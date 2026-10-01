# Contributing to zero-core

Thanks for your interest in zero-core, the native core of zero-server. The
project is a single Rust core with thin language bindings, and every parser in
it sits on a network boundary, so contributions are held to a bar that keeps it
small, correct and faithful to the specification it implements. This guide
covers how to build, test and submit changes.

## Getting started

zero-core is a Cargo workspace. The engine and capability crates live under
`crates/`, the language bindings under `bindings/`, and the runnable examples
and the conformance vector generator in `crates/zero-examples`.

```sh
cargo build --workspace      # build the engine and capability crates
cargo test --workspace       # run tests, including doctests
```

You do not need a database, a certificate or a load generator. The tests run
against in-process fixtures, the conformance vectors, and the published vectors
of the specifications.

## Standards first

Every feature maps to a row in `docs/standards.toml`, the register of the
documents this core is held to: the RFCs at rfc-editor.org, the WHATWG and W3C
specifications, protobuf.dev, the gRPC PROTOCOL-HTTP2 document, the Prometheus
exposition format, W3C Trace Context, NIST SP 800-63B, the OWASP cheat sheets,
and the vendor reference for each database dialect.

- Before implementing, changing or reviewing any protocol, wire format, parser,
  header, cookie, crypto or auth behavior, fetch the cited document, read the
  section, and work from that text. Standards behavior is never implemented
  from memory. If the register has no row for the area, add one first.
- Cite the document in the rustdoc of the item that implements it, as
  `@see <url>#section`, and in the commit body.
- A conformance test is named after the statement it checks and carries the
  section number. Anchor it to the document's own published vector or worked
  example where one exists, not to a round trip alone, so an implementation
  that is wrong but self-consistent is caught.
- Only the current document counts: RFC 9110 to 9112, not 2616 or 7230 to
  7235; RFC 9113, not 7540; RFC 8489, not 5389; RFC 8656, not 5766. When a
  document is obsoleted, update the row.
- Security defaults follow the document's MUST and SHOULD requirements plus the
  referenced best current practice (RFC 8725 for JWT, RFC 9700 for OAuth 2.0,
  the rfc6265bis draft for cookies). A deviation needs a written rationale in
  the rustdoc and a test that pins the behavior.
- Every row carries the release that ships it. `cargo xtask standards --check`
  fails when a row at or below the current release has no test and reports the
  later rows as pending.

## Formatting and linting in Docker

CI runs `cargo fmt --all -- --check` and
`cargo clippy --workspace --all-targets -- -D warnings`, plus the same two over
each binding crate through `--manifest-path`. A crate is immutable once it is
on crates.io, so that job must be green before any publish. If your local
toolchain has neither rustfmt nor clippy, run them in the official Rust image;
the image does not ship the components, so build a small one that does, once,
and again after pulling `rust:latest`:

```sh
docker build -t zero-core-lint -f .docker/lint.Dockerfile .docker
docker run --rm --memory=3g --pids-limit=400 -e CARGO_TARGET_DIR=/tmp/t \
  -v "$PWD:/work" -w /work zero-core-lint cargo fmt --all
docker run --rm --memory=3g --pids-limit=400 -e CARGO_TARGET_DIR=/tmp/t \
  -v "$PWD:/work" -w /work zero-core-lint bash -c \
  "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings"
```

From Git Bash on Windows, prefix each `docker run` with `MSYS_NO_PATHCONV=1`
and give the mount as `C:/path/to/zero-core:/work`. `CARGO_TARGET_DIR=/tmp/t`
keeps the container's Linux artifacts out of the host `target/`. Do not
hand-guess rustfmt's output: it rewraps at its call width, not only at the
maximum line width.

## Before you open a pull request

CI runs formatting, linting, the lint-table diff, the `no_std` builds, tests on
both runtime backends, a dependency audit, and the drift checks on the
generated files. Run the same checks locally first:

```sh
cargo fmt --all                                        # format
cargo clippy --workspace --all-targets -- -D warnings  # lint, warnings are errors
cargo test --workspace                                 # test
```

`just ci` runs the full set if you have [just](https://github.com/casey/just)
installed, and `cargo xtask` lists the workspace tasks. `cargo deny check`
audits the dependency graph if you have
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny) installed.

## What the code expects

- Public items are documented. `missing_docs` is denied at build time, so every
  public item needs a rustdoc comment with `# Arguments`, `# Returns` and
  `# Errors` sections where they apply. Doc comments are the canonical
  documentation and carry runnable examples.
- Third-party crates are the exception. A crate that neither terminates TLS,
  hosts QUIC, sits on the runtime seam, makes raw operating system calls, wraps
  the C library nor crosses a language boundary has no third-party dependency
  at all. The others use the pinned allowlist in `deny.toml`; a crate not on it
  is denied.
- `unsafe` is forbidden everywhere except the audited crates named in
  `SECURITY.md`, which deny it and allow it per item with a `// SAFETY:` comment
  on every block. The lint table each crate copies is checked by
  `cargo xtask lints --check`.
- The codec crates stay `no_std`. A crate whose inputs and outputs are bytes
  and plain values carries `#![cfg_attr(not(feature = "std"), no_std)]`, the
  no_std lint table (no indexing, unwrap, expect, panic or unchecked
  arithmetic), and builds with `--no-default-features` on the host and for
  thumbv7em-none-eabihf in CI. Every malformed input returns an error.
- Parsers that read untrusted input carry property tests and a fuzz target. A
  decoder must never panic on arbitrary bytes.
- Tests never sleep to wait for an assertion: poll, use fake time, or await the
  real event. Every bug fix ships with a test that fails on the previous code.
- Comments are professional and sparse. Keep file and module headers and the
  doc comments on public items; do not add inline narration that restates what
  the next line does or records why an edit was made.
- American English, with regular dashes. Examples and guides build values with
  library calls rather than pasting byte blobs.
- Every change that adds or removes a capability audits `web/home.toml`, the
  README, and `docs/capabilities.toml` and `docs/standards.toml` in the same
  commit. Crate READMEs, `include/zero.h`, `index.d.ts`, `__init__.pyi` and
  `conformance/vectors.json` are generated: edit the source and regenerate.

## Commits and pull requests

- Write short, imperative commit subjects ("Add the chunked trailer parser"),
  with a body when the change needs explanation, and cite the document a
  protocol change follows.
- Keep a pull request focused on one change, and make sure CI is green.
- Add or update tests for the behavior you change, and update the affected
  crate's documentation.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Keep the
community welcoming to newcomers, including those who are not native English
speakers or professional engineers. Conduct concerns are reported privately to
the maintainer; the code of conduct says how.
