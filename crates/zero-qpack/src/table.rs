//! The QPACK static table (RFC 9204 Section 3.1 and Appendix A).
//!
//! The table is predefined, holds 99 field lines and "is indexed from 0, whereas
//! the HPACK static table is indexed from 1" (Section 3.1). Every entry has a
//! name and a value, which can be empty. The entries are the published Appendix A
//! exactly, written into this file by a script from the extracted table, never
//! typed by hand: entry 73 is `FALSE` and entry 74 `TRUE`, as published, since
//! erratum 7277 against them is Held for Document Update.
//!
//! Names are compared as exact octets. Lowercasing field names is the HTTP/3
//! layer's rule (RFC 9114 Section 4.2) and is not done here.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#appendix-A>

/// One static table entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StaticEntry {
    /// The field name.
    pub name: &'static [u8],
    /// The field value, possibly empty.
    pub value: &'static [u8],
}

/// Builds one entry of [`STATIC_TABLE`].
const fn entry(name: &'static [u8], value: &'static [u8]) -> StaticEntry {
    StaticEntry { name, value }
}

/// The RFC 9204 Appendix A static table, indexed from 0.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#appendix-A>
pub const STATIC_TABLE: [StaticEntry; 99] = [
    entry(b":authority", b""),
    entry(b":path", b"/"),
    entry(b"age", b"0"),
    entry(b"content-disposition", b""),
    entry(b"content-length", b"0"),
    entry(b"cookie", b""),
    entry(b"date", b""),
    entry(b"etag", b""),
    entry(b"if-modified-since", b""),
    entry(b"if-none-match", b""),
    entry(b"last-modified", b""),
    entry(b"link", b""),
    entry(b"location", b""),
    entry(b"referer", b""),
    entry(b"set-cookie", b""),
    entry(b":method", b"CONNECT"),
    entry(b":method", b"DELETE"),
    entry(b":method", b"GET"),
    entry(b":method", b"HEAD"),
    entry(b":method", b"OPTIONS"),
    entry(b":method", b"POST"),
    entry(b":method", b"PUT"),
    entry(b":scheme", b"http"),
    entry(b":scheme", b"https"),
    entry(b":status", b"103"),
    entry(b":status", b"200"),
    entry(b":status", b"304"),
    entry(b":status", b"404"),
    entry(b":status", b"503"),
    entry(b"accept", b"*/*"),
    entry(b"accept", b"application/dns-message"),
    entry(b"accept-encoding", b"gzip, deflate, br"),
    entry(b"accept-ranges", b"bytes"),
    entry(b"access-control-allow-headers", b"cache-control"),
    entry(b"access-control-allow-headers", b"content-type"),
    entry(b"access-control-allow-origin", b"*"),
    entry(b"cache-control", b"max-age=0"),
    entry(b"cache-control", b"max-age=2592000"),
    entry(b"cache-control", b"max-age=604800"),
    entry(b"cache-control", b"no-cache"),
    entry(b"cache-control", b"no-store"),
    entry(b"cache-control", b"public, max-age=31536000"),
    entry(b"content-encoding", b"br"),
    entry(b"content-encoding", b"gzip"),
    entry(b"content-type", b"application/dns-message"),
    entry(b"content-type", b"application/javascript"),
    entry(b"content-type", b"application/json"),
    entry(b"content-type", b"application/x-www-form-urlencoded"),
    entry(b"content-type", b"image/gif"),
    entry(b"content-type", b"image/jpeg"),
    entry(b"content-type", b"image/png"),
    entry(b"content-type", b"text/css"),
    entry(b"content-type", b"text/html; charset=utf-8"),
    entry(b"content-type", b"text/plain"),
    entry(b"content-type", b"text/plain;charset=utf-8"),
    entry(b"range", b"bytes=0-"),
    entry(b"strict-transport-security", b"max-age=31536000"),
    entry(
        b"strict-transport-security",
        b"max-age=31536000; includesubdomains",
    ),
    entry(
        b"strict-transport-security",
        b"max-age=31536000; includesubdomains; preload",
    ),
    entry(b"vary", b"accept-encoding"),
    entry(b"vary", b"origin"),
    entry(b"x-content-type-options", b"nosniff"),
    entry(b"x-xss-protection", b"1; mode=block"),
    entry(b":status", b"100"),
    entry(b":status", b"204"),
    entry(b":status", b"206"),
    entry(b":status", b"302"),
    entry(b":status", b"400"),
    entry(b":status", b"403"),
    entry(b":status", b"421"),
    entry(b":status", b"425"),
    entry(b":status", b"500"),
    entry(b"accept-language", b""),
    entry(b"access-control-allow-credentials", b"FALSE"),
    entry(b"access-control-allow-credentials", b"TRUE"),
    entry(b"access-control-allow-headers", b"*"),
    entry(b"access-control-allow-methods", b"get"),
    entry(b"access-control-allow-methods", b"get, post, options"),
    entry(b"access-control-allow-methods", b"options"),
    entry(b"access-control-expose-headers", b"content-length"),
    entry(b"access-control-request-headers", b"content-type"),
    entry(b"access-control-request-method", b"get"),
    entry(b"access-control-request-method", b"post"),
    entry(b"alt-svc", b"clear"),
    entry(b"authorization", b""),
    entry(
        b"content-security-policy",
        b"script-src 'none'; object-src 'none'; base-uri 'none'",
    ),
    entry(b"early-data", b"1"),
    entry(b"expect-ct", b""),
    entry(b"forwarded", b""),
    entry(b"if-range", b""),
    entry(b"origin", b""),
    entry(b"purpose", b"prefetch"),
    entry(b"server", b""),
    entry(b"timing-allow-origin", b"*"),
    entry(b"upgrade-insecure-requests", b"1"),
    entry(b"user-agent", b""),
    entry(b"x-forwarded-for", b""),
    entry(b"x-frame-options", b"deny"),
    entry(b"x-frame-options", b"sameorigin"),
];

/// The entry at `index`.
///
/// # Arguments
///
/// * `index` - the static table index, as read from the wire.
///
/// # Returns
///
/// The entry, or `None` above 98, which RFC 9204 Section 3.1 makes an invalid
/// static table index.
#[must_use]
pub fn get(index: u64) -> Option<StaticEntry> {
    usize::try_from(index)
        .ok()
        .and_then(|index| STATIC_TABLE.get(index))
        .copied()
}

/// What a field line matched in the static table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Match {
    /// Name and value: the index of the entry.
    Full(u8),
    /// Name only: the lowest index with that name.
    Name(u8),
}

/// The best static match for a field line, by exact octet comparison.
///
/// A full match is preferred; a name match takes the lowest index with that
/// name, the smallest integer and so the fewest octets.
///
/// # Arguments
///
/// * `name` - the field name.
/// * `value` - the field value.
///
/// # Returns
///
/// The match, or `None` when no entry has that name.
#[must_use]
pub fn find(name: &[u8], value: &[u8]) -> Option<Match> {
    let mut by_name = None;
    for (index, entry) in (0u8..).zip(STATIC_TABLE.iter()) {
        if entry.name != name {
            continue;
        }
        if entry.value == value {
            return Some(Match::Full(index));
        }
        if by_name.is_none() {
            by_name = Some(Match::Name(index));
        }
    }
    by_name
}

#[cfg(test)]
mod tests {
    use super::{find, get, Match, StaticEntry, STATIC_TABLE};

    /// RFC 9204 Section 3.1: "Note that the QPACK static table is indexed from
    /// 0, whereas the HPACK static table is indexed from 1." Appendix A lists
    /// the 99 entries.
    #[test]
    fn the_static_table_holds_the_99_appendix_a_entries_indexed_from_zero() {
        assert_eq!(STATIC_TABLE.len(), 99);
        let pinned: [(u64, &[u8], &[u8]); 17] = [
            (0, b":authority", b""),
            (1, b":path", b"/"),
            (17, b":method", b"GET"),
            (25, b":status", b"200"),
            (30, b"accept", b"application/dns-message"),
            (41, b"cache-control", b"public, max-age=31536000"),
            (44, b"content-type", b"application/dns-message"),
            (45, b"content-type", b"application/javascript"),
            (47, b"content-type", b"application/x-www-form-urlencoded"),
            (52, b"content-type", b"text/html; charset=utf-8"),
            (54, b"content-type", b"text/plain;charset=utf-8"),
            (
                57,
                b"strict-transport-security",
                b"max-age=31536000; includesubdomains",
            ),
            (
                58,
                b"strict-transport-security",
                b"max-age=31536000; includesubdomains; preload",
            ),
            (73, b"access-control-allow-credentials", b"FALSE"),
            (74, b"access-control-allow-credentials", b"TRUE"),
            (
                85,
                b"content-security-policy",
                b"script-src 'none'; object-src 'none'; base-uri 'none'",
            ),
            (98, b"x-frame-options", b"sameorigin"),
        ];
        for (index, name, value) in pinned {
            assert_eq!(get(index), Some(StaticEntry { name, value }), "{index}");
        }
        assert_eq!(get(99), None);
        assert_eq!(get(u64::MAX), None);
        let empty = STATIC_TABLE
            .iter()
            .filter(|entry| entry.value.is_empty())
            .count();
        assert_eq!(empty, 21);
        for entry in STATIC_TABLE {
            assert!(!entry.name.is_empty());
            assert!(entry
                .name
                .iter()
                .all(|byte| !byte.is_ascii_uppercase() && byte.is_ascii_graphic()));
        }
    }

    /// RFC 9204 Appendix A: every entry of the static table is found at its
    /// own index; a name and value that match no entry fall back to the lowest
    /// index holding the name, the "field name of an entry in the static
    /// table" a Section 4.5.4 name reference uses.
    #[test]
    fn find_prefers_a_full_match_then_the_lowest_index_with_the_name() {
        assert_eq!(find(b":method", b"GET"), Some(Match::Full(17)));
        assert_eq!(find(b":method", b"PATCH"), Some(Match::Name(15)));
        assert_eq!(find(b":path", b"/index.html"), Some(Match::Name(1)));
        assert_eq!(find(b"authorization", b""), Some(Match::Full(84)));
        assert_eq!(find(b"content-type", b"x"), Some(Match::Name(44)));
        assert_eq!(find(b"Content-Type", b"x"), None);
        assert_eq!(find(b"x-custom", b""), None);
        for (index, entry) in (0u8..).zip(STATIC_TABLE) {
            assert_eq!(find(entry.name, entry.value), Some(Match::Full(index)));
        }
    }
}
