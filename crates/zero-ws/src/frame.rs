//! The base framing protocol: frame headers, as a server receives and sends them.
//!
//! A header is FIN, RSV1 to RSV3, a 4-bit opcode, the MASK bit and a 7-bit length,
//! then a 16-bit or 64-bit extended length when the 7 bits read 126 or 127, then a
//! 4-byte masking key when MASK is set (RFC 6455 Section 5.2). A received header is
//! refused, and the connection failed with 1002, when:
//!
//! - a reserved bit is set that no negotiated extension defines (Section 5.2);
//! - the opcode is reserved, `%x3-7` or `%xB-F` (Section 5.2);
//! - the length does not use "the minimal number of bytes", or the 64-bit length has
//!   its most significant bit set (Section 5.2);
//! - a control frame is fragmented or carries more than 125 bytes (Section 5.5);
//! - the frame is not masked, since "the server MUST close the connection upon
//!   receiving a frame that is not masked" (Section 5.1).
//!
//! A header the server sends is never masked: "A server MUST NOT mask any frames that
//! it sends to the client" (Section 5.1).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>

use crate::close::CloseCode;

/// The largest payload of a control frame.
pub const MAX_CONTROL_PAYLOAD: usize = 125;

/// The longest header: 2 bytes, a 64-bit length and a masking key.
pub const MAX_HEADER: usize = 14;

/// A frame opcode the protocol defines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opcode {
    /// `%x0`: the next fragment of a message.
    Continuation,
    /// `%x1`: a text message, UTF-8.
    Text,
    /// `%x2`: a binary message.
    Binary,
    /// `%x8`: a connection close.
    Close,
    /// `%x9`: a ping.
    Ping,
    /// `%xA`: a pong.
    Pong,
}

impl Opcode {
    /// The opcode for four bits, or `None` for a reserved value.
    ///
    /// # Arguments
    ///
    /// * `bits` - the low four bits of the first header byte.
    #[must_use]
    pub const fn from_bits(bits: u8) -> Option<Self> {
        match bits {
            0x0 => Some(Self::Continuation),
            0x1 => Some(Self::Text),
            0x2 => Some(Self::Binary),
            0x8 => Some(Self::Close),
            0x9 => Some(Self::Ping),
            0xA => Some(Self::Pong),
            _ => None,
        }
    }

    /// The four bits on the wire.
    #[must_use]
    pub const fn bits(self) -> u8 {
        match self {
            Self::Continuation => 0x0,
            Self::Text => 0x1,
            Self::Binary => 0x2,
            Self::Close => 0x8,
            Self::Ping => 0x9,
            Self::Pong => 0xA,
        }
    }

    /// Whether this is a control opcode: the most significant opcode bit is set.
    #[must_use]
    pub const fn is_control(self) -> bool {
        self.bits() & 0x8 != 0
    }
}

/// A received frame header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    /// The final fragment of a message.
    pub fin: bool,
    /// RSV1 to RSV3 as the low three bits.
    pub rsv: u8,
    /// The opcode.
    pub opcode: Opcode,
    /// The masking key.
    pub mask: [u8; 4],
    /// The payload length.
    pub len: u64,
    /// The header length in bytes, 6 to 14.
    pub header_len: usize,
}

/// Decode a header a server received.
///
/// # Arguments
///
/// * `input` - the bytes from the start of the frame.
/// * `allowed_rsv` - the RSV bits a negotiated extension defines, as the low three
///   bits; zero without extensions.
///
/// # Returns
///
/// The header, or `None` when `input` does not hold all of it yet.
///
/// # Errors
///
/// [`CloseCode::PROTOCOL_ERROR`] for any of the violations the module lists.
pub fn decode(input: &[u8], allowed_rsv: u8) -> Result<Option<Header>, CloseCode> {
    let Some(&[first, second]) = input.first_chunk::<2>() else {
        return Ok(None);
    };
    let fin = first & 0x80 != 0;
    let rsv = (first >> 4) & 0x07;
    if rsv & !allowed_rsv != 0 {
        return Err(CloseCode::PROTOCOL_ERROR);
    }
    let opcode = Opcode::from_bits(first & 0x0F).ok_or(CloseCode::PROTOCOL_ERROR)?;
    let short = second & 0x7F;
    if opcode.is_control() && (!fin || usize::from(short) > MAX_CONTROL_PAYLOAD) {
        return Err(CloseCode::PROTOCOL_ERROR);
    }
    if second & 0x80 == 0 {
        return Err(CloseCode::PROTOCOL_ERROR);
    }
    let rest = input.get(2..).unwrap_or(&[]);
    let (len, extended) = match short {
        126 => {
            let Some(bytes) = rest.first_chunk::<2>() else {
                return Ok(None);
            };
            let len = u64::from(u16::from_be_bytes(*bytes));
            if len < 126 {
                return Err(CloseCode::PROTOCOL_ERROR);
            }
            (len, 2)
        }
        127 => {
            let Some(bytes) = rest.first_chunk::<8>() else {
                return Ok(None);
            };
            let len = u64::from_be_bytes(*bytes);
            if len >> 63 != 0 || len <= 0xFFFF {
                return Err(CloseCode::PROTOCOL_ERROR);
            }
            (len, 8)
        }
        _ => (u64::from(short), 0),
    };
    let Some(mask) = rest.get(extended..).and_then(<[u8]>::first_chunk::<4>) else {
        return Ok(None);
    };
    Ok(Some(Header {
        fin,
        rsv,
        opcode,
        mask: *mask,
        len,
        header_len: 6usize.saturating_add(extended),
    }))
}

/// Encode the header of a frame the server sends, which is never masked.
///
/// # Arguments
///
/// * `fin` - whether this is the final fragment.
/// * `opcode` - the opcode.
/// * `len` - the payload length, encoded in the fewest bytes.
/// * `out` - receives the header.
///
/// # Returns
///
/// The header length: 2, 4 or 10.
pub fn encode(fin: bool, opcode: Opcode, len: u64, out: &mut [u8; 10]) -> usize {
    let first = (if fin { 0x80 } else { 0x00 }) | opcode.bits();
    let (written, header): (usize, [u8; 10]) = match len {
        0..=125 => {
            let mut header = [0u8; 10];
            header[0] = first;
            header[1] = u8::try_from(len).unwrap_or(0);
            (2, header)
        }
        126..=0xFFFF => {
            let mut header = [0u8; 10];
            header[0] = first;
            header[1] = 126;
            let [high, low] = u16::try_from(len).unwrap_or(0).to_be_bytes();
            header[2] = high;
            header[3] = low;
            (4, header)
        }
        _ => {
            let [a, b, c, d, e, f, g, h] = len.to_be_bytes();
            (10, [first, 127, a, b, c, d, e, f, g, h])
        }
    };
    *out = header;
    written
}
