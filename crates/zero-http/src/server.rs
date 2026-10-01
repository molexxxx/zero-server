//! The server: one handler instance per core over `zero-rt`'s workers, the accept
//! loop with the request-memory budget, and the shutdown sequence.
//!
//! Shutdown runs in the order Node's `http.Server` documents and `runtime-02` pins:
//! the signal stops the accept loops (the listeners close with them), idle
//! connections close at once, in-flight requests complete with `Connection: close`,
//! and whatever is still open when the drain deadline passes is dropped with the
//! runtime.

use std::io;
use std::net::SocketAddr;
use std::rc::Rc;
use std::time::Duration;

use zero_http_types::field::validate_field_value;
use zero_io::rt::Acceptor;
use zero_io::seam::{Listener, Shutdown, Timer};
use zero_limits::{Http1Limits, Limits};
use zero_rt::{StatusSink, Worker, Workers};

use crate::conn::{request_task, Conn, Shared};
use crate::handler::Handler;

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
    let limits = config.limits;
    let budget = config.runtime.io.memory_budget;
    zero_rt::start(addr, config.runtime, status, move |worker, acceptor| {
        let shared = Rc::new(Shared::new(
            worker.clone(),
            make(&worker),
            limits,
            server.clone(),
            budget,
        ));
        run_core(worker, acceptor, shared)
    })
}

/// One core's accept loop.
async fn run_core<H: Handler>(
    worker: Worker,
    acceptor: Acceptor,
    shared: Rc<Shared<H>>,
) -> io::Result<()> {
    let core = worker.core();
    loop {
        if shared.over_budget() {
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
                let conn = Conn::new(Rc::clone(&shared), Rc::new(stream), peer, request_task::<H>);
                worker.spawn(conn.run());
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
