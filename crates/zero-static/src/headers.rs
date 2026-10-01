//! The response fields a static route writes besides the validators: the
//! `Cache-Control` of a route (RFC 9111 Section 5.2.2), `Content-Disposition` for a
//! download (RFC 6266 Section 4.3 with the RFC 8187 `ext-value`), and the
//! `Last-Modified` rule of RFC 9110 Section 8.8.2.1.

use zero_date::Decimal;

/// How a route's responses may be cached: the `Cache-Control` directives it sends.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CachePolicy {
    /// `max-age=N`: fresh for `N` seconds (Section 5.2.2.1, the token form).
    pub max_age: Option<u32>,
    /// `no-store`: no cache stores any part of the response (Section 5.2.2.5), for
    /// sensitive paths.
    pub no_store: bool,
    /// `private`: a shared cache does not store the response (Section 5.2.2.7), for
    /// a response that is user-specific.
    pub private: bool,
    /// `public`: the response may be stored by any cache even when it would not be
    /// cacheable by default (Section 5.2.2.9).
    pub public: bool,
    /// `immutable`: the representation will not change while fresh (RFC 8246).
    pub immutable: bool,
}

impl CachePolicy {
    /// Write the field value; empty when no directive applies.
    ///
    /// # Arguments
    ///
    /// * `out` - where the value goes.
    pub fn write(self, out: &mut Vec<u8>) {
        let separate = |out: &mut Vec<u8>| {
            if !out.is_empty() {
                out.extend_from_slice(b", ");
            }
        };
        if self.no_store {
            separate(out);
            out.extend_from_slice(b"no-store");
        }
        if self.private {
            separate(out);
            out.extend_from_slice(b"private");
        }
        if self.public {
            separate(out);
            out.extend_from_slice(b"public");
        }
        if let Some(seconds) = self.max_age {
            separate(out);
            out.extend_from_slice(b"max-age=");
            out.extend_from_slice(Decimal::new(u64::from(seconds)).as_bytes());
        }
        if self.immutable {
            separate(out);
            out.extend_from_slice(b"immutable");
        }
    }

    /// Whether any directive is set.
    #[must_use]
    pub const fn is_set(self) -> bool {
        self.no_store || self.private || self.public || self.max_age.is_some() || self.immutable
    }
}

/// `attr-char` of RFC 8187 Section 3.2.1: `ALPHA / DIGIT / "!" / "#" / "$" / "&" /
/// "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"`.
const fn is_attr_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
        )
}

/// The last path segment of a name, with control characters and the quote and
/// backslash of the quoted-string form dropped, so a client never sees a path.
fn file_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// Write a `Content-Disposition: attachment` value for `name`: a `filename`
/// parameter every user agent reads, with the name's non-ASCII characters replaced
/// by `_`, and a `filename*` parameter with the UTF-8 `ext-value` of RFC 8187 when
/// the name has a character outside ASCII (RFC 6266 Section 4.3 and Appendix D).
///
/// # Arguments
///
/// * `out` - where the value goes.
/// * `name` - the file name the client should save under; only its last path
///   segment is used.
pub fn write_attachment(out: &mut Vec<u8>, name: &str) {
    let name = file_name(name);
    out.extend_from_slice(b"attachment; filename=\"");
    let mut non_ascii = false;
    for ch in name.chars() {
        match ch {
            '"' | '\\' => {
                out.push(b'\\');
                out.push(ch as u8);
            }
            ch if ch.is_ascii_control() => {}
            ch if ch.is_ascii() => out.push(ch as u8),
            _ => {
                non_ascii = true;
                out.push(b'_');
            }
        }
    }
    out.push(b'"');
    if !non_ascii {
        return;
    }
    out.extend_from_slice(b"; filename*=UTF-8''");
    for &byte in name.as_bytes() {
        if is_attr_char(byte) {
            out.push(byte);
        } else if byte.is_ascii_control() {
        } else {
            out.push(b'%');
            out.push(HEX[usize::from(byte >> 4)]);
            out.push(HEX[usize::from(byte & 0x0F)]);
        }
    }
}

const HEX: [u8; 16] = *b"0123456789ABCDEF";

/// The `Last-Modified` value to send for a modification time: never later than the
/// response's `Date`, so a time in the future is replaced by `now` (RFC 9110
/// Section 8.8.2.1: "the origin server MUST replace that value with the message
/// origination date").
///
/// # Arguments
///
/// * `modified` - the file's modification time as a unix timestamp.
/// * `now` - the response's `Date` as a unix timestamp.
#[must_use]
pub const fn last_modified_for(modified: u64, now: u64) -> u64 {
    if modified > now {
        now
    } else {
        modified
    }
}
