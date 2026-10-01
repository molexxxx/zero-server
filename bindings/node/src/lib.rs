//! Node.js bindings for the zero-server core, generated with napi-rs.
//!
//! This crate is the generated low-level surface (the contract tier): it exposes
//! the Rust core to JavaScript and TypeScript one-to-one over the C ABI of
//! `zero-ffi`. A hand-written, idiomatic facade wraps it for everyday use; see
//! the `@zero-server/core` package.

use std::ffi::CStr;

use napi_derive::napi;

/// Returns the version of the native zero-server core.
///
/// # Returns
///
/// The version string of the `zero-ffi` crate the addon was built against.
///
/// # Errors
///
/// Rejects when the core reported no version, which only happens if the call
/// panicked inside the core.
// The audited lint table denies `unsafe_code` crate-wide; the one block below
// carries its own allow and a `// SAFETY:` comment.
#[allow(unsafe_code)]
#[napi]
pub fn version() -> napi::Result<String> {
    let pointer = zero_ffi::zero_version();
    if pointer.is_null() {
        return Err(napi::Error::from_reason("the core reported no version"));
    }
    // SAFETY: `zero_version` returns either null, handled above, or a pointer to a
    // static null-terminated string that lives for the whole process.
    let version = unsafe { CStr::from_ptr(pointer) };
    Ok(version.to_string_lossy().into_owned())
}
