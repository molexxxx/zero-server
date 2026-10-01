//! Status codes, their classes, and the prebuilt status lines.
//!
//! RFC 9110 Section 15 defines the status code as a three-digit integer in
//! 100 to 599 whose first digit is its class, and lists the codes of this
//! table with their recommended reason phrases. RFC 9112 Section 4 defines
//! the status line a server writes: the version, a space, the code, a space
//! and the optional reason phrase, with the space sent even when the phrase
//! is absent.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-4>

use core::fmt;

/// The class of a status code: its first digit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum StatusClass {
    /// 1xx: the request was received, continuing process.
    Informational = 1,
    /// 2xx: the request was successfully received, understood, and accepted.
    Successful = 2,
    /// 3xx: further action needs to be taken in order to complete the request.
    Redirection = 3,
    /// 4xx: the request contains bad syntax or cannot be fulfilled.
    ClientError = 4,
    /// 5xx: the server failed to fulfill an apparently valid request.
    ServerError = 5,
}

/// A status code, 100 to 599.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StatusCode(u16);

/// The length of the status line written for a code with no reason phrase:
/// `HTTP/1.1 NNN \r\n`.
pub const BARE_STATUS_LINE_LEN: usize = 15;

/// The length of the longest status line the table holds.
pub const MAX_STATUS_LINE_LEN: usize = 44;

macro_rules! status_codes {
    ($($name:ident = $code:literal, $reason:literal, $section:literal;)*) => {
        impl StatusCode {
            $(
                #[doc = concat!("`", $code, " ", $reason, "` (RFC 9110 Section ", $section, ").")]
                pub const $name: Self = Self($code);
            )*

            /// Every code of the table, in numeric order.
            pub const TABLE: &'static [Self] = &[$(Self($code)),*];

            /// Returns the reason phrase RFC 9110 recommends for a code of the
            /// table.
            #[must_use]
            pub const fn canonical_reason(self) -> Option<&'static str> {
                match self.0 {
                    $($code => Some($reason),)*
                    _ => None,
                }
            }

            /// Returns the prebuilt `HTTP/1.1` status line of a code of the
            /// table, ending in CRLF.
            #[must_use]
            pub const fn status_line(self) -> Option<&'static [u8]> {
                match self.0 {
                    $($code => Some(concat!("HTTP/1.1 ", $code, " ", $reason, "\r\n").as_bytes()),)*
                    _ => None,
                }
            }
        }
    };
}

status_codes! {
    CONTINUE = 100, "Continue", "15.2.1";
    SWITCHING_PROTOCOLS = 101, "Switching Protocols", "15.2.2";
    OK = 200, "OK", "15.3.1";
    CREATED = 201, "Created", "15.3.2";
    ACCEPTED = 202, "Accepted", "15.3.3";
    NON_AUTHORITATIVE_INFORMATION = 203, "Non-Authoritative Information", "15.3.4";
    NO_CONTENT = 204, "No Content", "15.3.5";
    RESET_CONTENT = 205, "Reset Content", "15.3.6";
    PARTIAL_CONTENT = 206, "Partial Content", "15.3.7";
    MULTIPLE_CHOICES = 300, "Multiple Choices", "15.4.1";
    MOVED_PERMANENTLY = 301, "Moved Permanently", "15.4.2";
    FOUND = 302, "Found", "15.4.3";
    SEE_OTHER = 303, "See Other", "15.4.4";
    NOT_MODIFIED = 304, "Not Modified", "15.4.5";
    USE_PROXY = 305, "Use Proxy", "15.4.6";
    TEMPORARY_REDIRECT = 307, "Temporary Redirect", "15.4.8";
    PERMANENT_REDIRECT = 308, "Permanent Redirect", "15.4.9";
    BAD_REQUEST = 400, "Bad Request", "15.5.1";
    UNAUTHORIZED = 401, "Unauthorized", "15.5.2";
    PAYMENT_REQUIRED = 402, "Payment Required", "15.5.3";
    FORBIDDEN = 403, "Forbidden", "15.5.4";
    NOT_FOUND = 404, "Not Found", "15.5.5";
    METHOD_NOT_ALLOWED = 405, "Method Not Allowed", "15.5.6";
    NOT_ACCEPTABLE = 406, "Not Acceptable", "15.5.7";
    PROXY_AUTHENTICATION_REQUIRED = 407, "Proxy Authentication Required", "15.5.8";
    REQUEST_TIMEOUT = 408, "Request Timeout", "15.5.9";
    CONFLICT = 409, "Conflict", "15.5.10";
    GONE = 410, "Gone", "15.5.11";
    LENGTH_REQUIRED = 411, "Length Required", "15.5.12";
    PRECONDITION_FAILED = 412, "Precondition Failed", "15.5.13";
    CONTENT_TOO_LARGE = 413, "Content Too Large", "15.5.14";
    URI_TOO_LONG = 414, "URI Too Long", "15.5.15";
    UNSUPPORTED_MEDIA_TYPE = 415, "Unsupported Media Type", "15.5.16";
    RANGE_NOT_SATISFIABLE = 416, "Range Not Satisfiable", "15.5.17";
    EXPECTATION_FAILED = 417, "Expectation Failed", "15.5.18";
    MISDIRECTED_REQUEST = 421, "Misdirected Request", "15.5.20";
    UNPROCESSABLE_CONTENT = 422, "Unprocessable Content", "15.5.21";
    UPGRADE_REQUIRED = 426, "Upgrade Required", "15.5.22";
    INTERNAL_SERVER_ERROR = 500, "Internal Server Error", "15.6.1";
    NOT_IMPLEMENTED = 501, "Not Implemented", "15.6.2";
    BAD_GATEWAY = 502, "Bad Gateway", "15.6.3";
    SERVICE_UNAVAILABLE = 503, "Service Unavailable", "15.6.4";
    GATEWAY_TIMEOUT = 504, "Gateway Timeout", "15.6.5";
    HTTP_VERSION_NOT_SUPPORTED = 505, "HTTP Version Not Supported", "15.6.6";
}

impl StatusCode {
    /// Wraps a code.
    ///
    /// # Arguments
    ///
    /// * `code` - the three-digit code.
    ///
    /// # Returns
    ///
    /// The code, or `None` outside 100 to 599, which Section 15 calls
    /// invalid.
    #[must_use]
    pub const fn new(code: u16) -> Option<Self> {
        if code >= 100 && code <= 599 {
            Some(Self(code))
        } else {
            None
        }
    }

    /// Returns the code as an integer.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        self.0
    }

    /// Returns the class: the first digit.
    #[must_use]
    pub const fn class(self) -> StatusClass {
        match self.0.div_euclid(100) {
            1 => StatusClass::Informational,
            2 => StatusClass::Successful,
            3 => StatusClass::Redirection,
            4 => StatusClass::ClientError,
            _ => StatusClass::ServerError,
        }
    }

    /// Returns the `x00` code of this code's class, which Section 15 says an
    /// unrecognized code is equivalent to.
    #[must_use]
    pub const fn class_default(self) -> Self {
        Self(self.0.div_euclid(100).saturating_mul(100))
    }

    /// Returns `true` when the table defines the code.
    #[must_use]
    pub const fn is_recognized(self) -> bool {
        self.canonical_reason().is_some()
    }

    /// Returns `true` for a 1xx code.
    #[must_use]
    pub const fn is_informational(self) -> bool {
        matches!(self.class(), StatusClass::Informational)
    }

    /// Returns `true` for a 2xx code.
    #[must_use]
    pub const fn is_successful(self) -> bool {
        matches!(self.class(), StatusClass::Successful)
    }

    /// Returns `true` for a 3xx code.
    #[must_use]
    pub const fn is_redirection(self) -> bool {
        matches!(self.class(), StatusClass::Redirection)
    }

    /// Returns `true` for a 4xx code.
    #[must_use]
    pub const fn is_client_error(self) -> bool {
        matches!(self.class(), StatusClass::ClientError)
    }

    /// Returns `true` for a 5xx code.
    #[must_use]
    pub const fn is_server_error(self) -> bool {
        matches!(self.class(), StatusClass::ServerError)
    }

    /// Returns `true` for the codes Section 15.1 defines as heuristically
    /// cacheable: 200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414 and
    /// 501.
    #[must_use]
    pub const fn is_heuristically_cacheable(self) -> bool {
        matches!(
            self.0,
            200 | 203 | 204 | 206 | 300 | 301 | 308 | 404 | 405 | 410 | 414 | 501
        )
    }

    /// Writes the `HTTP/1.1` status line, ending in CRLF.
    ///
    /// A code of the table gets its reason phrase; any other code gets no
    /// phrase, and the line still carries the space after the code, as RFC
    /// 9112 Section 4 requires.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer to write at the start of; [`MAX_STATUS_LINE_LEN`]
    ///   bytes always suffice.
    ///
    /// # Returns
    ///
    /// The number of bytes written, or `None` when `out` is too short, in
    /// which case nothing was written.
    pub fn write_status_line(self, out: &mut [u8]) -> Option<usize> {
        if let Some(line) = self.status_line() {
            out.get_mut(..line.len())?.copy_from_slice(line);
            return Some(line.len());
        }
        let line = out.get_mut(..BARE_STATUS_LINE_LEN)?;
        line.copy_from_slice(b"HTTP/1.1 000 \r\n");
        let digits = [
            self.0.div_euclid(100),
            self.0.div_euclid(10).rem_euclid(10),
            self.0.rem_euclid(10),
        ];
        for (offset, digit) in digits.iter().enumerate() {
            if let Some(slot) = line.get_mut(offset.saturating_add(9)) {
                *slot = b'0'.wrapping_add(u8::try_from(*digit).unwrap_or_default());
            }
        }
        Some(BARE_STATUS_LINE_LEN)
    }
}

impl fmt::Display for StatusCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.canonical_reason() {
            Some(reason) => write!(f, "{} {reason}", self.0),
            None => write!(f, "{}", self.0),
        }
    }
}

impl From<StatusCode> for u16 {
    fn from(status: StatusCode) -> Self {
        status.0
    }
}

impl TryFrom<u16> for StatusCode {
    type Error = u16;

    fn try_from(code: u16) -> Result<Self, u16> {
        Self::new(code).ok_or(code)
    }
}

#[cfg(test)]
mod tests {
    use super::{StatusClass, StatusCode, BARE_STATUS_LINE_LEN, MAX_STATUS_LINE_LEN};

    #[test]
    fn the_table_is_rfc_9110_section_15_in_order() {
        let codes: alloc::vec::Vec<u16> =
            StatusCode::TABLE.iter().map(|code| code.as_u16()).collect();
        assert_eq!(
            codes,
            [
                100, 101, 200, 201, 202, 203, 204, 205, 206, 300, 301, 302, 303, 304, 305, 307,
                308, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
                415, 416, 417, 421, 422, 426, 500, 501, 502, 503, 504, 505
            ]
        );
        assert_eq!(StatusCode::OK.canonical_reason(), Some("OK"));
        assert_eq!(
            StatusCode::CONTENT_TOO_LARGE.canonical_reason(),
            Some("Content Too Large")
        );
        assert_eq!(
            StatusCode::UNPROCESSABLE_CONTENT.canonical_reason(),
            Some("Unprocessable Content")
        );
        assert_eq!(
            StatusCode::new(306).and_then(StatusCode::canonical_reason),
            None
        );
        assert_eq!(
            StatusCode::new(418).and_then(StatusCode::canonical_reason),
            None
        );
        assert!(StatusCode::TABLE.iter().all(|code| code.is_recognized()));
    }

    /// RFC 9110 Section 15: the first digit is the class, an unrecognized
    /// code is equivalent to the x00 code of its class, and values outside
    /// 100 to 599 are invalid.
    #[test]
    fn an_unrecognized_status_code_is_treated_as_the_x00_code_of_its_class() {
        let unknown = StatusCode::new(471);
        assert_eq!(
            unknown.map(StatusCode::class),
            Some(StatusClass::ClientError)
        );
        assert_eq!(
            unknown.map(StatusCode::class_default),
            Some(StatusCode::BAD_REQUEST)
        );
        assert_eq!(unknown.map(StatusCode::is_recognized), Some(false));
        assert_eq!(
            StatusCode::new(299).map(StatusCode::class_default),
            Some(StatusCode::OK)
        );
        assert_eq!(
            StatusCode::new(599).map(StatusCode::class_default),
            Some(StatusCode::INTERNAL_SERVER_ERROR)
        );
        assert_eq!(StatusCode::new(99), None);
        assert_eq!(StatusCode::new(600), None);
        assert_eq!(StatusCode::new(0), None);
        assert_eq!(
            StatusCode::new(100).map(StatusCode::class),
            Some(StatusClass::Informational)
        );
        assert_eq!(StatusCode::try_from(999), Err(999));
        assert_eq!(StatusCode::try_from(404), Ok(StatusCode::NOT_FOUND));
        assert_eq!(u16::from(StatusCode::NOT_FOUND), 404);
    }

    #[test]
    fn class_predicates_follow_the_first_digit() {
        assert!(StatusCode::CONTINUE.is_informational());
        assert!(StatusCode::OK.is_successful());
        assert!(StatusCode::FOUND.is_redirection());
        assert!(StatusCode::NOT_FOUND.is_client_error());
        assert!(StatusCode::BAD_GATEWAY.is_server_error());
        assert!(!StatusCode::OK.is_client_error());
        for code in StatusCode::TABLE {
            assert_eq!(code.class() as u16, code.as_u16().div_euclid(100), "{code}");
        }
    }

    #[test]
    fn heuristic_cacheability_is_the_section_15_1_list() {
        let cacheable: alloc::vec::Vec<u16> = StatusCode::TABLE
            .iter()
            .filter(|code| code.is_heuristically_cacheable())
            .map(|code| code.as_u16())
            .collect();
        assert_eq!(
            cacheable,
            [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]
        );
    }

    #[test]
    fn prebuilt_status_lines_carry_the_reason_phrase() {
        assert_eq!(
            StatusCode::OK.status_line(),
            Some(&b"HTTP/1.1 200 OK\r\n"[..])
        );
        assert_eq!(
            StatusCode::NOT_FOUND.status_line(),
            Some(&b"HTTP/1.1 404 Not Found\r\n"[..])
        );
        let longest = StatusCode::TABLE
            .iter()
            .filter_map(|code| code.status_line())
            .map(<[u8]>::len)
            .max();
        assert_eq!(longest, Some(MAX_STATUS_LINE_LEN));
        let mut out = [0u8; MAX_STATUS_LINE_LEN];
        for code in StatusCode::TABLE {
            let written = code.write_status_line(&mut out);
            assert_eq!(written, code.status_line().map(<[u8]>::len), "{code}");
            assert_eq!(
                out.get(..written.unwrap_or_default()),
                code.status_line(),
                "{code}"
            );
        }
        assert_eq!(StatusCode::OK.write_status_line(&mut [0u8; 10]), None);
    }

    /// RFC 9112 Section 4: the reason phrase is optional, and the server
    /// sends the space that separates the code from it even when it is absent.
    #[test]
    fn the_status_line_sends_the_space_after_the_code_even_without_a_reason_phrase() {
        let mut out = [0u8; MAX_STATUS_LINE_LEN];
        let written = StatusCode::new(431).and_then(|code| code.write_status_line(&mut out));
        assert_eq!(written, Some(BARE_STATUS_LINE_LEN));
        assert_eq!(
            out.get(..BARE_STATUS_LINE_LEN),
            Some(&b"HTTP/1.1 431 \r\n"[..])
        );
        assert_eq!(
            StatusCode::new(599).and_then(|code| code.write_status_line(&mut [0u8; 14])),
            None
        );
    }

    #[test]
    fn display_shows_the_code_and_the_phrase_when_known() {
        assert_eq!(alloc::format!("{}", StatusCode::OK), "200 OK");
        assert_eq!(
            StatusCode::new(471).map(|code| alloc::format!("{code}")),
            Some("471".into())
        );
    }
}
