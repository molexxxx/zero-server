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
- `docs/standards.toml`, the conformance register imported once from
  zero-server's `docs/STANDARDS.md` by `scripts/standards-from-markdown.mjs` and
  maintained in this repository since, with a release on every row.
- The runtime seam in `zero-io` with two backends, tokio by default and compio
  behind the `io-compio` feature, and per-core workers in `zero-rt`.
- The HTTP/1.1 server in `zero-http`: pipelining, `Expect: 100-continue`,
  chunked bodies, body limits, timeouts, a per-core memory budget, graceful
  shutdown, RFC 9457 problem details, panic containment, protocol switches and
  421 for a host a connection does not serve.
- Routing in `zero-router` and static files in `zero-static`, with a path policy
  on every segment, dotfiles refused by default, validators, conditional
  requests, byte ranges and a per-core cache.
- WebSocket in `zero-ws`, server-sent events in `zero-sse`, and rooms across
  cores in `zero-realtime`.
- TLS 1.3 and 1.2 in `zero-tls` over rustls, with a buffered and an unbuffered
  driver, certificates by server name, rotating tickets, and a handshake
  timeout and limit per core.
- Request rules in `zero-policy`: CORS, security headers, Fetch Metadata,
  request ids, trust proxy and body limits.
- The codecs: JSON, URIs, query strings, media types, base64 and HTTP dates,
  and in `zero-server-crypto` SHA-1, SHA-256, constant-time comparison and
  zeroizing secrets.
- The QPACK codec in `zero-qpack` and the HTTP/3 frame codec in `zero-h3`, both
  `no_std` with no I/O: the RFC 9204 static table, a static-only encoder and
  decoder, and the encoder and decoder stream instructions; the RFC 9114
  frames, settings, unidirectional stream types and GOAWAY over RFC 9000
  variable-length integers; and RFC 9297 capsules and HTTP datagrams.
- `docs/capabilities.toml`, the capability map that claims every crate once
  with its lint table and release.
- `conformance/api-surface.json`, the export contract generated from the JSDoc
  of `@zero-server/sdk` by `scripts/api-surface-from-zero-server.mjs`, with a
  naming map per binding.
