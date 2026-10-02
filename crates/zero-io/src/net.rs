//! The socket setup both backends share: the listener strategy per operating
//! system, the datagram socket options, and the datagram calls through `zero-sys`.
//!
//! Linux: one `SO_REUSEPORT` listener per core, created with socket2, backlog 1,024,
//! optionally `SO_INCOMING_CPU`, `TCP_DEFER_ACCEPT` and `TCP_FASTOPEN`; the kernel
//! distributes connections across the group. Windows and macOS: one listener (with
//! `SO_EXCLUSIVEADDRUSE` on Windows, where `SO_REUSEADDR` is unsafe for servers and
//! there is no reuse-port group; Apple's `SO_REUSEPORT` does not distribute TCP) whose
//! accepted sockets core 0 hands round-robin to every core over an explicit wake,
//! the only traffic between cores on the accept path.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};

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
    /// One listener on core 0 handing sockets to the cores in turn, the strategy
    /// Windows and macOS always use; on Linux it replaces the per-core
    /// `SO_REUSEPORT` listeners, which lets the handoff path run on every platform.
    pub handoff: bool,
}

impl Default for ListenConfig {
    fn default() -> Self {
        ListenConfig {
            backlog: 1024,
            defer_accept: None,
            fastopen: None,
            incoming_cpu: false,
            nodelay: true,
            handoff: false,
        }
    }
}

/// Whether every core gets a listener of its own: Linux, unless the handoff
/// strategy was chosen.
pub(crate) const fn per_core_listeners(config: &ListenConfig) -> bool {
    cfg!(target_os = "linux") && !config.handoff
}

/// A listening socket at `addr`, non-blocking, ready for a backend.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one.
/// * `config` - the options.
/// * `core` - the core the listener belongs to, for `SO_INCOMING_CPU`.
pub(crate) fn bind_listener(
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

/// How a datagram socket is set up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DatagramConfig {
    /// Deliver the destination address of each datagram (`IP_PKTINFO`,
    /// `IPV6_RECVPKTINFO`). Linux and Apple platforms.
    pub packet_info: bool,
    /// Deliver the type of service of each datagram, for its ECN codepoint
    /// (`IP_RECVTOS`, `IPV6_RECVTCLASS`). Linux and Apple platforms.
    pub tos: bool,
    /// Coalesce consecutive datagrams of a flow into one receive (`UDP_GRO`). Linux.
    pub gro: bool,
    /// Send with the don't-fragment flag and probe the path MTU in the transport
    /// (`IP_PMTUDISC_PROBE`). Linux.
    pub mtu_probe: bool,
    /// Join a reuse group so several cores can bind the same port (`SO_REUSEPORT`).
    /// Unix.
    pub reuse_port: bool,
}

impl Default for DatagramConfig {
    fn default() -> Self {
        DatagramConfig {
            packet_info: true,
            tos: true,
            gro: false,
            mtu_probe: false,
            reuse_port: false,
        }
    }
}

/// A bound, non-blocking datagram socket set up as `config` says.
///
/// # Arguments
///
/// * `addr` - the local address; port 0 picks one.
/// * `config` - the options.
///
/// # Returns
///
/// The socket and whether it is IPv6.
pub(crate) fn bind_datagram(
    addr: SocketAddr,
    config: &DatagramConfig,
) -> io::Result<(std::net::UdpSocket, bool)> {
    let socket = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP))?;
    let v6 = addr.is_ipv6();
    #[cfg(unix)]
    if config.reuse_port {
        zero_sys::sockopt::set_reuse_port(&socket, true)?;
    }
    socket.bind(&addr.into())?;
    socket.set_nonblocking(true)?;
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    {
        let family = ip_family(v6);
        if config.packet_info {
            zero_sys::sockopt::set_recv_pktinfo(&socket, family, true)?;
        }
        if config.tos {
            zero_sys::sockopt::set_recv_tos(&socket, family, true)?;
        }
        #[cfg(target_os = "linux")]
        {
            if config.gro {
                zero_sys::sockopt::set_udp_gro(&socket, true)?;
            }
            if config.mtu_probe {
                zero_sys::sockopt::set_mtu_probe(&socket, family)?;
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    let _ = config;
    Ok((socket.into(), v6))
}

/// The address family a socket option names.
#[cfg(any(target_os = "linux", target_vendor = "apple"))]
pub(crate) const fn ip_family(v6: bool) -> zero_sys::sockopt::IpFamily {
    if v6 {
        zero_sys::sockopt::IpFamily::V6
    } else {
        zero_sys::sockopt::IpFamily::V4
    }
}

/// The datagram calls on Unix: `recvmsg` and `sendmsg` through `zero-sys` with a
/// control buffer for the packet information, the type of service and the segment
/// size.
#[cfg(unix)]
pub(crate) mod unix {
    use std::io::{self, IoSlice, IoSliceMut};
    use std::net::IpAddr;

    use zero_core::OwnedBuf;
    use zero_sys::cmsg::{messages, Builder};
    use zero_sys::msg::{recvmsg, sendmsg, RecvFlags, SendFlags};
    use zero_sys::packet::{self, Known, CONTROL_SPACE};
    use zero_sys::Sock;

    use crate::seam::{DatagramMeta, Ecn};

    /// Receive one datagram, now; `WouldBlock` when none is queued.
    pub(crate) fn receive(
        socket: &impl Sock,
        buf: &mut OwnedBuf,
        meta: &mut DatagramMeta,
    ) -> io::Result<()> {
        let mut control = [0u8; CONTROL_SPACE];
        let received = recvmsg(
            socket,
            &mut [IoSliceMut::new(buf.unfilled_mut())],
            &mut control,
            RecvFlags::default(),
        )?;
        buf.advance(received.bytes)
            .map_err(|err| io::Error::other(err.to_string()))?;
        *meta = DatagramMeta {
            peer: received.from,
            truncated: received.truncated,
            ..DatagramMeta::default()
        };
        let control = control.get(..received.control).unwrap_or(&[]);
        for message in messages(control) {
            match packet::known(&message) {
                Some(Known::V4Destination { addr, .. }) => meta.local = Some(IpAddr::V4(addr)),
                Some(Known::V6Destination { addr, .. }) => meta.local = Some(IpAddr::V6(addr)),
                Some(Known::Tos(tos)) => meta.ecn = Ecn::from_tos(tos),
                Some(Known::GroSegment(size)) => meta.segment_size = Some(size),
                None => {}
            }
        }
        Ok(())
    }

    /// Send one datagram, now; `WouldBlock` when the socket has no room.
    pub(crate) fn send(
        socket: &impl Sock,
        v6: bool,
        buf: &OwnedBuf,
        meta: &DatagramMeta,
    ) -> io::Result<()> {
        let mut control = [0u8; CONTROL_SPACE];
        let mut builder = Builder::new(&mut control);
        let full = |_| io::Error::new(io::ErrorKind::InvalidInput, "the control buffer is full");
        match meta.local {
            Some(IpAddr::V4(source)) => {
                packet::push_v4_source(&mut builder, source).map_err(full)?
            }
            Some(IpAddr::V6(source)) => {
                packet::push_v6_source(&mut builder, source).map_err(full)?
            }
            None => {}
        }
        #[cfg(target_os = "linux")]
        {
            if let Some(size) = meta.segment_size {
                packet::push_segment_size(&mut builder, size).map_err(full)?;
            }
            if meta.ecn != Ecn::NotCapable {
                packet::push_tos(&mut builder, v6, meta.ecn.bits()).map_err(full)?;
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = v6;
        let len = builder.len();
        let control = control.get(..len).unwrap_or(&[]);
        let sent = sendmsg(
            socket,
            &[IoSlice::new(buf.filled())],
            control,
            meta.peer,
            SendFlags {
                dont_wait: true,
                no_signal: true,
            },
        )?;
        if sent != buf.len() {
            return Err(io::Error::other("the datagram was sent short"));
        }
        Ok(())
    }
}
