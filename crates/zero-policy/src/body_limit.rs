//! Per-route body limits: the largest request content each path prefix takes.
//!
//! A 413 (Content Too Large) "indicates that the server is refusing to process a
//! request because the request content is larger than the server is willing or able
//! to process" (RFC 9110 Section 15.5.14). The table answers the driver's
//! [`Handler::body_limit`](zero_http::Handler::body_limit) question when a head
//! arrives, so a declared `Content-Length` over the limit is refused before any
//! content is read, and a chunked body is refused as soon as it grows past it.
//!
//! A prefix matches on segment boundaries: `/upload` covers `/upload` and
//! `/upload/avatar`, never `/uploads`. Both the configured prefixes and the request
//! path are normalized with RFC 3986 Section 6.2.2 first (unreserved octets decoded,
//! dot-segments removed with `remove_dot_segments` of Section 5.2.4), and the query
//! is split off at the first `?` (Section 3.4), so `/upload/../api` is held to the
//! `/api` limit and `/%75pload` to the `/upload` one. An encoded `/` stays encoded and
//! is not a separator (Section 2.2), as in the router. A path that cannot be
//! normalized gets the smallest limit in the table, since the router refuses it
//! anyway once the content is in.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.14>
//! @see <https://www.rfc-editor.org/rfc/rfc3986.html#section-6.2.2>

use zero_core::{Error, Result};
use zero_uri::{normalize_path, split_query};

/// One prefix and its limit.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Rule {
    /// The normalized prefix, without a trailing `/` unless it is the root.
    prefix: Vec<u8>,
    /// The limit in octets.
    limit: u64,
}

/// The per-route body limit table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyLimits {
    /// The limit for a path no prefix covers.
    default: u64,
    /// The prefixes, longest first.
    rules: Vec<Rule>,
}

impl BodyLimits {
    /// A table with no prefixes.
    ///
    /// # Arguments
    ///
    /// * `default` - the limit in octets for a path no prefix covers.
    ///
    /// # Returns
    ///
    /// The table.
    #[must_use]
    pub const fn new(default: u64) -> Self {
        BodyLimits {
            default,
            rules: Vec::new(),
        }
    }

    /// Add a prefix. A prefix added again replaces its earlier limit.
    ///
    /// # Arguments
    ///
    /// * `prefix` - an absolute path, such as `/upload`; a trailing `/` is ignored.
    /// * `limit` - the limit in octets for every path under the prefix.
    ///
    /// # Returns
    ///
    /// The table with the prefix added.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] for a prefix that is not an absolute path, carries a query,
    /// or holds a byte or a percent triplet a path cannot.
    pub fn route(mut self, prefix: &str, limit: u64) -> Result<Self> {
        let bytes = prefix.as_bytes();
        if bytes.first() != Some(&b'/') || bytes.contains(&b'?') {
            return Err(Error::Protocol(format!(
                "a body limit prefix must be an absolute path without a query: {prefix:?}"
            )));
        }
        let mut scratch = Vec::new();
        let normal = normalize_path(bytes, &mut scratch)
            .map_err(|err| Error::Protocol(format!("body limit prefix {prefix:?}: {err}")))?;
        let prefix = trim_slash(normal).to_vec();
        self.rules.retain(|rule| rule.prefix != prefix);
        let at = self
            .rules
            .iter()
            .position(|rule| rule.prefix.len() < prefix.len())
            .unwrap_or(self.rules.len());
        self.rules.insert(at, Rule { prefix, limit });
        Ok(self)
    }

    /// The limit for one request.
    ///
    /// # Arguments
    ///
    /// * `target` - the path and query as received.
    ///
    /// # Returns
    ///
    /// The limit of the longest prefix that covers the normalized path, the default
    /// when none does, or the smallest limit in the table when the path cannot be
    /// normalized.
    #[must_use]
    pub fn limit(&self, target: &[u8]) -> u64 {
        let (path, _) = split_query(target);
        let mut scratch = Vec::new();
        let Ok(path) = normalize_path(path, &mut scratch) else {
            return self.smallest();
        };
        self.rules
            .iter()
            .find(|rule| covers(&rule.prefix, path))
            .map_or(self.default, |rule| rule.limit)
    }

    /// The smallest limit in the table, the default included.
    fn smallest(&self) -> u64 {
        self.rules
            .iter()
            .map(|rule| rule.limit)
            .fold(self.default, u64::min)
    }
}

/// Drop one trailing `/`, keeping the root as it is.
fn trim_slash(path: &[u8]) -> &[u8] {
    match path {
        [rest @ .., b'/'] if !rest.is_empty() => rest,
        _ => path,
    }
}

/// Whether `prefix` covers `path` on a segment boundary.
fn covers(prefix: &[u8], path: &[u8]) -> bool {
    if prefix == b"/" {
        return path.first() == Some(&b'/');
    }
    match path.strip_prefix(prefix) {
        Some(rest) => rest.is_empty() || rest.first() == Some(&b'/'),
        None => false,
    }
}
