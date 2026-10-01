//! The curated C ABI surface for the zero-server core.
//!
//! This crate exposes a small, hand-written `extern "C"` API over [`zero_core`] and
//! the protocol crates so that languages without a native Rust bridge - C, C++, and
//! C#/.NET through P/Invoke - can drive the core. It is deliberately the single
//! auditable `unsafe` boundary on the language side: every raw pointer that arrives
//! from a host is dereferenced here and nowhere else.
//!
//! The committed header `include/zero.h` is generated from this source by
//! `cbindgen` (see `build.rs`) and is drift-checked in CI, so the C contract can
//! never fall behind the Rust surface.
//!
//! # Conventions
//!
//! - Every export catches panics with [`std::panic::catch_unwind`] and reports them
//!   as a status code or a null result, never as an unwind across the boundary.
//! - Handles are opaque, heap-allocated, and owned by the caller, who must release
//!   each with its matching `*_free` function.
//! - All strings crossing the boundary are UTF-8. Inputs are borrowed for the
//!   duration of the call; returned pointers document their own lifetime.
//! - An enum the caller passes in, as an argument or as a field of a struct, must hold
//!   one of the values the enum declares. The library reads it as one of those values,
//!   and any other value is undefined behavior; each binding refuses one before the
//!   call.

// The audited lint table denies `unsafe_code` crate-wide; an item that needs it
// carries its own allow and a `// SAFETY:` comment on every block.

use std::ffi::c_char;
use std::panic;
use std::ptr;

/// The crate version as a null-terminated C string.
const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");

/// Returns the version of the zero-server core.
///
/// # Returns
///
/// A pointer to a null-terminated UTF-8 string owned by the library and valid for
/// the lifetime of the process, or null if the call panicked. The caller must not
/// free it.
// `#[no_mangle]` counts as unsafe code: the symbol name is fixed for the host, and
// every export in this crate carries the `zero_` prefix so it cannot collide.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_version() -> *const c_char {
    match panic::catch_unwind(|| VERSION.as_ptr().cast()) {
        Ok(pointer) => pointer,
        Err(_) => ptr::null(),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::CStr;

    use super::zero_version;

    #[test]
    #[allow(unsafe_code)]
    fn version_matches_the_crate() {
        let pointer = zero_version();
        assert!(!pointer.is_null());
        // SAFETY: `zero_version` returns a pointer to a static null-terminated string
        // that lives for the whole process.
        let version = unsafe { CStr::from_ptr(pointer) };
        assert_eq!(version.to_str(), Ok(env!("CARGO_PKG_VERSION")));
    }
}
