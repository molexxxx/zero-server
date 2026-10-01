//! The error registry: the status and problem type a handler's error is answered
//! with, and the problem details body (RFC 9457).
//!
//! The registry maps every [`zero_core::Error`] variant to a status code and a
//! stable code string, so a handler's failure never reaches the wire as its message
//! (RFC 9457 Section 5: implementation details such as a stack dump are not
//! exposed). The entries of the Node registry transfer as data in the binding step;
//! the codes here are the ones the Rust core produces itself.

use std::io::Write;

use zero_core::Error;
use zero_http_types::StatusCode;

/// The media type of a problem details body (RFC 9457 Section 3).
pub const PROBLEM_MEDIA_TYPE: &[u8] = b"application/problem+json";

/// The `Content-Type` line of a problem details body.
pub(crate) const PROBLEM_CONTENT_TYPE: &[u8] = b"Content-Type: application/problem+json\r\n";

/// The registry: every code the core produces with its status.
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
        out.extend_from_slice(b"{\"type\":\"about:blank\"");
        if let Some(title) = self.title() {
            out.extend_from_slice(b",\"title\":");
            write_string(out, title);
        }
        out.extend_from_slice(b",\"status\":");
        // Writing into a Vec through fmt never fails.
        let _ = write!(out, "{}", self.status.as_u16());
        out.extend_from_slice(b",\"code\":");
        write_string(out, self.code);
        if let Some(detail) = &self.detail {
            out.extend_from_slice(b",\"detail\":");
            write_string(out, detail);
        }
        out.push(b'}');
    }
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
    use super::{code_for, status_for, Problem, REGISTRY};
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
}
