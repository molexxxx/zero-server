# Releasing

Every crate, package, and binding shares one version and goes out together, so
`0.1.0` of any one of them wraps `0.1.0` of every other. PyPI writes a pre-release
in its own spelling (see below), but it is the same version. A release is a tag
on main; everything after that is automatic.

## Why a publish gets checked first

crates.io, npm, PyPI, and NuGet all refuse to re-release a version. A bad publish
cannot be withdrawn, only superseded by another version, and a yanked crate stays
in every lockfile that already resolved it. So the release workflows publish
nothing until `release-preflight` passes, which turns three permanent mistakes
into a failed job:

- **A tag whose version is not the tree's.** `cargo xtask version --check <v>`
  reads every manifest, lockfile, and generated loader structurally, each in the
  spelling its tooling uses, so a manifest added since the last release cannot be
  missed, and requires `CHANGELOG.md` to have that version's entry.
- **A tag that is not on main.** A tag on a branch, or on a commit that was
  force-pushed away, would publish code that never landed.
- **A tag whose tests never ran.** A green tick on a pull request is not a green
  tick on the merge commit, so the check asks for a completed successful run of
  `ci`, `node`, `python`, and `dotnet` on that exact commit.

## Cutting one

```sh
git switch -c release/0.1.0
cargo xtask version 0.1.0          # every manifest, lockfile, and loader
cargo xtask docs                   # the package READMEs, whose install lines follow the version
# write the version's entry in CHANGELOG.md
cargo run -p xtask -- version --check 0.1.0
cargo run -p xtask -- docs --check
cargo run -p xtask -- standards --check
cargo xtask release --dry-run       # resolves every crate against its siblings
```

The dry run is one `cargo publish --workspace --dry-run`, which Cargo has
supported since 1.90; the toolchain `rust-toolchain.toml` names is newer, while
the crates' `rust-version` of 1.89 only sets what a user needs to build them.

Open that as a pull request labeled `release`, merge it when green, and wait for
the `rust` job and the three binding jobs to finish on the merge commit. Then
tag it:

```sh
git tag -a v0.1.0 -m "zero-server 0.1.0" <merge sha>
git push origin v0.1.0
```

The tag starts five workflows. `release-github` publishes the notes, and the
other four publish to crates.io, npm, PyPI, and NuGet. Each runs the preflight
first, so a tag that should not have been pushed costs a red job rather than a
version.

`release-node` publishes only from major version 2. Until then
`@zero-server/sdk` and `@zero-server/core` on npm are the 1.x line of
[zero-server-node](https://github.com/molexxxx/zero-server-node), and a 0.x or
1.x release of this core must not replace their `latest` tag, so for those
versions the workflow runs the preflight and its gate and publishes nothing.

## Pre-releases

A version is final, `x.y.z`, or a pre-release of one: `x.y.z-alpha.N`, then
`x.y.z-beta.N`, then `x.y.z-rc.N` if a release candidate is wanted, which is also
the order every registry sorts them in, below the final `x.y.z`. Every registry
carries the same version, and these three are the only phases that map one to
one onto PEP 440 and keep the same order there. PEP 440 spells `c`, `pre`, and
`preview` all as `rcN`, so `x.y.z-pre.1` and `x.y.z-rc.1` would be two versions
on crates.io, npm, and NuGet but one on PyPI; and PEP 440 sorts a development
release before the alpha, while SemVer's ASCII order puts `dev` after `beta`. So
`cargo xtask version` refuses any other pre-release, and refuses build metadata
(`+...`), whose only Python counterpart is a local version that PyPI does not
accept.

A pre-release is cut exactly like a final release. The pre-release version goes
into `cargo xtask version`, the `CHANGELOG.md` heading (`## [x.y.z-alpha.N]`), and
the tag (`vx.y.z-alpha.N`), and the bump writes the spelling each file's tooling
reads:

- SemVer, `x.y.z-alpha.N`, in every Cargo, npm, and NuGet manifest, lockfile,
  and loader, and in the README and on this page outside a pip requirement.
- The normalized PEP 440 form in every `pyproject.toml`, in the pins between
  the Python distributions, and in the README and on this page right after a
  requirement operator (`==`, `~=`, `>=`, `<=`, or `!=`), where pip reads the
  version: the separators are dropped and the phase is
  shortened, so `-alpha.N` becomes `aN`, `-beta.N` becomes `bN`, and `-rc.N`
  becomes `rcN`. pip, hatchling, and maturin would normalize the SemVer spelling
  the same way; the pyproject specification asks for the normalized form, and the
  wheel and sdist file names carry only that form.
- An exact requirement, `=x.y.z-alpha.N`, on each sibling crate. A caret
  requirement on a pre-release also accepts every later pre-release of the same
  `x.y.z`, and the crates of one pre-release are tested only with each other. A
  final version goes back to a caret requirement.

The release workflows take the rest from the tag. `release-preflight` reports
whether the version is a pre-release; `release-node` publishes a pre-release
under the npm dist-tag `next`, so the `latest` tag of `@zero-server/core` stays
on the 1.x line of zero-server-node; `release-github` marks the GitHub release
as a pre-release; and the PyPI upload matches the normalized spelling in the
file names. crates.io and NuGet need nothing beyond the version itself.

The first final release from major version 2 publishes to npm with npm's default
tag, so `latest` moves to it. npm 11 refuses to publish a pre-release without an
explicit tag, and refuses to apply `latest` implicitly to a version below one
already published, so neither a pre-release nor a later patch to an older line
can take `latest` from a package npm already carries. `@zero-server/sdk` stays
private, and is not published at all, until its facade reaches parity with
zero-server-node.

### Where each registry shows one

| Registry | Version shown | A plain install | Asking for the pre-release |
| --- | --- | --- | --- |
| crates.io | `x.y.z-alpha.N` | `cargo add zero-server` takes a pre-release only while no final version exists; a hand-written requirement such as `"2"` never matches one | `cargo add zero-server@x.y.z-alpha.N`, which writes that version as the requirement |
| PyPI | `x.y.zaN` | `pip install zero-server` installs a pre-release only when no final version satisfies the requirement | `pip install --pre zero-server`, or `zero-server==x.y.zaN` |
| NuGet | `x.y.z-alpha.N` | `dotnet add package ZeroServer` leaves pre-releases out, and with the .NET 10 SDK fails while a pre-release is the only version | `dotnet add package ZeroServer --prerelease`, or `--version x.y.z-alpha.N` |
| npm | `x.y.z-alpha.N` under the `next` dist-tag | `npm install @zero-server/core` installs `latest`, the 1.x line of zero-server-node until the first final release from major version 2 | `npm install @zero-server/core@next`, or the exact version |
| GitHub | `vx.y.z-alpha.N`, marked as a pre-release | never the repository's Latest release | listed on the Releases page with the pre-release label |

## The first release on npm

The first release that reaches npm also creates `@zero-server/native` and its
seven platform packages, and npm adds a trusted publisher only to a package that
already exists, so that release publishes them with a token. Before tagging it:

- Add this repository's `release-node.yml` as a trusted publisher of
  `@zero-server/core`, with `npm publish` among its allowed actions. A package
  can have up to ten trusted publishers, so any it already has stay.
- Create a granular access token on npmjs.com with **Read and write (publish
  and stage)** access to the `@zero-server` scope, with **Bypass two-factor
  authentication** checked if the account asks for a second factor to publish,
  and save it as the repository secret `NPM_TOKEN`.

`release-node` still tries trusted publishing first for every package and uses
the token only where that fails, so `@zero-server/core` publishes through its
trusted publisher, and the run posts a notice while the secret exists. Without
the secret the workflow publishes through trusted publishing alone, and a
package with no trusted publisher fails to authenticate.

Once the release is out, add `release-node.yml` as the trusted publisher of each
new package, with `npm publish` among its allowed actions: a trusted publisher
created after September 3, 2026 allows only `npm stage publish` until that box
is checked. Then delete the secret, revoke the token, and set each package's
publishing access to **Require two-factor authentication and disallow tokens**.

A package's first publish also gets `latest`, whatever tag it goes out under, so
the new packages show the first pre-release as `latest` until the first final
release. They have no 1.x line, and nothing installs them by tag:
`@zero-server/core` pins `@zero-server/native` to its exact version, and
`@zero-server/native` pins each platform package the same way.

## When one stalls

Every release workflow also takes a version by hand, so a run that failed
partway can be restarted without inventing a new tag. crates.io publishes new
crates in a burst of five and then one per ten minutes, so the first release of
the 28 crates spends at least 230 minutes waiting, close to the job's limit.
`cargo xtask release` waits that out and skips what is already published, so a
rerun continues rather than starting over: dispatch `release-crates` by hand
with the same version.
`release-node` likewise skips a package npm already has at the version, and the
PyPI and NuGet uploads skip a file the registry already holds.

PyPI caps how many new projects an account may create in a window, and a release
that introduces a project per capability runs past it; retrying inside the window
creates nothing. So the upload goes in dependency order, the compiled engine
first, and stops at the first refusal, and the `pypi-backfill` workflow runs
every hour, builds only what the latest release still lacks, and uploads it
until the cap answers again. It can also be dispatched by hand. Once every project
exists a release only adds files to existing projects, which the cap never
touches.

## The notes

`release-github` puts the changelog's entry for the version first, then the pull
requests that went into it, grouped by label. The entry says what changed and why
it matters; the list says which pull requests carried it. Labels come from the
files a pull request touches, so nobody has to remember one while merging.
