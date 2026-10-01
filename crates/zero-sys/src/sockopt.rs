//! Socket options, each a safe call with a value of the option's own type.
//!
//! A setter takes the socket by borrow and the value the option is defined with, so the
//! length the kernel sees is always that value's size, and a getter checks the length
//! the kernel wrote before trusting the value. Where socket2 exposes an option as a safe
//! method, the wrapper delegates to it. An option one operating system defines exists
//! only there, so a caller chooses per operating system at compile time rather than
//! finding out at run time.
//!
//! Sources: socket(7), tcp(7), udp(7) and ip(7) of the Linux man-pages project, the
//! kernel's `asm-generic/socket.h`, `linux/tcp.h`, `linux/udp.h`, `linux/in.h` and
//! `linux/in6.h`, the UDP GSO selftests (`udpgso_bench_tx.c`, `udpgso_bench_rx.c`),
//! XNU's `netinet/in.h`, `netinet6/in6.h` and `sys/socket.h`, and the constants of the
//! pinned libc and windows-sys crates.

use std::io;

use socket2::SockRef;

use crate::Sock;

/// Which Internet protocol a per-protocol option applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpFamily {
    /// IPv4: the `IPPROTO_IP` level.
    V4,
    /// IPv6: the `IPPROTO_IPV6` level.
    V6,
}

/// `TCP_NODELAY`: send a segment as soon as there is data rather than waiting to
/// coalesce it with the next write (Nagle's algorithm off). Every platform.
///
/// # Arguments
///
/// * `socket` - a TCP socket.
/// * `on` - whether to disable the delay.
///
/// # Errors
///
/// The operating system's error.
pub fn set_tcp_nodelay(socket: &impl Sock, on: bool) -> io::Result<()> {
    SockRef::from(socket).set_tcp_nodelay(on)
}

/// Whether `TCP_NODELAY` is set.
///
/// # Arguments
///
/// * `socket` - a TCP socket.
///
/// # Errors
///
/// The operating system's error.
pub fn tcp_nodelay(socket: &impl Sock) -> io::Result<bool> {
    SockRef::from(socket).tcp_nodelay()
}

/// `SO_REUSEPORT`: let several sockets bind the same address, each a listener of its
/// own. On Linux (since 3.9) the kernel distributes connections across the group and
/// every binder must have the same effective user; on Apple platforms the option only
/// distributes multicast and broadcast datagrams (the accept handoff of `zero-io`
/// covers TCP there). Set it before `bind`.
///
/// # Arguments
///
/// * `socket` - an unbound socket.
/// * `on` - whether to join a reuse group.
///
/// # Errors
///
/// The operating system's error.
#[cfg(unix)]
pub fn set_reuse_port(socket: &impl Sock, on: bool) -> io::Result<()> {
    SockRef::from(socket).set_reuse_port(on)
}

/// Whether `SO_REUSEPORT` is set.
///
/// # Arguments
///
/// * `socket` - any socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(unix)]
pub fn reuse_port(socket: &impl Sock) -> io::Result<bool> {
    SockRef::from(socket).reuse_port()
}

/// `SO_INCOMING_CPU` (Linux, settable since 4.4): the CPU this socket's flows are
/// steered to, so a listener per receive queue is served on the CPU that queue
/// interrupts.
///
/// # Arguments
///
/// * `socket` - any socket.
/// * `cpu` - the CPU index.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn set_incoming_cpu(socket: &impl Sock, cpu: usize) -> io::Result<()> {
    SockRef::from(socket).set_cpu_affinity(cpu)
}

/// The `SO_INCOMING_CPU` value (Linux, gettable since 3.19).
///
/// # Arguments
///
/// * `socket` - any socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn incoming_cpu(socket: &impl Sock) -> io::Result<usize> {
    SockRef::from(socket).cpu_affinity()
}

/// `TCP_DEFER_ACCEPT` (Linux): wake the listener only once data arrives on a new
/// connection, waiting at most `wait` (in whole seconds) for it.
///
/// # Arguments
///
/// * `socket` - a listening socket.
/// * `wait` - how long a bare connection may wait for its first data.
///
/// # Errors
///
/// `InvalidInput` when the seconds do not fit a C `int`, else the operating system's
/// error.
#[cfg(target_os = "linux")]
pub fn set_tcp_defer_accept(socket: &impl Sock, wait: std::time::Duration) -> io::Result<()> {
    raw::set_int(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_DEFER_ACCEPT,
        raw::int(wait.as_secs())?,
    )
}

/// The `TCP_DEFER_ACCEPT` wait (Linux). The kernel rounds the value it stores to its
/// retransmission schedule, so this can be longer than what was set.
///
/// # Arguments
///
/// * `socket` - a listening socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn tcp_defer_accept(socket: &impl Sock) -> io::Result<std::time::Duration> {
    let seconds = raw::get_int(socket, libc::IPPROTO_TCP, libc::TCP_DEFER_ACCEPT)?;
    Ok(std::time::Duration::from_secs(
        u64::try_from(seconds).unwrap_or(0),
    ))
}

/// `TCP_FASTOPEN` (Linux, since 3.6): accept RFC 7413 data in the SYN of a new
/// connection, with room for `queue` connections whose handshake has not completed.
///
/// # Arguments
///
/// * `socket` - a listening socket.
/// * `queue` - the pending-connection queue length; 0 turns the option off.
///
/// # Errors
///
/// `InvalidInput` when the length does not fit a C `int`, else the operating
/// system's error.
#[cfg(target_os = "linux")]
pub fn set_tcp_fastopen(socket: &impl Sock, queue: u32) -> io::Result<()> {
    raw::set_int(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_FASTOPEN,
        raw::int(queue)?,
    )
}

/// The `TCP_FASTOPEN` queue length (Linux).
///
/// # Arguments
///
/// * `socket` - a listening socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn tcp_fastopen(socket: &impl Sock) -> io::Result<u32> {
    let queue = raw::get_int(socket, libc::IPPROTO_TCP, libc::TCP_FASTOPEN)?;
    Ok(u32::try_from(queue).unwrap_or(0))
}

/// `UDP_SEGMENT` (Linux): segment every datagram written to this socket into
/// datagrams of `size` bytes in the kernel (UDP generic segmentation offload), so one
/// `sendmsg` carries a whole batch. A per-call size travels as a `UDP_SEGMENT` control
/// message instead.
///
/// # Arguments
///
/// * `socket` - a UDP socket.
/// * `size` - the segment size, or `None` to turn segmentation off.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn set_udp_segment(socket: &impl Sock, size: Option<u16>) -> io::Result<()> {
    raw::set_int(
        socket,
        libc::IPPROTO_UDP,
        libc::UDP_SEGMENT,
        size.map_or(0, libc::c_int::from),
    )
}

/// The `UDP_SEGMENT` size (Linux), `None` when segmentation is off.
///
/// # Arguments
///
/// * `socket` - a UDP socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn udp_segment(socket: &impl Sock) -> io::Result<Option<u16>> {
    let size = raw::get_int(socket, libc::IPPROTO_UDP, libc::UDP_SEGMENT)?;
    Ok(u16::try_from(size).ok().filter(|size| *size > 0))
}

/// `UDP_GRO` (Linux): let the kernel coalesce consecutive datagrams of one flow into a
/// single receive (UDP generic receive offload); the segment size then arrives as a
/// `UDP_GRO` control message beside the data.
///
/// # Arguments
///
/// * `socket` - a UDP socket.
/// * `on` - whether to coalesce.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn set_udp_gro(socket: &impl Sock, on: bool) -> io::Result<()> {
    raw::set_int(
        socket,
        libc::IPPROTO_UDP,
        libc::UDP_GRO,
        libc::c_int::from(on),
    )
}

/// Whether `UDP_GRO` is set (Linux).
///
/// # Arguments
///
/// * `socket` - a UDP socket.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn udp_gro(socket: &impl Sock) -> io::Result<bool> {
    Ok(raw::get_int(socket, libc::IPPROTO_UDP, libc::UDP_GRO)? != 0)
}

/// `IP_MTU_DISCOVER` / `IPV6_MTU_DISCOVER` set to the probe mode (Linux): send with
/// the don't-fragment flag and ignore the path MTU the kernel has learned, which is
/// what a transport that probes the path itself (RFC 8899 on QUIC) needs.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to set.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn set_mtu_probe(socket: &impl Sock, family: IpFamily) -> io::Result<()> {
    match family {
        IpFamily::V4 => raw::set_int(
            socket,
            libc::IPPROTO_IP,
            libc::IP_MTU_DISCOVER,
            libc::IP_PMTUDISC_PROBE,
        ),
        IpFamily::V6 => raw::set_int(
            socket,
            libc::IPPROTO_IPV6,
            libc::IPV6_MTU_DISCOVER,
            libc::IPV6_PMTUDISC_PROBE,
        ),
    }
}

/// Whether the socket is in the probe mode of path MTU discovery (Linux).
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to read.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn mtu_probe(socket: &impl Sock, family: IpFamily) -> io::Result<bool> {
    Ok(match family {
        IpFamily::V4 => {
            raw::get_int(socket, libc::IPPROTO_IP, libc::IP_MTU_DISCOVER)?
                == libc::IP_PMTUDISC_PROBE
        }
        IpFamily::V6 => {
            raw::get_int(socket, libc::IPPROTO_IPV6, libc::IPV6_MTU_DISCOVER)?
                == libc::IPV6_PMTUDISC_PROBE
        }
    })
}

/// `IP_RECVERR` / `IPV6_RECVERR` (Linux): queue the errors a datagram socket meets
/// (an ICMP unreachable, a path MTU update) on its error queue, to be read with
/// `recvmsg` and the error-queue flag as a `sock_extended_err` control message.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to set.
/// * `on` - whether to queue errors.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn set_recv_err(socket: &impl Sock, family: IpFamily, on: bool) -> io::Result<()> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_RECVERR),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_RECVERR),
    };
    raw::set_int(socket, level, name, libc::c_int::from(on))
}

/// Whether errors are queued (Linux).
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to read.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
pub fn recv_err(socket: &impl Sock, family: IpFamily) -> io::Result<bool> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_RECVERR),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_RECVERR),
    };
    Ok(raw::get_int(socket, level, name)? != 0)
}

/// `IP_PKTINFO` / `IPV6_RECVPKTINFO`: deliver the destination address and the
/// interface of each received datagram as a packet-information control message
/// (`IP_PKTINFO` with an `in_pktinfo`, `IPV6_PKTINFO` with an `in6_pktinfo`). Linux
/// and Apple platforms.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to set.
/// * `on` - whether to deliver the message.
///
/// # Errors
///
/// The operating system's error.
#[cfg(any(target_os = "linux", target_vendor = "apple"))]
pub fn set_recv_pktinfo(socket: &impl Sock, family: IpFamily, on: bool) -> io::Result<()> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_PKTINFO),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_RECVPKTINFO),
    };
    raw::set_int(socket, level, name, libc::c_int::from(on))
}

/// `IP_RECVTOS` / `IPV6_RECVTCLASS`: deliver the type-of-service byte (the traffic
/// class, which carries the ECN bits) of each received datagram as a control message.
/// Linux and Apple platforms.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to set.
/// * `on` - whether to deliver the byte.
///
/// # Errors
///
/// The operating system's error.
#[cfg(any(target_os = "linux", target_vendor = "apple"))]
pub fn set_recv_tos(socket: &impl Sock, family: IpFamily, on: bool) -> io::Result<()> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_RECVTOS),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_RECVTCLASS),
    };
    raw::set_int(socket, level, name, libc::c_int::from(on))
}

/// `IP_TOS` / `IPV6_TCLASS`: the type-of-service byte (the traffic class) every
/// datagram sent from this socket carries, ECN bits included. Linux and Apple
/// platforms.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to set.
/// * `tos` - the byte.
///
/// # Errors
///
/// The operating system's error.
#[cfg(any(target_os = "linux", target_vendor = "apple"))]
pub fn set_tos(socket: &impl Sock, family: IpFamily, tos: u8) -> io::Result<()> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_TOS),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_TCLASS),
    };
    raw::set_int(socket, level, name, libc::c_int::from(tos))
}

/// The `IP_TOS` / `IPV6_TCLASS` byte. Linux and Apple platforms.
///
/// # Arguments
///
/// * `socket` - a datagram socket.
/// * `family` - which protocol's option to read.
///
/// # Errors
///
/// The operating system's error, or `InvalidData` when the value is not a byte.
#[cfg(any(target_os = "linux", target_vendor = "apple"))]
pub fn tos(socket: &impl Sock, family: IpFamily) -> io::Result<u8> {
    let (level, name) = match family {
        IpFamily::V4 => (libc::IPPROTO_IP, libc::IP_TOS),
        IpFamily::V6 => (libc::IPPROTO_IPV6, libc::IPV6_TCLASS),
    };
    u8::try_from(raw::get_int(socket, level, name)?).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the traffic class is not a byte",
        )
    })
}

/// `SO_EXCLUSIVEADDRUSE` (Windows): refuse any other socket on this address, which
/// Microsoft's guidance asks of every server socket in place of `SO_REUSEADDR`
/// (`research/runtime-io.md`, Windows details). Set it before `bind`.
///
/// # Arguments
///
/// * `socket` - an unbound socket.
/// * `on` - whether to hold the address exclusively.
///
/// # Errors
///
/// The Winsock error.
#[cfg(windows)]
pub fn set_exclusive_address_use(socket: &impl Sock, on: bool) -> io::Result<()> {
    raw::set_int(
        socket,
        windows_sys::Win32::Networking::WinSock::SOL_SOCKET,
        windows_sys::Win32::Networking::WinSock::SO_EXCLUSIVEADDRUSE,
        i32::from(on),
    )
}

/// The one place that calls `setsockopt` and `getsockopt` with a C `int`.
#[cfg(unix)]
mod raw {
    use std::io;
    use std::mem::size_of;
    use std::os::fd::AsRawFd;
    use std::ptr;

    use libc::{c_int, socklen_t};

    use crate::Sock;

    /// The length of one C `int`, as the kernel wants it.
    const INT_LEN: socklen_t = size_of::<c_int>() as socklen_t;

    /// A value as a C `int`, or `InvalidInput` when it does not fit.
    #[cfg(target_os = "linux")]
    pub(super) fn int(value: impl TryInto<c_int>) -> io::Result<c_int> {
        value.try_into().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the value does not fit a C int",
            )
        })
    }

    /// `setsockopt` with one C `int`.
    #[allow(unsafe_code)]
    pub(super) fn set_int(
        socket: &impl Sock,
        level: c_int,
        name: c_int,
        value: c_int,
    ) -> io::Result<()> {
        let fd = socket.as_fd().as_raw_fd();
        // SAFETY: `fd` is borrowed for the duration of the call, `value` lives on this
        // frame until the call returns, and the length passed is its size, so the kernel
        // reads exactly one `c_int`.
        let rc =
            unsafe { libc::setsockopt(fd, level, name, ptr::from_ref(&value).cast(), INT_LEN) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// `getsockopt` of one C `int`; `InvalidData` when the kernel wrote another size.
    #[allow(unsafe_code)]
    pub(super) fn get_int(socket: &impl Sock, level: c_int, name: c_int) -> io::Result<c_int> {
        let fd = socket.as_fd().as_raw_fd();
        let mut value: c_int = 0;
        let mut len = INT_LEN;
        // SAFETY: `fd` is borrowed for the duration of the call; `value` and `len` live on
        // this frame, `len` is the size of `value`, and the kernel writes at most `len`
        // bytes into `value` and the written size into `len`.
        let rc = unsafe {
            libc::getsockopt(fd, level, name, ptr::from_mut(&mut value).cast(), &mut len)
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        if len != INT_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the option is not a C int",
            ));
        }
        Ok(value)
    }
}

/// The one place that calls Winsock's `setsockopt` with a C `int`.
#[cfg(windows)]
mod raw {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::AsRawSocket;
    use std::ptr;

    use windows_sys::Win32::Networking::WinSock::{
        setsockopt, WSAGetLastError, SOCKET, SOCKET_ERROR,
    };

    use crate::Sock;

    /// The length of one C `int`, as Winsock wants it.
    const INT_LEN: i32 = size_of::<i32>() as i32;

    /// `setsockopt` with one C `int`.
    #[allow(unsafe_code)]
    pub(super) fn set_int(socket: &impl Sock, level: i32, name: i32, value: i32) -> io::Result<()> {
        let raw = socket.as_socket().as_raw_socket();
        let handle = SOCKET::try_from(raw).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the socket handle does not fit",
            )
        })?;
        // SAFETY: the socket is borrowed for the duration of the call, `value` lives on
        // this frame until the call returns, and the length passed is its size, so Winsock
        // reads exactly one `int`.
        let rc = unsafe { setsockopt(handle, level, name, ptr::from_ref(&value).cast(), INT_LEN) };
        if rc == SOCKET_ERROR {
            // SAFETY: reads the calling thread's last Winsock error; no preconditions.
            let code = unsafe { WSAGetLastError() };
            return Err(io::Error::from_raw_os_error(code));
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::net::UdpSocket;
    use std::time::Duration;

    use socket2::{Domain, Socket, Type};

    use super::{
        incoming_cpu, mtu_probe, recv_err, reuse_port, set_incoming_cpu, set_mtu_probe,
        set_recv_err, set_recv_pktinfo, set_recv_tos, set_reuse_port, set_tcp_defer_accept,
        set_tcp_fastopen, set_tcp_nodelay, set_tos, set_udp_gro, set_udp_segment, tcp_defer_accept,
        tcp_fastopen, tcp_nodelay, tos, udp_gro, udp_segment, IpFamily,
    };

    fn tcp() -> Socket {
        Socket::new(Domain::IPV4, Type::STREAM, None).unwrap()
    }

    fn udp() -> UdpSocket {
        UdpSocket::bind("127.0.0.1:0").unwrap()
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_listener_options_round_trip() {
        let socket = tcp();
        set_reuse_port(&socket, true).unwrap();
        assert!(reuse_port(&socket).unwrap());
        set_reuse_port(&socket, false).unwrap();
        assert!(!reuse_port(&socket).unwrap());

        set_incoming_cpu(&socket, 0).unwrap();
        assert_eq!(incoming_cpu(&socket).unwrap(), 0);

        set_tcp_defer_accept(&socket, Duration::from_secs(5)).unwrap();
        assert!(tcp_defer_accept(&socket).unwrap() >= Duration::from_secs(5));
        set_tcp_defer_accept(&socket, Duration::ZERO).unwrap();
        assert_eq!(tcp_defer_accept(&socket).unwrap(), Duration::ZERO);
        assert_eq!(
            set_tcp_defer_accept(&socket, Duration::from_secs(u64::MAX))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidInput
        );

        set_tcp_fastopen(&socket, 64).unwrap();
        assert_eq!(tcp_fastopen(&socket).unwrap(), 64);

        set_tcp_nodelay(&socket, true).unwrap();
        assert!(tcp_nodelay(&socket).unwrap());
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_datagram_options_round_trip() {
        let socket = udp();
        set_udp_segment(&socket, Some(1200)).unwrap();
        assert_eq!(udp_segment(&socket).unwrap(), Some(1200));
        set_udp_segment(&socket, None).unwrap();
        assert_eq!(udp_segment(&socket).unwrap(), None);

        set_udp_gro(&socket, true).unwrap();
        assert!(udp_gro(&socket).unwrap());

        assert!(!mtu_probe(&socket, IpFamily::V4).unwrap());
        set_mtu_probe(&socket, IpFamily::V4).unwrap();
        assert!(mtu_probe(&socket, IpFamily::V4).unwrap());

        assert!(!recv_err(&socket, IpFamily::V4).unwrap());
        set_recv_err(&socket, IpFamily::V4, true).unwrap();
        assert!(recv_err(&socket, IpFamily::V4).unwrap());

        set_recv_pktinfo(&socket, IpFamily::V4, true).unwrap();
        set_recv_tos(&socket, IpFamily::V4, true).unwrap();
        set_tos(&socket, IpFamily::V4, 0xb8).unwrap();
        assert_eq!(tos(&socket, IpFamily::V4).unwrap(), 0xb8);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_ipv6_options_name_their_own_level() {
        let socket = match UdpSocket::bind("[::1]:0") {
            Ok(socket) => socket,
            Err(_) => return,
        };
        set_mtu_probe(&socket, IpFamily::V6).unwrap();
        assert!(mtu_probe(&socket, IpFamily::V6).unwrap());
        set_recv_err(&socket, IpFamily::V6, true).unwrap();
        assert!(recv_err(&socket, IpFamily::V6).unwrap());
        set_recv_pktinfo(&socket, IpFamily::V6, true).unwrap();
        set_recv_tos(&socket, IpFamily::V6, true).unwrap();
        set_tos(&socket, IpFamily::V6, 0x28).unwrap();
        assert_eq!(tos(&socket, IpFamily::V6).unwrap(), 0x28);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_tcp_option_on_a_udp_socket_is_the_kernels_error_not_a_panic() {
        let socket = udp();
        let err = set_tcp_fastopen(&socket, 1).unwrap_err();
        assert!(err.raw_os_error().is_some(), "{err}");
    }
}
