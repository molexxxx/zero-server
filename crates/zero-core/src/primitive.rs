//! The primitive traits a `no_std` crate takes when it needs a digest, a MAC,
//! a key derivation function or random bytes.
//!
//! The implementations live in the std crate that wraps the cryptography
//! provider; a `no_std` crate takes one by generic parameter or by reference at
//! construction and never depends on the provider itself. Every operation is a
//! one-shot over a complete message, which is all the callers need: the
//! WebSocket accept value, a cookie or token MAC, a SCRAM exchange, a trace id.
//!
//! None of these traits compares a tag or a token. Comparisons of secret
//! material are constant-time operations that belong to the crate holding the
//! provider.

use alloc::format;

use crate::{Error, Result};

/// Checks that an output buffer has the length a primitive produces.
///
/// # Arguments
///
/// * `expected` - the length the primitive writes.
/// * `out` - the caller's buffer.
///
/// # Errors
///
/// Returns [`Error::Codec`] when the lengths differ.
pub fn ensure_output_len(expected: usize, out: &[u8]) -> Result<()> {
    if out.len() == expected {
        Ok(())
    } else {
        Err(Error::Codec(format!(
            "output buffer holds {} bytes, the primitive produces {expected}",
            out.len()
        )))
    }
}

/// A cryptographic hash function.
pub trait Digest {
    /// Returns the length in bytes of the digest this function produces.
    fn output_len(&self) -> usize;

    /// Hashes a complete message.
    ///
    /// # Arguments
    ///
    /// * `data` - the message.
    /// * `out` - receives the digest; its length must equal
    ///   [`output_len`](Self::output_len).
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`] when `out` has the wrong length.
    fn digest(&self, data: &[u8], out: &mut [u8]) -> Result<()>;
}

/// A message authentication code.
pub trait Mac {
    /// Returns the length in bytes of the tag this code produces.
    fn output_len(&self) -> usize;

    /// Computes the tag of a complete message under a key.
    ///
    /// # Arguments
    ///
    /// * `key` - the secret key.
    /// * `data` - the message.
    /// * `out` - receives the tag; its length must equal
    ///   [`output_len`](Self::output_len).
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`] when `out` has the wrong length, and
    /// [`Error::Auth`] when the provider rejects the key.
    fn mac(&self, key: &[u8], data: &[u8], out: &mut [u8]) -> Result<()>;
}

/// A password-based key derivation function with an iteration count.
pub trait Kdf {
    /// Derives key material from a secret and a salt.
    ///
    /// # Arguments
    ///
    /// * `secret` - the password or secret.
    /// * `salt` - the salt.
    /// * `iterations` - the iteration count, at least one.
    /// * `out` - receives the derived bytes; its length selects how many.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`] when `iterations` is zero or `out` is empty,
    /// and [`Error::Limit`] when `out` asks for more bytes than the function
    /// can derive.
    fn derive(&self, secret: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) -> Result<()>;
}

/// A source of cryptographically secure random bytes.
pub trait Rng {
    /// Fills a buffer with random bytes.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer to fill completely.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Io`] when the entropy source fails.
    fn fill(&self, out: &mut [u8]) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::{ensure_output_len, Digest, Kdf, Mac, Rng};
    use crate::{Error, Result};

    /// A toy one-byte checksum, enough to pin the trait contracts.
    struct Sum;

    impl Digest for Sum {
        fn output_len(&self) -> usize {
            1
        }

        fn digest(&self, data: &[u8], out: &mut [u8]) -> Result<()> {
            ensure_output_len(Digest::output_len(self), out)?;
            let sum = data.iter().fold(0u8, |acc, byte| acc.wrapping_add(*byte));
            out.fill(sum);
            Ok(())
        }
    }

    impl Mac for Sum {
        fn output_len(&self) -> usize {
            1
        }

        fn mac(&self, key: &[u8], data: &[u8], out: &mut [u8]) -> Result<()> {
            let mut tag = [0u8; 1];
            self.digest(data, &mut tag)?;
            let key = key.iter().fold(0u8, |acc, byte| acc.wrapping_add(*byte));
            ensure_output_len(1, out)?;
            out.fill(key.wrapping_add(tag.first().copied().unwrap_or_default()));
            Ok(())
        }
    }

    impl Kdf for Sum {
        fn derive(
            &self,
            secret: &[u8],
            salt: &[u8],
            iterations: u32,
            out: &mut [u8],
        ) -> Result<()> {
            if iterations == 0 || out.is_empty() {
                return Err(Error::Codec("nothing to derive".into()));
            }
            let mut byte = [0u8; 1];
            self.mac(secret, salt, &mut byte)?;
            out.fill(byte.first().copied().unwrap_or_default());
            Ok(())
        }
    }

    impl Rng for Sum {
        fn fill(&self, out: &mut [u8]) -> Result<()> {
            out.fill(4);
            Ok(())
        }
    }

    #[test]
    fn the_digest_contract_checks_the_output_length() {
        let mut out = [0u8; 1];
        assert!(Sum.digest(&[1, 2, 3], &mut out).is_ok());
        assert_eq!(out, [6]);
        let mut wrong = [0u8; 2];
        assert!(matches!(Sum.digest(&[], &mut wrong), Err(Error::Codec(_))));
    }

    #[test]
    fn the_mac_and_kdf_contracts_compose() {
        let mut tag = [0u8; 1];
        assert!(Sum.mac(&[10], &[1, 2], &mut tag).is_ok());
        assert_eq!(tag, [13]);
        let mut key = [0u8; 3];
        assert!(Sum.derive(&[10], &[1, 2], 1, &mut key).is_ok());
        assert_eq!(key, [13, 13, 13]);
        assert!(Sum.derive(&[], &[], 0, &mut key).is_err());
        assert!(Sum.derive(&[], &[], 1, &mut []).is_err());
    }

    #[test]
    fn the_rng_contract_fills_the_whole_buffer() {
        let mut out = [0u8; 4];
        assert!(Sum.fill(&mut out).is_ok());
        assert_eq!(out, [4; 4]);
    }

    #[test]
    fn ensure_output_len_names_both_lengths() {
        let error = ensure_output_len(32, &[0; 20]).err();
        assert_eq!(
            error.map(|error| alloc::format!("{error}")),
            Some("codec error: output buffer holds 20 bytes, the primitive produces 32".into())
        );
    }
}
