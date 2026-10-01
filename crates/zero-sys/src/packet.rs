//! The control messages a datagram socket exchanges, typed: packet information (the
//! destination of a received datagram, the source to send one from), the
//! type-of-service byte that carries the ECN codepoint, and the segment size of UDP
//! generic segmentation and receive offload.
//!
//! Sources: ip(7) for `IP_PKTINFO` and `IP_RECVTOS`; the Linux kernel's
//! `net/ipv4/ip_sockglue.c` (a received type of service is one byte of type `IP_TOS`,
//! and a sent `IP_TOS` message may be an `int` or a byte) and `net/ipv6/datagram.c`
//! (`IPV6_TCLASS` on send is an `int`); XNU's `netinet/ip_input.c` (a received type of
//! service is one byte of type `IP_RECVTOS`); the UDP GSO selftests (`UDP_SEGMENT` on
//! send is a `u16`, `UDP_GRO` on receive an `int`); and the layouts of `in_pktinfo` and
//! `in6_pktinfo` in the pinned libc crate, read with `offset_of!`.

use std::mem::{offset_of, size_of};
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::cmsg::{space, Builder, ControlMessage, Full};

/// A control buffer large enough for every message one datagram carries: packet
/// information, the type of service, and the segment size.
pub const CONTROL_SPACE: usize = 128;

const _: () = assert!(match (
    space(size_of::<libc::in6_pktinfo>()),
    space(size_of::<i32>()),
    space(size_of::<u16>())
) {
    (Some(info), Some(tos), Some(segment)) => info + tos + segment <= CONTROL_SPACE,
    _ => false,
});

/// A control message this module understands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Known {
    /// `IP_PKTINFO`: the IPv4 address a datagram arrived at and the interface index.
    V4Destination {
        /// The destination address.
        addr: Ipv4Addr,
        /// The interface the datagram arrived on.
        interface: u32,
    },
    /// `IPV6_PKTINFO`: the IPv6 address a datagram arrived at and the interface index.
    V6Destination {
        /// The destination address.
        addr: Ipv6Addr,
        /// The interface the datagram arrived on.
        interface: u32,
    },
    /// `IP_TOS` or `IPV6_TCLASS` (`IP_RECVTOS` on Apple platforms): the type of service
    /// or traffic class byte the datagram carried, ECN bits included.
    Tos(u8),
    /// `UDP_GRO` (Linux): the segment size the kernel coalesced consecutive datagrams
    /// at, so the buffer holds several of that size.
    GroSegment(u16),
}

/// Read a control message a datagram socket delivered.
///
/// # Arguments
///
/// * `message` - one message from the control buffer.
///
/// # Returns
///
/// The typed message, or `None` for a level and type this module does not know or a
/// payload of the wrong size.
#[must_use]
pub fn known(message: &ControlMessage<'_>) -> Option<Known> {
    match (message.level, message.kind) {
        (libc::IPPROTO_IP, libc::IP_PKTINFO) => v4_destination(message.data),
        (libc::IPPROTO_IPV6, libc::IPV6_PKTINFO) => v6_destination(message.data),
        (libc::IPPROTO_IP, libc::IP_TOS) | (libc::IPPROTO_IPV6, libc::IPV6_TCLASS) => {
            tos(message.data)
        }
        #[cfg(target_vendor = "apple")]
        (libc::IPPROTO_IP, libc::IP_RECVTOS) => tos(message.data),
        #[cfg(target_os = "linux")]
        (libc::SOL_UDP, libc::UDP_GRO) => {
            let size = message.int()?;
            u16::try_from(size).ok().map(Known::GroSegment)
        }
        _ => None,
    }
}

fn v4_destination(data: &[u8]) -> Option<Known> {
    if data.len() < size_of::<libc::in_pktinfo>() {
        return None;
    }
    let addr = octets::<4>(data, offset_of!(libc::in_pktinfo, ipi_addr))?;
    let interface = u32::from_ne_bytes(octets::<4>(
        data,
        offset_of!(libc::in_pktinfo, ipi_ifindex),
    )?);
    Some(Known::V4Destination {
        addr: Ipv4Addr::from(addr),
        interface,
    })
}

fn v6_destination(data: &[u8]) -> Option<Known> {
    if data.len() < size_of::<libc::in6_pktinfo>() {
        return None;
    }
    let addr = octets::<16>(data, offset_of!(libc::in6_pktinfo, ipi6_addr))?;
    let interface = u32::from_ne_bytes(octets::<4>(
        data,
        offset_of!(libc::in6_pktinfo, ipi6_ifindex),
    )?);
    Some(Known::V6Destination {
        addr: Ipv6Addr::from(addr),
        interface,
    })
}

/// A byte on Linux and Apple platforms for IPv4, an `int` for the IPv6 traffic class.
fn tos(data: &[u8]) -> Option<Known> {
    match *data {
        [byte] => Some(Known::Tos(byte)),
        [a, b, c, d] => u8::try_from(i32::from_ne_bytes([a, b, c, d]))
            .ok()
            .map(Known::Tos),
        _ => None,
    }
}

fn octets<const N: usize>(data: &[u8], at: usize) -> Option<[u8; N]> {
    let mut out = [0u8; N];
    out.copy_from_slice(data.get(at..at.checked_add(N)?)?);
    Some(out)
}

/// Append `IP_PKTINFO` naming the source address to send from.
///
/// # Arguments
///
/// * `builder` - the control buffer being written.
/// * `source` - the local IPv4 address.
///
/// # Errors
///
/// [`Full`] when the buffer has no room.
pub fn push_v4_source(builder: &mut Builder<'_>, source: Ipv4Addr) -> Result<(), Full> {
    let mut data = [0u8; size_of::<libc::in_pktinfo>()];
    let at = offset_of!(libc::in_pktinfo, ipi_spec_dst);
    data.get_mut(at..at + 4)
        .ok_or(Full)?
        .copy_from_slice(&source.octets());
    builder.push(libc::IPPROTO_IP, libc::IP_PKTINFO, &data)
}

/// Append `IPV6_PKTINFO` naming the source address to send from.
///
/// # Arguments
///
/// * `builder` - the control buffer being written.
/// * `source` - the local IPv6 address.
///
/// # Errors
///
/// [`Full`] when the buffer has no room.
pub fn push_v6_source(builder: &mut Builder<'_>, source: Ipv6Addr) -> Result<(), Full> {
    let mut data = [0u8; size_of::<libc::in6_pktinfo>()];
    let at = offset_of!(libc::in6_pktinfo, ipi6_addr);
    data.get_mut(at..at + 16)
        .ok_or(Full)?
        .copy_from_slice(&source.octets());
    builder.push(libc::IPPROTO_IPV6, libc::IPV6_PKTINFO, &data)
}

/// Append the type of service (IPv4, one byte) or traffic class (IPv6, an `int`) to
/// send one datagram with, ECN bits included. Linux.
///
/// # Arguments
///
/// * `builder` - the control buffer being written.
/// * `v6` - whether the socket is IPv6.
/// * `tos` - the byte.
///
/// # Errors
///
/// [`Full`] when the buffer has no room.
#[cfg(target_os = "linux")]
pub fn push_tos(builder: &mut Builder<'_>, v6: bool, tos: u8) -> Result<(), Full> {
    if v6 {
        builder.push(
            libc::IPPROTO_IPV6,
            libc::IPV6_TCLASS,
            &i32::from(tos).to_ne_bytes(),
        )
    } else {
        builder.push(libc::IPPROTO_IP, libc::IP_TOS, &[tos])
    }
}

/// Append `UDP_SEGMENT`: split the datagram into segments of `size` bytes in the
/// kernel (generic segmentation offload). Linux.
///
/// # Arguments
///
/// * `builder` - the control buffer being written.
/// * `size` - the segment size.
///
/// # Errors
///
/// [`Full`] when the buffer has no room.
#[cfg(target_os = "linux")]
pub fn push_segment_size(builder: &mut Builder<'_>, size: u16) -> Result<(), Full> {
    builder.push(libc::SOL_UDP, libc::UDP_SEGMENT, &size.to_ne_bytes())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::{known, push_v4_source, push_v6_source, Known, CONTROL_SPACE};
    use crate::cmsg::{messages, Builder, ControlMessage};

    #[test]
    fn packet_information_round_trips_through_the_builder() {
        let mut buf = [0u8; CONTROL_SPACE];
        let mut builder = Builder::new(&mut buf);
        push_v4_source(&mut builder, Ipv4Addr::new(10, 1, 2, 3)).unwrap();
        push_v6_source(&mut builder, Ipv6Addr::LOCALHOST).unwrap();
        let written = builder.written().to_vec();
        let found: Vec<Known> = messages(&written).filter_map(|m| known(&m)).collect();
        // The address written as the source sits in `ipi_spec_dst`; on receipt the
        // kernel fills `ipi_addr`, which the sent message leaves zero.
        assert_eq!(
            found,
            [
                Known::V4Destination {
                    addr: Ipv4Addr::UNSPECIFIED,
                    interface: 0
                },
                Known::V6Destination {
                    addr: Ipv6Addr::LOCALHOST,
                    interface: 0
                }
            ]
        );
    }

    #[test]
    fn the_type_of_service_is_read_as_a_byte_or_an_int() {
        let byte = ControlMessage {
            level: libc::IPPROTO_IP,
            kind: libc::IP_TOS,
            data: &[0xb9],
        };
        assert_eq!(known(&byte), Some(Known::Tos(0xb9)));
        let int = ControlMessage {
            level: libc::IPPROTO_IPV6,
            kind: libc::IPV6_TCLASS,
            data: &0x2ai32.to_ne_bytes(),
        };
        assert_eq!(known(&int), Some(Known::Tos(0x2a)));
        let wide = ControlMessage {
            level: libc::IPPROTO_IPV6,
            kind: libc::IPV6_TCLASS,
            data: &300i32.to_ne_bytes(),
        };
        assert_eq!(known(&wide), None);
        let short = ControlMessage {
            level: libc::IPPROTO_IP,
            kind: libc::IP_PKTINFO,
            data: &[0; 3],
        };
        assert_eq!(known(&short), None);
        let unknown = ControlMessage {
            level: libc::SOL_SOCKET,
            kind: 1,
            data: &[1, 2, 3, 4],
        };
        assert_eq!(known(&unknown), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_offload_messages_round_trip() {
        use super::{push_segment_size, push_tos};
        let mut buf = [0u8; CONTROL_SPACE];
        let mut builder = Builder::new(&mut buf);
        push_segment_size(&mut builder, 1200).unwrap();
        push_tos(&mut builder, false, 0x02).unwrap();
        push_tos(&mut builder, true, 0x01).unwrap();
        let written = builder.written().to_vec();
        let found: Vec<ControlMessage> = messages(&written).collect();
        assert_eq!(found[0].level, libc::SOL_UDP);
        assert_eq!(found[0].kind, libc::UDP_SEGMENT);
        assert_eq!(found[0].data, 1200u16.to_ne_bytes());
        assert_eq!(known(&found[1]), Some(Known::Tos(0x02)));
        assert_eq!(known(&found[2]), Some(Known::Tos(0x01)));
        let gro = ControlMessage {
            level: libc::SOL_UDP,
            kind: libc::UDP_GRO,
            data: &1400i32.to_ne_bytes(),
        };
        assert_eq!(known(&gro), Some(Known::GroSegment(1400)));
    }
}
