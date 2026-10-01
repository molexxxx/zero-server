# Security Policy

zero-core is the native core of zero-server: the parsers, the TLS termination
and the C ABI that every request to a zero-server application passes through.
A defect here is reachable from the network, so vulnerability reports are taken
seriously and handled promptly.

## Supported versions

zero-core is pre-1.0 and all crates share one workspace version. Security fixes
land on `main` and ship in the next patch release across every registry
(crates.io, npm, PyPI, NuGet). Only the latest published release is supported;
if you are on an older version, the fix is to upgrade.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not through a public issue,
pull request or discussion.

- Preferred: open a private report through GitHub's "Report a vulnerability"
  button under the repository's Security tab
  (https://github.com/molexxxx/zero-core/security/advisories/new). This keeps
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
