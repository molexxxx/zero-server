//! The acceptor of the `io-tokio` backend over the listener strategy of
//! [`crate::net`]: a core's own listener on Linux, or the sockets core 0's listener
//! hands it over an unbounded channel on Windows and macOS.

use std::cell::RefCell;
use std::future::poll_fn;
use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::shutdown::ShutdownHandle;
use super::tcp::TcpStream;
pub(crate) use crate::net::{is_transient, Handoff};
use crate::seam::{Listener, Shutdown};

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
