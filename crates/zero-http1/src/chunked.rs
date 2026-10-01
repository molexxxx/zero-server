//! The chunked transfer coding: a streaming decoder over the caller's
//! buffers, the trailer section parsed into a caller-owned table that is
//! never merged into the header section, and the encoder.
//!
//! ```text
//! chunked-body   = *chunk last-chunk trailer-section CRLF
//! chunk          = chunk-size [ chunk-ext ] CRLF chunk-data CRLF
//! chunk-size     = 1*HEXDIG
//! last-chunk     = 1*("0") [ chunk-ext ] CRLF
//! trailer-section = *( field-line CRLF )
//! ```
//!
//! A chunk size is read with checked arithmetic and a digit cap, so a large
//! numeral is refused rather than wrapped (RFC 9112 Section 7.1); chunk
//! extensions are ignored but bounded in total length (Section 7.1.1); the
//! trailer section is stored separately from the header fields (Section
//! 7.1.2), and a trailer that names a framing, routing, request-modifier,
//! authentication or content-format field is dropped, since such a field
//! cannot be evaluated after the content (RFC 9110 Section 6.5.1). Every
//! refusal closes the connection, because the end of the message is then
//! unknown.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-7.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-6.5.1>

use zero_http_types::{HeaderName, StatusCode};
use zero_limits::http1::Http1Limits;
use zero_simd::{scan_header_name, scan_header_value};

use crate::error::Reject;
use crate::head::{byte, expect_crlf, tail, Field, LineEnd, Span};
use crate::list::is_ows;

/// The bytes that end a chunk's data.
pub const CHUNK_END: &[u8] = b"\r\n";

/// The last chunk with no trailers, including the final CRLF.
pub const LAST_CHUNK: &[u8] = b"0\r\n\r\n";

/// The longest chunk header the encoder writes: sixteen hex digits and CRLF.
pub const MAX_CHUNK_HEADER_LEN: usize = 18;

/// Where the decoder is in the chunked body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// At the start of a chunk-size line.
    Size,
    /// Inside chunk-data, with this many octets still to deliver.
    Data(u64),
    /// After chunk-data, expecting CRLF.
    DataEnd,
    /// After the last chunk, expecting the trailer section and the final
    /// CRLF.
    Trailers,
    /// The body is complete.
    Done,
}

/// One step of decoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step<'a> {
    /// Chunk data, borrowed from the input; `consumed` input bytes were used,
    /// including any chunk framing before the data.
    Data {
        /// The decoded bytes.
        data: &'a [u8],
        /// The input bytes used.
        consumed: usize,
    },
    /// The input ended inside the framing; `consumed` bytes were used and
    /// the rest must be presented again with more bytes after it.
    NeedMore {
        /// The input bytes used.
        consumed: usize,
    },
    /// The body ended; `trailers` is the trailer section within the input,
    /// for [`parse_trailers`], and `consumed` input bytes were used,
    /// including the final CRLF.
    Done {
        /// The trailer section, possibly empty.
        trailers: Span,
        /// The input bytes used.
        consumed: usize,
    },
}

/// A streaming chunked decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkedDecoder {
    state: State,
}

impl Default for ChunkedDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl ChunkedDecoder {
    /// Creates a decoder at the start of a chunked body.
    #[must_use]
    pub const fn new() -> Self {
        Self { state: State::Size }
    }

    /// Returns `true` once the last chunk, the trailers and the final CRLF
    /// were consumed.
    #[must_use]
    pub const fn is_done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    /// Decodes as much of `input` as one step allows.
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed body bytes; after a step, drop the consumed
    ///   prefix and call again with the rest, extended by new bytes.
    /// * `limits` - the chunk-size digit, extension and trailer limits.
    ///
    /// # Errors
    ///
    /// Returns a closing rejection: 400 for a malformed chunk, size or line
    /// ending, 431 for a trailer section past its limit.
    pub fn decode<'a>(
        &mut self,
        input: &'a [u8],
        limits: &Http1Limits,
    ) -> Result<Step<'a>, Reject> {
        match self.state {
            State::Size => self.size_line(input, limits),
            State::Data(remaining) => {
                if input.is_empty() {
                    return Ok(Step::NeedMore { consumed: 0 });
                }
                let take = usize::try_from(remaining)
                    .map_or(input.len(), |remaining| remaining.min(input.len()));
                let data = input.get(..take).unwrap_or(&[]);
                let left = remaining.saturating_sub(take as u64);
                self.state = if left == 0 {
                    State::DataEnd
                } else {
                    State::Data(left)
                };
                Ok(Step::Data {
                    data,
                    consumed: take,
                })
            }
            State::DataEnd => match expect_crlf(input, 0) {
                LineEnd::Found => {
                    self.state = State::Size;
                    self.size_line(tail(input, 2), limits)
                        .map(|step| advance(step, 2))
                }
                LineEnd::Partial => Ok(Step::NeedMore { consumed: 0 }),
                LineEnd::Invalid => Err(Reject::bad_request()),
            },
            State::Trailers => self.trailer_section(input, limits),
            State::Done => Ok(Step::Done {
                trailers: Span::EMPTY,
                consumed: 0,
            }),
        }
    }

    /// Parses `chunk-size [ chunk-ext ] CRLF` at the start of `input`.
    fn size_line<'a>(&mut self, input: &'a [u8], limits: &Http1Limits) -> Result<Step<'a>, Reject> {
        let mut pos = 0usize;
        let mut size = 0u64;
        let mut digits = 0usize;
        while let Some(digit) = byte(input, pos).and_then(hex_value) {
            digits = digits.saturating_add(1);
            if digits > limits.max_chunk_size_digits {
                return Err(Reject::bad_request());
            }
            size = size
                .checked_mul(16)
                .and_then(|size| size.checked_add(u64::from(digit)))
                .ok_or(Reject::bad_request())?;
            pos = pos.saturating_add(1);
        }
        if pos >= input.len() {
            return Ok(Step::NeedMore { consumed: 0 });
        }
        if digits == 0 {
            return Err(Reject::bad_request());
        }
        let extension_start = pos;
        let extension_len = scan_header_value(tail(input, pos));
        if extension_len > limits.max_chunk_extension {
            return Err(Reject::bad_request());
        }
        pos = pos.saturating_add(extension_len);
        match expect_crlf(input, pos) {
            LineEnd::Found => pos = pos.saturating_add(2),
            LineEnd::Partial => return Ok(Step::NeedMore { consumed: 0 }),
            LineEnd::Invalid => return Err(Reject::bad_request()),
        }
        let extension = input
            .get(extension_start..extension_start.saturating_add(extension_len))
            .unwrap_or(&[]);
        if !extension.is_empty() && !valid_extension(extension) {
            return Err(Reject::bad_request());
        }
        if size == 0 {
            self.state = State::Trailers;
            return self
                .trailer_section(tail(input, pos), limits)
                .map(|step| advance(step, pos));
        }
        self.state = State::Data(size);
        let rest = tail(input, pos);
        if rest.is_empty() {
            return Ok(Step::NeedMore { consumed: pos });
        }
        self.decode(rest, limits).map(|step| advance(step, pos))
    }

    /// Finds the end of the trailer section: field lines up to an empty
    /// line, all of which must be present.
    fn trailer_section<'a>(
        &mut self,
        input: &'a [u8],
        limits: &Http1Limits,
    ) -> Result<Step<'a>, Reject> {
        let mut pos = 0usize;
        loop {
            if pos > limits.max_trailer_bytes {
                return Err(Reject::header_fields_too_large());
            }
            match byte(input, pos) {
                None => return Ok(Step::NeedMore { consumed: 0 }),
                Some(b'\n') => return Err(Reject::bad_request()),
                Some(b'\r') => match byte(input, pos.saturating_add(1)) {
                    None => return Ok(Step::NeedMore { consumed: 0 }),
                    Some(b'\n') => {
                        self.state = State::Done;
                        return Ok(Step::Done {
                            trailers: Span::new(0, pos),
                            consumed: pos.saturating_add(2),
                        });
                    }
                    Some(_) => return Err(Reject::bad_request()),
                },
                Some(_) => {}
            }
            let rest = tail(input, pos);
            let Some(line_len) = rest.iter().position(|byte| matches!(byte, b'\r' | b'\n')) else {
                return if rest.len() > limits.max_trailer_bytes {
                    Err(Reject::header_fields_too_large())
                } else {
                    Ok(Step::NeedMore { consumed: 0 })
                };
            };
            let line_end = pos.saturating_add(line_len);
            match expect_crlf(input, line_end) {
                LineEnd::Found => pos = line_end.saturating_add(2),
                LineEnd::Partial => return Ok(Step::NeedMore { consumed: 0 }),
                LineEnd::Invalid => return Err(Reject::bad_request()),
            }
        }
    }
}

/// Shifts a step's consumed count by the framing bytes before it.
fn advance(step: Step<'_>, by: usize) -> Step<'_> {
    match step {
        Step::Data { data, consumed } => Step::Data {
            data,
            consumed: consumed.saturating_add(by),
        },
        Step::NeedMore { consumed } => Step::NeedMore {
            consumed: consumed.saturating_add(by),
        },
        Step::Done { trailers, consumed } => Step::Done {
            trailers: Span::new(
                trailers.start.saturating_add(by),
                trailers.end.saturating_add(by),
            ),
            consumed: consumed.saturating_add(by),
        },
    }
}

/// Returns the value of a hexadecimal digit.
const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(byte.wrapping_sub(b'a').wrapping_add(10)),
        b'A'..=b'F' => Some(byte.wrapping_sub(b'A').wrapping_add(10)),
        _ => None,
    }
}

/// Checks `chunk-ext`: optional bad whitespace, then `;` introducing each
/// extension; the names and values are not interpreted.
fn valid_extension(extension: &[u8]) -> bool {
    let first = extension
        .iter()
        .position(|byte| !is_ows(*byte))
        .unwrap_or(extension.len());
    byte(extension, first) == Some(b';')
}

/// Writes `chunk-size CRLF` for a chunk of `len` octets.
///
/// # Arguments
///
/// * `len` - the chunk's data length, which must be nonzero for a data
///   chunk; zero writes the last-chunk line without its final CRLF.
/// * `out` - the buffer to write at the start of; [`MAX_CHUNK_HEADER_LEN`]
///   bytes always suffice.
///
/// # Returns
///
/// The number of bytes written, or `None` when `out` is too short, in which
/// case nothing was written.
pub fn chunk_header(len: usize, out: &mut [u8]) -> Option<usize> {
    let mut digits = [0u8; 16];
    let mut count = 0usize;
    let mut value = len as u64;
    loop {
        let digit = (value.rem_euclid(16)) as u8;
        let glyph = match digit {
            0..=9 => b'0'.wrapping_add(digit),
            _ => b'a'.wrapping_add(digit.wrapping_sub(10)),
        };
        if let Some(slot) = digits.get_mut(count) {
            *slot = glyph;
        }
        count = count.saturating_add(1);
        value = value.div_euclid(16);
        if value == 0 {
            break;
        }
    }
    let total = count.saturating_add(2);
    let target = out.get_mut(..total)?;
    for (index, slot) in target.iter_mut().take(count).enumerate() {
        *slot = digits
            .get(count.saturating_sub(1).saturating_sub(index))
            .copied()
            .unwrap_or(b'0');
    }
    if let Some(end) = target.get_mut(count..) {
        end.copy_from_slice(CHUNK_END);
    }
    Some(total)
}

/// Writes one complete chunk: the size line, the data and CRLF.
///
/// # Arguments
///
/// * `data` - the chunk data, which must not be empty, since an empty chunk
///   is the last chunk.
/// * `out` - the buffer to write at the start of.
///
/// # Returns
///
/// The number of bytes written, or `None` when `data` is empty or `out` is
/// too short, in which case nothing was written.
pub fn encode_chunk(data: &[u8], out: &mut [u8]) -> Option<usize> {
    if data.is_empty() {
        return None;
    }
    let mut header = [0u8; MAX_CHUNK_HEADER_LEN];
    let header_len = chunk_header(data.len(), &mut header)?;
    let total = header_len
        .checked_add(data.len())?
        .checked_add(CHUNK_END.len())?;
    let target = out.get_mut(..total)?;
    let (head, rest) = target.split_at_mut_checked(header_len)?;
    head.copy_from_slice(header.get(..header_len)?);
    let (body, end) = rest.split_at_mut_checked(data.len())?;
    body.copy_from_slice(data);
    end.copy_from_slice(CHUNK_END);
    Some(total)
}

/// Returns `true` when a trailer field with this name may be kept: not a
/// framing, routing, request-modifier, authentication or content-format
/// field, which RFC 9110 Section 6.5.1 says cannot be processed after the
/// content.
///
/// # Arguments
///
/// * `name` - the field name as received.
#[must_use]
pub fn is_trailer_allowed(name: &[u8]) -> bool {
    if let Some(id) = HeaderName::parse(name) {
        return !matches!(
            id,
            HeaderName::Accept
                | HeaderName::AcceptCharset
                | HeaderName::AcceptEncoding
                | HeaderName::AcceptLanguage
                | HeaderName::Authorization
                | HeaderName::CacheControl
                | HeaderName::Connection
                | HeaderName::ContentEncoding
                | HeaderName::ContentLanguage
                | HeaderName::ContentLength
                | HeaderName::ContentLocation
                | HeaderName::ContentRange
                | HeaderName::ContentType
                | HeaderName::Expect
                | HeaderName::Host
                | HeaderName::IfMatch
                | HeaderName::IfModifiedSince
                | HeaderName::IfNoneMatch
                | HeaderName::IfRange
                | HeaderName::IfUnmodifiedSince
                | HeaderName::MaxForwards
                | HeaderName::Pragma
                | HeaderName::ProxyAuthenticate
                | HeaderName::ProxyAuthorization
                | HeaderName::Range
                | HeaderName::Te
                | HeaderName::Trailer
                | HeaderName::TransferEncoding
                | HeaderName::Upgrade
                | HeaderName::Via
                | HeaderName::WwwAuthenticate
        );
    }
    !(name.eq_ignore_ascii_case(b"cookie")
        || name.eq_ignore_ascii_case(b"set-cookie")
        || name.eq_ignore_ascii_case(b"keep-alive")
        || name.eq_ignore_ascii_case(b"proxy-connection")
        || name.eq_ignore_ascii_case(b"origin"))
}

/// Parses a trailer section into a caller-owned table, keeping it separate
/// from the header fields and dropping every field [`is_trailer_allowed`]
/// refuses.
///
/// # Arguments
///
/// * `input` - the buffer the decoder reported the section in.
/// * `section` - the span of the trailer section, without its final CRLF.
/// * `table` - the caller's trailer table, filled from the start.
/// * `limits` - the field length limit.
///
/// # Returns
///
/// The number of trailers kept.
///
/// # Errors
///
/// Returns a closing 400 for a malformed field line (whitespace before the
/// colon, an obsolete fold, an invalid value byte or line ending) and a
/// closing 431 when a line exceeds the field limit or the kept trailers
/// exceed the table.
pub fn parse_trailers(
    input: &[u8],
    section: Span,
    table: &mut [Field],
    limits: &Http1Limits,
) -> Result<usize, Reject> {
    let mut pos = section.start;
    let mut count = 0usize;
    while pos < section.end {
        let line_start = pos;
        let rest = input.get(pos..section.end).unwrap_or(&[]);
        if rest.first().is_some_and(|byte| is_ows(*byte)) {
            return Err(Reject::bad_request());
        }
        let name_len = scan_header_name(rest);
        if name_len == 0 {
            return Err(Reject::bad_request());
        }
        let name = Span::new(pos, pos.saturating_add(name_len));
        pos = name.end;
        if byte(input, pos) != Some(b':') {
            return Err(Reject::bad_request());
        }
        pos = pos.saturating_add(1);
        while pos < section.end && byte(input, pos).is_some_and(is_ows) {
            pos = pos.saturating_add(1);
        }
        let value_start = pos;
        let value_len = scan_header_value(input.get(pos..section.end).unwrap_or(&[]));
        let value_limit = pos.saturating_add(value_len);
        match expect_crlf(input, value_limit) {
            LineEnd::Found => {}
            LineEnd::Partial | LineEnd::Invalid => return Err(Reject::bad_request()),
        }
        let mut value_end = value_limit;
        while value_end > value_start
            && byte(input, value_end.saturating_sub(1)).is_some_and(is_ows)
        {
            value_end = value_end.saturating_sub(1);
        }
        pos = value_limit.saturating_add(2);
        if pos.saturating_sub(line_start) > limits.max_header_field {
            return Err(Reject::header_fields_too_large());
        }
        if !is_trailer_allowed(name.of(input)) {
            continue;
        }
        let Some(slot) = table.get_mut(count) else {
            return Err(Reject::header_fields_too_large());
        };
        *slot = Field {
            name,
            value: Span::new(value_start, value_end),
            id: HeaderName::parse(name.of(input)),
        };
        count = count.saturating_add(1);
    }
    Ok(count)
}

/// The status a trailer or chunk refusal answers with when the head was
/// already answered: the connection closes without a further response.
pub const CLOSE_ONLY: StatusCode = StatusCode::BAD_REQUEST;

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        chunk_header, encode_chunk, is_trailer_allowed, parse_trailers, ChunkedDecoder, Step,
        LAST_CHUNK, MAX_CHUNK_HEADER_LEN,
    };
    use crate::error::Reject;
    use crate::head::{Field, Span};
    use zero_limits::http1::Http1Limits;

    /// Decodes a whole body presented at once, collecting the data and the
    /// trailer span.
    fn decode_all(body: &[u8]) -> Result<(Vec<u8>, Span, usize), Reject> {
        let mut decoder = ChunkedDecoder::new();
        let mut data = Vec::new();
        let mut pos = 0usize;
        loop {
            match decoder.decode(body.get(pos..).unwrap_or(&[]), &Http1Limits::DEFAULT)? {
                Step::Data {
                    data: chunk,
                    consumed,
                } => {
                    data.extend_from_slice(chunk);
                    pos = pos.saturating_add(consumed);
                }
                Step::NeedMore { consumed } => {
                    pos = pos.saturating_add(consumed);
                    if consumed == 0 || pos >= body.len() {
                        return Err(Reject::close(zero_http_types::StatusCode::REQUEST_TIMEOUT));
                    }
                }
                Step::Done { trailers, consumed } => {
                    let trailers = Span::new(
                        trailers.start.saturating_add(pos),
                        trailers.end.saturating_add(pos),
                    );
                    return Ok((data, trailers, pos.saturating_add(consumed)));
                }
            }
        }
    }

    /// Decodes a body one byte at a time, which exercises every partial
    /// state.
    fn decode_bytewise(body: &[u8]) -> Result<Vec<u8>, Reject> {
        let mut decoder = ChunkedDecoder::new();
        let mut data = Vec::new();
        let mut pending: Vec<u8> = Vec::new();
        for byte in body {
            pending.push(*byte);
            loop {
                match decoder.decode(&pending, &Http1Limits::DEFAULT)? {
                    Step::Data {
                        data: chunk,
                        consumed,
                    } => {
                        data.extend_from_slice(chunk);
                        pending.drain(..consumed);
                    }
                    Step::NeedMore { consumed } => {
                        pending.drain(..consumed);
                        break;
                    }
                    Step::Done { consumed, .. } => {
                        pending.drain(..consumed);
                        break;
                    }
                }
            }
        }
        assert!(decoder.is_done(), "{body:?}");
        assert!(pending.is_empty(), "{body:?}");
        Ok(data)
    }

    #[test]
    fn chunks_are_decoded_whole_and_byte_by_byte() {
        let body = b"4\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\n\r\n";
        let (data, trailers, consumed) = decode_all(body).unwrap_or_default();
        assert_eq!(data, b"Wikipedia in\r\n\r\nchunks.");
        assert_eq!(trailers.len(), 0);
        assert_eq!(consumed, body.len());
        assert_eq!(decode_bytewise(body).unwrap_or_default(), data);
        assert_eq!(decode_bytewise(b"0\r\n\r\n").unwrap_or_default(), b"");
        let big = b"ffffffffffffffff\r\n";
        let mut decoder = ChunkedDecoder::new();
        assert!(matches!(
            decoder.decode(big, &Http1Limits::DEFAULT),
            Ok(Step::NeedMore { consumed: 18 })
        ));
        assert_eq!(
            decode_all(b"4\r\nWiki\r\n0\r\n\r\nGET /next").map(|r| r.2),
            Ok(14)
        );
    }

    /// RFC 9112 Section 7.1.1: a recipient ignores unrecognized chunk
    /// extensions, and a server bounds their total length.
    #[test]
    fn unrecognized_chunk_extensions_are_ignored_and_their_total_size_is_bounded() {
        let body = b"4;name=value;flag\r\nWiki\r\n0 ; trailer=\"x\"\r\n\r\n";
        assert_eq!(decode_all(body).map(|r| r.0), Ok(b"Wiki".to_vec()));
        assert_eq!(decode_bytewise(body).unwrap_or_default(), b"Wiki");
        let mut long = b"4;x=".to_vec();
        long.extend_from_slice(&[b'y'; 300]);
        long.extend_from_slice(b"\r\nWiki\r\n0\r\n\r\n");
        assert_eq!(decode_all(&long).map(|r| r.0), Err(Reject::bad_request()));
        assert_eq!(
            decode_all(b"4 x\r\nWiki\r\n0\r\n\r\n").map(|r| r.0),
            Err(Reject::bad_request())
        );
    }

    /// RFC 9112 Section 7.1.2 and RFC 9110 Section 6.5.1: trailer fields
    /// are stored separately from the header section, and a field that
    /// cannot be processed after the content is dropped.
    #[test]
    fn chunked_trailer_fields_are_not_merged_into_the_header_section_unless_explicitly() {
        let body = b"4\r\nWiki\r\n0\r\nX-Checksum: abc \r\nContent-Length: 4\r\nHost: evil\r\nx-trace: t1\r\n\r\n";
        let (data, trailers, consumed) = decode_all(body).unwrap_or_default();
        assert_eq!(data, b"Wiki");
        assert_eq!(consumed, body.len());
        assert_eq!(
            trailers.of(body),
            &b"X-Checksum: abc \r\nContent-Length: 4\r\nHost: evil\r\nx-trace: t1\r\n"[..]
        );
        let mut table = [Field::EMPTY; 4];
        let kept = parse_trailers(body, trailers, &mut table, &Http1Limits::DEFAULT);
        assert_eq!(kept, Ok(2));
        let fields: Vec<(&[u8], &[u8])> = table
            .iter()
            .take(2)
            .map(|field| (field.name(body), field.value(body)))
            .collect();
        assert_eq!(
            fields,
            [(&b"X-Checksum"[..], &b"abc"[..]), (b"x-trace", b"t1")]
        );
        assert!(!is_trailer_allowed(b"content-length"));
        assert!(!is_trailer_allowed(b"Transfer-Encoding"));
        assert!(!is_trailer_allowed(b"Authorization"));
        assert!(!is_trailer_allowed(b"Cookie"));
        assert!(!is_trailer_allowed(b"Host"));
        assert!(is_trailer_allowed(b"Server-Timing"));
        assert!(is_trailer_allowed(b"ETag"));
    }

    #[test]
    fn malformed_trailers_are_refused() {
        let folded = b"0\r\nX: a\r\n b\r\n\r\n";
        let (_, trailers, _) = decode_all(folded).unwrap_or_default();
        let mut table = [Field::EMPTY; 4];
        assert_eq!(
            parse_trailers(folded, trailers, &mut table, &Http1Limits::DEFAULT),
            Err(Reject::bad_request())
        );
        let spaced = b"0\r\nX : a\r\n\r\n";
        let (_, trailers, _) = decode_all(spaced).unwrap_or_default();
        assert_eq!(
            parse_trailers(spaced, trailers, &mut table, &Http1Limits::DEFAULT),
            Err(Reject::bad_request())
        );
        let full = b"0\r\nA: 1\r\nB: 2\r\n\r\n";
        let (_, trailers, _) = decode_all(full).unwrap_or_default();
        let mut one = [Field::EMPTY; 1];
        assert_eq!(
            parse_trailers(full, trailers, &mut one, &Http1Limits::DEFAULT)
                .map_err(|r| r.status.as_u16()),
            Err(431)
        );
        let mut huge = b"0\r\n".to_vec();
        for index in 0..100 {
            huge.extend_from_slice(alloc::format!("X-{index}: {}\r\n", "v".repeat(60)).as_bytes());
        }
        huge.extend_from_slice(b"\r\n");
        assert_eq!(
            decode_all(&huge)
                .map(|r| r.0)
                .map_err(|r| r.status.as_u16()),
            Err(431)
        );
    }

    #[test]
    fn sizes_and_line_endings_are_strict() {
        let cases: [&[u8]; 8] = [
            b"10000000000000000\r\n",
            b"\r\nWiki\r\n0\r\n\r\n",
            b"4\nWiki\r\n0\r\n\r\n",
            b"4\r\nWiki\n0\r\n\r\n",
            b"4\r\nWikipedia\r\n0\r\n\r\n",
            b"4\rWiki\r\n0\r\n\r\n",
            b"g\r\n",
            b"0\r\n\n",
        ];
        for body in cases {
            assert_eq!(
                decode_all(body).map(|r| r.0),
                Err(Reject::bad_request()),
                "{body:?}"
            );
        }
        assert_eq!(
            decode_all(b"0004\r\nWiki\r\n0\r\n\r\n").map(|r| r.0),
            Ok(b"Wiki".to_vec())
        );
        assert_eq!(
            decode_all(b"A\r\n0123456789\r\n0\r\n\r\n").map(|r| r.0),
            Ok(b"0123456789".to_vec())
        );
        let mut done = ChunkedDecoder::new();
        assert!(decode_all(b"0\r\n\r\n").is_ok());
        let _ = done.decode(b"0\r\n\r\n", &Http1Limits::DEFAULT);
        assert!(done.is_done());
        assert_eq!(
            done.decode(b"more", &Http1Limits::DEFAULT),
            Ok(Step::Done {
                trailers: Span::EMPTY,
                consumed: 0
            })
        );
    }

    #[test]
    fn the_encoder_round_trips_through_the_decoder() {
        let mut out = [0u8; MAX_CHUNK_HEADER_LEN];
        assert_eq!(chunk_header(4, &mut out), Some(3));
        assert_eq!(out.get(..3), Some(&b"4\r\n"[..]));
        assert_eq!(chunk_header(0x1A2B, &mut out), Some(6));
        assert_eq!(out.get(..6), Some(&b"1a2b\r\n"[..]));
        assert_eq!(
            chunk_header(usize::MAX, &mut out),
            Some(MAX_CHUNK_HEADER_LEN)
        );
        assert_eq!(chunk_header(4, &mut [0u8; 2]), None);
        assert_eq!(encode_chunk(b"", &mut [0u8; 8]), None);

        let mut body = Vec::new();
        let mut buffer = [0u8; 4_096];
        let mut expected = Vec::new();
        for len in [1usize, 15, 16, 255, 256, 1_000] {
            let data: Vec<u8> = (0..len)
                .map(|index| (index.rem_euclid(251)) as u8)
                .collect();
            let written = encode_chunk(&data, &mut buffer).unwrap_or_default();
            body.extend_from_slice(buffer.get(..written).unwrap_or(&[]));
            expected.extend_from_slice(&data);
        }
        body.extend_from_slice(LAST_CHUNK);
        assert_eq!(decode_all(&body).map(|r| r.0), Ok(expected.clone()));
        assert_eq!(decode_bytewise(&body).unwrap_or_default(), expected);
    }
}
