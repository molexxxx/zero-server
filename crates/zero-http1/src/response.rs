//! The response serializer: a status line, validated field lines and a body
//! written into the caller's buffer.
//!
//! The serializer is the response-splitting boundary. Every field name host
//! code supplies must be a `token` and every value a `field-value` (RFC 9110
//! Sections 5.1 and 5.5), so a CR, LF or NUL from a request parameter can
//! never reach the header section, and the only CRs the serializer writes
//! are the line endings it writes itself (RFC 9112 Section 2.2). Precomputed
//! blocks the server built from validated parts are written as they are.
//!
//! The body rules of RFC 9112 Section 6.3 and RFC 9110 Section 8.6 hold
//! whatever the handler does: a response to `HEAD` and a 1xx, 204 or 304
//! response carries no body, and a 1xx or 204 response carries no
//! `Content-Length`.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-11.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6>

use core::fmt;

use zero_date::Decimal;
use zero_http_types::{validate_field_name, validate_field_value, HeaderName, StatusCode};

use crate::chunked::{chunk_header, CHUNK_END, LAST_CHUNK, MAX_CHUNK_HEADER_LEN};

/// Why a write was refused; nothing is written when a write is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteError {
    /// The buffer has no room for the bytes.
    Full,
    /// The field name is not a `token`.
    InvalidName,
    /// The field value is not a `field-value`: it holds CR, LF, NUL or
    /// another control character, or starts or ends with whitespace.
    InvalidValue,
    /// `Content-Length` is not allowed on a 1xx or 204 response.
    NoContentLength,
    /// The status line must be written first.
    NoStatus,
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Full => "the response buffer is full",
            Self::InvalidName => "the field name is not a token",
            Self::InvalidValue => "the field value holds a control character or edge whitespace",
            Self::NoContentLength => "a 1xx or 204 response carries no Content-Length",
            Self::NoStatus => "the status line must be written first",
        })
    }
}

#[cfg(feature = "std")]
impl std::error::Error for WriteError {}

impl From<WriteError> for zero_core::Error {
    fn from(error: WriteError) -> Self {
        match error {
            WriteError::Full => Self::Limit(alloc::format!("{error}")),
            _ => Self::Protocol(alloc::format!("{error}")),
        }
    }
}

/// Returns `true` when a response may carry a body: not a response to
/// `HEAD`, and not a 1xx, 204 or 304 response.
///
/// # Arguments
///
/// * `head_request` - whether the request method was `HEAD`.
/// * `status` - the response status.
#[must_use]
pub const fn body_allowed(head_request: bool, status: StatusCode) -> bool {
    !(head_request || status.is_informational() || status.as_u16() == 204 || status.as_u16() == 304)
}

/// Returns `true` when a response may carry `Content-Length`: every
/// response but 1xx and 204.
///
/// # Arguments
///
/// * `status` - the response status.
#[must_use]
pub const fn content_length_allowed(status: StatusCode) -> bool {
    !(status.is_informational() || status.as_u16() == 204)
}

/// A response being written into a caller's buffer.
#[derive(Debug)]
pub struct ResponseWriter<'a> {
    out: &'a mut [u8],
    len: usize,
    status: Option<StatusCode>,
    head_request: bool,
}

impl<'a> ResponseWriter<'a> {
    /// Starts a response in `out`.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the response is written at the start of.
    /// * `head_request` - whether the request method was `HEAD`, whose
    ///   response carries no body.
    #[must_use]
    pub fn new(out: &'a mut [u8], head_request: bool) -> Self {
        Self {
            out,
            len: 0,
            status: None,
            head_request,
        }
    }

    /// Returns the number of bytes written so far.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Returns `true` when nothing was written yet.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns the bytes written so far.
    #[must_use]
    pub fn written(&self) -> &[u8] {
        self.out.get(..self.len).unwrap_or(&[])
    }

    /// Returns the status, once the status line was written.
    #[must_use]
    pub const fn status(&self) -> Option<StatusCode> {
        self.status
    }

    /// Returns `true` when this response may carry a body.
    #[must_use]
    pub fn body_allowed(&self) -> bool {
        self.status
            .is_some_and(|status| body_allowed(self.head_request, status))
    }

    /// Writes the status line.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code; a code outside the table gets a line
    ///   with no reason phrase.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::Full`] when the buffer has no room.
    pub fn status_line(&mut self, status: StatusCode) -> Result<(), WriteError> {
        let rest = self.out.get_mut(self.len..).unwrap_or(&mut []);
        let written = status.write_status_line(rest).ok_or(WriteError::Full)?;
        self.len = self.len.saturating_add(written);
        self.status = Some(status);
        Ok(())
    }

    /// Writes a field line after validating its name and value.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, which must be a `token`.
    /// * `value` - the field value, which must be a `field-value`.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::InvalidName`], [`WriteError::InvalidValue`],
    /// [`WriteError::NoStatus`] or [`WriteError::Full`]; nothing is written.
    pub fn field(&mut self, name: &[u8], value: &[u8]) -> Result<(), WriteError> {
        validate_field_name(name).map_err(|_| WriteError::InvalidName)?;
        validate_field_value(value).map_err(|_| WriteError::InvalidValue)?;
        self.field_line(name, value)
    }

    /// Writes a field line for an interned name after validating the value.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned field name.
    /// * `value` - the field value, which must be a `field-value`.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::InvalidValue`], [`WriteError::NoStatus`] or
    /// [`WriteError::Full`]; nothing is written.
    pub fn field_id(&mut self, name: HeaderName, value: &[u8]) -> Result<(), WriteError> {
        validate_field_value(value).map_err(|_| WriteError::InvalidValue)?;
        self.field_line(name.canonical().as_bytes(), value)
    }

    /// Writes `Content-Length`.
    ///
    /// # Arguments
    ///
    /// * `len` - the body length in octets.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoContentLength`] on a 1xx or 204 response,
    /// [`WriteError::NoStatus`] or [`WriteError::Full`]; nothing is written.
    pub fn content_length(&mut self, len: u64) -> Result<(), WriteError> {
        let status = self.status.ok_or(WriteError::NoStatus)?;
        if !content_length_allowed(status) {
            return Err(WriteError::NoContentLength);
        }
        let decimal = Decimal::new(len);
        self.field_line(
            HeaderName::ContentLength.canonical().as_bytes(),
            decimal.as_bytes(),
        )
    }

    /// Writes `Transfer-Encoding: chunked`, after which the body goes
    /// through [`chunk`](Self::chunk) and [`last_chunk`](Self::last_chunk).
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn chunked(&mut self) -> Result<(), WriteError> {
        self.field_line(
            HeaderName::TransferEncoding.canonical().as_bytes(),
            b"chunked",
        )
    }

    /// Writes `Connection: close`.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn connection_close(&mut self) -> Result<(), WriteError> {
        self.field_line(HeaderName::Connection.canonical().as_bytes(), b"close")
    }

    /// Writes a precomputed block of field lines the server built from
    /// validated parts, each ending in CRLF.
    ///
    /// # Arguments
    ///
    /// * `block` - the bytes to copy.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn raw(&mut self, block: &[u8]) -> Result<(), WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        self.copy(block)
    }

    /// Ends the header section with the empty line.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn end_head(&mut self) -> Result<(), WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        self.copy(b"\r\n")
    }

    /// Writes body bytes, or nothing when the response carries no body.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the body bytes.
    ///
    /// # Returns
    ///
    /// The number of bytes written: all of them, or zero when the response
    /// to `HEAD` or a 1xx, 204 or 304 response suppresses the body.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn body(&mut self, bytes: &[u8]) -> Result<usize, WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        if !self.body_allowed() {
            return Ok(0);
        }
        self.copy(bytes)?;
        Ok(bytes.len())
    }

    /// Writes one chunk of a chunked body, or nothing when the response
    /// carries no body.
    ///
    /// # Arguments
    ///
    /// * `data` - the chunk data; empty data writes nothing, since an empty
    ///   chunk would end the body.
    ///
    /// # Returns
    ///
    /// The number of bytes written, framing included.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn chunk(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        if data.is_empty() || !self.body_allowed() {
            return Ok(0);
        }
        let mut header = [0u8; MAX_CHUNK_HEADER_LEN];
        let header_len = chunk_header(data.len(), &mut header).ok_or(WriteError::Full)?;
        let total = header_len
            .checked_add(data.len())
            .and_then(|total| total.checked_add(CHUNK_END.len()))
            .ok_or(WriteError::Full)?;
        if self.remaining() < total {
            return Err(WriteError::Full);
        }
        self.copy(header.get(..header_len).unwrap_or(&[]))?;
        self.copy(data)?;
        self.copy(CHUNK_END)?;
        Ok(total)
    }

    /// Writes the last chunk and the final CRLF, or nothing when the
    /// response carries no body.
    ///
    /// # Returns
    ///
    /// The number of bytes written.
    ///
    /// # Errors
    ///
    /// Returns [`WriteError::NoStatus`] or [`WriteError::Full`].
    pub fn last_chunk(&mut self) -> Result<usize, WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        if !self.body_allowed() {
            return Ok(0);
        }
        self.copy(LAST_CHUNK)?;
        Ok(LAST_CHUNK.len())
    }

    fn remaining(&self) -> usize {
        self.out.len().saturating_sub(self.len)
    }

    /// Writes `name: value CRLF` for a name and value already validated.
    fn field_line(&mut self, name: &[u8], value: &[u8]) -> Result<(), WriteError> {
        if self.status.is_none() {
            return Err(WriteError::NoStatus);
        }
        let total = name
            .len()
            .checked_add(2)
            .and_then(|total| total.checked_add(value.len()))
            .and_then(|total| total.checked_add(2))
            .ok_or(WriteError::Full)?;
        if self.remaining() < total {
            return Err(WriteError::Full);
        }
        self.copy(name)?;
        self.copy(b": ")?;
        self.copy(value)?;
        self.copy(b"\r\n")
    }

    fn copy(&mut self, bytes: &[u8]) -> Result<(), WriteError> {
        let end = self.len.checked_add(bytes.len()).ok_or(WriteError::Full)?;
        let target = self.out.get_mut(self.len..end).ok_or(WriteError::Full)?;
        target.copy_from_slice(bytes);
        self.len = end;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{body_allowed, content_length_allowed, ResponseWriter, WriteError};
    use zero_http_types::{HeaderName, StatusCode};

    fn writer(out: &mut [u8], status: StatusCode, head: bool) -> ResponseWriter<'_> {
        let mut writer = ResponseWriter::new(out, head);
        assert_eq!(writer.status_line(status), Ok(()));
        writer
    }

    /// RFC 9110 Section 5.5: a field value holds no CR, LF or NUL; the
    /// serializer refuses such a value instead of emitting it, which is the
    /// response-splitting boundary of RFC 9112 Section 11.1.
    #[test]
    fn setting_a_response_header_whose_value_contains_cr_lf_or_nul_is() {
        let mut out = [0u8; 256];
        let mut writer = writer(&mut out, StatusCode::OK, false);
        let before = writer.len();
        for value in [
            &b"a\r\nSet-Cookie: x"[..],
            b"a\nb",
            b"a\0b",
            b"a\rb",
            b" leading",
            b"trailing ",
            b"\x7f",
        ] {
            assert_eq!(
                writer.field(b"Location", value),
                Err(WriteError::InvalidValue),
                "{value:?}"
            );
            assert_eq!(
                writer.field_id(HeaderName::Location, value),
                Err(WriteError::InvalidValue),
                "{value:?}"
            );
            assert_eq!(writer.len(), before, "{value:?}");
        }
        for name in [&b"X Y"[..], b"X:Y", b"X\r\nY", b"", b"X\x00"] {
            assert_eq!(
                writer.field(name, b"v"),
                Err(WriteError::InvalidName),
                "{name:?}"
            );
            assert_eq!(writer.len(), before, "{name:?}");
        }
        assert_eq!(writer.field(b"Location", b"/safe?x=1"), Ok(()));
        assert_eq!(
            writer.written(),
            &b"HTTP/1.1 200 OK\r\nLocation: /safe?x=1\r\n"[..]
        );
    }

    /// RFC 9112 Section 2.2: a sender never generates a bare CR outside the
    /// content; every CR the serializer writes in the head is followed by
    /// LF.
    #[test]
    fn the_server_never_generates_a_bare_cr_outside_content() {
        let mut out = [0u8; 512];
        let mut writer = writer(&mut out, StatusCode::OK, false);
        assert_eq!(writer.field_id(HeaderName::Server, b"zero"), Ok(()));
        assert_eq!(writer.field(b"X-Trace", b"a\tb c"), Ok(()));
        assert_eq!(
            writer.field_id(HeaderName::ContentType, b"text/plain; charset=utf-8"),
            Ok(())
        );
        assert_eq!(writer.content_length(3), Ok(()));
        assert_eq!(writer.raw(b"Cache-Control: no-store\r\n"), Ok(()));
        assert_eq!(writer.connection_close(), Ok(()));
        assert_eq!(writer.end_head(), Ok(()));
        let head_len = writer.len();
        assert_eq!(writer.body(b"a\rb"), Ok(3));
        let head = writer.written().get(..head_len).unwrap_or(&[]);
        for (index, byte) in head.iter().enumerate() {
            if *byte == b'\r' {
                assert_eq!(
                    head.get(index.saturating_add(1)),
                    Some(&b'\n'),
                    "bare CR at {index}"
                );
            }
            if *byte == b'\n' {
                assert_eq!(
                    index.checked_sub(1).and_then(|at| head.get(at)),
                    Some(&b'\r'),
                    "bare LF at {index}"
                );
            }
        }
        assert_eq!(head.windows(2).filter(|pair| *pair == b"\r\n").count(), 8);
        assert!(head.ends_with(b"\r\n\r\n"));
        assert_eq!(
            writer.written(),
            &b"HTTP/1.1 200 OK\r\nServer: zero\r\nX-Trace: a\tb c\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 3\r\nCache-Control: no-store\r\nConnection: close\r\n\r\na\rb"[..]
        );
    }

    /// RFC 9110 Section 8.6: a server does not send Content-Length in any
    /// 1xx or 204 response.
    #[test]
    fn no_content_length_header_is_sent_on_1xx_or_204_responses() {
        for status in [
            StatusCode::CONTINUE,
            StatusCode::SWITCHING_PROTOCOLS,
            StatusCode::NO_CONTENT,
        ] {
            let mut out = [0u8; 128];
            let mut writer = writer(&mut out, status, false);
            let before = writer.len();
            assert_eq!(
                writer.content_length(0),
                Err(WriteError::NoContentLength),
                "{status}"
            );
            assert_eq!(writer.len(), before);
            assert!(!content_length_allowed(status));
        }
        for status in [
            StatusCode::OK,
            StatusCode::NOT_MODIFIED,
            StatusCode::NOT_FOUND,
        ] {
            let mut out = [0u8; 128];
            let mut writer = writer(&mut out, status, false);
            assert_eq!(
                writer.content_length(18_446_744_073_709_551_615),
                Ok(()),
                "{status}"
            );
            assert!(writer
                .written()
                .ends_with(b"Content-Length: 18446744073709551615\r\n"));
            assert!(content_length_allowed(status));
        }
    }

    /// RFC 9110 Sections 15.3.5 and 15.4.5 and RFC 9112 Section 6.3: a 204
    /// or 304 response, a 1xx response and a response to HEAD carry no
    /// content, whatever the handler writes.
    #[test]
    fn status_204_and_304_responses_never_carry_content_even_if_the_handler_writes() {
        for (status, head) in [
            (StatusCode::NO_CONTENT, false),
            (StatusCode::NOT_MODIFIED, false),
            (StatusCode::CONTINUE, false),
            (StatusCode::OK, true),
        ] {
            let mut out = [0u8; 128];
            let mut writer = writer(&mut out, status, head);
            assert_eq!(writer.end_head(), Ok(()));
            let head_len = writer.len();
            assert_eq!(writer.body(b"ignored"), Ok(0), "{status}");
            assert_eq!(writer.chunk(b"ignored"), Ok(0), "{status}");
            assert_eq!(writer.last_chunk(), Ok(0), "{status}");
            assert_eq!(writer.len(), head_len, "{status}");
            assert!(!writer.body_allowed());
            assert!(!body_allowed(head, status));
        }
        let mut out = [0u8; 128];
        let mut writer = writer(&mut out, StatusCode::OK, false);
        assert_eq!(writer.chunked(), Ok(()));
        assert_eq!(writer.end_head(), Ok(()));
        assert_eq!(writer.chunk(b"hello"), Ok(10));
        assert_eq!(writer.chunk(b""), Ok(0));
        assert_eq!(writer.last_chunk(), Ok(5));
        assert_eq!(
            writer.written(),
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"[..]
        );
        assert!(body_allowed(false, StatusCode::OK));
        assert!(body_allowed(false, StatusCode::PARTIAL_CONTENT));
    }

    #[test]
    fn a_full_buffer_refuses_without_partial_writes() {
        let mut out = [0u8; 20];
        let mut writer = ResponseWriter::new(&mut out, false);
        assert_eq!(writer.field(b"X", b"y"), Err(WriteError::NoStatus));
        assert_eq!(writer.end_head(), Err(WriteError::NoStatus));
        assert_eq!(writer.body(b"x"), Err(WriteError::NoStatus));
        assert_eq!(writer.content_length(1), Err(WriteError::NoStatus));
        assert!(writer.is_empty());
        assert_eq!(writer.status_line(StatusCode::OK), Ok(()));
        assert_eq!(writer.len(), 17);
        assert_eq!(writer.field(b"X", b"y"), Err(WriteError::Full));
        assert_eq!(writer.content_length(1), Err(WriteError::Full));
        assert_eq!(writer.raw(b"abcd"), Err(WriteError::Full));
        assert_eq!(writer.chunk(b"abc"), Err(WriteError::Full));
        assert_eq!(writer.len(), 17);
        assert_eq!(writer.end_head(), Ok(()));
        assert_eq!(writer.body(b"xy"), Err(WriteError::Full));
        assert_eq!(writer.len(), 19);
        assert_eq!(writer.status(), Some(StatusCode::OK));
        let mut tiny = [0u8; 4];
        let mut writer = ResponseWriter::new(&mut tiny, false);
        assert_eq!(writer.status_line(StatusCode::OK), Err(WriteError::Full));
        assert_eq!(writer.status(), None);
        assert_eq!(
            alloc::format!("{}", WriteError::InvalidValue),
            "the field value holds a control character or edge whitespace"
        );
        assert!(matches!(
            zero_core::Error::from(WriteError::Full),
            zero_core::Error::Limit(_)
        ));
    }

    #[test]
    fn unknown_status_codes_get_a_bare_status_line() {
        let mut out = [0u8; 64];
        let status = StatusCode::new(431).unwrap_or(StatusCode::BAD_REQUEST);
        let mut writer = writer(&mut out, status, false);
        assert_eq!(writer.end_head(), Ok(()));
        assert_eq!(writer.written(), &b"HTTP/1.1 431 \r\n\r\n"[..]);
    }
}
