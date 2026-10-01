//! The request head parser: a request line and its field lines, into byte
//! spans over the caller's buffer and a caller-owned field table.
//!
//! The parser allocates nothing, keeps no state between calls, and returns
//! one of three answers: the head with the number of bytes it occupies, the
//! need for more input, or a rejection with the status to answer. Every
//! ambiguity the specifications let a recipient repair is refused instead,
//! so a message is either the one grammar says it is or it is not a message:
//!
//! - A line ends in CRLF; a bare CR or a bare LF is refused (RFC 9112
//!   Section 2.2 lets a recipient refuse either).
//! - At least one empty line before the request line is ignored (Section
//!   2.2); whitespace before the first field or at the start of any field
//!   line, which is where obsolete line folding begins, is refused (Sections
//!   2.2 and 5.2).
//! - The request line is `method SP request-target SP HTTP-version` with
//!   single spaces (Section 3); a method longer than any the server
//!   implements is 501 and a request target past the line limit is 414.
//! - No whitespace may precede the colon of a field line (Section 5.1), and a
//!   field value holds no CR, LF, NUL or other control character (RFC 9110
//!   Section 5.5).
//! - An HTTP/1.1 request carries exactly one `Host`, with a value made of
//!   authority characters (Section 3.2); with an absolute-form target the
//!   target's authority is the request's and `Host` is recorded only.
//! - `Transfer-Encoding` with `Content-Length`, a coding list that does not
//!   end in `chunked`, `Transfer-Encoding` on HTTP/1.0, an invalid or
//!   repeated `Content-Length` and a `Content-Length` list are refused with
//!   400; a transfer coding other than `chunked` is 501 (Sections 6.1 and
//!   6.3; RFC 9110 Section 8.6). Every rejection closes the connection.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-3>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-5>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-6>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.1>

use core::ops::Range;

use zero_http_types::{HeaderName, Method, StatusCode};
use zero_limits::http1::Http1Limits;
use zero_simd::{scan_header_name, scan_header_value, scan_target};

use crate::error::Reject;
use crate::list::{
    is_digits, is_host_value, is_ows, list_elements, parse_content_length, trim_ows,
};

/// A range of bytes in the parsed buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Span {
    /// The offset of the first byte.
    pub start: usize,
    /// The offset after the last byte.
    pub end: usize,
}

impl Span {
    /// The empty span at offset zero.
    pub const EMPTY: Self = Self { start: 0, end: 0 };

    /// Creates a span.
    ///
    /// # Arguments
    ///
    /// * `start` - the offset of the first byte.
    /// * `end` - the offset after the last byte.
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    /// Returns the number of bytes.
    #[must_use]
    pub const fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    /// Returns `true` when the span holds no byte.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.end <= self.start
    }

    /// Returns the bytes of the span in `input`, or nothing when the span is
    /// out of range.
    ///
    /// # Arguments
    ///
    /// * `input` - the buffer the span was parsed from.
    #[must_use]
    pub fn of(self, input: &[u8]) -> &[u8] {
        input.get(self.start..self.end).unwrap_or(&[])
    }

    /// Returns the span as a range.
    #[must_use]
    pub const fn as_range(self) -> Range<usize> {
        self.start..self.end
    }
}

/// One field line: the spans of its name and value, and the interned id when
/// the name is in the table.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Field {
    /// The field name as received.
    pub name: Span,
    /// The field value with its surrounding whitespace removed.
    pub value: Span,
    /// The interned name, when the table knows it.
    pub id: Option<HeaderName>,
}

impl Field {
    /// An empty slot of a field table.
    pub const EMPTY: Self = Self {
        name: Span::EMPTY,
        value: Span::EMPTY,
        id: None,
    };

    /// Returns the name bytes.
    ///
    /// # Arguments
    ///
    /// * `input` - the parsed buffer.
    #[must_use]
    pub fn name<'a>(&self, input: &'a [u8]) -> &'a [u8] {
        self.name.of(input)
    }

    /// Returns the value bytes.
    ///
    /// # Arguments
    ///
    /// * `input` - the parsed buffer.
    #[must_use]
    pub fn value<'a>(&self, input: &'a [u8]) -> &'a [u8] {
        self.value.of(input)
    }
}

/// The HTTP version of a request line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Version {
    /// `HTTP/1.0`.
    Http10,
    /// `HTTP/1.1`, and any later minor version of HTTP/1.
    Http11,
}

/// The form of a request target (RFC 9112 Section 3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetForm {
    /// `absolute-path [ "?" query ]`, the usual request to an origin.
    Origin,
    /// An `absolute-URI`, which an origin server must accept.
    Absolute,
    /// `uri-host ":" port`, only with `CONNECT`.
    Authority,
    /// `*`, only with a server-wide `OPTIONS`.
    Asterisk,
}

/// How the message body is delimited (RFC 9112 Section 6.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyLength {
    /// No body: neither `Content-Length` nor `Transfer-Encoding`.
    None,
    /// A body of exactly this many octets.
    Length(u64),
    /// A chunked body, read until the last chunk.
    Chunked,
}

/// What the `Expect` field asks for (RFC 9110 Section 10.1.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Expect {
    /// No expectation, or one on an HTTP/1.0 request, which is ignored.
    #[default]
    None,
    /// `100-continue`: the client waits for an interim response before the
    /// body.
    Continue,
    /// An expectation this server does not define, which may be answered 417.
    Other,
}

/// A parsed request head.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Head {
    /// The method, when it is one of the standardized eight.
    pub method: Option<Method>,
    /// The method token as received.
    pub method_token: Span,
    /// The request target as received.
    pub target: Span,
    /// The form of the request target.
    pub form: TargetForm,
    /// The path and query of the target: the whole origin-form target, the
    /// part after the authority of an absolute-form target, and empty for
    /// the other forms.
    pub path: Span,
    /// The request's authority: the absolute-form target's host and port
    /// (its userinfo excluded), the authority-form target, or the `Host`
    /// value; `None` only for an HTTP/1.0 request without `Host`.
    pub authority: Option<Span>,
    /// The `Host` value as received, when present.
    pub host: Option<Span>,
    /// The protocol version.
    pub version: Version,
    /// The number of entries filled in the field table.
    pub field_count: usize,
    /// How the body is delimited.
    pub body: BodyLength,
    /// Whether the connection persists after the response.
    pub keep_alive: bool,
    /// The `Expect` field's request.
    pub expect: Expect,
    /// Whether the request asks to switch protocols: an `Upgrade` field with
    /// the `upgrade` connection option on HTTP/1.1.
    pub upgrade: bool,
    /// The number of bytes the head occupies, including the empty line and
    /// any empty lines before the request line.
    pub len: usize,
}

/// The outcome of a parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The head is complete.
    Complete(Head),
    /// The buffer ends inside the head; call again with more bytes.
    Partial,
    /// The buffer does not hold a request this server accepts.
    Reject(Reject),
}

/// The longest method this server implements, in bytes (`CONNECT` and
/// `OPTIONS`).
pub const LONGEST_METHOD: usize = 7;

const VERSION_LEN: usize = 8;

/// Parses a request head from the start of `input`.
///
/// # Arguments
///
/// * `input` - the bytes received so far; the head must start at offset
///   zero, after any empty lines.
/// * `table` - the caller's field table; the head fills it from the start,
///   and a request with more fields than the table holds is refused.
/// * `limits` - the request-line, field, count and head limits.
///
/// # Returns
///
/// The head and its length, [`Status::Partial`] when more bytes are needed,
/// or the rejection to answer with.
#[must_use]
pub fn parse_request(input: &[u8], table: &mut [Field], limits: &Http1Limits) -> Status {
    match parse(input, table, limits) {
        Ok(status) => status,
        Err(reject) => Status::Reject(reject),
    }
}

/// The fields the parser interprets while it fills the table.
#[derive(Default)]
struct Interpreted {
    host_count: usize,
    host: Option<Span>,
    content_length_count: usize,
    content_length: Option<Span>,
    transfer_encoding_seen: bool,
    transfer_encoding_invalid: bool,
    transfer_encoding_last_chunked: bool,
    transfer_encoding_other: bool,
    close: bool,
    keep_alive_option: bool,
    upgrade_option: bool,
    upgrade_field: bool,
    expect: Expect,
}

pub(crate) fn byte(input: &[u8], at: usize) -> Option<u8> {
    input.get(at).copied()
}

pub(crate) fn tail(input: &[u8], from: usize) -> &[u8] {
    input.get(from..).unwrap_or(&[])
}

/// Partial unless the head already exceeds the head limit.
fn need_more(input: &[u8], head_start: usize, limits: &Http1Limits) -> Result<Status, Reject> {
    if input.len().saturating_sub(head_start) > limits.max_head_bytes {
        Err(Reject::header_fields_too_large())
    } else {
        Ok(Status::Partial)
    }
}

/// Partial unless the request line already exceeds the line limit, in which
/// case the target is the part that is too long.
fn need_more_line(input: &[u8], line_start: usize, limits: &Http1Limits) -> Result<Status, Reject> {
    if input.len().saturating_sub(line_start) > limits.max_request_line {
        Err(Reject::close(StatusCode::URI_TOO_LONG))
    } else {
        Ok(Status::Partial)
    }
}

fn parse(input: &[u8], table: &mut [Field], limits: &Http1Limits) -> Result<Status, Reject> {
    let mut pos = 0usize;
    while tail(input, pos).starts_with(b"\r\n") {
        pos = pos.saturating_add(2);
        if pos > limits.max_head_bytes {
            return Err(Reject::header_fields_too_large());
        }
    }
    if pos >= input.len() || tail(input, pos) == b"\r" {
        return Ok(Status::Partial);
    }
    let head_start = pos;
    let line_start = pos;

    let rest = tail(input, pos);
    let method_len = scan_header_name(rest);
    if method_len > LONGEST_METHOD {
        return Err(Reject::close(StatusCode::NOT_IMPLEMENTED));
    }
    if method_len == rest.len() {
        return Ok(Status::Partial);
    }
    if method_len == 0 {
        return Err(Reject::bad_request());
    }
    let method_token = Span::new(pos, pos.saturating_add(method_len));
    pos = method_token.end;
    if byte(input, pos) != Some(b' ') {
        return Err(Reject::bad_request());
    }
    pos = pos.saturating_add(1);

    let rest = tail(input, pos);
    let target_len = scan_target(rest);
    if target_len == rest.len() {
        return need_more_line(input, line_start, limits);
    }
    if target_len == 0 {
        return Err(Reject::bad_request());
    }
    let target = Span::new(pos, pos.saturating_add(target_len));
    pos = target.end;
    if byte(input, pos) != Some(b' ') {
        return Err(Reject::bad_request());
    }
    pos = pos.saturating_add(1);

    let Some(version_bytes) = input.get(pos..pos.saturating_add(VERSION_LEN)) else {
        return need_more_line(input, line_start, limits);
    };
    let version = parse_version(version_bytes)?;
    pos = pos.saturating_add(VERSION_LEN);
    match expect_crlf(input, pos) {
        LineEnd::Found => pos = pos.saturating_add(2),
        LineEnd::Partial => return need_more_line(input, line_start, limits),
        LineEnd::Invalid => return Err(Reject::bad_request()),
    }
    if pos.saturating_sub(line_start) > limits.max_request_line {
        return Err(Reject::close(StatusCode::URI_TOO_LONG));
    }

    let mut seen = Interpreted::default();
    let mut field_count = 0usize;
    loop {
        let rest = tail(input, pos);
        match rest.first().copied() {
            None => return need_more(input, head_start, limits),
            Some(b'\r') => match rest.get(1).copied() {
                None => return need_more(input, head_start, limits),
                Some(b'\n') => {
                    pos = pos.saturating_add(2);
                    break;
                }
                Some(_) => return Err(Reject::bad_request()),
            },
            Some(b'\n' | b' ' | b'\t') => return Err(Reject::bad_request()),
            Some(_) => {}
        }
        let field_start = pos;
        let name_len = scan_header_name(rest);
        if name_len == rest.len() {
            return need_more(input, head_start, limits);
        }
        if name_len == 0 {
            return Err(Reject::bad_request());
        }
        let name = Span::new(pos, pos.saturating_add(name_len));
        pos = name.end;
        if byte(input, pos) != Some(b':') {
            return Err(Reject::bad_request());
        }
        pos = pos.saturating_add(1);
        while byte(input, pos).is_some_and(is_ows) {
            pos = pos.saturating_add(1);
        }
        let value_start = pos;
        let value_len = scan_header_value(tail(input, pos));
        let value_limit = pos.saturating_add(value_len);
        match expect_crlf(input, value_limit) {
            LineEnd::Found => {}
            LineEnd::Partial => return need_more(input, head_start, limits),
            LineEnd::Invalid => return Err(Reject::bad_request()),
        }
        let mut value_end = value_limit;
        while value_end > value_start
            && byte(input, value_end.saturating_sub(1)).is_some_and(is_ows)
        {
            value_end = value_end.saturating_sub(1);
        }
        pos = value_limit.saturating_add(2);
        if pos.saturating_sub(field_start) > limits.max_header_field {
            return Err(Reject::header_fields_too_large());
        }
        if field_count >= limits.max_header_count {
            return Err(Reject::header_fields_too_large());
        }
        let Some(slot) = table.get_mut(field_count) else {
            return Err(Reject::header_fields_too_large());
        };
        let value = Span::new(value_start, value_end);
        let id = HeaderName::parse(name.of(input));
        *slot = Field { name, value, id };
        field_count = field_count.saturating_add(1);
        interpret(&mut seen, id, value, input, version);
    }
    if pos.saturating_sub(head_start) > limits.max_head_bytes {
        return Err(Reject::header_fields_too_large());
    }

    let method = Method::parse(method_token.of(input));
    let (form, path, target_authority) = classify_target(target, input, method)?;

    if seen.host_count > 1 {
        return Err(Reject::bad_request());
    }
    if seen.host_count == 0 && version == Version::Http11 {
        return Err(Reject::bad_request());
    }
    if let Some(host) = seen.host {
        if !is_host_value(host.of(input)) {
            return Err(Reject::bad_request());
        }
    }
    let authority = target_authority.or(seen.host);

    let body = framing(&seen, input, version)?;

    let keep_alive = !seen.close
        && match version {
            Version::Http11 => true,
            Version::Http10 => seen.keep_alive_option,
        };
    let expect = match version {
        Version::Http11 => seen.expect,
        Version::Http10 => Expect::None,
    };
    let upgrade = version == Version::Http11 && seen.upgrade_field && seen.upgrade_option;

    Ok(Status::Complete(Head {
        method,
        method_token,
        target,
        form,
        path,
        authority,
        host: seen.host,
        version,
        field_count,
        body,
        keep_alive,
        expect,
        upgrade,
        len: pos,
    }))
}

pub(crate) enum LineEnd {
    Found,
    Partial,
    Invalid,
}

/// Requires CRLF at `at`: a lone CR at the end of the input is partial, a CR
/// followed by anything but LF is a bare CR, and a bare LF or any other byte
/// is invalid.
pub(crate) fn expect_crlf(input: &[u8], at: usize) -> LineEnd {
    match byte(input, at) {
        None => LineEnd::Partial,
        Some(b'\r') => match byte(input, at.saturating_add(1)) {
            None => LineEnd::Partial,
            Some(b'\n') => LineEnd::Found,
            Some(_) => LineEnd::Invalid,
        },
        Some(_) => LineEnd::Invalid,
    }
}

/// Parses `HTTP-version`: `HTTP/` DIGIT `.` DIGIT, major 1.
fn parse_version(bytes: &[u8]) -> Result<Version, Reject> {
    let (name, digits) = bytes.split_at_checked(5).ok_or(Reject::bad_request())?;
    if name != b"HTTP/" {
        return Err(Reject::bad_request());
    }
    let (major, minor) = match digits {
        [major @ b'0'..=b'9', b'.', minor @ b'0'..=b'9'] => (*major, *minor),
        _ => return Err(Reject::bad_request()),
    };
    if major != b'1' {
        return Err(Reject::close(StatusCode::HTTP_VERSION_NOT_SUPPORTED));
    }
    Ok(if minor == b'0' {
        Version::Http10
    } else {
        Version::Http11
    })
}

/// Classifies the request target and checks it against the method.
fn classify_target(
    target: Span,
    input: &[u8],
    method: Option<Method>,
) -> Result<(TargetForm, Span, Option<Span>), Reject> {
    let bytes = target.of(input);
    if bytes == b"*" {
        if method != Some(Method::Options) {
            return Err(Reject::bad_request());
        }
        return Ok((TargetForm::Asterisk, Span::EMPTY, None));
    }
    if bytes.first() == Some(&b'/') {
        if method == Some(Method::Connect) {
            return Err(Reject::bad_request());
        }
        return Ok((TargetForm::Origin, target, None));
    }
    if let Some(scheme_len) = bytes.iter().position(|byte| *byte == b':') {
        if tail(bytes, scheme_len).starts_with(b"://") {
            return classify_absolute(target, bytes, scheme_len, method);
        }
    }
    if method != Some(Method::Connect) {
        return Err(Reject::bad_request());
    }
    let Some(colon) = bytes.iter().rposition(|byte| *byte == b':') else {
        return Err(Reject::bad_request());
    };
    let host = bytes.get(..colon).unwrap_or(&[]);
    let port = tail(bytes, colon.saturating_add(1));
    if host.is_empty() || !is_host_value(host) || !is_digits(port) {
        return Err(Reject::bad_request());
    }
    Ok((TargetForm::Authority, Span::EMPTY, Some(target)))
}

/// Classifies an absolute-form target: an `http` or `https` URI whose
/// authority is the request's authority and whose host is not empty.
fn classify_absolute(
    target: Span,
    bytes: &[u8],
    scheme_len: usize,
    method: Option<Method>,
) -> Result<(TargetForm, Span, Option<Span>), Reject> {
    if method == Some(Method::Connect) {
        return Err(Reject::bad_request());
    }
    let scheme = bytes.get(..scheme_len).unwrap_or(&[]);
    if !(scheme.eq_ignore_ascii_case(b"http") || scheme.eq_ignore_ascii_case(b"https")) {
        return Err(Reject::bad_request());
    }
    let authority_start = scheme_len.saturating_add(3);
    let after = tail(bytes, authority_start);
    let authority_len = after
        .iter()
        .position(|byte| matches!(byte, b'/' | b'?'))
        .unwrap_or(after.len());
    let authority = after.get(..authority_len).unwrap_or(&[]);
    let host_start = authority
        .iter()
        .position(|byte| *byte == b'@')
        .map_or(0, |at| at.saturating_add(1));
    let host = tail(authority, host_start);
    if host.is_empty() || !is_host_value(host) {
        return Err(Reject::bad_request());
    }
    let authority_span = Span::new(
        target
            .start
            .saturating_add(authority_start)
            .saturating_add(host_start),
        target
            .start
            .saturating_add(authority_start)
            .saturating_add(authority_len),
    );
    let path = Span::new(authority_span.end, target.end);
    Ok((TargetForm::Absolute, path, Some(authority_span)))
}

/// Records the fields the framing and connection decisions need.
fn interpret(
    seen: &mut Interpreted,
    id: Option<HeaderName>,
    value: Span,
    input: &[u8],
    version: Version,
) {
    let bytes = value.of(input);
    match id {
        Some(HeaderName::Host) => {
            seen.host_count = seen.host_count.saturating_add(1);
            if seen.host.is_none() {
                seen.host = Some(value);
            }
        }
        Some(HeaderName::ContentLength) => {
            seen.content_length_count = seen.content_length_count.saturating_add(1);
            if seen.content_length.is_none() {
                seen.content_length = Some(value);
            }
        }
        Some(HeaderName::TransferEncoding) => {
            seen.transfer_encoding_seen = true;
            let mut any = false;
            for coding in list_elements(bytes) {
                any = true;
                let (name, parameters) = match coding.iter().position(|byte| *byte == b';') {
                    Some(at) => (trim_ows(coding.get(..at).unwrap_or(&[])), true),
                    None => (coding, false),
                };
                let chunked = name.eq_ignore_ascii_case(b"chunked");
                if chunked && parameters {
                    seen.transfer_encoding_invalid = true;
                }
                seen.transfer_encoding_last_chunked = chunked;
                if !chunked {
                    seen.transfer_encoding_other = true;
                }
            }
            if !any {
                seen.transfer_encoding_invalid = true;
            }
        }
        Some(HeaderName::Connection) => {
            for option in list_elements(bytes) {
                if option.eq_ignore_ascii_case(b"close") {
                    seen.close = true;
                } else if option.eq_ignore_ascii_case(b"keep-alive") {
                    seen.keep_alive_option = true;
                } else if option.eq_ignore_ascii_case(b"upgrade") {
                    seen.upgrade_option = true;
                }
            }
        }
        Some(HeaderName::Expect) => {
            if version == Version::Http11 {
                for expectation in list_elements(bytes) {
                    if expectation.eq_ignore_ascii_case(b"100-continue") {
                        if seen.expect == Expect::None {
                            seen.expect = Expect::Continue;
                        }
                    } else {
                        seen.expect = Expect::Other;
                    }
                }
            }
        }
        Some(HeaderName::Upgrade) => seen.upgrade_field = true,
        _ => {}
    }
}

/// Decides the body length from the framing fields (RFC 9112 Sections 6.1
/// and 6.3).
fn framing(seen: &Interpreted, input: &[u8], version: Version) -> Result<BodyLength, Reject> {
    if seen.transfer_encoding_seen {
        if version == Version::Http10
            || seen.content_length_count > 0
            || seen.transfer_encoding_invalid
            || !seen.transfer_encoding_last_chunked
        {
            return Err(Reject::bad_request());
        }
        if seen.transfer_encoding_other {
            return Err(Reject::close(StatusCode::NOT_IMPLEMENTED));
        }
        return Ok(BodyLength::Chunked);
    }
    match seen.content_length {
        None => Ok(BodyLength::None),
        Some(span) => {
            if seen.content_length_count > 1 {
                return Err(Reject::bad_request());
            }
            parse_content_length(span.of(input))
                .map(BodyLength::Length)
                .ok_or(Reject::bad_request())
        }
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec::Vec;

    use super::{
        parse_request, BodyLength, Expect, Field, Head, Span, Status, TargetForm, Version,
        LONGEST_METHOD,
    };
    use zero_http_types::{HeaderName, Method};
    use zero_limits::http1::Http1Limits;

    fn parse(input: &[u8]) -> Status {
        let mut table = [Field::EMPTY; 64];
        parse_request(input, &mut table, &Http1Limits::DEFAULT)
    }

    fn parse_head(input: &[u8]) -> Head {
        match parse(input) {
            Status::Complete(head) => head,
            other => unreachable!("expected a head for {input:?}, got {other:?}"),
        }
    }

    fn rejected(input: &[u8]) -> (u16, bool) {
        match parse(input) {
            Status::Reject(reject) => (reject.status.as_u16(), reject.close),
            other => unreachable!("expected a rejection for {input:?}, got {other:?}"),
        }
    }

    const SIMPLE: &[u8] = b"GET /index.html HTTP/1.1\r\nHost: www.example.org\r\n\r\n";

    #[test]
    fn a_minimal_request_parses_into_spans() {
        let head = parse_head(SIMPLE);
        assert_eq!(head.method, Some(Method::Get));
        assert_eq!(head.method_token.of(SIMPLE), b"GET");
        assert_eq!(head.target.of(SIMPLE), b"/index.html");
        assert_eq!(head.path.of(SIMPLE), b"/index.html");
        assert_eq!(head.form, TargetForm::Origin);
        assert_eq!(head.version, Version::Http11);
        assert_eq!(head.field_count, 1);
        assert_eq!(
            head.authority.map(|span| span.of(SIMPLE)),
            Some(&b"www.example.org"[..])
        );
        assert_eq!(head.host, head.authority);
        assert_eq!(head.body, BodyLength::None);
        assert!(head.keep_alive);
        assert_eq!(head.expect, Expect::None);
        assert!(!head.upgrade);
        assert_eq!(head.len, SIMPLE.len());
    }

    #[test]
    fn the_field_table_holds_names_values_and_ids() {
        let input = b"POST /submit HTTP/1.1\r\nHost: a\r\nContent-Type:  text/plain \t\r\nX-Custom: v1\r\ncontent-length: 5\r\n\r\nhello";
        let mut table = [Field::EMPTY; 8];
        let Status::Complete(head) = parse_request(input, &mut table, &Http1Limits::DEFAULT) else {
            unreachable!("expected a head");
        };
        assert_eq!(head.field_count, 4);
        let fields: Vec<(&[u8], &[u8], Option<HeaderName>)> = table
            .iter()
            .take(head.field_count)
            .map(|field| (field.name(input), field.value(input), field.id))
            .collect();
        assert_eq!(
            fields,
            [
                (&b"Host"[..], &b"a"[..], Some(HeaderName::Host)),
                (
                    b"Content-Type",
                    b"text/plain",
                    Some(HeaderName::ContentType)
                ),
                (b"X-Custom", b"v1", None),
                (b"content-length", b"5", Some(HeaderName::ContentLength)),
            ]
        );
        assert_eq!(head.body, BodyLength::Length(5));
        assert_eq!(input.get(head.len..), Some(&b"hello"[..]));
    }

    #[test]
    fn every_proper_prefix_is_partial_and_the_whole_is_complete() {
        let inputs: [&[u8]; 4] = [
            SIMPLE,
            b"\r\nOPTIONS * HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            b"CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n",
            b"GET http://EXAMPLE.org/a?b HTTP/1.1\r\nHost: other\r\nTransfer-Encoding: chunked\r\n\r\n",
        ];
        for input in inputs {
            for cut in 0..input.len() {
                assert_eq!(
                    parse(input.get(..cut).unwrap_or(&[])),
                    Status::Partial,
                    "prefix {cut} of {input:?}"
                );
            }
            assert!(matches!(parse(input), Status::Complete(_)), "{input:?}");
        }
    }

    /// RFC 9112 Section 6.1: a request with both fields may be rejected and
    /// the connection must close afterwards; Section 6.3 calls the pair a
    /// likely smuggling attempt.
    #[test]
    fn a_request_carrying_both_transfer_encoding_and_content_length_is_framed_by() {
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n"),
            (400, true)
        );
    }

    /// RFC 9112 Section 6.3: a request whose final transfer coding is not
    /// chunked cannot be delimited and gets 400 with a close; Section 6.1
    /// has a coding the server does not implement answered 501.
    #[test]
    fn a_request_whose_transfer_encoding_does_not_end_in_chunked_is_answered() {
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked, gzip\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"),
            (501, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked;x=y\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: \r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: gzip\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            parse_head(b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: Chunked\r\n\r\n").body,
            BodyLength::Chunked
        );
    }

    /// RFC 9112 Section 6.3 and RFC 9110 Section 8.6: an invalid
    /// Content-Length is an unrecoverable framing error answered 400 with a
    /// close; a list or a repeated field is refused rather than collapsed.
    #[test]
    fn a_request_with_an_invalid_content_length_and_no_transfer_encoding_is() {
        for value in [
            &b"3a"[..],
            b"-1",
            b"",
            b"3, 3",
            b"3 4",
            b"18446744073709551616",
            b"0x1",
        ] {
            let mut input = Vec::from(&b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: "[..]);
            input.extend_from_slice(value);
            input.extend_from_slice(b"\r\n\r\n");
            assert_eq!(rejected(&input), (400, true), "{value:?}");
        }
        assert_eq!(
            rejected(
                b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n"
            ),
            (400, true)
        );
        assert_eq!(
            rejected(
                b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\n"
            ),
            (400, true)
        );
        assert_eq!(
            parse_head(
                b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length:  18446744073709551615 \r\n\r\n"
            )
            .body,
            BodyLength::Length(u64::MAX)
        );
        assert_eq!(
            parse_head(b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n").body,
            BodyLength::Length(0)
        );
    }

    /// RFC 9112 Section 5.1: a server rejects with 400 any request with
    /// whitespace between a field name and the colon.
    #[test]
    fn whitespace_between_a_field_name_and_the_colon_yields_400_bad_request() {
        assert_eq!(rejected(b"GET / HTTP/1.1\r\nHost : a\r\n\r\n"), (400, true));
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost\t: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            parse_head(b"GET / HTTP/1.1\r\nHost:a\r\n\r\n").field_count,
            1
        );
        assert_eq!(
            parse_head(b"GET / HTTP/1.1\r\nHost:\t a\r\n\r\n").field_count,
            1
        );
    }

    /// RFC 9112 Section 3.2: 400 for an HTTP/1.1 request without Host, with
    /// more than one Host line, or with an invalid Host value.
    #[test]
    fn an_http_1_1_request_lacking_host_with_more_than_one_host() {
        assert_eq!(rejected(b"GET / HTTP/1.1\r\n\r\n"), (400, true));
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a b\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a/b\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: u@a\r\n\r\n"),
            (400, true)
        );
        let old = parse_head(b"GET / HTTP/1.0\r\n\r\n");
        assert_eq!(old.version, Version::Http10);
        assert_eq!(old.host, None);
        assert_eq!(old.authority, None);
        assert!(!old.keep_alive);
        assert_eq!(
            parse_head(b"GET / HTTP/1.1\r\nHost:\r\n\r\n")
                .host
                .map(Span::len),
            Some(0)
        );
        let ipv6 = parse_head(b"GET / HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n");
        assert_eq!(
            ipv6.authority
                .map(|span| span.of(b"GET / HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n")),
            Some(&b"[::1]:8080"[..])
        );
    }

    /// RFC 9112 Section 5.2 and Section 2.2: a line that starts with
    /// whitespace is an obsolete fold or whitespace before the first field,
    /// and this server rejects it with 400.
    #[test]
    fn a_request_containing_obs_fold_line_folding_is_rejected_with_400_or() {
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\nX-Long: one\r\n two\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\n\tHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(rejected(b"GET / HTTP/1.1\r\n Host: a\r\n\r\n"), (400, true));
    }

    /// RFC 9112 Section 2.2: a server ignores at least one empty line
    /// received before the request line.
    #[test]
    fn at_least_one_empty_crlf_line_received_before_the_request_line_is() {
        let input = b"\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n";
        let head = parse_head(input);
        assert_eq!(head.method_token.of(input), b"GET");
        assert_eq!(head.len, input.len());
        let two = b"\r\n\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n";
        assert_eq!(head_of(two).len, two.len());
        assert_eq!(parse(b"\r\n"), Status::Partial);
    }

    fn head_of(input: &[u8]) -> Head {
        parse_head(input)
    }

    /// RFC 9112 Section 3: 414 for a request target longer than the server
    /// parses, 501 for a method longer than any it implements, and request
    /// lines of at least 8000 octets supported.
    #[test]
    fn an_over_long_request_target_yields_414_and_an_over_long_unknown() {
        let mut long_target = String::from("GET /");
        long_target.push_str(&"a".repeat(8_300));
        assert_eq!(rejected(long_target.as_bytes()), (414, true));
        let mut unterminated = String::from("GET /");
        unterminated.push_str(&"a".repeat(8_300));
        unterminated.push_str(" HTTP/1.1\r\nHost: a\r\n\r\n");
        assert_eq!(rejected(unterminated.as_bytes()), (414, true));
        assert_eq!(
            rejected(b"ABCDEFGHIJ / HTTP/1.1\r\nHost: a\r\n\r\n"),
            (501, true)
        );
        assert_eq!(LONGEST_METHOD, "CONNECT".len());
        let mut supported = String::from("GET /");
        supported.push_str(&"b".repeat(7_980));
        supported.push_str(" HTTP/1.1\r\nHost: a\r\n\r\n");
        let head = parse_head(supported.as_bytes());
        assert_eq!(head.target.len(), 7_981);
        assert_eq!(parse(b"GET /abc"), Status::Partial);
    }

    /// RFC 9112 Sections 9.3 and 9.6: `close` ends persistence after the
    /// response, HTTP/1.1 persists by default, and HTTP/1.0 persists only
    /// with the `keep-alive` option.
    #[test]
    fn a_request_with_connection_close_causes_the_server_to_close_after_sending() {
        assert!(!parse_head(b"GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n").keep_alive);
        assert!(
            !parse_head(b"GET / HTTP/1.1\r\nHost: a\r\nConnection: keep-alive, Close\r\n\r\n")
                .keep_alive
        );
        assert!(
            parse_head(b"GET / HTTP/1.1\r\nHost: a\r\nConnection: keep-alive\r\n\r\n").keep_alive
        );
        assert!(parse_head(SIMPLE).keep_alive);
        assert!(!parse_head(b"GET / HTTP/1.0\r\n\r\n").keep_alive);
        assert!(parse_head(b"GET / HTTP/1.0\r\nConnection: Keep-Alive\r\n\r\n").keep_alive);
        assert!(!parse_head(b"GET / HTTP/1.0\r\nConnection: keep-alive, close\r\n\r\n").keep_alive);
    }

    #[test]
    fn line_endings_are_crlf_only() {
        assert_eq!(rejected(b"GET / HTTP/1.1\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / HTTP/1.1\r\nHost: a\n\r\n"), (400, true));
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\rX: y\r\n\r\n"),
            (400, true)
        );
        assert_eq!(rejected(b"GET / HTTP/1.1\r\rHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / HTTP/1.1\r\nHost: a\r\n\n"), (400, true));
        assert_eq!(parse(b"GET / HTTP/1.1\r\nHost: a\r\n\r"), Status::Partial);
    }

    #[test]
    fn request_line_spacing_and_version_are_strict() {
        assert_eq!(rejected(b"GET  / HTTP/1.1\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET /\tHTTP/1.1\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / HTTP/1.1 \r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / http/1.1\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / HTTP/1.a\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"GET / HTTP/2.0\r\nHost: a\r\n\r\n"), (505, true));
        assert_eq!(rejected(b"GET / HTTP/0.9\r\nHost: a\r\n\r\n"), (505, true));
        assert_eq!(
            parse_head(b"GET / HTTP/1.2\r\nHost: a\r\n\r\n").version,
            Version::Http11
        );
        assert_eq!(rejected(b" GET / HTTP/1.1\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(rejected(b"G@T / HTTP/1.1\r\nHost: a\r\n\r\n"), (400, true));
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\n:x\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\nX-\x01: y\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\nX: y\x00z\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET / HTTP/1.1\r\nHost: a\r\nX: y\x7f\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            parse_head(b"GET / HTTP/1.1\r\nHost: a\r\nX: caf\xc3\xa9\r\n\r\n").field_count,
            2
        );
        let unknown = parse_head(b"BREW /pot HTTP/1.1\r\nHost: a\r\n\r\n");
        assert_eq!(unknown.method, None);
        assert_eq!(
            unknown
                .method_token
                .of(b"BREW /pot HTTP/1.1\r\nHost: a\r\n\r\n"),
            b"BREW"
        );
        assert_eq!(
            parse_head(b"get / HTTP/1.1\r\nHost: a\r\n\r\n").method,
            None
        );
    }

    #[test]
    fn target_forms_match_their_methods() {
        let absolute =
            b"GET HTTP://User@Example.org:8080/pub/WWW/?q=1 HTTP/1.1\r\nHost: ignored\r\n\r\n";
        let head = parse_head(absolute);
        assert_eq!(head.form, TargetForm::Absolute);
        assert_eq!(
            head.authority.map(|span| span.of(absolute)),
            Some(&b"Example.org:8080"[..])
        );
        assert_eq!(head.path.of(absolute), b"/pub/WWW/?q=1");
        assert_eq!(
            head.host.map(|span| span.of(absolute)),
            Some(&b"ignored"[..])
        );
        let bare = b"GET http://example.org HTTP/1.1\r\nHost: a\r\n\r\n";
        assert_eq!(head_of(bare).path.len(), 0);
        let query_only = b"GET http://example.org?x HTTP/1.1\r\nHost: a\r\n\r\n";
        assert_eq!(head_of(query_only).path.of(query_only), b"?x");
        assert_eq!(
            rejected(b"GET http:/// HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET ftp://x/ HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET http://a b/ HTTP/1.1\r\nHost: a\r\n\r\n").0,
            400
        );
        let star = b"OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n";
        assert_eq!(head_of(star).form, TargetForm::Asterisk);
        assert_eq!(head_of(star).path.len(), 0);
        assert_eq!(rejected(b"GET * HTTP/1.1\r\nHost: a\r\n\r\n"), (400, true));
        let connect = b"CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n";
        let head = parse_head(connect);
        assert_eq!(head.form, TargetForm::Authority);
        assert_eq!(
            head.authority.map(|span| span.of(connect)),
            Some(&b"example.org:443"[..])
        );
        assert_eq!(
            rejected(b"CONNECT example.org HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"CONNECT / HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"CONNECT http://a/ HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET example.org:443 HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
        assert_eq!(
            rejected(b"GET \"/\" HTTP/1.1\r\nHost: a\r\n\r\n"),
            (400, true)
        );
    }

    #[test]
    fn expect_and_upgrade_are_read_on_http_1_1_only() {
        assert_eq!(
            parse_head(
                b"PUT / HTTP/1.1\r\nHost: a\r\nExpect: 100-Continue\r\nContent-Length: 1\r\n\r\n"
            )
            .expect,
            Expect::Continue
        );
        assert_eq!(
            parse_head(b"PUT / HTTP/1.1\r\nHost: a\r\nExpect: 100-continue, other\r\n\r\n").expect,
            Expect::Other
        );
        assert_eq!(
            parse_head(b"PUT / HTTP/1.0\r\nExpect: 100-continue\r\n\r\n").expect,
            Expect::None
        );
        assert!(
            parse_head(
                b"GET / HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            )
            .upgrade
        );
        assert!(!parse_head(b"GET / HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\n\r\n").upgrade);
        assert!(
            !parse_head(b"GET / HTTP/1.0\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n")
                .upgrade
        );
    }

    #[test]
    fn the_head_and_field_limits_answer_431() {
        let mut table = [Field::EMPTY; 2];
        let three = b"GET / HTTP/1.1\r\nHost: a\r\nA: 1\r\nB: 2\r\n\r\n";
        let status = parse_request(three, &mut table, &Http1Limits::DEFAULT);
        assert!(
            matches!(status, Status::Reject(reject) if reject.status.as_u16() == 431 && reject.close)
        );

        let mut limits = Http1Limits::DEFAULT;
        limits.max_header_count = 1;
        let mut table = [Field::EMPTY; 64];
        let two = b"GET / HTTP/1.1\r\nHost: a\r\nA: 1\r\n\r\n";
        assert!(matches!(
            parse_request(two, &mut table, &limits),
            Status::Reject(reject) if reject.status.as_u16() == 431
        ));

        let mut long_field = String::from("GET / HTTP/1.1\r\nHost: a\r\nX: ");
        long_field.push_str(&"v".repeat(8_300));
        long_field.push_str("\r\n\r\n");
        assert_eq!(rejected(long_field.as_bytes()), (431, true));

        let mut huge = String::from("GET / HTTP/1.1\r\nHost: a\r\n");
        for index in 0..60 {
            huge.push_str(&alloc::format!("X-{index}: {}\r\n", "v".repeat(600)));
        }
        assert_eq!(rejected(huge.as_bytes()), (431, true));
        let mut unterminated = String::from("GET / HTTP/1.1\r\nHost: a\r\n");
        unterminated.push_str(&"X: v\r\n".repeat(6_000));
        assert_eq!(rejected(unterminated.as_bytes()), (431, true));
    }
}
