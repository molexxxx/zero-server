//! Field names, field values and the bounded `Fields` list.
//!
//! RFC 9110 Section 5.1 defines a field name as a case-insensitive token,
//! Section 5.6.2 the token grammar, and Section 5.5 the field value: visible
//! US-ASCII and obs-text with interior SP and HTAB, no leading or trailing
//! whitespace, and never CR, LF or NUL. A `Fields` list holds pairs in
//! arrival order and looks names up by linear scan, never a hash map, so an
//! attacker who controls the names cannot degrade a lookup past the cost the
//! caller already budgets for.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.2>

use alloc::format;
use alloc::vec::Vec;
use core::fmt;

use zero_core::Error;

use crate::header::HeaderName;

/// Returns `true` for a `tchar` of RFC 9110 Section 5.6.2: any visible
/// US-ASCII character except the delimiters `"(),/:;<=>?@[\]{}`.
#[must_use]
pub const fn is_tchar(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z'
    )
}

/// Returns `true` when `bytes` is a `token`: one or more `tchar`.
#[must_use]
pub fn is_token(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes.iter().all(|byte| is_tchar(*byte))
}

/// Returns `true` for a `field-vchar`: `VCHAR` (0x21 to 0x7E) or `obs-text`
/// (0x80 to 0xFF).
#[must_use]
pub const fn is_field_vchar(byte: u8) -> bool {
    matches!(byte, 0x21..=0x7E | 0x80..=0xFF)
}

/// Why a field name or value was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldError {
    /// The name is empty.
    EmptyName,
    /// The name holds a byte that is not a `tchar`, at this offset.
    InvalidNameByte(usize),
    /// The value starts or ends with SP or HTAB.
    EdgeWhitespace,
    /// The value holds a byte that is neither `field-vchar`, SP nor HTAB, at
    /// this offset; CR, LF and NUL are the dangerous cases.
    InvalidValueByte(usize),
    /// The list already holds its maximum number of fields.
    TooMany(usize),
}

impl fmt::Display for FieldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyName => f.write_str("field name is empty"),
            Self::InvalidNameByte(at) => {
                write!(f, "field name holds a non-token byte at offset {at}")
            }
            Self::EdgeWhitespace => f.write_str("field value starts or ends with whitespace"),
            Self::InvalidValueByte(at) => {
                write!(f, "field value holds an invalid byte at offset {at}")
            }
            Self::TooMany(max) => write!(f, "field list already holds {max} fields"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for FieldError {}

impl From<FieldError> for Error {
    fn from(error: FieldError) -> Self {
        match error {
            FieldError::TooMany(max) => Self::Limit(format!("{error} (limit {max})")),
            _ => Self::Protocol(format!("{error}")),
        }
    }
}

/// Checks a field name against the token grammar.
///
/// # Arguments
///
/// * `name` - the name as received or as a caller wrote it.
///
/// # Errors
///
/// Returns [`FieldError::EmptyName`] or [`FieldError::InvalidNameByte`].
pub fn validate_field_name(name: &[u8]) -> Result<(), FieldError> {
    if name.is_empty() {
        return Err(FieldError::EmptyName);
    }
    match name.iter().position(|byte| !is_tchar(*byte)) {
        Some(at) => Err(FieldError::InvalidNameByte(at)),
        None => Ok(()),
    }
}

/// Checks a field value against the `field-value` grammar of Section 5.5:
/// `field-vchar` with interior SP and HTAB, no whitespace at either end, and
/// never CR, LF, NUL or another control character.
///
/// # Arguments
///
/// * `value` - the value as received or as a caller wrote it; empty is valid.
///
/// # Errors
///
/// Returns [`FieldError::EdgeWhitespace`] or [`FieldError::InvalidValueByte`].
pub fn validate_field_value(value: &[u8]) -> Result<(), FieldError> {
    let edge = |byte: &u8| matches!(byte, b' ' | b'\t');
    if value.first().is_some_and(edge) || value.last().is_some_and(edge) {
        return Err(FieldError::EdgeWhitespace);
    }
    match value
        .iter()
        .position(|byte| !(is_field_vchar(*byte) || edge(byte)))
    {
        Some(at) => Err(FieldError::InvalidValueByte(at)),
        None => Ok(()),
    }
}

/// A field name: an interned id when the table knows it, otherwise the token
/// as received.
#[derive(Clone, Debug)]
pub enum Name {
    /// A name from the interned table.
    Known(HeaderName),
    /// Any other valid token.
    Other(Vec<u8>),
}

impl Name {
    /// Parses and interns a field name.
    ///
    /// # Arguments
    ///
    /// * `name` - the name as received; its case is kept for `Other`.
    ///
    /// # Errors
    ///
    /// Returns the [`FieldError`] of [`validate_field_name`].
    pub fn parse(name: &[u8]) -> Result<Self, FieldError> {
        validate_field_name(name)?;
        Ok(HeaderName::parse(name).map_or_else(|| Self::Other(name.to_vec()), Self::Known))
    }

    /// Returns the name's bytes: the lowercase table spelling for a known
    /// name, the received spelling otherwise.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Known(name) => name.as_bytes(),
            Self::Other(bytes) => bytes,
        }
    }

    /// Returns the interned id, if the table knows the name.
    #[must_use]
    pub const fn id(&self) -> Option<HeaderName> {
        match self {
            Self::Known(name) => Some(*name),
            Self::Other(_) => None,
        }
    }

    /// Compares with another spelling, case-insensitively.
    ///
    /// # Arguments
    ///
    /// * `other` - the spelling to compare with.
    #[must_use]
    pub fn matches(&self, other: &[u8]) -> bool {
        self.as_bytes().eq_ignore_ascii_case(other)
    }
}

impl PartialEq for Name {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Known(left), Self::Known(right)) => left == right,
            _ => self.matches(other.as_bytes()),
        }
    }
}

impl Eq for Name {}

impl From<HeaderName> for Name {
    fn from(name: HeaderName) -> Self {
        Self::Known(name)
    }
}

/// A bounded list of fields in arrival order, looked up by linear scan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fields {
    entries: Vec<(Name, Vec<u8>)>,
    max: usize,
}

impl Fields {
    /// Creates an empty list that holds at most `max` fields.
    ///
    /// # Arguments
    ///
    /// * `max` - the number of fields the list accepts.
    #[must_use]
    pub const fn with_max(max: usize) -> Self {
        Self {
            entries: Vec::new(),
            max,
        }
    }

    /// Returns the number of fields the list accepts.
    #[must_use]
    pub const fn max(&self) -> usize {
        self.max
    }

    /// Returns the number of fields.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns `true` when the list holds no field.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Appends a field after validating its value.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// Returns [`FieldError::TooMany`] when the list is full, and the error
    /// of [`validate_field_value`] when the value is malformed; the list is
    /// unchanged in both cases.
    pub fn insert(&mut self, name: impl Into<Name>, value: &[u8]) -> Result<(), FieldError> {
        if self.entries.len() >= self.max {
            return Err(FieldError::TooMany(self.max));
        }
        validate_field_value(value)?;
        self.entries.push((name.into(), value.to_vec()));
        Ok(())
    }

    /// Parses a name and appends the field.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name as received.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// Returns the errors of [`Name::parse`] and [`Fields::insert`].
    pub fn insert_bytes(&mut self, name: &[u8], value: &[u8]) -> Result<(), FieldError> {
        let name = Name::parse(name)?;
        self.insert(name, value)
    }

    /// Removes every field with this name, then appends the pair.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// Returns the errors of [`Fields::insert`]; the removal still happened.
    pub fn set(&mut self, name: impl Into<Name>, value: &[u8]) -> Result<(), FieldError> {
        let name = name.into();
        self.remove(name.as_bytes());
        self.insert(name, value)
    }

    /// Returns the value of the first field with this name, compared
    /// case-insensitively.
    ///
    /// # Arguments
    ///
    /// * `name` - the name in any case.
    #[must_use]
    pub fn get(&self, name: &[u8]) -> Option<&[u8]> {
        self.iter()
            .find(|(field, _)| field.matches(name))
            .map(|(_, value)| value)
    }

    /// Returns the value of the first field with this interned name.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned name.
    #[must_use]
    pub fn get_known(&self, name: HeaderName) -> Option<&[u8]> {
        self.iter()
            .find(|(field, _)| field.id() == Some(name))
            .map(|(_, value)| value)
    }

    /// Returns the values of every field with this name, in arrival order.
    ///
    /// # Arguments
    ///
    /// * `name` - the name in any case.
    pub fn get_all<'a>(&'a self, name: &'a [u8]) -> impl Iterator<Item = &'a [u8]> + 'a {
        self.iter()
            .filter(move |(field, _)| field.matches(name))
            .map(|(_, value)| value)
    }

    /// Returns `true` when a field with this name is present.
    ///
    /// # Arguments
    ///
    /// * `name` - the name in any case.
    #[must_use]
    pub fn contains(&self, name: &[u8]) -> bool {
        self.get(name).is_some()
    }

    /// Removes every field with this name.
    ///
    /// # Arguments
    ///
    /// * `name` - the name in any case.
    ///
    /// # Returns
    ///
    /// The number of fields removed.
    pub fn remove(&mut self, name: &[u8]) -> usize {
        let before = self.entries.len();
        self.entries.retain(|(field, _)| !field.matches(name));
        before.saturating_sub(self.entries.len())
    }

    /// Removes every field.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Iterates over the fields in arrival order.
    pub fn iter(&self) -> impl Iterator<Item = (&Name, &[u8])> + '_ {
        self.entries
            .iter()
            .map(|(name, value)| (name, value.as_slice()))
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        is_field_vchar, is_tchar, is_token, validate_field_name, validate_field_value, FieldError,
        Fields, Name,
    };
    use crate::header::HeaderName;
    use zero_core::Error;

    #[test]
    fn tchar_is_every_visible_ascii_byte_except_the_delimiters() {
        let delimiters = b"\"(),/:;<=>?@[\\]{}";
        for byte in 0u8..=255 {
            let visible = (0x21..=0x7E).contains(&byte);
            let expected = visible && !delimiters.contains(&byte);
            assert_eq!(is_tchar(byte), expected, "byte {byte:#04x}");
        }
        assert!(is_token(b"Content-Length"));
        assert!(is_token(b"!#$%&'*+-.^_`|~09AZaz"));
        assert!(!is_token(b""));
        assert!(!is_token(b"Content Length"));
        assert!(!is_token("ünicode".as_bytes()));
    }

    #[test]
    fn field_names_are_tokens() {
        assert_eq!(validate_field_name(b"Host"), Ok(()));
        assert_eq!(validate_field_name(b""), Err(FieldError::EmptyName));
        assert_eq!(
            validate_field_name(b"Host :"),
            Err(FieldError::InvalidNameByte(4))
        );
        assert_eq!(
            validate_field_name(b"X\r\nInjected"),
            Err(FieldError::InvalidNameByte(1))
        );
    }

    #[test]
    fn field_values_follow_section_5_5() {
        assert_eq!(validate_field_value(b""), Ok(()));
        assert_eq!(validate_field_value(b"text/html; charset=utf-8"), Ok(()));
        assert_eq!(validate_field_value(b"a\tb"), Ok(()));
        assert_eq!(validate_field_value(b"obs-text \xFF"), Ok(()));
        assert_eq!(validate_field_value(b" x"), Err(FieldError::EdgeWhitespace));
        assert_eq!(
            validate_field_value(b"x\t"),
            Err(FieldError::EdgeWhitespace)
        );
        assert_eq!(validate_field_value(b" "), Err(FieldError::EdgeWhitespace));
        assert_eq!(
            validate_field_value(b"a\r\nSet-Cookie: x"),
            Err(FieldError::InvalidValueByte(1))
        );
        assert_eq!(
            validate_field_value(b"a\nb"),
            Err(FieldError::InvalidValueByte(1))
        );
        assert_eq!(
            validate_field_value(b"a\0b"),
            Err(FieldError::InvalidValueByte(1))
        );
        assert_eq!(
            validate_field_value(b"a\x7Fb"),
            Err(FieldError::InvalidValueByte(1))
        );
        for byte in 0u8..=255 {
            let expected = (0x21..=0x7E).contains(&byte) || byte >= 0x80;
            assert_eq!(is_field_vchar(byte), expected, "byte {byte:#04x}");
        }
    }

    #[test]
    fn names_intern_the_table_and_keep_other_spellings() {
        let known = Name::parse(b"CONTENT-length").ok();
        assert_eq!(known, Some(Name::Known(HeaderName::ContentLength)));
        assert_eq!(
            known.as_ref().map(Name::as_bytes),
            Some(&b"content-length"[..])
        );
        let other = Name::parse(b"X-Request-Id").ok();
        assert_eq!(other.as_ref().and_then(Name::id), None);
        assert_eq!(
            other.as_ref().map(Name::as_bytes),
            Some(&b"X-Request-Id"[..])
        );
        assert_eq!(other, Name::parse(b"x-request-id").ok());
        assert_ne!(other, known);
        assert_eq!(
            Name::parse(b"bad name"),
            Err(FieldError::InvalidNameByte(3))
        );
    }

    #[test]
    fn field_names_are_compared_case_insensitively_on_lookup_and_set() {
        let mut fields = Fields::with_max(8);
        assert!(fields.insert_bytes(b"Content-Type", b"text/plain").is_ok());
        assert!(fields.insert_bytes(b"X-Custom", b"one").is_ok());
        assert!(fields.insert_bytes(b"x-custom", b"two").is_ok());
        assert_eq!(fields.get(b"content-type"), Some(&b"text/plain"[..]));
        assert_eq!(fields.get(b"CONTENT-TYPE"), Some(&b"text/plain"[..]));
        assert_eq!(
            fields.get_known(HeaderName::ContentType),
            Some(&b"text/plain"[..])
        );
        assert_eq!(fields.get(b"X-CUSTOM"), Some(&b"one"[..]));
        let all: Vec<&[u8]> = fields.get_all(b"X-Custom").collect();
        assert_eq!(all, [&b"one"[..], &b"two"[..]]);
        assert!(fields.set(HeaderName::ContentType, b"text/html").is_ok());
        assert_eq!(fields.len(), 3);
        assert_eq!(fields.get(b"Content-Type"), Some(&b"text/html"[..]));
        assert_eq!(fields.remove(b"x-CUSTOM"), 2);
        assert!(!fields.contains(b"X-Custom"));
        assert_eq!(fields.len(), 1);
        fields.clear();
        assert!(fields.is_empty());
    }

    #[test]
    fn the_list_is_bounded_and_validates_values() {
        let mut fields = Fields::with_max(2);
        assert_eq!(fields.max(), 2);
        assert!(fields.insert(HeaderName::Host, b"example.com").is_ok());
        assert_eq!(
            fields.insert(HeaderName::Date, b"bad\r\n"),
            Err(FieldError::InvalidValueByte(3))
        );
        assert!(fields.insert(HeaderName::Date, b"").is_ok());
        assert_eq!(
            fields.insert(HeaderName::Server, b"zero"),
            Err(FieldError::TooMany(2))
        );
        assert_eq!(fields.len(), 2);
        let order: Vec<&[u8]> = fields.iter().map(|(name, _)| name.as_bytes()).collect();
        assert_eq!(order, [&b"host"[..], &b"date"[..]]);
    }

    #[test]
    fn errors_map_onto_the_core_error_model() {
        assert!(matches!(
            Error::from(FieldError::TooMany(64)),
            Error::Limit(_)
        ));
        assert!(matches!(
            Error::from(FieldError::EdgeWhitespace),
            Error::Protocol(_)
        ));
        assert_eq!(
            alloc::format!("{}", FieldError::InvalidValueByte(7)),
            "field value holds an invalid byte at offset 7"
        );
    }
}
