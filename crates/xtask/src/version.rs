//! The workspace version: `cargo xtask version <version>` rewrites every manifest
//! that carries it and refreshes the files derived from them; `cargo xtask
//! version --check [expected]` reads them all back and fails on any drift.
//!
//! A version is `x.y.z` or a pre-release of it: `x.y.z-alpha.N`, `x.y.z-beta.N` or
//! `x.y.z-rc.N`. crates.io, npm, NuGet and PyPI all carry the same version, so only
//! the pre-release phases that map one to one onto PEP 440 and keep the same order
//! under it are accepted, and each file holds the spelling its own tooling reads:
//! SemVer in the Cargo, npm and NuGet manifests and in prose, the normalized PEP 440
//! form in the Python manifests and in a pip requirement (`2.0.0-alpha.1` is
//! `2.0.0a1` there), and an exact requirement on a sibling crate while the version
//! is a pre-release.
//!
//! Every file is found by pattern rather than listed, so a new crate, binding,
//! or platform package is covered the moment it exists.

use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use toml_edit::{DocumentMut, Item, TableLike, Value};

/// The command line, for the usage errors.
const USAGE: &str = "version [<x.y.z>[-alpha.N|-beta.N|-rc.N] | --check [expected]]";

/// The pre-release phases a version may carry, each with the letter PEP 440
/// normalizes its name to.
///
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-release-spelling>
const PHASES: [(&str, &str); 3] = [("alpha", "a"), ("beta", "b"), ("rc", "rc")];

/// The prefix shared by every crate in the workspace; a dependency with this
/// prefix is pinned to the workspace version.
const CRATE_PREFIX: &str = "zero-";

/// The name every Python distribution of this repository starts with, and the
/// name of its metapackage.
const PYTHON_PREFIX: &str = "zero-server";

/// The prose that names the released version: the README's install lines and the
/// release runbook, which reads as a sequence to copy. Neither is generated, so both
/// went stale until the bump rewrote them.
const PROSE_SITES: [&str; 2] = ["README.md", "docs/about/releasing.md"];

/// The loader napi-rs generates carries the version it was built for in two
/// places per platform package: the comparison and the mismatch message. The
/// text on either side of the version at each.
const LOADER_SITES: [(&str, &str); 2] = [
    ("bindingPackageVersion !== '", "'"),
    ("expected ", " but got"),
];

/// Run `cargo xtask version [<version> | --check [expected]]`.
///
/// With no argument the workspace version is printed. With a version, every
/// manifest is rewritten to it, the cargo and npm lockfiles are refreshed, the
/// generated Node loader is updated, and the check runs. With `--check`, every
/// version-bearing file is read and compared with the workspace version in the
/// spelling that file uses; with a version after `--check`, also with that, and
/// the CHANGELOG entry of that version must carry its release date.
pub fn run(args: &[String]) -> ExitCode {
    let root = repo_root();
    let result = match args.first().map(String::as_str) {
        None => current().map(|version| println!("{version}")),
        Some("--check") => {
            let expected = args.get(1).map(String::as_str);
            check(&root, expected, expected.is_some())
        }
        Some(flag) if flag.starts_with('-') => Err(format!("unknown flag {flag}; usage: {USAGE}")),
        Some(version) => bump(&root, version),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("xtask version: {message}");
            ExitCode::FAILURE
        }
    }
}

/// How a file spells the workspace version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Spelling {
    /// As SemVer writes it, and with it Cargo, npm and NuGet: `2.0.0-alpha.1`.
    SemVer,
    /// The normalized PEP 440 form PyPI, pip, hatchling and maturin use: `2.0.0a1`.
    ///
    /// @see <https://packaging.python.org/en/latest/specifications/pyproject-toml/#version>
    Pep440,
    /// A Cargo requirement on a sibling crate: a caret requirement for a final
    /// version, and an exact one for a pre-release, since a caret requirement on a
    /// pre-release also matches every later pre-release of the same `x.y.z` and the
    /// crates of one pre-release are only known to work with each other.
    ///
    /// @see <https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#pre-releases>
    CargoPin,
}

impl Spelling {
    /// The workspace version as this spelling writes it.
    ///
    /// # Arguments
    ///
    /// * `version` - the workspace version, in SemVer.
    ///
    /// # Returns
    ///
    /// The text a file in this spelling carries for `version`.
    ///
    /// # Errors
    ///
    /// Returns the reason when `version` is not a version this repository releases.
    fn of(self, version: &str) -> Result<String, String> {
        let parts = parse(version)?;
        Ok(match (self, parts.pre) {
            (Spelling::SemVer, _) | (Spelling::CargoPin, None) => version.to_owned(),
            (Spelling::Pep440, None) => parts.release.to_owned(),
            (Spelling::Pep440, Some((letter, number))) => {
                format!("{}{letter}{number}", parts.release)
            }
            (Spelling::CargoPin, Some(_)) => format!("={version}"),
        })
    }
}

/// The PEP 440 spelling of a version, the form PyPI and the Python build backends
/// normalize to: the separators are dropped and the phase is shortened, so
/// `2.0.0-alpha.1` is `2.0.0a1`, and a final version is unchanged.
///
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-release-separators>
///
/// # Arguments
///
/// * `version` - `x.y.z`, optionally followed by `-alpha.N`, `-beta.N` or `-rc.N`.
///
/// # Returns
///
/// The normalized PEP 440 version.
///
/// # Errors
///
/// Returns the reason when `version` is not of that form.
pub(crate) fn pep440(version: &str) -> Result<String, String> {
    Spelling::Pep440.of(version)
}

/// A version taken apart: the `x.y.z` release, and the PEP 440 letter and number
/// of its pre-release phase when it has one.
struct Parts<'a> {
    release: &'a str,
    pre: Option<(&'static str, &'a str)>,
}

/// Take a version apart, refusing any shape one of the registries cannot carry.
///
/// SemVer build metadata is refused because its only PEP 440 counterpart is a local
/// version, which PyPI does not accept. A pre-release other than `alpha.N`, `beta.N`
/// or `rc.N` is refused because no other phase maps one to one and keeps its order:
/// PEP 440 spells `c`, `pre` and `preview` all as `rcN`, so `2.0.0-pre.1` and
/// `2.0.0-rc.1` would be two versions on crates.io, npm and NuGet but one on PyPI,
/// and it sorts a development release before the alpha, where SemVer's ASCII order
/// puts `dev` after `beta`.
///
/// @see <https://semver.org/spec/v2.0.0.html>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-release-spelling>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#developmental-releases>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#local-version-identifiers>
fn parse(version: &str) -> Result<Parts<'_>, String> {
    if version.contains('+') {
        return Err(format!(
            "{version} carries build metadata, which PEP 440 reads as a local version and PyPI refuses"
        ));
    }
    let (release, pre) = match version.split_once('-') {
        Some((release, pre)) => (release, Some(pre)),
        None => (version, None),
    };
    let numbers: Vec<&str> = release.split('.').collect();
    if numbers.len() != 3 || !numbers.iter().all(|number| is_number(number)) {
        return Err(format!(
            "{version} is not a version of the form x.y.z, three numbers without leading zeros"
        ));
    }
    let Some(pre) = pre else {
        return Ok(Parts { release, pre: None });
    };
    let phase = pre.split_once('.').and_then(|(phase, number)| {
        let (_, letter) = PHASES.iter().find(|(name, _)| *name == phase)?;
        is_number(number).then_some((*letter, number))
    });
    match phase {
        Some(phase) => Ok(Parts {
            release,
            pre: Some(phase),
        }),
        None => Err(format!(
            "{version} has the pre-release `{pre}`; a pre-release is alpha.N, beta.N or rc.N, \
             the only phases that map one to one onto PEP 440 and sort in the same order \
             there, so that every registry carries the same version"
        )),
    }
}

/// A SemVer numeric identifier: ASCII digits with no leading zero, `0` aside.
fn is_number(text: &str) -> bool {
    !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'))
}

/// One version read from a file, named well enough to act on a mismatch.
struct Reading {
    file: PathBuf,
    what: String,
    version: String,
    spelling: Spelling,
}

/// The workspace version, from `[workspace.package]` in the root manifest.
pub(crate) fn current() -> Result<String, String> {
    workspace_version(&repo_root())
}

/// The workspace version of the tree at `root`.
fn workspace_version(root: &Path) -> Result<String, String> {
    let path = root.join("Cargo.toml");
    let doc = parse_toml(&path)?;
    doc.get("workspace")
        .and_then(Item::as_table_like)
        .and_then(|workspace| workspace.get("package"))
        .and_then(Item::as_table_like)
        .and_then(|package| package.get("version"))
        .and_then(Item::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Cargo.toml has no workspace.package.version".to_owned())
}

/// Compare every version-bearing file of the tree at `root` with its workspace
/// version, each in the spelling that file uses, listing each disagreement. A
/// `release` check, the one the release workflows run with the tag's version,
/// also requires the CHANGELOG entry of that version to carry its release date,
/// `## [<version>] - YYYY-MM-DD` as Keep a Changelog writes it, so an entry still
/// marked unreleased cannot ship.
///
/// @see <https://keepachangelog.com/en/1.1.0/>
fn check(root: &Path, expected: Option<&str>, release: bool) -> Result<(), String> {
    let version = workspace_version(root)?;
    parse(&version).map_err(|err| format!("Cargo.toml: workspace.package.version: {err}"))?;
    let mut problems = Vec::new();

    if let Some(expected) = expected {
        if expected != version {
            problems.push(format!(
                "Cargo.toml: workspace.package.version is {version}, expected {expected}"
            ));
        }
    }

    for reading in readings(root)? {
        let wanted = reading.spelling.of(&version)?;
        if reading.version != wanted {
            problems.push(format!(
                "{}: {} is {}, expected {wanted}",
                display(&reading.file),
                reading.what,
                reading.version
            ));
        }
    }

    let changelog = read(&root.join("CHANGELOG.md"))?;
    let heading = format!("## [{version}]");
    match changelog.lines().find(|line| line.starts_with(&heading)) {
        None => problems.push(format!("CHANGELOG.md: no `{heading}` entry")),
        Some(line) if release && !is_dated(line.get(heading.len()..).unwrap_or_default()) => {
            problems.push(format!(
                "CHANGELOG.md: the `{heading}` entry has no release date; write `{heading} - YYYY-MM-DD`"
            ));
        }
        Some(_) => {}
    }

    if problems.is_empty() {
        println!("xtask version: every manifest, lockfile, and generated file is at {version}");
        Ok(())
    } else {
        Err(format!(
            "{} place(s) disagree with the workspace version {version}:\n  {}",
            problems.len(),
            problems.join("\n  ")
        ))
    }
}

/// Whether the rest of a CHANGELOG heading after `## [<version>]` is ` - YYYY-MM-DD`
/// with a month from 01 to 12 and a day from 01 to 31.
fn is_dated(rest: &str) -> bool {
    let Some(date) = rest.strip_prefix(" - ") else {
        return false;
    };
    let date = date.trim_end();
    let bytes = date.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .filter(|part| part.iter().all(u8::is_ascii_digit))
            .and_then(|part| std::str::from_utf8(part).ok())
            .and_then(|part| part.parse::<u32>().ok())
    };
    bytes.len() == 10
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && digits(0..4).is_some()
        && digits(5..7).is_some_and(|month| (1..=12).contains(&month))
        && digits(8..10).is_some_and(|day| (1..=31).contains(&day))
}

/// Rewrite every manifest of the tree at `root` to `new`, each in its own spelling,
/// refresh the derived files, and check. The old version is read before the root
/// manifest is rewritten, since the prose is matched against it.
fn bump(root: &Path, new: &str) -> Result<(), String> {
    validate(new)?;
    let old = workspace_version(root)?;
    let pin = Spelling::CargoPin.of(new)?;
    let python = Spelling::Pep440.of(new)?;
    println!("xtask version: {old} -> {new}");
    if python != new {
        println!("xtask version: the Python manifests carry it as {python}");
    }

    edit_toml(&root.join("Cargo.toml"), |doc| {
        let workspace = doc
            .get_mut("workspace")
            .and_then(Item::as_table_like_mut)
            .ok_or("no [workspace] table")?;
        let package = workspace
            .get_mut("package")
            .and_then(Item::as_table_like_mut)
            .ok_or("no [workspace.package] table")?;
        set_version(package, new)?;
        if let Some(deps) = workspace
            .get_mut("dependencies")
            .and_then(Item::as_table_like_mut)
        {
            set_dependency_versions(deps, &pin)?;
        }
        Ok(())
    })?;

    for manifest in crate_manifests(root)? {
        edit_toml(&manifest, |doc| {
            if let Some(package) = doc.get_mut("package").and_then(Item::as_table_like_mut) {
                if package.get("version").and_then(Item::as_str).is_some() {
                    set_version(package, new)?;
                }
            }
            for_each_dependency_table(doc, &mut |_, deps| set_dependency_versions(deps, &pin))
        })?;
    }

    for pyproject in pyprojects(root) {
        edit_toml(&pyproject, |doc| set_project_versions(doc, &python))?;
    }

    for package_json in package_manifests(root) {
        rewrite(&package_json, "\"version\": \"", "\"", new, 1)?;
        let text = read(&package_json)?;
        write(&package_json, &with_package_pins(&text, new))?;
    }

    for props in binding_files(root, "Directory.Build.props") {
        rewrite(&props, "<Version>", "</Version>", new, usize::MAX)?;
    }

    for loader in loader_files(root) {
        for (before, after) in LOADER_SITES {
            rewrite(&loader, before, after, new, usize::MAX)?;
        }
    }

    for site in PROSE_SITES {
        let path = root.join(site);
        let text = read(&path)?;
        write(&path, &with_prose_versions(&text, &old, new)?)?;
    }

    for lockfile in cargo_lockfiles(root) {
        let manifest = lockfile.with_file_name("Cargo.toml");
        println!("xtask version: refreshing {}", display(&lockfile));
        let mut cmd = Command::new("cargo");
        cmd.args(["update", "--workspace", "--manifest-path"])
            .arg(&manifest);
        if !super::run(&mut cmd) {
            return Err(format!("cargo update failed for {}", display(&lockfile)));
        }
    }

    for lockfile in binding_files(root, "package-lock.json") {
        let dir = lockfile.parent().ok_or("package-lock.json has no parent")?;
        println!("xtask version: refreshing {}", display(&lockfile));
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let mut cmd = Command::new(npm);
        cmd.args([
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(dir);
        if !super::run(&mut cmd) {
            return Err(format!("npm install failed for {}", display(&lockfile)));
        }
    }

    check(root, Some(new), false)
}

/// Read every version-bearing file of the tree at `root`.
fn readings(root: &Path) -> Result<Vec<Reading>, String> {
    let mut readings = Vec::new();

    let root_manifest = root.join("Cargo.toml");
    let doc = parse_toml(&root_manifest)?;
    if let Some(deps) = doc
        .get("workspace")
        .and_then(Item::as_table_like)
        .and_then(|workspace| workspace.get("dependencies"))
        .and_then(Item::as_table_like)
    {
        read_dependency_versions(
            &root_manifest,
            "workspace.dependencies",
            deps,
            false,
            &mut readings,
        )?;
    }

    for manifest in crate_manifests(root)? {
        let doc = parse_toml(&manifest)?;
        let package = doc.get("package").and_then(Item::as_table_like);
        if let Some(version) = package
            .and_then(|package| package.get("version"))
            .and_then(Item::as_str)
        {
            readings.push(reading(
                &manifest,
                "package.version",
                version,
                Spelling::SemVer,
            ));
        }
        let publishable = package
            .and_then(|package| package.get("publish"))
            .map(|publish| match publish {
                Item::Value(Value::Boolean(flag)) => *flag.value(),
                Item::Value(Value::Array(registries)) => !registries.is_empty(),
                _ => true,
            })
            .unwrap_or(true);
        for (section, deps) in dependency_tables(&doc) {
            let must_pin = publishable && !section.contains("dev-dependencies");
            read_dependency_versions(&manifest, &section, deps, must_pin, &mut readings)?;
        }
    }

    for lockfile in cargo_lockfiles(root) {
        let doc = parse_toml(&lockfile)?;
        let packages = doc
            .get("package")
            .and_then(Item::as_array_of_tables)
            .ok_or_else(|| format!("{} has no [[package]] entries", display(&lockfile)))?;
        for package in packages {
            if package.get("source").is_some() {
                continue;
            }
            let name = package.get("name").and_then(Item::as_str).unwrap_or("?");
            let version = package.get("version").and_then(Item::as_str).unwrap_or("?");
            readings.push(reading(
                &lockfile,
                &format!("package {name}"),
                version,
                Spelling::SemVer,
            ));
        }
    }

    for pyproject in pyprojects(root) {
        let doc = parse_toml(&pyproject)?;
        let versions = project_versions(&doc)
            .map_err(|message| format!("{}: {message}", display(&pyproject)))?;
        for (what, version) in versions {
            readings.push(reading(&pyproject, &what, &version, Spelling::Pep440));
        }
    }

    for package_json in package_manifests(root) {
        let version = json_version(&package_json, &[])?;
        readings.push(reading(
            &package_json,
            "version",
            &version,
            Spelling::SemVer,
        ));
        for (name, pinned) in package_pins(&package_json)? {
            readings.push(reading(
                &package_json,
                &format!("dependency {name}"),
                &pinned,
                Spelling::SemVer,
            ));
        }
    }

    for lockfile in binding_files(root, "package-lock.json") {
        let version = json_version(&lockfile, &[])?;
        readings.push(reading(&lockfile, "version", &version, Spelling::SemVer));
        let version = json_version(&lockfile, &["packages", ""])?;
        readings.push(reading(
            &lockfile,
            "packages[\"\"].version",
            &version,
            Spelling::SemVer,
        ));
    }

    for props in binding_files(root, "Directory.Build.props") {
        let versions = find_between(&read(&props)?, "<Version>", "</Version>");
        if versions.is_empty() {
            return Err(format!("{} has no <Version> element", display(&props)));
        }
        for version in versions {
            readings.push(reading(&props, "<Version>", &version, Spelling::SemVer));
        }
    }

    for loader in loader_files(root) {
        let text = read(&loader)?;
        let mut versions: Vec<String> = LOADER_SITES
            .iter()
            .flat_map(|(before, after)| find_between(&text, before, after))
            .collect();
        versions.sort();
        versions.dedup();
        if versions.is_empty() {
            return Err(format!(
                "{} names no version in its platform checks",
                display(&loader)
            ));
        }
        for version in versions {
            readings.push(reading(
                &loader,
                "the version the loader was generated for",
                &version,
                Spelling::SemVer,
            ));
        }
    }

    for site in PROSE_SITES {
        let path = root.join(site);
        let text = read(&path)?;
        let named = versions_in(&text);
        if named.is_empty() {
            return Err(format!("{} names no version", display(&path)));
        }
        for (version, spelling) in named {
            readings.push(reading(&path, "the version it names", &version, spelling));
        }
    }

    Ok(readings)
}

/// Every version a piece of prose names, each once, with the spelling its place in
/// the prose calls for.
fn versions_in(text: &str) -> Vec<(String, Spelling)> {
    let mut found: Vec<(String, Spelling)> = version_spans(text)
        .into_iter()
        .map(|(span, spelling)| (text[span].to_owned(), spelling))
        .collect();
    found.sort();
    found.dedup();
    found
}

/// The PEP 440 comparison operators a version in prose may follow to be read the
/// way pip reads a requirement. `===` ends in `==`; `<` and `>` alone are left out,
/// since in prose they more often close markup, as in NuGet's `<Version>`.
///
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#id5>
const REQUIREMENT_OPERATORS: [&str; 5] = ["==", "~=", ">=", "<=", "!="];

/// Every version in a piece of prose, as the byte range it covers and the spelling
/// its place calls for: the operand of a requirement operator is PEP 440, since pip
/// reads it, and every other mention is SemVer, so a PEP 440 spelling anywhere else,
/// such as `zero-server@2.0.0a1`, reads back as a version other than the workspace's.
/// A run of four or more numbers, such as an address, is not a version, and the
/// period that ends a sentence is not part of one.
fn version_spans(text: &str) -> Vec<(Range<usize>, Spelling)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let starts = bytes[at].is_ascii_digit() && (at == 0 || !is_release_byte(bytes[at - 1]));
        if !starts {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && is_release_byte(bytes[at]) {
            at += 1;
        }
        let mut end = at;
        while bytes[end - 1] == b'.' {
            end -= 1;
        }
        let parts: Vec<&str> = text[start..end].split('.').collect();
        if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
            continue;
        }
        let end = version_end(bytes, end);
        let spelling = if is_requirement_operand(text, start) {
            Spelling::Pep440
        } else {
            Spelling::SemVer
        };
        spans.push((start..end, spelling));
        at = at.max(end);
    }
    spans
}

/// Whether the version starting at `start` follows one of the requirement
/// operators, with the optional whitespace the specification allows between them.
///
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#id5>
fn is_requirement_operand(text: &str, start: usize) -> bool {
    let before = text[..start].trim_end_matches([' ', '\t']);
    REQUIREMENT_OPERATORS
        .iter()
        .any(|operator| before.ends_with(operator))
}

/// Where a version whose `x.y.z` ends at `end` stops: past a SemVer pre-release
/// (`-alpha.1`) or a PEP 440 one (`a1`), then a PEP 440 post-release and
/// development release (`.post2`, `.dev3`), then SemVer build metadata or a PEP 440
/// local version label (`+build.5`), so that a mention carrying any of them reads
/// back as the different version it is. A mention that still runs on past that
/// point is read to the end of the run, since PEP 440 also accepts other spellings
/// and separators (`2.0.0c1`, `2.0.0.rc1`, `2.0.0_rc1`) that name a version other
/// than the final `2.0.0`.
///
/// @see <https://semver.org/spec/v2.0.0.html>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#public-version-identifiers>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#local-version-identifiers>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-release-separators>
/// @see <https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-release-spelling>
fn version_end(bytes: &[u8], end: usize) -> usize {
    let mut end = if bytes.get(end) == Some(&b'-') {
        identifiers_end(bytes, end + 1).unwrap_or(end)
    } else {
        PHASES
            .iter()
            .find_map(|(_, letter)| numbered_end(bytes, end, letter))
            .unwrap_or(end)
    };
    for signifier in [".post", ".dev"] {
        end = numbered_end(bytes, end, signifier).unwrap_or(end);
    }
    if bytes.get(end) == Some(&b'+') {
        end = identifiers_end(bytes, end + 1).unwrap_or(end);
    }
    run_on_end(bytes, end)
}

/// Where the run that continues a version at `at` stops: an ASCII letter or digit
/// continues it, and so does a `.`, `-`, `_` or `+` followed by one, while the period
/// that ends a sentence does not.
fn run_on_end(bytes: &[u8], mut at: usize) -> usize {
    let continues = |b: Option<&u8>| b.is_some_and(u8::is_ascii_alphanumeric);
    loop {
        match bytes.get(at) {
            Some(b) if b.is_ascii_alphanumeric() => at += 1,
            Some(b'.' | b'-' | b'_' | b'+') if continues(bytes.get(at + 1)) => at += 2,
            _ => return at,
        }
    }
}

/// Where the dot-separated identifiers of ASCII letters, digits and hyphens that
/// start at `start` stop, or `None` when none starts there.
fn identifiers_end(bytes: &[u8], start: usize) -> Option<usize> {
    let identifier = |b: &u8| b.is_ascii_alphanumeric() || *b == b'-';
    let mut at = start;
    let mut stop = None;
    while bytes.get(at).is_some_and(identifier) {
        while bytes.get(at).is_some_and(identifier) {
            at += 1;
        }
        stop = Some(at);
        if bytes.get(at) == Some(&b'.') && bytes.get(at + 1).is_some_and(identifier) {
            at += 1;
        }
    }
    stop
}

/// Where `signifier` and the number after it stop when they start at `at`, or
/// `None` when they do not, or when a letter or digit runs on past the number.
fn numbered_end(bytes: &[u8], at: usize, signifier: &str) -> Option<usize> {
    let after = at + signifier.len();
    if bytes.get(at..after) != Some(signifier.as_bytes()) {
        return None;
    }
    let digits = bytes[after..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    let bounded = !bytes
        .get(after + digits)
        .is_some_and(u8::is_ascii_alphanumeric);
    (digits > 0 && bounded).then_some(after + digits)
}

/// Whether a byte can sit inside the `x.y.z` of a version, for `version_spans`.
fn is_release_byte(b: u8) -> bool {
    b.is_ascii_digit() || b == b'.'
}

/// Rewrite every whole mention of the `old` version in prose to `new`, each in the
/// spelling its place calls for, leaving any other version, and a mention in the
/// wrong spelling, for the check to report.
fn with_prose_versions(text: &str, old: &str, new: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (span, spelling) in version_spans(text) {
        let was = spelling.of(old).unwrap_or_else(|_| old.to_owned());
        if text[span.clone()] != *was {
            continue;
        }
        out.push_str(&text[copied..span.start]);
        out.push_str(&spelling.of(new)?);
        copied = span.end;
    }
    out.push_str(&text[copied..]);
    Ok(out)
}

/// Set `project.version` and every pin on a sibling distribution in a Python
/// project manifest to `python`, the PEP 440 spelling of the new version.
fn set_project_versions(doc: &mut DocumentMut, python: &str) -> Result<(), String> {
    let project = doc
        .get_mut("project")
        .and_then(Item::as_table_like_mut)
        .ok_or("no [project] table")?;
    set_version(project, python)?;
    if let Some(deps) = project.get_mut("dependencies").and_then(Item::as_array_mut) {
        for entry in deps.iter_mut() {
            let Some(pinned) = entry
                .as_str()
                .and_then(python_pin)
                .map(|(name, _)| format!("{name}=={python}"))
            else {
                continue;
            };
            replace_value(entry, &pinned);
        }
    }
    Ok(())
}

/// The versions a Python project manifest carries, as (what, version): its own and
/// each of its pins on a sibling distribution.
fn project_versions(doc: &DocumentMut) -> Result<Vec<(String, String)>, String> {
    let project = doc.get("project").and_then(Item::as_table_like);
    let version = project
        .and_then(|project| project.get("version"))
        .and_then(Item::as_str)
        .ok_or("no project.version")?;
    let mut versions = vec![("project.version".to_owned(), version.to_owned())];
    let deps = project
        .and_then(|project| project.get("dependencies"))
        .and_then(Item::as_array);
    for spec in deps.into_iter().flat_map(|deps| deps.iter()) {
        if let Some((name, pinned)) = spec.as_str().and_then(python_pin) {
            versions.push((format!("dependency {name}"), pinned.to_owned()));
        }
    }
    Ok(versions)
}

/// Record the pinned version of every workspace dependency in one table.
///
/// With `must_pin`, an unpinned workspace dependency is an error: crates.io
/// rejects a publish whose path dependency carries no version.
fn read_dependency_versions(
    file: &Path,
    section: &str,
    deps: &dyn TableLike,
    must_pin: bool,
    readings: &mut Vec<Reading>,
) -> Result<(), String> {
    for (key, item) in deps.iter() {
        let name = item
            .as_table_like()
            .and_then(|dep| dep.get("package"))
            .and_then(Item::as_str)
            .unwrap_or(key);
        if !name.starts_with(CRATE_PREFIX) {
            continue;
        }
        let what = format!("{section}.{key}.version");
        if let Some(version) = item.as_str() {
            readings.push(reading(file, &what, version, Spelling::CargoPin));
            continue;
        }
        let Some(dep) = item.as_table_like() else {
            continue;
        };
        if dep.get("workspace").and_then(Item::as_bool) == Some(true) {
            continue;
        }
        match dep.get("version").and_then(Item::as_str) {
            Some(version) => readings.push(reading(file, &what, version, Spelling::CargoPin)),
            None if must_pin => {
                return Err(format!(
                    "{}: {section}.{key} has no version, so the crate cannot be published",
                    display(file)
                ))
            }
            None => {}
        }
    }
    Ok(())
}

/// Set `version` in a package or project table, keeping its formatting.
fn set_version(table: &mut dyn TableLike, new: &str) -> Result<(), String> {
    let slot = table
        .get_mut("version")
        .and_then(Item::as_value_mut)
        .ok_or("no version key")?;
    replace_value(slot, new);
    Ok(())
}

/// Set the pinned version of every workspace dependency in one table.
fn set_dependency_versions(deps: &mut dyn TableLike, new: &str) -> Result<(), String> {
    for (key, item) in deps.iter_mut() {
        let name = item
            .as_table_like()
            .and_then(|dep| dep.get("package"))
            .and_then(Item::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| key.get().to_owned());
        if !name.starts_with(CRATE_PREFIX) {
            continue;
        }
        if item.as_str().is_some() {
            if let Some(slot) = item.as_value_mut() {
                replace_value(slot, new);
            }
            continue;
        }
        if let Some(slot) = item
            .as_table_like_mut()
            .and_then(|dep| dep.get_mut("version"))
            .and_then(Item::as_value_mut)
        {
            replace_value(slot, new);
        }
    }
    Ok(())
}

/// Replace a string value in place, keeping the whitespace and comments around it.
fn replace_value(slot: &mut Value, new: &str) {
    let decor = slot.decor().clone();
    *slot = Value::from(new);
    *slot.decor_mut() = decor;
}

/// The dependency tables of a manifest: the three plain sections and the same
/// three under each `[target.<cfg>]`, named as they appear in the file.
fn dependency_tables(doc: &DocumentMut) -> Vec<(String, &dyn TableLike)> {
    const SECTIONS: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];
    let mut tables = Vec::new();
    for section in SECTIONS {
        if let Some(table) = doc.get(section).and_then(Item::as_table_like) {
            tables.push((section.to_owned(), table));
        }
    }
    if let Some(targets) = doc.get("target").and_then(Item::as_table_like) {
        for (target, item) in targets.iter() {
            let Some(target_table) = item.as_table_like() else {
                continue;
            };
            for section in SECTIONS {
                if let Some(table) = target_table.get(section).and_then(Item::as_table_like) {
                    tables.push((format!("target.{target}.{section}"), table));
                }
            }
        }
    }
    tables
}

/// Visit every dependency table of a manifest mutably.
fn for_each_dependency_table(
    doc: &mut DocumentMut,
    visit: &mut dyn FnMut(&str, &mut dyn TableLike) -> Result<(), String>,
) -> Result<(), String> {
    const SECTIONS: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];
    for section in SECTIONS {
        if let Some(table) = doc.get_mut(section).and_then(Item::as_table_like_mut) {
            visit(section, table)?;
        }
    }
    if let Some(targets) = doc.get_mut("target").and_then(Item::as_table_like_mut) {
        for (target, item) in targets.iter_mut() {
            let Some(target_table) = item.as_table_like_mut() else {
                continue;
            };
            for section in SECTIONS {
                if let Some(table) = target_table
                    .get_mut(section)
                    .and_then(Item::as_table_like_mut)
                {
                    visit(&format!("target.{}.{section}", target.get()), table)?;
                }
            }
        }
    }
    Ok(())
}

/// Every crate manifest: the workspace members under `crates/` and `examples/`,
/// and the standalone binding crates under `bindings/`.
fn crate_manifests(root: &Path) -> Result<Vec<PathBuf>, String> {
    let bindings = subdirectories(&root.join("bindings"))?;
    let mut binding_packages = Vec::new();
    for binding in &bindings {
        binding_packages.extend(subdirectories(&binding.join("packages"))?);
    }
    let mut manifests: Vec<PathBuf> = subdirectories(&root.join("crates"))?
        .into_iter()
        .chain(bindings)
        .chain(binding_packages)
        .chain([root.join("examples")])
        .map(|dir| dir.join("Cargo.toml"))
        .filter(|path| path.is_file())
        .collect();
    manifests.sort();
    Ok(manifests)
}

/// Every `Cargo.lock`: the workspace's and one per standalone binding crate, at a
/// binding's root or under one of its packages.
fn cargo_lockfiles(root: &Path) -> Vec<PathBuf> {
    let mut lockfiles = vec![root.join("Cargo.lock")];
    lockfiles.extend(binding_files(root, "Cargo.lock"));
    for binding in subdirectories(&root.join("bindings")).unwrap_or_default() {
        for package in subdirectories(&binding.join("packages")).unwrap_or_default() {
            lockfiles.push(package.join("Cargo.lock"));
        }
    }
    lockfiles
        .into_iter()
        .filter(|path| path.is_file())
        .collect()
}

/// Every npm manifest: a binding's workspace root, each package under its
/// `packages/`, and the platform packages under any of those.
fn package_manifests(root: &Path) -> Vec<PathBuf> {
    let mut manifests = binding_files(root, "package.json");
    for binding in subdirectories(&root.join("bindings")).unwrap_or_default() {
        for package in subdirectories(&binding.join("packages")).unwrap_or_default() {
            let manifest = package.join("package.json");
            if manifest.is_file() {
                manifests.push(manifest);
            }
            for platform in subdirectories(&package.join("npm")).unwrap_or_default() {
                let manifest = platform.join("package.json");
                if manifest.is_file() {
                    manifests.push(manifest);
                }
            }
        }
    }
    manifests.sort();
    manifests
}

/// Every Python project manifest: a binding's own and each package under its `packages/`.
fn pyprojects(root: &Path) -> Vec<PathBuf> {
    let mut manifests = binding_files(root, "pyproject.toml");
    for binding in subdirectories(&root.join("bindings")).unwrap_or_default() {
        for package in subdirectories(&binding.join("packages")).unwrap_or_default() {
            let manifest = package.join("pyproject.toml");
            if manifest.is_file() {
                manifests.push(manifest);
            }
        }
    }
    manifests.sort();
    manifests
}

/// A PyPI requirement that pins one of this repository's own distributions, as
/// (name, version): `zero-server-native==0.1.0` gives `("zero-server-native", "0.1.0")`.
fn python_pin(spec: &str) -> Option<(&str, &str)> {
    let (name, version) = spec.split_once("==")?;
    let own = name == PYTHON_PREFIX || name.starts_with(&format!("{PYTHON_PREFIX}-"));
    own.then_some((name, version))
}

/// Every generated napi-rs loader: `index.js` under a binding or under one of its
/// packages.
fn loader_files(root: &Path) -> Vec<PathBuf> {
    let mut loaders = binding_files(root, "index.js");
    for binding in subdirectories(&root.join("bindings")).unwrap_or_default() {
        for package in subdirectories(&binding.join("packages")).unwrap_or_default() {
            let loader = package.join("index.js");
            if loader.is_file() {
                loaders.push(loader);
            }
        }
    }
    loaders.sort();
    loaders
}

/// The dependency sections of an npm manifest whose entries pin sibling packages.
const PIN_SECTIONS: [&str; 3] = ["dependencies", "optionalDependencies", "peerDependencies"];

/// Whether an npm dependency name is one of this repository's own packages.
fn is_own_package(name: &str) -> bool {
    name == PYTHON_PREFIX || name.starts_with("@zero-server/")
}

/// The pinned versions of this repository's own packages in an npm manifest, as
/// (name, version).
fn package_pins(file: &Path) -> Result<Vec<(String, String)>, String> {
    let document: serde_json::Value = serde_json::from_str(&read(file)?)
        .map_err(|err| format!("{} is not JSON: {err}", display(file)))?;
    let mut pins = Vec::new();
    for section in PIN_SECTIONS {
        let Some(entries) = document[section].as_object() else {
            continue;
        };
        for (name, version) in entries {
            if is_own_package(name) {
                let version = version.as_str().unwrap_or("?").to_owned();
                pins.push((name.clone(), version));
            }
        }
    }
    Ok(pins)
}

/// Rewrite the pinned version of every own-package dependency in npm manifest text,
/// line by line so the file's layout survives.
fn with_package_pins(text: &str, new: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let Some((key, rest)) = line.split_once("\": \"") else {
                return line.to_owned();
            };
            let name = key.trim_start().trim_start_matches('"');
            if !is_own_package(name) {
                return line.to_owned();
            }
            let Some(end) = rest.find('"') else {
                return line.to_owned();
            };
            format!("{key}\": \"{new}{}", &rest[end..])
        })
        .collect();
    let mut joined = lines.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// The file called `name` directly under each binding directory, where present.
fn binding_files(root: &Path, name: &str) -> Vec<PathBuf> {
    subdirectories(&root.join("bindings"))
        .unwrap_or_default()
        .into_iter()
        .map(|dir| dir.join(name))
        .filter(|path| path.is_file())
        .collect()
}

/// The subdirectories of `dir`, sorted; an absent directory has none.
fn subdirectories(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|err| format!("reading {}: {err}", display(dir)))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// The `version` string at `path` within a JSON file, `path` being the object
/// keys to descend before the `version` key.
fn json_version(file: &Path, path: &[&str]) -> Result<String, String> {
    let document: serde_json::Value = serde_json::from_str(&read(file)?)
        .map_err(|err| format!("{} is not JSON: {err}", display(file)))?;
    let mut node = &document;
    for key in path {
        node = &node[*key];
    }
    node["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no version at {}", display(file), path.join(".")))
}

/// Replace the text between `before` and the next `after` in a file, at most
/// `limit` times.
fn rewrite(file: &Path, before: &str, after: &str, new: &str, limit: usize) -> Result<(), String> {
    let text = read(file)?;
    let (rewritten, count) = replace_between(&text, before, after, new, limit);
    if count == 0 {
        return Err(format!(
            "{} has no `{before}...{after}` to rewrite",
            display(file)
        ));
    }
    write(file, &rewritten)
}

/// Replace the text between each `before` and the `after` that follows it,
/// returning the new text and how many replacements were made.
fn replace_between(
    text: &str,
    before: &str,
    after: &str,
    new: &str,
    limit: usize,
) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut count = 0;
    while count < limit {
        let Some(start) = rest.find(before) else {
            break;
        };
        let value_start = start + before.len();
        let Some(len) = rest[value_start..].find(after) else {
            break;
        };
        out.push_str(&rest[..value_start]);
        out.push_str(new);
        rest = &rest[value_start + len..];
        count += 1;
    }
    out.push_str(rest);
    (out, count)
}

/// Every text between a `before` and the `after` that follows it.
fn find_between(text: &str, before: &str, after: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(before) {
        let value_start = start + before.len();
        let Some(len) = rest[value_start..].find(after) else {
            break;
        };
        found.push(rest[value_start..value_start + len].to_owned());
        rest = &rest[value_start + len..];
    }
    found
}

/// Require `x.y.z`, optionally followed by `-alpha.N`, `-beta.N` or `-rc.N`.
fn validate(version: &str) -> Result<(), String> {
    parse(version).map(|_| ())
}

/// Parse a TOML file keeping its formatting.
fn parse_toml(file: &Path) -> Result<DocumentMut, String> {
    read(file)?
        .parse()
        .map_err(|err| format!("{} is not valid TOML: {err}", display(file)))
}

/// Edit a TOML file in place, keeping its formatting.
fn edit_toml(
    file: &Path,
    edit: impl FnOnce(&mut DocumentMut) -> Result<(), String>,
) -> Result<(), String> {
    let mut doc = parse_toml(file)?;
    edit(&mut doc).map_err(|message| format!("{}: {message}", display(file)))?;
    write(file, &doc.to_string())
}

fn reading(file: &Path, what: &str, version: &str, spelling: Spelling) -> Reading {
    Reading {
        file: file.to_path_buf(),
        what: what.to_owned(),
        version: version.to_owned(),
        spelling,
    }
}

fn read(file: &Path) -> Result<String, String> {
    fs::read_to_string(file).map_err(|err| format!("reading {}: {err}", display(file)))
}

fn write(file: &Path, text: &str) -> Result<(), String> {
    fs::write(file, text).map_err(|err| format!("writing {}: {err}", display(file)))
}

/// A path relative to the repository root with forward slashes, for messages.
fn display(path: &Path) -> String {
    let relative = path.strip_prefix(repo_root()).unwrap_or(path);
    relative.to_string_lossy().replace('\\', "/")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root is two levels above the xtask crate")
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_between_markers_up_to_the_limit() {
        let text = "expected 0.1.14 but got x; expected 0.1.14 but got y";
        let (all, count) = replace_between(text, "expected ", " but got", "0.2.0", usize::MAX);
        assert_eq!(count, 2);
        assert_eq!(all, "expected 0.2.0 but got x; expected 0.2.0 but got y");
        let (first, count) = replace_between(text, "expected ", " but got", "0.2.0", 1);
        assert_eq!(count, 1);
        assert_eq!(first, "expected 0.2.0 but got x; expected 0.1.14 but got y");
    }

    #[test]
    fn finds_every_value_between_markers() {
        let text = "<Version>1.2.3</Version> <Version>1.2.4</Version>";
        assert_eq!(
            find_between(text, "<Version>", "</Version>"),
            ["1.2.3", "1.2.4"]
        );
        assert!(find_between("nothing here", "<Version>", "</Version>").is_empty());
    }

    #[test]
    fn semver_item_2_a_normal_version_is_three_integers_without_leading_zeroes() {
        assert!(validate("0.1.15").is_ok());
        assert!(validate("10.0.0").is_ok());
        assert!(validate("0.1").is_err());
        assert!(validate("0.1.2.3").is_err());
        assert!(validate("v0.1.15").is_err());
        assert!(validate("0.1.x").is_err());
        assert!(validate("01.0.0").is_err());
        assert!(validate("1.00.0").is_err());
    }

    #[test]
    fn semver_item_9_a_pre_release_is_a_hyphen_and_dot_separated_identifiers_after_the_patch() {
        assert!(validate("2.0.0-alpha.1").is_ok());
        assert!(validate("2.0.0-beta.12").is_ok());
        assert!(validate("2.0.0-rc.0").is_ok());
        assert!(validate("2.0.0-").is_err());
        assert!(validate("2.0.0alpha.1").is_err());
        assert!(validate("2.0.0-alpha..1").is_err());
        assert!(validate("2.0.0-alpha.01").is_err());
    }

    #[test]
    fn pep440_pre_release_spelling_only_alpha_beta_and_rc_map_one_to_one_in_the_same_order() {
        for refused in [
            "2.0.0-dev.1",
            "2.0.0-c.1",
            "2.0.0-pre.1",
            "2.0.0-preview.1",
            "2.0.0-a.1",
            "2.0.0-ALPHA.1",
            "2.0.0-alpha",
            "2.0.0-alpha.1.1",
            "2.0.0-alpha.x",
        ] {
            let err = validate(refused).unwrap_err();
            assert!(err.contains("alpha.N, beta.N or rc.N"), "{refused}: {err}");
        }
    }

    #[test]
    fn pep440_local_versions_build_metadata_is_refused_because_pypi_does_not_accept_it() {
        for refused in ["2.0.0+build.1", "2.0.0-alpha.1+abc"] {
            let err = validate(refused).unwrap_err();
            assert!(err.contains("build metadata"), "{refused}: {err}");
        }
    }

    #[test]
    fn pep440_normalization_drops_the_separators_and_spells_the_phase_as_a_b_or_rc() {
        assert_eq!(pep440("2.0.0-alpha.1").unwrap(), "2.0.0a1");
        assert_eq!(pep440("2.0.0-beta.12").unwrap(), "2.0.0b12");
        assert_eq!(pep440("2.0.0-rc.0").unwrap(), "2.0.0rc0");
        assert_eq!(pep440("2.0.0").unwrap(), "2.0.0");
        assert!(pep440("2.0.0-dev.1").is_err());
    }

    #[test]
    fn cargo_pre_releases_a_sibling_pre_release_is_pinned_exactly_and_a_final_by_caret() {
        assert_eq!(
            Spelling::CargoPin.of("2.0.0-alpha.1").unwrap(),
            "=2.0.0-alpha.1"
        );
        assert_eq!(Spelling::CargoPin.of("2.0.0").unwrap(), "2.0.0");
        assert_eq!(
            Spelling::SemVer.of("2.0.0-alpha.1").unwrap(),
            "2.0.0-alpha.1"
        );
    }

    #[test]
    fn pyproject_version_python_manifests_carry_the_normalized_spelling() {
        let mut doc: DocumentMut = concat!(
            "[project]\n",
            "name = \"zero-server\"\n",
            "version = \"0.1.0\" # the workspace version\n",
            "dependencies = [\n",
            "    \"zero-server-core==0.1.0\",\n",
            "    \"zero-server-native==0.1.0\",\n",
            "    \"typing-extensions>=4\",\n",
            "]\n",
        )
        .parse()
        .unwrap();
        let python = pep440("2.0.0-alpha.1").unwrap();
        set_project_versions(&mut doc, &python).unwrap();

        let text = doc.to_string();
        assert!(text.contains("version = \"2.0.0a1\" # the workspace version\n"));
        assert!(text.contains("\"zero-server-core==2.0.0a1\",\n"));
        assert!(text.contains("\"zero-server-native==2.0.0a1\",\n"));
        assert!(text.contains("\"typing-extensions>=4\",\n"));
        assert!(!text.contains("alpha"));

        let read: Vec<(String, String)> = project_versions(&doc).unwrap();
        assert_eq!(
            read,
            [
                ("project.version".to_owned(), "2.0.0a1".to_owned()),
                (
                    "dependency zero-server-core".to_owned(),
                    "2.0.0a1".to_owned()
                ),
                (
                    "dependency zero-server-native".to_owned(),
                    "2.0.0a1".to_owned()
                ),
            ]
        );
        for (_, version) in read {
            assert_eq!(version, Spelling::Pep440.of("2.0.0-alpha.1").unwrap());
        }
    }

    #[test]
    fn prose_names_the_version_in_either_spelling() {
        let text = concat!(
            "Tag v2.0.0-alpha.1, then `pip install zero-server==2.0.0a1`.\n",
            "It ships 2.0.0-alpha.1. Not a version: 127.0.0.1, 2.0, or 2026-10-01.\n",
        );
        assert_eq!(
            versions_in(text),
            [
                ("2.0.0-alpha.1".to_owned(), Spelling::SemVer),
                ("2.0.0a1".to_owned(), Spelling::Pep440),
            ]
        );
        assert_eq!(
            versions_in("from 0.1.0. Then 0.1.0-"),
            [("0.1.0".to_owned(), Spelling::SemVer)]
        );
        assert_eq!(
            versions_in("a 2.0.0-rc.1-based build and 2.0.0rc1x"),
            [
                ("2.0.0-rc.1-based".to_owned(), Spelling::SemVer),
                ("2.0.0rc1x".to_owned(), Spelling::SemVer),
            ]
        );
        assert_eq!(
            versions_in("cargo add zero-server@2.0.0a1"),
            [("2.0.0a1".to_owned(), Spelling::SemVer)]
        );
        assert_eq!(
            versions_in("pip install zero-server==2.0.0a1.dev3"),
            [("2.0.0a1.dev3".to_owned(), Spelling::Pep440)]
        );
        assert_eq!(
            versions_in("zero-server 2.0.0-alpha.1+build.5"),
            [("2.0.0-alpha.1+build.5".to_owned(), Spelling::SemVer)]
        );

        let names_only = |text: &str, version: &str| {
            let named = versions_in(text);
            !named.is_empty()
                && named
                    .iter()
                    .all(|(named, spelling)| spelling.of(version).is_ok_and(|v| v == *named))
        };
        for wrong in [
            "cargo add zero-server@2.0.0a1",
            "git tag -a v2.0.0a1",
            "npm install @zero-server/core@2.0.0a1",
            "pip install zero-server==2.0.0a1.dev3",
            "pip install zero-server==2.0.0a1.post2",
            "zero-server 2.0.0-alpha.1+build.5",
        ] {
            assert!(
                !names_only(wrong, "2.0.0-alpha.1"),
                "{wrong}: {:?}",
                versions_in(wrong)
            );
        }
        for right in [
            "pip install zero-server==2.0.0a1",
            "zero-server >= 2.0.0a1",
            "cargo add zero-server@2.0.0-alpha.1",
        ] {
            assert!(
                names_only(right, "2.0.0-alpha.1"),
                "{right}: {:?}",
                versions_in(right)
            );
        }
    }

    #[test]
    fn pep440_pre_release_separators_and_spellings_after_a_final_version_read_as_another_version() {
        let names_only = |text: &str, version: &str| {
            let named = versions_in(text);
            !named.is_empty()
                && named
                    .iter()
                    .all(|(named, spelling)| spelling.of(version).is_ok_and(|v| v == *named))
        };
        for wrong in [
            "pip install zero-server==2.0.0c1",
            "pip install zero-server==2.0.0.rc1",
            "pip install zero-server==2.0.0_rc1",
            "pip install zero-server==2.0.0alpha1",
            "pip install zero-server==2.0.0preview1",
            "pip install zero-server==2.0.0dev1",
            "pip install zero-server==2.0.0.dev",
            "pip install zero-server==2.0.0post1",
            "cargo add zero-server@2.0.0rc1x",
        ] {
            assert!(
                !names_only(wrong, "2.0.0"),
                "{wrong}: {:?}",
                versions_in(wrong)
            );
        }
        for right in [
            "pip install zero-server==2.0.0.",
            "It ships 2.0.0. Then 2.0.0, and (v2.0.0).",
            "git log v2.0.0..main",
            "`zero-server@2.0.0`",
        ] {
            assert!(
                names_only(right, "2.0.0"),
                "{right}: {:?}",
                versions_in(right)
            );
        }
    }

    #[test]
    fn prose_a_bump_rewrites_each_whole_mention_of_the_old_version_in_its_own_spelling() {
        let text = concat!(
            "cargo xtask version 2.0.0-alpha.1\n",
            "pip install zero-server==2.0.0a1\n",
            "not 12.0.0-alpha.1, 2.0.0-alpha.10 or 2.0.0a10\n",
        );
        assert_eq!(
            with_prose_versions(text, "2.0.0-alpha.1", "2.0.0-beta.1").unwrap(),
            concat!(
                "cargo xtask version 2.0.0-beta.1\n",
                "pip install zero-server==2.0.0b1\n",
                "not 12.0.0-alpha.1, 2.0.0-alpha.10 or 2.0.0a10\n",
            )
        );
        assert_eq!(
            with_prose_versions("version = \"0.1.0\"\n", "0.1.0", "2.0.0-alpha.1").unwrap(),
            "version = \"2.0.0-alpha.1\"\n"
        );
        assert_eq!(
            with_prose_versions(
                "v2.0.0-rc.2 and zero-server==2.0.0rc2",
                "2.0.0-rc.2",
                "2.0.0"
            )
            .unwrap(),
            "v2.0.0 and zero-server==2.0.0"
        );
        assert_eq!(
            with_prose_versions(
                "cargo add zero-server@2.0.0a1\n",
                "2.0.0-alpha.1",
                "2.0.0-beta.1"
            )
            .unwrap(),
            "cargo add zero-server@2.0.0a1\n"
        );
    }

    #[test]
    fn a_bump_rewrites_the_old_version_in_the_readme_and_the_release_runbook() {
        let root =
            std::env::temp_dir().join(format!("zero-server-version-bump-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (path, text) in [
            (
                "Cargo.toml",
                concat!(
                    "[workspace.package]\n",
                    "version = \"0.1.0\"\n",
                    "\n",
                    "[workspace.dependencies]\n",
                    "zero-core = { path = \"crates/zero-core\", version = \"0.1.0\" }\n",
                ),
            ),
            ("CHANGELOG.md", "## [2.0.0-alpha.1]\n"),
            (
                "README.md",
                "cargo add zero-server@0.1.0\npip install zero-server==0.1.0\n",
            ),
            (
                "docs/about/releasing.md",
                "cargo xtask version 0.1.0\ngit tag -a v0.1.0\n",
            ),
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }

        let bumped = bump(&root, "2.0.0-alpha.1");
        let file = |path: &str| fs::read_to_string(root.join(path)).unwrap();
        let (manifest, readme, runbook) = (
            file("Cargo.toml"),
            file("README.md"),
            file("docs/about/releasing.md"),
        );
        fs::remove_dir_all(&root).unwrap();

        bumped.unwrap();
        assert!(
            manifest.contains("version = \"2.0.0-alpha.1\"\n"),
            "{manifest}"
        );
        assert!(
            manifest.contains("version = \"=2.0.0-alpha.1\" }"),
            "{manifest}"
        );
        assert_eq!(
            readme,
            "cargo add zero-server@2.0.0-alpha.1\npip install zero-server==2.0.0a1\n"
        );
        assert_eq!(
            runbook,
            "cargo xtask version 2.0.0-alpha.1\ngit tag -a v2.0.0-alpha.1\n"
        );
    }

    #[test]
    fn rewrites_manifest_versions_and_keeps_formatting() {
        let mut doc: DocumentMut = concat!(
            "[package]\n",
            "name = \"zero-demo\"\n",
            "version = \"0.1.14\" # the workspace version\n",
            "\n",
            "[dependencies]\n",
            "zero-core = { path = \"../zero-core\", version = \"0.1.14\" }\n",
            "zero-kit = { workspace = true }\n",
            "renamed = { package = \"zero-codec\", path = \"../zero-codec\", version = \"0.1.14\" }\n",
            "serde = { version = \"1\", features = [\"derive\"] }\n",
            "\n",
            "[dev-dependencies]\n",
            "zero-sync = { path = \"../zero-sync\" }\n",
            "\n",
            "[target.'cfg(unix)'.dependencies]\n",
            "zero-gpio = \"0.1.14\"\n",
        )
        .parse()
        .unwrap();

        let package = doc
            .get_mut("package")
            .and_then(Item::as_table_like_mut)
            .unwrap();
        set_version(package, "0.1.15").unwrap();
        for_each_dependency_table(&mut doc, &mut |_, deps| {
            set_dependency_versions(deps, "0.1.15")
        })
        .unwrap();

        let text = doc.to_string();
        assert!(text.contains("version = \"0.1.15\" # the workspace version\n"));
        assert!(text.contains("zero-core = { path = \"../zero-core\", version = \"0.1.15\" }\n"));
        assert!(text.contains("zero-kit = { workspace = true }\n"));
        assert!(text.contains("path = \"../zero-codec\", version = \"0.1.15\" }\n"));
        assert!(text.contains("serde = { version = \"1\", features = [\"derive\"] }\n"));
        assert!(text.contains("zero-sync = { path = \"../zero-sync\" }\n"));
        assert!(text.contains("zero-gpio = \"0.1.15\"\n"));
        assert!(!text.contains("0.1.14"));

        let mut readings = Vec::new();
        for (section, deps) in dependency_tables(&doc) {
            read_dependency_versions(Path::new("demo"), &section, deps, false, &mut readings)
                .unwrap();
        }
        let named: Vec<(String, String)> = readings
            .into_iter()
            .map(|reading| (reading.what, reading.version))
            .collect();
        assert_eq!(
            named,
            [
                (
                    "dependencies.zero-core.version".to_owned(),
                    "0.1.15".to_owned()
                ),
                (
                    "dependencies.renamed.version".to_owned(),
                    "0.1.15".to_owned()
                ),
                (
                    "target.cfg(unix).dependencies.zero-gpio.version".to_owned(),
                    "0.1.15".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn an_unpinned_dependency_fails_a_publishable_crate() {
        let doc: DocumentMut = "[dependencies]\nzero-core = { path = \"../zero-core\" }\n"
            .parse()
            .unwrap();
        let mut readings = Vec::new();
        let deps = doc
            .get("dependencies")
            .and_then(Item::as_table_like)
            .unwrap();
        let err =
            read_dependency_versions(Path::new("demo"), "dependencies", deps, true, &mut readings)
                .unwrap_err();
        assert!(err.contains("dependencies.zero-core has no version"));
        read_dependency_versions(
            Path::new("demo"),
            "dependencies",
            deps,
            false,
            &mut readings,
        )
        .unwrap();
        assert!(readings.is_empty());
    }

    #[test]
    fn a_release_check_requires_the_changelog_entry_dated_and_a_plain_check_does_not() {
        let root =
            std::env::temp_dir().join(format!("zero-server-version-dated-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[workspace.package]\nversion = \"2.0.0-alpha.1\"\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("docs/about")).unwrap();
        fs::write(
            root.join("README.md"),
            "cargo add zero-server@2.0.0-alpha.1\n",
        )
        .unwrap();
        fs::write(
            root.join("docs/about/releasing.md"),
            "cargo xtask version 2.0.0-alpha.1\n",
        )
        .unwrap();
        let checked = |changelog: &str, release: bool| {
            fs::write(root.join("CHANGELOG.md"), changelog).unwrap();
            let expected = release.then_some("2.0.0-alpha.1");
            check(&root, expected, release)
        };
        let undated = "# Changelog\n\n## [2.0.0-alpha.1] - Unreleased\n";
        let dated = "# Changelog\n\n## [2.0.0-alpha.1] - 2026-10-03\n";
        let results = [
            checked(undated, false),
            checked(undated, true),
            checked(dated, true),
            checked("## [2.0.0-alpha.1] - 2026-13-03\n", true),
            checked("## [2.0.0-alpha.1] - 2026-10-3\n", true),
            checked("## [2.0.0-alpha.10] - 2026-10-03\n", true),
        ];
        fs::remove_dir_all(&root).unwrap();
        let [plain, release_undated, release_dated, bad_month, short_day, other] = results;
        plain.expect("development carries an undated entry");
        let problem = release_undated.unwrap_err();
        assert!(
            problem.contains("CHANGELOG.md: the `## [2.0.0-alpha.1]` entry has no release date"),
            "{problem}"
        );
        release_dated.expect("a dated entry passes the release check");
        assert!(bad_month.is_err());
        assert!(short_day.is_err());
        let problem = other.unwrap_err();
        assert!(
            problem.contains("no `## [2.0.0-alpha.1]` entry"),
            "{problem}"
        );
    }

    #[test]
    fn the_checked_out_tree_is_consistent() {
        let version = current().unwrap();
        for reading in readings(&repo_root()).unwrap() {
            assert_eq!(
                reading.version,
                reading.spelling.of(&version).unwrap(),
                "{}: {}",
                display(&reading.file),
                reading.what
            );
        }
    }
}
