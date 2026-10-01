//! `sendmsg(2)` and `recvmsg(2)` over borrowed buffers and a control buffer.
//!
//! The message header is built on the stack from borrowed slices: the data slices (an
//! `IoSlice` is ABI compatible with `iovec`, which the standard library guarantees), the
//! control buffer, and the address storage socket2 provides; every length the kernel
//! sees is the length of the slice it describes, and the slice count is capped at what
//! the kernel accepts. The calls take no ownership, so a buffer that was borrowed for a
//! call is the caller's again when it returns, which is what the owned-buffer seam of
//! `zero-io` builds on.
//!
//! Sources: sendmsg(2), recvmsg(2) and cmsg(3) of the Linux man-pages project, the pinned
//! libc crate's `msghdr` and `iovec` definitions, and the standard library's `IoSlice`
//! documentation at the pinned Rust version.

use std::io::{self, IoSlice, IoSliceMut};
use std::mem;
use std::net::SocketAddr;
use std::os::fd::AsRawFd;
use std::ptr;

use libc::{c_int, msghdr, socklen_t};
use socket2::{SockAddr, SockAddrStorage};

use crate::Sock;

/// The most data slices one call may carry: `UIO_MAXIOV` on Linux and `IOV_MAX` on
/// Apple platforms, 1,024 on both.
pub const MAX_SLICES: usize = 1024;

/// How `recvmsg` behaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecvFlags {
    /// `MSG_DONTWAIT`: fail with `WouldBlock` rather than wait for data.
    pub dont_wait: bool,
    /// `MSG_PEEK`: read without consuming.
    pub peek: bool,
    /// `MSG_ERRQUEUE` (Linux): read the socket's error queue (see
    /// [`set_recv_err`](crate::sockopt::set_recv_err)) rather than its data.
    #[cfg(target_os = "linux")]
    pub error_queue: bool,
}

impl RecvFlags {
    fn bits(self) -> c_int {
        let mut bits = 0;
        if self.dont_wait {
            bits |= libc::MSG_DONTWAIT;
        }
        if self.peek {
            bits |= libc::MSG_PEEK;
        }
        #[cfg(target_os = "linux")]
        if self.error_queue {
            bits |= libc::MSG_ERRQUEUE;
        }
        bits
    }
}

/// How `sendmsg` behaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SendFlags {
    /// `MSG_DONTWAIT`: fail with `WouldBlock` rather than wait for room.
    pub dont_wait: bool,
    /// `MSG_NOSIGNAL`: report a closed peer as `EPIPE` rather than raising `SIGPIPE`.
    pub no_signal: bool,
}

impl SendFlags {
    fn bits(self) -> c_int {
        let mut bits = 0;
        if self.dont_wait {
            bits |= libc::MSG_DONTWAIT;
        }
        if self.no_signal {
            bits |= libc::MSG_NOSIGNAL;
        }
        bits
    }
}

/// What one `recvmsg` returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Received {
    /// The data bytes written into the slices, in order.
    pub bytes: usize,
    /// The control bytes written; [`cmsg::messages`](crate::cmsg::messages) walks them.
    pub control: usize,
    /// `MSG_TRUNC`: the datagram was longer than the slices and the rest is gone.
    pub truncated: bool,
    /// `MSG_CTRUNC`: the control messages were longer than the control buffer.
    pub control_truncated: bool,
    /// Who sent it, when the socket is not connected and the address is an Internet one.
    pub from: Option<SocketAddr>,
}

/// Receive one message.
///
/// # Arguments
///
/// * `socket` - the socket.
/// * `bufs` - where the data goes, filled in order; at most [`MAX_SLICES`].
/// * `control` - where the control messages go; empty when none are wanted.
/// * `flags` - how to receive.
///
/// # Returns
///
/// What was received.
///
/// # Errors
///
/// `InvalidInput` for more slices than the kernel accepts or a control buffer longer
/// than its length field holds, else the operating system's error.
#[allow(unsafe_code)]
pub fn recvmsg(
    socket: &impl Sock,
    bufs: &mut [IoSliceMut<'_>],
    control: &mut [u8],
    flags: RecvFlags,
) -> io::Result<Received> {
    let fd = socket.as_fd().as_raw_fd();
    let mut header = zeroed_header();
    header.msg_iov = bufs.as_mut_ptr().cast();
    header.msg_iovlen = slice_count(bufs.len())?;
    if !control.is_empty() {
        header.msg_control = control.as_mut_ptr().cast();
        header.msg_controllen = control_len(control.len())?;
    }
    let mut storage = SockAddrStorage::zeroed();
    header.msg_name = ptr::from_mut(&mut storage).cast();
    header.msg_namelen = STORAGE_LEN;
    // SAFETY: `fd` is borrowed for the duration of the call, and every pointer in
    // `header` names memory that lives at least as long: the slice array and the control
    // buffer are borrowed for the call and `storage` is on this frame, with each length
    // the size of what it describes.
    let received = unsafe { libc::recvmsg(fd, &mut header, flags.bits()) };
    let bytes = usize::try_from(received).map_err(|_| io::Error::last_os_error())?;
    let from = if header.msg_namelen == 0 {
        None
    } else {
        let len = header.msg_namelen.min(STORAGE_LEN);
        // SAFETY: the kernel wrote `msg_namelen` bytes of a socket address into
        // `storage`, which is at least `len` bytes long.
        let addr = unsafe { SockAddr::new(storage, len) };
        addr.as_socket()
    };
    Ok(Received {
        bytes,
        control: to_usize(header.msg_controllen),
        truncated: header.msg_flags & libc::MSG_TRUNC != 0,
        control_truncated: header.msg_flags & libc::MSG_CTRUNC != 0,
        from,
    })
}

/// Send one message.
///
/// # Arguments
///
/// * `socket` - the socket.
/// * `bufs` - the data, sent in order; at most [`MAX_SLICES`].
/// * `control` - the control messages, as [`cmsg::Builder`](crate::cmsg::Builder)
///   wrote them; empty when none.
/// * `to` - the destination, or `None` on a connected socket.
/// * `flags` - how to send.
///
/// # Returns
///
/// How many data bytes were sent.
///
/// # Errors
///
/// `InvalidInput` for more slices than the kernel accepts or a control buffer longer
/// than its length field holds, else the operating system's error.
#[allow(unsafe_code)]
pub fn sendmsg(
    socket: &impl Sock,
    bufs: &[IoSlice<'_>],
    control: &[u8],
    to: Option<SocketAddr>,
    flags: SendFlags,
) -> io::Result<usize> {
    let fd = socket.as_fd().as_raw_fd();
    let addr = to.map(SockAddr::from);
    let mut header = zeroed_header();
    if let Some(addr) = &addr {
        header.msg_name = addr.as_ptr().cast_mut().cast();
        header.msg_namelen = addr.len();
    }
    header.msg_iov = bufs.as_ptr().cast_mut().cast();
    header.msg_iovlen = slice_count(bufs.len())?;
    if !control.is_empty() {
        header.msg_control = control.as_ptr().cast_mut().cast();
        header.msg_controllen = control_len(control.len())?;
    }
    // SAFETY: `fd` is borrowed for the duration of the call, and every pointer in
    // `header` names memory that lives at least as long: the slice array, the control
    // buffer and `addr` are borrowed for the call, with each length the size of what it
    // describes; `sendmsg` only reads through them.
    let sent = unsafe { libc::sendmsg(fd, &header, flags.bits()) };
    usize::try_from(sent).map_err(|_| io::Error::last_os_error())
}

/// The address storage size, as `msg_namelen` is first set.
const STORAGE_LEN: socklen_t = mem::size_of::<SockAddrStorage>() as socklen_t;

/// A message header with null pointers and zero lengths.
#[allow(unsafe_code)]
fn zeroed_header() -> msghdr {
    // SAFETY: `msghdr` is a plain C struct of pointers and integers, for which the
    // all-zero pattern is a valid value: null pointers and zero lengths.
    unsafe { mem::zeroed() }
}

/// The slice count as the header's own field type, refused beyond [`MAX_SLICES`].
fn slice_count<T: TryFrom<usize>>(count: usize) -> io::Result<T> {
    if count > MAX_SLICES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "more data slices than one message may carry",
        ));
    }
    T::try_from(count)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the slice count does not fit"))
}

/// A length the kernel wrote, in the header's own field type, as a `usize`.
fn to_usize<T: TryInto<usize>>(len: T) -> usize {
    len.try_into().unwrap_or(0)
}

/// The control length as the header's own field type.
fn control_len<T: TryFrom<usize>>(len: usize) -> io::Result<T> {
    T::try_from(len).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the control buffer is longer than its length field holds",
        )
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::io::{IoSlice, IoSliceMut};
    use std::mem::{offset_of, size_of};
    use std::net::UdpSocket;

    use super::{recvmsg, sendmsg, RecvFlags, SendFlags, MAX_SLICES};
    use crate::cmsg::{messages, space, Builder};
    use crate::sockopt::{set_recv_pktinfo, set_recv_tos, IpFamily};

    fn pair() -> (UdpSocket, UdpSocket) {
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        (sender, receiver)
    }

    /// An `in_pktinfo` naming the loopback address as the source, as bytes.
    fn loopback_pktinfo() -> Vec<u8> {
        let mut info = vec![0u8; size_of::<libc::in_pktinfo>()];
        let at = offset_of!(libc::in_pktinfo, ipi_spec_dst);
        info[at..at + 4].copy_from_slice(&[127, 0, 0, 1]);
        info
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn control_messages_travel_both_ways() {
        let (sender, receiver) = pair();
        set_recv_pktinfo(&receiver, IpFamily::V4, true).unwrap();
        set_recv_tos(&receiver, IpFamily::V4, true).unwrap();

        let mut out = vec![0u8; space(size_of::<libc::in_pktinfo>()).unwrap()];
        let mut builder = Builder::new(&mut out);
        builder
            .push(libc::IPPROTO_IP, libc::IP_PKTINFO, &loopback_pktinfo())
            .unwrap();
        let control_len = builder.len();
        let sent = sendmsg(
            &sender,
            &[IoSlice::new(b"hel"), IoSlice::new(b"lo")],
            &out[..control_len],
            Some(receiver.local_addr().unwrap()),
            SendFlags {
                no_signal: true,
                ..SendFlags::default()
            },
        )
        .unwrap();
        assert_eq!(sent, 5);

        let mut first = [0u8; 2];
        let mut second = [0u8; 8];
        let mut control = [0u8; 128];
        let received = recvmsg(
            &receiver,
            &mut [IoSliceMut::new(&mut first), IoSliceMut::new(&mut second)],
            &mut control,
            RecvFlags::default(),
        )
        .unwrap();
        assert_eq!(received.bytes, 5);
        assert_eq!(&first, b"he");
        assert_eq!(&second[..3], b"llo");
        assert!(!received.truncated);
        assert!(!received.control_truncated);
        assert_eq!(received.from, Some(sender.local_addr().unwrap()));
        let found: Vec<_> = messages(&control[..received.control]).collect();
        let pktinfo = found
            .iter()
            .find(|message| message.level == libc::IPPROTO_IP && message.kind == libc::IP_PKTINFO)
            .expect("the packet information arrives");
        let at = offset_of!(libc::in_pktinfo, ipi_addr);
        assert_eq!(
            &pktinfo.data[at..at + 4],
            &[127, 0, 0, 1],
            "delivered to loopback"
        );
        let tos = found
            .iter()
            .find(|message| message.level == libc::IPPROTO_IP && message.kind == libc::IP_TOS)
            .expect("the type of service arrives");
        assert_eq!(tos.data.first(), Some(&0));
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_short_buffer_reports_the_truncation() {
        let (sender, receiver) = pair();
        sendmsg(
            &sender,
            &[IoSlice::new(b"0123456789")],
            &[],
            Some(receiver.local_addr().unwrap()),
            SendFlags::default(),
        )
        .unwrap();
        let mut buf = [0u8; 4];
        let received = recvmsg(
            &receiver,
            &mut [IoSliceMut::new(&mut buf)],
            &mut [],
            RecvFlags::default(),
        )
        .unwrap();
        assert_eq!(received.bytes, 4);
        assert!(received.truncated);
        assert_eq!(received.control, 0);
        assert_eq!(&buf, b"0123");
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn an_empty_socket_does_not_wait_when_told_not_to() {
        let (_, receiver) = pair();
        let mut buf = [0u8; 4];
        let err = recvmsg(
            &receiver,
            &mut [IoSliceMut::new(&mut buf)],
            &mut [],
            RecvFlags {
                dont_wait: true,
                ..RecvFlags::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn too_many_slices_are_refused_before_the_call() {
        let (sender, receiver) = pair();
        let slices = vec![IoSlice::new(b"x"); MAX_SLICES + 1];
        let err = sendmsg(
            &sender,
            &slices,
            &[],
            Some(receiver.local_addr().unwrap()),
            SendFlags::default(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }
}
