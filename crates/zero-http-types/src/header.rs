//! The interned header-name table.
//!
//! The names RFC 9110, RFC 9111 and RFC 9112 register in the HTTP Field Name
//! Registry, as integer ids in alphabetical order. The ids are shared with
//! the C header and every binding, so the table is append-only: a name added
//! later takes the next id and never renumbers an existing one.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-18.4>
//! @see <https://www.rfc-editor.org/rfc/rfc9111.html#section-5>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-12.1>

use core::fmt;

/// The longest name in the table, in bytes.
pub const MAX_HEADER_NAME_LEN: usize = 25;

macro_rules! header_names {
    ($($variant:ident = $id:literal, $lower:literal, $canonical:literal, $source:literal;)*) => {
        /// A registered field name, as an integer id.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[repr(u8)]
        pub enum HeaderName {
            $(
                #[doc = concat!("`", $canonical, "` (", $source, ").")]
                $variant = $id,
            )*
        }

        impl HeaderName {
            /// Every name of the table, in id order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),*];

            /// Returns the name with a given id.
            ///
            /// # Arguments
            ///
            /// * `id` - the id, as [`HeaderName::id`] returns it.
            ///
            /// # Returns
            ///
            /// The name, or `None` when no name has that id.
            #[must_use]
            pub const fn from_id(id: u8) -> Option<Self> {
                match id {
                    $($id => Some(Self::$variant),)*
                    _ => None,
                }
            }

            /// Returns the lowercase spelling, the one HTTP/2 and HTTP/3 send.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $lower,)*
                }
            }

            /// Returns the spelling the registry records.
            #[must_use]
            pub const fn canonical(self) -> &'static str {
                match self {
                    $(Self::$variant => $canonical,)*
                }
            }

            fn parse_lowercase(name: &[u8]) -> Option<Self> {
                match core::str::from_utf8(name).ok()? {
                    $($lower => Some(Self::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

header_names! {
    Accept = 0, "accept", "Accept", "RFC 9110 Section 12.5.1";
    AcceptCharset = 1, "accept-charset", "Accept-Charset", "RFC 9110 Section 12.5.2, deprecated";
    AcceptEncoding = 2, "accept-encoding", "Accept-Encoding", "RFC 9110 Section 12.5.3";
    AcceptLanguage = 3, "accept-language", "Accept-Language", "RFC 9110 Section 12.5.4";
    AcceptRanges = 4, "accept-ranges", "Accept-Ranges", "RFC 9110 Section 14.3";
    Age = 5, "age", "Age", "RFC 9111 Section 5.1";
    Allow = 6, "allow", "Allow", "RFC 9110 Section 10.2.1";
    AuthenticationInfo = 7, "authentication-info", "Authentication-Info", "RFC 9110 Section 11.6.3";
    Authorization = 8, "authorization", "Authorization", "RFC 9110 Section 11.6.2";
    CacheControl = 9, "cache-control", "Cache-Control", "RFC 9111 Section 5.2";
    Connection = 10, "connection", "Connection", "RFC 9110 Section 7.6.1";
    ContentEncoding = 11, "content-encoding", "Content-Encoding", "RFC 9110 Section 8.4";
    ContentLanguage = 12, "content-language", "Content-Language", "RFC 9110 Section 8.5";
    ContentLength = 13, "content-length", "Content-Length", "RFC 9110 Section 8.6";
    ContentLocation = 14, "content-location", "Content-Location", "RFC 9110 Section 8.7";
    ContentRange = 15, "content-range", "Content-Range", "RFC 9110 Section 14.4";
    ContentType = 16, "content-type", "Content-Type", "RFC 9110 Section 8.3";
    Date = 17, "date", "Date", "RFC 9110 Section 6.6.1";
    ETag = 18, "etag", "ETag", "RFC 9110 Section 8.8.3";
    Expect = 19, "expect", "Expect", "RFC 9110 Section 10.1.1";
    Expires = 20, "expires", "Expires", "RFC 9111 Section 5.3";
    From = 21, "from", "From", "RFC 9110 Section 10.1.2";
    Host = 22, "host", "Host", "RFC 9110 Section 7.2";
    IfMatch = 23, "if-match", "If-Match", "RFC 9110 Section 13.1.1";
    IfModifiedSince = 24, "if-modified-since", "If-Modified-Since", "RFC 9110 Section 13.1.3";
    IfNoneMatch = 25, "if-none-match", "If-None-Match", "RFC 9110 Section 13.1.2";
    IfRange = 26, "if-range", "If-Range", "RFC 9110 Section 13.1.5";
    IfUnmodifiedSince = 27, "if-unmodified-since", "If-Unmodified-Since", "RFC 9110 Section 13.1.4";
    LastModified = 28, "last-modified", "Last-Modified", "RFC 9110 Section 8.8.2";
    Location = 29, "location", "Location", "RFC 9110 Section 10.2.2";
    MaxForwards = 30, "max-forwards", "Max-Forwards", "RFC 9110 Section 7.6.2";
    MimeVersion = 31, "mime-version", "MIME-Version", "RFC 9112 Section B.1";
    Pragma = 32, "pragma", "Pragma", "RFC 9111 Section 5.4";
    ProxyAuthenticate = 33, "proxy-authenticate", "Proxy-Authenticate", "RFC 9110 Section 11.7.1";
    ProxyAuthenticationInfo = 34, "proxy-authentication-info", "Proxy-Authentication-Info", "RFC 9110 Section 11.7.3";
    ProxyAuthorization = 35, "proxy-authorization", "Proxy-Authorization", "RFC 9110 Section 11.7.2";
    Range = 36, "range", "Range", "RFC 9110 Section 14.2";
    Referer = 37, "referer", "Referer", "RFC 9110 Section 10.1.3";
    RetryAfter = 38, "retry-after", "Retry-After", "RFC 9110 Section 10.2.3";
    Server = 39, "server", "Server", "RFC 9110 Section 10.2.4";
    Te = 40, "te", "TE", "RFC 9110 Section 10.1.4";
    Trailer = 41, "trailer", "Trailer", "RFC 9110 Section 6.6.2";
    TransferEncoding = 42, "transfer-encoding", "Transfer-Encoding", "RFC 9112 Section 6.1";
    Upgrade = 43, "upgrade", "Upgrade", "RFC 9110 Section 7.8";
    UserAgent = 44, "user-agent", "User-Agent", "RFC 9110 Section 10.1.5";
    Vary = 45, "vary", "Vary", "RFC 9110 Section 12.5.5";
    Via = 46, "via", "Via", "RFC 9110 Section 7.6.3";
    Warning = 47, "warning", "Warning", "RFC 9111 Section 5.5";
    WwwAuthenticate = 48, "www-authenticate", "WWW-Authenticate", "RFC 9110 Section 11.6.1";
}

impl HeaderName {
    /// Recognizes a name in any case.
    ///
    /// # Arguments
    ///
    /// * `name` - the name as received.
    ///
    /// # Returns
    ///
    /// The interned name, or `None` when the table does not hold it.
    #[must_use]
    pub fn parse(name: &[u8]) -> Option<Self> {
        if name.len() > MAX_HEADER_NAME_LEN {
            return None;
        }
        let mut lowered = [0u8; MAX_HEADER_NAME_LEN];
        let target = lowered.get_mut(..name.len())?;
        target.copy_from_slice(name);
        target.make_ascii_lowercase();
        Self::parse_lowercase(target)
    }

    /// Returns the integer id.
    #[must_use]
    pub const fn id(self) -> u8 {
        self as u8
    }

    /// Returns the lowercase spelling as bytes.
    #[must_use]
    pub const fn as_bytes(self) -> &'static [u8] {
        self.as_str().as_bytes()
    }
}

impl fmt::Display for HeaderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::{HeaderName, MAX_HEADER_NAME_LEN};
    use crate::field::is_token;

    #[test]
    fn ids_are_dense_alphabetical_and_round_trip() {
        let mut previous: Option<&str> = None;
        for (index, name) in HeaderName::ALL.iter().enumerate() {
            assert_eq!(usize::from(name.id()), index, "{name}");
            assert_eq!(HeaderName::from_id(name.id()), Some(*name));
            assert_eq!(HeaderName::parse(name.as_bytes()), Some(*name));
            assert_eq!(HeaderName::parse(name.canonical().as_bytes()), Some(*name));
            assert_eq!(name.as_str(), name.canonical().to_ascii_lowercase());
            assert!(is_token(name.as_bytes()), "{name}");
            assert!(name.as_str().len() <= MAX_HEADER_NAME_LEN, "{name}");
            if let Some(previous) = previous {
                assert!(previous < name.as_str(), "{previous} before {name}");
            }
            previous = Some(name.as_str());
        }
        assert_eq!(HeaderName::ALL.len(), 49);
        assert_eq!(HeaderName::from_id(49), None);
    }

    #[test]
    fn parsing_is_case_insensitive_and_exact() {
        assert_eq!(
            HeaderName::parse(b"Content-Length"),
            Some(HeaderName::ContentLength)
        );
        assert_eq!(
            HeaderName::parse(b"CONTENT-LENGTH"),
            Some(HeaderName::ContentLength)
        );
        assert_eq!(HeaderName::parse(b"ETag"), Some(HeaderName::ETag));
        assert_eq!(
            HeaderName::parse(b"WWW-Authenticate"),
            Some(HeaderName::WwwAuthenticate)
        );
        assert_eq!(
            HeaderName::parse(b"Proxy-Authentication-Info"),
            Some(HeaderName::ProxyAuthenticationInfo)
        );
        assert_eq!(HeaderName::parse(b"Content-Length "), None);
        assert_eq!(HeaderName::parse(b"X-Request-Id"), None);
        assert_eq!(HeaderName::parse(b""), None);
        assert_eq!(HeaderName::parse(&[b'a'; 64]), None);
        assert_eq!(HeaderName::parse(b"close"), None);
    }

    #[test]
    fn the_longest_name_fits_the_bound() {
        let longest = HeaderName::ALL.iter().map(|name| name.as_str().len()).max();
        assert_eq!(longest, Some(MAX_HEADER_NAME_LEN));
        assert_eq!(alloc::format!("{}", HeaderName::Te), "te");
        assert_eq!(HeaderName::Te.canonical(), "TE");
    }
}
