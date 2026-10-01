//! Regenerates the type stub for the native `zero_server._native` module.
//!
//! Run with `cargo run --features stubs --bin stub_gen`. The stub is written to
//! `python/zero_server/_native/__init__.pyi` and is checked into the tree,
//! drift-checked in CI so it can never fall behind the Rust source.

use pyo3_stub_gen::Result;

fn main() -> Result<()> {
    let stub = zero_server_python::stub_info()?;
    stub.generate()?;
    Ok(())
}
