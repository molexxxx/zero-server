//! The conformance entry: the shared vectors recomputed by the parsers and encoders
//! the server uses, so the Node runner compares against the same implementation as
//! every other binding.

use napi_derive::napi;

use crate::guard::{node_guard, Code, Fail};

/// Recompute part of a section of `conformance/vectors.json`: the result is the
/// document with every outcome computed again from its inputs, as canonical JSON with
/// sorted keys, so it equals the input exactly when the core agrees with the vectors.
///
/// # Arguments
///
/// * `section` - the section's name: `http1Parser`, `responseSplitting`, `router`,
///   `ws`, `sse`, `qpack` or `h3Frames`.
/// * `input` - a JSON document in the section's shape.
///
/// # Returns
///
/// The recomputed document.
///
/// # Errors
///
/// `ZERO_UNSUPPORTED` for an unknown section, `ZERO_LIMIT` for a document past one
/// mebibyte or the nesting cap, and `ZERO_CODEC` for a document that is not JSON or
/// does not have the section's shape.
#[napi(catch_unwind)]
pub fn conformance_case(section: String, input: String) -> napi::Result<String, Code> {
    node_guard(|| {
        zero_host::conformance::case(section.as_bytes(), input.as_bytes()).map_err(Fail::from)
    })
}
