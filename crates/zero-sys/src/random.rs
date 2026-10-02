//! Random bytes from the operating system's cryptographically secure generator.
//!
//! On Linux the `getrandom(2)` system call with no flags, which "blocks ... until the
//! urandom entropy pool initializes" and then reads from it; it is made through
//! `syscall` so the binding needs neither glibc 2.25 nor a musl wrapper, a short read
//! is continued and `EINTR` retried. On Apple platforms `getentropy(2)`, "The maximum
//! buffer size permitted is 256 bytes", so larger requests are filled in 256-byte
//! chunks. On Windows `BCryptGenRandom` with `BCRYPT_USE_SYSTEM_PREFERRED_RNG`, for
//! which "The hAlgorithm parameter must be NULL", in chunks of at most `u32::MAX`
//! bytes.
//!
//! Sources, read 2026-10-01: getrandom(2) of the Linux man-pages project
//! (<https://man7.org/linux/man-pages/man2/getrandom.2.html>), the macOS getentropy(2)
//! page, and the Microsoft reference for BCryptGenRandom
//! (<https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptgenrandom>).

use std::io;

/// Fill `out` with random bytes from the operating system's cryptographically secure
/// generator.
///
/// # Arguments
///
/// * `out` - the buffer to fill completely; an empty buffer is left as it is.
///
/// # Returns
///
/// Nothing; every byte of `out` is random.
///
/// # Errors
///
/// The operating system's error when the generator fails, and `Unsupported` on a
/// platform this crate has no generator for.
pub fn fill(out: &mut [u8]) -> io::Result<()> {
    if out.is_empty() {
        return Ok(());
    }
    imp::fill(out)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
    use std::io;

    #[allow(unsafe_code)]
    pub fn fill(out: &mut [u8]) -> io::Result<()> {
        let mut done = 0usize;
        while done < out.len() {
            let rest = out.get_mut(done..).unwrap_or(&mut []);
            // SAFETY: `rest` is a live, writable buffer of `rest.len()` bytes for the
            // duration of the call, and flags 0 asks for nothing but the urandom pool.
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_getrandom,
                    rest.as_mut_ptr().cast::<libc::c_void>(),
                    rest.len(),
                    0,
                )
            };
            if rc < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            let read = usize::try_from(rc).unwrap_or(0).min(rest.len());
            if read == 0 {
                return Err(io::Error::other("getrandom returned no bytes"));
            }
            done = done.saturating_add(read);
        }
        Ok(())
    }
}

#[cfg(target_vendor = "apple")]
mod imp {
    use std::io;

    /// The most bytes one `getentropy` call may ask for.
    const CHUNK: usize = 256;

    #[allow(unsafe_code)]
    pub fn fill(out: &mut [u8]) -> io::Result<()> {
        for chunk in out.chunks_mut(CHUNK) {
            // SAFETY: `chunk` is a live, writable buffer of at most 256 bytes for the
            // duration of the call, the limit getentropy accepts.
            let rc =
                unsafe { libc::getentropy(chunk.as_mut_ptr().cast::<libc::c_void>(), chunk.len()) };
            if rc != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use std::io;

    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    /// The most bytes one `BCryptGenRandom` call may ask for.
    const CHUNK: usize = u32::MAX as usize;

    #[allow(unsafe_code)]
    pub fn fill(out: &mut [u8]) -> io::Result<()> {
        for chunk in out.chunks_mut(CHUNK) {
            let len = u32::try_from(chunk.len()).unwrap_or(u32::MAX);
            // SAFETY: the null handle is what BCRYPT_USE_SYSTEM_PREFERRED_RNG requires,
            // and `chunk` is a live, writable buffer of `len` bytes for the call.
            let status = unsafe {
                BCryptGenRandom(
                    core::ptr::null_mut(),
                    chunk.as_mut_ptr(),
                    len,
                    BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                )
            };
            if status != 0 {
                return Err(io::Error::other(format!(
                    "BCryptGenRandom failed with status {status:#010x}"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
mod imp {
    use std::io;

    pub fn fill(_out: &mut [u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no random number generator is wired for this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::fill;

    #[test]
    #[cfg_attr(miri, ignore)]
    fn every_byte_of_the_buffer_is_written_and_two_reads_differ() {
        let mut first = [0u8; 32];
        let mut second = [0u8; 32];
        fill(&mut first).expect("random bytes");
        fill(&mut second).expect("random bytes");
        assert_ne!(first, second);
        assert_ne!(first, [0u8; 32]);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_buffer_longer_than_one_chunk_is_filled_end_to_end() {
        let mut big = vec![0u8; 1 << 20];
        fill(&mut big).expect("random bytes");
        let head = big.get(..4096).expect("head");
        let tail = big.get(big.len() - 4096..).expect("tail");
        assert!(head.iter().any(|&b| b != 0));
        assert!(tail.iter().any(|&b| b != 0));
        let mut counts = [0u32; 256];
        for &byte in &big {
            if let Some(count) = counts.get_mut(usize::from(byte)) {
                *count = count.saturating_add(1);
            }
        }
        let expected = 4096u32;
        assert!(counts.iter().all(|&c| c > expected / 2 && c < expected * 2));
    }

    #[test]
    fn an_empty_buffer_needs_no_call() {
        fill(&mut []).expect("nothing to fill");
    }
}
