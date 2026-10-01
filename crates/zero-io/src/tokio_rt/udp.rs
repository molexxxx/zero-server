//! A UDP socket on the readiness backend: batches of datagrams received and sent on
//! readiness, each with its packet information, ECN codepoint and segment size.
//!
//! On Unix every datagram goes through `recvmsg` and `sendmsg` in `zero-sys` with a
//! control buffer, inside tokio's `try_io`, which clears the readiness flag when the
//! call would block; on Windows the plain receive and send carry the peer alone until
//! the completion backend brings `WSARecvMsg`. ECN per sent datagram and segmentation
//! are Linux paths; elsewhere the socket's type of service applies to every datagram.

use std::io;
use std::net::SocketAddr;

use socket2::{Domain, Protocol, Socket, Type};
use zero_core::OwnedBuf;

use crate::seam::{Datagram, DatagramMeta};

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

/// A bound UDP socket on this core.
#[derive(Debug)]
pub struct UdpSocket {
    inner: tokio::net::UdpSocket,
    v6: bool,
}

impl UdpSocket {
    /// Bind a socket, set up as `config` says. Call it on the core's runtime.
    ///
    /// # Arguments
    ///
    /// * `addr` - the local address; port 0 picks one.
    /// * `config` - the options.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    pub fn bind(addr: SocketAddr, config: &DatagramConfig) -> io::Result<Self> {
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
            let family = if v6 {
                zero_sys::sockopt::IpFamily::V6
            } else {
                zero_sys::sockopt::IpFamily::V4
            };
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
        let socket: std::net::UdpSocket = socket.into();
        Ok(UdpSocket {
            inner: tokio::net::UdpSocket::from_std(socket)?,
            v6,
        })
    }

    /// Whether the socket is IPv6.
    #[must_use]
    pub const fn is_v6(&self) -> bool {
        self.v6
    }

    /// The type of service every datagram is sent with unless its metadata says
    /// otherwise (`IP_TOS`, `IPV6_TCLASS`). Linux and Apple platforms.
    ///
    /// # Arguments
    ///
    /// * `tos` - the byte, ECN bits included.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    pub fn set_tos(&self, tos: u8) -> io::Result<()> {
        let family = if self.v6 {
            zero_sys::sockopt::IpFamily::V6
        } else {
            zero_sys::sockopt::IpFamily::V4
        };
        zero_sys::sockopt::set_tos(&self.inner, family, tos)
    }

    /// Receive one datagram, now; `WouldBlock` when none is queued.
    fn receive(&self, buf: &mut OwnedBuf, meta: &mut DatagramMeta) -> io::Result<()> {
        #[cfg(unix)]
        {
            self.inner.try_io(tokio::io::Interest::READABLE, || {
                unix::receive(&self.inner, buf, meta)
            })
        }
        #[cfg(not(unix))]
        {
            // Windows fills the buffer with the first part of a datagram that is
            // longer than it and then fails the call with WSAEMSGSIZE (10040), so
            // that error is a full, truncated buffer whose peer is not reported.
            const WSAEMSGSIZE: i32 = 10040;
            let (count, peer) = match self.inner.try_recv_from(buf.unfilled_mut()) {
                Ok((count, peer)) => (count, Some(peer)),
                Err(err) if err.raw_os_error() == Some(WSAEMSGSIZE) => (buf.remaining(), None),
                Err(err) => return Err(err),
            };
            buf.advance(count)
                .map_err(|err| io::Error::other(err.to_string()))?;
            *meta = DatagramMeta {
                peer,
                truncated: peer.is_none(),
                ..DatagramMeta::default()
            };
            Ok(())
        }
    }

    /// Send one datagram, now; `WouldBlock` when the socket has no room.
    fn send(&self, buf: &OwnedBuf, meta: &DatagramMeta) -> io::Result<()> {
        #[cfg(unix)]
        {
            self.inner.try_io(tokio::io::Interest::WRITABLE, || {
                unix::send(&self.inner, self.v6, buf, meta)
            })
        }
        #[cfg(not(unix))]
        {
            let peer = meta.peer.ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "a datagram needs a peer")
            })?;
            self.inner.try_send_to(buf.filled(), peer)?;
            Ok(())
        }
    }
}

impl Datagram for UdpSocket {
    async fn recv_batch(
        &self,
        bufs: &mut [OwnedBuf],
        meta: &mut [DatagramMeta],
    ) -> io::Result<usize> {
        if meta.len() < bufs.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "one metadata entry per buffer",
            ));
        }
        if bufs.is_empty() {
            return Ok(0);
        }
        loop {
            self.inner.readable().await?;
            let mut count = 0;
            for (buf, entry) in bufs.iter_mut().zip(meta.iter_mut()) {
                match self.receive(buf, entry) {
                    Ok(()) => count += 1,
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                    Err(err) if count > 0 => {
                        let _ = err;
                        break;
                    }
                    Err(err) => return Err(err),
                }
            }
            if count > 0 {
                return Ok(count);
            }
        }
    }

    async fn send_batch(&self, bufs: &[OwnedBuf], meta: &[DatagramMeta]) -> io::Result<usize> {
        if meta.len() < bufs.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "one metadata entry per buffer",
            ));
        }
        if bufs.is_empty() {
            return Ok(0);
        }
        loop {
            self.inner.writable().await?;
            let mut count = 0;
            for (buf, entry) in bufs.iter().zip(meta.iter()) {
                match self.send(buf, entry) {
                    Ok(()) => count += 1,
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                    Err(err) if count > 0 => {
                        let _ = err;
                        break;
                    }
                    Err(err) => return Err(err),
                }
            }
            if count > 0 {
                return Ok(count);
            }
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

#[cfg(unix)]
mod unix {
    use std::io::{self, IoSlice, IoSliceMut};
    use std::net::IpAddr;

    use zero_core::OwnedBuf;
    use zero_sys::cmsg::{messages, Builder};
    use zero_sys::msg::{recvmsg, sendmsg, RecvFlags, SendFlags};
    use zero_sys::packet::{self, Known, CONTROL_SPACE};

    use crate::seam::{DatagramMeta, Ecn};

    pub(super) fn receive(
        socket: &tokio::net::UdpSocket,
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

    pub(super) fn send(
        socket: &tokio::net::UdpSocket,
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
