//! HTML escaping for text rendered into a document.
//!
//! The five replacements are the HTML entity encoding of the OWASP Cross Site
//! Scripting Prevention Cheat Sheet (`&`, `<`, `>`, `"` and `'`), which
//! contains the four the HTML standard's "escaping a string" algorithm makes
//! in attribute mode, so one escaped value is safe both as element content and
//! inside a double- or single-quoted attribute.
//!
//! @see <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html#output-encoding-for-html-contexts>
//! @see <https://html.spec.whatwg.org/multipage/parsing.html#escapingString>

use alloc::string::String;
use alloc::vec::Vec;

/// Returns the entity that replaces a byte, or `None` when the byte passes
/// through unchanged.
#[must_use]
pub const fn html_entity(byte: u8) -> Option<&'static [u8]> {
    match byte {
        b'&' => Some(b"&amp;"),
        b'<' => Some(b"&lt;"),
        b'>' => Some(b"&gt;"),
        b'"' => Some(b"&quot;"),
        b'\'' => Some(b"&#x27;"),
        _ => None,
    }
}

/// Appends `input` to `out` with every `&`, `<`, `>`, `"` and `'` replaced by
/// its entity; every other byte, including multi-byte UTF-8, is copied as is.
///
/// # Arguments
///
/// * `input` - the text to escape.
/// * `out` - the buffer that receives the escaped text.
pub fn escape_html_into(input: &[u8], out: &mut Vec<u8>) {
    let mut copied_to = 0;
    for (index, byte) in input.iter().enumerate() {
        if let Some(entity) = html_entity(*byte) {
            out.extend_from_slice(input.get(copied_to..index).unwrap_or(&[]));
            out.extend_from_slice(entity);
            copied_to = index.saturating_add(1);
        }
    }
    out.extend_from_slice(input.get(copied_to..).unwrap_or(&[]));
}

/// Returns `input` with every `&`, `<`, `>`, `"` and `'` replaced by its
/// entity.
///
/// # Arguments
///
/// * `input` - the text to escape.
#[must_use]
pub fn escape_html(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    escape_html_into(input.as_bytes(), &mut out);
    // Only ASCII bytes were replaced, by ASCII entities, so the text is still
    // UTF-8.
    String::from_utf8(out).unwrap_or_default()
}

/// Returns `true` when `input` contains no byte that escaping would replace.
///
/// # Arguments
///
/// * `input` - the text to inspect.
#[must_use]
pub fn is_html_safe(input: &[u8]) -> bool {
    input.iter().all(|byte| html_entity(*byte).is_none())
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{escape_html, escape_html_into, is_html_safe};

    #[test]
    fn the_five_characters_become_their_entities() {
        assert_eq!(escape_html("&<>\"'"), "&amp;&lt;&gt;&quot;&#x27;");
        assert_eq!(
            escape_html("<script>alert(\"x\");</script>"),
            "&lt;script&gt;alert(&quot;x&quot;);&lt;/script&gt;"
        );
    }

    #[test]
    fn everything_else_passes_through() {
        let text = "fortune: déjà vu, 日本語, tab\t and newline\n";
        assert_eq!(escape_html(text), text);
        assert!(is_html_safe(text.as_bytes()));
        assert!(!is_html_safe(b"a&b"));
        assert_eq!(escape_html(""), "");
    }

    #[test]
    fn escaping_is_appended_to_the_buffer() {
        let mut out = Vec::from(&b"<p>"[..]);
        escape_html_into(b"a < b", &mut out);
        assert_eq!(out, b"<p>a &lt; b");
    }

    #[test]
    fn an_already_escaped_value_is_escaped_again() {
        assert_eq!(escape_html("&amp;"), "&amp;amp;");
    }
}
