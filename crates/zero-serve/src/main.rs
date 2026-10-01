//! The standalone zero-server binary.
//!
//! `zero serve` runs the server from its configuration; `zero migrate`, `zero seed`
//! and `zero doctor` share the same entry point. This is the only crate that may
//! install a global allocator.

use std::process::ExitCode;

fn main() -> ExitCode {
    println!("zero-server {}", zero_core::VERSION);
    ExitCode::SUCCESS
}
