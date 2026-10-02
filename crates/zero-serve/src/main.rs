//! The standalone zero-server binary, `zero`.
//!
//! The whole binary is [`zero_serve::run`]; this entry point only hands it the
//! command-line arguments. This is the only crate that may install a global allocator.

use std::process::ExitCode;

fn main() -> ExitCode {
    zero_serve::run(std::env::args_os().skip(1))
}
