//! The binding probes, rerun on Linux. Each language's probe measures what a
//! call across its boundary costs (a bare call, a borrowed slice, an owned
//! string, an opaque handle, a callback into the host, a batched callback) and
//! the budgets the bindings are held to are restated from those numbers. The
//! host is a Windows desktop, so `cargo xtask probes` runs each probe in that
//! language's official Linux container and writes what it printed to
//! `bench/probes/rerun-<lang>-linux.txt`.
//!
//! The sources live under `bench/probes/<lang>/`: the probe script or project
//! beside the small native crate it loads. The images ship no Rust toolchain,
//! so the script installs one into two named volumes on the first run and
//! reuses it afterwards; the native crates build into `/tmp` and the repository
//! mount is only read, except for the result file, which is written here on
//! the host.

use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

/// The memory cap every container runs under.
const MEMORY: &str = "3g";

/// The process cap every container runs under.
const PIDS: &str = "400";

/// The named volumes that keep the toolchain and the registry between runs.
const VOLUMES: [(&str, &str); 2] = [
    ("zero-core-probe-cargo", "/root/.cargo"),
    ("zero-core-probe-rustup", "/root/.rustup"),
];

/// The part of every script that provides a Rust toolchain and a C linker. It
/// writes only to stderr, so the probe's own output is all that reaches stdout.
const TOOLCHAIN: &str = "if ! command -v cc >/dev/null 2>&1; then \
    apt-get update >&2 && apt-get install -y --no-install-recommends gcc libc6-dev >&2; fi; \
if [ ! -x \"$HOME/.cargo/bin/cargo\" ]; then \
    curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >&2; fi; \
. \"$HOME/.cargo/env\"; ";

/// One probe: where it runs, what it needs, and how it is built and started.
struct Probe {
    /// The language, which names the result file.
    lang: &'static str,
    /// The official image the probe runs in.
    image: &'static str,
    /// The files under the repository the probe needs, checked before Docker
    /// runs so a missing source is reported by name.
    sources: &'static [&'static str],
    /// The shell script run in the container after [`TOOLCHAIN`].
    script: &'static str,
}

/// The three probes, in the order they run.
const PROBES: [Probe; 3] = [
    Probe {
        lang: "node",
        image: "node:24",
        sources: &[
            "bench/probes/node/bench-probe.js",
            "bench/probes/node/napi-probe/Cargo.toml",
            "bench/probes/node/napi-probe/build.rs",
            "bench/probes/node/napi-probe/src/lib.rs",
        ],
        script: "cp -r /work/bench/probes/node /tmp/probe; \
            cd /tmp/probe/napi-probe && cargo build --release >&2; \
            cp /tmp/t/release/libnapi_probe.so /tmp/probe/napi-probe/probe.node; \
            node /tmp/probe/bench-probe.js",
    },
    Probe {
        lang: "python",
        image: "python:3.13",
        sources: &[
            "bench/probes/python/bench_probe.py",
            "bench/probes/python/pyo3-probe/Cargo.toml",
            "bench/probes/python/pyo3-probe/src/lib.rs",
        ],
        script: "cp -r /work/bench/probes/python /tmp/probe; \
            cd /tmp/probe/pyo3-probe && cargo build --release >&2; \
            cp /tmp/t/release/libpyo3_probe.so /tmp/probe/pyo3-probe/pyo3_probe.so; \
            python /tmp/probe/bench_probe.py",
    },
    Probe {
        lang: "dotnet",
        image: "mcr.microsoft.com/dotnet/sdk:10.0",
        sources: &[
            "bench/probes/dotnet/pinvoke-bench/pinvoke-bench.csproj",
            "bench/probes/dotnet/pinvoke-bench/Program.cs",
            "bench/probes/dotnet/ffi-probe/Cargo.toml",
            "bench/probes/dotnet/ffi-probe/src/lib.rs",
            "crates/zero-ffi/Cargo.toml",
        ],
        script: "cp -r /work/bench/probes/dotnet /tmp/probe; \
            cd /tmp/probe/ffi-probe && cargo build --release >&2; \
            cd /work && cargo build -p zero-ffi --release >&2; \
            cd /tmp/probe/pinvoke-bench && dotnet build -c Release -o /tmp/pb >&2; \
            cp /tmp/t/release/libffi_probe.so /tmp/t/release/libzero_ffi.so /tmp/pb/; \
            dotnet /tmp/pb/pinvoke-bench.dll",
    },
];

/// Run `cargo xtask probes [node|python|dotnet]...`.
///
/// # Arguments
///
/// * `args` - the probes to run; none selects all three.
///
/// # Returns
///
/// Success when every selected probe ran and its result file was written.
/// A missing source is reported by path and nothing runs.
pub fn run(args: &[String]) -> ExitCode {
    let root = crate::docs::repo_root();
    let selected = match select(args) {
        Ok(selected) => selected,
        Err(message) => {
            eprintln!("xtask probes: {message}");
            return ExitCode::FAILURE;
        }
    };

    let missing = missing_sources(&root, &selected);
    if !missing.is_empty() {
        eprintln!(
            "xtask probes: {} source file(s) are missing:",
            missing.len()
        );
        for path in &missing {
            eprintln!("  {path}");
        }
        eprintln!("copy the probe sources under bench/probes/<lang>/ and retry");
        return ExitCode::FAILURE;
    }

    if !super::run(Command::new("docker").arg("--version")) {
        eprintln!("xtask probes: Docker is required (Docker Desktop); install it and retry.");
        return ExitCode::FAILURE;
    }

    for probe in selected {
        if let Err(message) = execute(&root, probe) {
            eprintln!("xtask probes: {message}");
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

/// The probes the arguments name, or all of them.
fn select(args: &[String]) -> Result<Vec<&'static Probe>, String> {
    if args.is_empty() {
        return Ok(PROBES.iter().collect());
    }
    args.iter()
        .map(|arg| {
            PROBES
                .iter()
                .find(|probe| probe.lang == arg)
                .ok_or_else(|| format!("unknown probe {arg}; use node, python, or dotnet"))
        })
        .collect()
}

/// Every source file a selected probe needs that is not on disk.
fn missing_sources(root: &Path, selected: &[&Probe]) -> Vec<String> {
    selected
        .iter()
        .flat_map(|probe| probe.sources.iter())
        .filter(|path| !root.join(path).is_file())
        .map(|path| (*path).to_owned())
        .collect()
}

/// Run one probe in its container and write what it printed.
fn execute(root: &Path, probe: &Probe) -> Result<(), String> {
    let mount = format!("{}:/work", root.display().to_string().replace('\\', "/"));
    let script = format!("set -e; {TOOLCHAIN}{}", probe.script);
    println!(
        "xtask probes: running the {} probe in {}\n",
        probe.lang, probe.image
    );

    let mut command = Command::new("docker");
    command.args([
        "run",
        "--rm",
        &format!("--memory={MEMORY}"),
        &format!("--pids-limit={PIDS}"),
        "-e",
        "CARGO_TARGET_DIR=/tmp/t",
        "-v",
        &mount,
    ]);
    for (volume, path) in VOLUMES {
        command.args(["-v", &format!("{volume}:{path}")]);
    }
    command
        .args(["-w", "/work", probe.image, "bash", "-c", &script])
        .stderr(Stdio::inherit());
    let output = command
        .output()
        .map_err(|err| format!("could not run docker: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "the {} probe failed ({})",
            probe.lang, output.status
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n");
    if text.trim().is_empty() {
        return Err(format!("the {} probe printed nothing", probe.lang));
    }
    let target = root
        .join("bench/probes")
        .join(format!("rerun-{}-linux.txt", probe.lang));
    fs::create_dir_all(target.parent().unwrap_or(root))
        .map_err(|err| format!("creating bench/probes: {err}"))?;
    fs::write(&target, &text).map_err(|err| format!("writing {}: {err}", target.display()))?;
    print!("{text}");
    println!(
        "\nxtask probes: wrote bench/probes/rerun-{}-linux.txt ({} lines)\n",
        probe.lang,
        text.lines().count()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_argument_selects_every_probe_and_a_name_selects_one() {
        let all = select(&[]).unwrap();
        assert_eq!(all.len(), PROBES.len());
        let one = select(&["python".to_owned()]).unwrap();
        assert_eq!(one[0].lang, "python");
        assert!(select(&["ruby".to_owned()]).is_err());
    }

    #[test]
    fn missing_sources_are_named_by_path() {
        let root = std::env::temp_dir().join(format!("zero-core-probes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("bench/probes/python")).unwrap();
        fs::write(root.join("bench/probes/python/bench_probe.py"), "").unwrap();
        let selected = select(&["python".to_owned()]).unwrap();
        let missing = missing_sources(&root, &selected);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            missing,
            [
                "bench/probes/python/pyo3-probe/Cargo.toml",
                "bench/probes/python/pyo3-probe/src/lib.rs"
            ]
        );
    }

    #[test]
    fn every_script_sends_its_build_output_to_stderr() {
        for probe in &PROBES {
            assert!(
                probe.script.contains("cargo build --release >&2"),
                "{}",
                probe.lang
            );
            assert!(!probe.sources.is_empty(), "{}", probe.lang);
        }
    }
}
