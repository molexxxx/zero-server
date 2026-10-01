//! `Value`: the dynamic value model shared by the codecs and the database drivers.
//!
//! Objects are ordered lists of pairs scanned linearly, never a hash map, so an
//! attacker who controls the keys cannot degrade a lookup past the linear cost
//! the caller already budgets for.

use alloc::string::String;
use alloc::vec::Vec;

/// A dynamically typed value: what a JSON document, a database row cell or a
/// conformance vector holds.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// The absence of a value.
    Null,
    /// A boolean.
    Bool(bool),
    /// A signed 64-bit integer.
    Int(i64),
    /// A 64-bit floating-point number.
    Float(f64),
    /// A UTF-8 string.
    Str(String),
    /// An opaque byte string.
    Bytes(Vec<u8>),
    /// An ordered sequence of values.
    Array(Vec<Value>),
    /// An ordered list of key and value pairs, looked up by linear scan.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// Returns the name of the variant, for error messages.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "bool",
            Self::Int(_) => "int",
            Self::Float(_) => "float",
            Self::Str(_) => "string",
            Self::Bytes(_) => "bytes",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }

    /// Returns `true` for [`Value::Null`].
    #[must_use]
    pub const fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// Returns the boolean, if this is one.
    #[must_use]
    pub const fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// Returns the integer, if this is one.
    #[must_use]
    pub const fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    /// Returns the number as a float; an integer is converted.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Float(value) => Some(*value),
            Self::Int(value) => Some(*value as f64),
            _ => None,
        }
    }

    /// Returns the string, if this is one.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(value) => Some(value),
            _ => None,
        }
    }

    /// Returns the bytes, if this is a byte string.
    #[must_use]
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(value) => Some(value),
            _ => None,
        }
    }

    /// Returns the elements, if this is an array.
    #[must_use]
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    /// Returns the pairs, if this is an object.
    #[must_use]
    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    /// Looks a key up in an object by linear scan, returning the first match.
    ///
    /// # Arguments
    ///
    /// * `key` - the key to find.
    ///
    /// # Returns
    ///
    /// The value under `key`, or `None` when this is not an object or the key is
    /// absent.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Self::Int(value)
    }
}

impl From<i32> for Value {
    fn from(value: i32) -> Self {
        Self::Int(value.into())
    }
}

impl From<u32> for Value {
    fn from(value: u32) -> Self {
        Self::Int(value.into())
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Self::Float(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Self::Str(value.into())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Self::Str(value)
    }
}

impl From<Vec<u8>> for Value {
    fn from(value: Vec<u8>) -> Self {
        Self::Bytes(value)
    }
}

impl From<Vec<Value>> for Value {
    fn from(value: Vec<Value>) -> Self {
        Self::Array(value)
    }
}

impl From<Vec<(String, Value)>> for Value {
    fn from(value: Vec<(String, Value)>) -> Self {
        Self::Object(value)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::Null, Into::into)
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;

    use super::Value;

    #[test]
    fn accessors_match_their_variant_only() {
        assert_eq!(Value::from(true).as_bool(), Some(true));
        assert_eq!(Value::from(7i64).as_i64(), Some(7));
        assert_eq!(Value::from(7i64).as_f64(), Some(7.0));
        assert_eq!(Value::from(2.5).as_f64(), Some(2.5));
        assert_eq!(Value::from(2.5).as_i64(), None);
        assert_eq!(Value::from("x").as_str(), Some("x"));
        assert_eq!(Value::from(vec![1u8]).as_bytes(), Some(&[1u8][..]));
        assert!(Value::from(None::<bool>).is_null());
        assert_eq!(Value::from(Some(3i32)), Value::Int(3));
    }

    #[test]
    fn objects_look_up_the_first_matching_key() {
        let object = Value::from(vec![
            ("a".into(), Value::from(1i64)),
            ("b".into(), Value::from(2i64)),
            ("a".into(), Value::from(3i64)),
        ]);
        assert_eq!(object.get("a"), Some(&Value::Int(1)));
        assert_eq!(object.get("b"), Some(&Value::Int(2)));
        assert_eq!(object.get("c"), None);
        assert_eq!(Value::from(vec![Value::Null]).get("a"), None);
        assert_eq!(object.as_object().map(<[_]>::len), Some(3));
    }

    #[test]
    fn kinds_name_every_variant() {
        let values = [
            Value::Null,
            Value::Bool(false),
            Value::Int(0),
            Value::Float(0.0),
            Value::Str("".into()),
            Value::Bytes(vec![]),
            Value::Array(vec![]),
            Value::Object(vec![]),
        ];
        let kinds: alloc::vec::Vec<&str> = values.iter().map(Value::kind).collect();
        assert_eq!(
            kinds,
            ["null", "bool", "int", "float", "string", "bytes", "array", "object"]
        );
    }
}
