//! Request methods as integer ids.
//!
//! RFC 9110 Section 9.1 defines the method as a case-sensitive token and
//! standardizes eight of them; Section 9.2 classifies them as safe and
//! idempotent. A method outside the table is not a `Method`: the parser
//! reports it as unrecognized and the router answers 501.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-9.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2>

use core::fmt;

/// A standardized request method, numbered in the order of the RFC 9110
/// method table so the id is stable across the C header and every binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Method {
    /// Transfer a current representation of the target resource.
    Get = 0,
    /// Same as GET, but do not transfer the response content.
    Head = 1,
    /// Perform resource-specific processing on the request content.
    Post = 2,
    /// Replace all current representations of the target resource with the
    /// request content.
    Put = 3,
    /// Remove all current representations of the target resource.
    Delete = 4,
    /// Establish a tunnel to the server identified by the target resource.
    Connect = 5,
    /// Describe the communication options for the target resource.
    Options = 6,
    /// Perform a message loop-back test along the path to the target resource.
    Trace = 7,
}

impl Method {
    /// Every standardized method, in id order.
    pub const ALL: [Self; 8] = [
        Self::Get,
        Self::Head,
        Self::Post,
        Self::Put,
        Self::Delete,
        Self::Connect,
        Self::Options,
        Self::Trace,
    ];

    /// Recognizes a method token.
    ///
    /// The match is case-sensitive, as Section 9.1 requires: `get` is not
    /// `GET`.
    ///
    /// # Arguments
    ///
    /// * `token` - the method token as received.
    ///
    /// # Returns
    ///
    /// The method, or `None` when the token is not one of the eight.
    #[must_use]
    pub const fn parse(token: &[u8]) -> Option<Self> {
        match token {
            b"GET" => Some(Self::Get),
            b"HEAD" => Some(Self::Head),
            b"POST" => Some(Self::Post),
            b"PUT" => Some(Self::Put),
            b"DELETE" => Some(Self::Delete),
            b"CONNECT" => Some(Self::Connect),
            b"OPTIONS" => Some(Self::Options),
            b"TRACE" => Some(Self::Trace),
            _ => None,
        }
    }

    /// Returns the method with a given id.
    ///
    /// # Arguments
    ///
    /// * `id` - the id, as [`Method::id`] returns it.
    ///
    /// # Returns
    ///
    /// The method, or `None` when no method has that id.
    #[must_use]
    pub const fn from_id(id: u8) -> Option<Self> {
        match id {
            0 => Some(Self::Get),
            1 => Some(Self::Head),
            2 => Some(Self::Post),
            3 => Some(Self::Put),
            4 => Some(Self::Delete),
            5 => Some(Self::Connect),
            6 => Some(Self::Options),
            7 => Some(Self::Trace),
            _ => None,
        }
    }

    /// Returns the integer id.
    #[must_use]
    pub const fn id(self) -> u8 {
        self as u8
    }

    /// Returns the method token.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Connect => "CONNECT",
            Self::Options => "OPTIONS",
            Self::Trace => "TRACE",
        }
    }

    /// Returns the method token as bytes.
    #[must_use]
    pub const fn as_bytes(self) -> &'static [u8] {
        self.as_str().as_bytes()
    }

    /// Returns `true` for the methods Section 9.2.1 defines as safe: GET, HEAD,
    /// OPTIONS and TRACE.
    #[must_use]
    pub const fn is_safe(self) -> bool {
        matches!(self, Self::Get | Self::Head | Self::Options | Self::Trace)
    }

    /// Returns `true` for the methods Section 9.2.2 defines as idempotent: PUT,
    /// DELETE and the safe methods.
    #[must_use]
    pub const fn is_idempotent(self) -> bool {
        self.is_safe() || matches!(self, Self::Put | Self::Delete)
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Method;

    #[test]
    fn the_eight_methods_round_trip_through_their_tokens_and_ids() {
        for (index, method) in Method::ALL.iter().enumerate() {
            assert_eq!(Method::parse(method.as_bytes()), Some(*method));
            assert_eq!(usize::from(method.id()), index);
            assert_eq!(Method::from_id(method.id()), Some(*method));
            assert_eq!(alloc::format!("{method}"), method.as_str());
        }
        assert_eq!(Method::from_id(8), None);
        assert_eq!(Method::from_id(u8::MAX), None);
    }

    #[test]
    fn method_tokens_are_matched_case_sensitively() {
        assert_eq!(Method::parse(b"GET"), Some(Method::Get));
        assert_eq!(Method::parse(b"get"), None);
        assert_eq!(Method::parse(b"Get"), None);
        assert_eq!(Method::parse(b"GET "), None);
        assert_eq!(Method::parse(b""), None);
        assert_eq!(Method::parse(b"PATCH"), None);
    }

    #[test]
    fn safe_and_idempotent_follow_section_9_2() {
        let safe = [Method::Get, Method::Head, Method::Options, Method::Trace];
        let idempotent_only = [Method::Put, Method::Delete];
        let neither = [Method::Post, Method::Connect];
        for method in safe {
            assert!(method.is_safe() && method.is_idempotent(), "{method}");
        }
        for method in idempotent_only {
            assert!(!method.is_safe() && method.is_idempotent(), "{method}");
        }
        for method in neither {
            assert!(!method.is_safe() && !method.is_idempotent(), "{method}");
        }
    }
}
