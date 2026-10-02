# Registry pre-release handling for 2.0.0-alpha.1

Every source below was fetched on 2026-10-01. Quotes marked "source" were read from the raw file at the named tag or branch; quotes marked "page" come from the rendered documentation page. The release decision being checked: one version, `2.0.0-alpha.1`, on crates.io, PyPI, NuGet and npm, with npm pre-releases under the dist-tag `next` so `latest` stays on `@zero-server/sdk` 1.1.0 until `2.0.0`.

## Registry and tool state today

| What | Value on 2026-10-01 | Fetched from |
| --- | --- | --- |
| `@zero-server/sdk` on npm | dist-tags `{"latest":"1.1.0"}`, versions 0.9.0 to 1.1.0 | https://registry.npmjs.org/@zero-server%2Fsdk |
| `@zero-server/core` on npm | dist-tags `{"latest":"1.1.0"}`, versions 0.9.0 to 1.1.0 | https://registry.npmjs.org/@zero-server%2Fcore |
| `@zero-server/native` on npm | 404, does not exist | https://registry.npmjs.org/@zero-server%2Fnative |
| `zero-server`, `zero-core`, `zero-ffi` on crates.io | 404, do not exist | https://crates.io/api/v1/crates/zero-server (and the other two) |
| `zero-server`, `zero-server-native`, `zero-server-core` on PyPI | 404, do not exist | https://pypi.org/pypi/zero-server/json (and the other two) |
| `ZeroServer`, `ZeroServer.Core`, `ZeroServer.Native` on NuGet | 404, do not exist | https://api.nuget.org/v3-flatcontainer/zeroserver/index.json (and the other two) |
| GitHub `molexxxx/zero-server` | 0 releases, 0 tags | https://api.github.com/repos/molexxxx/zero-server/releases, `/tags` |
| Rust stable | 1.99.0, published 2026-10-01 | https://api.github.com/repos/rust-lang/rust/releases/latest |
| npm | registry `latest` 12.2.0; Node 24.21.0 (2026-09-07) bundles npm 11.19.0 | https://registry.npmjs.org/npm, https://nodejs.org/dist/index.json |
| `@napi-rs/cli` | registry `latest` 3.10.6; `bindings/node/package-lock.json` locks 3.10.5 | https://registry.npmjs.org/@napi-rs%2Fcli |
| pip / packaging / maturin / hatchling / twine | 26.2.1 / 26.3 / 1.15.0 / 1.32.4 / 7.0.0 | https://pypi.org/pypi/<name>/json |
| gh | v2.102.0, published 2026-09-30 | https://api.github.com/repos/cli/cli/releases/latest |

So npm is the only registry with prior versions under these names. Every other registry would see `2.0.0-alpha.1` as the first and only version of each package, which matters for the "only a pre-release exists" fallbacks below.

## What the repository touches

| Registry | Workflow | Version source | Publish command |
| --- | --- | --- | --- |
| crates.io | `.github/workflows/release-crates.yml` | `[workspace.package] version` in `Cargo.toml`, internal deps pinned with `version = "<v>"` by `crates/xtask/src/version.rs` | `cargo xtask release`, which runs `cargo publish -p <crate>` per crate (`crates/xtask/src/release.rs`) |
| PyPI | `.github/workflows/release-python.yml`, `pypi-backfill.yml` | static `[project] version` in each `bindings/python/packages/*/pyproject.toml`; own deps pinned `name==<v>` by xtask | maturin-action (native wheels and sdist), `python -m build` (hatchling, pure packages), then `.github/scripts/pypi-upload.sh dist "${VERSION#v}"` |
| NuGet | `.github/workflows/release-nuget.yml` | `<Version>` in `bindings/dotnet/Directory.Build.props` | `dotnet pack bindings/dotnet/ZeroServer.sln -c Release -o dist`, `dotnet nuget push --skip-duplicate` |
| npm | `.github/workflows/release-node.yml` | `"version"` in every `bindings/node` manifest, own deps pinned exactly by xtask | `npx napi pre-publish -t npm ...` then `npm publish --workspaces --access public` |
| GitHub | `.github/workflows/release-github.yml` | the tag | `gh release create "$TAG" --verify-tag --title ... --notes-file notes.md` |

All five trigger on `v*` tags and call `release-preflight.yml`, which runs `cargo run -p xtask -- version --check "${VERSION#v}"`. `xtask version` accepts a pre-release: `validate` splits on the first `-` and checks only the numeric core, and its test asserts `validate("1.0.0-rc.1").is_ok()`. The check does not: `versions_in` (version.rs lines 382 to 404) collects runs of digits and dots from the prose sites `README.md` and `docs/about/releasing.md`, so `2.0.0-alpha.1` in prose reads back as `2.0.0` and is reported as disagreeing with the workspace version `2.0.0-alpha.1`. That fails `version --check`, the preflight that gates every release workflow, and the `the_checked_out_tree_is_consistent` test. This is from reading the code; it was not run, because a bump rewrites files other agents are editing.

## Cargo and crates.io

### SemVer pre-release syntax and precedence

SemVer 2.0.0, item 9 (page, https://semver.org/spec/v2.0.0.html): "A pre-release version MAY be denoted by appending a hyphen and a series of dot separated identifiers immediately following the patch version." Item 11 gives the precedence chain: "1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0".

Cargo manifest, "The version field" (page, https://doc.rust-lang.org/cargo/reference/manifest.html#the-version-field):

> A pre-release part can be added after a dash such as `1.0.0-alpha`. The pre-release part may be separated with periods to distinguish separate components. Numeric components will use numeric comparison while everything else will be compared lexicographically. For example, `1.0.0-alpha.11` is higher than `1.0.0-alpha.4`.

So `2.0.0-alpha.1 < 2.0.0-alpha.2 < 2.0.0-beta.1 < 2.0.0`, and `2.0.0-alpha.10` sorts after `2.0.0-alpha.9`.

### Does a requirement select a pre-release without being asked

Cargo Book, "Pre-releases" (page, https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#pre-releases), in full:

> Version requirements exclude pre-release versions, such as `1.0.0-alpha`, unless specifically asked for. For example, if `1.0.0-alpha` of package `foo` is published, then a requirement of `foo = "1.0"` will *not* match, and will return an error. The pre-release must be specified, such as `foo = "1.0.0-alpha"`. Similarly `cargo install` will avoid pre-releases unless explicitly asked to install one.
>
> Cargo allows "newer" pre-releases to be used automatically. For example, if `1.0.0-beta` is published, then a requirement `foo = "1.0.0-alpha"` will allow updating to the `beta` version. Note that this only works on the same release version, `foo = "1.0.0-alpha"` will not allow updating to `foo = "1.0.1-alpha"` or `foo = "1.0.1-beta"`.
>
> Cargo will also upgrade automatically to semver-compatible released versions from prereleases. The requirement `foo = "1.0.0-alpha"` will allow updating to `foo = "1.0.0"` as well as `foo = "1.2.0"`.
>
> Beware that pre-release versions can be unstable, and as such care should be taken when using them. Some projects may choose to publish breaking changes between pre-release versions. It is recommended to not use pre-release dependencies in a library if your library is not also a pre-release. Care should also be taken when updating your `Cargo.lock`, and be prepared if a pre-release update causes issues.

The SemVer compatibility chapter (page, https://doc.rust-lang.org/cargo/reference/semver.html) has no pre-release text; its only versioning rule is "Initial development releases starting with "0.y.z" can treat changes in "y" as a major release, and "z" as a minor release." The resolver chapter (page, https://doc.rust-lang.org/cargo/reference/resolver.html) has no pre-release text either.

A caret requirement therefore never selects a pre-release unless the requirement itself names one. A requirement that names one (`"2.0.0-alpha.1"`, which is `^2.0.0-alpha.1`) does float: to later pre-releases of 2.0.0 (beta, rc), to 2.0.0, and to any later 2.x.

### What `cargo add` does

The Cargo Book page for `cargo add` (https://doc.rust-lang.org/cargo/commands/cargo-add.html) only says "If no source is specified, then a best effort will be made to select one, including: ... Latest release in the registry" and says nothing about pre-releases. The behavior is in the source, `src/ops/cargo_add/mod.rs` at branch `rust-1.99.0` (https://raw.githubusercontent.com/rust-lang/cargo/rust-1.99.0/src/ops/cargo_add/mod.rs), lines 896 to 901:

```rust
possibilities.sort_by_key(|s| {
    // Fallback to a pre-release if no official release is available by sorting them as
    // less.
    let stable = s.version().pre.is_empty();
    (stable, s.version().clone())
});
```

The test `tests/testsuite/cargo_add/infer_prerelease` at the same branch publishes only `prerelease_only 0.2.0-alpha.1`, runs `cargo add prerelease_only`, and expects `prerelease_only = "0.2.0-alpha.1"` in the manifest. So while `zero-server` has no stable release, `cargo add zero-server` writes `zero-server = "2.0.0-alpha.1"`; once 2.0.0 exists it writes the stable version.

### What crates.io shows as the crate's version

`crates/crates_io_database/src/models/default_versions.rs` on crates.io `main` (commit 92ec0bded3bdc5ab6a266a7108ab2e72ef324e96, https://github.com/rust-lang/crates.io/blob/main/crates/crates_io_database/src/models/default_versions.rs), source:

> 1. The highest non-prerelease version that is not yanked.
> 2. The highest non-yanked version.
> 3. The highest version.

With only `2.0.0-alpha.1` published, rule 2 makes it the default version on crates.io and docs.rs.

### Publishing and yanking

Publishing (page, https://doc.rust-lang.org/cargo/reference/publishing.html): "Take care when publishing a crate, because a publish is generally permanent. The version can never be overwritten, and the code cannot be deleted." The page has no pre-release-specific rule; a pre-release publishes like any other version.

Yanking, same page, `cargo yank` section: "The semantics of a yanked version are that no new dependencies can be created against that version, but all existing dependencies continue to work. ... Essentially a yank means that all packages with a `Cargo.lock` will not break, while any future `Cargo.lock` files generated will not list the yanked version." `cargo yank` (page, https://doc.rust-lang.org/cargo/commands/cargo-yank.html): "Cargo will not use a yanked version for any new project or checkout without a pre-existing lockfile, and will generate an error if there are no longer any compatible versions for your crate." Resolver (page): "When the resolver is building the graph, it will ignore all yanked releases unless they already exist in the `Cargo.lock` file or are explicitly requested by the `--precise` flag of `cargo update`." Nothing in these pages treats a yanked pre-release differently.

### Repository implications

- `cargo xtask version 2.0.0-alpha.1` rewrites `[workspace.dependencies]` entries such as `zero-core = { path = "crates/zero-core", version = "0.1.0" }` (root `Cargo.toml` line 70) to `version = "2.0.0-alpha.1"`, a caret requirement. Per the quoted rule, a consumer holding `zero-server 2.0.0-alpha.1` in a lockfile who runs `cargo update -p zero-core` after `2.0.0-beta.1` ships can get `zero-core 2.0.0-beta.1` under `zero-server 2.0.0-alpha.1`. If the internal APIs change between pre-releases, an exact requirement (`=2.0.0-alpha.1`) is the Cargo form that prevents mixing; that is a design choice, not something any source requires.
- `release.rs` treats "already uploaded" or "already exists" as success and is unaffected by the version shape.

## PyPI

### PEP 440 spelling and normalization

Version specifiers specification, source `source/specifications/version-specifiers.rst` on `pypa/packaging.python.org` `main` (commit ded85415b762845a4a401bb0af741f35948036a6), rendered at https://packaging.python.org/en/latest/specifications/version-specifiers/:

- Public version identifiers: "The canonical public version identifiers MUST comply with the following scheme:: `[N!]N(.N)*[{a|b|rc}N][.postN][.devN]`" and "Installation tools SHOULD ignore any public versions which do not comply with this scheme but MUST also include the normalizations specified below."
- Pre-release separators (#pre-release-separators): "Pre-releases should allow a `.`, `-`, or `_` separator between the release segment and the pre-release segment. The normal form for this is without a separator. ... It should also allow a separator to be used between the pre-release signifier and the numeral. This allows versions such as `1.0a.1` which would be normalized to `1.0a1`."
- Pre-release spelling (#pre-release-spelling): "Pre-releases allow the additional spellings of `alpha`, `beta`, `c`, `pre`, and `preview` for `a`, `b`, `rc`, `rc`, and `rc` respectively. ... In every case the additional spelling should be considered equivalent to their normal forms."

Applied to `2.0.0-alpha.1`: the `-` separator is dropped, `alpha` becomes `a`, the `.` before the numeral is dropped. The canonical PyPI spelling is `2.0.0a1`; `2.0.0-beta.N` is `2.0.0bN`; `2.0.0-rc.N` is `2.0.0rcN`. Checked locally with packaging 26.3 (`Version('2.0.0-alpha.1')` prints `2.0.0a1`, `is_prerelease` True) and with packaging 26.2, the copy pip 26.2.1 vendors (`src/pip/_vendor/vendor.txt` at tag 26.2.1: `packaging==26.2`).

pyproject.toml specification (source `pyproject-toml.rst`, same commit), on `version`: "Users SHOULD prefer to specify already-normalized versions."

File names: binary distribution format, "Escaping and Unicode" (source `binary-distribution-format.rst`): "Version numbers should be normalised according to the Version specifier specification. Normalised version numbers cannot contain `-`." Source distribution format (source `source-distribution-format.rst`): "the file name must be in the form `{name}-{version}.tar.gz`, where ... `{version}` is the canonicalized form of the project version". Wheels and sdists of this release therefore carry `2.0.0a1`, never `2.0.0-alpha.1`, in their file names.

### Does pip install a pre-release without `--pre`

Specification, "Handling of pre-releases" (#handling-of-pre-releases):

> Pre-releases of any kind, including developmental releases, are implicitly excluded from all version specifiers, *unless* they are already present on the system, explicitly requested by the user, or if the only available version that satisfies the version specifier is a pre-release.
>
> By default, dependency resolution tools SHOULD:
>
> * accept already installed pre-releases for all version specifiers
> * accept remotely available pre-releases for version specifiers where there is no final or post release that satisfies the version specifier
> * exclude all other pre-releases from consideration

pip documentation, v26.2.1 (page, https://pip.pypa.io/en/stable/cli/pip_install/#pre-release-versions): "Starting with v1.4, pip will only install stable versions as specified by pre-releases by default. If a version cannot be parsed as a compliant version then it is assumed to be a pre-release. If a Requirement specifier includes a pre-release or development version (e.g. `>=0.0.dev0`) then pip will allow pre-release and development versions for that requirement." `--pre`: "Include pre-release and development versions. By default, pip only finds stable versions."

The page wording does not mention the "only a pre-release exists" fallback, so the source was read. pip 26.2.1, `src/pip/_internal/index/package_finder.py` lines 477 to 514 (https://github.com/pypa/pip/blob/26.2.1/src/pip/_internal/index/package_finder.py): with no `--pre`, `--all-releases` or `--only-final`, `allow_prereleases` is `None` (`ReleaseControl.allows_prereleases` returns "None: No specific setting, use default behavior", `src/pip/_internal/models/release_control.py`), and candidates go through `specifier.filter(candidates, prereleases=allow_prereleases, ...)`. packaging documents that default (page, https://packaging.pypa.io/en/stable/specifiers.html): "If set to `None` (the default), it will follow the recommendation from PEP 440 and match prereleases if there are no other versions." Run locally against packaging 26.2: `SpecifierSet('').filter(['2.0.0a1'])` returns `['2.0.0a1']`, `SpecifierSet('').filter(['1.1.0','2.0.0a1'])` returns `['1.1.0']`.

Result: while `2.0.0a1` is the only release of `zero-server` on PyPI, `pip install zero-server` installs it without `--pre`. Once any final release exists, pre-releases are skipped unless the user passes `--pre` (or `--all-releases`) or names one (`zero-server==2.0.0a1`, or the SemVer spelling `zero-server==2.0.0-alpha.1`, which packaging parses to the same specifier). pip 26.2.1 also has `--all-releases` and `--only-final` (help text in `src/pip/_internal/cli/cmdoptions.py`: "Allow all release types (including pre-releases) for a package." / "Only allow final releases (no pre-releases) for a package."), neither usable with `--pre`.

### maturin (native package)

maturin 1.15.0 guide, `guide/src/metadata.md` at tag v1.15.0 (https://github.com/PyO3/maturin/blob/v1.15.0/guide/src/metadata.md), source: dynamic `version` comes "From `package.version` in Cargo.toml (converted from SemVer to PEP 440 format)", and "Per specification, maturin is not allowed to populate fields that are not present in `project.dynamic` list when the `[project]` section is present. For example, to use the Rust crate version as the Python package version, you need to add `version` to the `project.dynamic` list." The rendered page (https://www.maturin.rs/metadata.html) adds: "`pyproject.toml` takes precedence over `Cargo.toml`."

Source, `src/metadata.rs` at v1.15.0: `merge_version` copies `project.version` from pyproject when present (lines 293 to 309); the Cargo path parses with `pep440_rs::Version::from_str(&package.version.to_string())` and on failure says "Note that rust uses SemVer while python uses PEP 440, which have e.g. some differences when declaring prereleases." (lines 653 to 661). maturin's `Cargo.lock` at v1.15.0 pins `pep440_rs 0.7.3`. In pep440_rs 0.7.3 (`src/version.rs`, `parse_pre`, read from the crates.io archive), the parser takes an optional separator, then one of `["alpha", "beta", "preview", "pre", "rc", "a", "b", "c"]`, then another optional separator, then the number; its tests assert `("1.0-alpha1", "1.0a1")`, and docs.rs (https://docs.rs/pep440_rs/0.7.3/pep440_rs/struct.Version.html) says Display "Shows normalized version". So `2.0.0-alpha.1` is accepted from either `Cargo.toml` or a static `project.version` and written as `2.0.0a1`.

`bindings/python/packages/native/pyproject.toml` declares a static `version = "0.1.0"` and no `dynamic`, so maturin takes the version from pyproject; `bindings/python/packages/native/Cargo.toml` (`zero-server-python`, `publish = false`) is bumped by xtask too but is not the source of the wheel version.

### hatchling (pure packages)

hatchling 1.32.4, `backend/src/hatchling/metadata/core.py` at tag hatchling-v1.32.4 (https://github.com/pypa/hatch/blob/hatchling-v1.32.4/backend/src/hatchling/metadata/core.py), lines 270 to 279, source:

```python
from packaging.version import InvalidVersion, Version

try:
    normalized_version = str(Version(version))
except InvalidVersion:
    message = f"Invalid version `{version}` from {source}, see https://peps.python.org/pep-0440/"
    raise ValueError(message) from None
else:
    self._original_version = version.strip()
    return normalized_version
```

A static `project.version = "2.0.0-alpha.1"` is accepted and emitted as `2.0.0a1`.

### PyPI JSON API

The JSON API docs (page, https://docs.pypi.org/api/json/) do not say whether version path segments are normalized. Tested against a real project: `https://pypi.org/pypi/Django/5.0a1/json`, `.../5.0-alpha.1/json` and `.../5.0.0a1/json` all return `info.version` `5.0a1`.

### Repository implications

- xtask writes the SemVer string into every `project.version` and into own pins (`zero-server-native==2.0.0-alpha.1`). Both parse (checked: `Requirement('zero-server-native==2.0.0-alpha.1').specifier.contains('2.0.0a1')` is True), but the pyproject spec says users SHOULD prefer normalized versions, and `xtask version --check` compares strings exactly, so writing `2.0.0a1` into pyproject files would fail the check unless xtask maps the spelling.
- `.github/scripts/pypi-upload.sh` derives the project from the file name with `file="${file%%-${version}*}"` and counts with `sed "s/-${version}.*//"`. `release-python.yml` passes `${VERSION#v}`, which is `2.0.0-alpha.1`, while every file name carries `2.0.0a1`, so the strip does not match: project names come out wrong, the "exists" ordering and the cap handling key on the wrong names, and the final `https://pypi.org/pypi/$project/$version/json` check reports every project missing. The URL itself tolerates the SemVer spelling (Django test above); the project name is what breaks. `pypi-backfill.yml` passes the same tag-derived version.

## NuGet

### SemVer 2.0.0 and pre-release support

NuGet Package Version Reference (page, https://learn.microsoft.com/en-us/nuget/concepts/package-versioning, updated 2025-07-29):

- "The following document follows the Semantic Versioning 2.0.0 standard, supported by NuGet 4.3.0+ and Visual Studio 2017 version 15.3+."
- Pre-release versions: "Technically speaking, package creators can use any string as a suffix to denote a pre-release version, as NuGet treats any such version as pre-release and makes no other interpretation." "Prerelease numbers with dot notation, as in *1.0.1-build.23*, are considered part of the SemVer 2.0.0 standard, and as such are only supported with NuGet 4.3.0+." Its SemVer 2.0 sort example notes "1.0.1-rc.10 is greater precedence than 1.0.1-rc.2."
- Semantic Versioning 2.0.0: "NuGet considers a package version to be SemVer v2.0.0 specific if either of the following statements is true: The pre-release label is dot-separated, for example, *1.0.0-alpha.1*; The version has build-metadata". "If you upload a SemVer v2.0.0-specific package to nuget.org, the package is invisible to older clients and available to only the following NuGet clients: NuGet 4.3.0+, Visual Studio 2017 version 15.3+, Visual Studio 2015 with NuGet VSIX v3.6.0, .NET SDK 2.0.0+", plus JetBrains Rider and Paket 5.0+.

`2.0.0-alpha.1` is SemVer 2.0.0-specific by that definition; every client that can consume a `net8.0` package is on the supported list.

### Is it shown or installed by default

Pre-release versions in NuGet packages (page, https://learn.microsoft.com/en-us/nuget/create-packages/prerelease-packages, updated 2025-10-31): "By default, NuGet does not include pre-release versions when working with packages, but you can change this behavior as follows:" Visual Studio's **Include prerelease** box, `-IncludePrerelease` in the Package Manager Console, `-prerelease` in the NuGet CLI.

`dotnet package add` (page, https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-package-add, updated 2025-12-17): `--prerelease` "Allows prerelease packages to be installed." and "If you're using .NET 9 SDK or earlier, use the "verb first" form (`dotnet add package`) instead. The "noun first" form was introduced in .NET 10." What happens without `--prerelease` when only a pre-release exists is in the source, `NuGet.Client` tag v10.0.201, `src/NuGet.Core/NuGet.CommandLine.XPlat/Commands/PackageReferenceCommands/AddPackageReferenceCommandRunner.cs` lines 152 to 164: it looks for a stable version, then for a pre-release, and if only the pre-release exists it throws `Strings.PrereleaseVersionsAvailable`, which `Strings.resx` defines as "There are no stable versions available, {0} is the best available. Consider adding the --prerelease option". So `dotnet package add ZeroServer` fails until 2.0.0 exists; `--prerelease` or `--version 2.0.0-alpha.1` works.

Search API (page, https://learn.microsoft.com/en-us/nuget/api/search-query-service-resource, updated 2026-08-11): "If `prerelease` is not provided, pre-release packages are excluded." and "If this query parameter [`semVerLevel`] is excluded, only packages with SemVer 1.0.0 compatible versions will be returned".

Dependency resolution (page, https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution, updated 2026-02-02): "If the project or any packages within the graph request a prerelease version of a package, then include both prerelease or stable versions, otherwise consider stable versions only." NU1103 (page, https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1103): "The project specified a stable version for the dependency range, but no stable versions were found in that range. Pre-release versions were found but are not allowed."

### `dotnet pack` version properties

NuGet pack target (page, https://learn.microsoft.com/en-us/nuget/reference/msbuild-targets, updated 2026-07-20): `PackageVersion` "This is semver compatible, for example `1.0.0`, `1.0.0-beta`, or `1.0.0-beta-00345`. Defaults to `Version` if not set." and "Specifies the version that the resulting package will have. Accepts all forms of NuGet version string. Default is the value of `$(Version)`". `VersionPrefix` / `VersionSuffix`: "Setting `PackageVersion` overwrites" each.

`dotnet pack` (page, https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-pack, updated 2026-06-11), `--version-suffix`: "If you want to use `--version-suffix`, specify `VersionPrefix` and not `Version` in the project file. ... If `Version` has a value and you pass `--version-suffix` to `dotnet pack`, the value specified for `--version-suffix` is ignored." Also: "NuGet dependencies of the packed project are added to the *.nuspec* file ... If the packed project has references to other projects, the other projects aren't included in the package."

Assembly versions: .NET SDK `Microsoft.NET.GenerateAssemblyInfo.targets` on branch `release/8.0.4xx` (https://github.com/dotnet/sdk/blob/release/8.0.4xx/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), source, `GetAssemblyVersion`: "Parses the nuget package version set in $(Version) and returns the implied $(AssemblyVersion) and $(FileVersion). e.g.: `<Version>1.2.3-beta.4</Version>` implies: `<AssemblyVersion>1.2.3</AssemblyVersion>` `<FileVersion>1.2.3</FileVersion>`", and line 232 sets `InformationalVersion` to `$(Version)` (with `+$(SourceRevisionId)` appended when `IncludeSourceRevisionInInformationalVersion` is true and source control info is available). The same lines are on `main`.

### Repository implications

- `<Version>2.0.0-alpha.1</Version>` in `Directory.Build.props` is enough: it becomes the package version of all three packages, `AssemblyVersion` and `FileVersion` become `2.0.0`, and `InformationalVersion` keeps the suffix. No workflow change is needed for NuGet beyond the version itself; `--skip-duplicate` is unaffected.
- Consumers need `--prerelease` (or an explicit version) to add the package until 2.0.0 ships.

## npm

### dist-tags and the default tag

`npm dist-tag`, npm v11 docs (page, https://docs.npmjs.com/cli/v11/commands/npm-dist-tag, labeled 11.21.0): "npm install <pkg> (without any @<version> or @<tag> specifier) installs the `latest` tag." "Publishing a package sets the `latest` tag to the published version unless the `--tag` option is used." "Tags that can be interpreted as valid semver ranges will be rejected." (`next` is not a range.)

`npm publish`, `tag` config (page, https://docs.npmjs.com/cli/v11/commands/npm-publish): "Default: "latest" ... If used in the `npm publish` command, this is the tag that will be added to the package submitted to the registry."

`package.json` `publishConfig` (page, https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig): "This is a set of config values that will be used at publish-time. It's especially handy if you want to set the tag, registry or access, so that you can ensure that a given package is not tagged with 'latest' ..."

Config from the environment (page, https://docs.npmjs.com/cli/v11/using-npm/config#environment-variables): "Any environment variables that start with `npm_config_` will be interpreted as a configuration parameter." Config is also read from a per-project `.npmrc`.

### npm 11 refuses a pre-release on the default tag

npm CHANGELOG at v11.19.0 (https://github.com/npm/cli/blob/v11.19.0/CHANGELOG.md), source:

- 11.0.0-pre.0: "When publishing a package with a pre-release version, you must explicitly specify a tag." (#7910 "publishing prerelease requires explicit tag")
- 11.0.0-pre.1: "Upon publishing, in order to apply a default "latest" dist tag, the command now retrieves all prior versions of the package. It will require that the version you're trying to publish is above the latest semver version in the registry, not including pre-release tags." (#7939 "no implicit latest tag on publish when latest > version")

`lib/commands/publish.js` at v11.19.0 (the npm that Node 24.21.0 bundles), source, lines 126 to 133 and 170 to 181:

```js
const isDefaultTag = this.npm.config.isDefault('tag') && !manifest.publishConfig?.tag

if (!force) {
  const isPreRelease = Boolean(semver.parse(manifest.version).prerelease.length)
  if (isPreRelease && isDefaultTag) {
    throw new Error('You must specify a tag using --tag when publishing a prerelease version.')
  }
}
...
if (highestVersionIsGreater && isDefaultTag) {
  throw new Error(`Cannot implicitly apply the "latest" tag because previously published version ${highestVersion} is higher than the new version ${manifest.version}. You must specify a tag using --tag.`)
}
```

`highestVersion` skips pre-release and deprecated versions (lines 259 to 268). So today `npm publish` of `2.0.0-alpha.1` with no tag fails outright rather than moving `latest`; any of `--tag next`, `npm_config_tag=next`, a `.npmrc` `tag=next`, or `publishConfig.tag` satisfies it. When `2.0.0` is published with no tag, the highest non-pre-release is `1.1.0`, lower than `2.0.0`, so `latest` moves to `2.0.0` with no extra flag. `next` keeps pointing at the last pre-release until it is moved or removed with `npm dist-tag`.

### `--workspaces` with `--tag`

Workspaces (page, https://docs.npmjs.com/cli/v11/using-npm/workspaces): the `workspaces` option runs the command "in the context of **all** configured workspaces", and "Commands will be run in each workspace in the order they appear in your `package.json`."

`publish.js` at v11.19.0, `execWorkspaces` (lines 54 to 72), source: it loops over the workspaces calling the same `#publish`, which reads the single `this.npm.config.get('tag')`, so one `--tag next` applies to every workspace package. Only `EPRIVATE` errors are caught and logged as "Skipping workspace ..., marked as private"; any other error ends the loop. The pre-release tag check (line 131) runs before the private check (line 153), so with no tag a private workspace also fails with the tag error instead of being skipped.

### `napi pre-publish` and the tag

`@napi-rs/cli` 3.10.5 (the locked version), `cli/src/api/pre-publish.ts` at tag `@napi-rs/cli@3.10.5`, source: each platform package is published with `execSync(`${npmClient} publish`, { cwd: publicationPackageDir, env: process.env, stdio: 'pipe' })` (line 654), with no `--tag`. Its "You cannot publish over the previously published versions" error is caught and skipped; others are rethrown. `cli/src/def/pre-publish.ts`: `-t` is `--tag-style,--tagstyle,-t` "git tag style, `npm` or `lerna`", not the dist-tag; `--gh-release` defaults to true and, when `GITHUB_REPOSITORY` is set, creates a GitHub release with `prerelease: version.includes('alpha') || version.includes('beta') || version.includes('rc')` and uploads assets using `process.env.GITHUB_TOKEN`, logging rather than throwing on failure. The publication context it builds copies `.npmrc` among `PUBLICATION_CONTEXT_FILES`.

### Trusted publishing

Trusted publishers (page, https://docs.npmjs.com/trusted-publishers, "Last Updated: September 30, 2026"): "Trusted publishing requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher." A trusted publisher's "Allowed actions (optional): `npm stage publish` is always allowed. Choose whether this trusted publisher can also publish directly with `npm publish` or manage dist-tags with `npm dist-tag`." "To allow a workflow to manage your package's distribution tags, select **Allow npm dist-tag** for its trusted publisher configuration in your package settings." "Dist-tag access is independent of direct publishing." "When you publish using trusted publishing from GitHub Actions or GitLab CI/CD, npm automatically generates and publishes provenance attestations for your package." The page puts no restriction on which tag `npm publish --tag` may set; the separate permission covers only the `npm dist-tag` command.

### Range matching for consumers

node-semver v7.8.5 README, "Prerelease Tags" (https://github.com/npm/node-semver/blob/v7.8.5/README.md#prerelease-tags), source: "If a version has a prerelease tag (for example, `1.2.3-alpha.3`) then it will only be allowed to satisfy comparator sets if at least one comparator with the same `[major, minor, patch]` tuple also has a prerelease tag." Existing consumers on `^1.1.0` or `^1.0.0` never resolve to `2.0.0-alpha.1`.

### Repository implications

- The gate in `release-node.yml` computes `major="${VERSION#v}"; major="${major%%.*}"`, which is `2` for `v2.0.0-alpha.1`, so the gate passes pre-releases of 2.0.0 and still stops 0.x and 1.x.
- `npm publish --workspaces --access public` has no tag; with npm 11.19.0 it fails on `2.0.0-alpha.1` before publishing anything. Before that, `npx napi pre-publish` runs a bare `npm publish` for each of the seven platform packages, which fails the same way. A tag has to reach both: `--tag next` on the workspace publish covers only that command, while `npm_config_tag=next` in the publish job's environment (passed through `env: process.env`) or a `.npmrc` would also reach napi's child `npm publish`.
- `@zero-server/sdk` is `"private": true` in `bindings/node/packages/sdk/package.json` today; with a tag set it would be skipped as private and not published.
- In the publish job napi's GitHub release path runs without `GITHUB_TOKEN` and with `contents: read`; it logs errors and does not create a release. `release-github.yml` is the workflow that owns the release.
- A later workflow command that moves `latest` with `npm dist-tag add` needs **Allow npm dist-tag** on each package's trusted publisher; publishing `2.0.0` with no tag sets `latest` through `npm publish` alone.

## GitHub releases

`gh release create`, gh v2.102.0, `pkg/cmd/release/create/create.go` (https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/release/create/create.go), source, line 210: `--prerelease`, `-p` "Mark the release as a prerelease"; line 218: `--latest` "Mark this release as "Latest" (default [automatic based on date and version]). --latest=false to explicitly NOT set as latest". The manual page (https://cli.github.com/manual/gh_release_create) carries the same text. The flag maps to the API field `prerelease` (line 451) and `--latest` to `make_latest` (line 464).

REST API, "Create a release" (page, https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28#create-a-release): `prerelease` "true to identify the release as a prerelease. false to identify the release as a full release. Default: `false`"; `make_latest` "Specifies whether this release should be set as the latest release for the repository. Drafts and prereleases cannot be set as latest. Defaults to true for newly published releases. legacy specifies that the latest release should be determined based on the release creation date and higher semantic version." "Get the latest release": "The latest release is the most recent non-prerelease, non-draft release, sorted by the created_at attribute."

### Tag sorting

git 2.56.0, `Documentation/config/versionsort.adoc` (https://github.com/git/git/blob/v2.56.0/Documentation/config/versionsort.adoc), source: "Even when version sort is used in git-tag, tagnames with the same base version but different suffixes are still sorted lexicographically, resulting e.g. in prerelease tags appearing after the main release (e.g. "1.0-rc1" after "1.0"). This variable can be specified to determine the sorting order of tags with different suffixes."

Checked locally (git 2.51.1) in a scratch repository with tags `v1.1.0 v2.0.0-alpha.1 v2.0.0-alpha.2 v2.0.0-beta.1 v2.0.0`:

- `git tag --list 'v*' --sort=-version:refname` gives `v2.0.0-beta.1, v2.0.0-alpha.2, v2.0.0-alpha.1, v2.0.0, v1.1.0`.
- `git -c versionsort.suffix=- tag --list 'v*' --sort=-version:refname` gives `v2.0.0, v2.0.0-beta.1, v2.0.0-alpha.2, v2.0.0-alpha.1, v1.1.0`.

### Repository implications

- `release-github.yml` calls `gh release create` without `--prerelease`, so `v2.0.0-alpha.1` would be a full release and, by the `make_latest` default, the repository's Latest release.
- Its `previous=$(git tag --list 'v*' --sort=-version:refname | grep -v "^${TAG}$" | head -1)` picks a pre-release over a final of the same base: tagging `v2.0.1` after `v2.0.0` and `v2.0.0-beta.N` would pick `v2.0.0-beta.N` as the previous tag. `pypi-backfill.yml` picks "the latest tag" with the same sort (`--sort=-v:refname | head -1`) and has the same problem once a final and its pre-releases coexist. `-c versionsort.suffix=-` orders them as SemVer does.
- The CHANGELOG extraction matches `## [$version]` with `index()`, a literal prefix, so `## [2.0.0-alpha.1]` works unchanged.

## Spelling per registry

| Version | crates.io | npm | NuGet | PyPI (canonical) | git tag |
| --- | --- | --- | --- | --- | --- |
| first alpha | `2.0.0-alpha.1` | `2.0.0-alpha.1` | `2.0.0-alpha.1` | `2.0.0a1` | `v2.0.0-alpha.1` |
| a beta | `2.0.0-beta.N` | `2.0.0-beta.N` | `2.0.0-beta.N` | `2.0.0bN` | `v2.0.0-beta.N` |
| a release candidate | `2.0.0-rc.N` | `2.0.0-rc.N` | `2.0.0-rc.N` | `2.0.0rcN` | `v2.0.0-rc.N` |
| final | `2.0.0` | `2.0.0` (moves `latest`) | `2.0.0` | `2.0.0` | `v2.0.0` |

PyPI tools accept the SemVer spelling as input and normalize it; the files and the index show only the PEP 440 form.

## Default visibility of a pre-release, summary

| Registry | Plain install or add while only the pre-release exists | After a final release exists |
| --- | --- | --- |
| crates.io | `cargo add` picks the pre-release (source fallback); a hand-written `"2"` or `"2.0"` does not match it | pre-release used only when the requirement names one |
| PyPI | `pip install zero-server` installs `2.0.0a1` (PEP 440 fallback) | needs `--pre`, `--all-releases`, or an explicit pre-release specifier |
| NuGet | `dotnet package add` errors and suggests `--prerelease` | needs `--prerelease` or an explicit version |
| npm | `npm install @zero-server/sdk` installs `latest`, 1.1.0 from zero-server-node | `latest` moves when 2.0.0 is published untagged |

## Not verified

- Whether the npm registry also points `latest` at the first version of a brand-new package published with `--tag next` (`@zero-server/native` and its seven platform packages have never been published). No npm documentation page fetched today states it.
- Whether an npm trusted publisher can be configured for a package that does not exist yet, which decides how the first OIDC publish of those eight new packages authenticates. The trusted publishers page does not say.
- That `napi pre-publish --no-gh-release` disables the GitHub release path. The option is declared as `Option.Boolean('--gh-release', true)`; the `--no-` negation is the clipanion convention but was not confirmed in clipanion's documentation.
- The exact dependency range `dotnet pack` writes into the nuspec for a `ProjectReference` (expected to be a minimum of `2.0.0-alpha.1`); no package was packed.
- That PyPI accepts a `Requires-Dist` written with the SemVer spelling (`zero-server-native==2.0.0-alpha.1`) on upload; it parses with packaging, but no upload was made.
- The produced file names (`zero_server_native-2.0.0a1-...whl`, `zero_server_core-2.0.0a1-...`) are inferred from the wheel and sdist specifications and the maturin and hatchling source; nothing was built.
- `dotnet package add` behavior was read from NuGet.Client tag v10.0.201; the NuGet bundled with older SDK lines was not checked.
- The `xtask version --check` failure on prose sites is from reading `version.rs`; the command was not run.
- The npm documentation pages are labeled 11.21.0 while Node 24.21.0 bundles npm 11.19.0; the publish behavior quoted above was read from the 11.19.0 source to match what the workflow runs.
- Quotes from rendered pages (Cargo Book, npm docs, Microsoft Learn, GitHub REST docs, pip docs) were extracted by a page fetch and may differ from the source in whitespace or markup; quotes marked "source" are verbatim.
