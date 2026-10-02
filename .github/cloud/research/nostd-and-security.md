# zero core: no_std boundaries and security engineering

Research notes for the Rust core of zero-server. Every claim below is tagged with the source it was read from in this task. Anything not backed by a fetched source is marked unverified. Numbers quoted from reference servers are defaults published by those projects, not measurements.

First pass fetched on 2026-09-29 (sections 1 to 11, sources cited inline); second pass on 2026-09-30 (sections 12 to 14). Section 15 lists every second-pass URL that returned content and, separately, the URLs that failed.

## 1. What no_std, core and alloc actually give you

Rust reference, preludes page (https://doc.rust-lang.org/reference/names/preludes.html):

- With `#![no_std]` the prelude switches to the `core` prelude for the crate's edition, `core` is added to the extern prelude, and `std` is not.
- "Additional crates that ship with rustc, such as alloc, and test, are not automatically included with the --extern flag when using Cargo. They must be brought into scope with an extern crate declaration, even in the 2018 edition."
- `no_std` does not prevent `std` from being linked: "It is still valid to write extern crate std in the crate or in its dependencies." So a no_std crate is only proven no_std by building it for a target that has no std (see section 3).

Embedded Rust book, no_std chapter (https://docs.rust-embedded.org/book/intro/no-std.html):

- "The libcore crate in turn is a platform-agnostic subset of the std crate which makes no assumptions about the system."
- core provides "APIs for language primitives like floats, strings and slices, as well as APIs that expose processor features like atomic operations and SIMD instructions" and "lacks APIs for anything that involves platform integration."
- The std runtime "takes care of setting up stack overflow protection, processing command line arguments, and spawning the main thread." None of that exists under no_std.
- Heap use is possible "only if you use the alloc crate and use a suitable allocator."

alloc crate docs (https://doc.rust-lang.org/alloc/index.html):

- Provides `Box`, `Vec`, `String`, `Rc`, `Arc`, the `collections` module (BTreeMap, BTreeSet, BinaryHeap, LinkedList, VecDeque), `borrow`, `fmt`, `str`, `slice`, `string`, `ffi` and `task`.
- Requires a global allocator: "The alloc module defines the low-level interface to the default global allocator."
- Does not provide HashMap, threads, or I/O; those are std. HashMap in no_std comes from hashbrown (section 3).

core async machinery (https://doc.rust-lang.org/core/task/index.html): `Context`, `Poll`, `Waker`, `RawWaker`, `RawWakerVTable` live in `core::task`, so futures and the polling protocol are no_std. `alloc::task` adds the `Wake` trait. An executor that blocks on an OS event queue is not.

core::net (https://doc.rust-lang.org/std/net/index.html): `IpAddr`, `Ipv4Addr`, `Ipv6Addr`, `SocketAddr`, `SocketAddrV4`, `SocketAddrV6` exist in `core::net`, so address types are no_std. `TcpListener`, `TcpStream`, `UdpSocket` are std only.

Things that need std, with the source that says so:

- Sockets: `std::net` provides "TcpListener and TcpStream ... UdpSocket" (std::net docs).
- Threads: "An executing Rust program consists of a collection of native OS threads" and "The thread name is provided to the OS where applicable (e.g., pthread_setname_np in unix-like platforms)" (https://doc.rust-lang.org/std/thread/index.html). Default stack "is 2 MiB on all Tier-1 platforms".
- Tokio: relies on "the operating system's event queue (epoll, kqueue, IOCP, etc...)" and guarantees Linux, Windows, Android, macOS, iOS, FreeBSD; its docs contain no no_std statement (https://docs.rs/tokio/latest/tokio/). Everything that touches the runtime is std.
- File I/O: std only. (No dedicated fetch; follows from the alloc docs listing no io module as stable and the embedded book statement that core lacks platform integration.)

## 2. TLS: rustls status for no_std

rustls crate root (https://docs.rs/rustls/latest/rustls/) and feature list (https://docs.rs/crate/rustls/latest/features):

- Default features: `aws_lc_rs`, `logging`, `prefer-post-quantum`, `std`, `tls12`. `std` "Enables std support in dependencies like once_cell, pki-types, and webpki". Non-default: `ring`, `fips`, `custom-provider`, `brotli`, `zlib`, `read_buf`, `hashbrown`.
- Without `std`: `Stream`, `StreamOwned`, `Reader`, `Writer`, `KeyLogFile` and the server `Acceptor` are unavailable, and "a custom time provider becomes mandatory". `DefaultTimeProvider` is the "Default TimeProvider implementation that uses std" (https://docs.rs/rustls/latest/rustls/time_provider/index.html).
- The unbuffered API "does not internally buffer TLS nor plaintext data", "doesn't make use of the std::io::Read and std::io::Write traits so it's usable in no-std context", and gives the caller control over "when and how to allocate, resize and dispose of" buffers (https://docs.rs/rustls/latest/rustls/unbuffered/index.html).
- Design: "provides no unsafe features or obsolete cryptography by default" and "does not take care of network IO".
- Providers (https://github.com/rustls/rustls/blob/main/README.md): `rustls-aws-lc-rs` gives "excellent performance and a complete feature set (including post-quantum algorithms)" but "can be harder to build on some platforms"; `rustls-ring` is "easier to build on a variety of platforms, but has a more limited feature set". "From 0.24, users must explicitly provide a crypto provider when constructing ClientConfig or ServerConfig instances."
- FIPS (https://docs.rs/rustls/latest/rustls/manual/_06_fips/index.html): enable the `fips` feature, install `rustls::crypto::default_fips_provider()`, and "validate the FIPS status of your ClientConfig/ServerConfig at run-time" with `fips()`. aws-lc-rs carries "FIPS 140-3 certificate #4816"; later releases "may be covered by later certificates, or be pending certification".

Consequence for the zero core: the TLS record layer and handshake state machine can sit in a no_std + alloc crate through the unbuffered API, with a `TimeProvider` supplied by the std host crate, but the socket-facing acceptor, the buffered `Stream` and the key log file are std. Practically, the server product will run rustls with `std` on; the no_std path is a portability guarantee, not the production configuration. The crate root is unconditionally `#![no_std]` with `extern crate alloc` and `#![forbid(unsafe_code)]` (section 12.4); whether it needs atomics for `Arc` on a given target is unverified.

## 3. Crate boundary for the zero core

Rule: a crate is no_std + alloc when its inputs and outputs are byte slices, buffers or plain values and it never needs a clock, a socket, a file, a thread, or an OS event queue. Everything else is std.

no_std + alloc (build with `--no-default-features`, `#![no_std]`, `extern crate alloc`):

- `zero-http1-codec`: request line, field lines, chunked coding, Content-Length and Transfer-Encoding framing decisions (RFC 9112). Model: httparse is a "push library for parsing HTTP/1.x requests and responses" designed for "speed and safety" (https://docs.rs/httparse/latest/httparse/). Its no_std attribute is confirmed from source in section 12.
- `zero-h2-codec`: frame parser, HPACK encoder and decoder, settings and flow-control accounting (RFC 9113, RFC 7541). Pure state machine over byte slices.
- `zero-ws-codec`: WebSocket framing and masking (RFC 6455).
- `zero-router`: method and path matching, parameter decoding, RFC 3986 dot-segment removal. Only needs `alloc::string` and `alloc::vec`.
- `zero-uri`, `zero-mime`, `zero-cookie`, `zero-date` (IMF-fixdate), `zero-qs` (query strings), `zero-multipart` boundary scanner, `zero-json`, `zero-base64`, `zero-varint`/protobuf wire, `zero-sdp` (WebRTC signaling parser), `zero-stun-codec`.
- `zero-limits`: the shared limit table (section 7) as plain `const` values and a `Limits` struct with no I/O.
- Crypto-free logic: `zero-jwt-codec` (header and claims encoding, algorithm allow list, no signing), `zero-hpack`, `zero-grpc-frame` (the 5-byte gRPC length prefix).
- Supporting crates that are no_std themselves: `bytes` (confirmed in section 12), `hashbrown` for maps (section 12), `heapless` for fixed-capacity containers ("static friendly data structures that don't require dynamic memory allocation"; push is "truly constant time rather than amortized constant time", capacity errors return `Result`, no_std, optional zeroize integration, https://docs.rs/heapless/latest/heapless/), `subtle`, `zeroize` ("embedded-friendly", https://docs.rs/zeroize/latest/zeroize/), `secrecy` ("no_std-compatible, unsafe-code-free", https://docs.rs/secrecy/latest/secrecy/).

std:

- `zero-net`: listeners, accept loop, per-connection tasks, timers, backpressure. Built on tokio (std only, above).
- `zero-tls`: rustls acceptor, certificate loading from disk, key log, `DefaultTimeProvider`.
- `zero-fs`: static files, range requests, sendfile-style streaming.
- `zero-db-*`: wire drivers for PostgreSQL, MySQL, MongoDB, Redis, SQLite (sockets, threads for SQLite).
- `zero-ffi`: the C ABI crate, which hosts the runtime for the Node, Python and C# bindings (same shape as pamoja-ffi: `crate-type = ["lib", "cdylib", "staticlib"]`, tokio `rt-multi-thread` behind a `runtime` feature, cbindgen as a build dependency; read from C:\Users\tonyw\Desktop\projects\zero-edge\crates\pamoja-ffi\Cargo.toml).
- `zero-observability` exporters (OTLP over sockets), `zero-signal` (OS signals), `zero-cli`.

Feature convention (copied from pamoja): each no_std crate has `default = ["std"]`, `std` turns on `alloc` plus std-only conveniences (`std::error::Error` impls, `std::io` adapters), and the std host crates depend with default features. pamoja's CI proves the boundary two ways: a host `cargo build --no-default-features -p <no_std crates>` and a bare-metal `cargo build --target thumbv7em-none-eabihf --no-default-features ...` job, with the comment that the host job "still links against the host std" so only the cross-compile is "the honest test of the no_std claim" (C:\Users\tonyw\Desktop\projects\zero-edge\.github\workflows\ci.yml, lines 49-58 and 192-229). The zero core CI copies both jobs.

Deliberate exclusions from the no_std set: anything holding secrets that must be compared or signed (HMAC, JWT signature verification, password hashing) is no_std-capable in principle but is placed in an audited crate `zero-crypto` with its own unsafe budget and fuzz targets, so the crypto-free crates can carry `#![forbid(unsafe_code)]` without exception.

## 4. Unsafe policy

What unsafe permits and what it can break (Rustonomicon, https://doc.rust-lang.org/nomicon/what-unsafe-does.html): unsafe lets code "Dereference raw pointers", "Call unsafe functions (including C functions, compiler intrinsics, and the raw allocator)", "Implement unsafe traits", "Access or modify mutable statics", "Access fields of unions". Undefined behavior includes dangling or unaligned dereference, "Breaking the pointer aliasing rules", wrong call or unwind ABI, data races, unsupported target features, and producing invalid values (a `bool` not 0 or 1, invalid enum discriminant, uninitialized integers, dangling references).

Lint facts (rustc allowed-by-default listing, https://doc.rust-lang.org/rustc/lints/listing/allowed-by-default.html): `unsafe_code` "catches usage of unsafe code and other potentially unsound constructs like no_mangle, export_name, and link_section"; `unsafe_op_in_unsafe_fn` "detects unsafe operations in unsafe functions without an explicit unsafe block". In edition 2024 `unsafe_op_in_unsafe_fn` "now warns by default" because the old behavior "could mask unsafe operations and make code harder to audit for safety" (https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-op-in-unsafe-fn.html).

Clippy restriction lints (https://rust-lang.github.io/rust-clippy/master/index.html): `undocumented_unsafe_blocks` ("Checks for usage of unsafe blocks without a safety comment"), `multiple_unsafe_ops_per_block`, `unnecessary_safety_comment`, `indexing_slicing`, `unwrap_used`, `expect_used`, `panic`, `arithmetic_side_effects` ("Checks any kind of arithmetic operation" that could overflow), `integer_division`, `as_conversions`, `mem_forget`; `cast_possible_truncation` is pedantic.

Policy:

1. Workspace default in `[workspace.lints.rust]`: `unsafe_code = "forbid"`, `missing_docs = "deny"`, `unsafe_op_in_unsafe_fn = "deny"`. pamoja uses `unsafe_code = "warn"` (C:\Users\tonyw\Desktop\projects\zero-edge\Cargo.toml, line 83); the zero core is stricter because the parsers face the network. Note that `#![forbid(unsafe_code)]` also forbids `#[no_mangle]`, `#[export_name]` and `#[link_section]`, so the FFI crate cannot be in the forbid set.
2. Audited crates, the only ones allowed `unsafe_code = "deny"` with per-item `#[allow(unsafe_code)]`: `zero-ffi` (C ABI, raw pointers from hosts), `zero-crypto` (only if a vetted provider such as aws-lc-rs or ring is wrapped; the wrapper itself should still be safe code), and at most one performance crate (`zero-simd` for header scanning) if and only if a benchmark shows the safe version loses the Drogon comparison. Each unsafe block carries a `// SAFETY:` comment enforced by `clippy::undocumented_unsafe_blocks = "deny"` and `clippy::multiple_unsafe_ops_per_block = "deny"`.
3. Dependencies: `cargo geiger` "lists statistics related to the usage of unsafe Rust code in a Rust crate and all its dependencies" and "is not meant to advise directly whether the code ultimately is truly insecure or not" (https://github.com/geiger-rs/cargo-geiger); it is run on release to produce the unsafe inventory that goes in SECURITY.md, not as a gate.
4. Panics are bugs in the parsers: `clippy::indexing_slicing`, `unwrap_used`, `expect_used`, `panic`, `arithmetic_side_effects` at `deny` in every no_std crate; the network-facing code must return `Err` for every malformed input, which is also what libFuzzer requires of a fuzz target ("must tolerate any kind of input (empty, huge, malformed, etc)", https://llvm.org/docs/LibFuzzer.html).
5. `overflow-checks = true` stays on in release for the parsers (section 9), so a missed checked arithmetic becomes a panic (caught by fuzzing) rather than a silent wrap.

## 5. Verification tools for the audited crates

Miri (https://github.com/rust-lang/miri/blob/master/README.md):

- Detects "Out-of-bounds memory accesses and use-after-free", "Invalid use of uninitialized data", intrinsic precondition violations, "Not sufficiently aligned memory accesses and references", basic type invariant violations, "Data races and emulation of some weak memory effects", experimental Stacked Borrows and Tree Borrows aliasing checks, and leaks.
- Limits: "Miri does not catch every violation of the Rust specification"; "The program has no access to most platform-specific APIs or FFI"; interpreted, so slow; "Miri tests one of many possible executions of your program".
- Run: `rustup +nightly component add miri`, `cargo miri test`; on Windows "use --target x86_64-unknown-linux-gnu to get better support". Flags: `-Zmiri-strict-provenance`, `-Zmiri-tree-borrows`, `-Zmiri-many-seeds=[<from>]..<to>`, `-Zmiri-symbolic-alignment-check`. "All Rust Tier 1 targets are supported by Miri" plus s390x for big-endian.
- Policy: `cargo miri test -p zero-ffi -p zero-crypto -p zero-simd` (the audited set) plus every no_std codec crate (cheap, and it catches the `bytes`-style pointer tricks in dependencies when they are exercised). Run with `-Zmiri-strict-provenance -Zmiri-many-seeds=0..16` on a Linux target in CI weekly and on every change to an audited crate.

Sanitizers (https://doc.rust-lang.org/beta/unstable-book/compiler-flags/sanitizer.html):

- Enable with `RUSTFLAGS=-Zsanitizer=<name> cargo build -Zbuild-std --target <triple>` on nightly. Testing-only sanitizers: address, hwaddress, leak, memory, thread. Production-capable: cfi, kcfi, memtag, safestack, shadow-call-stack.
- "AddressSanitizer works with non-instrumented code although it will impede its ability to detect some bugs. It is not expected to produce false positive reports." "MemorySanitizer requires all program code to be instrumented." ThreadSanitizer "does not support atomic fences std::sync::atomic::fence".
- CFI needs `-Clinker-plugin-lto` or `-Clto`; without `-Zsanitizer-cfi-normalize-integers`, `usize` and `u64` are treated as incompatible.
- Policy: ASan and TSan on the audited crates' test suites in a nightly CI job on `x86_64-unknown-linux-gnu`; fuzzing always runs with ASan (default for cargo-fuzz).

cargo-fuzz and libFuzzer:

- "cargo-fuzz is itself not a fuzzer, but a tool to invoke a fuzzer" using libfuzzer-sys (https://rust-fuzz.github.io/book/cargo-fuzz.html). "This project requires the nightly compiler since it uses the -Z compiler flag to provide address sanitization." Works on "x86-64 Linux, x86-64 macOS and Apple-Silicon (aarch64) macOS, and Windows (thanks to the MSVC AddressSanitizer)" (https://rust-fuzz.github.io/book/cargo-fuzz/setup.html).
- `cargo fuzz init` creates `fuzz/fuzz_targets`; "It is generally a good idea to check in the files generated by init." Targets are `fuzz_target!(|data: &[u8]| { ... })`; `cargo fuzz run <target>` (https://rust-fuzz.github.io/book/cargo-fuzz/tutorial.html). Subcommands: init, add, run, fmt, tmin ("Minify it to the smallest input that causes that failure"), cmin ("Minify your corpus of input files!"), coverage (https://github.com/rust-fuzz/cargo-fuzz).
- Structured inputs: "The fuzz_target! macro allows us to define fuzz targets that take any kind of input type, not just &[u8], as long as the input type implements the Arbitrary trait" (https://rust-fuzz.github.io/book/cargo-fuzz/structure-aware-fuzzing.html).
- `cargo fuzz coverage <target> [corpus dirs]` builds with `-Cinstrument-coverage`, replays the corpus, and merges into `coverage.profdata` for `llvm-cov` (https://rust-fuzz.github.io/book/cargo-fuzz/coverage.html).
- libFuzzer is "an in-process, coverage-guided, evolutionary fuzzing engine". Targets must be deterministic, tolerate any input, never call `exit()`, avoid "cubic or greater complexity, logging, or excessive memory consumption". Options: `-max_len`, `-timeout` (default 1200 s), `-rss_limit_mb` (default 2048), `-dict=FILE`, `-jobs`/`-workers`, `-merge=1` to minimize a corpus (https://llvm.org/docs/LibFuzzer.html).
- OSS-Fuzz for Rust: `cargo fuzz build -O`, `language: rust` in project.yaml, and "The only supported fuzzing engine and sanitizer are libfuzzer and address, respectively" (https://google.github.io/oss-fuzz/getting-started/new-project-guide/rust-lang/).

proptest (https://docs.rs/proptest/latest/proptest/, https://docs.rs/crate/proptest/latest/features): "Hypothesis-like property-based testing and shrinking"; default features include `std`, `fork`, `timeout`, `bit-set`; there is an `alloc` feature and a `no_std` feature (enables `num-traits/libm`), so property tests can run against the no_std crates with their std feature on in the dev-dependency graph. Use it for round-trip laws (encode(decode(x)) == x for HPACK, chunked, base64, varint) and for limit monotonicity (any input over a cap is rejected, any input under it is accepted).

## 6. Fuzz corpus per parser

Every parser crate ships `fuzz/` with one target per entry point, a checked-in `corpus/<target>/` seed set, a `<target>.dict` of protocol tokens, and CI that runs each target for a fixed budget then `cargo fuzz cmin`. The seed corpus is drawn from (a) the RFC examples, (b) the conformance vectors that the STANDARDS.md checklist statements describe, and (c) every crash artifact ever found, which is committed as a regression seed.

| Crate | Targets | Seeds and dictionary |
| --- | --- | --- |
| zero-http1-codec | `request_head`, `response_head`, `chunked_body`, `chunk_size`, `field_value`, `content_length` | RFC 9112 examples; CL.TE, TE.CL, TE.TE smuggling shapes; bare CR, obs-fold, whitespace before colon, `Transfer-Encoding: chunked, gzip`; dictionary of method tokens, header names, `chunked`, `close`, `keep-alive`, hex digits |
| zero-h2-codec | `frame`, `hpack_decode`, `hpack_encode_roundtrip`, `settings`, `connection_preface`, `stream_state` (structure-aware via Arbitrary over a frame sequence) | RFC 9113 and RFC 7541 worked examples (C.3 to C.6), rapid reset sequences (section 7), oversized dynamic table updates |
| zero-ws-codec | `frame`, `close_reason`, `utf8_continuation` | RFC 6455 masked and fragmented examples, control frames over 125 bytes, reserved bits |
| zero-router | `match_path`, `normalize_path` | `%2F`, dot segments, overlong percent sequences, non-UTF-8 |
| zero-uri, zero-qs, zero-cookie | one target each over the parse function | RFC 3986 and cookie edge cases from STANDARDS.md |
| zero-multipart | `boundary_scan`, `part_headers` | RFC 7578 examples, boundary at chunk edges |
| zero-json | `parse`, `roundtrip` (Arbitrary over a value tree) | nesting depth at the cap, long numbers, invalid UTF-8, surrogates |
| zero-grpc-frame, zero-varint | `length_prefix`, `varint`, `message` | 10-byte varints, truncated frames, `MAX_RECURSION_DEPTH` shapes |
| zero-sdp, zero-stun-codec | `sdp_parse`, `stun_message` | zero-server's `maxSdpSize` cases, attribute length overflows |
| zero-jwt-codec | `compact_split`, `header_parse` | `alg: none`, mixed-case algorithm names, oversized kid |
| zero-tls (std) | `unbuffered_handshake` driving rustls with Arbitrary record sequences | rustls' own test vectors |
| zero-ffi (std, audited) | `c_api_sequence` (Arbitrary over API call sequences with lengths and null pointers) | none |

Reference practice: httparse ships six libFuzzer targets and h2 ships three, one of them structure-aware through `arbitrary` (target lists in sections 12.4 and 12.5).

## 7. HTTP hardening: smuggling, slow clients, limits

RFC 9112 Section 11 (https://www.rfc-editor.org/rfc/rfc9112.html#section-11):

- 11.1: "Response splitting (a.k.a. CRLF injection) is a common technique, used in various attacks on Web usage, that exploits the line-based nature of HTTP message framing"; when attacker-controlled data is echoed into a header "the response has been split, and the content within the apparent second response is controlled by the attacker".
- 11.2: "Request smuggling is a technique that exploits differences in protocol parsing among various recipients to hide additional requests"; the RFC addresses it with "new requirements on request parsing, particularly with regard to message framing".
- 11.3: "HTTP does not define a specific mechanism for ensuring message integrity, instead relying on the error-detection ability of underlying transport protocols"; with https, "connection closure cannot be used to truncate messages" without detection.
- 11.4: "HTTP relies on underlying transport protocols to provide message confidentiality when that is desired."

Framing rules to implement exactly (RFC 9112, same document):

- 6.3: when both Transfer-Encoding and Content-Length are present "the Transfer-Encoding overrides the Content-Length. Such a message might indicate an attempt to perform request smuggling or response splitting and ought to be handled as an error"; invalid or conflicting Content-Length values are answered 400 and the connection is closed.
- 6.1: "If any transfer coding other than chunked is applied to a request's content, the sender MUST apply chunked as the final transfer coding"; a request whose final coding is not chunked is rejected.
- 2.2: bare CR outside content must be treated as invalid or replaced by SP; "A sender MUST NOT send whitespace between the start-line and the first header field".
- 3: "It is RECOMMENDED that all HTTP senders and recipients support, at a minimum, request-line lengths of 8000 octets"; over-long target is 414, over-long method 501.
- 5: whitespace between field name and colon is 400.
- 7.1: chunk-size numerals must be parsed so that "integer overflow or precision loss" cannot occur; unrecognized chunk extensions are ignored.
- 9.5: "A server SHOULD sustain persistent connections, when possible, and allow the underlying transport's flow-control mechanisms to resolve temporary overloads."

RFC 6585 (https://www.rfc-editor.org/rfc/rfc6585.html): 431 "indicates that the server is unwilling to process the request because its header fields are too large" and applies both when the total header size is too large and when a single field is; 429 "indicates that the user has sent too many requests in a given amount of time".

RFC 9113 HTTP/2 (https://www.rfc-editor.org/rfc/rfc9113.html#section-10.5): `SETTINGS_MAX_HEADER_LIST_SIZE` is advisory, counted as "the length of the name and value in units of octets plus an overhead of 32 octets for each field line"; `SETTINGS_MAX_FRAME_SIZE` ranges 2^14 to 2^24-1 and every endpoint must accept 16,384-octet payloads; HPACK dynamic table starts at 4,096 bytes; `SETTINGS_MAX_CONCURRENT_STREAMS` bounds simultaneous streams per direction.

OWASP Denial of Service cheat sheet (https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html): "Slow HTTP attacks deliver HTTP requests very slow and fragmented, one at a time. Until the HTTP request was fully delivered, the server will keep resources stalled while waiting for the missing incoming data." Recommends: "Define a minimum ingress data rate limit and drop all connections below that rate", "Define an absolute connection timeout", "Limit server side session time based on inactivity and a final timeout", "Limit total request size", "Limit file upload size and extensions". It gives no numbers and warns that thresholds set too low harm legitimate users.

Reference defaults (published defaults of the named projects, not measurements):

| Limit | nginx (https://nginx.org/en/docs/http/ngx_http_core_module.html) | hyper 1.x http1 Builder (https://docs.rs/hyper/latest/hyper/server/conn/http1/struct.Builder.html) | Node.js | Apache 2.4 |
| --- | --- | --- | --- | --- |
| Initial header buffer | `client_header_buffer_size 1k` | `max_buf_size` default about 400 kB, minimum 8192 (panics below) | see section 12 | unverified (page truncated) |
| Large header buffers | `large_client_header_buffers 4 8k`; a field over one buffer is 400, a request line over one buffer is 414 | | | |
| Header count | | `max_headers` 100, over that 431 | `maxHeadersCount` 1000 (response side) | |
| Header read timeout | `client_header_timeout 60s`, then 408 | `header_read_timeout` 30 s, connection closed | see section 12 | |
| Body read timeout | `client_body_timeout 60s` between reads, then 408 | | | |
| Max body | `client_max_body_size 1m`, then 413 | | | |
| Keep-alive idle | `keepalive_timeout 75s` | `keep_alive` true | | |
| Requests per connection | `keepalive_requests 1000` ("Closing connections periodically is necessary to free per-connection memory allocations") | | `maxRequestsPerSocket` then 503 on `dropRequest` | |
| Send timeout | `send_timeout 60s` between writes | | | |

h2 Rapid Reset and h2 crate limits: section 12.5.

Per-connection limit table for the zero core (defaults chosen inside the ranges above; every one configurable):

- `max_request_line = 8192` (meets the RFC 9112 8000-octet recommendation; nginx's 8k buffer): over that 414 (target) or 501 (method).
- `max_header_field = 8192`, `max_header_count = 100` (hyper), `max_header_bytes = 32768`: over that 431 with the offending field named in the body when a single field is at fault (RFC 6585).
- `header_read_timeout = 30 s` from first byte of a request head (hyper); `idle_keep_alive = 60 s`; `body_read_idle = 60 s` between reads (nginx); `min_ingress_rate` optional, default off (OWASP).
- `max_body = 1 MiB` unless a route opts in (nginx; matches zero-server's `'1mb'` body defaults, see section 11); streaming bodies past the cap are rejected 413 before buffering.
- `max_requests_per_connection = 1000` (nginx) to recycle per-connection allocations.
- `max_chunk_extension_bytes = 256`, `max_trailer_bytes = 4096`; chunk-size parsing uses checked `u64` hex with a digit cap.
- `max_pipelined = 8` in-flight requests per connection, responses written in order.
- h2: `max_concurrent_streams = 100`, `max_frame_size = 16384`, `max_header_list_size = 32768` counted with the 32-octet overhead, `header_table_size = 4096`, plus reset-rate limits (section 12).
- Global: `max_connections` bounded by a semaphore in the accept loop; connection memory budget = initial buffer (8 KiB, grown only on demand to the header cap) so the per-connection resident floor stays in the low tens of kilobytes.

Smuggling posture: reject (400 and close) rather than normalize whenever CL and TE coexist, when TE has an unknown or non-final chunked coding, when CL is a list of differing values, or when a bare CR or obs-fold appears; never forward ambiguous requests. This is the strict reading of RFC 9112 6.3 ("ought to be handled as an error"). The zero core is an origin server, so it has no downstream parser to disagree with, but reverse proxies in front of it do, and refusing ambiguity keeps it from being the "back end" half of a CL.TE or TE.CL pair.

## 8. Secrets: constant-time comparison and zeroization

subtle (https://docs.rs/subtle/latest/subtle/): provides `Choice` (a `u8` holding 0 or 1), `ConstantTimeEq` ("Produces a Choice instead of bool"), `CtOption`, `ConditionallySelectable`. "This represents a best-effort attempt to protect against some software side-channels." "This crate is intended to be used in release mode" because debug assertions branch on secret data. The compiler caveat: "For a compiler to recognize that bitwise operations represent a conditional assignment, it needs to know that the value used to generate the bitmasks is really a boolean i1 rather than an i8 byte value", mitigated with volatile reads.

zeroize (https://docs.rs/zeroize/latest/zeroize/): `Zeroize` "takes &mut self and writes over the type's internal memory with some placeholder value, typically some form of 0", implemented with "core::ptr::write_volatile and core::sync::atomic memory fences"; `ZeroizeOnDrop`, `Zeroizing<T>` wrapper, derive macros via `zeroize_derive`; "embedded-friendly", works in WebAssembly. Limits: stack spills and moves may leave copies; `Vec`, `String`, `CString` "cannot guarantee copies of the data were not previously made by buffer reallocation"; no guarantee against microarchitectural leaks; register clearing, `mlock()`, `mprotect()` are out of scope.

secrecy (https://docs.rs/secrecy/latest/secrecy/): `SecretBox`, `SecretString`, `SecretSlice`, `ExposeSecret`; redacts Debug, zeroizes on drop, "no_std-compatible, unsafe-code-free"; serialization is off by default "to prevent secret exfiltration".

Policy:

- Every comparison of a MAC, token, API key, session id, CSRF token, password hash or JWT signature goes through `subtle::ConstantTimeEq`; `clippy` cannot enforce this, so `zero-crypto` exposes `verify_mac(&[u8], &[u8]) -> bool` and `verify_token` and the parsers never compare secret bytes with `==`. A test asserts by grep that `PartialEq` is not implemented on secret newtypes.
- Secret material is held in `secrecy::SecretBox<[u8; N]>` or `Zeroizing<Vec<u8>>`, allocated once at its final size to avoid the reallocation caveat, and never formatted.
- Debug builds of `subtle` are unsuitable for timing claims, so timing tests run only on release artifacts.

## 9. Hardened build flags

rustc exploit mitigations (https://doc.rust-lang.org/rustc/exploit-mitigations.html), Linux AMD64 table: PIE yes by default since 0.12.0; integer overflow checks yes but debug only; non-executable memory yes since 1.8.0; stack clashing protection (stack probes) yes since 1.20.0; read-only relocations and immediate binding (full RELRO) yes since 1.21.0; heap corruption protection via the system allocator since 1.32.0; stack smashing protection no, `-Z stack-protector` (nightly); forward-edge CFI no, `-Z sanitizer=cfi` (nightly); backward-edge no, `-Z sanitizer=shadow-call-stack,safestack` (nightly). Windows: Control Flow Guard supported.

rustc codegen options (https://doc.rust-lang.org/rustc/codegen-options/index.html): `-C overflow-checks` "If not specified, overflow checks are enabled if debug-assertions are enabled, disabled otherwise"; `-C control-flow-guard` "currently ignored for non-Windows targets", off by default; `-C relro-level` "rustc enables Full RELRO by default on platforms where it is supported"; `-C relocation-model=pic` "is the default model for majority of supported targets"; `-C strip=symbols`; `-C lto=thin|fat`; `-C codegen-units=1` "may improve the performance of generated code"; `-C panic=abort|unwind|immediate-abort` and "If any crate in the crate graph uses abort, the final binary must also use abort".

Cargo release profile defaults (https://doc.rust-lang.org/cargo/reference/profiles.html): `opt-level = 3`, `strip = "none"`, `debug-assertions = false`, `overflow-checks = false`, `lto = false`, `panic = 'unwind'`, `codegen-units = 16`. Overrides per package: `[profile.release.package.<name>]`.

Chosen release profile:

```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
overflow-checks = true
panic = "unwind"
strip = "symbols"
debug = false
```

- `overflow-checks = true` in release: the parsers use checked arithmetic by lint, and this converts any miss into a panic instead of a wraparound that could become an out-of-bounds length. The TechEmpower comparison must be run with this on; if the cost is measurable, it is disabled only via `[profile.release.package."zero-simd"]`, never globally.
- `panic = "unwind"` is required: the FFI crate must catch panics at the boundary (`std::panic::catch_unwind`) because unwinding across `extern "C"` is undefined behavior (Rustonomicon list above, "unwinding from a function with the wrong unwind ABI"). `panic = "abort"` would turn a parser panic into a host-process crash for Node, Python and .NET users. The pure `zero-*` binaries (CLI, standalone server) may opt into abort in their own profile.
- `lto = "fat"` plus `codegen-units = 1` (pamoja uses thin and 1) enables `-Z sanitizer=cfi` builds on nightly for the hardened artifact variant, since CFI "requires -Clinker-plugin-lto or -Clto".
- Windows artifacts: `RUSTFLAGS=-C control-flow-guard` in the release workflow (no cost on other targets, ignored there).
- Linux artifacts: defaults already give PIE, NX, full RELRO, stack probes. A nightly "hardened" job additionally builds with `-Z stack-protector=all` and `-Z sanitizer=cfi` to keep the code CFI-clean (function pointer types must match exactly), even though the shipped stable build cannot use them.
- Verification step in CI copied from the mitigations page: `readelf -l` shows `GNU_STACK ... RW` and `GNU_RELRO`, `readelf -d` shows `BIND_NOW`.

## 10. Supply chain: advisories, SBOM, provenance, CodeQL

RustSec (https://rustsec.org/): "a vulnerability database for the Rust ecosystem" maintained by the Rust Secure Code Working Group; the GitHub Advisory Database "imports our advisories and makes them available in its public API", which feeds Dependabot.

cargo-audit (https://github.com/rustsec/rustsec/blob/main/cargo-audit/README.md): audits `Cargo.lock` against RustSec; `cargo audit bin <binary>` and "If your programs have been compiled with cargo auditable, the audit is fully accurate because all the necessary information is embedded in the compiled binary"; `--ignore RUSTSEC-...` for accepted advisories; for GitHub Actions "Please use audit-check action directly".

cargo-deny (https://embarkstudios.github.io/cargo-deny/): "lets you lint your project's dependency graph"; checks advisories, licenses, bans, sources; `cargo deny init && cargo deny check`; GitHub Action `cargo-deny-action`. pamoja's deny.toml (C:\Users\tonyw\Desktop\projects\zero-edge\deny.toml) sets `exclude-dev = true`, `yanked = "deny"`, a license allow list (MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib), an MPL-2.0 exception for cbindgen, `multiple-versions = "warn"`, `wildcards = "warn"`, `unknown-registry = "deny"`, `unknown-git = "deny"`, and every ignored advisory carries a written reason. The zero core reuses that file with `multiple-versions = "deny"` (the dependency graph is small enough to hold to it from the start).

cargo-auditable (https://github.com/rust-secure-code/cargo-auditable): "embedding data about the dependency tree in JSON format into a dedicated linker section of the compiled executable" (`.dep-v0`, zlib-compressed); `cargo auditable build --release`; consumed by cargo audit (0.17.3+), trivy (0.31.0+), grype (0.83.0+), osv-scanner (2.0.1+), syft; "under 4kB even on large dependency trees with 400+ entries"; supports Linux, Windows, macOS and WebAssembly from 0.6.3.

Cargo native SBOM precursor (https://doc.rust-lang.org/cargo/reference/unstable.html#sbom): nightly `-Z sbom` or `CARGO_BUILD_SBOM=true` writes `<artifact>.cargo-sbom.json` (version, root, crates with features and dependencies, rustc version and commit) for "all executable and linkable outputs"; tracking issue 13709, RFC 3553. Unstable, so it is an input to the SBOM job, not the shipped format.

CycloneDX (https://github.com/CycloneDX/cyclonedx-rust-cargo): `cargo install cargo-cyclonedx`, `cargo cyclonedx` "creates a valid CycloneDX Software Bill of Materials (SBOM) containing an aggregate of all project dependencies"; "Cargo may run arbitrary code when invoked on an untrusted project, so cargo-cyclonedx should not be called on untrusted projects either."

Provenance (https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds and https://docs.github.com/en/actions/concepts/security/artifact-attestations): permissions `id-token: write`, `contents: read`, `attestations: write`; step `uses: actions/attest@v4` with `subject-path`; SBOM attestation through `sbom-path` after a separate SBOM generation step; verify with `gh attestation verify PATH -R ORG/REPO`. "Artifact attestations by itself provides SLSA v1.0 Build Level 2"; "Reusable workflows can provide isolation between the build process and the calling workflow, to meet SLSA v1.0 Build Level 3". Public repositories use the Sigstore Public Good Instance with a public transparency log; private ones use GitHub's instance without a transparency log.

SLSA levels (https://slsa.dev/spec/v1.0/levels): L1 "Provenance exists describing how the artifact was built, including the build platform, build process, and top-level inputs"; L2 "Build platform runs on dedicated infrastructure, not an individual's workstation, and the provenance is tied to that infrastructure through a digital signature"; L3 "Build platform implements strong controls to prevent runs from influencing one another, even within the same project".

CodeQL (https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql and https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/): "CodeQL supports the following languages: C/C++, C#, Go, Java/Kotlin, JavaScript/TypeScript, Python, Ruby, Rust, Swift, GitHub Actions workflows". Rust: "Rust editions 2021 and 2024", "Requires rustup and cargo to be installed. Features from nightly toolchains are not supported", query pack `codeql/rust-queries`, not marked preview. pamoja's workflow (C:\Users\tonyw\Desktop\projects\zero-edge\.github\workflows\codeql.yml) runs one analysis per language (actions, csharp, javascript-typescript, python, rust) with `build-mode: none`, `github/codeql-action/init@v4.38.0` and `analyze@v4.38.0`, weekly schedule, `security-events: write`. Copy it verbatim; add `--extension-packs` only if the Rust web-framework models (actix-web, rocket, warp are listed) need a custom model for the zero router.

Pipeline (per release, in this order): `cargo deny check` and `cargo audit` on the lock file; `cargo auditable build --release` for every binary; `cargo cyclonedx --format json` plus the nightly `-Z sbom` precursor attached as build artifacts; `actions/attest` with `subject-path` on every binary, wheel, nupkg and npm tarball, and `sbom-path` for the CycloneDX file; publish through a reusable workflow so the attestation qualifies for SLSA Build L3; consumers verify with `gh attestation verify`. Weekly `cargo audit bin` over the released binaries catches advisories published after the release.

## 11. What transfers from zero-server

Read from C:\Users\tonyw\Desktop\projects\zero-server (no files modified):

- `docs/STANDARDS.md`: 45 feature rows, 417 checklist statements, 11 driver rows, 98 driver statements, 148 verified URLs (its own header). The statements are written "to become test names" and cite section numbers; they are language-neutral. The HTTP/1.1 framing checklist (13 statements at lines 70-82) maps one-to-one onto the `zero-http1-codec` conformance tests and the smuggling fuzz seeds: CL plus TE rejected and connection closed, TE not ending in chunked is 400, invalid CL is 400, whitespace before colon is 400, Host rules, obs-fold, bare CR, leading CRLF ignored, 414/501 with 8000-octet support, chunk extensions bounded, trailers not merged, `Connection: close`, pipelined order. The HTTP/2 checklist (15 statements, lines 92-106) does the same for `zero-h2-codec`, including never-indexed HPACK literals for Authorization, Cookie and Set-Cookie. This file is the single most valuable transfer; copy it into the new repository as the conformance registry and generate the Rust test names from it.
- Limit constants already chosen in the Node code, usable as the zero-limits defaults: body parsers default `limit '1mb'` (lib/body/json.js line 57, raw.js 35, urlencoded.js 59, text.js 37); multipart `maxFieldSize` 1 MiB (lib/body/multipart.js 160); gRPC `DEFAULT_MAX_MESSAGE_SIZE` 4 MiB, `MAX_VARINT_SIZE` 10, `MAX_RECURSION_DEPTH` 64 (lib/grpc/codec.js 39-51), `MAX_FRAME_SIZE` 16 MiB (lib/grpc/frame.js 29), metadata `MAX_KEY_LENGTH` 256 and `DEFAULT_MAX_METADATA_SIZE` 8192 (lib/grpc/metadata.js 44-50); WebSocket `maxPayload` example 64 KiB (lib/app.js 765); SDP `DEFAULT_MAX_BYTES` 65,536, `DEFAULT_MAX_CANDIDATES` 30, `DEFAULT_MAX_PROTOCOL_ERRORS` 5 (lib/webrtc/signaling.js 58-67, sdp.js 19); session `MAX_COOKIE_SIZE` 4096 (lib/auth/session.js 53); TURN `MAX_LIFETIME` 3600 (lib/webrtc/turn/server.js 74). The Node HTTP layer itself sets no header limits of its own (grep for maxHeaderSize/headersTimeout in lib/ finds only the JWKS `requestTimeout` 5000 in lib/auth/jwt.js), so those defaults come from Node and must be made explicit in the Rust core.
- The roughly 8,000 vitest tests: the ones under test/http, test/orm, test/realtime and test/grpc are behavioral specifications that can be re-expressed as conformance vectors (JSON in, expected status and headers out) and driven from all three bindings, which is the pamoja `conformance/vectors.json` pattern (its CI fails if the regenerated vectors differ, ci.yml lines 127-137).
- Not transferable: the JavaScript implementation, the `packages/` generator, and the middleware that depends on Node streams.

## 12. Confirmations from the second pass (fetched 2026-09-30)

### 12.1 ANSSI Secure Rust Guidelines

Source: https://anssi-fr.github.io/rust-guide/print.html (the single-page render; the per-chapter URLs returned 404). The rules that bind the zero core, quoted exactly, with the policy item they justify:

- DENV-RUSTUP-STABLE: "Development of a secure application MUST be done using a fully stable toolchain, for limiting potential compiler, runtime or tool bugs." Shipped artifacts build on stable; Miri, sanitizers, cargo-fuzz and `-Z sbom` run on nightly in separate CI jobs only (DENV-RUSTUP-NIGHTLY: "it is preferable to run it by switching the toolchain only locally").
- DENV-CARGO-LOCK: "Cargo.lock files MUST be tracked by a version control system." The workspace commits its lock file; cargo-audit and cargo-deny read it.
- DENV-CARGO-PROFILES: "The variables debug-assertions and overflow-checks MUST NOT be overridden in development profiles' sections." Section 9 raises `overflow-checks` in the release profile, which is the opposite direction (more checking) and leaves the dev profile untouched.
- DENV-CARGO-ENV: "The environment variables RUSTC, RUSTC_WRAPPER and RUSTFLAGS MUST NOT be overridden when using Cargo to build the project." The Windows `control-flow-guard` flag in section 9 therefore goes into `.cargo/config.toml` under `[target.x86_64-pc-windows-msvc] rustflags`, not into a `RUSTFLAGS` export in the workflow.
- DENV-LINTER: "A linter, such as clippy, MUST be used regularly during the development of a secure application." DENV-FORMAT: rustfmt "SHOULD be used". pamoja runs both through Docker because the scoop toolchain lacks them; copy that.
- LIB-DEPEND-DIRECT: "Each direct third-party dependency MUST be properly validated, and each validation MUST be tracked." LIB-AUDIT: "The cargo-audit tool MUST be used to check for known vulnerabilities in dependencies." LIB-OUTDATED: "The cargo-outdated tool MUST be used to check the status of dependencies." Add `cargo outdated` to the weekly job next to `cargo audit`.
- LANG-ARITH: "When an arithmetic operation can produce an overflow, the usual operators MUST NOT be used directly. Instead, specialized methods such as checked_<op>, overflowing_<op>, wrapping_<op>, or saturating_<op>, or specialized wrapper types like Wrapping or Saturating, MUST be used." This is the `clippy::arithmetic_side_effects = "deny"` rule in section 4.
- LANG-LIMIT-PANIC: "A Rust function MUST NOT panic UNLESS its usage conditions have been violated." LANG-LIBRARY-PANIC: "Crates providing libraries should never use functions or instructions that can fail and cause the code to panic." LANG-UNWRAP-ASSERT: "Uses of unwrap, expect and assert! MUST be restricted to cases explicitly forbidden by the function's specification." LANG-ARRINDEXING: "Array indexing must be properly tested, or the get method SHOULD be used to return an Option." These are the `unwrap_used`, `expect_used`, `panic`, `indexing_slicing` denies in section 4.
- LANG-UB: "NO Undefined Behavior is allowed."
- LANG-UNSAFE-RESTRICT: unsafe blocks "SHOULD be avoided, or MUST be justified by at least one of the following points: FFI requirements, embedded device programming, or performance optimization." LANG-UNSAFE-FORBID: "With the exception of these cases, #![forbid(unsafe_code)] must appear in the crate root". LANG-UNSAFE-ENCAPSULATE: all unsafe code "MUST be encapsulated in such a way that either it exposes a safe behavior to the user, in which no safe interaction can result in UB; or it exposes features marked as unsafe whose usage conditions are exhaustively documented." Section 4's three audited crates map exactly onto the three permitted justifications: `zero-ffi` (FFI), `zero-simd` (performance, only with a benchmark), and nothing for embedded because the server never runs bare metal.
- MEM-LEAK: "NO memory leak is allowed." MEM-FORGET: `mem::forget` "MUST NOT be used." MEM-FORGET-LINT: "The lint mem_forget of Clippy SHOULD be used". MEM-BOX-LEAK: no leaks "in particular via Box::leak". MEM-RAWPTR-RECONSTRUCT and MEM-RAWPTR-FROM-RAW: every `into_raw` pointer "MUST eventually be transformed into a value with a call to the respective from_raw" and `from_raw` "MUST ONLY be called on into_rawed values". MEM-UNINIT: "Each usage of the std::mem::MaybeUninit type MUST be explicitly justified". Add `clippy::mem_forget = "deny"` workspace-wide; the FFI handle pattern (opaque `Box::into_raw` handed to the host, `Box::from_raw` in the destructor) already satisfies the raw pointer rules and pamoja's `pamoja_*_free` functions are the template.
- FFI rules that shape `zero-ffi`: FFI-C-COMPAT (only C-compatible types cross the boundary), FFI-PANIC ("Rust code called from FFI SHOULD either ensure the function cannot panic, or use a panic handling mechanism"; this is the `catch_unwind` requirement in section 9), FFI-ENUM-CHECK ("the Rust code MUST NOT accept incoming values of any Rust enum type"; status codes cross as `i32`), FFI-FUNCPTR-CHECK (function pointer types "MUST be marked extern (possibly with the specific ABI) and unsafe"), FFI-OPAQUE-RUST (opaque Rust types "SHOULD be translated as incomplete struct types and be provided with a dedicated constructor and destructor"), FFI-OWNERSHIP ("a single language is responsible for both allocation and deallocation"), FFI-DROP (no `Drop` on types passed by value), FFI-SAFEWRAPPING ("exposing a Rust library to a foreign language SHOULD only be done through a dedicated C-compatible API"), FFI-BINDING-GENERATION (generate bindings with tools; cbindgen as in pamoja).
- STD-SEND-SYNC: manual `Send`/`Sync` impls "SHOULD be avoided and, if necessary, MUST be justified and documented." Only `zero-ffi` may implement them, with a `// SAFETY:` comment.

The guide does not cover cargo-geiger, zeroization or constant-time comparison; those policies rest on the crate docs in sections 4 and 8.

### 12.2 Request smuggling definitions

The OWASP request smuggling cheat sheet and the WSTG chapters could not be fetched (every URL variant returned 404 or redirected to the site root; see section 15). The definitions below come from PortSwigger (https://portswigger.net/web-security/request-smuggling), which is outside the task's sanctioned source list, so they are cited for vocabulary only; the normative behavior is RFC 9112 6.3 (section 7).

- CL.TE: "the front-end server uses the Content-Length header and the back-end server uses the Transfer-Encoding header."
- TE.CL: "the front-end server uses the Transfer-Encoding header and the back-end server uses the Content-Length header."
- TE.TE: "the front-end and back-end servers both support the Transfer-Encoding header, but one of the servers can be induced not to process it by obfuscating the header in some way."
- Prevention (paraphrased from the same page): use HTTP/2 end to end and disable downgrading; have the front end normalize ambiguous requests and the back end reject any that remain ambiguous while closing the TCP connection; never assume a request has no body; drop the connection when a server-level exception occurs mid-request.

Zero core consequence: because the core may be either the front end (standalone) or the back end (behind nginx or a cloud load balancer), it takes the back-end rule in both roles: ambiguous framing is a 400 followed by connection close, and TE obfuscation (`Transfer-Encoding: xchunked`, ` chunked`, `chunked\r\n` with a tab, duplicate TE fields, TE in an obs-fold) is treated as unknown coding, which is also 400 plus close. Fuzz seeds for all three shapes are listed in section 6.

### 12.3 Node.js HTTP defaults, from source

Source: https://raw.githubusercontent.com/nodejs/node/main/lib/_http_server.js (main branch at fetch time) and https://raw.githubusercontent.com/nodejs/node/main/doc/api/cli.md.

- `this.requestTimeout = 300_000; // 5 minutes`
- `this.headersTimeout = MathMin(60_000, this.requestTimeout);`
- `this.keepAliveTimeout = 65_000; // 65 seconds;` with `this.keepAliveTimeoutBuffer = 1000;`
- `this.connectionsCheckingInterval = 30_000; // 30 seconds`
- `this.timeout = 0;` (socket inactivity timeout disabled), `this.maxHeadersCount = null;`, `this.maxRequestsPerSocket = 0;` (unlimited)
- `--max-http-header-size`: "Specify the maximum size, in bytes, of HTTP headers. Defaults to 16 KiB." History: "Change maximum default size of HTTP headers from 8 KiB to 16 KiB" in v13.13.0.

So the Node zero-server today inherits a 16 KiB total header cap, a 60 s headers timeout, a 300 s whole-request timeout and no cap on headers count or requests per socket. The zero core defaults in section 7 are tighter on every axis except header bytes (32 KiB, chosen to match the h2 `max_header_list_size` so that HTTP/1.1 and HTTP/2 accept the same requests). The 300 s `requestTimeout` is worth keeping as `request_total_timeout` for slow uploads on routes that raise `max_body`. The rendered docs page (https://nodejs.org/api/http.html) was truncated by the fetcher, so the released-version defaults are unverified; the main-branch source values above are what was read.

### 12.4 no_std attributes read from source

- httparse (https://raw.githubusercontent.com/seanmonstar/httparse/master/src/lib.rs): `#![cfg_attr(not(any(test, feature = "std")), no_std)]` and `#![deny(missing_docs, clippy::missing_safety_doc, clippy::undocumented_unsafe_blocks)]`. "Unsafe code is used to keep parsing fast, but unsafety is contained in a submodule, with invariants enforced." SIMD (SSE4.2, AVX2) is runtime detected. No built-in header count: `TooManyHeaders` is returned when the caller's slice is full, so the caller's slice length is the header cap. Fuzz targets (https://raw.githubusercontent.com/seanmonstar/httparse/master/fuzz/Cargo.toml): `parse_request`, `parse_chunk_size`, `parse_headers`, `parse_response`, `parse_response_multspaces`, `parse_request_multspaces`, all on `libfuzzer-sys = "0.4.0"`.
- bytes (https://raw.githubusercontent.com/tokio-rs/bytes/master/src/lib.rs): `#![no_std]`, `extern crate alloc;`, `#[cfg(feature = "std")] extern crate std;`. Confirmed no_std + alloc.
- hashbrown (https://raw.githubusercontent.com/rust-lang/hashbrown/master/README.md): "Compatible with #[no_std] (but requires a global allocator with the alloc crate)." Default hasher: "uses foldhash as the default hasher, which is much faster than SipHash. However, foldhash does not provide the same level of HashDoS resistance as SipHash." Features: `default-hasher` (on), `allocator-api2` (on), `equivalent` (on), `inline-more` (on), `nightly`, `rayon`, `serde`, `raw-entry`. Consequence: no attacker-keyed map (header names, query keys, cookie names, multipart field names) may use hashbrown's default hasher. The parsers store fields as `Vec<(Name, Value)>` bounded by `max_header_count` and scan linearly, which removes the hash-flooding surface entirely at 100 entries; if a map is ever needed it is `hashbrown::HashMap<K, V, S>` with a `BuildHasher` seeded from the std host (`RandomState` in `zero-net`), never `default-hasher`.
- rustls (https://raw.githubusercontent.com/rustls/rustls/main/rustls/src/lib.rs): `#![no_std]`, `extern crate alloc;`, `#![forbid(unsafe_code, unused_must_use)]`, `#![warn(missing_docs, clippy::exhaustive_enums, clippy::exhaustive_structs)]`. So the rustls crate root is unconditionally no_std with `alloc`, and the `std` feature adds the I/O layer described in section 2; the maintainers' README says only "While Rustls itself is platform independent, it requires the use of cryptography primitives" (https://github.com/rustls/rustls/blob/main/README.md). Whether the `Arc`-based session types need atomics on the target is still unverified (no source fetched states it).

### 12.5 h2 defaults, reset limits and CVE-2023-44487

h2 server Builder (https://docs.rs/h2/latest/h2/server/struct.Builder.html): `max_frame_size` "The default value is 16,384"; `initial_window_size` and `initial_connection_window_size` "The default value is 65,535"; `max_concurrent_streams` "It is recommended that this value be no smaller than 100"; `max_pending_accept_reset_streams` "The default value is currently 20, but could change"; `max_local_error_reset_streams` "The default value is currently 1024, but could change"; `max_concurrent_reset_streams` "The default value is currently 50"; `reset_stream_duration` "The default value is currently 1 second"; `max_send_buffer_size` "The default is currently ~400KB". h2 fuzz targets (https://raw.githubusercontent.com/hyperium/h2/master/fuzz/Cargo.toml): `fuzz_client`, `fuzz_hpack`, `fuzz_e2e`, with `libfuzzer-sys` (`arbitrary-derive`) and `arbitrary` (`derive`), which is the structure-aware pattern in section 6.

GHSA-qppj-fm5r-hxr3 (https://github.com/advisories/GHSA-qppj-fm5r-hxr3): "The client opens a large number of streams at once as in the standard HTTP/2 attack, but rather than waiting for a response to each request stream from the server or proxy, the client cancels each request immediately." "This creates an exploitable cost asymmetry between the server and the client." The referenced fix implements "a reset counter using a sliding window. This constrains the number of stream resets that may occur in a given window of time. Clients violating this limit will have their connections torn down."

Zero core h2 additions to the section 7 table: `max_pending_accept_reset_streams = 20`, `max_local_error_reset_streams = 1024`, `max_concurrent_reset_streams = 50`, `reset_stream_duration = 1 s` (all h2 defaults), plus a per-connection sliding-window counter of client-initiated RST_STREAM frames (`max_resets_per_window = 200` over `reset_window = 10 s`, unmeasured starting values) that closes the connection with GOAWAY ENHANCE_YOUR_CALM when exceeded. Also `max_send_buffer_size = 400 KiB` per connection, since it bounds memory on slow readers.

### 12.6 cargo-fuzz build options

Source: https://raw.githubusercontent.com/rust-fuzz/cargo-fuzz/main/src/options.rs. `sanitizer`: "Use a specific sanitizer", `#[arg(short, long, value_enum, default_value = "address")]`, variants `Address, Leak, Memory, Thread, None`. `release` (`-O`): "Build artifacts in release mode, with optimizations". `debug_assertions` (`-a`): "Build artifacts with debug assertions and overflow checks enabled". `build_std`: "Pass -Zbuild-std to Cargo, which will build the standard library with all build settings for the fuzz target, including debug assertions, and a sanitizer if requested." `careful_mode` (`-c`): "inspired by cargo-careful, this enables building the fuzzing harness with the standard library (implies --build-std)". `no_cfg_fuzzing`: "By default the 'cfg(fuzzing)' compilation configuration is set." The cargo-fuzz README (https://raw.githubusercontent.com/rust-fuzz/cargo-fuzz/main/README.md) says "libFuzzer needs LLVM sanitizer support, so this only works on x86-64 and Aarch64, and only on Unix-like operating systems (not Windows)", while the Rust Fuzz Book setup page (section 5) lists Windows via the MSVC AddressSanitizer; the two fetched statements disagree, so the fuzz jobs run on Linux and the Windows capability is unverified.

Standard invocation for the zero core: `cargo fuzz run <target> -O -a -s address -- -max_len=65536 -timeout=10 -rss_limit_mb=1024 -dict=fuzz/<target>.dict fuzz/corpus/<target>`, so optimized code runs with overflow checks and debug assertions on, matching the release profile in section 9. A weekly `-s thread` run covers the audited crates and a `--careful` run exercises the standard library's own debug assertions.

### 12.7 Cargo lints table semantics

https://doc.rust-lang.org/cargo/reference/workspaces.html: "The workspace.lints table is where you define lint configuration to be inherited by members of a workspace"; members opt in with `[lints] workspace = true`; respected as of Rust 1.74. https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section: tools `rust`, `clippy`, `rustdoc`; levels `forbid`, `deny`, `warn`, `allow`; `priority` is a signed integer where "lower (particularly negative) numbers have lower priority, being overridden by higher numbers, and show up first on the command-line"; "Cargo only applies these to the current package and not to dependencies", and "Cargo suppresses lints from non-path dependencies with features like --cap-lints". Consequence: the `[workspace.lints]` table in section 4 governs only zero core crates; dependencies are covered by cargo-geiger and cargo-deny instead. Because `forbid` cannot be relaxed by an inner `allow`, the audited crates cannot inherit the workspace table unchanged; they set `[lints] workspace = true` and then a package-level `[lints.rust] unsafe_code = "deny"` with a higher `priority` is not possible either (a package table replaces the workspace table rather than merging), so the audited crates carry their own full `[lints]` table copied from the workspace with the single `unsafe_code` line changed. A CI script diffs the two tables to keep them aligned.

## 13. Unverified

- Apache 2.4 defaults (LimitRequestFieldSize 8190, LimitRequestFields 100, LimitRequestLine 8190, Timeout 300, KeepAliveTimeout 5, MaxKeepAliveRequests 100): two fetches of httpd.apache.org/docs/2.4/mod/core.html were truncated before the directive sections; treat as unverified.
- Any claim that a specific safe Rust parser is faster or slower than Drogon: no measurement was run in this task.
- Whether `overflow-checks = true` costs measurable throughput on the parsers: unmeasured.
- Node.js released-version defaults: only the main-branch source was read (section 12.3); the docs page was truncated.
- Whether rustls without `std` needs atomic pointer support on the target: no fetched source states it.
- OWASP request smuggling text: not fetched (section 15); vocabulary comes from PortSwigger and the normative rules from RFC 9112.
- Windows support in cargo-fuzz: the README and the book disagree (section 12.6).
- The reset-window numbers in section 12.5 and the h3 limits in section 14.4 are starting values, not measurements.
- That wrk speaks only HTTP/1.1: its README says it embeds "the nginx/joyent/node.js 'http-parser'" and the TechEmpower `concurrency.sh` passes no HTTP/2 or HTTP/3 flags, but neither fetched source states the version explicitly.

## 14. HTTP/3 head start

Owner direction received during this run: the plan covers HTTP/1.1 and HTTP/2, and the owner wants HTTP/3 groundwork started. This section fixes the protocol facts, the Rust stack, the no_std boundary and the hardening limits so the h3 codec crates can be written in parallel with the HTTP/1.1 work without blocking the Drogon comparison.

### 14.1 Why it does not move the benchmark

The TechEmpower toolset drives every test with wrk: `wrk -H "Host: $server_host" -H "Accept: $accept" -H "Connection: keep-alive" --latency -d $duration -c $c --timeout 8 -t ... $url` (https://raw.githubusercontent.com/TechEmpower/FrameworkBenchmarks/master/toolset/wrk/concurrency.sh), with no HTTP/2 or HTTP/3 option, and wrk embeds "the nginx/joyent/node.js 'http-parser'" (https://raw.githubusercontent.com/wg/wrk/master/README.md). HTTP/3 is therefore a product feature for real users, not a lever on the "faster than Drogon" goal, and it must never be allowed to slow the HTTP/1.1 path (no shared abstraction that adds a dynamic dispatch to the h1 hot loop).

### 14.2 Protocol facts the design depends on

RFC 9114 (https://www.rfc-editor.org/rfc/rfc9114.html):

- Discovery (3.1): "An HTTP origin can advertise the availability of an equivalent HTTP/3 endpoint via the Alt-Svc HTTP response header field or the HTTP/2 ALTSVC frame using the "h3" ALPN token", for example `Alt-Svc: h3=":50781"`. So the HTTP/1.1 and HTTP/2 servers must be able to emit Alt-Svc, and the h3 listener is a separate UDP socket that can share the TCP port number or not.
- Connection (3.2): QUIC version 1, TLS 1.3, SNI required "unless an alternative mechanism" exists, ALPN "h3", and "each endpoint must send a SETTINGS frame as the initial frame on their HTTP control stream". Reuse (3.3): clients "should avoid opening multiple HTTP/3 connections to the same IP address and port combination".
- Settings (7.2.4.1): `SETTINGS_MAX_FIELD_SECTION_SIZE (0x06)` "The default value is unlimited"; HTTP/2 settings without an HTTP/3 equivalent MUST NOT be sent and their receipt is a connection error.
- Unidirectional streams (6.2): "endpoints MUST allow the peer to create at least three unidirectional streams" (control, QPACK encoder, QPACK decoder) and implementations "MUST NOT consider unknown stream types to be a connection error of any kind".
- Cancellation (4.1.1): `H3_REQUEST_REJECTED` means the request was not processed and can be retried safely; `H3_REQUEST_CANCELLED` means it may have been partially processed.
- Field size (4.2.2): "The size of a field list is calculated based on the uncompressed size of fields, including the length of the name and value in bytes plus an overhead of 32 bytes for each field", the same accounting as HTTP/2, so `max_header_list_size` in section 7 carries over unchanged.
- Security (10): "A server that receives a larger header section than it is willing to handle can send an HTTP 431 (Request Header Fields Too Large) status code" (10.5); pushed responses that are not cacheable "MUST NOT be stored by any HTTP cache" (10.4); 0-RTT early data requires settings compatibility checks (10.9); frame parsing must be strict (10.8). Section 10.5 also names limits on concurrent streams and field section size as the CPU and memory exhaustion controls.

RFC 9204 QPACK (https://www.rfc-editor.org/rfc/rfc9204.html): "QPACK mitigates, but does not completely prevent, attacks modeled on CRIME by forcing a guess to match an entire field line rather than individual characters"; never-indexed literals protect sensitive fields across hops (same policy as the HPACK rule for Authorization, Cookie and Set-Cookie in STANDARDS.md); "There is no currently known attack against a static Huffman encoding"; decoder memory is bounded by `SETTINGS_QPACK_MAX_TABLE_CAPACITY` and `SETTINGS_QPACK_BLOCKED_STREAMS`, both defaulting to 0, so "requiring explicit negotiation before dynamic table usage"; implementations "must establish maximum values for integer sizes and string literal lengths" and answer overruns with stream or connection errors.

RFC 9000 QUIC (https://www.rfc-editor.org/rfc/rfc9000.html): "A server MUST limit the total bytes it sends to the unvalidated address to no more than three times the number of bytes it receives from the client address" (the anti-amplification limit); Initial packets are at least 1200 bytes; Retry packets validate the client address before the server commits state; idle timeout: "The effective value of the idle timeout is the minimum of the two advertised values" and it should be at least three times the PTO; transport parameter defaults `max_udp_payload_size` 65527, `ack_delay_exponent` 3, `max_ack_delay` 25 ms, `active_connection_id_limit` 2; Section 21 covers Slowloris (21.6, idle timeout), stream fragmentation and reassembly (21.7, bounded by flow control), stream commitment (21.8, bounded by stream limits) and peer DoS (21.9).

RFC 9220 (https://www.rfc-editor.org/rfc/rfc9220.html): WebSocket over HTTP/3 uses Extended CONNECT with the `:protocol` pseudo-header, `SETTINGS_ENABLE_CONNECT_PROTOCOL` value 0x08 with default 0, "the semantics of the pseudo-header fields and setting are identical to those in HTTP/2", and an unknown `:protocol` "SHOULD respond to the request with a 501 (Not Implemented) status code". So the `zero-ws-codec` framing crate is reused unchanged over an h3 bidirectional stream, and the extended CONNECT handling is shared between h2 and h3.

### 14.3 Rust QUIC stack, with the std and no_std split

- quinn-proto (https://docs.rs/quinn-proto/latest/quinn_proto/, https://raw.githubusercontent.com/quinn-rs/quinn/main/quinn-proto/src/lib.rs, https://raw.githubusercontent.com/quinn-rs/quinn/main/quinn-proto/Cargo.toml): "a fully deterministic implementation of QUIC protocol logic. It contains no networking code and does not get any relevant timestamps from the operating system". Crate attributes are `#![cfg_attr(not(fuzzing), warn(missing_docs))]`, `#![warn(unreachable_pub)]`, `#![warn(clippy::use_self)]`; there is no `no_std` attribute and no `std` feature, so quinn-proto is a std crate that happens to do no I/O. Features: `default = ["rustls-ring", "tracing-log", "bloom"]`, `rustls-aws-lc-rs`, `platform-verifier`, `qlog`; docs.rs additionally lists `arbitrary` ("Adds arbitrary type generation support") and `aws-lc-rs-fips`. It depends on rustls for the TLS 1.3 handshake.
- quinn (https://docs.rs/quinn/latest/quinn/): "builds on top of quinn-proto, which implements protocol logic independent of any particular runtime"; `Runtime` trait with `TokioRuntime`, `AsyncStdRuntime`, `SmolRuntime` behind `runtime-tokio`, `runtime-async-std`, `runtime-smol`; `Endpoint`, connections, streams, datagrams, `ServerConfig`, `TransportConfig`. std.
- quinn-udp (https://docs.rs/quinn-udp/latest/quinn_udp/): "Uniform interface to send and receive UDP packets with advanced features useful for QUIC": `UdpSocketState`, `Transmit`, `RecvMeta`; "Segmentation offload for bulk send and receive operations, reducing CPU load" (GSO and GRO); ECN "required by QUIC to prevent packet loss and reduce latency on congested links when supported by the network path"; features "gracefully degrade" where the OS lacks them. std.
- h3 (https://docs.rs/h3/latest/h3/, https://raw.githubusercontent.com/hyperium/h3/master/README.md): "an HTTP/3 implementation that is generic over a provided QUIC transport" through the `h3::quic` traits; "The h3 crate is still very experimental. While the client and servers do work, there may still be bugs"; "Runtime independent (h3 does not spawn tasks and works with any runtime)"; backends quinn (h3-quinn), s2n-quic (s2n-quic-h3) and MsQuic (h3-msquic-async); "tested for interoperability and performance in the quic-interop-runner".
- s2n-quic-core (https://raw.githubusercontent.com/aws/s2n-quic/main/quic/s2n-quic-core/src/lib.rs, Cargo.toml): `#![cfg_attr(not(any(test, feature = "std")), no_std)]`, `extern crate alloc;`, features `default = ["alloc", "std"]`, `alloc = ["atomic-waker", "bytes", "crossbeam-utils", "s2n-codec/alloc"]`, `std = ["alloc", "once_cell"]`; modules include `frame`, `packet`, `varint`, `crypto`, `recovery`, `stream`, `transport`, `stateless_reset`, `token`. It is the one QUIC core in the ecosystem that is no_std by construction, which proves that QUIC frame and packet logic can live below the std line; it is "Internal crate used by s2n-quic" and therefore not a stable dependency.
- quiche (https://docs.rs/quiche/latest/quiche/): "The application is responsible for providing I/O (e.g. sockets handling) as well as an event loop with support for timers"; TLS through BoringSSL via the `boring` crate (`boringssl-boring-crate` feature); includes an `h3` module; no no_std statement; config setters `set_initial_max_streams_bidi`, `set_initial_max_data`, `set_max_idle_timeout`, `set_max_recv_udp_payload_size`. Its BoringSSL dependency is C, which conflicts with the memory-safe-core goal and the rustls-based TLS layer, so it is rejected.

Decision for the zero core:

- no_std + alloc, own crates, written now: `zero-h3-codec` (QUIC variable-length integers per RFC 9000 Section 16, HTTP/3 frame headers and payload parsing for DATA, HEADERS, SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, PUSH_PROMISE, unidirectional stream type classification with reserved-type tolerance) and `zero-qpack` (static table, static Huffman shared with `zero-hpack`, field section prefix, encoder and decoder instruction streams, dynamic table with capacity 0 unless negotiated). Both take byte slices and return values or `Err`; same lint set, same fuzz shape as section 6.
- std, adopted rather than written: `zero-quic` wraps quinn-proto and quinn-udp behind the tokio runtime already used by `zero-net`; rustls stays the single TLS implementation because quinn-proto depends on it. Writing a QUIC transport (loss recovery, congestion control, path validation, migration) in-house is not justified until the HTTP/1.1 and HTTP/2 goals are met; the s2n-quic-core layout is the reference if that day comes.
- h3 crate: not adopted as a dependency ("still very experimental") but used as the interop yardstick; the zero core's `zero-h3` std crate implements the request and response mapping over `zero-quic` streams using `zero-h3-codec` and `zero-qpack`, and runs the quic-interop-runner cases as conformance tests.
- Binding surface: the Node, Python and C# bindings see one `Request`/`Response` model; the transport (h1, h2, h3) is invisible above `zero-ffi`, which is why the codec crates must be transport-neutral from the start.

### 14.4 h3 hardening limits (starting values, configurable)

- Transport: `initial_max_streams_bidi = 100` (the h2 `max_concurrent_streams` analogue), `initial_max_streams_uni = 3` plus a small allowance for reserved types, `initial_max_data = 1 MiB`, per-stream data `256 KiB`, `max_idle_timeout = 30 s` (must exceed three times the PTO), `max_udp_payload_size = 1350` on receive to keep datagrams below common path MTU, Retry enabled under load (address validation before state), the 3x anti-amplification limit as implemented by quinn-proto, and stateless reset tokens so a restarted server can tear down stale peers.
- HTTP layer: `SETTINGS_MAX_FIELD_SECTION_SIZE = 32768` sent explicitly (the RFC default is unlimited), 431 on overrun; `SETTINGS_QPACK_MAX_TABLE_CAPACITY = 0` and `SETTINGS_QPACK_BLOCKED_STREAMS = 0` in the first release (no dynamic table means no encoder stream to attack and the lowest per-connection memory), raised to 4096 and 16 only after the QPACK fuzz corpus has run; QPACK integer cap 2^30 and string literal cap equal to `max_header_field`; never-indexed literals forced for Authorization, Cookie, Set-Cookie and any field a route marks secret.
- Reset abuse: a sliding-window count of client `RESET_STREAM` and `STOP_SENDING` frames per connection with the same threshold as the h2 rapid-reset counter (section 12.5), closing with `H3_EXCESSIVE_LOAD`.
- 0-RTT: off by default; when on, only idempotent methods are accepted in early data and the settings compatibility check of RFC 9114 10.9 runs before any early request is routed.
- Alt-Svc: emitted only when the h3 listener is actually bound, with `ma` bounded to the certificate lifetime.

### 14.5 Fuzz corpus additions

| Crate | Targets | Seeds and dictionary |
| --- | --- | --- |
| zero-h3-codec | `varint`, `frame`, `settings`, `stream_type`, `frame_sequence` (Arbitrary over a frame list) | RFC 9114 frame layouts, reserved frame and stream types (0x1f * N + 0x21), truncated lengths, 62-bit lengths, HTTP/2-only settings identifiers |
| zero-qpack | `field_section`, `encoder_instruction`, `decoder_instruction`, `huffman`, `roundtrip` | RFC 9204 Appendix B examples, capacity 0 references to the dynamic table, blocked-stream references beyond the limit, overlong integers |
| zero-quic (std) | `transport_sequence` using quinn-proto's `arbitrary` feature over packet sequences | quinn-proto's own fuzz seeds, amplification probes below 1200 bytes |

### 14.6 Sequence

1. Now, in parallel with the HTTP/1.1 codec: `zero-h3-codec` and `zero-qpack` as no_std crates with fuzz targets, plus the shared static Huffman table between HPACK and QPACK, and Alt-Svc emission in the h1 and h2 responders.
2. After HTTP/2 is conformant: `zero-quic` over quinn-proto and quinn-udp, `zero-h3` request mapping, extended CONNECT shared with h2 for WebSocket.
3. Before shipping h3: quic-interop-runner cases as conformance tests, the limit table above under load, and a self-run of the TechEmpower plaintext and JSON tests with an HTTP/3-capable client to publish numbers, clearly labeled as outside the official toolset.

## 15. Sources

Fetched in this task and used above (first pass, 2026-09-29, cited inline in sections 1 to 11; second pass, 2026-09-30, listed here):

- https://anssi-fr.github.io/rust-guide/ and https://anssi-fr.github.io/rust-guide/print.html
- https://portswigger.net/web-security/request-smuggling (outside the sanctioned list; vocabulary only)
- https://nodejs.org/api/http.html (truncated), https://raw.githubusercontent.com/nodejs/node/main/lib/_http_server.js, https://raw.githubusercontent.com/nodejs/node/main/doc/api/cli.md
- https://raw.githubusercontent.com/seanmonstar/httparse/master/src/lib.rs, https://raw.githubusercontent.com/seanmonstar/httparse/master/fuzz/Cargo.toml
- https://docs.rs/bytes/latest/bytes/, https://raw.githubusercontent.com/tokio-rs/bytes/master/src/lib.rs
- https://docs.rs/hashbrown/latest/hashbrown/, https://raw.githubusercontent.com/rust-lang/hashbrown/master/README.md
- https://github.com/rustls/rustls/blob/main/README.md, https://raw.githubusercontent.com/rustls/rustls/main/rustls/src/lib.rs
- https://docs.rs/h2/latest/h2/server/struct.Builder.html, https://raw.githubusercontent.com/hyperium/h2/master/fuzz/Cargo.toml
- https://github.com/advisories/GHSA-qppj-fm5r-hxr3
- https://rust-fuzz.github.io/book/cargo-fuzz/guide.html, https://raw.githubusercontent.com/rust-fuzz/cargo-fuzz/main/README.md, https://raw.githubusercontent.com/rust-fuzz/cargo-fuzz/main/src/options.rs
- https://doc.rust-lang.org/cargo/reference/workspaces.html, https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section
- https://httpd.apache.org/docs/2.4/mod/core.html (truncated, unusable)
- https://www.rfc-editor.org/rfc/rfc9114.html (sections 3, 4, 6, 7, 10), https://www.rfc-editor.org/rfc/rfc9000.html (sections 8, 10, 14, 18, 21), https://www.rfc-editor.org/rfc/rfc9204.html, https://www.rfc-editor.org/rfc/rfc9220.html
- https://docs.rs/quinn-proto/latest/quinn_proto/, https://docs.rs/crate/quinn-proto/latest/features, https://raw.githubusercontent.com/quinn-rs/quinn/main/quinn-proto/src/lib.rs, https://raw.githubusercontent.com/quinn-rs/quinn/main/quinn-proto/Cargo.toml
- https://docs.rs/quinn/latest/quinn/, https://docs.rs/quinn-udp/latest/quinn_udp/
- https://docs.rs/h3/latest/h3/, https://raw.githubusercontent.com/hyperium/h3/master/README.md
- https://docs.rs/quiche/latest/quiche/
- https://docs.rs/s2n-quic-core/latest/s2n_quic_core/, https://raw.githubusercontent.com/aws/s2n-quic/main/quic/s2n-quic-core/Cargo.toml, https://raw.githubusercontent.com/aws/s2n-quic/main/quic/s2n-quic-core/src/lib.rs
- https://raw.githubusercontent.com/TechEmpower/FrameworkBenchmarks/master/toolset/wrk/concurrency.sh, https://raw.githubusercontent.com/wg/wrk/master/README.md

Failed fetches (404, redirect to a site root, or listing not rendered):

- https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Request_Smuggling_Cheat_Sheet.html (404)
- https://owasp.org/www-project-web-security-testing-guide/latest/.../15-Testing_for_HTTP_Splitting_Smuggling and .../16-Testing_for_HTTP_Request_Smuggling (308 to https://wstg.owasp.org/latest/)
- https://wstg.owasp.org/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/15-... and 16-... (404)
- https://owasp.org/www-community/attacks/HTTP_Request_Smuggling (308 to community.owasp.org, which returned 404)
- https://raw.githubusercontent.com/OWASP/wstg/{master,main}/document/.../15-... and 16-... (404), https://raw.githubusercontent.com/OWASP/www-project-web-security-testing-guide/master/latest/.../16-... (404), the matching GitHub blob URL (404)
- https://anssi-fr.github.io/rust-guide/{03_libraries,04_language,10_recommendations}.html and https://raw.githubusercontent.com/ANSSI-FR/rust-guide/master/src/SUMMARY.md (404)
- https://raw.githubusercontent.com/TechEmpower/FrameworkBenchmarks/master/toolset/wrk/Dockerfile (404)
- https://github.com/hyperium/h2/tree/master/fuzz and https://github.com/seanmonstar/httparse/tree/master/fuzz (page loaded, directory listing not rendered; the Cargo.toml raw files were used instead)
