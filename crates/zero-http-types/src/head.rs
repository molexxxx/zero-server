//! The protocol-neutral request and response heads.
//!
//! Every front-end codec (HTTP/1.1 today, HTTP/2 and HTTP/3 later) produces
//! the same `RequestHead` and `ResponseHead`, so the router, the handler
//! tiers and the serializers never learn which transport carried a message.
//! HTTP/1.1 folds `Host` into the authority, the way HTTP/2 and HTTP/3 carry
//! it as `:authority`.

use alloc::vec::Vec;

use crate::field::Fields;
use crate::method::Method;
use crate::status::StatusCode;

/// The URI scheme of a request target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// `http`.
    Http,
    /// `https`.
    Https,
    /// Any other scheme, as received.
    Other(Vec<u8>),
}

impl Scheme {
    /// Recognizes a scheme, case-insensitively.
    ///
    /// # Arguments
    ///
    /// * `scheme` - the scheme as received.
    #[must_use]
    pub fn parse(scheme: &[u8]) -> Self {
        if scheme.eq_ignore_ascii_case(b"http") {
            Self::Http
        } else if scheme.eq_ignore_ascii_case(b"https") {
            Self::Https
        } else {
            Self::Other(scheme.to_vec())
        }
    }

    /// Returns the scheme's bytes: the lowercase spelling for the two known
    /// schemes, the received spelling otherwise.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Http => b"http",
            Self::Https => b"https",
            Self::Other(bytes) => bytes,
        }
    }

    /// Returns `true` for `https`.
    #[must_use]
    pub const fn is_secure(&self) -> bool {
        matches!(self, Self::Https)
    }
}

/// Whether a request arrived in TLS early data, before the handshake that
/// authenticated the client's keys completed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Early {
    /// The request arrived after the handshake, or over a cleartext
    /// connection.
    #[default]
    No,
    /// The request arrived in early data and may be a replay.
    Yes,
}

/// The head of a request: method, target and fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestHead {
    /// The request method.
    pub method: Method,
    /// The target's scheme.
    pub scheme: Scheme,
    /// The target's authority: the `Host` value on HTTP/1.1, `:authority`
    /// on HTTP/2 and HTTP/3.
    pub authority: Vec<u8>,
    /// The target's path and query, as received.
    pub path: Vec<u8>,
    /// The header fields.
    pub fields: Fields,
    /// Whether the request arrived in early data.
    pub early: Early,
}

impl RequestHead {
    /// Creates a head with no fields.
    ///
    /// # Arguments
    ///
    /// * `method` - the request method.
    /// * `max_fields` - the number of header fields the head accepts.
    #[must_use]
    pub const fn new(method: Method, max_fields: usize) -> Self {
        Self {
            method,
            scheme: Scheme::Http,
            authority: Vec::new(),
            path: Vec::new(),
            fields: Fields::with_max(max_fields),
            early: Early::No,
        }
    }
}

/// The head of a response: status and fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponseHead {
    /// The status code.
    pub status: StatusCode,
    /// The header fields.
    pub fields: Fields,
}

impl ResponseHead {
    /// Creates a head with no fields.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code.
    /// * `max_fields` - the number of header fields the head accepts.
    #[must_use]
    pub const fn new(status: StatusCode, max_fields: usize) -> Self {
        Self {
            status,
            fields: Fields::with_max(max_fields),
        }
    }
}

/// The trailer fields that follow a chunked or framed body.
pub type Trailers = Fields;

/// One piece of a message body as a codec delivers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyChunk<'a> {
    /// Some bytes of the body, borrowed from the receive buffer.
    Data(&'a [u8]),
    /// The trailer section, after the last data.
    Trailers(Trailers),
    /// The end of the body; nothing follows for this message.
    End,
}

#[cfg(test)]
mod tests {
    use super::{BodyChunk, Early, RequestHead, ResponseHead, Scheme};
    use crate::header::HeaderName;
    use crate::method::Method;
    use crate::status::StatusCode;

    #[test]
    fn schemes_are_recognized_case_insensitively() {
        assert_eq!(Scheme::parse(b"HTTPS"), Scheme::Https);
        assert_eq!(Scheme::parse(b"http"), Scheme::Http);
        assert_eq!(Scheme::parse(b"ws"), Scheme::Other(b"ws".to_vec()));
        assert!(Scheme::Https.is_secure());
        assert!(!Scheme::Http.is_secure());
        assert_eq!(Scheme::parse(b"Http").as_bytes(), b"http");
        assert_eq!(Scheme::parse(b"WS").as_bytes(), b"WS");
    }

    #[test]
    fn heads_start_empty_at_their_field_bound() {
        let mut request = RequestHead::new(Method::Get, 4);
        assert_eq!(request.early, Early::No);
        assert_eq!(request.scheme, Scheme::Http);
        assert!(request.fields.is_empty());
        assert_eq!(request.fields.max(), 4);
        assert!(request
            .fields
            .insert(HeaderName::Host, b"example.com")
            .is_ok());
        request.authority = b"example.com".to_vec();
        request.path = b"/index.html?x=1".to_vec();
        assert_eq!(
            request.fields.get_known(HeaderName::Host),
            Some(&b"example.com"[..])
        );

        let response = ResponseHead::new(StatusCode::OK, 8);
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.fields.max(), 8);
        assert_eq!(Early::default(), Early::No);
    }

    #[test]
    fn body_chunks_borrow_their_data() {
        let buffer = *b"hello";
        let chunk = BodyChunk::Data(&buffer);
        assert_eq!(chunk, BodyChunk::Data(b"hello"));
        assert_ne!(chunk, BodyChunk::End);
        assert_eq!(
            BodyChunk::Trailers(super::Trailers::with_max(1)),
            BodyChunk::Trailers(super::Trailers::with_max(1))
        );
    }
}
