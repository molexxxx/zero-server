//! The packages of the three bindings, rendered from the capability map: for each binding
//! the core package, the bundle that depends on every package the binding publishes, the
//! README of the compiled engine's package, and each capability and domain package once
//! the release that ships it is the one being built or an earlier one. For Node that is a
//! manifest, a TypeScript project, and a README per package, plus the workspace's project
//! references; for Python a `pyproject.toml` and a README; for .NET a project file and a
//! README. A package's dependencies are derived from its own imports, so a facade that
//! starts using another package declares it on the next `cargo xtask docs`.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use crate::catalog::{
    dotnet_name, dotnet_reference_url, node_package, node_reference_url, python_reference_url,
    Capability, Catalog, Chapter, NODE_BUNDLE, PYTHON_BUNDLE, SITE,
};
use crate::regions;

/// The repository URL every manifest points at.
const REPOSITORY: &str = "git+https://github.com/molexxxx/zero-server.git";

/// The page the core and bundle packages of every binding name as their home, the one
/// `bindings/dotnet/Directory.Build.props` gives every NuGet package. A registry keeps
/// the metadata a version was published with, and the documentation site may still
/// move to a custom domain, so the packages every release publishes name the
/// repository; a capability or domain package names its guide on the site.
const PROJECT_URL: &str = "https://github.com/molexxxx/zero-server";

/// How far the npm publishing of this core has come at a version, which decides what a
/// README tells a reader to install. It follows the gate in `release-node.yml`: the
/// `@zero-server/*` names on npm carry the 1.x line of the earlier JavaScript framework,
/// so this core publishes from major version 2, a pre-release under the `next` dist-tag
/// and a final version under `latest`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Publish {
    /// Below major version 2: nothing is published from this repository.
    Unpublished,
    /// A pre-release from major version 2.
    PreRelease,
    /// A final version from major version 2.
    Final,
}

impl Publish {
    /// The stage a version is at.
    ///
    /// # Arguments
    ///
    /// * `version` - the workspace version, in SemVer.
    ///
    /// # Returns
    ///
    /// The stage; a version whose major part does not parse counts as unpublished.
    fn of(version: &str) -> Publish {
        let major = version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .unwrap_or(0);
        if major < 2 {
            Publish::Unpublished
        } else if version.contains('-') {
            Publish::PreRelease
        } else {
            Publish::Final
        }
    }
}

/// What the `packages` task generates, for its messages.
const FILES: &str = "the binding package manifests and READMEs";

/// Run `cargo xtask packages [--check]`: render every binding package's manifest and
/// README from the capability map, or verify the committed ones are current.
///
/// # Arguments
///
/// * `args` - `--check` verifies without writing; otherwise the files are regenerated.
///
/// # Returns
///
/// Success when the files were written, or when the check found them in sync.
pub fn run(args: &[String]) -> ExitCode {
    let check = args.iter().any(|arg| arg == "--check");
    let root = crate::docs::repo_root();
    let rendered = Catalog::load(&root).and_then(|catalog| {
        let version = crate::version::current()?;
        let mut files = render_node(&root, &catalog, &version)?;
        files.extend(render_python(&root, &catalog, &version)?);
        files.extend(render_dotnet(&root, &catalog, &version)?);
        Ok(files)
    });
    match rendered {
        Ok(files) => {
            let ok = if check {
                crate::docs::verify_files(&files, "packages", FILES)
            } else {
                crate::docs::write_files(&files, "packages", FILES)
            };
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(message) => {
            eprintln!("xtask packages: {message}");
            ExitCode::FAILURE
        }
    }
}

/// The package that carries the compiled engine and the generated contract. It is
/// not a TypeScript project, so it is a dependency but never a project reference.
const NATIVE: &str = "native";

/// A JSON value whose object keys keep the order they were given, so a manifest reads
/// the way npm writes one and an `exports` map keeps `types` ahead of `default`.
enum Json {
    Str(String),
    Bool(bool),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn str(text: impl Into<String>) -> Json {
        Json::Str(text.into())
    }

    fn strings<I, S>(items: I) -> Json
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Json::Array(
            items
                .into_iter()
                .map(|item| Json::Str(item.into()))
                .collect(),
        )
    }

    fn object(fields: Vec<(&str, Json)>) -> Json {
        Json::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }

    fn render(&self, out: &mut String, indent: usize) {
        match self {
            Json::Str(text) => {
                out.push('"');
                for c in text.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            Json::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            Json::Array(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    out.push_str(&" ".repeat(indent + 2));
                    item.render(out, indent + 2);
                    if index + 1 < items.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&" ".repeat(indent));
                out.push(']');
            }
            Json::Object(fields) => {
                if fields.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (index, (key, value)) in fields.iter().enumerate() {
                    out.push_str(&" ".repeat(indent + 2));
                    out.push('"');
                    out.push_str(key);
                    out.push_str("\": ");
                    value.render(out, indent + 2);
                    if index + 1 < fields.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&" ".repeat(indent));
                out.push('}');
            }
        }
    }
}

/// Render every generated file of the Node workspace as (path, contents): the core
/// package, the `@zero-server/sdk` bundle, the README of `@zero-server/native`, the
/// capability and domain packages the current release ships, and the project references.
///
/// # Arguments
///
/// * `root` - the repository root.
/// * `catalog` - the capability map the packages are rendered from.
/// * `version` - the workspace version.
///
/// # Returns
///
/// Every generated file as (path, contents).
///
/// # Errors
///
/// Returns the reason when a package's source cannot be read.
pub fn render_node(
    root: &Path,
    catalog: &Catalog,
    version: &str,
) -> Result<Vec<(String, String)>, String> {
    let workspace = root.join("bindings/node");
    let mut files = Vec::new();

    let core_deps = package_imports(&workspace.join("packages/core"))?;
    files.extend(package_files(
        "core",
        &core_deps,
        &manifest(&Manifest {
            key: "core",
            version,
            private: false,
            description: "The zero-server core's surface for Node: the runtime version of the compiled core, the counterpart of the zero-core crate.",
            homepage: PROJECT_URL,
            keywords: &["zero-server", "http", "server", "core"],
            deps: &core_deps,
            subpaths: &[],
        }),
        core_readme(version),
    ));

    // A capability that lives in another capability's package renders no package of its
    // own, and a package whose release is still ahead renders nothing yet.
    let mut keys: Vec<&str> = Vec::new();
    for capability in &catalog.capabilities {
        let key = capability.node.as_str();
        if key == "core" || key != capability.key || !catalog.package_ships("node", key) {
            continue;
        }
        keys.push(key);
        let mut deps = package_imports(&workspace.join("packages").join(key))?;
        deps.remove(key);
        files.extend(package_files(
            key,
            &deps,
            &manifest(&Manifest {
                key,
                version,
                private: false,
                description: &format!("{}.", capability.summary),
                homepage: &homepage(capability),
                keywords: &["zero-server", "http", "server", key],
                deps: &deps,
                subpaths: &[],
            }),
            capability_readme(root, catalog, &deps, capability, key)?,
        ));
    }

    let mut domains: Vec<&str> = Vec::new();
    for (chapter, members) in catalog.domains() {
        if !catalog.package_ships("node", &chapter.key) {
            continue;
        }
        domains.push(&chapter.key);
        let deps: BTreeSet<String> = members
            .iter()
            .map(|capability| capability.node.clone())
            .collect();
        files.extend(package_files(
            &chapter.key,
            &deps,
            &manifest(&Manifest {
                key: &chapter.key,
                version,
                private: false,
                description: &format!("{}: {}", chapter.title, chapter.intent),
                homepage: &format!("{SITE}/install.html"),
                keywords: &["zero-server", "http", "server", &chapter.key],
                deps: &deps,
                subpaths: &[],
            }),
            domain_readme(chapter, &members),
        ));
        files.push((
            format!("bindings/node/packages/{}/src/index.ts", chapter.key),
            domain_entry(chapter, &members),
        ));
    }

    let all: BTreeSet<String> = keys
        .iter()
        .map(|key| (*key).to_owned())
        .chain(["core".to_owned(), NATIVE.to_owned()])
        .collect();
    let private = !catalog.packages_ship("node");
    files.extend(package_files(
        NODE_BUNDLE,
        &all,
        &manifest(&Manifest {
            key: NODE_BUNDLE,
            version,
            private,
            description: "The zero-server framework over the Rust core: the TypeScript facade every application imports, re-exporting @zero-server/core.",
            homepage: PROJECT_URL,
            keywords: &["zero-server", "http", "server", "framework", "web"],
            deps: &all,
            subpaths: &[],
        }),
        bundle_readme(catalog, &keys, private),
    ));

    files.push((
        format!("bindings/node/packages/{NATIVE}/README.md"),
        native_readme(),
    ));

    let mut references = vec![reference("packages/core")];
    references.extend(keys.iter().map(|key| reference(&format!("packages/{key}"))));
    references.extend(
        domains
            .iter()
            .map(|key| reference(&format!("packages/{key}"))),
    );
    references.push(reference(&format!("packages/{NODE_BUNDLE}")));
    files.push((
        "bindings/node/tsconfig.json".to_owned(),
        pretty(&Json::object(vec![
            ("files", Json::Array(Vec::new())),
            ("references", Json::Array(references)),
        ])),
    ));

    Ok(files)
}

/// The three generated files of one TypeScript package.
fn package_files(
    key: &str,
    deps: &BTreeSet<String>,
    manifest: &Json,
    readme: String,
) -> Vec<(String, String)> {
    vec![
        (
            format!("bindings/node/packages/{key}/package.json"),
            pretty(manifest),
        ),
        (
            format!("bindings/node/packages/{key}/tsconfig.json"),
            pretty(&tsconfig(deps)),
        ),
        (format!("bindings/node/packages/{key}/README.md"), readme),
    ]
}

/// What one npm package's manifest says.
struct Manifest<'a> {
    /// The directory under `bindings/node/packages`, which is also the name after the
    /// `@zero-server/` scope.
    key: &'a str,
    /// The version every package of the workspace carries.
    version: &'a str,
    /// Whether npm must refuse to publish it.
    private: bool,
    /// The one-line description the registry shows.
    description: &'a str,
    /// The page the registry links as the package's home.
    homepage: &'a str,
    /// The registry keywords.
    keywords: &'a [&'a str],
    /// The `@zero-server/<name>` packages it depends on, each pinned to `version`.
    deps: &'a BTreeSet<String>,
    /// The extra entry points it exports beside its root, each a module of the same name
    /// under `dist/`.
    subpaths: &'a [&'a str],
}

/// A package manifest, its fields in the order npm writes them. Every package is under
/// the `@zero-server` scope, the bundle `@zero-server/sdk` included.
///
/// # Arguments
///
/// * `package` - what the manifest says.
///
/// # Returns
///
/// The manifest as JSON.
fn manifest(package: &Manifest) -> Json {
    let mut exports = vec![(".".to_owned(), entry("index"))];
    for subpath in package.subpaths {
        exports.push((format!("./{subpath}"), entry(subpath)));
    }
    let mut fields = vec![
        ("name", Json::str(format!("@zero-server/{}", package.key))),
        ("version", Json::str(package.version)),
    ];
    if package.private {
        fields.push(("private", Json::Bool(true)));
    }
    fields.extend([
        ("description", Json::str(package.description)),
        ("license", Json::str("Apache-2.0")),
        (
            "publishConfig",
            Json::object(vec![("access", Json::str("public"))]),
        ),
        (
            "repository",
            Json::object(vec![
                ("type", Json::str("git")),
                ("url", Json::str(REPOSITORY)),
                (
                    "directory",
                    Json::str(format!("bindings/node/packages/{}", package.key)),
                ),
            ]),
        ),
        ("homepage", Json::str(package.homepage)),
        ("keywords", Json::strings(package.keywords.iter().copied())),
        ("main", Json::str("dist/index.js")),
        ("types", Json::str("dist/index.d.ts")),
        ("exports", Json::Object(exports)),
        ("files", Json::strings(["dist/", "LICENSE"])),
        ("engines", Json::object(vec![("node", Json::str(">= 16"))])),
        ("dependencies", pins(package.deps, package.version)),
    ]);
    Json::object(fields)
}

/// One `exports` entry: the declaration first, so TypeScript matches it before `default`.
fn entry(module: &str) -> Json {
    Json::object(vec![
        ("types", Json::str(format!("./dist/{module}.d.ts"))),
        ("default", Json::str(format!("./dist/{module}.js"))),
    ])
}

/// One project reference.
fn reference(path: &str) -> Json {
    Json::object(vec![("path", Json::str(path))])
}

/// The `@zero-server/<name>` packages the TypeScript sources under a package's `src/` import.
fn package_imports(package: &Path) -> Result<BTreeSet<String>, String> {
    let src = package.join("src");
    let entries = fs::read_dir(&src).map_err(|err| format!("reading {}: {err}", src.display()))?;
    let mut names = BTreeSet::new();
    for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())) {
        if path.extension().and_then(|ext| ext.to_str()) != Some("ts") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        names.extend(node_imports(&text));
    }
    Ok(names)
}

/// The `@zero-server/<name>` packages a TypeScript source imports from.
fn node_imports(source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut rest = source;
    while let Some(at) = rest.find("'@zero-server/") {
        let after = &rest[at + "'@zero-server/".len()..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !name.is_empty() {
            names.insert(name);
        }
        rest = after;
    }
    names
}

/// The dependency map of a package: every name pinned to the workspace version.
fn pins(names: &BTreeSet<String>, version: &str) -> Json {
    Json::Object(
        names
            .iter()
            .map(|name| (format!("@zero-server/{name}"), Json::str(version)))
            .collect(),
    )
}

/// A package's TypeScript project: the shared options, and a reference to each
/// TypeScript package it depends on so `tsc -b` builds them first.
fn tsconfig(deps: &BTreeSet<String>) -> Json {
    let references: Vec<Json> = deps
        .iter()
        .filter(|dep| dep.as_str() != NATIVE)
        .map(|dep| reference(&format!("../{dep}")))
        .collect();
    Json::object(vec![
        ("extends", Json::str("../../tsconfig.base.json")),
        (
            "compilerOptions",
            Json::object(vec![
                ("rootDir", Json::str("src")),
                ("outDir", Json::str("dist")),
                ("composite", Json::Bool(true)),
            ]),
        ),
        ("include", Json::strings(["src/**/*.ts"])),
        ("references", Json::Array(references)),
    ])
}

/// The guide's URL when the capability has one, else the site's front page.
fn homepage(capability: &Capability) -> String {
    match &capability.guide {
        Some(guide) => format!("{SITE}/{}.html", guide.strip_suffix(".md").unwrap_or(guide)),
        None => format!("{SITE}/"),
    }
}

/// The README of one capability package: what it is, how to install it, the guide's
/// example when the guide exists, and where the documentation is.
/// The entry point of a domain package: every capability of the domain re-exported flat,
/// and again under the capability's own name. A name two capabilities of the domain both
/// export is ambiguous, so `export *` leaves it out and the namespaced form reaches it.
fn domain_entry(chapter: &Chapter, members: &[&Capability]) -> String {
    let names = distinct(members.iter().map(|c| c.node.as_str()));
    let installs = names
        .iter()
        .map(|name| format!("`@zero-server/{name}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!(
        "/**\n * {}: {}\n *\n * Installing this package installs {installs}, and re-exports each under its own\n * name, so a name two of them share stays unambiguous.\n *\n * @packageDocumentation\n */\n\n",
        chapter.title, chapter.intent
    );
    for name in &names {
        out.push_str(&format!(
            "export * as {} from '@zero-server/{name}'\n",
            camel(name)
        ));
    }
    out
}

/// The package names a set of capabilities maps to, each once, in first-seen order:
/// two capabilities that live in one package (the engine surface and an own-link
/// guide both in the core) must not re-export it twice.
fn distinct<'a>(names: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    names.filter(|name| seen.insert(*name)).collect()
}

/// The README of a domain package.
fn domain_readme(chapter: &Chapter, members: &[&Capability]) -> String {
    let mut out = format!(
        "# @zero-server/{}\n\n{}\n\nOne install for the {} capabilities of this domain. Each is also its own package, and\n`@zero-server/sdk` is the whole framework in one.\n\n```sh\nnpm install @zero-server/{}\n```\n\n| Capability | Package | What it covers |\n| --- | --- | --- |\n",
        chapter.key,
        chapter.intent,
        members.len(),
        chapter.key
    );
    for capability in members {
        out.push_str(&format!(
            "| [{}]({SITE}/guides/{}.html) | `@zero-server/{}` | {} |\n",
            capability.title, capability.key, capability.node, capability.summary
        ));
    }
    out.push_str(&format!(
        "\nThe guides, with a worked TypeScript example for each, are at [{SITE}]({SITE}/).\n\n## License\n\nApache-2.0\n"
    ));
    out
}

// A domain key as a JavaScript identifier: `field-io` is not one, `fieldIo` is.
fn camel(key: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in key.chars() {
        if ch == '-' || ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn capability_readme(
    root: &Path,
    catalog: &Catalog,
    deps: &BTreeSet<String>,
    capability: &Capability,
    key: &str,
) -> Result<String, String> {
    let reference = node_reference_url(&capability.node);
    let mut out = format!(
        "# @zero-server/{key}\n\n{}. One capability of [zero-server](https://github.com/molexxxx/zero-server), \
         one memory-safe Rust core with bindings for TypeScript, Python, and C#.\n\n{}\n\n\
         ## Install\n\n```sh\nnpm install @zero-server/{key}\n```\n\n\
         This pulls in `@zero-server/native`, the compiled core{}. \
         `npm install @zero-server/{NODE_BUNDLE}` is the whole framework in one package.\n",
        capability.summary,
        doc_buttons(capability, &reference),
        siblings(deps, NATIVE, |dep| format!("`@zero-server/{dep}`"))
    );

    let snippet = format!("bindings/node/guides/{}.ts", capability.key);
    if root.join(&snippet).is_file() {
        let example = regions::snippet(root, &format!("{snippet}#example"))?;
        out.push_str("\n## Example\n\nThe test that runs in CI, spliced here as it ran.\n\n");
        out.push_str(&example);
        out.push('\n');
    }

    out.push_str(&format!(
        "\n## The same capability in every language\n\n{}\n",
        catalog.cross_language(capability)
    ));

    out.push_str(&format!(
        "\n## Documentation\n\n- [`{}` reference]({reference}), every class, function, and \
         type this package exports.\n",
        node_package(capability)
    ));
    if capability.guide.is_some() {
        out.push_str(&format!(
            "- [The {} guide]({}), with the same example in Rust, Python, and C#.\n",
            capability.title,
            homepage(capability)
        ));
    }
    out.push_str(&format!(
        "- [Every capability]({SITE}/), and the [install page]({SITE}/install.html).\n\n\
         ## License\n\nApache-2.0\n"
    ));
    Ok(out)
}

// The row of links every registry page opens with: the capability's own reference in the
// language of the package, its guide when it has one, and the site the rest of it is on.
// Written as plain Markdown links, since the four registries do not agree on how much
// raw HTML they render.
//
// # Arguments
//
// * `capability` - the capability the page is about.
// * `reference` - the URL of its reference in this language.
fn doc_buttons(capability: &Capability, reference: &str) -> String {
    // The actions lead, then the reference they are about.
    let mut row = Vec::new();
    if capability.guide.is_some() {
        row.push(badge("Read the guide", &homepage(capability)));
    }
    row.push(badge("Documentation", &format!("{SITE}/")));
    row.push(badge("API reference", reference));
    row.join(" | ")
}

// One link in the row.
fn badge(alt: &str, href: &str) -> String {
    format!("[{alt}]({href})")
}

/// The README of the `@zero-server/sdk` bundle. While the bundle is private it says why
/// and how the npm tags move until it is published; once published it lists the packages
/// it depends on.
///
/// # Arguments
///
/// * `catalog` - the capability map.
/// * `keys` - the capability packages the current release ships.
/// * `private` - whether the bundle is still private.
///
/// # Returns
///
/// The README.
fn bundle_readme(catalog: &Catalog, keys: &[&str], private: bool) -> String {
    let mut out = String::from(
        "# @zero-server/sdk\n\n\
         The zero-server framework over the Rust core: the TypeScript facade every application \
         imports. It re-exports `@zero-server/core` and, as the facade grows, the routing, ORM, \
         auth and real-time surfaces of the framework.\n",
    );
    if private {
        out.push_str(
            "\nThe package is private at this version. It becomes publishable when the facade \
             reaches parity with the Node SDK it replaces, at which point it takes over the \
             `@zero-server/sdk` name from the 1.x line. Until then npm's `latest` tag for \
             `@zero-server/sdk` stays on the 1.x line. `@zero-server/core` publishes its \
             pre-releases under the `next` tag, so its `latest` tag also stays on the 1.x line \
             until the first final release of this core.\n",
        );
        return out;
    }
    out.push_str(&format!(
        "\n## Install\n\n```sh\nnpm install @zero-server/{NODE_BUNDLE}\n```\n\n\
         ## What it bundles\n\nEach package name opens its reference.\n\n\
         | Package | What it covers |\n| --- | --- |\n"
    ));
    for capability in catalog
        .ordered()
        .into_iter()
        .filter(|capability| keys.contains(&capability.node.as_str()))
    {
        out.push_str(&format!(
            "| [`@zero-server/{}`]({}) | {} |\n",
            capability.node,
            node_reference_url(&capability.node),
            capability.summary
        ));
    }
    out.push_str(&format!(
        "\nAll of them run on `@zero-server/native`, the compiled core, which is one binary \
         whichever packages you install. The guides are at [{SITE}]({SITE}/).\n"
    ));
    out
}

/// The README of `@zero-server/core`. Below major version 2 it says the package is not
/// published from this repository, since the 1.x versions on npm are the earlier
/// framework; a pre-release installs from the `next` dist-tag, and a final version from
/// `latest`.
///
/// # Arguments
///
/// * `version` - the workspace version, in SemVer.
///
/// # Returns
///
/// The README.
fn core_readme(version: &str) -> String {
    let install = match Publish::of(version) {
        Publish::Unpublished => {
            "This package is not published from this repository yet. The 1.x versions of \
             `@zero-server/core` on npm are the earlier JavaScript framework, a different code \
             base.\n"
        }
        Publish::PreRelease => {
            "## Install\n\nPre-releases are published under npm's `next` tag:\n\n\
             ```sh\nnpm install @zero-server/core@next\n```\n\n\
             A plain `npm install @zero-server/core` installs the `latest` tag, which is the 1.x \
             line of the earlier JavaScript framework until the first final release of this \
             core.\n"
        }
        Publish::Final => "## Install\n\n```sh\nnpm install @zero-server/core\n```\n",
    };
    format!(
        "# @zero-server/core\n\n\
         The zero-server core's surface for Node: the runtime version of the compiled core. This \
         is the counterpart of the `zero-core` crate, and like it, it is small. The compiled \
         core it loads is `@zero-server/native`. It has no server API yet.\n\n\
         {install}\n\
         ## Use\n\n```ts\nimport {{ version }} from '@zero-server/core'\n\nconsole.log(version())\n```\n",
    )
}

/// The README of `@zero-server/native`.
fn native_readme() -> String {
    String::from(
        "# @zero-server/native\n\n\
         The compiled zero-server core for Node and the generated napi-rs contract every \
         `@zero-server` package builds on. It is installed as a dependency of \
         `@zero-server/core`, not directly.\n\n\
         The package holds the loader `index.js` and the contract `index.d.ts`, both generated \
         by `napi build` from `bindings/node/src` and drift-checked in CI. The platform binaries \
         ship as `@zero-server/native-<platform>` packages selected by `os`, `cpu` and `libc`.\n",
    )
}

/// Render every generated file of the Python packages as (path, contents): a
/// `pyproject.toml`, a README, and a `py.typed` marker for `zero-server-core` and for each
/// `zero-server-<key>` capability and domain distribution the current release ships, the
/// `zero-server` metapackage that depends on all of them, and the README of
/// `zero-server-native`, the maturin project under `packages/native`.
///
/// The manifests carry the version in its normalized PEP 440 spelling, the form
/// `cargo xtask version` writes and checks in every Python manifest.
///
/// # Arguments
///
/// * `root` - the repository root.
/// * `catalog` - the capability map the packages are rendered from.
/// * `version` - the workspace version, in SemVer.
///
/// # Returns
///
/// Every generated file as (path, contents).
///
/// # Errors
///
/// Returns the reason when a package's source cannot be read, or when `version` has
/// no PEP 440 spelling.
pub fn render_python(
    root: &Path,
    catalog: &Catalog,
    version: &str,
) -> Result<Vec<(String, String)>, String> {
    let python = crate::version::pep440(version)?;
    let version = python.as_str();
    let packages = root.join("bindings/python/packages");
    let mut files = Vec::new();

    let core_deps = python_package_imports(&packages.join("core/zero_server/core"), "core")?;
    files.extend(python_package_files(
        "core",
        version,
        "The zero-server core's surface for Python: the runtime version of the compiled core, the counterpart of the zero-core crate.",
        None,
        &["zero-server", "http", "server", "core"],
        &core_deps,
        python_core_readme(),
    ));

    // A package whose release is still ahead renders nothing yet.
    let mut keys: Vec<&str> = Vec::new();
    for capability in catalog.ordered() {
        let key = capability.python.as_str();
        if key == "core" || key != capability.key || !catalog.package_ships("python", key) {
            continue;
        }
        keys.push(key);
        let deps = python_package_imports(&packages.join(key).join("zero_server").join(key), key)?;
        files.extend(python_package_files(
            key,
            version,
            &format!("{}.", capability.summary),
            Some(&homepage(capability)),
            &["zero-server", "http", "server", key],
            &deps,
            python_capability_readme(root, catalog, &deps, capability, key)?,
        ));
    }

    for (chapter, members) in catalog.domains() {
        if catalog.package_ships("python", &chapter.key) {
            files.extend(python_domain_files(chapter, &members, version));
        }
    }

    let all: BTreeSet<String> = keys
        .iter()
        .map(|key| (*key).to_owned())
        .chain(["core".to_owned(), NATIVE.to_owned()])
        .collect();
    let facade = catalog.packages_ship("python");
    let description = if facade {
        "The zero-server framework in one package: every capability of one memory-safe Rust core, behind an idiomatic Python facade."
    } else {
        "The zero-server packages for Python in one install: zero-server-core and the compiled core in zero-server-native, pinned to the same version."
    };
    files.push((
        format!("bindings/python/packages/{PYTHON_BUNDLE}/pyproject.toml"),
        pyproject(
            PYTHON_BUNDLE,
            version,
            description,
            None,
            &["zero-server", "http", "server", "web", "framework"],
            &all,
            true,
        ),
    ));
    files.push((
        format!("bindings/python/packages/{PYTHON_BUNDLE}/README.md"),
        python_bundle_readme(catalog, &keys, facade),
    ));
    files.push((
        "bindings/python/packages/native/README.md".to_owned(),
        python_native_readme(),
    ));

    Ok(files)
}

/// The three generated files of one pure Python package.
fn python_package_files(
    key: &str,
    version: &str,
    description: &str,
    homepage: Option<&str>,
    keywords: &[&str],
    deps: &BTreeSet<String>,
    readme: String,
) -> Vec<(String, String)> {
    vec![
        (
            format!("bindings/python/packages/{key}/pyproject.toml"),
            pyproject(key, version, description, homepage, keywords, deps, false),
        ),
        (format!("bindings/python/packages/{key}/README.md"), readme),
        (
            format!("bindings/python/packages/{key}/zero_server/{key}/py.typed"),
            String::new(),
        ),
    ]
}

/// A pure Python project manifest built by hatchling. A capability package ships its
/// portion of the `zero_server` import namespace; the metapackage ships nothing and only
/// depends. `homepage`, when given, is the documentation URL beside the repository.
fn pyproject(
    key: &str,
    version: &str,
    description: &str,
    homepage: Option<&str>,
    keywords: &[&str],
    deps: &BTreeSet<String>,
    metapackage: bool,
) -> String {
    let name = if key == PYTHON_BUNDLE {
        PYTHON_BUNDLE.to_owned()
    } else {
        format!("zero-server-{key}")
    };
    let keywords: Vec<String> = keywords.iter().map(|k| format!("\"{k}\"")).collect();
    let dependencies: Vec<String> = deps
        .iter()
        .map(|dep| format!("    \"zero-server-{dep}=={version}\","))
        .collect();
    let documentation = homepage
        .map(|homepage| format!("Documentation = \"{homepage}\"\n"))
        .unwrap_or_default();
    let build = if metapackage {
        "[tool.hatch.build.targets.wheel]\nbypass-selection = true\n"
    } else {
        "[tool.hatch.build.targets.wheel]\npackages = [\"zero_server\"]\n"
    };
    format!(
        "[build-system]\n\
         requires = [\"hatchling>=1.27\"]\n\
         build-backend = \"hatchling.build\"\n\n\
         [project]\n\
         name = \"{name}\"\n\
         version = \"{version}\"\n\
         description = \"{description}\"\n\
         readme = \"README.md\"\n\
         license = {{ text = \"Apache-2.0\" }}\n\
         license-files = [\"LICENSE\"]\n\
         requires-python = \">=3.10\"\n\
         authors = [{{ name = \"molexxxx\" }}]\n\
         keywords = [{}]\n\
         classifiers = [\n\
         \x20   \"Programming Language :: Python :: 3\",\n\
         \x20   \"License :: OSI Approved :: Apache Software License\",\n\
         \x20   \"Operating System :: OS Independent\",\n\
         \x20   \"Typing :: Typed\",\n\
         ]\n\
         dependencies = [\n{}\n]\n\n\
         [project.urls]\n\
         Repository = \"{PROJECT_URL}\"\n\
         {documentation}\n\
         {build}",
        keywords.join(", "),
        dependencies.join("\n"),
    )
}

/// The `zero-server` distributions a namespace portion imports from: `native` for the
/// generated contract and a capability key for each sibling module, never itself.
fn python_package_imports(portion: &Path, own: &str) -> Result<BTreeSet<String>, String> {
    let entries =
        fs::read_dir(portion).map_err(|err| format!("reading {}: {err}", portion.display()))?;
    let mut names = BTreeSet::new();
    for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())) {
        if path.extension().and_then(|ext| ext.to_str()) != Some("py") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        names.extend(python_imports(&text));
    }
    names.remove(own);
    Ok(names)
}

/// The `zero-server` distributions a Python source imports from.
fn python_imports(source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in source.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("from zero_server.") {
            let module: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            names.insert(module);
        } else if let Some(rest) = line.strip_prefix("from zero_server import ") {
            for name in rest.split(',') {
                let name = name.trim().trim_matches(|c| c == '(' || c == ')').trim();
                if !name.is_empty() {
                    names.insert(name.to_owned());
                }
            }
        } else if let Some(rest) = line.strip_prefix("import zero_server.") {
            let module: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            names.insert(module);
        }
    }
    names
        .into_iter()
        .map(|name| {
            if name == "_native" || name == "raw" {
                NATIVE.to_owned()
            } else {
                name
            }
        })
        .collect()
}

/// The README of one Python capability package.
fn python_capability_readme(
    root: &Path,
    catalog: &Catalog,
    deps: &BTreeSet<String>,
    capability: &Capability,
    key: &str,
) -> Result<String, String> {
    let reference = python_reference_url(&capability.python);
    let mut out = format!(
        "# zero-server-{key}\n\n{}. One capability of [zero-server](https://github.com/molexxxx/zero-server), \
         one memory-safe Rust core with bindings for TypeScript, Python, and C#.\n\n{}\n\n\
         ## Install\n\n```sh\npip install zero-server-{key}\n```\n\n```python\nfrom zero_server import {key}\n```\n\n\
         This pulls in `zero-server-native`, the compiled core{}. \
         `pip install zero-server` is the whole framework in one package.\n",
        capability.summary,
        doc_buttons(capability, &reference),
        siblings(deps, NATIVE, |dep| format!("`zero-server-{dep}`"))
    );

    let snippet = format!("bindings/python/guides/{}.py", capability.key);
    if root.join(&snippet).is_file() {
        let example = regions::snippet(root, &format!("{snippet}#example"))?;
        out.push_str("\n## Example\n\nThe script the test suite runs, spliced here as it ran.\n\n");
        out.push_str(&example);
        out.push('\n');
    }

    out.push_str(&format!(
        "\n## The same capability in every language\n\n{}\n",
        catalog.cross_language(capability)
    ));

    out.push_str(&format!(
        "\n## Documentation\n\n- [`zero_server.{}` reference]({reference}), every class and \
         function in this module.\n",
        capability.python
    ));
    if capability.guide.is_some() {
        out.push_str(&format!(
            "- [The {} guide]({}), with the same example in Rust, TypeScript, and C#.\n",
            capability.title,
            homepage(capability)
        ));
    }
    out.push_str(&format!(
        "- [Every capability]({SITE}/), and the [install page]({SITE}/install.html).\n\n\
         ## License\n\nApache-2.0\n"
    ));
    Ok(out)
}

/// The README of the `zero-server` metapackage. Until the Python facade ships it names
/// the two distributions it pins and says there is no server API yet; from then on it
/// lists the capability distributions it installs.
///
/// # Arguments
///
/// * `catalog` - the capability map.
/// * `keys` - the capability distributions the current release ships.
/// * `facade` - whether the Python facade ships in the current release.
///
/// # Returns
///
/// The README.
fn python_bundle_readme(catalog: &Catalog, keys: &[&str], facade: bool) -> String {
    let install = "## Install\n\n```sh\npip install zero-server\n```\n";
    if !facade {
        return format!(
            "# zero-server\n\n\
             The zero-server packages for Python in one install: `zero-server-core` and the \
             compiled core in `zero-server-native`, pinned to the same version. Today they \
             report the core's version; there is no server API for Python yet.\n\n{install}"
        );
    }
    let mut out = format!(
        "# zero-server\n\n\
         The zero-server framework for Python in one install: every capability distribution \
         below, `zero-server-core`, and the compiled core in `zero-server-native`, pinned to \
         the same version.\n\n{install}\n\
         ## What it installs\n\nEach module name opens its reference.\n\n\
         | Distribution | Module | What it covers |\n| --- | --- | --- |\n"
    );
    for capability in catalog
        .ordered()
        .into_iter()
        .filter(|capability| keys.contains(&capability.python.as_str()))
    {
        out.push_str(&format!(
            "| `zero-server-{0}` | [`zero_server.{0}`]({1}) | {2} |\n",
            capability.python,
            python_reference_url(&capability.python),
            capability.summary
        ));
    }
    out.push_str(&format!(
        "\nAll of them run on `zero-server-native`, the compiled core, which is one extension \
         whichever distributions you install. The guides are at [{SITE}]({SITE}/).\n"
    ));
    out
}

/// The README of `zero-server-core`.
fn python_core_readme() -> String {
    String::from(
        "# zero-server-core\n\n\
         The zero-server core's surface for Python: the runtime version of the compiled core. \
         This is the counterpart of the `zero-core` crate, and like it, it is small. The \
         compiled core it loads is `zero-server-native`. It has no server API yet.\n\n\
         ## Install\n\n```sh\npip install zero-server-core\n```\n\n\
         ## Use\n\n```python\nfrom zero_server.core import version\n\nprint(version())\n```\n",
    )
}

/// The README of `zero-server-native`, the maturin project under `packages/native`.
fn python_native_readme() -> String {
    String::from(
        "# zero-server-native\n\n\
         The compiled zero-server core for Python and the generated contract every \
         `zero-server` package builds on. It is installed as a dependency of \
         `zero-server-core` and of the `zero-server` metapackage, not directly.\n\n\
         The extension is imported as `zero_server._native` and re-exported verbatim at \
         `zero_server.raw`. Its type stub `zero_server/_native/__init__.pyi` is written by the \
         `stub_gen` binary from the Rust source and drift-checked in CI.\n",
    )
}

/// Render every generated file of the .NET packages as (path, contents): a project
/// file and a README for `ZeroServer.Core` and for each `ZeroServer.<Name>` capability and
/// domain package the current release ships, the `ZeroServer` metapackage that depends on
/// all of them, and the README of `ZeroServer.Native`, whose project file carries the
/// native runtimes and is hand-written.
///
/// # Arguments
///
/// * `root` - the repository root.
/// * `catalog` - the capability map the packages are rendered from.
/// * `version` - the workspace version, which decides whether an install line asks for
///   a pre-release.
///
/// # Returns
///
/// Every generated file as (path, contents).
///
/// # Errors
///
/// Returns the reason when a package's sources cannot be read.
pub fn render_dotnet(
    root: &Path,
    catalog: &Catalog,
    version: &str,
) -> Result<Vec<(String, String)>, String> {
    let src = root.join("bindings/dotnet/src");
    let mut files = Vec::new();
    let install = dotnet_install_flag(version);

    let core_deps = dotnet_package_usings(&src.join("ZeroServer.Core"), "Core")?;
    files.push((
        "bindings/dotnet/src/ZeroServer.Core/ZeroServer.Core.csproj".to_owned(),
        csproj(
            "Core",
            "The zero-server core's surface for .NET: the runtime version of the compiled core, the counterpart of the zero-core crate.",
            None,
            &["zero-server", "http", "server", "core"],
            &core_deps,
            false,
        ),
    ));
    files.push((
        "bindings/dotnet/src/ZeroServer.Core/README.md".to_owned(),
        dotnet_core_readme(install),
    ));

    // A capability that lives in another capability's package has no project of its own,
    // and a package whose release is still ahead renders nothing yet.
    let mut names: Vec<String> = Vec::new();
    for capability in &catalog.capabilities {
        if capability.dotnet_package() == "ZeroServer.Core" || capability.node != capability.key {
            continue;
        }
        let name = dotnet_name(&capability.key);
        if !catalog.package_ships("dotnet", &name) {
            continue;
        }
        let deps = dotnet_package_usings(&src.join(format!("ZeroServer.{name}")), &name)?;
        files.push((
            format!("bindings/dotnet/src/ZeroServer.{name}/ZeroServer.{name}.csproj"),
            csproj(
                &name,
                &format!("{}.", capability.summary),
                Some(&homepage(capability)),
                &["zero-server", "http", "server", &capability.key],
                &deps,
                false,
            ),
        ));
        files.push((
            format!("bindings/dotnet/src/ZeroServer.{name}/README.md"),
            dotnet_capability_readme(root, catalog, &deps, capability, &name)?,
        ));
        names.push(name);
    }

    for (chapter, members) in catalog.domains() {
        if catalog.package_ships("dotnet", &pascal(&chapter.key)) {
            files.extend(dotnet_domain_files(chapter, &members));
        }
    }

    let all: BTreeSet<String> = names
        .iter()
        .cloned()
        .chain(["Core".to_owned(), "Native".to_owned()])
        .collect();
    let facade = catalog.packages_ship("dotnet");
    let description = if facade {
        "The whole zero-server framework in one package: every capability of one memory-safe Rust core, behind an idiomatic C# facade."
    } else {
        "The zero-server packages for .NET in one reference: ZeroServer.Core and the compiled core in ZeroServer.Native, at one version."
    };
    files.push((
        "bindings/dotnet/src/ZeroServer/ZeroServer.csproj".to_owned(),
        csproj(
            "",
            description,
            None,
            &["zero-server", "http", "server", "web", "framework"],
            &all,
            true,
        ),
    ));
    files.push((
        "bindings/dotnet/src/ZeroServer/README.md".to_owned(),
        dotnet_bundle_readme(catalog, &names, facade, install),
    ));
    files.push((
        "bindings/dotnet/src/ZeroServer.Native/README.md".to_owned(),
        dotnet_native_readme(),
    ));

    Ok(files)
}

/// A project file. `name` is the part after `ZeroServer.`, or empty for the metapackage,
/// which ships no assembly and only depends. Without a `homepage` the project keeps the
/// `PackageProjectUrl` of `Directory.Build.props`.
fn csproj(
    name: &str,
    description: &str,
    homepage: Option<&str>,
    tags: &[&str],
    deps: &BTreeSet<String>,
    metapackage: bool,
) -> String {
    let id = if name.is_empty() {
        "ZeroServer".to_owned()
    } else {
        format!("ZeroServer.{name}")
    };
    let project_url = homepage
        .map(|homepage| format!("    <PackageProjectUrl>{homepage}</PackageProjectUrl>\n"))
        .unwrap_or_default();
    let mut properties = format!(
        "    <PackageId>{id}</PackageId>\n\
         \x20   <AssemblyName>{id}</AssemblyName>\n\
         \x20   <RootNamespace>{id}</RootNamespace>\n\
         \x20   <Description>{description}</Description>\n\
         \x20   <PackageTags>{}</PackageTags>\n\
         {project_url}\
         \x20   <PackageReadmeFile>README.md</PackageReadmeFile>\n",
        tags.join(";")
    );
    if metapackage {
        properties.push_str(
            "    <IncludeBuildOutput>false</IncludeBuildOutput>\n\
             \x20   <GenerateDocumentationFile>false</GenerateDocumentationFile>\n\
             \x20   <NoWarn>$(NoWarn);NU5128</NoWarn>\n",
        );
    } else {
        properties.push_str(
            "    <GenerateDocumentationFile>true</GenerateDocumentationFile>\n\
             \x20   <IncludeSymbols>true</IncludeSymbols>\n\
             \x20   <SymbolPackageFormat>snupkg</SymbolPackageFormat>\n",
        );
    }
    let references: Vec<String> = deps
        .iter()
        .map(|dep| {
            format!(
                "    <ProjectReference Include=\"../ZeroServer.{dep}/ZeroServer.{dep}.csproj\" />"
            )
        })
        .collect();
    format!(
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n\n\
         \x20 <PropertyGroup>\n{properties}  </PropertyGroup>\n\n\
         \x20 <ItemGroup>\n\
         \x20   <None Include=\"README.md\" Pack=\"true\" PackagePath=\"\\\" />\n\
         \x20 </ItemGroup>\n\n\
         \x20 <ItemGroup>\n{}\n  </ItemGroup>\n\n\
         </Project>\n",
        references.join("\n")
    )
}

/// The `ZeroServer.<X>` packages the C# sources of a project use, never itself.
fn dotnet_package_usings(project: &Path, own: &str) -> Result<BTreeSet<String>, String> {
    let entries =
        fs::read_dir(project).map_err(|err| format!("reading {}: {err}", project.display()))?;
    let mut names = BTreeSet::new();
    for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())) {
        if path.extension().and_then(|ext| ext.to_str()) != Some("cs") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        names.extend(dotnet_usings(&text));
    }
    names.remove(own);
    Ok(names)
}

/// The `ZeroServer.<X>` packages a C# source names in its `using` directives.
fn dotnet_usings(source: &str) -> BTreeSet<String> {
    source
        .lines()
        .filter_map(|line| line.trim().strip_prefix("using ZeroServer."))
        .filter_map(|rest| rest.strip_suffix(';'))
        .map(|name| name.split('.').next().unwrap_or(name).to_owned())
        .collect()
}

/// The README of one .NET capability package.
fn dotnet_capability_readme(
    root: &Path,
    catalog: &Catalog,
    deps: &BTreeSet<String>,
    capability: &Capability,
    name: &str,
) -> Result<String, String> {
    let package = capability.dotnet_package();
    let reference = dotnet_reference_url(&package);
    let mut out = format!(
        "# ZeroServer.{name}\n\n{}. One capability of [zero-server](https://github.com/molexxxx/zero-server), \
         one memory-safe Rust core with bindings for TypeScript, Python, and C#.\n\n{}\n\n\
         ## Install\n\n```sh\ndotnet add package ZeroServer.{name}\n```\n\n```csharp\nusing ZeroServer.{name};\n```\n\n\
         This pulls in `ZeroServer.Native`, the compiled core{}. \
         `dotnet add package ZeroServer` is the whole framework in one package.\n",
        capability.summary,
        doc_buttons(capability, &reference),
        siblings(deps, "Native", |dep| format!("`ZeroServer.{dep}`"))
    );

    // The class is suffixed so it cannot shadow the type it demonstrates: a Guides.Modbus
    // would hide the ZeroServer.Modbus.Modbus the example calls.
    let snippet = format!("bindings/dotnet/samples/ZeroServer.Guides/{name}Guide.cs");
    if root.join(&snippet).is_file() {
        let example = regions::snippet(root, &format!("{snippet}#example"))?;
        out.push_str(
            "\n## Example\n\nThe guide project's example, spliced here as it ran in CI.\n\n",
        );
        out.push_str(&example);
        out.push('\n');
    }

    out.push_str(&format!(
        "\n## The same capability in every language\n\n{}\n",
        catalog.cross_language(capability)
    ));

    out.push_str(&format!(
        "\n## Documentation\n\n- [`{package}` reference]({reference}), every type in this \
         namespace.\n"
    ));
    if capability.guide.is_some() {
        out.push_str(&format!(
            "- [The {} guide]({}), with the same example in Rust, TypeScript, and Python.\n",
            capability.title,
            homepage(capability)
        ));
    }
    out.push_str(&format!(
        "- [Every capability]({SITE}/), and the [install page]({SITE}/install.html).\n\n\
         ## License\n\nApache-2.0\n"
    ));
    Ok(out)
}

// The sibling packages a facade needs besides the engine, named in its README so the
// install line is not a surprise. Most capabilities need none.
// # Arguments
//
// * `deps` - the package's own dependencies, the engine included.
// * `engine` - the dependency to leave out, since the sentence names it already.
// * `render` - how a dependency is written in this registry.
fn siblings(deps: &BTreeSet<String>, engine: &str, render: impl Fn(&str) -> String) -> String {
    let mut names: Vec<String> = deps
        .iter()
        .filter(|dep| dep.as_str() != engine)
        .map(|dep| render(dep))
        .collect();
    names.sort();
    match names.len() {
        0 => String::new(),
        1 => format!(", and {}", names[0]),
        _ => format!(
            ", and {} and {}",
            names[..names.len() - 1].join(", "),
            names[names.len() - 1]
        ),
    }
}

/// The `dotnet add package` flag an install line carries at a version. `dotnet add
/// package` leaves pre-releases out unless asked, so the line asks for one until the
/// first final release from major version 2, the first a plain install finds.
///
/// # Arguments
///
/// * `version` - the workspace version, in SemVer.
///
/// # Returns
///
/// ` --prerelease`, or nothing for a final version from major version 2.
fn dotnet_install_flag(version: &str) -> &'static str {
    match Publish::of(version) {
        Publish::Final => "",
        Publish::Unpublished | Publish::PreRelease => " --prerelease",
    }
}

/// The README of the `ZeroServer` metapackage. Until the C# facade ships it names the
/// two packages it references and says there is no server API yet; from then on it
/// lists the capability packages it installs.
///
/// # Arguments
///
/// * `catalog` - the capability map.
/// * `names` - the capability packages the current release ships, after `ZeroServer.`.
/// * `facade` - whether the C# facade ships in the current release.
/// * `flag` - the flag the install line carries, from [`dotnet_install_flag`].
///
/// # Returns
///
/// The README.
fn dotnet_bundle_readme(catalog: &Catalog, names: &[String], facade: bool, flag: &str) -> String {
    let install = format!("## Install\n\n```sh\ndotnet add package ZeroServer{flag}\n```\n");
    if !facade {
        return format!(
            "# ZeroServer\n\n\
             The zero-server packages for .NET in one reference: `ZeroServer.Core` and the \
             compiled core in `ZeroServer.Native`, at one version. Today they report the core's \
             version; there is no server API for .NET yet.\n\n{install}"
        );
    }
    let mut out = format!(
        "# ZeroServer\n\n\
         The zero-server framework for .NET in one reference: every capability package below, \
         `ZeroServer.Core`, and the compiled core in `ZeroServer.Native`, at one version.\n\n\
         {install}\n\
         ## What it installs\n\nEach package name opens its reference.\n\n\
         | Package | What it covers |\n| --- | --- |\n"
    );
    for capability in catalog.ordered() {
        let package = capability.dotnet_package();
        let shipped = package
            .strip_prefix("ZeroServer.")
            .is_some_and(|name| names.iter().any(|shipped| shipped == name));
        if !shipped {
            continue;
        }
        out.push_str(&format!(
            "| [`{package}`]({}) | {} |\n",
            dotnet_reference_url(&package),
            capability.summary
        ));
    }
    out.push_str(&format!(
        "\nAll of them run on `ZeroServer.Native`, the compiled core, which is one library \
         whichever packages you install. The guides are at [{SITE}]({SITE}/).\n"
    ));
    out
}

/// The README of `ZeroServer.Core`.
///
/// # Arguments
///
/// * `flag` - the flag the install line carries, from [`dotnet_install_flag`].
///
/// # Returns
///
/// The README.
fn dotnet_core_readme(flag: &str) -> String {
    format!(
        "# ZeroServer.Core\n\n\
         The zero-server core's surface for .NET: the runtime version of the compiled core. This \
         is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core \
         it loads is `ZeroServer.Native`. It has no server API yet.\n\n\
         ## Install\n\n```sh\ndotnet add package ZeroServer.Core{flag}\n```\n\n\
         ## Use\n\n```csharp\nusing ZeroServer.Core;\n\nConsole.WriteLine(ZeroServerCore.Version);\n```\n"
    )
}

/// The README of `ZeroServer.Native`.
fn dotnet_native_readme() -> String {
    String::from(
        "# ZeroServer.Native\n\n\
         The compiled zero-server core for .NET and the P/Invoke contract every `ZeroServer` \
         package builds on. It is installed as a dependency of `ZeroServer.Core`, not \
         directly.\n\n\
         `Interop/NativeMethods.cs` declares the exports of `crates/zero-ffi/include/zero.h`, and \
         the package carries the `zero_ffi` cdylib under `runtimes/<rid>/native/` for each \
         published runtime identifier.\n",
    )
}

/// Two-space JSON with a trailing newline, the way npm writes a manifest.
/// A domain's Python distribution: `zero-<key>`, shipping the `zero_server.<key>` module that
/// re-exports the domain's capability modules under their own names, for the same reason the
/// Node package does.
fn python_domain_files(
    chapter: &Chapter,
    members: &[&Capability],
    version: &str,
) -> Vec<(String, String)> {
    let module = chapter.key.replace('-', "_");
    let names = distinct(members.iter().map(|c| c.python.as_str()));
    let deps: BTreeSet<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let installs = names
        .iter()
        .map(|name| format!("``zero_server.{name}``"))
        .collect::<Vec<_>>()
        .join(", ");

    let mut init = format!(
        "\"\"\"{}: {}\n\nInstalling this distribution installs {installs}, and re-exports each under its\nown name, so a name two of them share stays unambiguous.\n\"\"\"\n\nfrom zero_server import {}\n\n__all__ = [{}]\n",
        chapter.title,
        chapter.intent,
        names.join(", "),
        names
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    init.push('\n');

    let mut readme = format!(
        "# zero-server-{}\n\n{}\n\nOne install for the {} capabilities of this domain. Each is also its own\ndistribution, and `zero-server` is the whole framework in one.\n\n```sh\npip install zero-server-{}\n```\n\n```python\nfrom zero_server.{module} import {}\n```\n\n| Capability | Module | What it covers |\n| --- | --- | --- |\n",
        chapter.key,
        chapter.intent,
        members.len(),
        chapter.key,
        names[0]
    );
    for capability in members {
        readme.push_str(&format!(
            "| [{}]({SITE}/guides/{}.html) | `zero_server.{}` | {} |\n",
            capability.title, capability.key, capability.python, capability.summary
        ));
    }
    readme.push_str(&format!(
        "\nThe guides, with a worked Python example for each, are at [{SITE}]({SITE}/).\n\n## License\n\nApache-2.0\n"
    ));

    vec![
        (
            format!("bindings/python/packages/{}/pyproject.toml", chapter.key),
            pyproject(
                &chapter.key,
                version,
                &format!("{}: {}", chapter.title, chapter.intent),
                Some(&format!("{SITE}/install.html")),
                &["zero-server", "http", "server", &chapter.key],
                &deps,
                false,
            ),
        ),
        (
            format!("bindings/python/packages/{}/README.md", chapter.key),
            readme,
        ),
        (
            format!(
                "bindings/python/packages/{}/zero_server/{module}/__init__.py",
                chapter.key
            ),
            init,
        ),
        (
            format!(
                "bindings/python/packages/{}/zero_server/{module}/py.typed",
                chapter.key
            ),
            String::new(),
        ),
    ]
}

/// A domain's NuGet package: `ZeroServer.<Name>`, which references the domain's capability
/// packages and ships no assembly of its own. C# cannot re-export a namespace, so a
/// consumer writes the capability's `using` as they would anyway.
fn dotnet_domain_files(chapter: &Chapter, members: &[&Capability]) -> Vec<(String, String)> {
    let name = pascal(&chapter.key);
    let mut references = String::new();
    for capability in members {
        let package = capability.dotnet_package();
        references.push_str(&format!(
            "    <ProjectReference Include=\"../{package}/{package}.csproj\" />\n"
        ));
    }
    let csproj = format!(
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n\n  <PropertyGroup>\n    <PackageId>ZeroServer.{name}</PackageId>\n    <Description>{}: {}</Description>\n    <PackageTags>zero-server;http;server;{}</PackageTags>\n    <PackageProjectUrl>{SITE}/install.html</PackageProjectUrl>\n    <PackageReadmeFile>README.md</PackageReadmeFile>\n    <IncludeBuildOutput>false</IncludeBuildOutput>\n    <GenerateDocumentationFile>false</GenerateDocumentationFile>\n    <NoWarn>$(NoWarn);NU5128</NoWarn>\n  </PropertyGroup>\n\n  <ItemGroup>\n    <None Include=\"README.md\" Pack=\"true\" PackagePath=\"\\\" />\n  </ItemGroup>\n\n  <ItemGroup>\n{references}  </ItemGroup>\n\n</Project>\n",
        chapter.title, chapter.intent, chapter.key
    );

    let mut readme = format!(
        "# ZeroServer.{name}\n\n{}\n\nOne reference for the {} capabilities of this domain. Each is also its own package,\nand `ZeroServer` is the whole framework in one.\n\n```sh\ndotnet add package ZeroServer.{name}\n```\n\nThis package ships no assembly: it brings in the packages below, and each keeps its own\nnamespace, so a type is named the way it is when the package is referenced directly.\n\n| Capability | Package | What it covers |\n| --- | --- | --- |\n",
        chapter.intent,
        members.len()
    );
    for capability in members {
        readme.push_str(&format!(
            "| [{}]({SITE}/guides/{}.html) | `{}` | {} |\n",
            capability.title,
            capability.key,
            capability.dotnet_package(),
            capability.summary
        ));
    }
    readme.push_str(&format!(
        "\nThe guides, with a worked C# example for each, are at [{SITE}]({SITE}/).\n\n## License\n\nApache-2.0\n"
    ));

    vec![
        (
            format!("bindings/dotnet/src/ZeroServer.{name}/ZeroServer.{name}.csproj"),
            csproj,
        ),
        (
            format!("bindings/dotnet/src/ZeroServer.{name}/README.md"),
            readme,
        ),
    ]
}

/// A kebab-case key as a .NET package-name segment: `field-io` becomes `FieldIo`.
pub(crate) fn pascal(key: &str) -> String {
    key.split('-').map(dotnet_name).collect::<Vec<_>>().concat()
}

fn pretty(value: &Json) -> String {
    let mut text = String::new();
    value.render(&mut text, 0);
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_packages_a_source_imports() {
        let source = concat!(
            "import { DeviceIdentity } from '@zero-server/security'\n",
            "import type { AuditEntry } from '@zero-server/native'\n",
            "export { Transport } from '@zero-server/core/transport'\n",
        );
        let names: Vec<String> = node_imports(source).into_iter().collect();
        assert_eq!(names, ["core", "native", "security"]);
    }

    #[test]
    fn pins_every_dependency_and_references_only_typescript_packages() {
        let deps: BTreeSet<String> = ["native", "security"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let pinned = pretty(&pins(&deps, "0.2.0"));
        assert!(pinned.contains("\"@zero-server/native\": \"0.2.0\""));
        assert!(pinned.contains("\"@zero-server/security\": \"0.2.0\""));
        let project = pretty(&tsconfig(&deps));
        assert!(project.contains("\"path\": \"../security\""));
        assert!(!project.contains("../native"));
    }

    #[test]
    fn every_package_is_scoped_and_a_private_one_says_so_after_its_version() {
        let deps = BTreeSet::new();
        let bundle = pretty(&manifest(&Manifest {
            key: NODE_BUNDLE,
            version: "0.2.0",
            private: true,
            description: "d",
            homepage: "h",
            keywords: &[],
            deps: &deps,
            subpaths: &[],
        }));
        assert!(bundle.starts_with(
            "{\n  \"name\": \"@zero-server/sdk\",\n  \"version\": \"0.2.0\",\n  \"private\": true,\n  \"description\": \"d\","
        ));
        assert!(!bundle.contains("./transport"));
        let core = pretty(&manifest(&Manifest {
            key: "core",
            version: "0.2.0",
            private: false,
            description: "d",
            homepage: "h",
            keywords: &[],
            deps: &deps,
            subpaths: &["transport"],
        }));
        assert!(core.contains("\"name\": \"@zero-server/core\""));
        assert!(!core.contains("\"private\""));
        assert!(core.contains(
            "\"./transport\": {\n      \"types\": \"./dist/transport.d.ts\",\n      \"default\": \"./dist/transport.js\"\n    }"
        ));
    }

    #[test]
    fn pyproject_version_python_manifests_are_rendered_in_the_normalized_spelling() {
        let root = crate::docs::repo_root();
        let catalog = Catalog::load(&root).unwrap();
        let files = render_python(&root, &catalog, "2.0.0-alpha.1").unwrap();
        let manifests: Vec<&String> = files
            .iter()
            .filter(|(path, _)| path.ends_with("pyproject.toml"))
            .map(|(_, text)| text)
            .collect();
        assert!(!manifests.is_empty());
        for text in manifests {
            assert!(text.contains("version = \"2.0.0a1\"\n"), "{text}");
            assert!(!text.contains("2.0.0-alpha.1"), "{text}");
        }
    }

    #[test]
    fn core_readme_a_version_below_major_2_is_not_published_from_this_repository() {
        let readme = core_readme("0.1.0");
        assert!(readme.contains("This package is not published from this repository yet."));
        assert!(!readme.contains("npm install"), "{readme}");
        assert_eq!(Publish::of("1.4.0-rc.1"), Publish::Unpublished);
    }

    #[test]
    fn core_readme_a_pre_release_installs_from_the_next_dist_tag() {
        let readme = core_readme("2.0.0-alpha.1");
        assert!(readme.contains("```sh\nnpm install @zero-server/core@next\n```"));
        assert!(
            readme.contains("A plain `npm install @zero-server/core` installs the `latest` tag")
        );
        assert!(!readme.contains("not published"), "{readme}");
    }

    #[test]
    fn core_readme_a_final_version_installs_from_latest() {
        let readme = core_readme("2.0.0");
        assert!(readme.contains("```sh\nnpm install @zero-server/core\n```"));
        assert!(!readme.contains("@next"), "{readme}");
    }

    // npm sets `latest` on the first version of a new package whatever tag it is
    // published under, so only a package npm already carries keeps `latest` off a
    // pre-release, and the README promises that for `@zero-server/core` alone.
    #[test]
    fn bundle_readme_a_private_bundle_promises_latest_off_a_pre_release_only_for_core() {
        let root = crate::docs::repo_root();
        let catalog = Catalog::load(&root).unwrap();
        let readme = bundle_readme(&catalog, &[], true);
        assert!(
            readme.contains("`@zero-server/core` publishes its pre-releases under the `next` tag"),
            "{readme}"
        );
        assert!(!readme.contains("`@zero-server/*`"), "{readme}");
    }

    #[test]
    fn dotnet_install_asks_for_a_pre_release_until_the_first_final_release_from_major_2() {
        assert_eq!(dotnet_install_flag("0.1.0"), " --prerelease");
        assert_eq!(dotnet_install_flag("2.0.0-beta.3"), " --prerelease");
        assert_eq!(dotnet_install_flag("2.0.0"), "");
        assert!(dotnet_core_readme(dotnet_install_flag("2.0.0-rc.1"))
            .contains("dotnet add package ZeroServer.Core --prerelease\n"));
    }

    // Every file the three renderers write for the repository at `version`, held to
    // release 1, before any binding ships its capability packages.
    fn rendered(version: &str) -> Vec<(String, String)> {
        let root = crate::docs::repo_root();
        let mut catalog = Catalog::load(&root).unwrap();
        catalog.current_release = 1;
        let mut files = render_node(&root, &catalog, version).unwrap();
        files.extend(render_python(&root, &catalog, version).unwrap());
        files.extend(render_dotnet(&root, &catalog, version).unwrap());
        files
    }

    // The words of the project this generator was first written for, and its license.
    const FOREIGN: [&str; 7] = ["IoT", "iot", "robotics", "drones", "mqtt", "Mqtt", "MIT"];

    #[test]
    fn no_generated_package_file_names_another_product_or_license() {
        for version in ["0.1.0", "2.0.0-alpha.1", "2.0.0"] {
            for (path, text) in rendered(version) {
                for word in FOREIGN {
                    assert!(!text.contains(word), "{path} at {version} names {word}");
                }
            }
        }

        let catalog = Catalog::parse(concat!(
            "[[chapter]]\nkey = \"realtime\"\ntitle = \"Real time\"\nintent = \"Open connections.\"\n\n",
            "[[capability]]\nkey = \"websocket\"\nchapter = \"realtime\"\ntitle = \"WebSocket\"\nsummary = \"Frames\"\ncrates = [\"zero-ws\"]\nnode = \"websocket\"\npython = \"websocket\"\ndotnet = []\n\n",
            "[[capability]]\nkey = \"sse\"\nchapter = \"realtime\"\ntitle = \"Server-sent events\"\nsummary = \"Events\"\ncrates = [\"zero-sse\"]\nnode = \"sse\"\npython = \"sse\"\ndotnet = []\n",
        ))
        .unwrap();
        let (chapter, members) = catalog.domains().remove(0);
        let mut domain = vec![domain_readme(chapter, &members)];
        domain.extend(
            python_domain_files(chapter, &members, "2.0.0")
                .into_iter()
                .map(|(_, text)| text),
        );
        domain.extend(
            dotnet_domain_files(chapter, &members)
                .into_iter()
                .map(|(_, text)| text),
        );
        for text in &domain {
            for word in FOREIGN {
                assert!(
                    !text.contains(word),
                    "a domain package names {word}: {text}"
                );
            }
        }
        assert!(domain[0].contains("## License\n\nApache-2.0\n"));
        assert!(domain[0].contains("`@zero-server/sdk` is the whole framework"));
    }

    #[test]
    fn the_python_metapackage_lives_in_the_directory_named_as_its_distribution() {
        let files = rendered("0.1.0");
        let text = |path: &str| {
            files
                .iter()
                .find(|(name, _)| name == path)
                .map(|(_, text)| text.clone())
                .unwrap_or_else(|| panic!("{path} is not rendered"))
        };
        assert!(text("bindings/python/packages/zero-server/pyproject.toml")
            .contains("name = \"zero-server\"\n"));
        assert!(
            text("bindings/python/packages/zero-server/README.md").starts_with("# zero-server\n")
        );
        assert!(text("bindings/python/packages/core/pyproject.toml")
            .contains("[tool.hatch.build.targets.wheel]\npackages = [\"zero_server\"]\n"));
        assert!(!files
            .iter()
            .any(|(name, _)| name.starts_with("bindings/python/packages/zero_server/")));
    }

    #[test]
    fn a_package_whose_release_is_still_ahead_renders_nothing_yet() {
        let files = rendered("0.1.0");
        let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        for later in [
            "bindings/node/packages/http/",
            "bindings/node/packages/realtime/",
            "bindings/python/packages/middleware/",
            "bindings/python/packages/http3/",
            "bindings/dotnet/src/ZeroServer.Http/",
            "bindings/dotnet/src/ZeroServer.Realtime/",
        ] {
            assert!(
                !names.iter().any(|name| name.starts_with(later)),
                "{later} is rendered"
            );
        }
        let sdk = files
            .iter()
            .find(|(name, _)| name == "bindings/node/packages/sdk/package.json")
            .map(|(_, text)| text.as_str())
            .unwrap();
        assert!(sdk.contains("\"private\": true,"));
    }

    #[test]
    fn json_renders_the_way_npm_writes_it() {
        let value = Json::object(vec![
            ("a", Json::strings(["x"])),
            ("b", Json::Array(Vec::new())),
            ("c", Json::object(Vec::new())),
            ("d", Json::Bool(true)),
        ]);
        assert_eq!(
            pretty(&value),
            "{\n  \"a\": [\n    \"x\"\n  ],\n  \"b\": [],\n  \"c\": {},\n  \"d\": true\n}\n"
        );
    }
}
