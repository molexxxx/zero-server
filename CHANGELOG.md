# Changelog

Notable changes to zero-server, the Rust server core and its bindings, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every
crate, the npm, PyPI and NuGet packages, and the language bindings share one
version and are released together, so one entry covers all of them.

## [0.1.0] - Unreleased

### Added

- The Cargo workspace: one crate per responsibility under `crates/`, the
  `zero-server` bundle crate, the `zero-ffi` C ABI, and the three lint tables in
  `docs/lints` that every member manifest copies.
- `docs/standards.toml`, the conformance register migrated from zero-server's
  `docs/STANDARDS.md` by `scripts/standards-from-markdown.mjs`, with a release
  on every row.
- `docs/capabilities.toml`, the capability map that claims every crate once
  with its lint table and release.
- `conformance/api-surface.json`, the export contract generated from the JSDoc
  of `@zero-server/sdk` by `scripts/api-surface-from-zero-server.mjs`, with a
  naming map per binding.
