//! Workspace task runner for zero-server.
//!
//! Run with `cargo xtask <task>`. The tasks cover the release (the crates.io
//! publish order and the lockstep version bump), the generated documentation
//! and site, the lint tables and the standards register the workspace is held
//! to, the binding package manifests, and the binding probes that run in
//! Docker.

use std::path::Path;
use std::process::{Command, ExitCode};

mod builds;
mod catalog;
mod docs;
mod licenses;
mod links;
mod lints;
mod packages;
mod probes;
mod regions;
mod release;
mod site;
mod standards;
mod version;

/// The tasks xtask knows about, each paired with a one-line description.
const TASKS: &[(&str, &str)] = &[
    (
        "release",
        "publish the workspace crates to crates.io in dependency order (release [--plan|--dry-run])",
    ),
    (
        "version",
        "set or check the version every manifest carries (version [<x.y.z>|--check [expected]])",
    ),
    (
        "builds",
        "report what each named feature set of the zero-server crate compiles, and the built engine sizes",
    ),
    (
        "docs",
        "regenerate the crate READMEs and the generated regions in the Markdown pages (docs [--check])",
    ),
    (
        "site",
        "render the documentation site into target/site (site [--out <dir>] | site --verify [<dir>])",
    ),
    (
        "links",
        "fetch every document the standards register cites and fail on anything that is not 200",
    ),
    (
        "standards",
        "check the standards register against the tests it cites, up to the current release (standards [--check])",
    ),
    (
        "packages",
        "render the binding package manifests and READMEs from the capability map (packages [--check])",
    ),
    (
        "lints",
        "diff every member manifest's [lints] table against the table docs/capabilities.toml names (lints [--check])",
    ),
    (
        "probes",
        "run the binding probes in Docker and write bench/probes/rerun-<lang>-linux.txt (probes [node|python|dotnet]...)",
    ),
];

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(task) = args.next() else {
        help();
        return ExitCode::SUCCESS;
    };
    let rest: Vec<String> = args.collect();

    match task.as_str() {
        "release" => release::run(&rest),
        "version" => version::run(&rest),
        "builds" => match builds::report(&docs::repo_root()) {
            Ok(report) => {
                print!("{report}");
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("xtask builds: {err}");
                ExitCode::FAILURE
            }
        },
        "docs" => docs::run(&rest),
        "site" => site::run(&rest),
        "links" => links::run(&docs::repo_root()),
        "standards" => standards::run(&rest),
        "packages" => packages::run(&rest),
        "lints" => lints::run(&rest),
        "probes" => probes::run(&rest),
        "minify" => minify(&rest),
        _ => {
            eprintln!("unknown task: {task}\n");
            help();
            ExitCode::FAILURE
        }
    }
}

/// Minify every stylesheet and script under a directory in place; the site task
/// does this as part of rendering, and this is the escape hatch for a tree the
/// generators produced.
fn minify(args: &[String]) -> ExitCode {
    let [dir] = args else {
        eprintln!("usage: cargo xtask minify <dir>");
        return ExitCode::FAILURE;
    };
    match site::minify::directory(Path::new(dir)) {
        Ok(done) => {
            for (path, before, after) in &done {
                println!("minify: {path} {before} -> {after} bytes");
            }
            println!("minify: {} file(s) under {dir}", done.len());
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("xtask minify: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Run a command, streaming its output, and report whether it succeeded.
fn run(command: &mut Command) -> bool {
    match command.status() {
        Ok(status) => status.success(),
        Err(err) => {
            eprintln!("could not run {:?}: {err}", command.get_program());
            false
        }
    }
}

fn help() {
    println!("zero-server xtask");
    println!("usage: cargo xtask <task>\n");
    println!("tasks:");
    for (name, description) in TASKS {
        println!("  {name:<10} {description}");
    }
}
