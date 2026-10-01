//! The lint tables: `cargo xtask lints --check` diffs every member manifest's
//! `[lints]` table against the table `docs/capabilities.toml` names for it.
//!
//! Cargo replaces rather than merges a package `[lints]` table, so a crate that
//! needs more than the workspace table carries a full copy. The copies live in
//! `docs/lints/<name>.toml`, one file per table, and every member has a
//! `[[crate]]` row in `docs/capabilities.toml` whose `lint` key names the table
//! its manifest copies. A `no_std` crate is held to the `nostd` table with the
//! named table's keys applied over it, so a crate that is both `no_std` and
//! audited names `audited` and carries the union. A name may also join tables
//! with `+` (`nostd+audited`), later tables overriding earlier keys. A manifest
//! with `[lints] workspace = true` matches the `workspace` table, which must in
//! turn equal `[workspace.lints]` in the root manifest. The binding crates
//! outside the workspace are held to the audited table whenever their manifest
//! exists.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use toml_edit::{DocumentMut, Item, TableLike};

/// The table a crate uses unless its row says otherwise.
const DEFAULT_TABLE: &str = "workspace";

/// The table every `no_std` crate starts from.
const NOSTD_TABLE: &str = "nostd";

/// The crates outside the workspace that carry the audited table, checked when
/// their manifest exists.
const BINDING_CRATES: [(&str, &str); 2] = [
    ("bindings/node", "audited"),
    ("bindings/python/packages/native", "audited"),
];

/// A lint table flattened to `tool.lint` keys and the level each carries.
type Table = BTreeMap<String, String>;

/// Run `cargo xtask lints [--check]`.
///
/// # Arguments
///
/// * `args` - `--check` reports only the outcome; without it every crate is
///   listed with the table it was held to.
///
/// # Returns
///
/// Success when every manifest carries the table its row names.
pub fn run(args: &[String]) -> ExitCode {
    let quiet = args.iter().any(|arg| arg == "--check");
    match check(&crate::docs::repo_root()) {
        Ok(held) => {
            if !quiet {
                for (krate, table) in &held {
                    println!("  {krate:<24} {table}");
                }
            }
            println!(
                "lints: {} crate(s) carry the lint table docs/capabilities.toml names",
                held.len()
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("xtask lints: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Check every member manifest, and every binding manifest that exists, against
/// the table it is held to.
///
/// # Arguments
///
/// * `root` - the repository root.
///
/// # Returns
///
/// Every crate checked, paired with the name of the table it matched.
///
/// # Errors
///
/// When a file cannot be read, a row names a crate that is not a member, a
/// member has no row, the root `[workspace.lints]` drifts from
/// `docs/lints/workspace.toml`, or a manifest's table differs from the one
/// named for it; the message lists every differing key.
pub fn check(root: &Path) -> Result<Vec<(String, String)>, String> {
    let root_manifest = parse(&root.join("Cargo.toml"))?;
    let workspace = root_manifest
        .get("workspace")
        .and_then(Item::as_table_like)
        .ok_or("Cargo.toml has no [workspace] table")?;

    let mirrored = load_table(root, DEFAULT_TABLE)?;
    let inline = workspace
        .get("lints")
        .and_then(Item::as_table_like)
        .ok_or("Cargo.toml has no [workspace.lints] table")?;
    let inline = flatten(inline, "Cargo.toml [workspace.lints]")?;
    if inline != mirrored {
        return Err(format!(
            "Cargo.toml [workspace.lints] differs from docs/lints/workspace.toml:\n{}",
            diff(
                &mirrored,
                &inline,
                "docs/lints/workspace.toml",
                "Cargo.toml"
            )
        ));
    }

    let named = assignments(root)?;
    let mut members = BTreeMap::new();
    for path in member_paths(workspace)? {
        let manifest = root.join(&path).join("Cargo.toml");
        let doc = parse(&manifest)?;
        let name = doc
            .get("package")
            .and_then(Item::as_table_like)
            .and_then(|package| package.get("name"))
            .and_then(Item::as_str)
            .ok_or_else(|| format!("{path}/Cargo.toml has no package.name"))?
            .to_owned();
        members.insert(name, (path, doc));
    }
    for krate in named.keys() {
        if !members.contains_key(krate) {
            return Err(format!(
                "docs/capabilities.toml has a [[crate]] row for {krate}, which is not a workspace member"
            ));
        }
    }

    let mut held = Vec::new();
    for (name, (path, doc)) in &members {
        let table = named.get(name).ok_or_else(|| {
            format!("docs/capabilities.toml has no [[crate]] row for {name}; add one naming its lint table")
        })?;
        compare(root, &format!("{path}/Cargo.toml"), doc, table)?;
        held.push((name.clone(), table.clone()));
    }
    for (path, table) in BINDING_CRATES {
        let manifest = root.join(path).join("Cargo.toml");
        if !manifest.is_file() {
            continue;
        }
        let doc = parse(&manifest)?;
        compare(root, &format!("{path}/Cargo.toml"), &doc, table)?;
        held.push((path.to_owned(), table.to_owned()));
    }
    Ok(held)
}

/// Hold one manifest to the named table.
fn compare(root: &Path, manifest: &str, doc: &DocumentMut, table: &str) -> Result<(), String> {
    let lints = doc
        .get("lints")
        .and_then(Item::as_table_like)
        .ok_or_else(|| format!("{manifest} has no [lints] table; it must name {table}"))?;
    if lints.get("workspace").and_then(Item::as_bool) == Some(true) {
        if table == DEFAULT_TABLE {
            return Ok(());
        }
        return Err(format!(
            "{manifest} inherits the workspace table, but docs/capabilities.toml names {table}; copy that table into it"
        ));
    }
    let expected = load_table(root, table)?;
    let actual = flatten(lints, manifest)?;
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "{manifest} does not carry the {table} table:\n{}",
        diff(&expected, &actual, &format!("the {table} table"), manifest)
    ))
}

/// The lines that tell two tables apart, one per differing key.
fn diff(expected: &Table, actual: &Table, expected_name: &str, actual_name: &str) -> String {
    let mut lines = Vec::new();
    for (key, level) in expected {
        match actual.get(key) {
            Some(found) if found == level => {}
            Some(found) => lines.push(format!(
                "  {key}: {found} in {actual_name}, {level} in {expected_name}"
            )),
            None => lines.push(format!(
                "  {key}: {level} in {expected_name}, absent from {actual_name}"
            )),
        }
    }
    for (key, level) in actual {
        if !expected.contains_key(key) {
            lines.push(format!(
                "  {key}: {level} in {actual_name}, absent from {expected_name}"
            ));
        }
    }
    lines.join("\n")
}

/// The table `name` denotes: the `docs/lints/<part>.toml` files it joins with
/// `+`, applied in order.
fn load_table(root: &Path, name: &str) -> Result<Table, String> {
    let mut table = Table::new();
    for part in name.split('+') {
        let part = part.trim();
        if part.is_empty() || part.contains(['/', '\\', '.']) {
            return Err(format!("`{name}` is not a lint table name"));
        }
        let path = root.join("docs/lints").join(format!("{part}.toml"));
        let doc = parse(&path)?;
        let lints = doc
            .get("lints")
            .and_then(Item::as_table_like)
            .ok_or_else(|| format!("docs/lints/{part}.toml has no [lints] table"))?;
        table.extend(flatten(lints, &format!("docs/lints/{part}.toml"))?);
    }
    Ok(table)
}

/// Flatten a `[lints]` table to `tool.lint` keys. A level is its string, or
/// `level (priority n)` when written as a table.
fn flatten(lints: &dyn TableLike, context: &str) -> Result<Table, String> {
    let mut table = Table::new();
    for (tool, item) in lints.iter() {
        if tool == "workspace" {
            continue;
        }
        let entries = item
            .as_table_like()
            .ok_or_else(|| format!("{context}: lints.{tool} must be a table"))?;
        for (lint, value) in entries.iter() {
            let level = if let Some(level) = value.as_str() {
                level.to_owned()
            } else if let Some(spec) = value.as_table_like() {
                let level = spec
                    .get("level")
                    .and_then(Item::as_str)
                    .ok_or_else(|| format!("{context}: lints.{tool}.{lint} has no level"))?;
                match spec.get("priority").and_then(Item::as_integer) {
                    Some(priority) => format!("{level} (priority {priority})"),
                    None => level.to_owned(),
                }
            } else {
                return Err(format!(
                    "{context}: lints.{tool}.{lint} must be a level or a table"
                ));
            };
            table.insert(format!("{tool}.{lint}"), level);
        }
    }
    Ok(table)
}

/// The table each crate is held to, from its `[[crate]]` row: the `lint` it
/// names, applied over the `nostd` table when the row says `no_std = true`.
fn assignments(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let doc = parse(&root.join("docs/capabilities.toml"))?;
    let mut named = BTreeMap::new();
    let Some(rows) = doc.get("crate") else {
        return Ok(named);
    };
    let rows = rows
        .as_array_of_tables()
        .ok_or("docs/capabilities.toml: [[crate]] must be an array of tables")?;
    for row in rows {
        let name = row
            .get("name")
            .and_then(Item::as_str)
            .ok_or("docs/capabilities.toml: a [[crate]] row has no name")?;
        let lint = match row.get("lint") {
            None => DEFAULT_TABLE,
            Some(item) => item
                .as_str()
                .ok_or_else(|| format!("docs/capabilities.toml: {name}: lint must be a string"))?,
        };
        let no_std = match row.get("no_std") {
            None => false,
            Some(item) => item.as_bool().ok_or_else(|| {
                format!("docs/capabilities.toml: {name}: no_std must be a boolean")
            })?,
        };
        let table = if no_std && lint != NOSTD_TABLE {
            format!("{NOSTD_TABLE}+{lint}")
        } else {
            lint.to_owned()
        };
        if named.insert(name.to_owned(), table).is_some() {
            return Err(format!(
                "docs/capabilities.toml has two [[crate]] rows for {name}"
            ));
        }
    }
    Ok(named)
}

/// The member paths of the root manifest, as written.
fn member_paths(workspace: &dyn TableLike) -> Result<Vec<String>, String> {
    let members = workspace
        .get("members")
        .and_then(Item::as_array)
        .ok_or("Cargo.toml has no workspace.members array")?;
    members
        .iter()
        .map(|value| {
            let path = value
                .as_str()
                .ok_or("Cargo.toml: workspace.members must hold only strings")?;
            if path.contains(['*', '?', '[']) {
                return Err(format!(
                    "Cargo.toml: member `{path}` is a pattern; list each crate by path"
                ));
            }
            Ok(path.to_owned())
        })
        .collect()
}

fn parse(path: &Path) -> Result<DocumentMut, String> {
    let text =
        fs::read_to_string(path).map_err(|err| format!("reading {}: {err}", display(path)))?;
    text.parse()
        .map_err(|err| format!("{} is not valid TOML: {err}", display(path)))
}

fn display(path: &Path) -> String {
    let relative = path.strip_prefix(crate::docs::repo_root()).unwrap_or(path);
    relative.to_string_lossy().replace('\\', "/")
}

/// A scratch repository under the system temp directory, for tests.
#[cfg(test)]
fn scratch(name: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("zero-server-lints-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs/lints")).unwrap();
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE_TABLE: &str = "[lints.rust]\nunsafe_code = \"forbid\"\nmissing_docs = \"deny\"\n\n[lints.clippy]\nall = \"warn\"\n";
    const NOSTD_TABLE: &str = "[lints.rust]\nunsafe_code = \"forbid\"\nmissing_docs = \"deny\"\n\n[lints.clippy]\nall = \"warn\"\nunwrap_used = \"deny\"\n";
    const AUDITED_TABLE: &str = "[lints.rust]\nunsafe_code = \"deny\"\nmissing_docs = \"deny\"\n\n[lints.clippy]\nall = \"warn\"\n";

    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn repository(name: &str) -> std::path::PathBuf {
        let root = scratch(name);
        write(
            &root,
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/a\", \"crates/b\", \"crates/c\", \"crates/d\"]\n\n[workspace.lints.rust]\nunsafe_code = \"forbid\"\nmissing_docs = \"deny\"\n\n[workspace.lints.clippy]\nall = \"warn\"\n",
        );
        write(&root, "docs/lints/workspace.toml", WORKSPACE_TABLE);
        write(&root, "docs/lints/nostd.toml", NOSTD_TABLE);
        write(&root, "docs/lints/audited.toml", AUDITED_TABLE);
        write(
            &root,
            "docs/capabilities.toml",
            "[[crate]]\nname = \"a\"\nlint = \"workspace\"\n\n[[crate]]\nname = \"b\"\nlint = \"nostd\"\nno_std = true\n\n[[crate]]\nname = \"c\"\nlint = \"audited\"\nno_std = true\n\n[[crate]]\nname = \"d\"\n",
        );
        write(
            &root,
            "crates/a/Cargo.toml",
            "[package]\nname = \"a\"\n\n[lints]\nworkspace = true\n",
        );
        write(
            &root,
            "crates/b/Cargo.toml",
            &format!("[package]\nname = \"b\"\n\n{NOSTD_TABLE}"),
        );
        write(
            &root,
            "crates/c/Cargo.toml",
            "[package]\nname = \"c\"\n\n[lints.rust]\nunsafe_code = \"deny\"\nmissing_docs = \"deny\"\n\n[lints.clippy]\nall = \"warn\"\nunwrap_used = \"deny\"\n",
        );
        write(
            &root,
            "crates/d/Cargo.toml",
            "[package]\nname = \"d\"\n\n[lints]\nworkspace = true\n",
        );
        root
    }

    #[test]
    fn every_manifest_that_carries_its_table_passes() {
        let root = repository("passes");
        let held = check(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();
        let named: Vec<(&str, &str)> = held
            .iter()
            .map(|(krate, table)| (krate.as_str(), table.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                ("a", "workspace"),
                ("b", "nostd"),
                ("c", "nostd+audited"),
                ("d", "workspace")
            ]
        );
    }

    #[test]
    fn a_drifted_copy_is_reported_by_key() {
        let root = repository("drift");
        write(
            &root,
            "crates/c/Cargo.toml",
            "[package]\nname = \"c\"\n\n[lints.rust]\nunsafe_code = \"forbid\"\nmissing_docs = \"deny\"\n\n[lints.clippy]\nall = \"warn\"\n",
        );
        let problem = check(&root).unwrap_err();
        fs::remove_dir_all(&root).unwrap();
        assert!(
            problem.contains("crates/c/Cargo.toml does not carry the nostd+audited table"),
            "{problem}"
        );
        assert!(
            problem.contains(
                "rust.unsafe_code: forbid in crates/c/Cargo.toml, deny in the nostd+audited table"
            ),
            "{problem}"
        );
        assert!(problem.contains("clippy.unwrap_used: deny in the nostd+audited table, absent from crates/c/Cargo.toml"), "{problem}");
    }

    #[test]
    fn inheriting_the_workspace_table_when_a_copy_is_named_is_refused() {
        let root = repository("inherits");
        write(
            &root,
            "crates/b/Cargo.toml",
            "[package]\nname = \"b\"\n\n[lints]\nworkspace = true\n",
        );
        let problem = check(&root).unwrap_err();
        fs::remove_dir_all(&root).unwrap();
        assert!(problem.contains("crates/b/Cargo.toml inherits the workspace table, but docs/capabilities.toml names nostd"), "{problem}");
    }

    #[test]
    fn the_root_table_must_match_its_mirror() {
        let root = repository("mirror");
        write(
            &root,
            "docs/lints/workspace.toml",
            "[lints.rust]\nunsafe_code = \"forbid\"\n\n[lints.clippy]\nall = \"warn\"\n",
        );
        let problem = check(&root).unwrap_err();
        fs::remove_dir_all(&root).unwrap();
        assert!(
            problem.contains("[workspace.lints] differs from docs/lints/workspace.toml"),
            "{problem}"
        );
        assert!(
            problem.contains(
                "rust.missing_docs: deny in Cargo.toml, absent from docs/lints/workspace.toml"
            ),
            "{problem}"
        );
    }

    #[test]
    fn every_row_names_a_member_and_every_member_has_a_row() {
        let root = repository("member");
        let rows = fs::read_to_string(root.join("docs/capabilities.toml")).unwrap();
        write(
            &root,
            "docs/capabilities.toml",
            &format!("{rows}\n[[crate]]\nname = \"z\"\n"),
        );
        let problem = check(&root).unwrap_err();
        assert!(
            problem.contains("row for z, which is not a workspace member"),
            "{problem}"
        );

        write(
            &root,
            "docs/capabilities.toml",
            &rows.replace("[[crate]]\nname = \"d\"\n", ""),
        );
        let problem = check(&root).unwrap_err();
        fs::remove_dir_all(&root).unwrap();
        assert!(problem.contains("no [[crate]] row for d"), "{problem}");
    }

    #[test]
    fn a_level_written_as_a_table_keeps_its_priority() {
        let doc: DocumentMut =
            "[lints.rust]\nunsafe_code = { level = \"forbid\", priority = -1 }\n"
                .parse()
                .unwrap();
        let table = flatten(doc.get("lints").and_then(Item::as_table_like).unwrap(), "t").unwrap();
        assert_eq!(table["rust.unsafe_code"], "forbid (priority -1)");
    }
}
