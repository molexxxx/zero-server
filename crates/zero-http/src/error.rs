//! The error registry: the status and problem type a handler's error is answered
//! with, and the body shapes the server answers errors in.
//!
//! The registry maps every [`zero_core::Error`] variant to a status code and a
//! stable code string, so a handler's failure never reaches the wire as its message
//! (RFC 9457 Section 5: implementation details such as a stack dump are not
//! exposed). [`REGISTRY`] holds every code the Rust core produces itself: those of
//! handler errors and those of the answers the router and the driver write.
//!
//! [`ErrorShape`] picks the body of every answer the server writes for an error:
//! [`ErrorShape::Problem`], the default, is the RFC 9457 problem details object with
//! `type` `about:blank`, the reason phrase as `title` (Section 4.2.1), the `status`
//! member equal to the response status (Section 3.1.2) and the registry code as the
//! `code` extension member (Section 3.2); [`ErrorShape::Legacy`] is the JSON body
//! the 1.x server wrote, for applications that read it.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9457.html#section-3>
//! @see <https://www.rfc-editor.org/rfc/rfc9457.html#section-4.2.1>

use std::io::Write;

use zero_core::Error;
use zero_http_types::StatusCode;

/// The media type of a problem details body (RFC 9457 Section 3).
pub const PROBLEM_MEDIA_TYPE: &[u8] = b"application/problem+json";

/// The media type of a legacy error body.
pub const LEGACY_MEDIA_TYPE: &[u8] = b"application/json";

/// The body shape of the answers the server writes for errors: the core's own
/// answers (404, 405, 413, 503 and the rest of the registry), a handler's error, and
/// a host's error through [`Exchange::write_error`](crate::Exchange::write_error).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ErrorShape {
    /// The RFC 9457 problem details object, `application/problem+json`:
    /// `{"type":"about:blank","title":<reason phrase>,"status":<status>,"code":<code>}`
    /// with `detail` when the occurrence has one.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9457.html#section-3.1>
    #[default]
    Problem,
    /// The 1.x bodies, `application/json`: `{"error":<reason phrase>}` for a core
    /// answer, with `message` when the occurrence has a detail, and
    /// `{"error":<message>,"code":<code>,"statusCode":<status>}` with `details` for a
    /// host's error.
    Legacy,
}

impl ErrorShape {
    /// The media type of a body in this shape.
    ///
    /// # Returns
    ///
    /// `application/problem+json` for [`Problem`](Self::Problem), `application/json`
    /// for [`Legacy`](Self::Legacy).
    #[must_use]
    pub const fn media_type(self) -> &'static [u8] {
        match self {
            ErrorShape::Problem => PROBLEM_MEDIA_TYPE,
            ErrorShape::Legacy => LEGACY_MEDIA_TYPE,
        }
    }

    /// The `Content-Type` field line of a body in this shape, ending in CRLF.
    pub(crate) const fn content_type_line(self) -> &'static [u8] {
        match self {
            ErrorShape::Problem => b"Content-Type: application/problem+json\r\n",
            ErrorShape::Legacy => b"Content-Type: application/json\r\n",
        }
    }
}

/// The reason phrase of a status, or `Error` for a code the table does not name.
fn reason(status: StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or("Error")
}

/// The registry: every code the core produces with its status. The first rows are
/// the codes of handler errors ([`code_for`]) and of a handler's panic; the rest
/// are the router's misses (`not_found`, `method_not_allowed`, `not_implemented`),
/// its refusals of a target (`target` for an asterisk form outside `OPTIONS`,
/// `uri` for a path it cannot normalize), and the driver's `misdirected` answer.
pub const REGISTRY: &[(&str, StatusCode)] = &[
    ("protocol", StatusCode::BAD_REQUEST),
    ("codec", StatusCode::BAD_REQUEST),
    ("auth", StatusCode::UNAUTHORIZED),
    ("limit", StatusCode::CONTENT_TOO_LARGE),
    ("internal", StatusCode::INTERNAL_SERVER_ERROR),
    ("io", StatusCode::INTERNAL_SERVER_ERROR),
    ("panic", StatusCode::INTERNAL_SERVER_ERROR),
    ("unsupported", StatusCode::NOT_IMPLEMENTED),
    ("closed", StatusCode::SERVICE_UNAVAILABLE),
    ("timeout", StatusCode::SERVICE_UNAVAILABLE),
    ("upstream_timeout", StatusCode::GATEWAY_TIMEOUT),
    ("not_found", StatusCode::NOT_FOUND),
    ("method_not_allowed", StatusCode::METHOD_NOT_ALLOWED),
    ("not_implemented", StatusCode::NOT_IMPLEMENTED),
    ("target", StatusCode::BAD_REQUEST),
    ("uri", StatusCode::BAD_REQUEST),
    ("misdirected", StatusCode::MISDIRECTED_REQUEST),
];

/// The timeout operation name that means an upstream server did not answer in time,
/// which RFC 9110 Section 15.6.5 reports as 504.
pub const UPSTREAM: &str = "upstream";

/// The status a handler error is answered with.
///
/// # Arguments
///
/// * `error` - the handler's error.
#[must_use]
pub fn status_for(error: &Error) -> StatusCode {
    match error {
        Error::Protocol(_) | Error::Codec(_) => StatusCode::BAD_REQUEST,
        Error::Auth(_) => StatusCode::UNAUTHORIZED,
        Error::Limit(_) => StatusCode::CONTENT_TOO_LARGE,
        Error::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        Error::Unsupported(_) => StatusCode::NOT_IMPLEMENTED,
        Error::Closed => StatusCode::SERVICE_UNAVAILABLE,
        Error::Timeout(operation) if *operation == UPSTREAM => StatusCode::GATEWAY_TIMEOUT,
        Error::Timeout(_) => StatusCode::SERVICE_UNAVAILABLE,
        // A variant a later release adds is a server-side failure until it gets a row.
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The registry code of a handler error.
///
/// # Arguments
///
/// * `error` - the handler's error.
#[must_use]
pub fn code_for(error: &Error) -> &'static str {
    match error {
        Error::Protocol(_) => "protocol",
        Error::Codec(_) => "codec",
        Error::Auth(_) => "auth",
        Error::Limit(_) => "limit",
        Error::Io(_) => "io",
        Error::Unsupported(_) => "unsupported",
        Error::Closed => "closed",
        Error::Timeout(operation) if *operation == UPSTREAM => "upstream_timeout",
        Error::Timeout(_) => "timeout",
        _ => "internal",
    }
}

/// A problem to answer with: the status, the registry code, and a detail for the
/// client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// The status code, which the `status` member repeats.
    pub status: StatusCode,
    /// The registry code, carried as the `code` extension member.
    pub code: &'static str,
    /// A human-readable explanation of this occurrence, for the client; never
    /// debugging output.
    pub detail: Option<String>,
}

impl Problem {
    /// A problem with no detail.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code.
    /// * `code` - the registry code.
    #[must_use]
    pub const fn new(status: StatusCode, code: &'static str) -> Self {
        Problem {
            status,
            code,
            detail: None,
        }
    }

    /// The problem for a handler error: the registry's status and code, with the
    /// error's own message as the detail only for the client-side variants
    /// (`Protocol`, `Codec`, `Limit`), whose messages describe the request.
    ///
    /// # Arguments
    ///
    /// * `error` - the handler's error.
    #[must_use]
    pub fn from_error(error: &Error) -> Self {
        let detail = match error {
            Error::Protocol(message) | Error::Codec(message) | Error::Limit(message) => {
                Some(message.clone())
            }
            _ => None,
        };
        Problem {
            status: status_for(error),
            code: code_for(error),
            detail,
        }
    }

    /// The problem for a handler that panicked: 500 with no detail.
    #[must_use]
    pub const fn panicked() -> Self {
        Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "panic")
    }

    /// The `title` member: the status code's reason phrase, since the type is
    /// `about:blank` (RFC 9457 Section 4.2.1).
    #[must_use]
    pub fn title(&self) -> Option<&'static str> {
        self.status.canonical_reason()
    }

    /// Append the problem details object: `type`, `title`, `status`, `code` and,
    /// when present, `detail`.
    ///
    /// # Arguments
    ///
    /// * `out` - the body buffer.
    pub fn write_json(&self, out: &mut Vec<u8>) {
        write_problem(out, self.status, self.code, self.detail.as_deref(), None);
    }

    /// Append the body of this problem in a shape: the problem details object of
    /// [`write_json`](Self::write_json), or the legacy `{"error":<reason phrase>}`
    /// with the detail as `message`.
    ///
    /// # Arguments
    ///
    /// * `shape` - the body shape.
    /// * `out` - the body buffer.
    pub fn write_body(&self, shape: ErrorShape, out: &mut Vec<u8>) {
        match shape {
            ErrorShape::Problem => self.write_json(out),
            ErrorShape::Legacy => {
                out.extend_from_slice(b"{\"error\":");
                write_string(out, reason(self.status));
                if let Some(detail) = &self.detail {
                    out.extend_from_slice(b",\"message\":");
                    write_string(out, detail);
                }
                out.push(b'}');
            }
        }
    }
}

/// The status a host's error is answered with: its own when it is a client or a
/// server error, 500 otherwise, since an error body never goes with a success.
///
/// # Arguments
///
/// * `status` - the status the host asked for.
///
/// # Returns
///
/// A status from 400 to 599.
#[must_use]
pub const fn error_status(status: StatusCode) -> StatusCode {
    if status.as_u16() >= 400 {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// Append the body of a host's error in a shape.
///
/// The problem details object carries the message as `detail` and the details as
/// the `details` extension member (RFC 9457 Section 3.2); the legacy body is the 1.x
/// `toJSON` shape, whose `error` is the message or, without one, the reason phrase.
///
/// # Arguments
///
/// * `shape` - the body shape.
/// * `status` - the response status, from 400 to 599.
/// * `code` - the error's code.
/// * `message` - the human-readable message, if any.
/// * `details` - one JSON value the caller already checked, if any; it is written
///   as it is.
/// * `out` - the body buffer.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9457.html#section-3.2>
pub fn write_host_error(
    shape: ErrorShape,
    status: StatusCode,
    code: &str,
    message: Option<&str>,
    details: Option<&[u8]>,
    out: &mut Vec<u8>,
) {
    match shape {
        ErrorShape::Problem => write_problem(out, status, code, message, details),
        ErrorShape::Legacy => {
            out.extend_from_slice(b"{\"error\":");
            write_string(out, message.unwrap_or_else(|| reason(status)));
            out.extend_from_slice(b",\"code\":");
            write_string(out, code);
            out.extend_from_slice(b",\"statusCode\":");
            let _ = write!(out, "{}", status.as_u16());
            if let Some(details) = details {
                out.extend_from_slice(b",\"details\":");
                out.extend_from_slice(details);
            }
            out.push(b'}');
        }
    }
}

/// Append a problem details object (RFC 9457 Section 3.1): `type`, `title` when
/// the reason phrase is known, `status`, `code`, then `detail` and `details` when
/// given.
fn write_problem(
    out: &mut Vec<u8>,
    status: StatusCode,
    code: &str,
    detail: Option<&str>,
    details: Option<&[u8]>,
) {
    out.extend_from_slice(b"{\"type\":\"about:blank\"");
    if let Some(title) = status.canonical_reason() {
        out.extend_from_slice(b",\"title\":");
        write_string(out, title);
    }
    out.extend_from_slice(b",\"status\":");
    // Writing into a Vec through fmt never fails.
    let _ = write!(out, "{}", status.as_u16());
    out.extend_from_slice(b",\"code\":");
    write_string(out, code);
    if let Some(detail) = detail {
        out.extend_from_slice(b",\"detail\":");
        write_string(out, detail);
    }
    if let Some(details) = details {
        out.extend_from_slice(b",\"details\":");
        out.extend_from_slice(details);
    }
    out.push(b'}');
}

/// Write a JSON string: quotation marks, reverse solidus and control characters
/// escaped (RFC 8259 Section 7).
fn write_string(out: &mut Vec<u8>, text: &str) {
    out.push(b'"');
    for byte in text.bytes() {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0x00..=0x1F => {
                let _ = write!(out, "\\u{byte:04x}");
            }
            _ => out.push(byte),
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::{
        code_for, error_status, status_for, write_host_error, ErrorShape, Problem, REGISTRY,
    };
    use zero_core::Error;
    use zero_http_types::StatusCode;

    #[test]
    fn every_error_variant_maps_to_a_registry_code_and_its_status() {
        let errors = [
            Error::Protocol("x".to_owned()),
            Error::Io("x".to_owned()),
            Error::Codec("x".to_owned()),
            Error::Closed,
            Error::Auth("x".to_owned()),
            Error::Unsupported("tls"),
            Error::Timeout("upstream"),
            Error::Timeout("database"),
            Error::Limit("x".to_owned()),
        ];
        for error in &errors {
            let code = code_for(error);
            let (_, status) = REGISTRY
                .iter()
                .find(|(name, _)| *name == code)
                .unwrap_or_else(|| panic!("{code} is not in the registry"));
            assert_eq!(*status, status_for(error), "{code}");
        }
        assert_eq!(status_for(&Error::Timeout("upstream")).as_u16(), 504);
        assert_eq!(status_for(&Error::Timeout("database")).as_u16(), 503);
        assert_eq!(status_for(&Error::Auth("x".to_owned())).as_u16(), 401);
    }

    /// The status whose constant is `name`, found through its reason phrase.
    fn status_named(name: &str) -> Option<StatusCode> {
        (100..=599).filter_map(StatusCode::new).find(|status| {
            status.canonical_reason().is_some_and(|reason| {
                reason
                    .chars()
                    .map(|c| match c {
                        ' ' | '-' => '_',
                        other => other.to_ascii_uppercase(),
                    })
                    .eq(name.chars())
            })
        })
    }

    #[test]
    fn every_code_the_crate_writes_is_registered_with_the_status_it_is_written_with() {
        let sources = [
            include_str!("call.rs"),
            include_str!("conn.rs"),
            include_str!("error.rs"),
            include_str!("exchange.rs"),
            include_str!("handler.rs"),
            include_str!("lib.rs"),
            include_str!("record.rs"),
            include_str!("ring.rs"),
            include_str!("server.rs"),
            include_str!("takeover.rs"),
        ];
        let call = ["Problem", "::new("].concat();
        let literal = [call.as_str(), "StatusCode::"].concat();
        let mut written = Vec::new();
        for source in sources {
            let code: String = source
                .split("#[cfg(test)]")
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            assert_eq!(
                code.matches(call.as_str()).count(),
                code.matches(literal.as_str()).count(),
                "every problem names its status as a constant"
            );
            assert!(
                !code.contains("code:\""),
                "every problem is built with Problem::new"
            );
            for (at, _) in code.match_indices(literal.as_str()) {
                let rest = code.get(at + literal.len()..).unwrap_or_default();
                let (name, rest) = rest.split_once(',').unwrap();
                let (written_code, _) = rest.strip_prefix('"').unwrap().split_once('"').unwrap();
                written.push((written_code.to_owned(), status_named(name).unwrap()));
            }
        }
        for (code, status) in &written {
            assert!(
                REGISTRY.contains(&(code.as_str(), *status)),
                "{code} is written with {status} but the registry does not hold that row"
            );
        }
        for code in [
            "not_found",
            "method_not_allowed",
            "not_implemented",
            "target",
            "uri",
            "misdirected",
            "limit",
            "timeout",
            "panic",
        ] {
            assert!(
                written.iter().any(|(found, _)| found == code),
                "{code} was not found in the sources"
            );
        }
    }

    #[test]
    fn the_problem_body_carries_the_members_and_escapes_the_detail() {
        let mut out = Vec::new();
        Problem::from_error(&Error::Protocol("bad \"quote\"\n".to_owned())).write_json(&mut out);
        assert_eq!(
            out,
            br#"{"type":"about:blank","title":"Bad Request","status":400,"code":"protocol","detail":"bad \"quote\"\n"}"#
        );
        let mut out = Vec::new();
        Problem::from_error(&Error::Io("disk on fire".to_owned())).write_json(&mut out);
        assert_eq!(
            out,
            br#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"io"}"#,
            "a server-side message is not a detail"
        );
        assert_eq!(
            Problem::panicked().status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn the_legacy_bodies_escape_their_strings_and_name_the_reason_phrase_when_no_message_is_given()
    {
        let mut out = Vec::new();
        Problem::from_error(&Error::Codec("a \"b\"\u{1}".to_owned()))
            .write_body(ErrorShape::Legacy, &mut out);
        assert_eq!(out, br#"{"error":"Bad Request","message":"a \"b\"\u0001"}"#);
        let mut out = Vec::new();
        write_host_error(
            ErrorShape::Legacy,
            StatusCode::UNPROCESSABLE_CONTENT,
            "VALIDATION_FAILED",
            None,
            Some(br#"[{"field":"age"}]"#),
            &mut out,
        );
        assert_eq!(
            out,
            br#"{"error":"Unprocessable Content","code":"VALIDATION_FAILED","statusCode":422,"details":[{"field":"age"}]}"#
        );
        assert_eq!(ErrorShape::default(), ErrorShape::Problem);
        assert_eq!(ErrorShape::Legacy.media_type(), b"application/json");
        assert_eq!(
            ErrorShape::Problem.media_type(),
            b"application/problem+json"
        );
    }

    #[test]
    fn an_error_status_outside_400_to_599_is_answered_500() {
        for (asked, answered) in [(200, 500), (302, 500), (399, 500), (400, 400), (599, 599)] {
            let status = StatusCode::new(asked).unwrap();
            assert_eq!(error_status(status).as_u16(), answered, "{asked}");
        }
    }
}
