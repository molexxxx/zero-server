//! The `Codec` trait: one encoder and decoder pair per wire format.

use alloc::vec::Vec;

use crate::Result;

/// A symmetric encoder and decoder for values of type `T`.
///
/// Every format the crates share, from JSON to the database wire protocols and
/// the conformance vectors, implements this trait, so a caller can exchange one
/// for another without changing the code around it.
pub trait Codec<T> {
    /// Encodes a value into a byte buffer.
    ///
    /// # Arguments
    ///
    /// * `value` - the value to serialize.
    ///
    /// # Returns
    ///
    /// A byte buffer containing the encoded representation of `value`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`](crate::Error::Codec) if the value cannot be
    /// encoded.
    fn encode(&self, value: &T) -> Result<Vec<u8>>;

    /// Decodes a value from its encoded bytes.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the encoded representation to parse.
    ///
    /// # Returns
    ///
    /// The decoded value.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`](crate::Error::Codec) if `bytes` is not a valid
    /// encoding of a `T`.
    fn decode(&self, bytes: &[u8]) -> Result<T>;
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::Codec;
    use crate::{Error, Result};

    /// A four-byte big-endian codec for `u32`, enough to exercise the trait.
    struct BigEndian;

    impl Codec<u32> for BigEndian {
        fn encode(&self, value: &u32) -> Result<Vec<u8>> {
            Ok(value.to_be_bytes().to_vec())
        }

        fn decode(&self, bytes: &[u8]) -> Result<u32> {
            let array: [u8; 4] = bytes
                .try_into()
                .map_err(|_| Error::Codec("expected four bytes".into()))?;
            Ok(u32::from_be_bytes(array))
        }
    }

    #[test]
    fn round_trips_through_a_codec() {
        let encoded = BigEndian.encode(&0x0102_0304).unwrap_or_default();
        assert_eq!(encoded, [1, 2, 3, 4]);
        assert_eq!(BigEndian.decode(&encoded).ok(), Some(0x0102_0304));
    }

    #[test]
    fn decode_reports_a_codec_error() {
        assert!(matches!(BigEndian.decode(&[1, 2]), Err(Error::Codec(_))));
    }
}
