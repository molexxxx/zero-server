//! The strict parser.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use zero_core::{Error, Value};

use crate::MAX_SAFE_INTEGER;

/// The default nesting cap.
pub const DEFAULT_DEPTH: usize = 64;

/// The default size cap: one mebibyte, the request body default.
pub const DEFAULT_SIZE: usize = 1_048_576;

/// The nesting cap no option raises, which bounds the parser's recursion.
pub const DEPTH_CAP: usize = 256;

/// What a text may be at the top level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopLevel {
    /// Any value, as RFC 8259 Section 2 allows.
    Any,
    /// An object or an array only, the older restriction some callers want.
    ObjectOrArray,
}

/// What becomes of an integer a binary64 cannot hold exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BigIntegers {
    /// Integers that fit an `i64` are exact; larger ones become floats, which is
    /// lossy.
    Lossy,
    /// Integers outside `[-(2^53 - 1), 2^53 - 1]` are kept as strings of their
    /// digits, for a consumer that turns them into a big integer.
    Strings,
}

/// The parser's settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    /// The most input bytes accepted.
    pub max_size: usize,
    /// The deepest nesting accepted, at most [`DEPTH_CAP`].
    pub max_depth: usize,
    /// What the top-level value may be.
    pub top_level: TopLevel,
    /// What becomes of large integers.
    pub big_integers: BigIntegers,
}

impl Options {
    /// The defaults: [`DEFAULT_SIZE`], [`DEFAULT_DEPTH`], any top-level value,
    /// lossy large integers.
    pub const DEFAULT: Self = Options {
        max_size: DEFAULT_SIZE,
        max_depth: DEFAULT_DEPTH,
        top_level: TopLevel::Any,
        big_integers: BigIntegers::Lossy,
    };
}

impl Default for Options {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// What was wrong with the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The input is longer than the size cap.
    TooLarge,
    /// Containers nest deeper than the cap.
    TooDeep,
    /// The text ends inside a value.
    UnexpectedEnd,
    /// A byte the grammar does not allow here.
    UnexpectedByte,
    /// A number outside the grammar, or one that is not finite.
    InvalidNumber,
    /// A reverse solidus followed by something that is not an escape.
    InvalidEscape,
    /// A string whose bytes are not UTF-8.
    InvalidUtf8,
    /// A control character below U+0020 inside a string, unescaped.
    ControlCharacter,
    /// A `\u` escape that is one half of a surrogate pair without the other.
    LoneSurrogate,
    /// Bytes after the value that are not whitespace.
    TrailingBytes,
    /// A top-level value that is not an object or array when one is required.
    NotObjectOrArray,
}

/// A refused text: what was wrong and where.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseError {
    /// What was wrong.
    pub kind: ErrorKind,
    /// The byte offset it was found at.
    pub offset: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let what = match self.kind {
            ErrorKind::TooLarge => "the text is larger than the limit",
            ErrorKind::TooDeep => "the nesting is deeper than the limit",
            ErrorKind::UnexpectedEnd => "the text ends inside a value",
            ErrorKind::UnexpectedByte => "unexpected byte",
            ErrorKind::InvalidNumber => "invalid number",
            ErrorKind::InvalidEscape => "invalid escape",
            ErrorKind::InvalidUtf8 => "a string is not UTF-8",
            ErrorKind::ControlCharacter => "an unescaped control character in a string",
            ErrorKind::LoneSurrogate => "a lone surrogate escape",
            ErrorKind::TrailingBytes => "bytes after the value",
            ErrorKind::NotObjectOrArray => "the top-level value is not an object or array",
        };
        write!(f, "{what} at offset {}", self.offset)
    }
}

impl From<ParseError> for Error {
    fn from(error: ParseError) -> Self {
        match error.kind {
            ErrorKind::TooLarge | ErrorKind::TooDeep => {
                Error::Limit(alloc::format!("json: {error}"))
            }
            _ => Error::Codec(alloc::format!("json: {error}")),
        }
    }
}

/// Parse a text with the default options.
///
/// # Arguments
///
/// * `input` - the text, UTF-8, with or without a leading byte order mark.
///
/// # Errors
///
/// [`ParseError`] for a text outside the grammar or the limits.
pub fn parse(input: &[u8]) -> Result<Value, ParseError> {
    parse_with(input, &Options::DEFAULT)
}

/// Parse a text.
///
/// # Arguments
///
/// * `input` - the text, UTF-8, with or without a leading byte order mark, which
///   is ignored (RFC 8259 Section 8.1).
/// * `options` - the limits and modes.
///
/// # Errors
///
/// [`ParseError`] for a text outside the grammar or the limits.
pub fn parse_with(input: &[u8], options: &Options) -> Result<Value, ParseError> {
    if input.len() > options.max_size {
        return Err(ParseError {
            kind: ErrorKind::TooLarge,
            offset: 0,
        });
    }
    let mut parser = Parser {
        input,
        at: 0,
        depth: 0,
        max_depth: options.max_depth.min(DEPTH_CAP),
        big_integers: options.big_integers,
    };
    if input.starts_with(b"\xEF\xBB\xBF") {
        parser.at = 3;
    }
    parser.skip_ws();
    let value = parser.value()?;
    parser.skip_ws();
    if parser.at < input.len() {
        return Err(parser.error(ErrorKind::TrailingBytes));
    }
    if options.top_level == TopLevel::ObjectOrArray
        && !matches!(value, Value::Object(_) | Value::Array(_))
    {
        return Err(ParseError {
            kind: ErrorKind::NotObjectOrArray,
            offset: 0,
        });
    }
    Ok(value)
}

struct Parser<'a> {
    input: &'a [u8],
    at: usize,
    depth: usize,
    max_depth: usize,
    big_integers: BigIntegers,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.input.get(self.at).copied()
    }

    fn error(&self, kind: ErrorKind) -> ParseError {
        ParseError {
            kind,
            offset: self.at,
        }
    }

    fn end_or(&self, kind: ErrorKind) -> ParseError {
        if self.at >= self.input.len() {
            self.error(ErrorKind::UnexpectedEnd)
        } else {
            self.error(kind)
        }
    }

    /// RFC 8259 Section 2 `ws`.
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at = self.at.saturating_add(1);
        }
    }

    fn value(&mut self) -> Result<Value, ParseError> {
        match self.peek() {
            None => Err(self.error(ErrorKind::UnexpectedEnd)),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Value::Str),
            Some(b't') => self.literal(b"true", Value::Bool(true)),
            Some(b'f') => self.literal(b"false", Value::Bool(false)),
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error(ErrorKind::UnexpectedByte)),
        }
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth = self.depth.saturating_add(1);
        if self.depth > self.max_depth {
            return Err(self.error(ErrorKind::TooDeep));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn object(&mut self) -> Result<Value, ParseError> {
        self.enter()?;
        self.at = self.at.saturating_add(1);
        let mut members: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.at = self.at.saturating_add(1);
            self.leave();
            return Ok(Value::Object(members));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(self.end_or(ErrorKind::UnexpectedByte));
            }
            let name = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(self.end_or(ErrorKind::UnexpectedByte));
            }
            self.at = self.at.saturating_add(1);
            self.skip_ws();
            let value = self.value()?;
            // A repeated name keeps the first member's place with the last value,
            // which is what JavaScript's JSON.parse observably does.
            match members.iter_mut().find(|(existing, _)| *existing == name) {
                Some(member) => member.1 = value,
                None => members.push((name, value)),
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at = self.at.saturating_add(1),
                Some(b'}') => {
                    self.at = self.at.saturating_add(1);
                    break;
                }
                _ => return Err(self.end_or(ErrorKind::UnexpectedByte)),
            }
        }
        self.leave();
        Ok(Value::Object(members))
    }

    fn array(&mut self) -> Result<Value, ParseError> {
        self.enter()?;
        self.at = self.at.saturating_add(1);
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.at = self.at.saturating_add(1);
            self.leave();
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at = self.at.saturating_add(1),
                Some(b']') => {
                    self.at = self.at.saturating_add(1);
                    break;
                }
                _ => return Err(self.end_or(ErrorKind::UnexpectedByte)),
            }
        }
        self.leave();
        Ok(Value::Array(items))
    }

    /// One of the three literal names, lowercase only (RFC 8259 Section 3).
    fn literal(&mut self, word: &[u8], value: Value) -> Result<Value, ParseError> {
        let rest = self.input.get(self.at..).unwrap_or(&[]);
        if rest.starts_with(word) {
            self.at = self.at.saturating_add(word.len());
            return Ok(value);
        }
        let matching = rest.iter().zip(word).take_while(|(a, b)| a == b).count();
        self.at = self.at.saturating_add(matching);
        Err(self.end_or(ErrorKind::UnexpectedByte))
    }

    /// `number = [ minus ] int [ frac ] [ exp ]` (RFC 8259 Section 6).
    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.at;
        let mut at = self.at;
        let byte_at = |at: usize| self.input.get(at).copied();
        if byte_at(at) == Some(b'-') {
            at = at.saturating_add(1);
        }
        match byte_at(at) {
            Some(b'0') => at = at.saturating_add(1),
            Some(b'1'..=b'9') => {
                while matches!(byte_at(at), Some(b'0'..=b'9')) {
                    at = at.saturating_add(1);
                }
            }
            _ => {
                self.at = at;
                return Err(self.end_or(ErrorKind::InvalidNumber));
            }
        }
        let mut is_float = false;
        if byte_at(at) == Some(b'.') {
            at = at.saturating_add(1);
            if !matches!(byte_at(at), Some(b'0'..=b'9')) {
                self.at = at;
                return Err(self.end_or(ErrorKind::InvalidNumber));
            }
            while matches!(byte_at(at), Some(b'0'..=b'9')) {
                at = at.saturating_add(1);
            }
            is_float = true;
        }
        if matches!(byte_at(at), Some(b'e' | b'E')) {
            at = at.saturating_add(1);
            if matches!(byte_at(at), Some(b'+' | b'-')) {
                at = at.saturating_add(1);
            }
            if !matches!(byte_at(at), Some(b'0'..=b'9')) {
                self.at = at;
                return Err(self.end_or(ErrorKind::InvalidNumber));
            }
            while matches!(byte_at(at), Some(b'0'..=b'9')) {
                at = at.saturating_add(1);
            }
            is_float = true;
        }
        let literal = self.input.get(start..at).unwrap_or(&[]);
        self.at = at;
        // The grammar admits ASCII only, so the bytes are a string.
        let text =
            core::str::from_utf8(literal).map_err(|_| self.error(ErrorKind::InvalidNumber))?;
        if !is_float {
            if let Some(integer) = parse_i64(literal) {
                let safe = (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer);
                return Ok(match self.big_integers {
                    BigIntegers::Strings if !safe => Value::Str(String::from(text)),
                    _ => Value::Int(integer),
                });
            }
            if self.big_integers == BigIntegers::Strings {
                return Ok(Value::Str(String::from(text)));
            }
        }
        let float: f64 = text
            .parse()
            .map_err(|_| self.error(ErrorKind::InvalidNumber))?;
        if !float.is_finite() {
            self.at = start;
            return Err(self.error(ErrorKind::InvalidNumber));
        }
        Ok(Value::Float(float))
    }

    /// `string = quotation-mark *char quotation-mark` (RFC 8259 Section 7), decoded
    /// as UTF-8 (Section 8.1).
    fn string(&mut self) -> Result<String, ParseError> {
        let start = self.at;
        self.at = self.at.saturating_add(1);
        let mut out: Vec<u8> = Vec::new();
        loop {
            match self.peek() {
                None => return Err(self.error(ErrorKind::UnexpectedEnd)),
                Some(b'"') => {
                    self.at = self.at.saturating_add(1);
                    break;
                }
                Some(b'\\') => self.escape(&mut out)?,
                Some(byte) if byte < 0x20 => {
                    return Err(self.error(ErrorKind::ControlCharacter));
                }
                Some(byte) => {
                    out.push(byte);
                    self.at = self.at.saturating_add(1);
                }
            }
        }
        String::from_utf8(out).map_err(|_| ParseError {
            kind: ErrorKind::InvalidUtf8,
            offset: start,
        })
    }

    /// One escape, with `self.at` on the reverse solidus.
    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), ParseError> {
        let escape_at = self.at;
        self.at = self.at.saturating_add(1);
        let Some(kind) = self.peek() else {
            return Err(self.error(ErrorKind::UnexpectedEnd));
        };
        self.at = self.at.saturating_add(1);
        let byte = match kind {
            b'"' => b'"',
            b'\\' => b'\\',
            b'/' => b'/',
            b'b' => 0x08,
            b'f' => 0x0C,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'u' => {
                let unit = self.hex4()?;
                let code = match unit {
                    0xD800..=0xDBFF => {
                        let rest = self.input.get(self.at..).unwrap_or(&[]);
                        if !rest.starts_with(b"\\u") {
                            self.at = escape_at;
                            return Err(self.error(ErrorKind::LoneSurrogate));
                        }
                        self.at = self.at.saturating_add(2);
                        let low = self.hex4()?;
                        if !(0xDC00..=0xDFFF).contains(&low) {
                            self.at = escape_at;
                            return Err(self.error(ErrorKind::LoneSurrogate));
                        }
                        let high = u32::from(unit.wrapping_sub(0xD800)).wrapping_shl(10);
                        0x10000u32
                            .wrapping_add(high)
                            .wrapping_add(u32::from(low.wrapping_sub(0xDC00)))
                    }
                    0xDC00..=0xDFFF => {
                        self.at = escape_at;
                        return Err(self.error(ErrorKind::LoneSurrogate));
                    }
                    _ => u32::from(unit),
                };
                let character = char::from_u32(code).ok_or(ParseError {
                    kind: ErrorKind::LoneSurrogate,
                    offset: escape_at,
                })?;
                let mut buffer = [0u8; 4];
                out.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
                return Ok(());
            }
            _ => {
                self.at = escape_at;
                return Err(self.error(ErrorKind::InvalidEscape));
            }
        };
        out.push(byte);
        Ok(())
    }

    /// Four hexadecimal digits, in either case.
    fn hex4(&mut self) -> Result<u16, ParseError> {
        let mut unit = 0u16;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(byte @ b'0'..=b'9') => byte.wrapping_sub(b'0'),
                Some(byte @ b'a'..=b'f') => byte.wrapping_sub(b'a').wrapping_add(10),
                Some(byte @ b'A'..=b'F') => byte.wrapping_sub(b'A').wrapping_add(10),
                _ => return Err(self.end_or(ErrorKind::InvalidEscape)),
            };
            unit = unit.wrapping_shl(4) | u16::from(digit);
            self.at = self.at.saturating_add(1);
        }
        Ok(unit)
    }
}

/// An integer literal as an `i64`, or `None` when it does not fit.
fn parse_i64(literal: &[u8]) -> Option<i64> {
    let (negative, digits) = match literal.split_first() {
        Some((b'-', rest)) => (true, rest),
        _ => (false, literal),
    };
    let mut magnitude = 0u64;
    for &byte in digits {
        let digit = u64::from(byte.wrapping_sub(b'0'));
        magnitude = magnitude.checked_mul(10)?.checked_add(digit)?;
    }
    if negative {
        if magnitude == 1u64.wrapping_shl(63) {
            return Some(i64::MIN);
        }
        i64::try_from(magnitude)
            .ok()
            .map(|value| value.wrapping_neg())
    } else {
        i64::try_from(magnitude).ok()
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::{String, ToString};
    use alloc::vec;

    use super::{parse, parse_with, BigIntegers, ErrorKind, Options, ParseError, TopLevel};
    use crate::write::to_vec;
    use zero_core::{Error, Value};

    fn kind(input: &[u8]) -> Result<Value, ErrorKind> {
        parse(input).map_err(|error| error.kind)
    }

    /// Standards row `body-01`: RFC 8259 Section 2.
    #[test]
    fn the_json_parser_accepts_any_json_value_at_the_top_level_including_strings_numbers_and_null()
    {
        assert_eq!(parse(b"\"s\""), Ok(Value::Str("s".to_string())));
        assert_eq!(parse(b" 12 "), Ok(Value::Int(12)));
        assert_eq!(parse(b"null"), Ok(Value::Null));
        assert_eq!(parse(b"true"), Ok(Value::Bool(true)));
        let strict = Options {
            top_level: TopLevel::ObjectOrArray,
            ..Options::DEFAULT
        };
        assert_eq!(
            parse_with(b"\"s\"", &strict).map_err(|error| error.kind),
            Err(ErrorKind::NotObjectOrArray)
        );
        assert_eq!(
            parse_with(b"[1]", &strict),
            Ok(Value::Array(vec![Value::Int(1)]))
        );
        assert_eq!(parse_with(b"{}", &strict), Ok(Value::Object(vec![])));
    }

    /// Standards row `body-02`: RFC 8259 Section 8.1.
    #[test]
    fn a_leading_byte_order_mark_is_ignored_rather_than_rejected_and_json_responses_never_carry_one(
    ) {
        assert_eq!(parse(b"\xEF\xBB\xBF{}"), Ok(Value::Object(vec![])));
        assert_eq!(kind(b"{}\xEF\xBB\xBF"), Err(ErrorKind::TrailingBytes));
        let written = to_vec(&Value::Str("\u{feff}x".to_string())).unwrap_or_default();
        assert!(!written.starts_with(b"\xEF\xBB\xBF"));
        assert_eq!(written, "\"\u{feff}x\"".as_bytes());
    }

    /// Standards row `body-03`: RFC 8259 Section 8.1.
    #[test]
    fn json_bodies_are_decoded_as_utf_8_regardless_of_a_charset_parameter_since_json_defines_none()
    {
        assert_eq!(parse(b"\"\xC3\xA9\""), Ok(Value::Str("\u{e9}".to_string())));
        assert_eq!(parse(b"\"\\u00e9\""), Ok(Value::Str("\u{e9}".to_string())));
        assert_eq!(
            parse(b"\"\xE9\""),
            Err(ParseError {
                kind: ErrorKind::InvalidUtf8,
                offset: 0
            }),
            "a Latin-1 byte is not decoded as if a charset said so"
        );
        assert_eq!(
            kind(b"\"\xED\xA0\x80\""),
            Err(ErrorKind::InvalidUtf8),
            "an encoded surrogate"
        );
    }

    /// Standards row `body-04`: RFC 8259 Section 4.
    #[test]
    fn duplicate_member_names_resolve_deterministically_and_a_proto_member_never_alters_the_object()
    {
        let parsed = parse(br#"{"a":1,"b":true,"a":2,"__proto__":{"x":1}}"#);
        let Ok(Value::Object(members)) = parsed else {
            unreachable!("the text is an object: {parsed:?}");
        };
        assert_eq!(members.len(), 3, "the repeated name holds one member");
        assert_eq!(
            members.first().map(|(name, value)| (name.as_str(), value)),
            Some(("a", &Value::Int(2)))
        );
        let value = Value::Object(members);
        assert_eq!(value.get("a"), Some(&Value::Int(2)), "the last value wins");
        assert_eq!(
            value.get("__proto__").and_then(|proto| proto.get("x")),
            Some(&Value::Int(1))
        );
        assert_eq!(value.get("x"), None, "nothing was inherited");
    }

    /// Standards row `body-05`: RFC 8259 Section 7.
    #[test]
    fn unescaped_control_characters_u_0000_through_u_001f_inside_strings_are_rejected() {
        for byte in 0u8..=0x1F {
            let text = [b'"', b'a', byte, b'"'];
            assert_eq!(
                parse(&text),
                Err(ParseError {
                    kind: ErrorKind::ControlCharacter,
                    offset: 2
                }),
                "byte {byte:#04x}"
            );
        }
        assert_eq!(
            parse(b"\"\\u0000\\u001f\\n\""),
            Ok(Value::Str("\u{0}\u{1f}\n".to_string()))
        );
        assert_eq!(
            parse(b"\"\x7f\""),
            Ok(Value::Str("\u{7f}".to_string())),
            "DEL is not a control here"
        );
    }

    /// Standards row `body-06`: RFC 8259 Section 9.
    #[test]
    fn size_and_nesting_depth_limits_are_enforced_and_a_body_over_the_size_limit_is_a_limit_error()
    {
        let small = Options {
            max_size: 10,
            max_depth: 3,
            ..Options::DEFAULT
        };
        let over = parse_with(b"[1,2,3,4,5]", &small);
        assert_eq!(
            over,
            Err(ParseError {
                kind: ErrorKind::TooLarge,
                offset: 0
            })
        );
        assert!(
            matches!(over.map_err(Error::from), Err(Error::Limit(_))),
            "a limit error, which the driver answers 413"
        );
        assert_eq!(
            parse_with(b"[[[1]]]", &small),
            Ok(Value::Array(vec![Value::Array(vec![Value::Array(vec![
                Value::Int(1)
            ])])]))
        );
        assert_eq!(
            parse_with(b"[[[[1]]]]", &small),
            Err(ParseError {
                kind: ErrorKind::TooDeep,
                offset: 3
            })
        );
        let deep: String = "[".repeat(100_000);
        assert_eq!(
            kind(deep.as_bytes()),
            Err(ErrorKind::TooDeep),
            "bounded recursion"
        );
    }

    /// Standards row `body-07`: RFC 8259 Section 6.
    #[test]
    fn integers_outside_2_53_1_2_53_1_are_documented_as_lossy_and_an_opt_in_mode_keeps_them_as_strings(
    ) {
        assert_eq!(
            parse(b"9007199254740991"),
            Ok(Value::Int(9_007_199_254_740_991))
        );
        assert_eq!(
            parse(b"9007199254740993"),
            Ok(Value::Int(9_007_199_254_740_993)),
            "exact in an i64"
        );
        assert_eq!(parse(b"-9223372036854775808"), Ok(Value::Int(i64::MIN)));
        assert_eq!(
            parse(b"18446744073709551616"),
            Ok(Value::Float(18_446_744_073_709_551_616.0)),
            "past an i64 the default is lossy"
        );
        let strings = Options {
            big_integers: BigIntegers::Strings,
            ..Options::DEFAULT
        };
        assert_eq!(
            parse_with(b"9007199254740991", &strings),
            Ok(Value::Int(9_007_199_254_740_991))
        );
        assert_eq!(
            parse_with(b"9007199254740992", &strings),
            Ok(Value::Str("9007199254740992".to_string()))
        );
        assert_eq!(
            parse_with(b"-18446744073709551616", &strings),
            Ok(Value::Str("-18446744073709551616".to_string()))
        );
        assert_eq!(parse_with(b"1.5", &strings), Ok(Value::Float(1.5)));
    }

    #[test]
    fn the_grammar_is_applied_strictly() {
        assert_eq!(kind(b"01"), Err(ErrorKind::TrailingBytes));
        assert_eq!(kind(b"-"), Err(ErrorKind::UnexpectedEnd));
        assert_eq!(kind(b"1."), Err(ErrorKind::UnexpectedEnd));
        assert_eq!(kind(b"1.e5"), Err(ErrorKind::InvalidNumber));
        assert_eq!(kind(b"1e"), Err(ErrorKind::UnexpectedEnd));
        assert_eq!(kind(b"+1"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"1e400"), Err(ErrorKind::InvalidNumber));
        assert_eq!(parse(b"-0"), Ok(Value::Int(0)));
        assert_eq!(parse(b"1E+2"), Ok(Value::Float(100.0)));
        assert_eq!(kind(b"True"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"nul"), Err(ErrorKind::UnexpectedEnd));
        assert_eq!(kind(b"[1,]"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"{\"a\":1,}"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"{a:1}"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"[1 2]"), Err(ErrorKind::UnexpectedByte));
        assert_eq!(kind(b"\"\\x\""), Err(ErrorKind::InvalidEscape));
        assert_eq!(kind(b"\"\\u12\""), Err(ErrorKind::InvalidEscape));
        assert_eq!(kind(b"\"\\ud800\""), Err(ErrorKind::LoneSurrogate));
        assert_eq!(kind(b"\"\\udc00\""), Err(ErrorKind::LoneSurrogate));
        assert_eq!(kind(b"\"\\ud800\\u0041\""), Err(ErrorKind::LoneSurrogate));
        assert_eq!(
            parse(b"\"\\ud834\\udd1e\""),
            Ok(Value::Str("\u{1d11e}".to_string()))
        );
        assert_eq!(
            parse(b"\"\\/\\\"\\\\\""),
            Ok(Value::Str("/\"\\".to_string()))
        );
        assert_eq!(kind(b""), Err(ErrorKind::UnexpectedEnd));
        assert_eq!(
            kind(b" \x0c1"),
            Err(ErrorKind::UnexpectedByte),
            "form feed is not whitespace"
        );
        assert_eq!(kind(b"[\"a\"]x"), Err(ErrorKind::TrailingBytes));
    }
}
