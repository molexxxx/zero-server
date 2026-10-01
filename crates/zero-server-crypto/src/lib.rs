//! The cryptographic primitives of zero-server.
//!
//! SHA-1, SHA-256, HMAC, PBKDF2, random bytes, Ed25519 and the JWT signature
//! primitives, constant-time comparison, zeroizing secret types, and the std
//! implementations of the `zero-core` `Digest`, `Mac`, `Kdf` and `Rng` traits over one
//! crypto provider per build.
//!
//! [`SystemRng`] is the `Rng` the workspace uses: the operating system's
//! cryptographically secure generator, read through `zero-sys`. [`Sha1`] and
//! [`Sha256`] are the `Digest` implementations, over aws-lc-rs's `digest` module.
//!
//! @see <https://docs.rs/aws-lc-rs/1.18.1/aws_lc_rs/digest/index.html>

use aws_lc_rs::digest;
use zero_core::primitive::ensure_output_len;
use zero_core::{Digest, Error, Result, Rng};

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
    use zero_core::{Digest, Rng};

    use super::{Sha1, Sha256, SystemRng};

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
