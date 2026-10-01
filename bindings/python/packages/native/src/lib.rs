//! Python bindings for the zero-server core, generated with PyO3.
//!
//! This crate is the generated low-level surface (the contract tier): it exposes
//! the Rust core to Python one-to-one over the C ABI of `zero-ffi`. A
//! hand-written, idiomatic facade wraps it for everyday use; see the
//! `zero-server-core` Python package.
//!
//! The native module is imported as `zero_server._native` and re-exported
//! verbatim at `zero_server.raw`.

use std::ffi::CStr;

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
#[cfg(feature = "stubs")]
use pyo3_stub_gen::{define_stub_info_gatherer, derive::gen_stub_pyfunction};

/// Returns the version of the native zero-server core.
///
/// # Returns
///
/// The version string of the `zero-ffi` crate the module was built against.
///
/// # Errors
///
/// Raises `RuntimeError` when the core reported no version, which only happens
/// if the call panicked inside the core.
// The audited lint table denies `unsafe_code` crate-wide; the one block below
// carries its own allow and a `// SAFETY:` comment.
#[allow(unsafe_code)]
#[cfg_attr(feature = "stubs", gen_stub_pyfunction)]
#[pyfunction]
fn version() -> PyResult<String> {
    let pointer = zero_ffi::zero_version();
    if pointer.is_null() {
        return Err(PyRuntimeError::new_err("the core reported no version"));
    }
    // SAFETY: `zero_version` returns either null, handled above, or a pointer to a
    // static null-terminated string that lives for the whole process.
    let version = unsafe { CStr::from_ptr(pointer) };
    Ok(version.to_string_lossy().into_owned())
}

/// The generated low-level Python surface for the zero-server core.
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(version, m)?)?;
    Ok(())
}

#[cfg(feature = "stubs")]
define_stub_info_gatherer!(stub_info);
