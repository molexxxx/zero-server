//! The listener strategy per operating system (`DESIGN.md` section 5.4).
//!
//! Linux: one `SO_REUSEPORT` listener per core, created with socket2, backlog 1,024,
//! optionally `SO_INCOMING_CPU`, `TCP_DEFER_ACCEPT` and `TCP_FASTOPEN`; the kernel
//! distributes connections across the group. Windows and macOS: one listener (with
//! `SO_EXCLUSIVEADDRUSE` on Windows, where `SO_REUSEADDR` is unsafe for servers and
//! there is no reuse-port group; Apple's `SO_REUSEPORT` does not distribute TCP) whose
//! accepted sockets core 0 hands round-robin to every core over an unbounded channel,
//! the explicit wake of section 5.1.

use std::cell::RefCell;
use std::future::poll_fn;
use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::shutdown::ShutdownHandle;
use super::tcp::TcpStream;
use crate::seam::{Listener, Shutdown};

/// How a listening socket is set up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenConfig {
    /// The `listen` backlog; 1,024 as the Round 23 Rust entries use.
    pub backlog: i32,
    /// `TCP_DEFER_ACCEPT` (Linux): wake the acceptor only once data arrives, waiting
    /// at most this long.
    pub defer_accept: Option<Duration>,
    /// `TCP_FASTOPEN` (Linux): the queue length for connections carrying data in the
    /// SYN.
    pub fastopen: Option<u32>,
    /// `SO_INCOMING_CPU` (Linux): steer each core's listener to its own CPU.
    pub incoming_cpu: bool,
    /// `TCP_NODELAY` on every accepted socket.
    pub nodelay: bool,
}

impl Default for ListenConfig {
    fn default() -> Self {
        ListenConfig {
            backlog: 1024,
            defer_accept: None,
            fastopen: None,
            incoming_cpu: false,
            nodelay: true,
        }
    }
}

/// Whether this platform gives every core a listener of its own.
pub(crate) const fn per_core_listeners() -> bool {
    cfg!(target_os = "linux")
}

/// A listening socket at `addr`, non-blocking, ready for the runtime.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one.
/// * `config` - the options.
/// * `core` - the core the listener belongs to, for `SO_INCOMING_CPU`.
pub(crate) fn bind(
    addr: SocketAddr,
    config: &ListenConfig,
    core: usize,
) -> io::Result<std::net::TcpListener> {
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    #[cfg(target_os = "linux")]
    {
        zero_sys::sockopt::set_reuse_port(&socket, true)?;
        if config.incoming_cpu {
            zero_sys::sockopt::set_incoming_cpu(&socket, core)?;
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = core;
    #[cfg(windows)]
    zero_sys::sockopt::set_exclusive_address_use(&socket, true)?;
    socket.bind(&addr.into())?;
    #[cfg(target_os = "linux")]
    {
        if let Some(wait) = config.defer_accept {
            zero_sys::sockopt::set_tcp_defer_accept(&socket, wait)?;
        }
        if let Some(queue) = config.fastopen {
            zero_sys::sockopt::set_tcp_fastopen(&socket, queue)?;
        }
    }
    socket.listen(config.backlog)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// An accepted connection on its way to a core: the socket and the peer's address.
pub(crate) type Handoff = (std::net::TcpStream, SocketAddr);

/// Where a core's connections come from.
#[derive(Debug)]
pub enum Acceptor {
    /// This core's own listener.
    Own {
        /// The listener.
        listener: tokio::net::TcpListener,
        /// Whether accepted sockets get `TCP_NODELAY`.
        nodelay: bool,
    },
    /// The sockets another core's listener hands to this one.
    Handoff {
        /// The receiving end of the handoff.
        receiver: RefCell<UnboundedReceiver<Handoff>>,
        /// The address the shared listener is bound to.
        addr: SocketAddr,
        /// Whether accepted sockets get `TCP_NODELAY`.
        nodelay: bool,
    },
}

impl Listener for Acceptor {
    type Stream = TcpStream;

    async fn accept(&self) -> io::Result<(TcpStream, SocketAddr)> {
        let (stream, peer, nodelay) = match self {
            Acceptor::Own { listener, nodelay } => {
                let (stream, peer) = listener.accept().await?;
                (stream, peer, *nodelay)
            }
            Acceptor::Handoff {
                receiver, nodelay, ..
            } => {
                let handed = poll_fn(|cx| receiver.borrow_mut().poll_recv(cx)).await;
                let (socket, peer) = handed.ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotConnected, "the listener closed")
                })?;
                (tokio::net::TcpStream::from_std(socket)?, peer, *nodelay)
            }
        };
        let stream = TcpStream::new(stream);
        if nodelay {
            stream.set_nodelay(true)?;
        }
        Ok((stream, peer))
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        match self {
            Acceptor::Own { listener, .. } => listener.local_addr(),
            Acceptor::Handoff { addr, .. } => Ok(*addr),
        }
    }
}

/// Accept on the shared listener and hand each socket to the next core, until a
/// shutdown is requested or the listener fails for good.
///
/// # Arguments
///
/// * `listener` - the one listener.
/// * `cores` - every core's receiving end, in order.
/// * `shutdown` - the signal that ends the loop.
pub(crate) async fn distribute(
    listener: tokio::net::TcpListener,
    cores: Vec<UnboundedSender<Handoff>>,
    shutdown: ShutdownHandle,
) {
    let mut targets = cores.iter().cycle();
    while let Some(accepted) = shutdown.until(listener.accept()).await {
        match accepted {
            Ok((stream, peer)) => {
                let Ok(socket) = stream.into_std() else {
                    continue;
                };
                if let Some(target) = targets.next() {
                    // A core that is gone drops its receiver; its share is simply lost.
                    let _ = target.send((socket, peer));
                }
            }
            // A transient failure (the descriptor table is full, a connection was
            // reset before accept) is retried after a pause; see accept(2).
            Err(err) if is_transient(&err) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(_) => break,
        }
    }
}

/// Whether an accept error passes with time rather than ending the listener.
pub(crate) fn is_transient(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock
            | io::ErrorKind::Interrupted
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    ) || zero_sys::error::out_of_resources(err)
}
