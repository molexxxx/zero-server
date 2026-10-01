//! The cryptographic primitives of zero-server.
//!
//! SHA-1 and SHA-256, random bytes, constant-time comparison, zeroizing secret types,
//! and the std implementations of the `zero-core` `Digest` and `Rng` traits over one
//! crypto provider per build. HMAC, PBKDF2, Ed25519 and the JWT signature primitives
//! come with the auth stack in a later release.
//!
//! [`SystemRng`] is the `Rng` the workspace uses: the operating system's
//! cryptographically secure generator, read through `zero-sys`. [`Sha1`] and
//! [`Sha256`] are the `Digest` implementations, over aws-lc-rs's `digest` module.
//! [`verify_mac`] and [`verify_token`] compare secret material in constant time,
//! and [`Secret`] holds a secret that is zeroized when dropped.
//!
//! @see <https://docs.rs/aws-lc-rs/1.18.1/aws_lc_rs/digest/index.html>
//! @see <https://docs.rs/aws-lc-rs/1.18.1/aws_lc_rs/constant_time/index.html>
//! @see <https://docs.rs/zeroize/1.9.0/zeroize/struct.Zeroizing.html>

use std::fmt;

use aws_lc_rs::{constant_time, digest};
use zero_core::primitive::ensure_output_len;
use zero_core::{Digest, Error, Result, Rng};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Compare a computed MAC or signature tag with a received one.
///
/// "The comparison of the computed HMAC value to the JWS Signature value MUST be
/// done in a constant-time manner to thwart timing attacks" (RFC 7518 Section 3.2).
/// The time taken does not depend on the contents of either value; it reveals only
/// whether the lengths differ, and for a MAC the expected length is the algorithm's
/// public output length. Compare like encodings: decoded bytes with decoded bytes,
/// or encoded with encoded, which the RFC allows as well.
///
/// # Arguments
///
/// * `expected` - the tag computed here.
/// * `received` - the tag the peer sent.
///
/// # Returns
///
/// Whether they are equal; `false` for different lengths or an empty `expected`,
/// which is always a configuration error.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7518.html#section-3.2>
#[must_use]
pub fn verify_mac(expected: &[u8], received: &[u8]) -> bool {
    equal_in_constant_time(expected, received)
}

/// Compare a stored token, such as a session id, a CSRF token or an API key, with a
/// received one, with the same contract as [`verify_mac`]: the OWASP Cross-Site
/// Request Forgery Prevention Cheat Sheet asks for a comparison that runs "in
/// constant time, regardless of how many characters match".
///
/// # Arguments
///
/// * `expected` - the token held here.
/// * `received` - the token the peer sent.
///
/// # Returns
///
/// Whether they are equal; `false` for different lengths or an empty `expected`.
///
/// @see <https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>
#[must_use]
pub fn verify_token(expected: &[u8], received: &[u8]) -> bool {
    equal_in_constant_time(expected, received)
}

/// The one place the provider's constant-time comparison is called.
fn equal_in_constant_time(expected: &[u8], received: &[u8]) -> bool {
    !expected.is_empty() && constant_time::verify_slices_are_equal(expected, received).is_ok()
}

/// A secret, zeroized when it is dropped.
///
/// It has no `PartialEq`, `Eq`, `Display`, `Clone` or `Zeroize`, so a secret is
/// never compared in variable time, printed, copied past its zeroization, or used
/// after a zeroize; its `Debug` output is redacted, so a struct that holds one can
/// still derive `Debug`. [`Secret::expose`] is the only way to the value, and
/// [`Secret::ct_eq`] compares it in constant time. Bytes are best held as
/// [`SecretBytes`], one heap allocation of exact size that cannot reallocate and
/// leave a copy behind.
///
/// ```compile_fail
/// let a = zero_server_crypto::SecretBytes::from_slice(b"k");
/// let b = zero_server_crypto::SecretBytes::from_slice(b"k");
/// let _ = a == b;
/// ```
///
/// ```compile_fail
/// let a = zero_server_crypto::SecretBytes::from_slice(b"k");
/// let _ = format!("{a}");
/// ```
///
/// ```compile_fail
/// let a = zero_server_crypto::SecretBytes::from_slice(b"k");
/// let _ = a.clone();
/// ```
///
/// @see <https://docs.rs/zeroize/1.9.0/zeroize/index.html>
pub struct Secret<T: Zeroize>(Zeroizing<T>);

/// Secret bytes in one heap allocation of exact size.
pub type SecretBytes = Secret<Box<[u8]>>;

impl<T: Zeroize> Secret<T> {
    /// Wrap a value.
    ///
    /// # Arguments
    ///
    /// * `value` - the secret; zeroized when the `Secret` is dropped.
    #[must_use]
    pub fn new(value: T) -> Self {
        Secret(Zeroizing::new(value))
    }

    /// The value, for the one call that needs it.
    #[must_use]
    pub fn expose(&self) -> &T {
        &self.0
    }
}

impl<T: Zeroize + AsRef<[u8]>> Secret<T> {
    /// Compare the secret with received bytes in constant time, with the contract of
    /// [`verify_token`].
    ///
    /// # Arguments
    ///
    /// * `received` - the bytes the peer sent.
    ///
    /// # Returns
    ///
    /// Whether they are equal.
    #[must_use]
    pub fn ct_eq(&self, received: &[u8]) -> bool {
        equal_in_constant_time(self.expose().as_ref(), received)
    }
}

impl Secret<Box<[u8]>> {
    /// Copy bytes into a new exact-size allocation.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the secret bytes; the caller zeroizes its own copy.
    #[must_use]
    pub fn from_slice(bytes: &[u8]) -> Self {
        Secret::new(Box::from(bytes))
    }

    /// Take bytes from a vector, zeroizing the vector's whole capacity after the
    /// copy.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the secret bytes.
    #[must_use]
    pub fn from_vec(mut bytes: Vec<u8>) -> Self {
        let secret = Secret::from_slice(&bytes);
        bytes.zeroize();
        secret
    }
}

impl<T: Zeroize> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

impl<T: Zeroize> ZeroizeOnDrop for Secret<T> {}

/// SHA-1 as FIPS 180-4 specifies it.
///
/// Kept for the protocols that still name it, such as the WebSocket handshake's
/// `Sec-WebSocket-Accept` value (RFC 6455 Section 4.2.2), where it is a
/// checksum and not a security property. Nothing that needs collision resistance
/// takes it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sha1;

impl Digest for Sha1 {
    fn output_len(&self) -> usize {
        digest::SHA1_OUTPUT_LEN
    }

    fn digest(&self, data: &[u8], out: &mut [u8]) -> Result<()> {
        one_shot(&digest::SHA1_FOR_LEGACY_USE_ONLY, data, out)
    }
}

/// SHA-256 as FIPS 180-4 specifies it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sha256;

impl Digest for Sha256 {
    fn output_len(&self) -> usize {
        digest::SHA256_OUTPUT_LEN
    }

    fn digest(&self, data: &[u8], out: &mut [u8]) -> Result<()> {
        one_shot(&digest::SHA256, data, out)
    }
}

/// Hash `data` with `algorithm` into `out`, whose length must be the output length.
fn one_shot(algorithm: &'static digest::Algorithm, data: &[u8], out: &mut [u8]) -> Result<()> {
    ensure_output_len(algorithm.output_len(), out)?;
    out.copy_from_slice(digest::digest(algorithm, data).as_ref());
    Ok(())
}

/// The operating system's cryptographically secure random number generator.
///
/// `getrandom(2)` on Linux, `getentropy(2)` on Apple platforms and `BCryptGenRandom`
/// with the system-preferred generator on Windows.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRng;

impl Rng for SystemRng {
    fn fill(&self, out: &mut [u8]) -> Result<()> {
        zero_sys::random::fill(out).map_err(|err| Error::Io(err.to_string()))
    }
}

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use zero_core::{Digest, Rng};
    use zeroize::Zeroize;

    use super::{verify_mac, verify_token, Secret, SecretBytes, Sha1, Sha256, SystemRng};

    #[test]
    fn rfc7518_3_2_the_computed_hmac_is_compared_with_the_received_tag_in_constant_time() {
        let tag = [0x5au8; 32];
        assert!(verify_mac(&tag, &tag));
        let mut first = tag;
        first[0] ^= 1;
        let mut last = tag;
        last[31] ^= 0x80;
        assert!(!verify_mac(&tag, &first), "a difference in the first byte");
        assert!(!verify_mac(&tag, &last), "a difference in the last byte");
        assert!(!verify_mac(&tag, &tag[..31]), "a shorter tag");
        let mut longer = tag.to_vec();
        longer.push(0);
        assert!(!verify_mac(&tag, &longer), "a longer tag");
        assert!(
            !verify_mac(&[], &[]),
            "an empty expected tag is a configuration error"
        );
    }

    #[test]
    fn tokens_compare_like_tags_and_a_secret_compares_like_a_token() {
        let token = b"0f5c2a9e41b7d3c8";
        assert!(verify_token(token, token));
        assert!(!verify_token(token, b"0f5c2a9e41b7d3c9"));
        assert!(!verify_token(token, b"0f5c"));
        assert!(!verify_token(b"", b""));
        let secret = SecretBytes::from_slice(token);
        for received in [&token[..], b"0f5c2a9e41b7d3c9", b"", b"0f5c"] {
            assert_eq!(secret.ct_eq(received), verify_token(token, received));
        }
        assert_eq!(&**secret.expose(), &token[..]);
    }

    #[test]
    fn a_secret_prints_redacted_and_never_its_bytes() {
        let secret = SecretBytes::from_vec(b"k3y-material".to_vec());
        let printed = format!("{secret:?}");
        assert_eq!(printed, "Secret([REDACTED])");
        assert!(!printed.contains("k3y"));
    }

    /// Records whether it was zeroized.
    struct Probe(Rc<Cell<bool>>);

    impl Zeroize for Probe {
        fn zeroize(&mut self) {
            self.0.set(true);
        }
    }

    #[test]
    fn a_secret_is_zeroized_when_it_is_dropped() {
        let zeroized = Rc::new(Cell::new(false));
        let secret = Secret::new(Probe(Rc::clone(&zeroized)));
        assert!(!zeroized.get());
        drop(secret);
        assert!(zeroized.get());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn sha1_and_sha256_match_the_fips_180_4_abc_examples() {
        let mut sha1 = [0u8; 20];
        Sha1.digest(b"abc", &mut sha1).expect("sha1");
        assert_eq!(hex(&sha1), "a9993e364706816aba3e25717850c26c9cd0d89d");
        let mut sha256 = [0u8; 32];
        Sha256.digest(b"abc", &mut sha256).expect("sha256");
        assert_eq!(
            hex(&sha256),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!((Sha1.output_len(), Sha256.output_len()), (20, 32));
        assert!(Sha1.digest(b"abc", &mut [0u8; 19]).is_err());
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_system_generator_fills_through_the_rng_trait() {
        let rng: &dyn Rng = &SystemRng;
        let mut a = [0u8; 16];
        let mut b = [0u8; 16];
        rng.fill(&mut a).expect("random bytes");
        rng.fill(&mut b).expect("random bytes");
        assert_ne!(a, b);
    }
}
