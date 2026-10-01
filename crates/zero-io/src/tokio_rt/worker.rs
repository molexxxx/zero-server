//! The workers: one thread per core, each with its own runtime, pool, date block and
//! listener, running the caller's per-core future.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::rc::Rc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::listen::{self, Acceptor, Handoff, ListenConfig};
use super::shutdown::ShutdownHandle;
use crate::date::{Date, DATE_BLOCK_LEN};
use crate::pool::Pool;
use crate::seam::{DateService, Elapsed, Runtime, Shutdown, Timer};

/// How the workers are started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// How many cores to run; 0 means one per logical CPU
    /// (`std::thread::available_parallelism`).
    pub threads: usize,
    /// Pin each worker to its CPU where the platform allows; a platform without a
    /// pinning call runs unpinned.
    pub pin: bool,
    /// The listener options.
    pub listen: ListenConfig,
    /// The capacity of a receive block (`zero_limits::http1::RECEIVE_BLOCK`).
    pub receive_block: usize,
    /// The request memory one core may lease at once
    /// (`zero_limits::services::REQUEST_MEMORY_PER_CORE`).
    pub memory_budget: u64,
    /// How long a stopping worker waits for its tasks to finish before it leaks what is
    /// left and returns, the second of tokio's two shutdown modes.
    pub drain: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            threads: 0,
            pin: true,
            listen: ListenConfig::default(),
            receive_block: zero_limits::http1::RECEIVE_BLOCK,
            memory_budget: zero_limits::services::REQUEST_MEMORY_PER_CORE,
            drain: Duration::from_secs(30),
        }
    }
}

/// What a per-core future is given: this core's pool, date block, clock and signal.
#[derive(Clone, Debug)]
pub struct Core {
    index: usize,
    count: usize,
    pinned: bool,
    /// This core's receive-buffer pool.
    pub pool: Rc<Pool>,
    /// This core's `Date` block.
    pub date: Rc<Date>,
    shutdown: ShutdownHandle,
}

impl Core {
    /// Which core this is, from 0.
    #[must_use]
    pub const fn index(&self) -> usize {
        self.index
    }

    /// How many cores there are.
    #[must_use]
    pub const fn count(&self) -> usize {
        self.count
    }

    /// Whether this worker is pinned to its CPU.
    #[must_use]
    pub const fn pinned(&self) -> bool {
        self.pinned
    }

    /// The shutdown signal.
    #[must_use]
    pub const fn shutdown(&self) -> &ShutdownHandle {
        &self.shutdown
    }
}

impl Runtime for Core {
    fn spawn_local<F>(&self, future: F)
    where
        F: Future<Output = ()> + 'static,
    {
        drop(tokio::task::spawn_local(future));
    }
}

impl Timer for Core {
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> {
        super::time::sleep(duration)
    }

    fn timeout<F>(
        &self,
        duration: Duration,
        future: F,
    ) -> impl Future<Output = Result<F::Output, Elapsed>>
    where
        F: Future,
    {
        super::time::timeout(duration, future)
    }
}

impl DateService for Core {
    fn date_block(&self) -> [u8; DATE_BLOCK_LEN] {
        self.date.block()
    }
}

/// The running workers.
#[derive(Debug)]
pub struct Workers {
    threads: Vec<JoinHandle<io::Result<()>>>,
    shutdown: ShutdownHandle,
    addr: SocketAddr,
}

impl Workers {
    /// The address the listener (or listeners) is bound to.
    #[must_use]
    pub const fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// How many workers run.
    #[must_use]
    pub fn count(&self) -> usize {
        self.threads.len()
    }

    /// A handle on the shutdown signal, to request it from anywhere.
    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        self.shutdown.clone()
    }

    /// Request a shutdown and wait for every worker to return.
    ///
    /// # Errors
    ///
    /// The first error a worker returned, or a worker panicking.
    pub fn stop(self) -> io::Result<()> {
        self.shutdown.request();
        self.join()
    }

    /// Wait for every worker to return on its own.
    ///
    /// # Errors
    ///
    /// The first error a worker returned, or a worker panicking.
    pub fn join(self) -> io::Result<()> {
        let mut first = None;
        for thread in self.threads {
            let outcome = thread
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("a worker thread panicked")));
            if let Err(err) = outcome {
                first.get_or_insert(err);
            }
        }
        first.map_or(Ok(()), Err)
    }
}

/// Where a worker's connections come from, decided before its thread starts.
enum Seed {
    /// This core's own listener.
    Own(std::net::TcpListener),
    /// The shared listener this core accepts on for everyone, plus its own share.
    Distribute {
        listener: std::net::TcpListener,
        cores: Vec<UnboundedSender<Handoff>>,
        receiver: UnboundedReceiver<Handoff>,
        addr: SocketAddr,
    },
    /// This core's share of the shared listener.
    Handoff {
        receiver: UnboundedReceiver<Handoff>,
        addr: SocketAddr,
    },
}

/// Start one worker per core, each running `per_core` on its own runtime.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one, and every core then listens there.
/// * `config` - how many workers, pinning, the listener options, the pool sizes.
/// * `per_core` - the future each core runs, given its [`Core`] and its [`Acceptor`];
///   when it returns, the core's runtime drains for [`Config::drain`] and the worker
///   ends. It is called on the worker's thread.
///
/// # Returns
///
/// The workers, already listening.
///
/// # Errors
///
/// When a listener cannot be bound or a thread cannot be started; nothing is left
/// running then.
pub fn serve<F, Fut>(addr: SocketAddr, config: Config, per_core: F) -> io::Result<Workers>
where
    F: Fn(Core, Acceptor) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = io::Result<()>> + 'static,
{
    let count = if config.threads == 0 {
        thread::available_parallelism().map_or(1, NonZeroUsize::get)
    } else {
        config.threads
    };
    let first = listen::bind(addr, &config.listen, 0)?;
    let bound = first.local_addr()?;
    let shutdown = ShutdownHandle::new();
    let config = Arc::new(config);
    let per_core = Arc::new(per_core);

    let mut seeds = Vec::with_capacity(count);
    if listen::per_core_listeners() {
        seeds.push(Seed::Own(first));
        for index in 1..count {
            seeds.push(Seed::Own(listen::bind(bound, &config.listen, index)?));
        }
    } else {
        let (senders, receivers): (Vec<_>, Vec<_>) =
            (0..count).map(|_| unbounded_channel()).unzip();
        let mut receivers = receivers.into_iter();
        let receiver = receivers
            .next()
            .ok_or_else(|| io::Error::other("no cores"))?;
        seeds.push(Seed::Distribute {
            listener: first,
            cores: senders,
            receiver,
            addr: bound,
        });
        seeds.extend(receivers.map(|receiver| Seed::Handoff {
            receiver,
            addr: bound,
        }));
    }

    let mut threads = Vec::with_capacity(count);
    for (index, seed) in seeds.into_iter().enumerate() {
        let config = Arc::clone(&config);
        let per_core = Arc::clone(&per_core);
        let signal = shutdown.clone();
        let spawned = thread::Builder::new()
            .name(format!("zero-core-{index}"))
            .spawn(move || worker(index, count, seed, &config, &*per_core, signal));
        match spawned {
            Ok(handle) => threads.push(handle),
            Err(err) => {
                shutdown.request();
                for thread in threads {
                    let _ = thread.join();
                }
                return Err(err);
            }
        }
    }
    Ok(Workers {
        threads,
        shutdown,
        addr: bound,
    })
}

/// One worker thread: the runtime, the pin, the core, the per-core future.
fn worker<F, Fut>(
    index: usize,
    count: usize,
    seed: Seed,
    config: &Config,
    per_core: &F,
    shutdown: ShutdownHandle,
) -> io::Result<()>
where
    F: Fn(Core, Acceptor) -> Fut,
    Fut: Future<Output = io::Result<()>> + 'static,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    let pinned = config.pin && zero_sys::affinity::pin_current_thread(&[index]).is_ok();
    let local = tokio::task::LocalSet::new();
    let outcome = local.block_on(&runtime, async {
        let pool = Rc::new(Pool::new(config.receive_block, config.memory_budget));
        let date = Rc::new(Date::now());
        let core = Core {
            index,
            count,
            pinned,
            pool,
            date: Rc::clone(&date),
            shutdown: shutdown.clone(),
        };
        let ticker = shutdown.clone();
        drop(tokio::task::spawn_local(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            while ticker.until(tick.tick()).await.is_some() {
                date.refresh();
            }
        }));
        let nodelay = config.listen.nodelay;
        let acceptor = match seed {
            Seed::Own(listener) => Acceptor::Own {
                listener: tokio::net::TcpListener::from_std(listener)?,
                nodelay,
            },
            Seed::Distribute {
                listener,
                cores,
                receiver,
                addr,
            } => {
                let listener = tokio::net::TcpListener::from_std(listener)?;
                drop(tokio::task::spawn_local(listen::distribute(
                    listener,
                    cores,
                    shutdown.clone(),
                )));
                Acceptor::Handoff {
                    receiver: std::cell::RefCell::new(receiver),
                    addr,
                    nodelay,
                }
            }
            Seed::Handoff { receiver, addr } => Acceptor::Handoff {
                receiver: std::cell::RefCell::new(receiver),
                addr,
                nodelay,
            },
        };
        per_core(core, acceptor).await
    });
    runtime.shutdown_timeout(config.drain);
    outcome
}
