//! The per-core workers over the `zero-io` seam, with panic containment and the
//! status callback.
//!
//! Every task a worker spawns runs under [`contain`]; a panic counts on the core's
//! panic counter and reaches the status callback as [`Event::TaskPanic`], and the core
//! keeps serving. The worker's own loop is contained the same way and fails closed: a
//! panic outside a task stops that core and reports it as [`Event::WorkerPanic`],
//! because a core with no worker is a silent outage.

use std::cell::Cell;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::rc::Rc;
use std::sync::Arc;

use zero_io::rt::{self, Acceptor, Core, ShutdownHandle};
use zero_io::seam::Runtime;

use crate::contain::contain;

/// What a worker reports through the status callback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A core's worker started serving.
    Started {
        /// The core.
        core: usize,
    },
    /// A core's worker returned.
    Stopped {
        /// The core.
        core: usize,
    },
    /// A task on a core panicked; the core keeps serving.
    TaskPanic {
        /// The core.
        core: usize,
        /// The panic message.
        message: String,
    },
    /// A core's own loop panicked; the core stopped.
    WorkerPanic {
        /// The core.
        core: usize,
        /// The panic message.
        message: String,
    },
}

/// The status callback: called on the core's thread, so it must be `Send + Sync`.
pub type StatusSink = Arc<dyn Fn(Event) + Send + Sync>;

/// How the workers are started.
#[derive(Clone, Debug, Default)]
pub struct Config {
    /// The runtime seam's settings: threads, pinning, the listener, the pool.
    pub io: rt::Config,
}

/// One core's worker: the seam's core plus the panic counter and the status sink.
#[derive(Clone)]
pub struct Worker {
    core: Core,
    panics: Rc<Cell<u64>>,
    status: StatusSink,
}

impl std::fmt::Debug for Worker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Worker")
            .field("core", &self.core.index())
            .field("panics", &self.panics.get())
            .finish_non_exhaustive()
    }
}

impl Worker {
    /// The seam's core: the pool, the date block, the clock and the shutdown signal.
    #[must_use]
    pub const fn core(&self) -> &Core {
        &self.core
    }

    /// Which core this is.
    #[must_use]
    pub const fn index(&self) -> usize {
        self.core.index()
    }

    /// How many task panics this core has contained.
    #[must_use]
    pub fn panics(&self) -> u64 {
        self.panics.get()
    }

    /// The shutdown signal.
    #[must_use]
    pub const fn shutdown(&self) -> &ShutdownHandle {
        self.core.shutdown()
    }

    /// Spawn a task on this core under panic containment.
    ///
    /// # Arguments
    ///
    /// * `future` - the task body; a panic in it is counted and reported, and the
    ///   task ends there.
    pub fn spawn(&self, future: impl Future<Output = ()> + 'static) {
        let worker = self.clone();
        // Each async wrapper the future passes through, containment, this block and
        // the runtime's own, keeps its own copy of what it was handed; boxing first
        // hands them a pointer, so the task holds the future once.
        let future = Box::pin(future);
        self.core.spawn_local(async move {
            if let Err(panicked) = contain(future).await {
                worker.note_panic(panicked.message);
            }
        });
    }

    /// Count a panic this core contained itself, such as a handler future polled
    /// inline by a connection task under [`contain`], and report it as
    /// [`Event::TaskPanic`].
    ///
    /// # Arguments
    ///
    /// * `message` - the panic message.
    pub fn note_panic(&self, message: String) {
        self.panics.set(self.panics.get().saturating_add(1));
        (self.status)(Event::TaskPanic {
            core: self.core.index(),
            message,
        });
    }

    /// Report an event through the status callback.
    ///
    /// # Arguments
    ///
    /// * `event` - what happened.
    pub fn report(&self, event: Event) {
        (self.status)(event);
    }
}

/// The running workers.
#[derive(Debug)]
pub struct Workers {
    inner: rt::Workers,
}

impl Workers {
    /// The address the listeners are bound to.
    #[must_use]
    pub const fn local_addr(&self) -> SocketAddr {
        self.inner.local_addr()
    }

    /// How many cores run.
    #[must_use]
    pub fn count(&self) -> usize {
        self.inner.count()
    }

    /// A handle on the shutdown signal.
    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        self.inner.shutdown_handle()
    }

    /// Request a shutdown and wait for every core to return.
    ///
    /// # Errors
    ///
    /// The first error a core returned, a core that panicked outside a task included.
    pub fn stop(self) -> io::Result<()> {
        self.inner.stop()
    }

    /// Wait for every core to return on its own.
    ///
    /// # Errors
    ///
    /// The first error a core returned.
    pub fn join(self) -> io::Result<()> {
        self.inner.join()
    }
}

/// Start one worker per core, each running `per_core` under panic containment.
///
/// # Arguments
///
/// * `addr` - where to listen.
/// * `config` - the settings.
/// * `status` - the status callback, called on the cores' threads.
/// * `per_core` - the future each core runs with its [`Worker`] and [`Acceptor`]; a
///   panic in it stops that core and is reported as [`Event::WorkerPanic`].
///
/// # Returns
///
/// The workers, already listening.
///
/// # Errors
///
/// When a listener cannot be bound or a thread cannot be started.
pub fn start<F, Fut>(
    addr: SocketAddr,
    config: Config,
    status: StatusSink,
    per_core: F,
) -> io::Result<Workers>
where
    F: Fn(Worker, Acceptor) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = io::Result<()>> + 'static,
{
    let inner = rt::serve(addr, config.io, move |core, acceptor| {
        let status = Arc::clone(&status);
        let worker = Worker {
            core,
            panics: Rc::new(Cell::new(0)),
            status: Arc::clone(&status),
        };
        let index = worker.index();
        let body = per_core(worker, acceptor);
        async move {
            status(Event::Started { core: index });
            let outcome = match contain(body).await {
                Ok(outcome) => outcome,
                Err(panicked) => {
                    status(Event::WorkerPanic {
                        core: index,
                        message: panicked.message.clone(),
                    });
                    Err(io::Error::other(panicked.to_string()))
                }
            };
            status(Event::Stopped { core: index });
            outcome
        }
    })?;
    Ok(Workers { inner })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use zero_core::OwnedBuf;
    use zero_io::seam::{Leased, Listener, Shutdown, Stream};

    use super::{start, Config, Event, Worker};

    fn config() -> Config {
        Config {
            io: zero_io::rt::Config {
                threads: 2,
                drain: Duration::from_secs(2),
                ..zero_io::rt::Config::default()
            },
        }
    }

    /// Answer each line with the core's panic count; a line saying `panic` panics the
    /// connection task first.
    async fn serve(worker: Worker, acceptor: zero_io::rt::Acceptor) -> std::io::Result<()> {
        while let Some(accepted) = worker.shutdown().until(acceptor.accept()).await {
            let (stream, _) = accepted?;
            let task_worker = worker.clone();
            worker.spawn(async move {
                loop {
                    let Some(Ok(Leased::Data(buf))) = task_worker
                        .shutdown()
                        .until(stream.read_leased(&task_worker.core().pool))
                        .await
                    else {
                        return;
                    };
                    let line = buf.filled().to_vec();
                    task_worker.core().pool.release(buf);
                    if line.starts_with(b"panic") {
                        panic!("asked to");
                    }
                    let reply = format!("panics={}\n", task_worker.panics());
                    let (written, _) = stream.write(OwnedBuf::from_vec(reply.into_bytes())).await;
                    if written.is_err() {
                        return;
                    }
                }
            });
        }
        Ok(())
    }

    /// One line in, one line out; an empty string when the server closed instead.
    fn ask(addr: std::net::SocketAddr, line: &str) -> String {
        let mut conn = TcpStream::connect(addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        conn.write_all(line.as_bytes()).unwrap();
        let mut reply = Vec::new();
        let mut byte = [0u8; 1];
        while conn.read(&mut byte).is_ok_and(|count| count == 1) {
            reply.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        String::from_utf8(reply).unwrap()
    }

    #[test]
    fn a_panicking_task_is_contained_and_reported_and_the_core_serves_on() {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let workers = start(
            "127.0.0.1:0".parse().unwrap(),
            config(),
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            serve,
        )
        .unwrap();
        let addr = workers.local_addr();
        assert_eq!(workers.count(), 2);

        assert_eq!(
            ask(addr, "panic\n"),
            "",
            "the panicking task closes its connection"
        );
        // Every core still answers, the one that panicked included; which core a
        // connection lands on is the kernel's choice, so the count is looked for over
        // enough connections to reach both.
        let mut saw_count = false;
        for _ in 0..64 {
            let reply = ask(addr, "hello\n");
            assert!(reply.starts_with("panics="), "{reply}");
            if reply == "panics=1\n" {
                saw_count = true;
                break;
            }
        }
        assert!(saw_count, "the core that contained the panic counts it");
        workers.stop().unwrap();
        std::panic::set_hook(previous);
        let events = events.lock().unwrap();
        assert!(events.iter().any(
            |event| matches!(event, Event::TaskPanic { message, .. } if message == "asked to")
        ));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, Event::Started { .. }))
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, Event::Stopped { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn a_panic_in_the_worker_loop_stops_that_core_and_is_reported() {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let workers = start(
            "127.0.0.1:0".parse().unwrap(),
            config(),
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            |worker: Worker, _acceptor| async move {
                if worker.index() == 1 {
                    panic!("loop fell over");
                }
                worker.shutdown().requested().await;
                Ok(())
            },
        )
        .unwrap();
        let outcome = workers.stop();
        std::panic::set_hook(previous);
        assert!(outcome.is_err(), "the panicked core fails closed");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            Event::WorkerPanic { core: 1, message } if message == "loop fell over"
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event, Event::Stopped { core: 1 })));
    }
}
