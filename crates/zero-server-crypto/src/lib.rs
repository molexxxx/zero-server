//! The cryptographic primitives of zero-server.
//!
//! SHA-1, SHA-256, HMAC, PBKDF2, random bytes, Ed25519 and the JWT signature
//! primitives, constant-time comparison, zeroizing secret types, and the std
//! implementations of the `zero-core` `Digest`, `Mac`, `Kdf` and `Rng` traits over one
//! crypto provider per build.
//!
//! [`SystemRng`] is the `Rng` the workspace uses: the operating system's
//! cryptographically secure generator, read through `zero-sys`.

use zero_core::{Error, Result, Rng};

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
    use zero_core::Rng;

    use super::SystemRng;

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
