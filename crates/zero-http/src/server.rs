//! The server: one handler instance per core over `zero-rt`'s workers, the accept
//! loop with the request-memory budget, and the shutdown sequence.
//!
//! Shutdown runs in the order Node's `http.Server` documents and `runtime-02` pins:
//! the signal stops the accept loops (the listeners close with them), idle
//! connections close at once, in-flight requests complete with `Connection: close`,
//! and whatever is still open when the drain deadline passes is dropped with the
//! runtime.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::rc::Rc;
use std::time::Duration;

use zero_http_types::field::validate_field_value;
use zero_io::rt::{Acceptor, TcpStream};
use zero_io::seam::{Listener, Shutdown, Stream, Timer};
use zero_limits::{Http1Limits, Limits};
use zero_rt::{StatusSink, Worker, Workers};

use crate::conn::{request_task, Conn, Shared};
use crate::handler::Handler;

/// Prepares each accepted connection before the driver serves it, such as with a
/// TLS handshake. One instance runs on each core, built by the `make_accept`
/// function given to [`serve_with`].
pub trait Accept: 'static {
    /// The stream the driver serves once the connection is prepared.
    type Stream: Stream + 'static;

    /// Whether the connections this core serves are secure, which
    /// [`Request::is_secure`](crate::Request::is_secure) reports.
    fn secure(&self) -> bool {
        false
    }

    /// Whether the core should pause accepting, such as when its in-progress
    /// handshakes reached their cap; the kernel's backlog holds the rest.
    fn saturated(&self) -> bool {
        false
    }

    /// Prepare one connection.
    ///
    /// # Arguments
    ///
    /// * `stream` - the accepted connection.
    /// * `peer` - its peer's address.
    ///
    /// # Returns
    ///
    /// The stream to serve.
    ///
    /// # Errors
    ///
    /// Any error ends the connection without a response.
    fn accept(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
    ) -> impl Future<Output = io::Result<Self::Stream>>;
}

/// How long a core waits after running out of descriptors before accepting again.
const RESOURCE_PAUSE: Duration = Duration::from_millis(10);

/// How often a core over its request-memory budget checks whether it may accept.
const BUDGET_PAUSE: Duration = Duration::from_millis(1);

/// How a server is started.
#[derive(Clone, Debug)]
pub struct Config {
    /// The workers: threads, pinning, the listener, the pool, the drain deadline.
    pub runtime: zero_rt::Config,
    /// The HTTP/1.1 limits and timeouts.
    pub limits: Http1Limits,
    /// The `Server` field value sent on every response, when set.
    pub server: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            runtime: zero_rt::Config::default(),
            limits: Http1Limits::DEFAULT,
            server: None,
        }
    }
}

/// Start the server: one worker per core, each with its own handler from `make`.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one.
/// * `config` - the settings.
/// * `status` - the status callback for started, stopped and panicking cores.
/// * `make` - builds the core's handler; called on each worker's thread.
///
/// # Returns
///
/// The workers, already listening.
///
/// # Errors
///
/// `InvalidInput` for limits that contradict each other or a `Server` value that
/// is not a field value; otherwise the error of binding or starting a thread.
pub fn serve<H, M>(
    addr: SocketAddr,
    config: Config,
    status: StatusSink,
    make: M,
) -> io::Result<Workers>
where
    H: Handler,
    M: Fn(&Worker) -> H + Send + Sync + 'static,
{
    let (limits, server, budget) = prepare(&config)?;
    zero_rt::start(addr, config.runtime, status, move |worker, acceptor| {
        let shared = Rc::new(Shared::new(
            worker.clone(),
            make(&worker),
            limits,
            server.clone(),
            budget,
            false,
        ));
        let spawner = worker.clone();
        run_core(
            worker,
            acceptor,
            Rc::clone(&shared),
            || false,
            move |stream, peer| {
                let conn = Conn::new(Rc::clone(&shared), Rc::new(stream), peer, request_task::<H>);
                spawner.spawn(conn.run());
            },
        )
    })
}

/// Start the server with each accepted connection prepared by an [`Accept`] before
/// the driver serves it, such as a TLS listener.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one.
/// * `config` - the settings.
/// * `status` - the status callback for started, stopped and panicking cores.
/// * `make` - builds the core's handler; called on each worker's thread.
/// * `make_accept` - builds the core's [`Accept`]; called on each worker's thread.
///
/// # Returns
///
/// The workers, already listening.
///
/// # Errors
///
/// As [`serve`].
pub fn serve_with<H, M, A, N>(
    addr: SocketAddr,
    config: Config,
    status: StatusSink,
    make: M,
    make_accept: N,
) -> io::Result<Workers>
where
    H: Handler,
    M: Fn(&Worker) -> H + Send + Sync + 'static,
    A: Accept,
    N: Fn(&Worker) -> A + Send + Sync + 'static,
{
    let (limits, server, budget) = prepare(&config)?;
    zero_rt::start(addr, config.runtime, status, move |worker, acceptor| {
        let accept = Rc::new(make_accept(&worker));
        let shared = Rc::new(Shared::new(
            worker.clone(),
            make(&worker),
            limits,
            server.clone(),
            budget,
            accept.secure(),
        ));
        let spawner = worker.clone();
        let gate = Rc::clone(&accept);
        run_core(
            worker,
            acceptor,
            Rc::clone(&shared),
            move || gate.saturated(),
            move |stream, peer| {
                let shared = Rc::clone(&shared);
                let accept = Rc::clone(&accept);
                spawner.spawn(async move {
                    if let Ok(prepared) = accept.accept(stream, peer).await {
                        Conn::new(shared, Rc::new(prepared), peer, request_task::<H>)
                            .run()
                            .await;
                    }
                });
            },
        )
    })
}

/// Check the configuration and build the `Server` field line.
fn prepare(config: &Config) -> io::Result<(Http1Limits, Vec<u8>, u64)> {
    let all = Limits {
        http1: config.limits,
        ..Limits::DEFAULT
    };
    all.check().map_err(|invalid| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{}: {}", invalid.name, invalid.reason),
        )
    })?;
    let server = match &config.server {
        Some(value) => {
            validate_field_value(value.as_bytes()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the Server value is not a field value",
                )
            })?;
            let mut line = Vec::with_capacity(value.len() + 10);
            line.extend_from_slice(b"Server: ");
            line.extend_from_slice(value.as_bytes());
            line.extend_from_slice(b"\r\n");
            line
        }
        None => Vec::new(),
    };
    Ok((config.limits, server, config.runtime.io.memory_budget))
}

/// One core's accept loop: it pauses while the core is over its request-memory
/// budget or `saturated` holds, and hands every accepted connection to `spawn`
/// once `saturated` no longer holds.
async fn run_core<H: Handler>(
    worker: Worker,
    acceptor: Acceptor,
    shared: Rc<Shared<H>>,
    saturated: impl Fn() -> bool,
    spawn: impl Fn(TcpStream, SocketAddr),
) -> io::Result<()> {
    let core = worker.core();
    loop {
        if shared.over_budget() || saturated() {
            if worker
                .shutdown()
                .until(core.sleep(BUDGET_PAUSE))
                .await
                .is_none()
            {
                break;
            }
            continue;
        }
        let Some(accepted) = worker.shutdown().until(acceptor.accept()).await else {
            break;
        };
        match accepted {
            Ok((stream, peer)) => {
                // An accept that was already waiting when the core saturated holds its
                // connection here, so the cap is never passed by one.
                while saturated() {
                    if worker
                        .shutdown()
                        .until(core.sleep(BUDGET_PAUSE))
                        .await
                        .is_none()
                    {
                        return Ok(());
                    }
                }
                spawn(stream, peer);
            }
            Err(err) if zero_sys::error::out_of_resources(&err) => {
                if worker
                    .shutdown()
                    .until(core.sleep(RESOURCE_PAUSE))
                    .await
                    .is_none()
                {
                    break;
                }
            }
            Err(err) if is_transient(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Accept errors that concern one connection, not the listener.
fn is_transient(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::TimedOut
    )
}
