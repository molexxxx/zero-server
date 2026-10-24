//! Every host access to a slot's payload goes through one module: no source in the
//! workspace calls a slot's host read, host write or published view outside
//! `crates/zero-host/src/access.rs`, apart from the runtime's own tests. The scan reads
//! every Rust source under the repository root and looks for those methods called on a
//! slot, as a method or through a path other than the access module's.

use std::fs;
use std::path::{Path, PathBuf};

/// The one module that calls the slot methods.
const ACCESS: &str = "crates/zero-host/src/access.rs";

/// The slot methods only the access module calls, each with its opening parenthesis,
/// assembled at run time so this file does not hold them itself.
fn needles() -> [String; 3] {
    ["with_read", "with_write", "read_view"].map(|name| format!("{name}("))
}

/// The repository root: two levels above this crate's manifest.
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate sits two levels below the root")
        .to_path_buf()
}

/// Every `.rs` file under `dir`, leaving out build output and version control.
fn collect(dir: &Path, into: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|err| panic!("reading {dir:?}: {err}"));
    for entry in entries {
        let path = entry.expect("a directory entry").path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if !matches!(name, "target" | ".git" | "node_modules") {
                collect(&path, into);
            }
        } else if name.ends_with(".rs") {
            into.push(path);
        }
    }
}

/// Whether the text before a needle makes it a call on a slot: a method call, or a
/// path whose last segment is not `access`.
fn slot_call(before: &str) -> bool {
    if before.ends_with('.') {
        return true;
    }
    match before.strip_suffix("::") {
        Some(path) => {
            let segment = path
                .rsplit(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .next()
                .unwrap_or("");
            segment != "access"
        }
        None => false,
    }
}

/// The first line of `text` that belongs to the runtime's tests, when the file is the
/// runtime's: every line of its integration tests and loom models, and the lines from
/// a source file's `#[cfg(test)]` module on.
fn tests_from(relative: &str, text: &str) -> Option<usize> {
    if relative.starts_with("crates/zero-rt/tests/")
        || relative == "crates/zero-rt/src/loom_tests.rs"
    {
        return Some(0);
    }
    if relative.starts_with("crates/zero-rt/src/") {
        return text.lines().position(|line| line.trim() == "#[cfg(test)]");
    }
    None
}

#[test]
fn only_the_access_module_calls_a_slots_host_read_host_write_or_published_view() {
    let root = root();
    let mut files = Vec::new();
    collect(&root, &mut files);
    let needles = needles();
    let mut seen_in_access = [false; 3];
    let mut offenders = Vec::new();
    for file in &files {
        let relative = file
            .strip_prefix(&root)
            .expect("under the root")
            .to_string_lossy()
            .replace('\\', "/");
        let text =
            fs::read_to_string(file).unwrap_or_else(|err| panic!("reading {relative}: {err}"));
        let tests = tests_from(&relative, &text);
        for (number, line) in text.lines().enumerate() {
            for (which, needle) in needles.iter().enumerate() {
                for (at, _) in line.match_indices(needle.as_str()) {
                    if !slot_call(&line[..at]) {
                        continue;
                    }
                    if relative == ACCESS {
                        seen_in_access[which] = true;
                    } else if !tests.is_some_and(|from| number >= from) {
                        offenders.push(format!("{relative}:{}: {}", number + 1, line.trim()));
                    }
                }
            }
        }
    }
    assert!(
        files.len() > 100,
        "the scan read {} files from {root:?}",
        files.len()
    );
    assert_eq!(
        seen_in_access, [true; 3],
        "the scan finds the access module's own calls"
    );
    assert!(
        offenders.is_empty(),
        "slot payload access outside {ACCESS}:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_scan_tells_a_call_on_a_slot_from_a_call_of_the_access_helpers() {
    assert!(slot_call("slot."));
    assert!(slot_call("        ."));
    assert!(slot_call("let read = Slot::"));
    assert!(slot_call("<Slot<HostExchange>>::"));
    assert!(!slot_call("zero_host::access::"));
    assert!(!slot_call("crate::access::"));
    assert!(!slot_call("pub fn "));
    assert!(!slot_call("    "));
}
