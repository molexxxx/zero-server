//! The capability map in `docs/capabilities.toml`: the chapters the guides follow,
//! what each capability covers in every language, and the checks that keep the map
//! honest against the crates, the binding exports, and the .NET types. The map
//! renders the tables in the READMEs and the site through [`Catalog::render`].
//!
//! The map is release-aware the way the standards register is. A capability ships in
//! the latest release its crates' `[[crate]]` rows name, and its binding packages and
//! .NET types ship no earlier than the release `[packages]` names for the binding.
//! [`Catalog::check`] holds the repository to everything at or below the current
//! release, the `current_release` of `docs/standards.toml`, and [`Catalog::pending`]
//! lists the rest, so the map can describe the whole framework while each release is
//! held only to what it ships.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use toml_edit::{DocumentMut, Item};

use crate::standards::RELEASES;

/// The directory of the Node bundle under `bindings/node/packages`: `@zero-server/sdk`,
/// the facade every application imports, which depends on every other package.
pub const NODE_BUNDLE: &str = "sdk";

/// The directory of the Python metapackage under `bindings/python/packages`, named as
/// its distribution, `zero-server`. It ships no module of its own, so it is not named
/// as the `zero_server` import namespace the other distributions share.
pub const PYTHON_BUNDLE: &str = "zero-server";

/// The binding keys `[packages]` may name, as the reference pages and the binding
/// directories name them.
const BINDINGS: [&str; 3] = ["node", "python", "dotnet"];

/// Where the site is published (`layout::HOST` under `layout::DEFAULT_BASE`); the tables
/// link into it with absolute URLs so the registry pages, which do not resolve relative
/// links, reach the guides too.
pub const SITE: &str = "https://molexxxx.github.io/zero-server/docs";

/// A group of capabilities that share a chapter of the guides.
pub struct Chapter {
    pub key: String,
    pub title: String,
    pub intent: String,
}

/// One capability: what it is called, what it covers, and where it lives in each language.
pub struct Capability {
    pub key: String,
    pub chapter: String,
    pub title: String,
    pub summary: String,
    pub crates: Vec<String>,
    pub node: String,
    pub python: String,
    pub dotnet: Vec<String>,
    pub guide: Option<String>,
    /// Further guides that belong here rather than to a capability of their own, because
    /// they cross two: the page and the title the navigation shows it under.
    pub guides: Vec<(String, String)>,
    /// The capabilities whose guides a reader of this one goes to next, in order.
    pub next: Vec<String>,
    /// Pages under `docs/` beside the guide that are not guides themselves, such as a board
    /// page or the bus overview, as paths relative to `docs/`.
    pub pages: Vec<String>,
    /// For a capability with no crate of its own, the Rust items its guide is written
    /// against, which its reference line names.
    pub rust_items: Vec<String>,
    /// The crate those items live in, `zero-core` unless said otherwise.
    pub rust_crate: Option<String>,
}

impl Capability {
    /// The NuGet package the capability lives in: its own `ZeroServer.<Name>`, or
    /// `ZeroServer.Core` for the surface the engine carries itself.
    pub fn dotnet_package(&self) -> String {
        if self.node == "core" {
            "ZeroServer.Core".to_owned()
        } else {
            format!("ZeroServer.{}", dotnet_name(&self.node))
        }
    }
}

/// The whole map: chapters in order, capabilities in order, the engine crates and which
/// of them are the C ABI and the dashboard, the crate that bundles every capability
/// behind a feature each, and the releases that ship each crate and each binding's
/// packages.
pub struct Catalog {
    pub chapters: Vec<Chapter>,
    pub capabilities: Vec<Capability>,
    pub engine: Vec<String>,
    pub abi: Option<String>,
    pub dashboard: Option<String>,
    pub bundle: Option<String>,
    /// The unpublished crates `[tooling]` names. They are claimed without being a
    /// capability, and get no generated README since no registry shows them.
    pub tooling: Vec<String>,
    /// The release each crate first ships in, from its `[[crate]]` row.
    pub crate_releases: BTreeMap<String, u32>,
    /// The release each binding first ships the packages the map names for its
    /// capabilities and chapters, and for .NET the types each capability lists, from
    /// `[packages]`. A binding the table leaves out ships them with the capability.
    pub package_releases: BTreeMap<String, u32>,
    /// The release being built. [`Catalog::load`] reads it from `docs/standards.toml`; a
    /// map parsed from its text alone is read as of the last release, when everything it
    /// names has shipped.
    pub current_release: u32,
}

/// Something the map names that ships after the current release, and so is reported
/// rather than required.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pending {
    /// The release that first ships it.
    pub release: u32,
    /// What it is: a package, the .NET types of a capability, or a guide.
    pub what: String,
}

/// A package the map names in one binding: the capabilities and chapters that live in
/// it, and the first release any of them ships there.
struct Wanted {
    key: String,
    needed_by: Vec<String>,
    release: u32,
}

impl Catalog {
    /// Read `docs/capabilities.toml` under `root`, and the release being built from
    /// `docs/standards.toml`.
    ///
    /// # Arguments
    ///
    /// * `root` - the repository root.
    ///
    /// # Returns
    ///
    /// The map, held to the current release.
    ///
    /// # Errors
    ///
    /// Returns the reason when either file is missing or malformed.
    pub fn load(root: &Path) -> Result<Catalog, String> {
        let path = root.join("docs/capabilities.toml");
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        let mut catalog = Catalog::parse(&text)?;
        catalog.current_release = crate::standards::current_release(root)?;
        Ok(catalog)
    }

    /// Parse the map from its TOML text, read as of the last release.
    ///
    /// # Arguments
    ///
    /// * `text` - the contents of `docs/capabilities.toml`.
    ///
    /// # Returns
    ///
    /// The map.
    ///
    /// # Errors
    ///
    /// Returns the reason when a required field is missing or has the wrong type, or a
    /// release is not one of the releases the standards register knows.
    pub fn parse(text: &str) -> Result<Catalog, String> {
        let doc: DocumentMut = text
            .parse()
            .map_err(|err| format!("capabilities.toml is not valid TOML: {err}"))?;

        let mut chapters = Vec::new();
        for table in tables(&doc, "chapter")? {
            chapters.push(Chapter {
                key: string(table, "key", "chapter")?,
                title: string(table, "title", "chapter")?,
                intent: string(table, "intent", "chapter")?,
            });
        }

        let mut capabilities = Vec::new();
        for table in tables(&doc, "capability")? {
            let key = string(table, "key", "capability")?;
            let context = format!("capability {key}");
            let crates = strings(table, "crates", &context)?;
            let rust_items = optional_strings(table, "rust_items", &context)?;
            if crates.is_empty() && rust_items.is_empty() {
                return Err(format!(
                    "{context} has no crate, so it names the Rust items its guide uses in rust_items"
                ));
            }
            capabilities.push(Capability {
                chapter: string(table, "chapter", &context)?,
                title: string(table, "title", &context)?,
                summary: string(table, "summary", &context)?,
                crates,
                node: string(table, "node", &context)?,
                python: string(table, "python", &context)?,
                dotnet: strings(table, "dotnet", &context)?,
                guide: table.get("guide").and_then(Item::as_str).map(str::to_owned),
                guides: further(table, &context)?,
                next: optional_strings(table, "next", &context)?,
                pages: optional_strings(table, "pages", &context)?,
                rust_items,
                rust_crate: table
                    .get("rust_crate")
                    .and_then(Item::as_str)
                    .map(str::to_owned),
                key,
            });
        }

        let engine_table = doc.get("engine").and_then(Item::as_table_like);
        let engine = engine_table
            .map(|engine| strings_of(engine, "crates", "engine"))
            .transpose()?
            .unwrap_or_default();
        let engine_role = |key: &str| {
            engine_table
                .and_then(|engine| engine.get(key))
                .and_then(Item::as_str)
                .map(str::to_owned)
        };
        let abi = engine_role("abi");
        let dashboard = engine_role("dashboard");

        let bundle = doc
            .get("bundle")
            .and_then(Item::as_table_like)
            .map(|bundle| string(bundle, "crate", "bundle"))
            .transpose()?;

        let tooling = doc
            .get("tooling")
            .and_then(Item::as_table_like)
            .map(|tooling| strings_of(tooling, "crates", "tooling"))
            .transpose()?
            .unwrap_or_default();

        let mut crate_releases = BTreeMap::new();
        for table in tables(&doc, "crate")? {
            let name = string(table, "name", "crate")?;
            let release = table
                .get("release")
                .and_then(release_number)
                .ok_or_else(|| format!("crate {name}: `release` must be one of {RELEASES:?}"))?;
            if crate_releases.insert(name.clone(), release).is_some() {
                return Err(format!("[[crate]] {name} is declared twice"));
            }
        }

        let mut package_releases = BTreeMap::new();
        if let Some(packages) = doc.get("packages") {
            let packages = packages
                .as_table_like()
                .ok_or("[packages] must be a table")?;
            for (binding, value) in packages.iter() {
                if !BINDINGS.contains(&binding) {
                    return Err(format!(
                        "[packages] names {binding}, which is not one of {BINDINGS:?}"
                    ));
                }
                let release = release_number(value)
                    .ok_or_else(|| format!("[packages] {binding} must be one of {RELEASES:?}"))?;
                package_releases.insert(binding.to_owned(), release);
            }
        }

        Ok(Catalog {
            chapters,
            capabilities,
            engine,
            abi,
            dashboard,
            bundle,
            tooling,
            crate_releases,
            package_releases,
            current_release: *RELEASES.end(),
        })
    }

    /// The release a capability ships in: the latest release among its crates, or the
    /// release of the crate its Rust items live in when it has none. A crate without a
    /// `[[crate]]` row counts as the first release, so it is held to the strictest one,
    /// and [`Catalog::check`] reports the missing row.
    ///
    /// # Arguments
    ///
    /// * `capability` - the capability.
    ///
    /// # Returns
    ///
    /// The release that ships it.
    pub fn release_of(&self, capability: &Capability) -> u32 {
        let first = *RELEASES.start();
        let home = [capability.rust_crate.as_deref().unwrap_or("zero-core")];
        let crates: Vec<&str> = if capability.crates.is_empty() {
            home.to_vec()
        } else {
            capability.crates.iter().map(String::as_str).collect()
        };
        crates
            .iter()
            .map(|krate| self.crate_releases.get(*krate).copied().unwrap_or(first))
            .max()
            .unwrap_or(first)
    }

    /// The release a capability ships in one binding: the later of its own release and
    /// the release `[packages]` names for the binding.
    ///
    /// # Arguments
    ///
    /// * `capability` - the capability.
    /// * `binding` - `node`, `python` or `dotnet`.
    ///
    /// # Returns
    ///
    /// The release that ships its package, module or types in that binding.
    pub fn binding_release(&self, capability: &Capability, binding: &str) -> u32 {
        let packages = self
            .package_releases
            .get(binding)
            .copied()
            .unwrap_or(*RELEASES.start());
        self.release_of(capability).max(packages)
    }

    /// Whether something that first ships in `release` is part of the release being built.
    ///
    /// # Arguments
    ///
    /// * `release` - the release that ships it.
    ///
    /// # Returns
    ///
    /// True at or below the current release.
    pub fn ships(&self, release: u32) -> bool {
        release <= self.current_release
    }

    /// Whether a binding package the map names ships in the current release.
    ///
    /// # Arguments
    ///
    /// * `binding` - `node`, `python` or `dotnet`.
    /// * `key` - the package's key: a capability's `node` or `python` value, or a
    ///   chapter key for a domain package; for `dotnet`, the name after `ZeroServer.`.
    ///
    /// # Returns
    ///
    /// True when some capability or chapter that lives in it ships there by now.
    pub fn package_ships(&self, binding: &str, key: &str) -> bool {
        self.wanted(binding)
            .iter()
            .any(|wanted| wanted.key == key && self.ships(wanted.release))
    }

    /// Whether a binding publishes its capability and domain packages in the current
    /// release: whether the release `[packages]` names for it has come.
    ///
    /// # Arguments
    ///
    /// * `binding` - `node`, `python` or `dotnet`.
    ///
    /// # Returns
    ///
    /// True at or after that release, and for a binding the table leaves out.
    pub fn packages_ship(&self, binding: &str) -> bool {
        let release = self
            .package_releases
            .get(binding)
            .copied()
            .unwrap_or(*RELEASES.start());
        self.ships(release)
    }

    // The packages one binding needs beyond its core, native and bundle packages: one per
    // capability key that is not `core`, and one per domain, each with the first release
    // that needs it. A .NET package is named as its directory is, after `ZeroServer.`.
    fn wanted(&self, binding: &str) -> Vec<Wanted> {
        let mut wanted: Vec<Wanted> = Vec::new();
        let mut add = |key: String, needed_by: String, release: u32| match wanted
            .iter_mut()
            .find(|wanted| wanted.key == key)
        {
            Some(found) => {
                found.needed_by.push(needed_by);
                found.release = found.release.min(release);
            }
            None => wanted.push(Wanted {
                key,
                needed_by: vec![needed_by],
                release,
            }),
        };
        for capability in &self.capabilities {
            let key = match binding {
                "python" => capability.python.as_str(),
                _ => capability.node.as_str(),
            };
            if key == "core" {
                continue;
            }
            let key = match binding {
                "dotnet" => dotnet_name(key),
                _ => key.to_owned(),
            };
            add(
                key,
                capability.key.clone(),
                self.binding_release(capability, binding),
            );
        }
        for (chapter, members) in self.domains() {
            let release = members
                .iter()
                .map(|member| self.binding_release(member, binding))
                .min()
                .unwrap_or(*RELEASES.start());
            let key = match binding {
                "dotnet" => chapter
                    .key
                    .split('-')
                    .map(dotnet_name)
                    .collect::<Vec<_>>()
                    .concat(),
                _ => chapter.key.clone(),
            };
            add(key, format!("chapter {}", chapter.key), release);
        }
        wanted
    }

    /// Everything the map names that ships after the current release: each binding's
    /// packages, the .NET types of each capability, and the guides of capabilities that
    /// are not part of this release.
    ///
    /// # Returns
    ///
    /// The pending entries, ordered by release and then by name.
    pub fn pending(&self) -> Vec<Pending> {
        let mut pending = Vec::new();
        for binding in BINDINGS {
            for wanted in self.wanted(binding) {
                if self.ships(wanted.release) {
                    continue;
                }
                let package = match binding {
                    "node" => format!("@zero-server/{}", wanted.key),
                    "python" => format!("zero-server-{}", wanted.key),
                    _ => format!("ZeroServer.{}", wanted.key),
                };
                pending.push(Pending {
                    release: wanted.release,
                    what: format!("{package} ({})", wanted.needed_by.join(", ")),
                });
            }
        }
        for capability in &self.capabilities {
            let release = self.binding_release(capability, "dotnet");
            if !capability.dotnet.is_empty() && !self.ships(release) {
                pending.push(Pending {
                    release,
                    what: format!(
                        "C# types {} ({})",
                        capability.dotnet.join(", "),
                        capability.key
                    ),
                });
            }
            let release = self.release_of(capability);
            if !self.ships(release) {
                pending.push(Pending {
                    release,
                    what: format!("the {} guide ({})", capability.title, capability.key),
                });
            }
        }
        pending.sort();
        pending
    }

    /// The engine crates that are the engine itself: every crate `[engine]` lists except
    /// the one it names as the C ABI and the one it names as the dashboard.
    pub fn core_crates(&self) -> Vec<&str> {
        self.engine
            .iter()
            .map(String::as_str)
            .filter(|krate| {
                Some(*krate) != self.abi.as_deref() && Some(*krate) != self.dashboard.as_deref()
            })
            .collect()
    }

    /// Every capability in table order: the engine's own surface first, then the
    /// chapters in map order.
    pub fn ordered(&self) -> Vec<&Capability> {
        let mut out: Vec<&Capability> = self
            .capabilities
            .iter()
            .filter(|capability| capability.node == "core")
            .collect();
        for chapter in &self.chapters {
            out.extend(
                self.in_chapter(&chapter.key)
                    .filter(|capability| capability.node != "core"),
            );
        }
        out
    }

    /// The chapters worth naming as a set, with every capability they hold. A chapter
    /// qualifies when more than one of its capabilities has a crate of its own, and the
    /// engine's own surface comes with the chapter it belongs to, so installing a domain
    /// gives the whole chapter as the guides present it.
    pub fn domains(&self) -> Vec<(&Chapter, Vec<&Capability>)> {
        self.chapters
            .iter()
            .map(|chapter| {
                let members: Vec<&Capability> = self.in_chapter(&chapter.key).collect();
                (chapter, members)
            })
            .filter(|(_, members)| {
                members
                    .iter()
                    .filter(|capability| !capability.crates.is_empty())
                    .count()
                    > 1
            })
            .collect()
    }

    /// The capabilities of one chapter, in map order.
    pub fn in_chapter<'a>(&'a self, chapter: &'a str) -> impl Iterator<Item = &'a Capability> {
        self.capabilities
            .iter()
            .filter(move |capability| capability.chapter == chapter)
    }

    /// The capability with `key`.
    pub fn capability(&self, key: &str) -> Option<&Capability> {
        self.capabilities
            .iter()
            .find(|capability| capability.key == key)
    }

    /// Where a reader goes after a guide: the guides the capability names as next, each
    /// with what it covers, the pages beside it, and the rest of its chapter. A guide that
    /// belongs to a capability without being its own, such as a walkthrough that crosses
    /// two, leads back to that capability's guide first and then goes where it goes.
    ///
    /// # Arguments
    ///
    /// * `key` - the capability key, or the file stem of a further guide.
    /// * `root` - the repository root, whose pages give their own titles.
    ///
    /// # Returns
    ///
    /// Markdown list lines linking relative to `docs/guides/`, without a trailing newline.
    ///
    /// # Errors
    ///
    /// When the key names no guide, when `next` names a capability without a guide, or
    /// when a page is missing or has no title.
    pub fn next_links(&self, key: &str, root: &Path) -> Result<String, String> {
        let page = format!("guides/{key}.md");
        let (capability, further) = match self.capability(key) {
            Some(capability) => (capability, false),
            None => (
                self.capabilities
                    .iter()
                    .find(|capability| capability.guides.iter().any(|(p, _)| *p == page))
                    .ok_or_else(|| format!("`next` names {key}, which is no guide"))?,
                true,
            ),
        };

        let mut lines = Vec::new();
        let mut listed: BTreeSet<&str> = BTreeSet::new();
        listed.insert(capability.key.as_str());
        let link = |target: &Capability| -> Result<String, String> {
            let guide = target.guide.as_deref().ok_or_else(|| {
                format!(
                    "capability {}: `next` names {}, which has no guide",
                    capability.key, target.key
                )
            })?;
            Ok(format!(
                "- [{}]({}): {}.",
                target.title,
                guide_file(guide),
                clause(&target.summary)
            ))
        };
        if further {
            lines.push(link(capability)?);
        }
        for name in &capability.next {
            let target = self.capability(name).ok_or_else(|| {
                format!(
                    "capability {}: `next` names the unknown {name}",
                    capability.key
                )
            })?;
            if target.key == key {
                continue;
            }
            listed.insert(target.key.as_str());
            lines.push(link(target)?);
        }

        let mut beside = Vec::new();
        for path in capability.pages.iter().filter(|path| **path != page) {
            let text = fs::read_to_string(root.join("docs").join(path))
                .map_err(|err| format!("capability {}: the page {path}: {err}", capability.key))?;
            let title = text
                .lines()
                .find_map(|line| line.strip_prefix("# "))
                .ok_or_else(|| format!("capability {}: {path} has no title", capability.key))?;
            let href = match path.strip_prefix("guides/") {
                Some(file) => file.to_owned(),
                None => format!("../{path}"),
            };
            beside.push(format!("[{}]({href})", title.trim()));
        }
        if !beside.is_empty() {
            lines.push(format!("- Beside it: {}.", beside.join(", ")));
        }

        let chapter = self
            .chapters
            .iter()
            .find(|chapter| chapter.key == capability.chapter)
            .map_or(capability.chapter.as_str(), |chapter| {
                chapter.title.as_str()
            });
        let rest: Vec<String> = self
            .in_chapter(&capability.chapter)
            .filter(|other| !listed.contains(other.key.as_str()))
            .filter_map(|other| {
                other
                    .guide
                    .as_deref()
                    .map(|guide| format!("[{}]({})", other.title, guide_file(guide)))
            })
            .collect();
        if !rest.is_empty() {
            lines.push(format!("- Also in {chapter}: {}.", rest.join(", ")));
        }
        Ok(lines.join("\n"))
    }

    /// The same capability in the other three languages: where to install it from and
    /// where its reference is. Every capability page in every registry carries this, so a
    /// reader who arrives on the crates.io page can reach the npm one without going back
    /// through the site. A language whose package for the capability ships after the
    /// current release gets no row, since a registry page is fixed once published and
    /// must not link a package that does not exist yet; a sentence under the table names
    /// those languages instead.
    ///
    /// # Arguments
    ///
    /// * `capability` - the capability the page is about.
    ///
    /// # Returns
    ///
    /// A Markdown table, and the sentence when a language is left out, without a
    /// trailing newline.
    pub fn cross_language(&self, capability: &Capability) -> String {
        let mut out = String::from("| Language | Package | Reference |\n| --- | --- | --- |\n");
        let [rust_lang, node, python, dotnet] = &LANGUAGES;
        let later: Vec<&str> = [node, python, dotnet]
            .iter()
            .filter(|lang| !self.ships(self.binding_release(capability, lang.key)))
            .map(|lang| lang.name)
            .collect();
        let rust = if capability.crates.is_empty() {
            format!(
                "| Rust | [`zero-core`](https://crates.io/crates/zero-core) | [reference]({}), [docs.rs](https://docs.rs/zero-core), [install]({}) |\n",
                rustdoc_url("zero-core"),
                rust_lang.row_url(capability)
            )
        } else {
            capability
                .crates
                .iter()
                .map(|krate| {
                    format!(
                        "| Rust | [`{krate}`](https://crates.io/crates/{krate}) | [reference]({}), [docs.rs](https://docs.rs/{krate}), [install]({}) |\n",
                        rustdoc_url(krate),
                        rust_lang.row_url(capability)
                    )
                })
                .collect()
        };
        out.push_str(&rust);
        if !later.contains(&node.name) {
            out.push_str(&format!(
                "| TypeScript | [`{0}`](https://www.npmjs.com/package/{0}) | [reference]({1}), [install]({2}) |\n",
                node_package(capability),
                node_reference_url(&capability.node),
                node.row_url(capability)
            ));
        }
        if !later.contains(&python.name) {
            out.push_str(&format!(
                "| Python | [`zero-server-{0}`](https://pypi.org/project/zero-server-{0}/) | [reference]({1}), [install]({2}) |\n",
                capability.python,
                python_reference_url(&capability.python),
                python.row_url(capability)
            ));
        }
        if !later.contains(&dotnet.name) {
            let package = capability.dotnet_package();
            out.push_str(&format!(
                "| C# | [`{package}`](https://www.nuget.org/packages/{package}) | [reference]({}), [install]({}) |\n",
                dotnet_reference_url(&package),
                dotnet.row_url(capability)
            ));
        }
        let mut out = out.trim_end().to_owned();
        if let Some((last, rest)) = later.split_last() {
            let named = match rest {
                [] => (*last).to_owned(),
                _ => format!("{} and {last}", rest.join(", ")),
            };
            let packages = if later.len() == 1 {
                "package"
            } else {
                "packages"
            };
            out.push_str(&format!(
                "\n\nThe {named} {packages} of this capability ship in a later release."
            ));
        }
        out
    }

    /// Check the map against the repository: every library crate claimed once and given
    /// a release, and, for what ships by the current release, the node keys matching the
    /// packages, the python keys matching the modules, every dotnet name declared, every
    /// guide present, and the bundle crate turning on every capability crate. With
    /// `require_guides`, a capability of the current release without a guide is an error
    /// too. What ships later is left to [`Catalog::pending`]; a package that exists early
    /// is accepted, one that no capability claims is not.
    ///
    /// # Arguments
    ///
    /// * `root` - the repository root.
    /// * `lib_crates` - the workspace library crates.
    /// * `require_guides` - whether a capability must have a guide.
    ///
    /// # Returns
    ///
    /// Nothing when the repository holds everything the current release ships.
    ///
    /// # Errors
    ///
    /// Returns every disagreement found, one per line.
    pub fn check(
        &self,
        root: &Path,
        lib_crates: &[String],
        require_guides: bool,
    ) -> Result<(), String> {
        let mut problems = Vec::new();

        for krate in lib_crates {
            if !self.crate_releases.contains_key(krate) {
                problems.push(format!(
                    "crate {krate} has no [[crate]] row, so no release says when it ships"
                ));
            }
        }

        let mut chapter_keys = BTreeSet::new();
        for chapter in &self.chapters {
            if !chapter_keys.insert(chapter.key.as_str()) {
                problems.push(format!("chapter {} is declared twice", chapter.key));
            }
        }
        let mut capability_keys = BTreeSet::new();
        for capability in &self.capabilities {
            if !capability_keys.insert(capability.key.as_str()) {
                problems.push(format!("capability {} is declared twice", capability.key));
            }
            if !chapter_keys.contains(capability.chapter.as_str()) {
                problems.push(format!(
                    "capability {} names the unknown chapter {}",
                    capability.key, capability.chapter
                ));
            }
        }

        let mut claimed: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for capability in &self.capabilities {
            for krate in &capability.crates {
                claimed
                    .entry(krate.as_str())
                    .or_default()
                    .push(capability.key.as_str());
            }
        }
        for krate in &self.engine {
            claimed.entry(krate.as_str()).or_default().push("engine");
        }
        for krate in &self.tooling {
            claimed.entry(krate.as_str()).or_default().push("tooling");
        }
        for (role, named) in [("abi", &self.abi), ("dashboard", &self.dashboard)] {
            if let Some(krate) = named.as_ref().filter(|krate| !self.engine.contains(*krate)) {
                problems.push(format!(
                    "[engine] names {krate} as its {role}, which is not one of its crates"
                ));
            }
        }
        if let Some(name) = &self.bundle {
            claimed.entry(name.as_str()).or_default().push("bundle");
            problems.extend(self.bundle_problems(root, name));
        }
        for krate in lib_crates {
            match claimed.get(krate.as_str()) {
                None => problems.push(format!(
                    "crate {krate} is claimed by no capability and is not in [engine] or [tooling]"
                )),
                Some(owners) if owners.len() > 1 => problems.push(format!(
                    "crate {krate} is claimed more than once: {}",
                    owners.join(", ")
                )),
                Some(_) => {}
            }
        }
        for (krate, owners) in &claimed {
            if lib_crates.iter().any(|known| known == krate) {
                continue;
            }
            // A tooling crate may be a binary alone, such as the task runner.
            let tooling_member = owners.as_slice() == ["tooling"]
                && root.join("crates").join(krate).join("Cargo.toml").is_file();
            if !tooling_member {
                problems.push(format!("{krate} is claimed but is not a library crate"));
            }
        }

        // A domain has a package of its own in each binding, alongside the capabilities;
        // each is required once the first capability or chapter that lives in it ships.
        for (binding, found, place) in [
            ("node", node_packages(root), "bindings/node/packages"),
            ("python", python_packages(root), "bindings/python/packages"),
            ("dotnet", dotnet_packages(root), "bindings/dotnet/src"),
        ] {
            let found = match found {
                Ok(found) => found,
                Err(err) => {
                    problems.push(err);
                    continue;
                }
            };
            let wanted = self.wanted(binding);
            let prefix = if binding == "dotnet" {
                "ZeroServer."
            } else {
                ""
            };
            for package in &found {
                if !wanted.iter().any(|wanted| wanted.key == *package) {
                    problems.push(format!(
                        "{place}/{prefix}{package} exists, which no capability claims"
                    ));
                }
            }
            for wanted in wanted.iter().filter(|wanted| self.ships(wanted.release)) {
                if !found.contains(&wanted.key) {
                    problems.push(format!(
                        "{binding} package {prefix}{} ({}) ships in release {} and has no directory under {place}",
                        wanted.key,
                        wanted.needed_by.join(", "),
                        wanted.release
                    ));
                }
            }
        }

        match dotnet_types(root) {
            Ok(types) => {
                for capability in &self.capabilities {
                    if !self.ships(self.binding_release(capability, "dotnet")) {
                        continue;
                    }
                    for name in &capability.dotnet {
                        if !types.contains(name) {
                            problems.push(format!(
                                "capability {}: {name} is not a type declared under bindings/dotnet/src",
                                capability.key
                            ));
                        }
                    }
                }
            }
            Err(err) => problems.push(err),
        }

        for capability in &self.capabilities {
            if !self.ships(self.release_of(capability)) {
                continue;
            }
            for (page, _) in &capability.guides {
                if !root.join("docs").join(page).is_file() {
                    problems.push(format!(
                        "capability {}: docs/{page} does not exist",
                        capability.key
                    ));
                }
            }
            match &capability.guide {
                Some(guide) if !root.join("docs").join(guide).is_file() => problems.push(format!(
                    "capability {}: docs/{guide} does not exist",
                    capability.key
                )),
                None if require_guides => problems.push(format!(
                    "capability {} ships in release {} and has no guide",
                    capability.key,
                    self.release_of(capability)
                )),
                _ => {}
            }
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "docs/capabilities.toml disagrees with the repository:\n  {}",
                problems.join("\n  ")
            ))
        }
    }

    // The bundle crate against the capabilities of the current release and the ones
    // before it; see the free function `bundle_problems` for the rule.
    fn bundle_problems(&self, root: &Path, name: &str) -> Vec<String> {
        let path = root.join("crates").join(name).join("Cargo.toml");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => return vec![format!("reading {}: {err}", path.display())],
        };
        let lib = root.join("crates").join(name).join("src").join("lib.rs");
        let source = match fs::read_to_string(&lib) {
            Ok(source) => source,
            Err(err) => return vec![format!("reading {}: {err}", lib.display())],
        };
        let shipped: Vec<&Capability> = self
            .capabilities
            .iter()
            .filter(|capability| self.ships(self.release_of(capability)))
            .collect();
        bundle_problems(&text, &source, name, &self.chapters, &shipped)
    }

    /// Render one generated table for a `<!-- table: <kind> [arg] -->` region.
    ///
    /// The Markdown kinds render anywhere, the registries included: `crates` (every
    /// crate with its reference links, or `crates engine` for the engine and the bundle
    /// alone), `reference <capability>`
    /// (the per-language reference links of one guide), `binding <node|python|dotnet>`
    /// (the capability table of one binding README), `domains <language>` (the install
    /// line per domain), and `references` (the four languages with their reference
    /// pages). The HTML kinds are for the site's own pages: `packages <language>` (one
    /// row per capability with its install line, its reference, its worked example, and
    /// the other registries), `install <language>` (the same for the six domains), and
    /// `reference-link <language>` (the head of a reference page, with the other three
    /// languages beside it).
    ///
    /// # Errors
    ///
    /// Returns the reason when the kind or its argument is unknown.
    pub fn render(
        &self,
        directive: &str,
        crate_descriptions: &BTreeMap<String, String>,
    ) -> Result<String, String> {
        let mut words = directive.split_whitespace();
        let kind = words.next().unwrap_or_default();
        let arg = words.next();
        match (kind, arg) {
            ("crates", None) => Ok(self.crates_table(crate_descriptions, false)),
            ("crates", Some("engine")) => Ok(self.crates_table(crate_descriptions, true)),
            ("packages", Some(language @ ("rust" | "node" | "python" | "dotnet"))) => {
                Ok(self.packages_block(language))
            }
            ("install", Some("all")) => Ok(self.install_tabs()),
            ("install", Some(language @ ("rust" | "node" | "python" | "dotnet"))) => {
                Ok(self.install_block(language))
            }
            ("reference", Some(key)) => self
                .capability(key)
                .map(|capability| self.reference_links(capability))
                .ok_or_else(|| format!("reference table names the unknown capability {key}")),
            ("binding", Some(language @ ("node" | "python" | "dotnet"))) => {
                Ok(self.binding_table(language))
            }
            ("domains", Some(language @ ("rust" | "node" | "python" | "dotnet"))) => {
                Ok(self.domains_block(language))
            }
            ("references", None) => Ok(references(false)),
            ("references", Some("absolute")) => Ok(references(true)),
            ("reference-link", Some(language @ ("rust" | "node" | "python" | "dotnet"))) => {
                Ok(reference_link(language))
            }
            _ => Err(format!("unknown table `{directive}`")),
        }
    }

    fn crates_table(&self, descriptions: &BTreeMap<String, String>, engine_only: bool) -> String {
        let mut out = String::from(
            "| Chapter | Crate | What it does |
| --- | --- | --- |
",
        );
        let mut rows: Vec<(String, String)> = Vec::new();
        if let Some(bundle) = &self.bundle {
            rows.push(("Everything".to_owned(), bundle.clone()));
        }
        for krate in &self.engine {
            rows.push(("Engine".to_owned(), krate.clone()));
        }
        if !engine_only {
            for chapter in &self.chapters {
                for capability in self.in_chapter(&chapter.key) {
                    for krate in &capability.crates {
                        rows.push((chapter.title.clone(), krate.clone()));
                    }
                }
            }
        }
        // The chapter is named once per run, so the table reads as a handful of groups.
        let mut last = String::new();
        for (chapter, krate) in rows {
            let description = descriptions.get(&krate).cloned().unwrap_or_default();
            let shown = if chapter == last {
                String::new()
            } else {
                last.clone_from(&chapter);
                format!("**{chapter}**")
            };
            out.push_str(&format!(
                "| {shown} | {} | {description} |
",
                crate_link(&krate)
            ));
        }
        out.trim_end().to_owned()
    }

    // The end of a guide: the capability's API pages in each language, and the row on
    // that language's reference page, which holds the install line and the registry.
    fn reference_links(&self, capability: &Capability) -> String {
        let mut lines = Vec::new();
        let [rust, node, python, dotnet] = &LANGUAGES;
        if !capability.crates.is_empty() {
            let crates: Vec<String> = capability
                .crates
                .iter()
                .map(|krate| format!("[`{krate}`]({})", rustdoc_url(krate)))
                .collect();
            lines.push(format!(
                "- Rust: {}, [install]({})",
                crates.join(", "),
                rust.row_url(capability)
            ));
        } else {
            let home = capability.rust_crate.as_deref().unwrap_or("zero-core");
            let items: Vec<String> = capability
                .rust_items
                .iter()
                .map(|item| format!("`{item}`"))
                .collect();
            let named = match items.as_slice() {
                [only] => only.clone(),
                [first, second] => format!("{first} and {second}"),
                [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
                [] => String::new(),
            };
            lines.push(format!(
                "- Rust: {named} in [`{home}`]({}), [install]({})",
                rustdoc_url(home),
                rust.row_url(capability)
            ));
        }
        lines.push(format!(
            "- TypeScript: [`{}`]({}), [install]({})",
            node_package(capability),
            node_reference_url(&capability.node),
            node.row_url(capability)
        ));
        lines.push(format!(
            "- Python: [`zero_server.{0}`]({1}), [install]({2})",
            capability.python,
            python_reference_url(&capability.python),
            python.row_url(capability)
        ));
        let package = capability.dotnet_package();
        lines.push(format!(
            "- C#: [`{package}`]({}), [install]({})",
            dotnet_reference_url(&package),
            dotnet.row_url(capability)
        ));
        lines.join("\n")
    }

    // The install line for each domain, in the language's own mechanism: a feature in
    // Rust, which decides what compiles, and the capability packages elsewhere, where
    // naming them keeps the manifest an honest record of what the code uses.
    fn domains_block(&self, language: &str) -> String {
        let rows: Vec<(String, String)> = self
            .domains()
            .into_iter()
            .map(|(chapter, _members)| {
                let command = match language {
                    "rust" => format!(
                        "cargo add zero-server --no-default-features --features std,{}",
                        chapter.key
                    ),
                    "node" => format!("npm install @zero-server/{}", chapter.key),
                    "python" => format!("pip install zero-server-{}", chapter.key),
                    _ => format!(
                        "dotnet add package ZeroServer.{}",
                        chapter
                            .key
                            .split('-')
                            .map(dotnet_name)
                            .collect::<Vec<_>>()
                            .concat()
                    ),
                };
                (command, chapter.title.clone())
            })
            .collect();
        let width = rows
            .iter()
            .map(|(command, _)| command.len())
            .max()
            .unwrap_or(0);
        let mut out = String::from(
            "```sh
",
        );
        for (command, title) in rows {
            out.push_str(&format!(
                "{command:<width$}  # {title}
"
            ));
        }
        out.push_str("```");
        out
    }

    fn binding_table(&self, language: &str) -> String {
        let import_heading = match language {
            "node" => "Import",
            "python" => "Module",
            _ => "Package",
        };
        let mut out = format!(
            "| Group | Capability | {import_heading} | What it covers |
| --- | --- | --- | --- |
"
        );
        // The chapter is named once per group, so thirty rows read as a handful of domains
        // rather than a flat list.
        let mut last = "";
        for capability in self.ordered() {
            let import = match language {
                "node" => format!(
                    "[`{}`]({})",
                    node_package(capability),
                    node_reference_url(&capability.node)
                ),
                "python" => format!(
                    "[`zero_server.{0}`]({1})",
                    capability.python,
                    python_reference_url(&capability.python)
                ),
                _ => {
                    let package = capability.dotnet_package();
                    format!("[`{package}`]({})", dotnet_reference_url(&package))
                }
            };
            let title = match guide_url(capability) {
                Some(url) => format!("[{}]({url})", capability.title),
                None => capability.title.clone(),
            };
            // The engine's own surface is hoisted above the chapters, so it is labeled for
            // what it is rather than borrowing the chapter it happens to sit in.
            let chapter = if capability.node == "core" {
                "**Engine**".to_owned()
            } else if capability.chapter == last {
                String::new()
            } else {
                last = &capability.chapter;
                self.chapters
                    .iter()
                    .find(|chapter| chapter.key == capability.chapter)
                    .map(|chapter| format!("**{}**", chapter.title))
                    .unwrap_or_default()
            };
            out.push_str(&format!(
                "| {chapter} | {title} | {import} | {} |
",
                capability.summary
            ));
        }
        out.trim_end().to_owned()
    }

    /// One row per capability for the site's reference and install pages: the title linking
    /// the guide, the install line with a copy button, the name a program uses and where its
    /// reference is, the worked example, the registry page, and the same capability on the
    /// other three registries. Grouped under a heading per chapter, the engine's own surface
    /// first, so the page reads the way the guides are arranged.
    fn packages_block(&self, language: &str) -> String {
        let lang = Language::by_key(language);
        let mut out = String::new();
        let mut last = String::new();
        for capability in self.ordered() {
            let chapter = if capability.node == "core" {
                "Engine".to_owned()
            } else {
                self.chapter_title(&capability.chapter)
            };
            if chapter != last {
                if !last.is_empty() {
                    out.push_str("</div>\n\n");
                }
                out.push_str(&format!("### {chapter}\n\n<div class=\"pkgs\">\n"));
                last = chapter;
            }
            out.push_str(&package_row(lang, capability));
        }
        out.push_str("</div>");
        out
    }

    // The same six domains once, in a tab per language, so a page that speaks to all four
    // shows a reader the one they work in rather than the set four times over. The tab
    // ids are the ones every listing on the site uses, so the choice carries between pages.
    fn install_tabs(&self) -> String {
        const TABS: [(&str, &str, &str); 4] = [
            ("Rust", "rust", "rust"),
            ("TypeScript", "typescript", "node"),
            ("Python", "python", "python"),
            ("C#", "c", "dotnet"),
        ];
        let mut tabs = String::new();
        let mut panels = String::new();
        for (label, id, key) in TABS {
            tabs.push_str(&format!(
                "<button class=\"lang-tab\" role=\"tab\" type=\"button\" id=\"domains-tab-{id}\" aria-controls=\"domains-{id}\" aria-selected=\"false\" data-lang=\"{id}\">{label}</button>\n"
            ));
            panels.push_str(&format!(
                "<section class=\"lang-panel\" id=\"domains-{id}\" role=\"tabpanel\" aria-labelledby=\"domains-tab-{id}\" data-lang=\"{id}\" tabindex=\"0\">\n{}\n</section>\n",
                self.install_block(key)
            ));
        }
        format!(
            "<div class=\"langs\">\n<div class=\"lang-tabs\" role=\"tablist\" aria-label=\"Language\">\n{tabs}</div>\n{panels}</div>"
        )
    }

    /// The six domains as install rows for the site: the install line with a copy button,
    /// the domain linked to its registry page where it is a package, and the capabilities
    /// it brings in, each linking its guide.
    fn install_block(&self, language: &str) -> String {
        let lang = Language::by_key(language);
        let mut out = String::from("<div class=\"domains\">\n");
        for (chapter, members) in self.domains() {
            let names: Vec<String> = members
                .iter()
                .map(|member| match guide_url(member) {
                    Some(url) => format!("<a href=\"{url}\">{}</a>", escape(&member.title)),
                    None => escape(&member.title),
                })
                .collect();
            let page = domain_url(lang.key, &chapter.title);
            let mut actions = vec![format!(
                "<a class=\"pkg-btn api {}\" href=\"{page}\">API reference</a>",
                lang.key
            )];
            let import = match lang.domain_reference(&chapter.key) {
                Some((import, _)) if lang.key != "rust" => {
                    format!("<code class=\"pkg-import\">{}</code>", escape(&import))
                }
                _ => String::new(),
            };
            if let Some(package) = lang.domain_package(&chapter.key) {
                actions.push(format!(
                    "<a class=\"pkg-btn ext\" href=\"{}\">{}</a>",
                    lang.registry_url(&package),
                    lang.registry
                ));
            }
            let count = names.len();
            let guides = format!(
                "<details class=\"guide-menu\">\n<summary><span class=\"guide-menu-n\">{count}</span> {}<span class=\"guide-menu-caret\" aria-hidden=\"true\"></span></summary>\n<ul class=\"guide-menu-list\">{}</ul>\n</details>",
                if count == 1 { "guide" } else { "guides" },
                names
                    .iter()
                    .map(|name| format!("<li>{name}</li>"))
                    .collect::<String>()
            );
            out.push_str(&format!(
                "<div class=\"domain\">\n<div class=\"pkg-head\">\n<div class=\"pkg-what\"><a class=\"pkg-title\" href=\"{page}\">{}</a>{import}</div>\n{}\n</div>\n<div class=\"pkg-foot\"><div class=\"pkg-btns\">{guides}{}</div></div>\n</div>\n",
                escape(&chapter.title),
                command(&lang.domain_install(&chapter.key)),
                actions.join("")
            ));
        }
        out.push_str("</div>");
        out
    }

    fn chapter_title(&self, key: &str) -> String {
        self.chapters
            .iter()
            .find(|chapter| chapter.key == key)
            .map(|chapter| chapter.title.clone())
            .unwrap_or_default()
    }
}

/// The bundle crate against the capabilities that ship. As its crate doc states, every
/// crate those capabilities claim has a feature named as the crate without its prefix,
/// which turns the crate on and sits in the default set, and lib.rs re-exports the
/// crate. And a chapter with more than one of those capabilities has a feature named
/// for the chapter that turns on, directly or through the features it names, every
/// crate of the chapter, so a build can name a chapter instead of listing its crates.
///
/// # Arguments
///
/// * `manifest` - the bundle's `Cargo.toml`.
/// * `source` - the bundle's `src/lib.rs`.
/// * `name` - the bundle crate, for the messages.
/// * `chapters` - every chapter of the map.
/// * `shipped` - the capabilities of the current release and the ones before it.
///
/// # Returns
///
/// One line per disagreement; empty when the bundle follows the rule.
fn bundle_problems(
    manifest: &str,
    source: &str,
    name: &str,
    chapters: &[Chapter],
    shipped: &[&Capability],
) -> Vec<String> {
    let doc: DocumentMut = match manifest.parse() {
        Ok(doc) => doc,
        Err(err) => return vec![format!("crates/{name}/Cargo.toml is not valid TOML: {err}")],
    };
    let Some(table) = doc.get("features").and_then(Item::as_table_like) else {
        return vec![format!("crates/{name}/Cargo.toml has no [features] table")];
    };
    let features: BTreeMap<String, Vec<String>> = table
        .iter()
        .map(|(key, value)| {
            let enabled = value
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            (key.to_owned(), enabled)
        })
        .collect();
    let default = features.get("default").cloned().unwrap_or_default();

    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for capability in shipped {
        for krate in &capability.crates {
            if !seen.insert(krate.as_str()) {
                continue;
            }
            let feature = bundle_feature(krate);
            let dep = format!("dep:{krate}");
            match features.get(&feature) {
                None => problems.push(format!(
                    "crates/{name}/Cargo.toml has no `{feature}` feature for {krate} ({})",
                    capability.key
                )),
                Some(enabled) if !enabled.contains(&dep) => problems.push(format!(
                    "crates/{name}/Cargo.toml: feature `{feature}` does not enable {dep}"
                )),
                Some(_) => {}
            }
            if !default.contains(&feature) {
                problems.push(format!(
                    "crates/{name}/Cargo.toml: `{feature}` is not in the default feature set"
                ));
            }
            let reexport = format!("pub use {} as ", krate.replace('-', "_"));
            if !source.contains(&reexport) {
                problems.push(format!(
                    "crates/{name}/src/lib.rs does not re-export {krate}, so feature `{feature}` builds a crate no one can reach"
                ));
            }
        }
    }

    for chapter in chapters {
        let members: Vec<&Capability> = shipped
            .iter()
            .copied()
            .filter(|capability| capability.chapter == chapter.key)
            .filter(|capability| !capability.crates.is_empty())
            .collect();
        if members.len() < 2 {
            continue;
        }
        if !features.contains_key(&chapter.key) {
            problems.push(format!(
                "crates/{name}/Cargo.toml has no `{}` feature for the chapter of the same name",
                chapter.key
            ));
            continue;
        }
        let reached = turned_on(&features, &chapter.key);
        let missing: Vec<&str> = members
            .iter()
            .flat_map(|capability| capability.crates.iter())
            .map(String::as_str)
            .filter(|krate| !reached.contains(*krate))
            .collect();
        if !missing.is_empty() {
            problems.push(format!(
                "crates/{name}/Cargo.toml: feature `{}` does not turn on {} of the {} chapter",
                chapter.key,
                missing.join(", "),
                chapter.key
            ));
        }
    }
    problems
}

/// The bundle feature that turns a capability crate on: the crate's name without its
/// prefix, `zero-server-` for the crates whose short name another registry holds and
/// `zero-` for the rest.
///
/// # Arguments
///
/// * `krate` - the crate's name.
///
/// # Returns
///
/// The feature name.
fn bundle_feature(krate: &str) -> String {
    krate
        .strip_prefix("zero-server-")
        .or_else(|| krate.strip_prefix("zero-"))
        .unwrap_or(krate)
        .to_owned()
}

/// Every optional dependency a feature turns on, through the features it names as well
/// as its own `dep:` entries and `crate/feature` entries.
///
/// # Arguments
///
/// * `features` - the `[features]` table, each feature with what it enables.
/// * `start` - the feature to follow.
///
/// # Returns
///
/// The names of the dependencies turned on.
fn turned_on(features: &BTreeMap<String, Vec<String>>, start: &str) -> BTreeSet<String> {
    let mut crates = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut queue = vec![start.to_owned()];
    while let Some(feature) = queue.pop() {
        if !visited.insert(feature.clone()) {
            continue;
        }
        for entry in features.get(&feature).into_iter().flatten() {
            if let Some(krate) = entry.strip_prefix("dep:") {
                crates.insert(krate.to_owned());
            } else if let Some((krate, _)) = entry.split_once('/') {
                if !krate.ends_with('?') {
                    crates.insert(krate.to_owned());
                }
            } else {
                queue.push(entry.clone());
            }
        }
    }
    crates
}

/// One language's packaging: how a capability is named and installed there, and which
/// registry holds it.
pub(crate) struct Language {
    /// The key the reference page and the binding directory use (`node` for TypeScript).
    pub key: &'static str,
    /// The language as a reader names it.
    pub name: &'static str,
    /// The registry that holds its packages.
    pub registry: &'static str,
    /// The fragment of the guide section that shows the language's example.
    pub anchor: &'static str,
}

/// The four languages, in the order the site presents them.
pub(crate) const LANGUAGES: [Language; 4] = [
    Language {
        key: "rust",
        name: "Rust",
        registry: "crates.io",
        anchor: "rust",
    },
    Language {
        key: "node",
        name: "TypeScript",
        registry: "npm",
        anchor: "typescript",
    },
    Language {
        key: "python",
        name: "Python",
        registry: "PyPI",
        anchor: "python",
    },
    Language {
        key: "dotnet",
        name: "C#",
        registry: "NuGet",
        anchor: "c",
    },
];

impl Language {
    pub(crate) fn by_key(key: &str) -> &'static Language {
        LANGUAGES
            .iter()
            .find(|language| language.key == key)
            .expect("one of the four languages")
    }

    /// The package that carries every capability in this language.
    pub(crate) fn bundle(&self) -> &'static str {
        match self.key {
            "dotnet" => "ZeroServer",
            _ => "zero-server",
        }
    }

    /// What one unit of the generated reference is called in this language.
    pub(crate) fn unit(&self) -> &'static str {
        match self.key {
            "rust" => "crate",
            "python" => "module",
            _ => "package",
        }
    }

    /// The tool that generates this language's reference.
    pub(crate) fn generator(&self) -> &'static str {
        match self.key {
            "rust" => "rustdoc",
            "node" => "typedoc",
            "python" => "pdoc",
            _ => "DocFX",
        }
    }

    /// The page that opens the whole generated reference: the umbrella crate's rustdoc,
    /// which lists every crate beside it, typedoc's package list, pdoc's package page, and
    /// the root namespace in DocFX.
    pub(crate) fn api_index_url(&self) -> String {
        match self.key {
            "rust" => rustdoc_url("zero-server"),
            "node" => format!("{SITE}/reference/node/index.html"),
            "python" => format!("{SITE}/reference/python/zero_server.html"),
            _ => dotnet_reference_url("ZeroServer"),
        }
    }

    /// The row for `capability` on this language's reference page: its install line, API
    /// pages, guide, worked example, and registry page in one place.
    pub(crate) fn row_url(&self, capability: &Capability) -> String {
        format!(
            "{SITE}/reference/{0}.html#{0}-{1}",
            self.key, capability.key
        )
    }

    /// A domain package's page in the generated reference, where the generator documents
    /// it: typedoc and pdoc take the domain packages as modules. A NuGet domain package
    /// holds no code of its own, and a Rust domain is a feature of the umbrella crate.
    fn domain_reference(&self, chapter: &str) -> Option<(String, String)> {
        match self.key {
            "rust" => Some(("zero-server".to_owned(), rustdoc_url("zero-server"))),
            "node" => Some((
                format!("@zero-server/{chapter}"),
                node_reference_url(chapter),
            )),
            "python" => {
                let module = chapter.replace('-', "_");
                Some((
                    format!("zero_server.{module}"),
                    python_reference_url(&module),
                ))
            }
            _ => None,
        }
    }

    /// The package a capability is in this language.
    pub(crate) fn package(&self, capability: &Capability) -> String {
        match self.key {
            "rust" => capability
                .crates
                .first()
                .cloned()
                .unwrap_or_else(|| "zero-core".to_owned()),
            "node" => node_package(capability),
            "python" => format!("zero-server-{}", capability.python),
            _ => capability.dotnet_package(),
        }
    }

    /// What a reader types to install `package`.
    pub(crate) fn install(&self, package: &str) -> String {
        match self.key {
            "rust" => format!("cargo add {package}"),
            "node" => format!("npm install {package}"),
            "python" => format!("pip install {package}"),
            _ => format!("dotnet add package {package}"),
        }
    }

    /// The registry page of `package`.
    pub(crate) fn registry_url(&self, package: &str) -> String {
        match self.key {
            "rust" => format!("https://crates.io/crates/{package}"),
            "node" => format!("https://www.npmjs.com/package/{package}"),
            "python" => format!("https://pypi.org/project/{package}/"),
            _ => format!("https://www.nuget.org/packages/{package}"),
        }
    }

    /// The name a program uses for the capability, and its page in the generated
    /// reference.
    fn import(&self, capability: &Capability) -> (String, String) {
        match self.key {
            "rust" => {
                let krate = self.package(capability);
                let href = rustdoc_url(&krate);
                (krate, href)
            }
            "node" => (
                node_package(capability),
                node_reference_url(&capability.node),
            ),
            "python" => (
                format!("zero_server.{}", capability.python),
                python_reference_url(&capability.python),
            ),
            _ => {
                let package = capability.dotnet_package();
                let href = dotnet_reference_url(&package);
                (package, href)
            }
        }
    }

    /// The package a domain is in this language, or none where it is a feature instead.
    fn domain_package(&self, chapter: &str) -> Option<String> {
        match self.key {
            "rust" => None,
            "node" => Some(format!("@zero-server/{chapter}")),
            "python" => Some(format!("zero-server-{chapter}")),
            _ => Some(format!(
                "ZeroServer.{}",
                chapter
                    .split('-')
                    .map(dotnet_name)
                    .collect::<Vec<_>>()
                    .concat()
            )),
        }
    }

    /// What a reader types to install a domain.
    fn domain_install(&self, chapter: &str) -> String {
        match self.domain_package(chapter) {
            Some(package) => self.install(&package),
            None => format!("cargo add zero-server --no-default-features --features std,{chapter}"),
        }
    }
}

// One capability's row: what it is, how to install it, and a button for each place to go
// next, the generated API pages first. The row carries an id so a guide, a README, or the
// same row on another language's page can point straight at it. Every link is absolute,
// since the region is committed Markdown that GitHub renders too.
fn package_row(lang: &Language, capability: &Capability) -> String {
    let package = lang.package(capability);
    let (import, reference) = lang.import(capability);
    let guide = guide_url(capability);
    let title = match &guide {
        Some(href) => format!(
            "<a class=\"pkg-title\" href=\"{href}\">{}</a>",
            escape(&capability.title)
        ),
        None => format!(
            "<span class=\"pkg-title\">{}</span>",
            escape(&capability.title)
        ),
    };
    let mut actions = vec![format!(
        "<a class=\"pkg-btn api {}\" href=\"{reference}\">API reference</a>",
        lang.key
    )];
    if let Some(href) = &guide {
        actions.push(format!("<a class=\"pkg-btn\" href=\"{href}\">Guide</a>"));
        actions.push(format!(
            "<a class=\"pkg-btn\" href=\"{href}#{}\">Worked example</a>",
            lang.anchor
        ));
    }
    actions.push(format!(
        "<a class=\"pkg-btn ext\" href=\"{}\">{}</a>",
        lang.registry_url(&package),
        lang.registry
    ));
    if lang.key == "rust" {
        actions.push(format!(
            "<a class=\"pkg-btn ext\" href=\"https://docs.rs/{package}\">docs.rs</a>"
        ));
    }
    let others: Vec<String> = LANGUAGES
        .iter()
        .filter(|other| other.key != lang.key)
        .map(|other| {
            format!(
                "<a href=\"{}\" title=\"{}\">{}</a>",
                other.row_url(capability),
                escape(&other.package(capability)),
                other.name
            )
        })
        .collect();
    format!(
        "<div class=\"pkg\" id=\"{}-{}\">\n<div class=\"pkg-head\">\n<div class=\"pkg-what\">{title}<code class=\"pkg-import\">{}</code><p>{}</p></div>\n{}\n</div>\n<div class=\"pkg-foot\">\n<div class=\"pkg-btns\">{}</div>\n<p class=\"pkg-else\"><span>Also in</span> {}</p>\n</div>\n</div>\n",
        lang.key,
        escape(&capability.key),
        escape(&import),
        escape(&capability.summary),
        command(&lang.install(&package)),
        actions.join(""),
        others.join(" ")
    )
}

// An install line with the button that copies it.
pub(crate) fn command(text: &str) -> String {
    let text = escape(text);
    format!(
        "<div class=\"pkg-get\"><code class=\"cmd\">{text}</code><button class=\"copy\" type=\"button\" data-copy=\"{text}\" aria-label=\"Copy the install command\">copy</button></div>"
    )
}

/// Escape text for an HTML text node or a double-quoted attribute.
pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The absolute URL of a capability's guide on the site, when it has one.
/// Where a domain is listed: the section of one language's reference page that holds its
/// capabilities, each with its install line and its API pages.
///
/// # Arguments
///
/// * `language` - the reference page to open (`rust`, `node`, `python`, `dotnet`).
/// * `title` - the chapter's title, which is also its heading on that page.
///
/// # Returns
///
/// The absolute URL of that section.
pub fn domain_url(language: &str, title: &str) -> String {
    let anchor: String = title
        .chars()
        .filter_map(|ch| {
            if ch.is_alphanumeric() || ch == '_' || ch == '-' {
                Some(ch.to_ascii_lowercase())
            } else if ch.is_whitespace() {
                Some('-')
            } else {
                None
            }
        })
        .collect();
    format!("{SITE}/reference/{language}.html#{anchor}")
}

fn guide_url(capability: &Capability) -> Option<String> {
    capability.guide.as_ref().map(|guide| {
        let page = guide.strip_suffix(".md").unwrap_or(guide);
        format!("{SITE}/{page}.html")
    })
}

/// A crate name linked to its rustdoc on the site, which is where every other reference
/// on every page points; docs.rs stays the per-version copy, named on the Rust reference.
fn crate_link(krate: &str) -> String {
    format!("[`{krate}`]({})", rustdoc_url(krate))
}

/// The four languages on the front page and in the root README: what a reader installs,
/// and the page on this site that lists every package and opens each one's API pages.
/// That page is the one way into a generated reference; the trees' own roots hand off to
/// it. Relative, since only the site front page carries it, unless `absolute` is set, which
/// the root README needs since a registry renders it away from the site.
fn references(absolute: bool) -> String {
    let mut out = String::from("| Language | Install | Reference |\n| --- | --- | --- |\n");
    for language in &LANGUAGES {
        let href = if absolute {
            format!("{SITE}/reference/{}.html", language.key)
        } else {
            format!("reference/{}.md", language.key)
        };
        out.push_str(&format!(
            "| {} | `{}` | [{} reference]({href}), every {} with its API pages, generated by {} |\n",
            language.name,
            language.install(language.bundle()),
            language.name,
            language.unit(),
            language.generator()
        ));
    }
    out.trim_end().to_owned()
}

/// The head of one language's reference page, the same shape on all four: what the rows
/// below open, the button into the whole generated reference, the install page and the
/// guides, and the other three languages. Every link is absolute, since the region is
/// committed Markdown that GitHub renders too.
fn reference_link(language: &str) -> String {
    let lang = Language::by_key(language);
    let what = match language {
        "rust" => "Every crate, generated by rustdoc from this commit.",
        "node" => "Every <code>@zero-server</code> package, generated by typedoc from this commit.",
        "python" => "Every <code>zero-server</code> module, generated by pdoc from this commit.",
        _ => "Every <code>ZeroServer</code> package, generated by DocFX from this commit.",
    };
    let switcher: Vec<String> = LANGUAGES
        .iter()
        .map(|other| {
            if other.key == language {
                format!("<span aria-current=\"page\">{}</span>", other.name)
            } else {
                format!(
                    "<a href=\"{SITE}/reference/{}.html\">{}</a>",
                    other.key, other.name
                )
            }
        })
        .collect();
    format!(
        "<div class=\"door\">\n<p>{what} Each row below opens a {}'s API pages, and the same capability in the other three languages is one step away.</p>\n<div class=\"door-actions\"><a class=\"btn btn-warm\" href=\"{}\">Browse the full API <small>{}</small></a><a class=\"btn btn-ghost\" href=\"{SITE}/install.html\">Install</a><a class=\"btn btn-ghost\" href=\"{SITE}/index.html\">Guides</a></div>\n<nav class=\"door-langs\" aria-label=\"The other languages\">{}</nav>\n</div>",
        lang.unit(),
        lang.api_index_url(),
        lang.generator(),
        switcher.join("\n")
    )
}

/// The URL of a module's page in the Python reference on the site.
pub fn python_reference_url(module: &str) -> String {
    format!("{SITE}/reference/python/zero_server/{module}.html")
}

/// The URL of a package's namespace page in the C# reference on the site. The namespace
/// page lists every type the package defines, so it is the one link the package needs.
pub fn dotnet_reference_url(package: &str) -> String {
    format!("{SITE}/reference/dotnet/api/{package}.html")
}

/// The URL of a crate's rustdoc on the site.
pub fn rustdoc_url(krate: &str) -> String {
    format!(
        "{SITE}/reference/rust/{}/index.html",
        krate.replace('-', "_")
    )
}

/// The `[[name]]` tables of a document.
pub(crate) fn tables<'a>(
    doc: &'a DocumentMut,
    name: &str,
) -> Result<Vec<&'a dyn toml_edit::TableLike>, String> {
    let Some(item) = doc.get(name) else {
        return Ok(Vec::new());
    };
    let array = item
        .as_array_of_tables()
        .ok_or_else(|| format!("[[{name}]] must be an array of tables"))?;
    Ok(array
        .iter()
        .map(|table| table as &dyn toml_edit::TableLike)
        .collect())
}

/// A required string field of a table.
pub(crate) fn string(
    table: &dyn toml_edit::TableLike,
    key: &str,
    context: &str,
) -> Result<String, String> {
    table
        .get(key)
        .and_then(Item::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{context}: `{key}` must be a string"))
}

/// A string field that may be left out, which reads as empty.
pub(crate) fn optional(table: &dyn toml_edit::TableLike, key: &str) -> String {
    table
        .get(key)
        .and_then(Item::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Reads a capability's `guides` array: each entry names a page and the title the
/// navigation shows it under.
fn further(
    table: &dyn toml_edit::TableLike,
    context: &str,
) -> Result<Vec<(String, String)>, String> {
    let Some(array) = table.get("guides").and_then(Item::as_array_of_tables) else {
        if table.get("guides").is_some() {
            return Err(format!("{context}: `guides` must be an array of tables"));
        }
        return Ok(Vec::new());
    };
    array
        .iter()
        .map(|entry| {
            let page = entry
                .get("page")
                .and_then(Item::as_str)
                .ok_or_else(|| format!("{context}: a guide needs a `page`"))?;
            let title = entry
                .get("title")
                .and_then(Item::as_str)
                .ok_or_else(|| format!("{context}: a guide needs a `title`"))?;
            Ok((page.to_owned(), title.to_owned()))
        })
        .collect()
}

fn strings(
    table: &dyn toml_edit::TableLike,
    key: &str,
    context: &str,
) -> Result<Vec<String>, String> {
    strings_of(table, key, context)
}

// A release as the map writes it: a whole number that is one of the releases the
// standards register knows.
fn release_number(item: &Item) -> Option<u32> {
    item.as_integer()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| RELEASES.contains(value))
}

// An array of strings that may be left out, which reads as empty.
fn optional_strings(
    table: &dyn toml_edit::TableLike,
    key: &str,
    context: &str,
) -> Result<Vec<String>, String> {
    if table.get(key).is_none() {
        return Ok(Vec::new());
    }
    strings_of(table, key, context)
}

/// The opening clause of a summary, which is what a link line has room for. A summary that
/// lists its parts or qualifies itself is cut at that turn; one that joins two things with
/// ", and" keeps both, or a reader would be told a guide covers only the first.
///
/// # Arguments
///
/// * `summary` - a capability's summary.
///
/// # Returns
///
/// The clause, without a closing period.
pub(crate) fn clause(summary: &str) -> &str {
    let cut = [": ", "; ", ". "]
        .iter()
        .filter_map(|mark| summary.find(mark))
        .min();
    match cut {
        Some(at) => summary[..at].trim_end_matches(['.', ',']),
        None => summary.trim_end_matches('.'),
    }
}

// A guide's link from another guide: both live under `docs/guides/`.
fn guide_file(guide: &str) -> &str {
    guide.strip_prefix("guides/").unwrap_or(guide)
}

fn strings_of(
    table: &dyn toml_edit::TableLike,
    key: &str,
    context: &str,
) -> Result<Vec<String>, String> {
    let array = table
        .get(key)
        .and_then(Item::as_array)
        .ok_or_else(|| format!("{context}: `{key}` must be an array of strings"))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{context}: `{key}` must hold only strings"))
        })
        .collect()
}

/// The capability and domain packages of the Node binding: every directory under
/// `bindings/node/packages` with a TypeScript entry point, other than the core, the
/// compiled engine and the bundle.
fn node_packages(root: &Path) -> Result<BTreeSet<String>, String> {
    let dir = root.join("bindings/node/packages");
    let entries = fs::read_dir(&dir).map_err(|err| format!("reading {}: {err}", dir.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.join("src/index.ts").is_file())
        .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
        .filter(|name| name != "core" && name != "native" && name != NODE_BUNDLE)
        .collect())
}

/// The URL of a capability package's page in the generated TypeScript reference.
pub fn node_reference_url(key: &str) -> String {
    format!("{SITE}/reference/node/modules/_zero_{key}.html")
}

/// The npm package a capability lives in: its own `@zero-server/<key>`, or `@zero-server/core`
/// for the transport surface the engine carries itself.
pub fn node_package(capability: &Capability) -> String {
    format!("@zero-server/{}", capability.node)
}

/// The capability and domain distributions of the Python binding: every directory under
/// `bindings/python/packages` that ships a `zero_server.<module>` namespace portion,
/// other than the core and the metapackage.
fn python_packages(root: &Path) -> Result<BTreeSet<String>, String> {
    let dir = root.join("bindings/python/packages");
    let entries = fs::read_dir(&dir).map_err(|err| format!("reading {}: {err}", dir.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_owned();
            // A domain's directory keeps the map's key, `real-time`, while its module is the
            // identifier `real_time`, since a hyphen cannot appear in a Python module name.
            let module = name.replace('-', "_");
            path.join("zero_server")
                .join(&module)
                .join("__init__.py")
                .is_file()
                .then_some(name)
        })
        .filter(|name| name != "core" && name != PYTHON_BUNDLE)
        .collect())
}

/// Every type declared in the .NET binding's sources.
fn dotnet_types(root: &Path) -> Result<BTreeSet<String>, String> {
    let mut types = BTreeSet::new();
    for project in dotnet_project_dirs(root)? {
        let entries = fs::read_dir(&project)
            .map_err(|err| format!("reading {}: {err}", project.display()))?;
        for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())) {
            if path.extension().and_then(|ext| ext.to_str()) != Some("cs") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .map_err(|err| format!("reading {}: {err}", path.display()))?;
            types.extend(declared_types(&text));
        }
    }
    Ok(types)
}

/// Every project directory under `bindings/dotnet/src`.
fn dotnet_project_dirs(root: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let dir = root.join("bindings/dotnet/src");
    let entries = fs::read_dir(&dir).map_err(|err| format!("reading {}: {err}", dir.display()))?;
    let mut dirs: Vec<std::path::PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// The capability packages under `bindings/dotnet/src`: every `ZeroServer.<Name>` project
/// other than the engine's own (`Core`, `Native`) and the metapackage.
fn dotnet_packages(root: &Path) -> Result<BTreeSet<String>, String> {
    Ok(dotnet_project_dirs(root)?
        .into_iter()
        .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
        .filter_map(|name| name.strip_prefix("ZeroServer.").map(str::to_owned))
        .filter(|name| name != "Core" && name != "Native")
        .collect())
}

/// The .NET package a capability key becomes: the key with its first letter raised.
pub fn dotnet_name(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

/// The names declared by `class`, `record`, `struct`, `enum`, and `interface` in C# source.
fn declared_types(source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut tokens = source.split_whitespace().peekable();
    while let Some(token) = tokens.next() {
        if !matches!(token, "class" | "record" | "struct" | "enum" | "interface") {
            continue;
        }
        let Some(next) = tokens.peek() else {
            break;
        };
        // `record struct Name` names its kind twice.
        if *next == "struct" || *next == "class" {
            continue;
        }
        let name: String = next
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[[chapter]]
key = "real-time"
title = "Real time"
intent = "Connections that stay open."

[[capability]]
key = "sse"
chapter = "real-time"
title = "Server-sent events"
summary = "Server-sent event streams"
crates = ["zero-sse"]
node = "sse"
python = "sse"
dotnet = ["Sse", "SseEvent"]
guide = "guides/sse.md"

[[capability]]
key = "transport"
chapter = "real-time"
title = "Transports"
summary = "The transport surface"
crates = []
rust_items = ["Transport", "Receive"]
node = "core"
python = "core"
dotnet = ["Transport"]

[engine]
crates = ["zero-core"]

[bundle]
crate = "zero-server"
"#;

    #[test]
    fn parses_the_map() {
        let catalog = Catalog::parse(SAMPLE).unwrap();
        assert_eq!(catalog.chapters.len(), 1);
        assert_eq!(catalog.capabilities.len(), 2);
        assert_eq!(catalog.engine, ["zero-core"]);
        assert_eq!(catalog.bundle.as_deref(), Some("zero-server"));
        let sse = catalog.capability("sse").unwrap();
        assert_eq!(sse.dotnet, ["Sse", "SseEvent"]);
        assert_eq!(sse.guide.as_deref(), Some("guides/sse.md"));
        let transport = catalog.capability("transport").unwrap();
        assert!(transport.guide.is_none());
        assert_eq!(transport.rust_items, ["Transport", "Receive"]);
        assert!(transport.rust_crate.is_none());
    }

    #[test]
    fn a_capability_with_no_crate_names_its_rust_items() {
        let bare = SAMPLE.replace("rust_items = [\"Transport\", \"Receive\"]\n", "");
        let refused = Catalog::parse(&bare).err().unwrap();
        assert!(
            refused.contains("capability transport has no crate"),
            "{refused}"
        );
    }

    #[test]
    fn a_guide_leads_to_its_next_guides_the_pages_beside_it_and_its_chapter() {
        let root = std::env::temp_dir().join("zero-next-links");
        fs::create_dir_all(root.join("docs/deploy")).unwrap();
        fs::create_dir_all(root.join("docs/guides")).unwrap();
        fs::write(root.join("docs/guides/walk.md"), "# A walk\n").unwrap();
        fs::write(
            root.join("docs/limits.md"),
            "# Limits and timeouts\n\nText.\n",
        )
        .unwrap();
        fs::write(
            root.join("docs/deploy/tls.md"),
            "Intro\n# TLS certificates\n",
        )
        .unwrap();
        let text = format!(
            "{}\n[[capability]]\nkey = \"websocket\"\nchapter = \"real-time\"\ntitle = \"WebSocket\"\nsummary = \"Frames on a socket: text, binary and control\"\ncrates = [\"zero-websocket\"]\nnode = \"websocket\"\npython = \"websocket\"\ndotnet = [\"WebSocket\"]\nguide = \"guides/websocket.md\"\n\n[[capability.guides]]\npage = \"guides/walk.md\"\ntitle = \"A walk\"\n\n[[capability]]\nkey = \"polling\"\nchapter = \"real-time\"\ntitle = \"Long polling\"\nsummary = \"Long-polling responses\"\ncrates = [\"zero-polling\"]\nnode = \"polling\"\npython = \"polling\"\ndotnet = [\"Polling\"]\nguide = \"guides/polling.md\"\n",
            SAMPLE.replace(
                "guide = \"guides/sse.md\"\n",
                "guide = \"guides/sse.md\"\nnext = [\"websocket\"]\npages = [\"limits.md\", \"deploy/tls.md\", \"guides/walk.md\"]\n"
            )
        )
        .replace("[engine]", "\n[engine]");
        let catalog = Catalog::parse(&text).unwrap();
        assert_eq!(
            catalog.next_links("sse", &root).unwrap(),
            "- [WebSocket](websocket.md): Frames on a socket.\n- Beside it: [Limits and timeouts](../limits.md), [TLS certificates](../deploy/tls.md), [A walk](walk.md).\n- Also in Real time: [Long polling](polling.md)."
        );
        assert!(catalog
            .next_links("walk", &root)
            .unwrap()
            .starts_with("- [WebSocket](websocket.md): Frames on a socket.\n- Also in Real time: [Server-sent events](sse.md), [Long polling](polling.md)."));
        assert!(catalog.next_links("nowhere", &root).is_err());
        let unknown = text.replace("next = [\"websocket\"]", "next = [\"graphql\"]");
        let err = Catalog::parse(&unknown)
            .unwrap()
            .next_links("sse", &root)
            .unwrap_err();
        assert!(err.contains("unknown graphql"), "{err}");
        let guideless = text.replace("next = [\"websocket\"]", "next = [\"transport\"]");
        let err = Catalog::parse(&guideless)
            .unwrap()
            .next_links("sse", &root)
            .unwrap_err();
        assert!(err.contains("has no guide"), "{err}");
        assert_eq!(
            clause("ETag and Last-Modified validators, and byte ranges"),
            "ETag and Last-Modified validators, and byte ranges"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_engine_names_its_abi_and_its_dashboard() {
        let text = SAMPLE.replace(
            "[engine]\ncrates = [\"zero-core\"]\n",
            "[engine]\ncrates = [\"zero-core\", \"zero-ffi\", \"zero-dashboard\"]\nabi = \"zero-ffi\"\ndashboard = \"zero-dashboard\"\n",
        );
        let catalog = Catalog::parse(&text).unwrap();
        assert_eq!(catalog.abi.as_deref(), Some("zero-ffi"));
        assert_eq!(catalog.dashboard.as_deref(), Some("zero-dashboard"));
        assert_eq!(catalog.core_crates(), ["zero-core"]);
        assert_eq!(Catalog::parse(SAMPLE).unwrap().core_crates(), ["zero-core"]);
    }

    #[test]
    fn renders_the_tables() {
        let catalog = Catalog::parse(SAMPLE).unwrap();
        let descriptions = BTreeMap::from([
            (
                "zero-sse".to_owned(),
                "The server-sent events codec".to_owned(),
            ),
            ("zero-core".to_owned(), "The shared types".to_owned()),
            (
                "zero-server".to_owned(),
                "Everything in one crate".to_owned(),
            ),
        ]);

        let crates = catalog.render("crates", &descriptions).unwrap();
        assert!(crates.contains("| **Engine** | [`zero-core`](https://molexxxx.github.io/zero-server/docs/reference/rust/zero_core/index.html) | The shared types |"));
        assert!(crates.starts_with("| Chapter | Crate | What it does |\n| --- | --- | --- |\n| **Everything** | [`zero-server`](https://molexxxx.github.io/zero-server/docs/reference/rust/zero_server/index.html) | Everything in one crate |"));

        let reference = catalog.render("reference sse", &descriptions).unwrap();
        assert!(reference.contains("- TypeScript: [`@zero-server/sse`](https://molexxxx.github.io/zero-server/docs/reference/node/modules/_zero_sse.html)"));
        assert!(reference.contains("- Rust: [`zero-sse`](https://molexxxx.github.io/zero-server/docs/reference/rust/zero_sse/index.html)"));
        assert!(reference.contains("- C#: [`ZeroServer.Sse`](https://molexxxx.github.io/zero-server/docs/reference/dotnet/api/ZeroServer.Sse.html), [install](https://molexxxx.github.io/zero-server/docs/reference/dotnet.html#dotnet-sse)"));

        let binding = catalog.render("binding python", &descriptions).unwrap();
        assert!(binding.contains("| **Real time** | [Server-sent events](https://molexxxx.github.io/zero-server/docs/guides/sse.html) | [`zero_server.sse`](https://molexxxx.github.io/zero-server/docs/reference/python/zero_server/sse.html) | Server-sent event streams |"));
        assert!(binding.contains("| **Engine** | Transports | [`zero_server.core`](https://molexxxx.github.io/zero-server/docs/reference/python/zero_server/core.html) | The transport surface |"));

        assert!(catalog.render("reference nothing", &descriptions).is_err());
        assert!(catalog.render("binding lua", &descriptions).is_err());
    }

    #[test]
    fn renders_the_package_rows_for_the_site() {
        let catalog = Catalog::parse(SAMPLE).unwrap();
        let descriptions = BTreeMap::new();

        let python = catalog.render("packages python", &descriptions).unwrap();
        assert!(python.starts_with("### Engine\n\n<div class=\"pkgs\">\n<div class=\"pkg\" id=\"python-transport\">\n<div class=\"pkg-head\">\n<div class=\"pkg-what\"><span class=\"pkg-title\">Transports</span><code class=\"pkg-import\">zero_server.core</code><p>The transport surface</p></div>"), "{python}");
        assert!(python.contains("### Real time\n\n<div class=\"pkgs\">\n<div class=\"pkg\" id=\"python-sse\">\n<div class=\"pkg-head\">\n<div class=\"pkg-what\"><a class=\"pkg-title\" href=\"https://molexxxx.github.io/zero-server/docs/guides/sse.html\">Server-sent events</a><code class=\"pkg-import\">zero_server.sse</code>"));
        assert!(python.contains("<code class=\"cmd\">pip install zero-server-sse</code><button class=\"copy\" type=\"button\" data-copy=\"pip install zero-server-sse\""));
        assert!(python.contains("<div class=\"pkg-foot\">\n<div class=\"pkg-btns\"><a class=\"pkg-btn api python\" href=\"https://molexxxx.github.io/zero-server/docs/reference/python/zero_server/sse.html\">API reference</a>"));
        assert!(python.contains("<a class=\"pkg-btn\" href=\"https://molexxxx.github.io/zero-server/docs/guides/sse.html\">Guide</a><a class=\"pkg-btn\" href=\"https://molexxxx.github.io/zero-server/docs/guides/sse.html#python\">Worked example</a><a class=\"pkg-btn ext\" href=\"https://pypi.org/project/zero-server-sse/\">PyPI</a></div>"));
        assert!(python.contains("<span>Also in</span> <a href=\"https://molexxxx.github.io/zero-server/docs/reference/rust.html#rust-sse\" title=\"zero-sse\">Rust</a> <a href=\"https://molexxxx.github.io/zero-server/docs/reference/node.html#node-sse\" title=\"@zero-server/sse\">TypeScript</a> <a href=\"https://molexxxx.github.io/zero-server/docs/reference/dotnet.html#dotnet-sse\" title=\"ZeroServer.Sse\">C#</a>"), "the other languages lead to the same row on their own pages");
        assert!(python.ends_with("</p>\n</div>\n</div>\n</div>"));

        let rust = catalog.render("packages rust", &descriptions).unwrap();
        assert!(
            rust.contains("<code class=\"cmd\">cargo add zero-core</code>"),
            "the engine surface is the core crate"
        );
        assert!(rust.contains("<code class=\"pkg-import\">zero-sse</code>"));
        assert!(rust.contains("<a class=\"pkg-btn api rust\" href=\"https://molexxxx.github.io/zero-server/docs/reference/rust/zero_sse/index.html\">API reference</a>"));
        assert!(rust.contains("<a class=\"pkg-btn ext\" href=\"https://crates.io/crates/zero-sse\">crates.io</a><a class=\"pkg-btn ext\" href=\"https://docs.rs/zero-sse\">docs.rs</a>"));

        let dotnet = catalog.render("packages dotnet", &descriptions).unwrap();
        assert!(dotnet.contains("<code class=\"cmd\">dotnet add package ZeroServer.Sse</code>"));
        assert!(dotnet.contains("<div class=\"pkg\" id=\"dotnet-sse\">"));
        assert!(dotnet.contains("<a class=\"pkg-btn\" href=\"https://molexxxx.github.io/zero-server/docs/guides/sse.html#c\">Worked example</a>"));
    }

    #[test]
    fn renders_the_domain_install_rows_and_the_reference_door() {
        let two = format!(
            "{SAMPLE}\n[[capability]]\nkey = \"polling\"\nchapter = \"real-time\"\ntitle = \"Long polling\"\nsummary = \"Long-polling responses\"\ncrates = [\"zero-polling\"]\nnode = \"polling\"\npython = \"polling\"\ndotnet = [\"Polling\"]\nguide = \"guides/polling.md\"\n"
        );
        let catalog = Catalog::parse(&two).unwrap();
        let descriptions = BTreeMap::new();

        let node = catalog.render("install node", &descriptions).unwrap();
        assert!(node.starts_with("<div class=\"domains\">\n<div class=\"domain\">\n<div class=\"pkg-head\">\n<div class=\"pkg-what\"><a class=\"pkg-title\" href=\"https://molexxxx.github.io/zero-server/docs/reference/node.html#real-time\">Real time</a><code class=\"pkg-import\">@zero-server/real-time</code></div>"), "{node}");
        assert!(
            node.contains(
                "<div class=\"pkg-get\"><code class=\"cmd\">npm install @zero-server/real-time</code>"
            ),
            "{node}"
        );
        assert!(node.contains("<div class=\"pkg-btns\"><details class=\"guide-menu\">\n<summary><span class=\"guide-menu-n\">3</span> guides<span class=\"guide-menu-caret\" aria-hidden=\"true\"></span></summary>\n<ul class=\"guide-menu-list\"><li><a href=\"https://molexxxx.github.io/zero-server/docs/guides/sse.html\">Server-sent events</a></li><li>Transports</li><li><a href=\"https://molexxxx.github.io/zero-server/docs/guides/polling.html\">Long polling</a></li></ul>\n</details><a class=\"pkg-btn api node\""), "{node}");
        assert!(node.contains("<a class=\"pkg-btn api node\" href=\"https://molexxxx.github.io/zero-server/docs/reference/node.html#real-time\">API reference</a><a class=\"pkg-btn ext\" href=\"https://www.npmjs.com/package/@zero-server/real-time\">npm</a></div></div>"), "{node}");

        let rust = catalog.render("install rust", &descriptions).unwrap();
        assert!(rust.contains(
            "<code class=\"cmd\">cargo add zero-server --no-default-features --features std,real-time</code>"
        ));
        assert!(
            rust.contains("<a class=\"pkg-title\" href=\"https://molexxxx.github.io/zero-server/docs/reference/rust.html#real-time\">Real time</a></div>"),
            "a feature has no registry page and no import of its own"
        );
        assert!(rust.contains("</details><a class=\"pkg-btn api rust\" href=\"https://molexxxx.github.io/zero-server/docs/reference/rust.html#real-time\">API reference</a></div>"), "every language opens the section that lists the domain, not the root of its whole reference");

        let dotnet = catalog.render("install dotnet", &descriptions).unwrap();
        assert!(dotnet.contains("dotnet add package ZeroServer.RealTime"));
        assert!(dotnet.contains("<a class=\"pkg-btn api dotnet\" href=\"https://molexxxx.github.io/zero-server/docs/reference/dotnet.html#real-time\">API reference</a><a class=\"pkg-btn ext\" href=\"https://www.nuget.org/packages/ZeroServer.RealTime\">NuGet</a></div></div>"), "a NuGet domain package has no namespace page of its own, so it opens the section that lists it");
        let python = catalog.render("install python", &descriptions).unwrap();
        assert!(python.contains("<code class=\"pkg-import\">zero_server.real_time</code>"));
        assert!(python.contains("<a class=\"pkg-btn api python\" href=\"https://molexxxx.github.io/zero-server/docs/reference/python.html#real-time\">API reference</a>"));

        let door = catalog
            .render("reference-link python", &descriptions)
            .unwrap();
        assert!(door.starts_with("<div class=\"door\">\n<p>Every <code>zero-server</code> module, generated by pdoc from this commit. Each row below opens a module's API pages"), "{door}");
        assert!(door.contains("<div class=\"door-actions\"><a class=\"btn btn-warm\" href=\"https://molexxxx.github.io/zero-server/docs/reference/python/zero_server.html\">Browse the full API <small>pdoc</small></a><a class=\"btn btn-ghost\" href=\"https://molexxxx.github.io/zero-server/docs/install.html\">Install</a><a class=\"btn btn-ghost\" href=\"https://molexxxx.github.io/zero-server/docs/index.html\">Guides</a></div>"), "{door}");

        let references = catalog
            .render("references absolute", &descriptions)
            .unwrap();
        assert!(references.starts_with("| Language | Install | Reference |\n| --- | --- | --- |\n| Rust | `cargo add zero-server` | [Rust reference](https://molexxxx.github.io/zero-server/docs/reference/rust.html), every crate with its API pages, generated by rustdoc |"), "{references}");
        assert!(references.contains("| C# | `dotnet add package ZeroServer` | [C# reference](https://molexxxx.github.io/zero-server/docs/reference/dotnet.html), every package with its API pages, generated by DocFX |"));
        assert!(
            !references.contains("zero_server/index.html"),
            "the generated roots are not linked"
        );
        let relative = catalog.render("references", &descriptions).unwrap();
        assert!(relative.contains("[Python reference](reference/python.md)"));
        assert!(door.contains("<a href=\"https://molexxxx.github.io/zero-server/docs/reference/rust.html\">Rust</a>\n<a href=\"https://molexxxx.github.io/zero-server/docs/reference/node.html\">TypeScript</a>\n<span aria-current=\"page\">Python</span>\n<a href=\"https://molexxxx.github.io/zero-server/docs/reference/dotnet.html\">C#</a>"));

        let engine = catalog
            .render(
                "crates engine",
                &BTreeMap::from([("zero-core".to_owned(), "The shared types".to_owned())]),
            )
            .unwrap();
        assert!(engine.contains("zero-core") && !engine.contains("zero-sse"));
    }

    #[test]
    fn finds_declared_dotnet_types() {
        let source = "public sealed class Server : IDisposable { }\npublic readonly record struct Header(string Name);\npublic enum Version { Http11 }\ninternal interface IHandle<T> { }";
        assert_eq!(
            declared_types(source),
            ["Server", "Header", "Version", "IHandle"]
        );
    }

    /// A map whose one capability lives in a crate that first ships in release 2.
    const RELEASED: &str = r#"
[[chapter]]
key = "http"
title = "HTTP"
intent = "Requests."

[[capability]]
key = "router"
chapter = "http"
title = "Routing"
summary = "Method dispatch"
crates = ["zero-router"]
node = "router"
python = "router"
dotnet = ["Router"]

[engine]
crates = ["zero-core"]

[[crate]]
name = "zero-core"
release = 1

[[crate]]
name = "zero-router"
release = 2
"#;

    /// The crates of [`RELEASED`].
    fn released_crates() -> Vec<String> {
        vec!["zero-core".to_owned(), "zero-router".to_owned()]
    }

    /// A repository with nothing in it but the three binding package roots and the
    /// guides directory, under the system temp directory in a directory of its own.
    fn empty_tree(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(name);
        fs::remove_dir_all(&root).ok();
        for dir in [
            "bindings/node/packages",
            "bindings/python/packages",
            "bindings/dotnet/src",
            "docs/guides",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        root
    }

    #[test]
    fn docs_check_an_entry_for_a_later_release_than_the_current_one_is_pending_and_does_not_fail() {
        let root = empty_tree("zero-catalog-later-release");
        let mut catalog = Catalog::parse(RELEASED).unwrap();
        catalog.current_release = 1;
        let checked = catalog.check(&root, &released_crates(), true);
        let pending = catalog.pending();
        fs::remove_dir_all(&root).ok();

        checked.unwrap();
        let whats: Vec<&str> = pending.iter().map(|entry| entry.what.as_str()).collect();
        assert_eq!(
            whats,
            [
                "@zero-server/router (router)",
                "C# types Router (router)",
                "ZeroServer.Router (router)",
                "the Routing guide (router)",
                "zero-server-router (router)",
            ]
        );
        assert!(pending.iter().all(|entry| entry.release == 2));
    }

    #[test]
    fn docs_check_an_entry_at_or_below_the_current_release_still_fails() {
        let root = empty_tree("zero-catalog-current-release");
        let mut catalog = Catalog::parse(RELEASED).unwrap();
        catalog.current_release = 2;
        let checked = catalog.check(&root, &released_crates(), true);
        let pending = catalog.pending();
        fs::remove_dir_all(&root).ok();

        let err = checked.unwrap_err();
        for expected in [
            "capability router ships in release 2 and has no guide",
            "node package router (router) ships in release 2 and has no directory under bindings/node/packages",
            "python package router (router) ships in release 2 and has no directory under bindings/python/packages",
            "dotnet package ZeroServer.Router (router) ships in release 2 and has no directory under bindings/dotnet/src",
            "capability router: Router is not a type declared under bindings/dotnet/src",
        ] {
            assert!(err.contains(expected), "{expected} missing from {err}");
        }
        assert!(pending.is_empty());
    }

    #[test]
    fn docs_check_a_binding_package_ships_no_earlier_than_the_release_packages_names_for_it() {
        let root = empty_tree("zero-catalog-package-release");
        fs::write(root.join("docs/guides/router.md"), "# Routing\n").unwrap();
        let text = RELEASED
            .replace(
                "dotnet = [\"Router\"]\n",
                "dotnet = [\"Router\"]\nguide = \"guides/router.md\"\n",
            )
            .replace(
                "name = \"zero-router\"\nrelease = 2",
                "name = \"zero-router\"\nrelease = 1",
            )
            + "\n[packages]\nnode = 2\n";
        let mut catalog = Catalog::parse(&text).unwrap();
        catalog.current_release = 1;
        let checked = catalog.check(&root, &released_crates(), true);
        let pending = catalog.pending();
        fs::remove_dir_all(&root).ok();

        let err = checked.unwrap_err();
        assert!(!err.contains("node package"), "{err}");
        assert!(!err.contains("guide"), "{err}");
        assert!(err.contains("python package router (router) ships in release 1"));
        assert!(err.contains("dotnet package ZeroServer.Router (router) ships in release 1"));
        assert_eq!(
            pending,
            [Pending {
                release: 2,
                what: "@zero-server/router (router)".to_owned(),
            }]
        );
        assert!(!catalog.packages_ship("node"));
        assert!(catalog.packages_ship("python"));
    }

    #[test]
    fn docs_check_every_crate_names_the_release_that_first_ships_it() {
        let root = empty_tree("zero-catalog-crate-release");
        let mut catalog = Catalog::parse(RELEASED).unwrap();
        catalog.current_release = 1;
        let mut crates = released_crates();
        crates.push("zero-extra".to_owned());
        let checked = catalog.check(&root, &crates, true);
        fs::remove_dir_all(&root).ok();
        let err = checked.unwrap_err();
        assert!(
            err.contains("crate zero-extra has no [[crate]] row, so no release says when it ships"),
            "{err}"
        );

        let unknown = RELEASED.replace("release = 2", "release = 4");
        let err = Catalog::parse(&unknown).err().unwrap();
        assert!(
            err.contains("crate zero-router: `release` must be one of"),
            "{err}"
        );
        let binding = format!("{RELEASED}\n[packages]\nruby = 2\n");
        let err = Catalog::parse(&binding).err().unwrap();
        assert!(err.contains("[packages] names ruby"), "{err}");
    }

    #[test]
    fn a_map_parsed_from_its_text_alone_is_read_as_of_the_last_release() {
        let catalog = Catalog::parse(RELEASED).unwrap();
        assert_eq!(catalog.current_release, *RELEASES.end());
        assert!(catalog.pending().is_empty());
    }

    #[test]
    fn the_bundle_turns_on_each_shipped_crate_by_its_own_feature_and_each_chapter_by_one() {
        let text = format!(
            "{SAMPLE}\n[[capability]]\nkey = \"polling\"\nchapter = \"real-time\"\ntitle = \"Long polling\"\nsummary = \"Long-polling responses\"\ncrates = [\"zero-server-polling\"]\nnode = \"polling\"\npython = \"polling\"\ndotnet = [\"Polling\"]\n"
        );
        let catalog = Catalog::parse(&text).unwrap();
        let shipped: Vec<&Capability> = catalog.capabilities.iter().collect();
        let manifest = "[features]\ndefault = [\"sse\", \"polling\"]\nsse = [\"dep:zero-sse\"]\npolling = [\"dep:zero-server-polling\"]\nreal-time = [\"sse\", \"polling\"]\n";
        let source = "#[cfg(feature = \"sse\")]\npub use zero_sse as sse;\n#[cfg(feature = \"polling\")]\npub use zero_server_polling as polling;\n";
        assert_eq!(
            bundle_problems(manifest, source, "zero-server", &catalog.chapters, &shipped),
            Vec::<String>::new()
        );

        let partial = manifest.replace(
            "real-time = [\"sse\", \"polling\"]",
            "real-time = [\"sse\"]",
        );
        assert_eq!(
            bundle_problems(&partial, source, "zero-server", &catalog.chapters, &shipped),
            ["crates/zero-server/Cargo.toml: feature `real-time` does not turn on zero-server-polling of the real-time chapter"]
        );

        let chapterless = manifest.replace("real-time = [\"sse\", \"polling\"]\n", "");
        let off_default =
            chapterless.replace("default = [\"sse\", \"polling\"]", "default = [\"sse\"]");
        let unexported = source.replace("pub use zero_server_polling as polling;\n", "");
        assert_eq!(
            bundle_problems(&off_default, &unexported, "zero-server", &catalog.chapters, &shipped),
            [
                "crates/zero-server/Cargo.toml: `polling` is not in the default feature set",
                "crates/zero-server/src/lib.rs does not re-export zero-server-polling, so feature `polling` builds a crate no one can reach",
                "crates/zero-server/Cargo.toml has no `real-time` feature for the chapter of the same name",
            ]
        );

        // A chapter left with one shipped capability needs no feature of its own.
        let one: Vec<&Capability> = shipped
            .iter()
            .copied()
            .filter(|capability| capability.key != "polling")
            .collect();
        assert_eq!(
            bundle_problems(&chapterless, source, "zero-server", &catalog.chapters, &one),
            Vec::<String>::new()
        );
    }
}
