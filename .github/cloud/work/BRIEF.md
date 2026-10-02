# Brief: implementing the host dispatch, the C ABI and the Node binding

Repository: C:/Users/tonyw/Desktop/projects/zero-core (GitHub molexxxx/zero-server).

## Read first

1. `.github/cloud/RULES.md` at the repository root, and `.github/cloud/RULES.md`. Their rules bind
   you: every external fact (versions, API shapes, specification text) is fetched live
   and cited with URL and date, never written from memory; tests are named after the
   statement they check, with the specification section in the name or doc comment;
   every bug fix ships with a test that fails on the old code; American English; no em
   or en dashes; no planning vocabulary (phase, step, work package, milestone) in code,
   comments, docs or test names; rustdoc on every public item; no narration comments.
2. The design you implement: `.github/cloud/work/step12/DESIGN-12-13.md` (the revised design,
   authoritative), with its maps and facts in `.github/cloud/work/step12/` (`map-*.md`,
   `facts.md`). Section 14 lists the work packages, their files, tests, rows and exit
   checks. Your task names your package. Touch only the files your package owns;
   section 14 says which.
3. `.github/cloud/DESIGN.md` for anything DESIGN-12-13 cites by section.

## Owner decisions that apply

- DESIGN-12-13 section 15: every recommended default is accepted (the section 13
  amendments as a set; floors Node >=22, .NET net10.0, Python >=3.11 with abi3-py311;
  the 2.0.0 behavior breaks as a set; zero-host is published with the other crates;
  the three readings of the R.3 row 13 budget exit).
- `@zero-server/sdk` publishes `2.0.0-alpha.1` under the npm dist-tag `next`, together
  with `@zero-server/core` and `@zero-server/native` (decided 2026-10-02). This
  replaces any text that says sdk stays private until parity: the package that builds
  the facade removes `"private": true` from the sdk manifest and updates the generator
  (`crates/xtask/src/packages.rs`, the bundle README), `docs/about/releasing.md` and
  `SECURITY.md` in the same change.
- Public text never links github.com/molexxxx/zero-server-node, except the one link in
  SECURITY.md that stays until that repository is archived.

## Environment

- A cloud session runs in a Linux container with a fresh clone of the repository.
  Install the toolchains it needs: rustup with the version `rust-toolchain.toml`
  pins, plus `nightly` with `miri` and `rust-src` for Miri, cargo-fuzz and the
  sanitizers, and Node 24 for the bindings. Run cargo directly; use Docker only if
  the container has it. CONTRIBUTING.md lists the exact checks CI runs.
- Tests of the io-compio backend need io_uring; if the container refuses it, compio
  falls back to epoll silently, so say so instead of reporting io_uring as tested.
- Fetch every external fact live (crates.io, npm, PyPI, NuGet, rfc-editor.org, the
  WHATWG and W3C standards, nodejs.org) and cite it with its URL and date.
- Use a `CARGO_TARGET_DIR` unique to each parallel task so builds never wait on one
  another's lock.
- Two things stay on the owner's desktop and are not for a cloud session: the
  benchmark run on the Ryzen 9 9950X3D (the harness is built in the cloud, the
  numbers are taken locally), and the long local fuzz campaign.
## Working beside other agents

- Other packages are being implemented in the same tree at the same time, on files
  you do not own. Scope builds, clippy and tests to your crates with `-p`. Run `cargo
  fmt -p <your crates>`; run `cargo fmt --all -- --check` only to read, never to write.
  A workspace-wide failure in a crate you do not own is not yours to fix: report it.
- A generated file is changed only by running its generator, and only by the package
  that owns the generator change or whose sources change its output.
- In a parallel task, do not commit or push: the lead session reviews and commits each package after checking it.
- Your task may have been started before and cut off by a session limit. Run `git
  status` and read the files your package owns first; if partial work exists, review it
  and continue from it.
