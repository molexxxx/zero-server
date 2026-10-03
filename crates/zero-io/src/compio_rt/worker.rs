//! The workers: one thread per core, each with its own driver, executor, pool, date
//! block and listener, running the caller's per-core future.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::rc::Rc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use compio_driver::SharedFd;
use socket2::Socket;

use super::executor::{self, Handle};
use super::listen::{self, Acceptor, Slot};
use super::shutdown::ShutdownHandle;
use crate::date::{Date, DATE_BLOCK_LEN};
use crate::net::{self, ListenConfig};
use crate::pool::Pool;
use crate::seam::{DateService, Elapsed, Runtime, Shutdown, Timer};

/// How the workers are started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// How many cores to run; 0 means one per logical CPU
    /// (`std::thread::available_parallelism`).
    pub threads: usize,
    /// Pin each worker to a CPU where the platform allows: worker `i` to the `i`-th
    /// of the CPUs the starting thread may run on, wrapping around, so a process
    /// confined to a CPU set keeps its workers inside it. A platform without a
    /// pinning call, or whose allowed set cannot be read, runs unpinned.
    pub pin: bool,
    /// The listener options.
    pub listen: ListenConfig,
    /// The capacity of a receive block (`zero_limits::http1::RECEIVE_BLOCK`).
    pub receive_block: usize,
    /// The request memory one core may lease at once
    /// (`zero_limits::services::REQUEST_MEMORY_PER_CORE`).
    pub memory_budget: u64,
    /// How long a stopping worker waits for its tasks to finish before it drops
    /// what is left and returns.
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
#[derive(Clone)]
pub struct Core {
    index: usize,
    count: usize,
    cpu: Option<usize>,
    /// This core's receive-buffer pool.
    pub pool: Rc<Pool>,
    /// This core's `Date` block.
    pub date: Rc<Date>,
    shutdown: ShutdownHandle,
    handle: Rc<Handle>,
}

impl std::fmt::Debug for Core {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Core")
            .field("index", &self.index)
            .field("count", &self.count)
            .field("cpu", &self.cpu)
            .field("io_uring", &self.handle.is_io_uring())
            .finish_non_exhaustive()
    }
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
        self.cpu.is_some()
    }

    /// The CPU this worker is pinned to: the `index`-th of the CPUs the process may
    /// run on, wrapping around, or `None` when it runs unpinned.
    #[must_use]
    pub const fn cpu(&self) -> Option<usize> {
        self.cpu
    }

    /// The shutdown signal.
    #[must_use]
    pub const fn shutdown(&self) -> &ShutdownHandle {
        &self.shutdown
    }

    /// How many tasks spawned through [`Runtime::spawn_local`] are still running.
    #[must_use]
    pub fn live_tasks(&self) -> usize {
        self.handle.live()
    }

    /// Whether this core's driver is io_uring rather than the epoll fallback, IOCP
    /// or kqueue.
    #[must_use]
    pub fn is_io_uring(&self) -> bool {
        self.handle.is_io_uring()
    }
}

impl Runtime for Core {
    fn spawn_local<F>(&self, future: F)
    where
        F: Future<Output = ()> + 'static,
    {
        self.handle.spawn(future);
    }
}

impl Timer for Core {
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> {
        super::time::sleep_on(&self.handle, duration)
    }

    fn timeout<F>(
        &self,
        duration: Duration,
        future: F,
    ) -> impl Future<Output = Result<F::Output, Elapsed>>
    where
        F: Future,
    {
        super::time::timeout_on(&self.handle, duration, future)
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
        cores: Vec<Arc<Slot>>,
        slot: Arc<Slot>,
        addr: SocketAddr,
    },
    /// This core's share of the shared listener.
    Handoff { slot: Arc<Slot>, addr: SocketAddr },
}

/// Start one worker per core, each running `per_core` on its own driver.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one, and every core then listens there.
/// * `config` - how many workers, pinning, the listener options, the pool sizes.
/// * `per_core` - the future each core runs, given its [`Core`] and its [`Acceptor`];
///   when it returns, the core drains its tasks for [`Config::drain`] and the worker
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
    let cpus = net::worker_cpus(count);
    let listener_cpu = |index: usize| cpus.get(index).copied().flatten().unwrap_or(index);
    let first = net::bind_listener(addr, &config.listen, listener_cpu(0))?;
    let bound = first.local_addr()?;
    let shutdown = ShutdownHandle::new();
    let config = Arc::new(config);
    let per_core = Arc::new(per_core);

    let mut seeds = Vec::with_capacity(count);
    if net::per_core_listeners(&config.listen) {
        seeds.push(Seed::Own(first));
        for index in 1..count {
            seeds.push(Seed::Own(net::bind_listener(
                bound,
                &config.listen,
                listener_cpu(index),
            )?));
        }
    } else {
        let slots: Vec<Arc<Slot>> = (0..count).map(|_| Arc::new(Slot::default())).collect();
        let mut rest = slots.iter().cloned();
        let slot = rest.next().ok_or_else(|| io::Error::other("no cores"))?;
        seeds.push(Seed::Distribute {
            listener: first,
            cores: slots.clone(),
            slot,
            addr: bound,
        });
        seeds.extend(rest.map(|slot| Seed::Handoff { slot, addr: bound }));
    }

    let mut threads = Vec::with_capacity(count);
    for (index, seed) in seeds.into_iter().enumerate() {
        let config = Arc::clone(&config);
        let per_core = Arc::clone(&per_core);
        let signal = shutdown.clone();
        let cpu = cpus.get(index).copied().flatten();
        let spawned = thread::Builder::new()
            .name(format!("zero-core-{index}"))
            .spawn(move || worker(index, count, cpu, seed, &config, &*per_core, signal));
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

/// A listener as the driver sees it, attached where the driver needs that.
fn share_listener(
    handle: &Rc<Handle>,
    listener: std::net::TcpListener,
) -> io::Result<SharedFd<Socket>> {
    let listener = Socket::from(listener);
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        handle.attach(listener.as_raw_socket() as compio_driver::RawFd)?;
    }
    #[cfg(not(windows))]
    let _ = handle;
    Ok(SharedFd::new(listener))
}

/// One worker thread: the driver, the pin, the core, the per-core future.
fn worker<F, Fut>(
    index: usize,
    count: usize,
    cpu: Option<usize>,
    seed: Seed,
    config: &Config,
    per_core: &F,
    shutdown: ShutdownHandle,
) -> io::Result<()>
where
    F: Fn(Core, Acceptor) -> Fut,
    Fut: Future<Output = io::Result<()>> + 'static,
{
    let pool = Rc::new(Pool::new(config.receive_block, config.memory_budget));
    let handle = Handle::new(pool)?;
    executor::enter(&handle);
    let outcome = run(index, count, cpu, seed, config, per_core, shutdown, &handle);
    // Whatever is still queued after the drain goes with the executor: the tasks
    // are dropped first, which cancels their operations and closes their sockets,
    // then the driver.
    handle.clear();
    executor::exit();
    outcome
}

/// The worker's body, on its thread with the core set.
#[allow(clippy::too_many_arguments)]
fn run<F, Fut>(
    index: usize,
    count: usize,
    cpu: Option<usize>,
    seed: Seed,
    config: &Config,
    per_core: &F,
    shutdown: ShutdownHandle,
    handle: &Rc<Handle>,
) -> io::Result<()>
where
    F: Fn(Core, Acceptor) -> Fut,
    Fut: Future<Output = io::Result<()>> + 'static,
{
    let cpu =
        cpu.filter(|&cpu| config.pin && zero_sys::affinity::pin_current_thread(&[cpu]).is_ok());
    let date = Rc::new(Date::now());
    let core = Core {
        index,
        count,
        cpu,
        pool: Rc::clone(&handle.pool),
        date: Rc::clone(&date),
        shutdown: shutdown.clone(),
        handle: Rc::clone(handle),
    };
    let ticker = core.clone();
    handle.spawn(async move {
        loop {
            if ticker
                .shutdown
                .until(ticker.sleep(Duration::from_secs(1)))
                .await
                .is_none()
            {
                return;
            }
            date.refresh();
        }
    });
    let nodelay = config.listen.nodelay;
    let acceptor = match seed {
        Seed::Own(listener) => Acceptor::own(
            share_listener(handle, listener)?,
            Rc::clone(handle),
            nodelay,
        ),
        Seed::Distribute {
            listener,
            cores,
            slot,
            addr,
        } => {
            let listener = share_listener(handle, listener)?;
            handle.spawn(listen::distribute(
                Rc::clone(handle),
                listener,
                cores,
                shutdown.clone(),
            ));
            Acceptor::handoff(slot, Rc::clone(handle), addr, nodelay)
        }
        Seed::Handoff { slot, addr } => Acceptor::handoff(slot, Rc::clone(handle), addr, nodelay),
    };
    let outcome = handle.block_on(per_core(core, acceptor));
    // Drain: the tasks still running (the open connections) finish on their own up
    // to the deadline.
    handle.drain(config.drain);
    outcome
}
