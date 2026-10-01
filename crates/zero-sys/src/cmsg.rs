//! Control messages (ancillary data), built and parsed without a pointer in sight.
//!
//! A control buffer is a sequence of `cmsghdr` headers, each followed by its data and
//! padded to the platform's alignment: `CMSG_ALIGN` rounds to the size of a pointer on
//! Linux and to four bytes on Apple platforms; `cmsg_len` counts the header and the data
//! but not the padding (`CMSG_LEN`); `CMSG_SPACE` is the whole element (cmsg(3) and the
//! pinned libc crate's definitions). The header's field offsets and the width of its
//! length field are taken from libc's `cmsghdr` with `offset_of!` and the field's own
//! type, so the bytes written here are the bytes the C macros would write on every
//! target, and nothing is cast.
//!
//! Parsing trusts no length: an element whose `cmsg_len` is shorter than a header or
//! longer than what is left ends the walk, where `CMSG_NXTHDR` returns null. The walk
//! is total over any byte sequence, which the `cmsg_decode` fuzz target holds.

use core::mem::{offset_of, size_of};

/// `sizeof(struct cmsghdr)`.
const HEADER: usize = size_of::<libc::cmsghdr>();

/// What `CMSG_ALIGN` rounds to: `__DARWIN_ALIGN32` on Apple platforms, a pointer elsewhere.
#[cfg(target_vendor = "apple")]
const ALIGN: usize = 4;
#[cfg(not(target_vendor = "apple"))]
const ALIGN: usize = size_of::<usize>();

const _: () = assert!(ALIGN.is_power_of_two());

/// Where the data of an element starts: `CMSG_ALIGN(sizeof(struct cmsghdr))`.
const DATA: usize = match align(HEADER) {
    Some(data) => data,
    None => panic!("the header aligns"),
};

const _: () = assert!(DATA >= HEADER && DATA.is_multiple_of(ALIGN));

const LEN_AT: usize = offset_of!(libc::cmsghdr, cmsg_len);
const LEVEL_AT: usize = offset_of!(libc::cmsghdr, cmsg_level);
const TYPE_AT: usize = offset_of!(libc::cmsghdr, cmsg_type);

/// `CMSG_ALIGN`: `len` rounded up to the alignment.
const fn align(len: usize) -> Option<usize> {
    match len.checked_add(ALIGN - 1) {
        Some(sum) => Some(sum & !(ALIGN - 1)),
        None => None,
    }
}

/// `CMSG_SPACE`: the bytes an element with `data_len` bytes of data occupies in a
/// control buffer, padding included.
///
/// # Arguments
///
/// * `data_len` - the data length.
///
/// # Returns
///
/// The element size, or `None` when it does not fit in `usize`.
#[must_use]
pub const fn space(data_len: usize) -> Option<usize> {
    match align(data_len) {
        Some(data) => data.checked_add(DATA),
        None => None,
    }
}

/// `CMSG_LEN`: the value of `cmsg_len` for an element with `data_len` bytes of data.
///
/// # Arguments
///
/// * `data_len` - the data length.
///
/// # Returns
///
/// The header and the data, or `None` when the sum does not fit in `usize`.
#[must_use]
pub const fn len(data_len: usize) -> Option<usize> {
    DATA.checked_add(data_len)
}

/// An integer type the `cmsg_len` field can have (`size_t` on Linux, `socklen_t` on
/// Apple platforms); which one is read off libc's struct, never assumed.
trait LenField: Copy {
    const WIDTH: usize;
    fn encode(len: usize) -> Option<Self>;
    fn write(self, out: &mut [u8]) -> Option<()>;
    fn read(bytes: &[u8]) -> Option<usize>;
}

macro_rules! len_field {
    ($t:ty) => {
        impl LenField for $t {
            const WIDTH: usize = size_of::<$t>();

            fn encode(len: usize) -> Option<Self> {
                <$t>::try_from(len).ok()
            }

            fn write(self, out: &mut [u8]) -> Option<()> {
                out.get_mut(..Self::WIDTH)?
                    .copy_from_slice(&self.to_ne_bytes());
                Some(())
            }

            fn read(bytes: &[u8]) -> Option<usize> {
                let mut raw = [0u8; size_of::<$t>()];
                raw.copy_from_slice(bytes.get(..Self::WIDTH)?);
                usize::try_from(<$t>::from_ne_bytes(raw)).ok()
            }
        }
    };
}

len_field!(u32);
len_field!(u64);
len_field!(usize);

/// Pins the length field's type to the type of `cmsghdr::cmsg_len` on this target: the
/// closure is never called, it only carries the field's type into `T`.
fn with_len_type<T: LenField, R>(
    _: impl Fn(&libc::cmsghdr) -> T,
    f: impl FnOnce(fn(usize) -> Option<T>, fn(&[u8]) -> Option<usize>) -> R,
) -> R {
    f(T::encode, T::read)
}

fn write_len(out: &mut [u8], len: usize) -> Option<()> {
    with_len_type(
        |header: &libc::cmsghdr| header.cmsg_len,
        |encode, _| {
            let field = encode(len)?;
            field.write(out.get_mut(LEN_AT..)?)
        },
    )
}

fn read_len(bytes: &[u8]) -> Option<usize> {
    with_len_type(
        |header: &libc::cmsghdr| header.cmsg_len,
        |_, read| read(bytes.get(LEN_AT..)?),
    )
}

fn read_i32(bytes: &[u8], at: usize) -> Option<i32> {
    let mut raw = [0u8; size_of::<i32>()];
    raw.copy_from_slice(bytes.get(at..at.checked_add(size_of::<i32>())?)?);
    Some(i32::from_ne_bytes(raw))
}

fn write_i32(out: &mut [u8], at: usize, value: i32) -> Option<()> {
    out.get_mut(at..at.checked_add(size_of::<i32>())?)?
        .copy_from_slice(&value.to_ne_bytes());
    Some(())
}

/// One control message: its protocol level, its type within that level, and its data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlMessage<'a> {
    /// The originating protocol (`cmsg_level`): `IPPROTO_IP`, `SOL_UDP` and so on.
    pub level: i32,
    /// The protocol-specific type (`cmsg_type`): `IP_PKTINFO`, `UDP_GRO` and so on.
    pub kind: i32,
    /// The data, without the header or the padding.
    pub data: &'a [u8],
}

impl ControlMessage<'_> {
    /// The data as the C `int` most options carry.
    ///
    /// # Returns
    ///
    /// The value, or `None` when the data is not exactly one `int` wide.
    #[must_use]
    pub fn int(&self) -> Option<i32> {
        if self.data.len() == size_of::<i32>() {
            read_i32(self.data, 0)
        } else {
            None
        }
    }
}

/// The control messages in a buffer, in order.
///
/// # Arguments
///
/// * `control` - the control buffer, cut to the length `recvmsg` reported.
///
/// # Returns
///
/// An iterator that ends at the first element that does not fit.
#[must_use]
pub fn messages(control: &[u8]) -> Messages<'_> {
    Messages { rest: control }
}

/// The iterator [`messages`] returns.
#[derive(Clone, Debug)]
pub struct Messages<'a> {
    rest: &'a [u8],
}

impl<'a> Iterator for Messages<'a> {
    type Item = ControlMessage<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let rest = self.rest;
        let item = element(rest);
        self.rest = match item {
            Some((_, step)) => rest.get(step..).unwrap_or(&[]),
            None => &[],
        };
        item.map(|(message, _)| message)
    }
}

/// The element at the start of `rest` and the distance to the next one, or `None` when
/// no whole element starts there.
fn element(rest: &[u8]) -> Option<(ControlMessage<'_>, usize)> {
    if rest.len() < HEADER {
        return None;
    }
    let len = read_len(rest)?;
    if len < HEADER || len > rest.len() {
        return None;
    }
    let level = read_i32(rest, LEVEL_AT)?;
    let kind = read_i32(rest, TYPE_AT)?;
    let data = rest.get(DATA.min(len)..len).unwrap_or(&[]);
    let step = align(len).map_or(rest.len(), |aligned| aligned.min(rest.len()));
    Some((ControlMessage { level, kind, data }, step))
}

/// The error of [`Builder::push`]: the buffer has no room for the element.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Full;

impl core::fmt::Display for Full {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("the control buffer has no room for the message")
    }
}

impl std::error::Error for Full {}

/// Writes control messages into a buffer for `sendmsg`.
#[derive(Debug)]
pub struct Builder<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl<'a> Builder<'a> {
    /// Start writing at the beginning of `buf`.
    ///
    /// # Arguments
    ///
    /// * `buf` - the control buffer; [`space`] per message says how much is needed.
    ///
    /// # Returns
    ///
    /// An empty builder.
    pub fn new(buf: &'a mut [u8]) -> Self {
        Builder { buf, len: 0 }
    }

    /// Append one message.
    ///
    /// # Arguments
    ///
    /// * `level` - the protocol level (`cmsg_level`).
    /// * `kind` - the type within the level (`cmsg_type`).
    /// * `data` - the data; the padding after it is zeroed.
    ///
    /// # Returns
    ///
    /// Nothing; the message is in the buffer.
    ///
    /// # Errors
    ///
    /// [`Full`] when the element does not fit after what was written, in which case
    /// the buffer is unchanged.
    pub fn push(&mut self, level: i32, kind: i32, data: &[u8]) -> Result<(), Full> {
        let need = space(data.len()).ok_or(Full)?;
        let end = self.len.checked_add(need).ok_or(Full)?;
        let slot = self.buf.get_mut(self.len..end).ok_or(Full)?;
        slot.fill(0);
        let cmsg_len = len(data.len()).ok_or(Full)?;
        write_len(slot, cmsg_len).ok_or(Full)?;
        write_i32(slot, LEVEL_AT, level).ok_or(Full)?;
        write_i32(slot, TYPE_AT, kind).ok_or(Full)?;
        slot.get_mut(DATA..cmsg_len)
            .ok_or(Full)?
            .copy_from_slice(data);
        self.len = end;
        Ok(())
    }

    /// How many bytes the messages so far occupy: the `msg_controllen` to send.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Whether nothing was pushed.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The written prefix of the buffer.
    #[must_use]
    pub fn written(&self) -> &[u8] {
        self.buf.get(..self.len).unwrap_or(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::{len, messages, space, Builder, ControlMessage, Full, ALIGN, DATA, HEADER};

    /// A small deterministic generator for the property tests.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            usize::try_from(self.next() % u64::try_from(n.max(1)).unwrap_or(1)).unwrap_or(0)
        }
    }

    #[test]
    fn the_sizes_match_the_c_macros() {
        assert_eq!(len(0), Some(DATA));
        assert_eq!(len(4), Some(DATA + 4));
        assert_eq!(space(0), Some(DATA));
        assert_eq!(space(1), Some(DATA + ALIGN));
        assert_eq!(space(ALIGN), Some(DATA + ALIGN));
        assert_eq!(space(ALIGN + 1), Some(DATA + 2 * ALIGN));
        assert_eq!(space(usize::MAX), None);
        assert_eq!(len(usize::MAX), None);
        #[cfg(target_os = "linux")]
        {
            assert_eq!(HEADER, 16);
            assert_eq!(DATA, 16);
        }
        #[cfg(target_vendor = "apple")]
        {
            assert_eq!(HEADER, 12);
            assert_eq!(DATA, 12);
        }
    }

    #[test]
    fn a_message_round_trips_through_the_buffer() {
        let mut buf = [0xaau8; 64];
        let mut builder = Builder::new(&mut buf);
        assert!(builder.is_empty());
        builder
            .push(libc::IPPROTO_IP, libc::IP_TOS, &[0x2e])
            .unwrap();
        builder
            .push(libc::SOL_SOCKET, 7, &0x1234_5678i32.to_ne_bytes())
            .unwrap();
        assert_eq!(
            builder.len(),
            space(1).unwrap() + space(4).unwrap(),
            "two elements, each padded"
        );
        let written = builder.written().to_vec();
        let found: Vec<ControlMessage> = messages(&written).collect();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].level, libc::IPPROTO_IP);
        assert_eq!(found[0].kind, libc::IP_TOS);
        assert_eq!(found[0].data, &[0x2e]);
        assert_eq!(found[0].int(), None, "one byte is not an int");
        assert_eq!(found[1].level, libc::SOL_SOCKET);
        assert_eq!(found[1].kind, 7);
        assert_eq!(found[1].int(), Some(0x1234_5678));
        let padding = &written[DATA + 1..space(1).unwrap()];
        assert!(padding.iter().all(|byte| *byte == 0), "padding is zeroed");
    }

    #[test]
    fn a_full_buffer_refuses_and_keeps_what_it_had() {
        let mut buf = [0u8; 40];
        let mut builder = Builder::new(&mut buf);
        builder.push(1, 2, &[1, 2, 3]).unwrap();
        let before = builder.len();
        assert_eq!(builder.push(3, 4, &[0; 32]), Err(Full));
        assert_eq!(builder.len(), before);
        assert_eq!(messages(builder.written()).count(), 1);
        assert_eq!(
            format!("{Full}"),
            "the control buffer has no room for the message"
        );
        let mut tiny = [0u8; 4];
        assert_eq!(Builder::new(&mut tiny).push(1, 1, &[]), Err(Full));
    }

    #[test]
    fn a_length_that_does_not_fit_ends_the_walk() {
        let mut buf = [0u8; 64];
        let mut builder = Builder::new(&mut buf);
        builder.push(1, 1, &[9; 4]).unwrap();
        builder.push(2, 2, &[8; 4]).unwrap();
        let written = builder.written().to_vec();
        assert_eq!(messages(&written).count(), 2);
        let first = space(4).unwrap();
        assert_eq!(
            messages(&written[..written.len() - (first - len(4).unwrap())]).count(),
            2,
            "padding cut off the end is no loss"
        );
        assert_eq!(
            messages(&written[..first + HEADER + 2]).count(),
            1,
            "the second element's data is cut"
        );
        assert_eq!(
            messages(&written[..HEADER - 1]).count(),
            0,
            "no whole header"
        );
        let mut short = written.clone();
        short[0] = 1;
        #[cfg(target_endian = "big")]
        {
            short[0] = 0;
            short[super::LEN_AT + size_of_len() - 1] = 1;
        }
        assert_eq!(
            messages(&short).count(),
            0,
            "a length below the header stops at once"
        );
        let mut huge = written.clone();
        for byte in &mut huge[..HEADER / 2] {
            *byte = 0xff;
        }
        assert_eq!(
            messages(&huge).count(),
            0,
            "a length beyond the buffer stops at once"
        );
        assert_eq!(messages(&[]).count(), 0);
    }

    #[cfg(target_endian = "big")]
    fn size_of_len() -> usize {
        let mut probe = [0u8; 16];
        super::write_len(&mut probe, 0x01).unwrap();
        probe.iter().rposition(|byte| *byte == 1).unwrap() + 1 - super::LEN_AT
    }

    #[test]
    fn random_messages_round_trip_and_random_bytes_never_panic() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..500 {
            let count = rng.below(5);
            let items: Vec<(i32, i32, Vec<u8>)> = (0..count)
                .map(|_| {
                    let level = rng.next() as i32;
                    let kind = rng.next() as i32;
                    let data: Vec<u8> = (0..rng.below(40)).map(|_| rng.next() as u8).collect();
                    (level, kind, data)
                })
                .collect();
            let mut buf = vec![0u8; 512];
            let mut builder = Builder::new(&mut buf);
            for (level, kind, data) in &items {
                builder.push(*level, *kind, data).unwrap();
            }
            let written = builder.written().to_vec();
            let found: Vec<(i32, i32, Vec<u8>)> = messages(&written)
                .map(|message| (message.level, message.kind, message.data.to_vec()))
                .collect();
            assert_eq!(found, items);

            let noise: Vec<u8> = (0..rng.below(96)).map(|_| rng.next() as u8).collect();
            let seen = messages(&noise).count();
            assert!(
                seen <= noise.len() / HEADER + 1,
                "{seen} from {} bytes",
                noise.len()
            );
        }
    }
}
