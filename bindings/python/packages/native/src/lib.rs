//! Python bindings for the zero-server core, generated with PyO3.
//!
//! This crate is the generated low-level surface (the contract tier): it exposes
//! the Rust core to Python one-to-one over the C ABI of `zero-ffi`. A
//! hand-written, idiomatic facade wraps it for everyday use; see the
//! `zero-server-core` Python package.
//!
//! The native module is imported as `zero_server._native` and re-exported
//! verbatim at `zero_server.raw`.

use pyo3::prelude::*;
#[cfg(feature = "stubs")]
use pyo3_stub_gen::{define_stub_info_gatherer, derive::gen_stub_pyfunction};

/// Returns the version of the native zero-server core.
///
/// # Returns
///
/// The version of the `zero-ffi` crate the module was built against, the text
/// `zero_version` returns through the C ABI.
#[cfg_attr(feature = "stubs", gen_stub_pyfunction)]
#[pyfunction]
fn version() -> &'static str {
    zero_ffi::VERSION
}

/// The generated low-level Python surface for the zero-server core.
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(version, m)?)?;
    Ok(())
}

#[cfg(feature = "stubs")]
define_stub_info_gatherer!(stub_info);
