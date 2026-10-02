# Security Policy

zero-server is a memory-safe HTTP server core in Rust: the parsers, the TLS termination
and the C ABI that every request to a zero-server application passes through.
A defect here is reachable from the network, so vulnerability reports are taken
seriously and handled promptly.

## Supported versions

Every crate and package shares one version, published to crates.io, PyPI, NuGet
and npm together. The first releases are pre-releases of 2.0.0: 2.0.0-alpha.N,
then 2.0.0-beta.N (PyPI spells them 2.0.0aN and 2.0.0bN). Pre-releases carry no
compatibility promise between one another, and a security fix ships in the next
pre-release rather than as a patch to an earlier one. From 2.0.0 on, security
fixes land on `main` and ship in the next patch release on every registry.

Only the latest published release, pre-release or final, is supported; if you
are on an older version, the fix is to upgrade.

On npm, the 1.x versions of `@zero-server/sdk` and `@zero-server/core` are the
earlier JavaScript framework,
[zero-server-node](https://github.com/molexxxx/zero-server-node), which
maintains them; report issues in them there. This core's pre-releases publish
to npm under the `next` tag. The `latest` tag of `@zero-server/core` moves to
this core with 2.0.0, while the `latest` tag of `@zero-server/sdk` stays on the
1.x line until this core's sdk package is made public.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not through a public issue,
pull request or discussion.

- Preferred: open a private report through GitHub's "Report a vulnerability"
  button under the repository's Security tab
  (https://github.com/molexxxx/zero-server/security/advisories/new). This keeps
  the report confidential until a fix is available and gives us a private
  channel to coordinate.

A good report includes the affected crate and version, the platform, a
description of the issue and its impact, and a minimal reproduction (a byte
sequence, a code snippet or a failing test) where possible.

## What to expect

- Acknowledgment of your report within a few days.
- An initial assessment of severity and affected versions, and a private channel
  to work through the details with you.
- A coordinated fix and a patch release across the affected registries, with a
  published advisory once users have a version to upgrade to.
- Credit for the report, if you would like it.

Please give us a reasonable window to release a fix before any public
disclosure.

## Scope and areas of concern

The highest-risk surfaces, and where a report is most valuable:

- The parsers that read untrusted bytes off the wire: the HTTP/1.1 request head
  and chunked decoder, the WebSocket frame codec and its UTF-8 validation, the
  URI, query string, JSON and base64 parsers, the QPACK and HTTP/3 codecs, and
  every wire codec that follows them. These carry property tests and fuzz
  targets, and a crafted input that panics, hangs, misparses or is framed two
  ways is exactly the kind of issue we want to hear about.
- Request smuggling: ambiguous framing is answered with 400 and a close in
  every role, and Transfer-Encoding obfuscation with 501 and a close.
- The `unsafe` boundaries listed below, in particular `zero-ffi`, the single
  crate that exposes the C ABI, and the slot ownership protocol that keeps a
  late accessor from a host language away from recycled request memory.
- The TLS configuration in `zero-tls` and the primitives in
  `zero-server-crypto`: every MAC, token, session id and signature is compared
  in constant time, and secrets are zeroized on drop.
- The path policy in `zero-static`: a symlink, a dotfile segment, an alternate
  data stream name or an 8.3 short name must never escape the root.

The dependency graph is audited in CI on every change with `cargo deny`
(licenses, advisories and the pinned allowlist) and `cargo vet`, every shipped
library is built with `cargo auditable`, and each release carries a CycloneDX
SBOM and a build attestation.

## Unsafe inventory

`unsafe_code` is forbidden across the workspace. Eight audited crates carry a
lint table that lowers it to `deny` and allow it per item, each block with a
`// SAFETY:` comment stating the bounds check that precedes it, enforced by
`clippy::undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block` at
deny. CI diffs every manifest against the lint table it names, so no other
crate can gain an `unsafe` allow, and `cargo geiger` produces the inventory
below on each release. A crate that is not yet in the workspace is listed for
when it is created. Every table is empty until its first block lands.

### zero-simd

The dispatch call site and every pointer-taking load and store inside the
kernels; the SWAR path is safe Rust and the reference every kernel is tested
against.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### zero-server-crypto

The provider wrapper over aws-lc-rs, or ring under the alternate provider
feature.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### zero-ffi

The C ABI: every export catches panics, validates its arguments and takes a
slot borrow token before it reads arena memory.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### zero-sys

Every raw system call and socket option the workspace makes, behind a
bounds-checked wrapper.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### zero-sqlite

The bundled C library, the one deliberate C exception in the data path.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### zero-plugin

The dynamic loader and the vtable of a tier 4 plugin, under the trust model in
its documentation.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### bindings/node

The napi-rs crate: external buffers over the pooled staging region where still
used, thread-safe function pointers, and instance data.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### bindings/python/packages/native

The PyO3 crate: the view classes whose slot is reset per request.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

### bindings/dotnet

Every `unsafe` block, every `[SuppressGCTransition]` site and every
`[UnmanagedCallersOnly]` stub in the .NET binding, each requiring a named
reviewer through the CODEOWNERS rule on those files.

| Item | File | Obligation | Justification |
| --- | --- | --- | --- |

## Regression catalog

The defects found in the audit of the Node implementation become failing-first
tests in the crate that owns the behavior: identifier injection, operator
injection, prototype pollution and array caps in form decoding, decompression
bombs, dotfile segments, percent-decoding errors, JWT algorithm confusion, JWKS
key and algorithm matching, WebAuthn user verification, TURN loops and private
relays, protobuf 64-bit varints and presence, gRPC deadlines, WebSocket
framing, tenancy isolation under concurrency, and bounded maps with expiry. The
catalog lives in `conformance/regressions.md`, which is gitignored and kept
locally until it is empty, so an open defect is never published before its fix
is released. A fix ships with the test that failed before it.
