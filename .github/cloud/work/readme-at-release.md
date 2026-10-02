# Text for the 2.0.0-alpha.1 release commit

These are the README and package-page changes that become true only once
2.0.0-alpha.1 is on crates.io, npm, PyPI and NuGet. They go in the release
commit, after `README.proposed.md` has replaced `README.md`. Two hunks at the
end are not tied to the publish: SECURITY.md goes in the README commit itself,
and the codec sentence goes in the commit that lands the QPACK and HTTP/3
codecs.

## How to apply

1. Run `cargo xtask version 2.0.0-alpha.1`. It rewrites `version = "0.1.0"` in
   `README.md` to `version = "2.0.0-alpha.1"`. Every README hunk below is written
   against `README.proposed.md` as it reads after that bump, so each "Replace"
   block matches the file exactly.
2. Apply the hunks. Each "Replace" block occurs once in its file.
3. Run `cargo run -p xtask -- version --check 2.0.0-alpha.1` and
   `cargo run -p xtask -- docs --check`.

Every three-part version in these hunks is `2.0.0-alpha.1` in SemVer spelling,
and none follows a pip requirement operator, so `version --check` reads each one
as the workspace version. The `pip` lines name no version, so no PEP 440
spelling appears in the README.

The release commit merges before the tag, so the install lines are ahead of the
registries until the release workflows finish. If one registry fails partway,
rerun its workflow by hand with the version (see "When one stalls" in
`docs/about/releasing.md`) rather than reverting the README.

## README.md

### R1. The opening status sentence

The brief says the Node binding ships with the first release. Use A when the
released Node package serves requests; use B when it does not.

Replace:

````markdown
The Rust core serves HTTP/1.1 and HTTPS today. Nothing is published to a
registry yet, so it is used from this repository. The Node, Python and .NET
packages load the core but have no server API yet.
````

With (A, the Node binding is in the release):

````markdown
The Rust core serves HTTP/1.1 and HTTPS today, and the Node package serves
requests through it. The crates and packages on the registries are
pre-releases, and the Python and .NET packages have no server API yet.
````

With (B, the Node binding is not in the release):

````markdown
The Rust core serves HTTP/1.1 and HTTPS today. The crates and packages on the
registries are pre-releases, and the Node, Python and .NET packages have no
server API yet.
````

### R2. The quick start depends on crates.io, not on git

A pre-release requirement must name the whole pre-release version; a requirement
such as `"2"` never matches one. The bump rewrites the line at every later
release.

Replace:

````markdown
```toml
[dependencies.zero-server]
git = "https://github.com/molexxxx/zero-server"
version = "2.0.0-alpha.1"
default-features = false
features = ["http"]
```
````

With:

````markdown
```toml
[dependencies.zero-server]
version = "2.0.0-alpha.1"
default-features = false
features = ["http"]
```
````

The `zero` binary's install line stays as it is: `zero-serve` has
`publish = false`, so it installs from git at every release.

### R3. Install lines and the npm tag

Two hunks in "Packages". First, delete this paragraph and the blank line after
it, so the list follows the heading directly:

````markdown
None of these is on a registry yet; the Rust crate is used from git, as in the
quick start.
````

Then replace:

````markdown
On npm, the 1.x versions of `@zero-server/sdk` and `@zero-server/core` are the
earlier JavaScript framework, a different code base from this core.
````

With:

````markdown
The published versions are pre-releases, so each install asks for one:

```sh
cargo add zero-server@2.0.0-alpha.1
npm install @zero-server/core@next
pip install --pre zero-server
dotnet add package ZeroServer --prerelease
```

On npm, `latest` still points at the 1.x versions of `@zero-server/sdk` and
`@zero-server/core`, the earlier JavaScript framework and a different code base
from this core, so a plain `npm install @zero-server/core` installs that
framework.
````

`zero-serve`, `zero-examples`, `zero-bench` and `xtask` have `publish = false`,
and `@zero-server/sdk` stays private, so none of them is named here.

### R4. The bindings paragraph, with the Node binding

Apply only with R1 A, and only when the released Node package does both things
the picture draws: it declares routes, rules and static files once across the C
ABI, and it calls TypeScript handlers once per batch. Otherwise keep the
paragraph as it is.

Only the closing sentence changes. The whole paragraph is quoted so the block
matches the file's line breaks.

Replace:

````markdown
**The same core from other languages.** In the design the language packages
follow, a Node, Python or .NET application loads the core as a native library
and declares its routes, rules and static files once at startup, across the C
ABI. Rules, static files and Rust handlers are answered in Rust, and the
application's own handlers are called once per batch of up to 256 requests.
Today the C ABI exports only the core's version, and none of the packages can
serve a request yet.
````

With:

````markdown
**The same core from other languages.** In the design the language packages
follow, a Node, Python or .NET application loads the core as a native library
and declares its routes, rules and static files once at startup, across the C
ABI. Rules, static files and Rust handlers are answered in Rust, and the
application's own handlers are called once per batch of up to 256 requests.
The Node package works this way; the Python and .NET packages have no server
API yet.
````

### R5. A TypeScript example, with the Node binding

Apply only with R1 A, and only when a guide under `bindings/node/guides/` serves
requests and runs in the `node` workflow's "Smoke, conformance, and guide
tests" step. Without such a guide the README carries no TypeScript code.

Insert this after the paragraph that ends "which also takes an `Identities`
table and `TlsOptions`." and before "To serve a directory of files without
writing code". Fill the `ts` block with the guide's `import` lines, a blank
line, and the lines between its `// ANCHOR: <name>` and `// ANCHOR_END: <name>`
markers, byte for byte. Write nothing in it by hand.

````markdown
From TypeScript, install the Node package from npm's `next` tag:

```sh
npm install @zero-server/core@next
```

```ts
(the guide's import lines and anchored region, copied byte for byte)
```
````

## Other public files

`crates/xtask/src/packages.rs` renders every file in this section
(`core_readme`, `python_core_readme`, `python_bundle_readme`,
`dotnet_core_readme`, `dotnet_bundle_readme`). Put the same text into those
functions in the same commit. Otherwise `cargo xtask docs --check` fails, and
`release-preflight` blocks on it, and `cargo xtask docs` writes the old text
back.

The audit's wording for these files before the publish (P1, P3, P4, P6, P7)
either drops the install section for a one-line stand-in such as "This package
is not on PyPI yet." or keeps an earlier install section. Either way, the
release commit replaces whatever stands between the first paragraph and the
next heading (or the end of the file) with the section below.

### bindings/node/packages/core/README.md

Remove the paragraph:

````markdown
This package is not published from this repository yet. The 1.x versions of `@zero-server/core` on npm are the earlier JavaScript framework, a different code base.
````

or, if the file still has it, the section:

````markdown
## Install

```sh
npm install @zero-server/core
```
````

and put this in its place:

````markdown
## Install

Pre-releases are published under npm's `next` tag:

```sh
npm install @zero-server/core@next
```

A plain `npm install @zero-server/core` installs the `latest` tag, which is the 1.x line of the earlier JavaScript framework until the first final release of this core.
````

npm shows the README of the `latest` version on the package page, so until the
first final release this text appears only on the pre-release's version page.

### bindings/python/packages/zero-server/README.md

````markdown
## Install

```sh
pip install --pre zero-server
```
````

### bindings/python/packages/core/README.md

````markdown
## Install

```sh
pip install --pre zero-server-core
```
````

### bindings/dotnet/src/ZeroServer/README.md

````markdown
## Install

```sh
dotnet add package ZeroServer --prerelease
```
````

### bindings/dotnet/src/ZeroServer.Core/README.md

````markdown
## Install

```sh
dotnet add package ZeroServer.Core --prerelease
```
````

### CHANGELOG.md

`version --check` requires a `## [2.0.0-alpha.1]` entry. Write the date the tag
is pushed.

Replace:

````markdown
## [0.1.0] - Unreleased
````

With:

````markdown
## [2.0.0-alpha.1] - YYYY-MM-DD
````

### web/home.toml

Apply only if the owner counts the alpha as the first release (the audit's
P9.8 leaves that to the owner). Otherwise the line waits for the first final
release.

Replace either of:

````toml
opens = "Each opens once release 1 has shipped and the first tiered run is published."
opens = "Each opens once the first release is out and the first tiered run is published."
````

With:

````toml
opens = "Each opens once the first tiered run is published."
````

### Files that need nothing at release

- `docs/about/releasing.md`: the bump rewrites its `0.1.0` examples.
- `docs/about/standards.md`, `bindings/node/packages/sdk/README.md` and the three
  native READMEs: none names a version or an install line.
- `SECURITY.md`, once the hunk below is in: its text already describes the 2.0.0
  pre-releases and the npm `next` tag.

## Not tied to the publish: SECURITY.md drops the old repository's link

The README links SECURITY.md directly, and the owner is archiving
`molexxxx/zero-server-node`. Apply this hunk in the README commit, not the
release commit. It matches SECURITY.md as it reads in the working tree today
(lines 20 to 26).

Replace:

````markdown
On npm, the 1.x versions of `@zero-server/sdk` and `@zero-server/core` are the
earlier JavaScript framework,
[zero-server-node](https://github.com/molexxxx/zero-server-node), which
maintains them; report issues in them there. This core's pre-releases publish
to npm under the `next` tag. The `latest` tag of `@zero-server/core` moves to
this core with 2.0.0, while the `latest` tag of `@zero-server/sdk` stays on the
1.x line until this core's sdk package is made public.
````

With:

````markdown
On npm, the 1.x versions of `@zero-server/sdk` and `@zero-server/core` are the
earlier JavaScript framework, a different code base from this core. This core's
pre-releases publish to npm under the `next` tag. The `latest` tag of
`@zero-server/core` moves to this core with 2.0.0, while the `latest` tag of
`@zero-server/sdk` stays on the 1.x line until this core's sdk package is made
public.
````

The old text also told readers where to report issues in the 1.x line. Once the
repository is archived it has no issue tracker, so the new text names no
channel; whether this policy covers the 1.x line is the owner's call.

## Not tied to the publish: the QPACK and HTTP/3 codecs

`README.proposed.md` describes HEAD, where `zero-qpack` and `zero-h3` hold only
`VERSION`. The working tree now has both codecs, uncommitted. Apply this hunk in
the commit that lands them. If that commit is already on main when the README
is replaced, apply it to the README commit itself. The release ships both
crates, so the release commit is the latest point for it.

Replace:

````markdown
**Codecs without an operating system.** The HTTP/1.1, WebSocket and server-sent
event codecs, the router and the parsers around them are `no_std`, and CI
builds them for a bare-metal target.
````

With:

````markdown
**Codecs without an operating system.** The HTTP/1.1, WebSocket, server-sent
event, QPACK and HTTP/3 frame codecs, the router and the parsers around them
are `no_std`, and CI builds them for a bare-metal target.
````
