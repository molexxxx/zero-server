//! Regenerates the committed C header from the crate's `extern "C"` surface.
//!
//! `cbindgen` parses this crate and writes `include/zero.h`, opened by a comment that
//! is the crate documentation of `src/lib.rs`, so the rules of the ABI are written once
//! and read the same in rustdoc and in the header. The header is checked into the tree
//! and drift-checked in CI so it can never fall behind the Rust source, and the whole
//! `src` directory is watched so a new module keeps that true.
//!
//! The header is only refreshed when the crate is built from the zero-server workspace
//! checkout, never when it is consumed as a published dependency, where the source lives
//! in a registry cache that must not be mutated. Without `ZERO_FFI_HEADER_STRICT` the
//! refresh is best-effort, so a read-only source tree (for example on docs.rs) cannot
//! fail the build; with it set, as CI sets it, a header that cannot be generated or
//! written fails the build.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The environment variable that turns a header that cannot be generated or written
/// into a build error.
const STRICT: &str = "ZERO_FFI_HEADER_STRICT";

fn main() -> ExitCode {
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=cbindgen.toml");
    println!("cargo:rerun-if-env-changed={STRICT}");

    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Cargo does not pass CARGO_PRIMARY_PACKAGE to a build script, only to the rustc
    // invocations it drives, so the workspace root is what tells a source-tree build
    // from a build of the published crate.
    if !in_workspace_checkout(&crate_dir) {
        return ExitCode::SUCCESS;
    }
    let strict = std::env::var_os(STRICT).is_some_and(|value| !value.is_empty());
    match refresh(&crate_dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(problem) if strict => {
            eprintln!("zero-ffi: {problem}");
            ExitCode::FAILURE
        }
        Err(problem) => {
            println!("cargo:warning={problem}");
            ExitCode::SUCCESS
        }
    }
}

/// Generates the header and writes it when its bytes differ from the committed file.
///
/// # Arguments
///
/// * `crate_dir` - this crate's manifest directory.
///
/// # Errors
///
/// The configuration or the crate documentation cannot be read, cbindgen cannot
/// generate the header, or the header cannot be written.
fn refresh(crate_dir: &Path) -> Result<(), String> {
    let config = cbindgen::Config::from_file(crate_dir.join("cbindgen.toml"))
        .map_err(|error| format!("cannot read cbindgen.toml: {error}"))?;
    let lib = fs::read_to_string(crate_dir.join("src").join("lib.rs"))
        .map_err(|error| format!("cannot read src/lib.rs: {error}"))?;
    let bindings = cbindgen::Builder::new()
        .with_crate(crate_dir)
        .with_config(config)
        .with_header(header_comment(&lib))
        .generate()
        .map_err(|error| format!("cbindgen could not generate the header: {error}"))?;
    let mut rendered = Vec::new();
    bindings.write(&mut rendered);

    let include = crate_dir.join("include");
    let header_path = include.join("zero.h");
    if fs::read(&header_path).is_ok_and(|existing| existing == rendered) {
        return Ok(());
    }
    fs::create_dir_all(&include)
        .and_then(|()| fs::write(&header_path, &rendered))
        .map_err(|error| format!("could not write {}: {error}", header_path.display()))
}

/// Renders the crate documentation of `lib.rs` as the C comment that opens the header.
///
/// # Arguments
///
/// * `lib` - the text of `src/lib.rs`.
///
/// # Returns
///
/// The comment: the leading `//!` lines, each behind ` * `, inside `/*` and `*/`, with
/// any `*/` in the text broken so the comment cannot end early.
fn header_comment(lib: &str) -> String {
    let mut comment = String::from("/*");
    for line in lib.lines().take_while(|line| line.starts_with("//!")) {
        let text = line
            .trim_start_matches("//!")
            .strip_prefix(' ')
            .unwrap_or_else(|| line.trim_start_matches("//!"))
            .replace("*/", "* /");
        comment.push('\n');
        if text.is_empty() {
            comment.push_str(" *");
        } else {
            comment.push_str(" * ");
            comment.push_str(&text);
        }
    }
    comment.push_str("\n */");
    comment
}

/// Reports whether `crate_dir` sits inside the zero-server workspace checkout.
///
/// # Arguments
///
/// * `crate_dir` - this crate's manifest directory.
///
/// # Returns
///
/// `true` when the grandparent directory holds the workspace manifest, which is
/// the layout of the git checkout and never that of an extracted registry package.
fn in_workspace_checkout(crate_dir: &Path) -> bool {
    let Some(root) = crate_dir.parent().and_then(Path::parent) else {
        return false;
    };
    fs::read_to_string(root.join("Cargo.toml"))
        .map(|manifest| manifest.contains("[workspace]"))
        .unwrap_or(false)
}
