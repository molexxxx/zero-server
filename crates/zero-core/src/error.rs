//! The error model shared by every zero-server crate.
//!
//! A single [`Error`] type keeps failure handling uniform across crates and maps
//! onto each language binding's native error idiom and onto the C ABI status code.

use alloc::string::String;
use core::fmt;

/// The error type returned by all fallible zero-server operations.
///
/// This enum is `#[non_exhaustive]`: new variants may be added in future releases
/// without a breaking change, so downstream `match` expressions must include a
/// wildcard arm.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A peer violated the protocol in use, such as a malformed request head.
    ///
    /// The payload is a human-readable description of the violation.
    Protocol(String),

    /// An input/output operation on a socket, file or timer failed.
    ///
    /// The payload is a human-readable description of the fault.
    Io(String),

    /// A payload could not be encoded or decoded.
    ///
    /// The payload describes the encoding or decoding fault.
    Codec(String),

    /// The operation targeted a connection, stream or slot that is closed.
    Closed,

    /// An authentication or integrity check failed.
    ///
    /// The payload describes the authentication or integrity fault.
    Auth(String),

    /// The requested capability is not compiled into this build.
    ///
    /// The payload names the missing capability, for example `"tls"`.
    Unsupported(&'static str),

    /// An operation did not complete within its deadline.
    ///
    /// The payload names the operation that timed out.
    Timeout(&'static str),

    /// A configured limit was exceeded.
    ///
    /// The payload names the limit and the offending size.
    Limit(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(message) => write!(f, "protocol error: {message}"),
            Self::Io(message) => write!(f, "io error: {message}"),
            Self::Codec(message) => write!(f, "codec error: {message}"),
            Self::Closed => f.write_str("resource is closed"),
            Self::Auth(message) => write!(f, "authentication error: {message}"),
            Self::Unsupported(capability) => {
                write!(f, "unsupported capability: {capability}")
            }
            Self::Timeout(operation) => write!(f, "timeout: {operation}"),
            Self::Limit(message) => write!(f, "limit exceeded: {message}"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

/// A specialized [`core::result::Result`] whose error type is fixed to [`Error`].
pub type Result<T> = core::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use alloc::format;

    use super::Error;

    #[test]
    fn display_names_the_variant() {
        assert_eq!(format!("{}", Error::Closed), "resource is closed");
        assert_eq!(
            format!("{}", Error::Timeout("header read")),
            "timeout: header read"
        );
    }
}
