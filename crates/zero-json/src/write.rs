//! The buffer-direct writer.

use alloc::vec::Vec;
use core::fmt::{self, Write as _};

use zero_core::{Error, Value};

/// The deepest nesting the writer tracks.
pub const MAX_DEPTH: usize = 128;

/// Why a write was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteError {
    /// More than [`MAX_DEPTH`] open containers.
    TooDeep,
    /// A float that is not finite, which the grammar has no form for (RFC 8259
    /// Section 6).
    NonFinite,
    /// A key outside an object, a value where a key is due, or an end that
    /// matches no open container.
    Misplaced,
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooDeep => f.write_str("too many open containers"),
            Self::NonFinite => f.write_str("a float that is not finite has no JSON form"),
            Self::Misplaced => f.write_str("a key, value or end out of place"),
        }
    }
}

impl From<WriteError> for Error {
    fn from(error: WriteError) -> Self {
        Error::Codec(alloc::format!("json: {error}"))
    }
}

/// A JSON text being written into a byte buffer.
///
/// The writer keeps one bit per open container saying whether a separator is
/// due, so it allocates nothing of its own.
#[derive(Debug)]
pub struct Writer<'a> {
    out: &'a mut Vec<u8>,
    depth: usize,
    /// Bit `i` set: the container at depth `i + 1` has a member already.
    has_member: u128,
    /// Bit `i` set: the container at depth `i + 1` is an object.
    is_object: u128,
    /// A key was written and its value is due.
    value_due: bool,
    /// A top-level value was written.
    done: bool,
}

impl<'a> Writer<'a> {
    /// A writer appending to `out`.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer; it is not cleared.
    pub fn new(out: &'a mut Vec<u8>) -> Self {
        Writer {
            out,
            depth: 0,
            has_member: 0,
            is_object: 0,
            value_due: false,
            done: false,
        }
    }

    /// Whether the text is complete: one value, every container closed.
    #[must_use]
    pub const fn is_complete(&self) -> bool {
        self.done && self.depth == 0
    }

    fn bit(&self) -> u128 {
        1u128
            .checked_shl(u32::try_from(self.depth.saturating_sub(1)).unwrap_or(0))
            .unwrap_or(0)
    }

    /// Put the separator a value needs, and account for it.
    fn before_value(&mut self) -> Result<(), WriteError> {
        if self.depth == 0 {
            if self.done {
                return Err(WriteError::Misplaced);
            }
            self.done = true;
            return Ok(());
        }
        let bit = self.bit();
        if self.is_object & bit != 0 {
            if !self.value_due {
                return Err(WriteError::Misplaced);
            }
            self.value_due = false;
            return Ok(());
        }
        if self.has_member & bit != 0 {
            self.out.push(b',');
        }
        self.has_member |= bit;
        Ok(())
    }

    fn open(&mut self, byte: u8, object: bool) -> Result<(), WriteError> {
        if self.depth >= MAX_DEPTH {
            return Err(WriteError::TooDeep);
        }
        self.before_value()?;
        self.out.push(byte);
        self.depth = self.depth.saturating_add(1);
        let bit = self.bit();
        self.has_member &= !bit;
        if object {
            self.is_object |= bit;
        } else {
            self.is_object &= !bit;
        }
        Ok(())
    }

    fn close(&mut self, byte: u8, object: bool) -> Result<(), WriteError> {
        if self.depth == 0 || self.value_due {
            return Err(WriteError::Misplaced);
        }
        let bit = self.bit();
        if (self.is_object & bit != 0) != object {
            return Err(WriteError::Misplaced);
        }
        self.out.push(byte);
        self.depth = self.depth.saturating_sub(1);
        Ok(())
    }

    /// Open an object.
    ///
    /// # Errors
    ///
    /// [`WriteError::TooDeep`] past [`MAX_DEPTH`], [`WriteError::Misplaced`]
    /// where no value may go.
    pub fn begin_object(&mut self) -> Result<&mut Self, WriteError> {
        self.open(b'{', true)?;
        Ok(self)
    }

    /// Close the open object.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] when no object is open or a value is due.
    pub fn end_object(&mut self) -> Result<&mut Self, WriteError> {
        self.close(b'}', true)?;
        Ok(self)
    }

    /// Open an array.
    ///
    /// # Errors
    ///
    /// As for [`begin_object`](Self::begin_object).
    pub fn begin_array(&mut self) -> Result<&mut Self, WriteError> {
        self.open(b'[', false)?;
        Ok(self)
    }

    /// Close the open array.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] when no array is open.
    pub fn end_array(&mut self) -> Result<&mut Self, WriteError> {
        self.close(b']', false)?;
        Ok(self)
    }

    /// Write a member name; its value comes next.
    ///
    /// # Arguments
    ///
    /// * `name` - the name, escaped as a string.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] outside an object or when a value is due.
    pub fn key(&mut self, name: &str) -> Result<&mut Self, WriteError> {
        let bit = self.bit();
        if self.depth == 0 || self.is_object & bit == 0 || self.value_due {
            return Err(WriteError::Misplaced);
        }
        if self.has_member & bit != 0 {
            self.out.push(b',');
        }
        self.has_member |= bit;
        write_string(self.out, name);
        self.out.push(b':');
        self.value_due = true;
        Ok(self)
    }

    /// Write a string value, escaped (RFC 8259 Section 7).
    ///
    /// # Arguments
    ///
    /// * `value` - the text.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] where no value may go.
    pub fn string(&mut self, value: &str) -> Result<&mut Self, WriteError> {
        self.before_value()?;
        write_string(self.out, value);
        Ok(self)
    }

    /// Write a signed integer.
    ///
    /// # Arguments
    ///
    /// * `value` - the number.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] where no value may go.
    pub fn int(&mut self, value: i64) -> Result<&mut Self, WriteError> {
        self.before_value()?;
        if value < 0 {
            self.out.push(b'-');
        }
        write_unsigned(self.out, value.unsigned_abs());
        Ok(self)
    }

    /// Write an unsigned integer.
    ///
    /// # Arguments
    ///
    /// * `value` - the number.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] where no value may go.
    pub fn uint(&mut self, value: u64) -> Result<&mut Self, WriteError> {
        self.before_value()?;
        write_unsigned(self.out, value);
        Ok(self)
    }

    /// Write a float in the shortest form that reads back to the same value.
    ///
    /// # Arguments
    ///
    /// * `value` - the number; must be finite.
    ///
    /// # Errors
    ///
    /// [`WriteError::NonFinite`] for NaN or an infinity, [`WriteError::Misplaced`]
    /// where no value may go.
    pub fn float(&mut self, value: f64) -> Result<&mut Self, WriteError> {
        if !value.is_finite() {
            return Err(WriteError::NonFinite);
        }
        self.before_value()?;
        // Writing into a Vec never fails.
        let start = self.out.len();
        let _ = write!(Sink(self.out), "{value}");
        // An integral float prints without a fraction; the ".0" keeps it a float
        // when the text is read back.
        let integral = self
            .out
            .get(start..)
            .is_some_and(|text| !text.iter().any(|byte| matches!(byte, b'.' | b'e' | b'E')));
        if integral {
            self.out.extend_from_slice(b".0");
        }
        Ok(self)
    }

    /// Write `true` or `false`.
    ///
    /// # Arguments
    ///
    /// * `value` - the boolean.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] where no value may go.
    pub fn bool(&mut self, value: bool) -> Result<&mut Self, WriteError> {
        self.before_value()?;
        self.out
            .extend_from_slice(if value { b"true" } else { b"false" });
        Ok(self)
    }

    /// Write `null`.
    ///
    /// # Errors
    ///
    /// [`WriteError::Misplaced`] where no value may go.
    pub fn null(&mut self) -> Result<&mut Self, WriteError> {
        self.before_value()?;
        self.out.extend_from_slice(b"null");
        Ok(self)
    }

    /// Write a whole value tree.
    ///
    /// # Arguments
    ///
    /// * `value` - the value; bytes are written as an array of integers.
    ///
    /// # Errors
    ///
    /// As for the single-value methods.
    pub fn value(&mut self, value: &Value) -> Result<&mut Self, WriteError> {
        match value {
            Value::Null => self.null(),
            Value::Bool(flag) => self.bool(*flag),
            Value::Int(number) => self.int(*number),
            Value::Float(number) => self.float(*number),
            Value::Str(text) => self.string(text),
            Value::Bytes(bytes) => {
                self.begin_array()?;
                for byte in bytes {
                    self.uint(u64::from(*byte))?;
                }
                self.end_array()
            }
            Value::Array(items) => {
                self.begin_array()?;
                for item in items {
                    self.value(item)?;
                }
                self.end_array()
            }
            Value::Object(members) => {
                self.begin_object()?;
                for (name, member) in members {
                    self.key(name)?;
                    self.value(member)?;
                }
                self.end_object()
            }
        }
    }
}

/// A `fmt::Write` over a byte buffer.
struct Sink<'a>(&'a mut Vec<u8>);

impl fmt::Write for Sink<'_> {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.0.extend_from_slice(text.as_bytes());
        Ok(())
    }
}

/// Write a quoted, escaped string (RFC 8259 Section 7): quotation mark, reverse
/// solidus and the controls below U+0020 escaped, everything else as UTF-8.
fn write_string(out: &mut Vec<u8>, text: &str) {
    out.push(b'"');
    let bytes = text.as_bytes();
    let mut start = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        let escape: Option<&[u8]> = match byte {
            b'"' => Some(b"\\\""),
            b'\\' => Some(b"\\\\"),
            b'\n' => Some(b"\\n"),
            b'\r' => Some(b"\\r"),
            b'\t' => Some(b"\\t"),
            0x08 => Some(b"\\b"),
            0x0C => Some(b"\\f"),
            0x00..=0x1F => None,
            _ => continue,
        };
        out.extend_from_slice(bytes.get(start..index).unwrap_or(&[]));
        match escape {
            Some(escape) => out.extend_from_slice(escape),
            None => {
                out.extend_from_slice(b"\\u00");
                out.push(hex_digit(byte.wrapping_shr(4)));
                out.push(hex_digit(byte & 0x0F));
            }
        }
        start = index.saturating_add(1);
    }
    out.extend_from_slice(bytes.get(start..).unwrap_or(&[]));
    out.push(b'"');
}

const fn hex_digit(nibble: u8) -> u8 {
    match nibble & 0x0F {
        0..=9 => b'0'.wrapping_add(nibble & 0x0F),
        other => b'a'.wrapping_add(other.wrapping_sub(10)),
    }
}

/// Write a decimal integer.
fn write_unsigned(out: &mut Vec<u8>, mut value: u64) {
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    loop {
        at = at.saturating_sub(1);
        if let Some(slot) = digits.get_mut(at) {
            *slot = b'0'.wrapping_add(u8::try_from(value % 10).unwrap_or(0));
        }
        value /= 10;
        if value == 0 || at == 0 {
            break;
        }
    }
    out.extend_from_slice(digits.get(at..).unwrap_or(&[]));
}

/// Serialize a value tree into a new buffer.
///
/// # Arguments
///
/// * `value` - the value.
///
/// # Errors
///
/// [`WriteError::NonFinite`] for a float that is not finite, [`WriteError::TooDeep`]
/// past [`MAX_DEPTH`].
pub fn to_vec(value: &Value) -> Result<Vec<u8>, WriteError> {
    let mut out = Vec::new();
    Writer::new(&mut out).value(value)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use alloc::string::ToString;
    use alloc::vec::Vec;

    use super::{to_vec, WriteError, Writer};
    use zero_core::Value;

    fn text(
        build: impl FnOnce(&mut Writer<'_>) -> Result<(), WriteError>,
    ) -> Result<alloc::string::String, WriteError> {
        let mut out = Vec::new();
        let mut writer = Writer::new(&mut out);
        build(&mut writer)?;
        assert!(writer.is_complete());
        Ok(alloc::string::String::from_utf8(out).unwrap_or_default())
    }

    #[test]
    fn the_writer_puts_separators_where_the_grammar_wants_them() {
        let built = text(|w| {
            w.begin_object()?;
            w.key("message")?.string("Hello, World!")?;
            w.key("n")?.int(-42)?;
            w.key("list")?.begin_array()?;
            w.int(1)?.float(2.5)?.bool(true)?.null()?;
            w.begin_object()?.end_object()?;
            w.end_array()?;
            w.key("empty")?.begin_array()?.end_array()?;
            w.end_object()?;
            Ok(())
        });
        assert_eq!(
            built,
            Ok(
                r#"{"message":"Hello, World!","n":-42,"list":[1,2.5,true,null,{}],"empty":[]}"#
                    .to_string()
            )
        );
        assert_eq!(
            text(|w| w.uint(u64::MAX).map(|_| ())),
            Ok("18446744073709551615".to_string())
        );
        assert_eq!(
            text(|w| w.int(i64::MIN).map(|_| ())),
            Ok("-9223372036854775808".to_string())
        );
        assert_eq!(text(|w| w.int(0).map(|_| ())), Ok("0".to_string()));
        assert_eq!(text(|w| w.float(0.1).map(|_| ())), Ok("0.1".to_string()));
        assert_eq!(
            text(|w| w.float(1e21).map(|_| ())),
            Ok("1000000000000000000000.0".to_string())
        );
    }

    #[test]
    fn strings_escape_the_quotation_mark_the_reverse_solidus_and_controls_only() {
        let built = text(|w| {
            w.string("a\"b\\c\n\r\t\u{8}\u{c}\u{1}\u{1f} \u{7f}\u{e9}/\u{2028}")
                .map(|_| ())
        });
        assert_eq!(
            built,
            Ok("\"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f \u{7f}\u{e9}/\u{2028}\"".to_string())
        );
    }

    #[test]
    fn misplaced_items_non_finite_floats_and_excess_depth_are_refused() {
        assert_eq!(text(|w| w.key("x").map(|_| ())), Err(WriteError::Misplaced));
        assert_eq!(
            text(|w| {
                w.begin_object()?;
                w.int(1)?;
                Ok(())
            }),
            Err(WriteError::Misplaced),
            "a value without a key"
        );
        assert_eq!(
            text(|w| {
                w.begin_object()?;
                w.key("a")?;
                w.end_object()?;
                Ok(())
            }),
            Err(WriteError::Misplaced),
            "a key without a value"
        );
        assert_eq!(
            text(|w| {
                w.begin_array()?;
                w.end_object()?;
                Ok(())
            }),
            Err(WriteError::Misplaced)
        );
        assert_eq!(
            text(|w| w.float(f64::NAN).map(|_| ())),
            Err(WriteError::NonFinite)
        );
        assert_eq!(
            text(|w| {
                w.int(1)?;
                w.int(2)?;
                Ok(())
            }),
            Err(WriteError::Misplaced),
            "one top-level value"
        );
        assert_eq!(
            text(|w| {
                for _ in 0..super::MAX_DEPTH {
                    w.begin_array()?;
                }
                w.begin_array()?;
                Ok(())
            }),
            Err(WriteError::TooDeep)
        );
    }

    #[test]
    fn a_value_tree_serializes_with_bytes_as_an_array_of_integers() {
        let value = Value::Object(alloc::vec![
            (
                "a".to_string(),
                Value::Array(alloc::vec![Value::Int(1), Value::Null])
            ),
            ("b".to_string(), Value::Bytes(alloc::vec![0, 255])),
            ("c".to_string(), Value::Float(-0.5)),
        ]);
        assert_eq!(
            to_vec(&value),
            Ok(br#"{"a":[1,null],"b":[0,255],"c":-0.5}"#.to_vec())
        );
    }

    #[test]
    fn integral_floats_keep_a_fraction_so_they_read_back_as_floats() {
        assert_eq!(text(|w| w.float(2.0).map(|_| ())), Ok("2.0".to_string()));
        assert_eq!(text(|w| w.float(-0.0).map(|_| ())), Ok("-0.0".to_string()));
        assert_eq!(text(|w| w.float(2.5).map(|_| ())), Ok("2.5".to_string()));
        let zero = Value::Array(alloc::vec![Value::Float(0.0), Value::Int(0)]);
        let written = to_vec(&zero).unwrap_or_default();
        assert_eq!(written, b"[0.0,0]");
        assert_eq!(crate::parse(&written), Ok(zero));
    }
}
