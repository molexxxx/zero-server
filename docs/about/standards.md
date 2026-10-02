# Standards and testing

How zero-server holds every protocol behavior to its specification, and how that is
checked on every push.

## From the specification text

Every parser, wire format and protocol rule is written from the current text of the
document that defines it: the RFCs at rfc-editor.org, the WHATWG and W3C standards, and
the vendor reference of each database protocol. The text is read before the code is
written, and the function that implements a rule names its section in its
documentation. When a document is replaced, the code and its tests move to the new
one: TLS cites RFC 9846, which obsoletes RFC 8446.

## The registry

[`docs/standards.toml`](../standards.toml) holds one row for each statement the core
relies on: the document and section, the subject in the specification's own words, the
file that implements it, and the test that pins it. A test is named after the statement
it checks. `cargo xtask standards --check` runs on every push and blocks a release while
any row of that release has no test, or names a test that can no longer be found, so a
rule cannot lose its test silently.

## One set of vectors for every language

[`conformance/vectors.json`](../../conformance/vectors.json) is generated from the Rust
crates, with each case checked against the crate before it is written. It is the file
every language binding is held to, so a parser fix changes the expected results for
TypeScript, Python and C# at once; no binding asserts it yet. See
[`conformance/README.md`](../../conformance/README.md) for its shape.

## Untrusted input

The parsers of bytes from the network have libFuzzer targets under `fuzz/` with seeds
built from the specification's examples: the HTTP/1.1 head and chunked body, the
router, URIs, query strings, JSON, UTF-8, and the QPACK and HTTP/3 codecs. The
WebSocket frame and server-sent event decoders, the TLS hello reader and the smaller
field parsers do not have one yet. Every parser runs randomized tests against arbitrary
input and is written so it can never panic: the codec crates deny indexing, unwrap,
panics and unchecked arithmetic at compile time and build without the standard library
for a bare-metal target.

## Checks on every push

- Formatting, Clippy with warnings denied and the full test suite, and the runtime
  seam's tests on Linux, macOS and Windows.
- Miri over the codec and audited crates, and AddressSanitizer and ThreadSanitizer.
- A fuzzing pass over every target.
- `cargo deny` against the dependency allowlist and the advisory database, and
  `cargo vet` over every third-party crate.
- A reproducible-build check and a hardened build of the C ABI.

Unsafe code is forbidden outside a few audited crates; [SECURITY.md](../../SECURITY.md)
lists them with their inventory and says how to report a vulnerability.
