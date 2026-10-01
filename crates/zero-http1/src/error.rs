//! The rejection a codec returns for a message it refuses.

use core::fmt;

use zero_http_types::StatusCode;

/// A message the codec refuses, with the status the connection answers and
/// whether it closes afterwards.
///
/// Every framing rejection closes the connection: once a head or a chunk is
/// refused, the position of the next message is unknown, and RFC 9112
/// Section 2.2 has the server "respond with a 400 (Bad Request) response and
/// close the connection".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reject {
    /// The status code to answer with.
    pub status: StatusCode,
    /// Whether the connection closes after the response.
    pub close: bool,
}

impl Reject {
    /// A rejection that closes the connection after the response.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code to answer with.
    #[must_use]
    pub const fn close(status: StatusCode) -> Self {
        Self {
            status,
            close: true,
        }
    }

    /// `400 Bad Request`, closing.
    #[must_use]
    pub const fn bad_request() -> Self {
        Self::close(StatusCode::BAD_REQUEST)
    }

    /// `431 Request Header Fields Too Large`, closing, for a head, a field or
    /// a field count past its limit.
    #[must_use]
    pub const fn header_fields_too_large() -> Self {
        match StatusCode::new(431) {
            Some(status) => Self::close(status),
            None => Self::bad_request(),
        }
    }
}

impl fmt::Display for Reject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.close {
            write!(f, "rejected with {} and the connection closes", self.status)
        } else {
            write!(f, "rejected with {}", self.status)
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Reject {}

impl From<Reject> for zero_core::Error {
    fn from(reject: Reject) -> Self {
        Self::Protocol(alloc::format!("{reject}"))
    }
}

#[cfg(test)]
mod tests {
    use super::Reject;
    use zero_http_types::StatusCode;

    #[test]
    fn rejections_name_their_status_and_closing() {
        assert_eq!(
            alloc::format!("{}", Reject::bad_request()),
            "rejected with 400 Bad Request and the connection closes"
        );
        assert_eq!(Reject::header_fields_too_large().status.as_u16(), 431);
        assert!(Reject::close(StatusCode::URI_TOO_LONG).close);
        assert!(matches!(
            zero_core::Error::from(Reject::bad_request()),
            zero_core::Error::Protocol(_)
        ));
    }
}
