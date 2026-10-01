# HTTP/1.1, HTTP/2, HTTP/3, WebSocket, and SSE implementation strategy for the zero-server Rust core

Status: complete. Every claim below cites a source fetched during this task (2026-09-29 first run, re-fetched and verified 2026-09-30 on resume) or is marked unverified.

Companion notes in this folder: research-nostd-and-security.md (crate boundaries, unsafe policy, fuzzing), research-techempower.md (benchmark yardstick), research-tls-and-deps.md (rustls and provider choice), research-runtime-io.md (event loop), salvage-map.md (what transfers from the Node code base).

## 1. Sources fetched

Specifications:
- RFC 9110 HTTP Semantics (https://www.rfc-editor.org/rfc/rfc9110.html, https://httpwg.org/specs/rfc9110.html)
- RFC 9112 HTTP/1.1 (https://www.rfc-editor.org/rfc/rfc9112.html, https://httpwg.org/specs/rfc9112.html)
- RFC 9113 HTTP/2 (https://www.rfc-editor.org/rfc/rfc9113.html, https://httpwg.org/specs/rfc9113.html)
- RFC 7541 HPACK (https://www.rfc-editor.org/rfc/rfc7541.html)
- RFC 6455 WebSocket (https://www.rfc-editor.org/rfc/rfc6455.html)
- RFC 7692 WebSocket compression extensions (https://www.rfc-editor.org/rfc/rfc7692.html)
- RFC 8441 WebSocket over HTTP/2 (https://www.rfc-editor.org/rfc/rfc8441.html)
- RFC 9218 Extensible Priorities (https://www.rfc-editor.org/rfc/rfc9218.html)
- RFC 9000 QUIC (https://www.rfc-editor.org/rfc/rfc9000.html)
- RFC 9114 HTTP/3 (https://www.rfc-editor.org/rfc/rfc9114.html, https://httpwg.org/specs/rfc9114.html)
- RFC 9204 QPACK (https://www.rfc-editor.org/rfc/rfc9204.html)
- RFC 9220 WebSocket over HTTP/3 (https://www.rfc-editor.org/rfc/rfc9220.html)
- WHATWG HTML, Server-sent events (https://html.spec.whatwg.org/multipage/server-sent-events.html)

Rust language and toolchain:
- std::simd (https://doc.rust-lang.org/std/simd/index.html)
- core::arch (https://doc.rust-lang.org/core/arch/index.html)
- is_x86_feature_detected (https://doc.rust-lang.org/std/macro.is_x86_feature_detected.html)
- Rust 1.86.0 release notes, target_feature on safe functions (https://blog.rust-lang.org/2025/04/03/Rust-1.86.0/)

Crates (docs.rs unless noted):
- httparse 1.10.1 (docs.rs, GitHub README, src/simd/mod.rs, Cargo.toml)
- h2 0.4.19, hyper 1.11.1 and hyper::rt, hpack 0.3.0
- h3 0.0.8, h3-quinn 0.0.10, quinn-proto 0.11.18 on docs.rs and 0.12.0 in the main branch Cargo.toml, s2n-quic 1.89.0, cloudflare/quiche (GitHub), rustls::quic module
- memchr 2.8.3, simdutf8 0.1.5, cpufeatures 0.3.1, base64 0.23.1, sha1 0.11.0, sha1_smol 1.0.1, httpdate 1.0.3, itoa 1.0.18
- tokio-websockets 0.13.3, fastwebsockets (GitHub), embedded-websocket 0.9.5

Comparison targets:
- Drogon lib/src/HttpRequestParser.cc and lib/src/HttpResponseImpl.cc (raw.githubusercontent.com, drogonframework/drogon master)
- TechEmpower Framework Tests Overview wiki (https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Framework-Tests-Overview)
- Node.js CLI options (https://nodejs.org/api/cli.html) and API index for v26.10.0 (https://nodejs.org/docs/latest/api/index.html)

## 2. Normative rules the HTTP/1.1 layer must implement (RFC 9112, RFC 9110)

### 2.1 Message framing and smuggling defenses (RFC 9112 Sections 6.1, 6.3, 11.2)

Body length precedence, in the order the RFC lists it (Section 6.3):
1. HEAD responses and 1xx, 204, 304 responses: terminated by the first empty line after the header fields regardless of the header fields present.
2. 2xx to CONNECT: tunnel mode; client ignores Content-Length and Transfer-Encoding.
3. "If a message is received with both a Transfer-Encoding and a Content-Length header field, the Transfer-Encoding overrides the Content-Length."
4. "If a Transfer-Encoding header field is present and the chunked transfer coding is the final encoding, the message body length is determined by reading and decoding the chunked data until the transfer coding indicates the data is complete."
5. "If a Transfer-Encoding header field is present in a request and the chunked transfer coding is not the final encoding, the message body length cannot be determined reliably; the server MUST respond with the 400 (Bad Request) status code and then close the connection."
6. "If a message is received without Transfer-Encoding and with an invalid Content-Length header field, then the message framing is invalid and the recipient MUST treat it as an unrecoverable error, unless the field value can be successfully parsed as a comma-separated list, all values in the list are valid, and all values in the list are the same."
7. Valid Content-Length defines the length; a request with no length indicator has a zero-length body.

Section 6.1: "A server MAY reject a request that contains both Content-Length and Transfer-Encoding or process such a request in accordance with the Transfer-Encoding alone. Regardless, the server MUST close the connection after responding to such a request to avoid the potential attacks."

RFC 9110 Section 8.6: "a recipient MUST reject a message that contains multiple Content-Length field values with differing numeric values" and "a recipient MUST reject a message that contains a Content-Length field value that cannot be represented as a non-negative integer".

RFC 9112 Section 11.2 describes request smuggling as a technique that "exploits differences in protocol parsing among various recipients to hide additional requests within an apparently harmless request".

Decisions derived from these rules:
- Reject (400, then close) any request carrying both Transfer-Encoding and Content-Length. The RFC allows reject, and rejecting removes the CL.TE and TE.CL ambiguity entirely. Drogon does the same (Section 6.4 below).
- Reject any request Transfer-Encoding value other than exactly `chunked` (case-insensitive token compare, no parameters). This covers `chunked, gzip` style TE.TE shapes.
- Content-Length: digits only, no sign, no whitespace inside the digits, checked u64 parse (overflow is a 400), repeated fields allowed only when byte-identical after trimming OWS.
- Every framing rejection closes the connection; a rejected message is never parsed past the head.

### 2.2 Line and field syntax (RFC 9112 Sections 2.2, 3, 5.1, 5.2; RFC 9110 Sections 4.1, 5.5, 9.1)

- Whitespace between start-line and first header (Section 2.2): "A recipient that receives whitespace between the start-line and the first header field MUST either reject the message as invalid or consume each whitespace-preceded line without further processing." Decision: reject.
- Bare CR (Section 2.2): "A recipient of such a bare CR MUST consider that element to be invalid or replace each bare CR with SP before processing the element or forwarding the message." Decision: reject.
- Whitespace before the colon (Section 5.1): "A server MUST reject, with a response status code of 400 (Bad Request), any received request message that contains whitespace between a header field name and colon."
- obs-fold (Section 5.2): a server that receives an obs-fold in a request outside a message/http container "MUST either reject the message by sending a 400 (Bad Request)" or replace the fold with spaces. Decision: reject.
- Request-line (Section 3): "It is RECOMMENDED that all HTTP senders and recipients support, at a minimum, request-line lengths of 8000 octets." RFC 9110 Section 4.1 says the same for URIs and defines 414 for targets longer than the server will process. Decision: default request-line limit 8192 octets (configurable), 414 when only the target is too long, 400 otherwise.
- Malformed request-line (Section 3): "the server SHOULD respond with a 400 (Bad Request) response and close the connection."
- Host (Section 3.2): "A server MUST respond with a 400 (Bad Request) status code to any HTTP/1.1 request message that lacks a Host header field and to any request message that contains more than one Host header field line or a Host header field with an invalid field value."
- Field values (RFC 9110 Section 5.5): field-vchar = VCHAR / obs-text, obs-text = %x80-FF. "a recipient of CR, LF, or NUL within a field value MUST either reject the message or replace each of those characters with SP before further processing." Decision: reject.
- Method tokens are case-sensitive (RFC 9110 Section 9.1).
- Request-target forms: origin-form, absolute-form, authority-form (CONNECT only), asterisk-form (OPTIONS only); no whitespace allowed in the request-target.

### 2.3 Chunked coding (RFC 9112 Section 7.1)

Grammar: chunked-body = *chunk last-chunk trailer-section CRLF; chunk = chunk-size [chunk-ext] CRLF chunk-data CRLF. Recipients must "prevent parsing errors due to integer conversion overflows or precision loss due to integer representation" when reading hexadecimal chunk sizes. Decision: chunk-size parsing uses checked arithmetic with a hard cap of 16 hex digits and a configurable maximum chunk size; chunk extensions are validated and discarded with a length cap; trailers go through the same field-line validator as headers, are size-capped, and are exposed only when the caller opts in.

### 2.4 Persistence and pipelining (RFC 9112 Sections 9.3, 9.6)

- Persistent connections are the default in HTTP/1.1.
- "A server MUST read the entire request message body or close the connection after sending its response; otherwise, the remaining data on a persistent connection would be misinterpreted as the next request."
- "A server MAY process a sequence of pipelined requests in parallel if they all have safe methods, but it MUST send the corresponding responses in the same order that the requests were received."
- Tear-down (Section 9.6): the server performs a half-close by "closing only the write side of the read/write connection" and continues reading until the client closes.

### 2.5 Response serialization rules (RFC 9110)

- "An origin server SHOULD send a Date header field in all responses" (Section 6.6.1), in IMF-fixdate format, example "Sun, 06 Nov 1994 08:49:37 GMT" (Section 5.6.7).
- HEAD responses must not contain a body; 204 and 304 cannot contain a body.
- Server header is optional (Section 10.2.4).
- TechEmpower rules (wiki): "All test types require Server and Date HTTP response headers", "The response headers must include either Content-Length or Transfer-Encoding", plaintext body must be `Hello, World!`, "Server support for HTTP/1.1 pipelining is assumed", plaintext concurrency levels 256, 1024, 4096 and 16,384, JSON body `{"message":"Hello, World!"}` with Content-Type application/json and no gzip. The pipeline depth used by the load generator was not visible on the fetched page (unverified; commonly cited as 16).

## 3. HTTP/2 rules (RFC 9113) and HPACK rules (RFC 7541)

RFC 9113:
- Preface: the 24-octet sequence `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n` followed by a SETTINGS frame (Section 3.4).
- Frame header: 24-bit length, 8-bit type, 8-bit flags, 1 reserved bit, 31-bit stream identifier; stream 0 is the connection (Section 4.1).
- SETTINGS_MAX_FRAME_SIZE: range 2^14 (16,384) to 2^24-1 (16,777,215); 2^14 is the mandatory minimum (Section 4.2).
- SETTINGS identifiers and defaults: HEADER_TABLE_SIZE 0x1 (4,096), ENABLE_PUSH 0x2, MAX_CONCURRENT_STREAMS 0x3 (unlimited; should not fall below 100), INITIAL_WINDOW_SIZE 0x4 (65,535), MAX_FRAME_SIZE 0x5 (16,384), MAX_HEADER_LIST_SIZE 0x6 (advisory, counted as uncompressed name plus value length plus 32 per field).
- Flow control: initial window 65,535; maximum 2^31-1, exceeding it is FLOW_CONTROL_ERROR; only DATA frames consume credit (Section 6.9).
- Streams: client-initiated streams are odd, server-initiated even, identifiers increase monotonically and are never reused (Section 5.1.1).
- HEADERS without END_HEADERS must be followed by CONTINUATION frames on the same stream; anything else is a connection error (Section 4.3).
- Pseudo-headers :method, :scheme, :authority, :path; field names must be lowercase; connection-specific fields (Connection, Keep-Alive, Proxy-Connection, Transfer-Encoding, Upgrade) are forbidden, TE only with the value trailers (Sections 8.2.2, 8.3).
- Content-Length that does not match the total of DATA payloads makes the message malformed, PROTOCOL_ERROR (Section 8.1.1).
- Denial of service (Section 10.5): "SETTINGS frames, PING, PRIORITY, CONTINUATION, WINDOW_UPDATE, empty DATA frames" can be used to exhaust resources; the RFC recommends limits and the ENHANCE_YOUR_CALM error code.
- RFC 7540 priority signaling is deprecated (Section 5.3); RFC 9218 replaces it with the Priority header (u 0 to 7, default 3; i boolean) and PRIORITY_UPDATE frame type 0x10 for HTTP/2, plus SETTINGS_NO_RFC7540_PRIORITIES.
- TLS ALPN token h2; the h2c Upgrade path is deprecated; prior knowledge remains (Sections 3.1, 3.3).

RFC 7541 HPACK:
- Static table: 61 entries. Dynamic entry size: "the sum of its name's length in octets, its value's length in octets, and 32" (Section 4.1). Default table size 4,096; a size update "MUST occur at the beginning of the first header block following the change" (Sections 4.2, 6.3).
- Integers: "Integer encodings that exceed implementation limits -- in value or octet length -- MUST be treated as decoding errors" (Section 5.1).
- Huffman: padding longer than 7 bits or not matching the EOS prefix is a decoding error (Section 5.2).
- Representations: indexed `1`, literal with incremental indexing `01`, literal without indexing `0000`, literal never indexed `0001` (Section 6.2). Intermediaries must not re-encode never-indexed literals with an indexed form (Section 7.1.3).
- Security: the decoder bounds memory through SETTINGS_HEADER_TABLE_SIZE (Section 7.3); compression attacks are mitigated because an attacker must guess whole values (Section 7.1).

## 4. WebSocket rules (RFC 6455, RFC 7692, RFC 8441, RFC 9220)

RFC 6455:
- Handshake: Sec-WebSocket-Accept is built "by concatenating /key/ ... with the string '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', taking the SHA-1 hash of this concatenated value to obtain a 20-byte value and base64-encoding this 20-byte hash" (Section 4.2.2).
- Frame: FIN, RSV1-3, 4-bit opcode, MASK bit, payload length 7 bits, or 126 plus 16 bits, or 127 plus 64 bits; "the minimal number of bytes MUST be used to encode the length" (Section 5.2).
- Masking: "The server MUST close the connection upon receiving a frame that is not masked"; transformed-octet-i = original-octet-i XOR masking-key-octet-(i mod 4) (Sections 5.1, 5.3).
- Fragmentation: "The fragments of one message MUST NOT be interleaved between the fragments of another message unless an extension has been negotiated"; control frames may be injected between fragments (Section 5.4).
- "All control frames MUST have a payload length of 125 bytes or less and MUST NOT be fragmented" (Section 5.5). Close carries a 2-byte network-order status code plus an optional UTF-8 reason.
- Text frames must be valid UTF-8; invalid UTF-8 fails the connection (Section 8.1).
- Opcodes: 0x0 continuation, 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong.

RFC 7692 permessage-deflate: parameters server_no_context_takeover, client_no_context_takeover, server_max_window_bits, client_max_window_bits (8 to 15); "This document allocates the RSV1 bit of the WebSocket header for PMCEs and calls the bit the 'Per-Message Compressed' bit"; the sender removes the trailing 4 octets 0x00 0x00 0xff 0xff of the DEFLATE output; "There is a known exploit when history-based compression is combined with a secure transport."

RFC 8441: SETTINGS_ENABLE_CONNECT_PROTOCOL (value 0 or 1); Extended CONNECT with the :protocol pseudo-header; for WebSocket, :protocol is websocket, :scheme is https or http, :path and :authority carry the URI, sec-websocket-version stays, and "Implementations using this extended CONNECT to bootstrap WebSockets do not do the processing of the Sec-WebSocket-Key and Sec-WebSocket-Accept header fields". END_STREAM stands in for an orderly TCP close and RST_STREAM with CANCEL for an abrupt one.

RFC 9220: the same mechanism over HTTP/3 with SETTINGS_ENABLE_CONNECT_PROTOCOL identifier 0x08 (default 0); orderly close is the stream FIN, abrupt close is H3_REQUEST_CANCELLED.

## 5. SSE rules (WHATWG HTML)

- MIME type text/event-stream; the client fails the connection when the status is not 200 or the Content-Type is wrong.
- Stream grammar: optional BOM then events; line endings CRLF, LF, or CR; fields event, data, id, retry; lines starting with `:` are comments. "If value starts with a U+0020 SPACE character, remove it from value."
- data: each data line appends value plus LF; on dispatch the trailing LF is removed; "if the data buffer is an empty string, set the data buffer and the event type buffer to the empty string and return" (no event dispatched).
- id is ignored when it contains U+0000; retry accepts ASCII digits only.
- Reconnection: the client sends Last-Event-ID; a 204 response stops reconnection attempts.
- Authors should "include a comment line (one starting with a ':' character) every 15 seconds or so" to defeat proxy idle timeouts; "HTTP chunking can have unexpected negative effects on the reliability of this protocol" when the chunking layer is unaware of event timing.
- Streams are always UTF-8.

## 6. Crate and comparison-target survey (verified on resume)

### 6.1 httparse 1.10.1
- "A push library for parsing HTTP/1.x requests and responses" with a focus on "speed and safety"; README: "Avoids allocations. No copy. Fast." and "Works with no_std, simply disable the std Cargo feature."
- Cargo.toml: features default = ["std"], std; no dependencies; edition 2021; rust-version 1.59; license "MIT OR Apache-2.0". 714 GitHub stars.
- API: caller-owned `[httparse::EMPTY_HEADER; 64]`, `Request::new(&mut headers)`, `parse(buf)` returns `Status::Complete(usize)` or `Status::Partial`; `ParserConfig` for lenient modes; `Error` variants; `parse_chunk_size`.
- SIMD selection (src/simd/mod.rs): SWAR is the portable fallback; SSE4.2 and AVX2 paths are selected at compile time under `target_feature = "sse4.2"` and `target_feature = "avx2"`; NEON under `target_arch = "aarch64", target_feature = "neon"`; runtime detection exists only under `feature = "std"` and only when neither x86 feature is set at compile time. Under no_std without target features the parser runs SWAR with no runtime dispatch. The SIMD paths accelerate the request-target scan and the header-value scan.
- httparse parses only the message head; framing decisions (Content-Length versus Transfer-Encoding, Host validation, smuggling rejections) are the caller's job.

### 6.2 h2 0.4.19, hyper 1.11.1, hpack 0.3.0
- h2: "An asynchronous, HTTP/2 server and client implementation"; requires tokio ^1; also depends on bytes, http, indexmap, slab, tracing, tokio-util, futures-core, futures-sink, atomic-waker, fnv; no no_std support; MIT. Decoupled from TCP and TLS, so ALPN is the caller's job. Its HPACK codec is internal.
- hyper: "a lower-level HTTP library, meant to be a building block"; features http1, http2, client, server, ffi (unstable); hyper::rt traits Read, Write, Executor, Timer, Sleep make it runtime-agnostic ("By abstracting over async runtimes, hyper can work with different executors, timers, and IO transports"); depends on h2 ^0.4.14 and httparse ^1.9; MIT; no no_std.
- hpack 0.3.0 (mlalic/hpack-rs): standalone HPACK crate; no no_std statement; maintenance status not shown.

### 6.3 Helper crates
- memchr 2.8.3: "designed from the ground up to be usable in core-only contexts"; features std, alloc (default); SSE2 available without std, AVX2 needs the std runtime detection; NEON on aarch64; memmem module; Unlicense OR MIT.
- simdutf8 0.1.5: "Blazingly fast API-compatible UTF-8 validation for Rust using SIMD extensions, based on the implementation from simdjson"; no_std via --no-default-features; SSE4.2, AVX2, NEON, SIMD128 backends; x86 runtime selection uses std::is_x86_feature_detected!, aarch64 and wasm select at compile time; MIT OR Apache-2.0.
- cpufeatures 0.3.1: an alternative to "the std-dependent is_x86_feature_detected! macro"; x86 and x86_64 detection is OS-independent and no_std-friendly (40+ features); aarch64 detection only on Linux, iOS and macOS; the `new!` macro yields an `InitToken` that caches the result; depends on libc; Apache-2.0 OR MIT.
- base64 0.23.1: no_std with the alloc feature; `Engine::encode_slice` and `Engine::decode_slice` write into caller buffers without allocation; simd-unsafe feature (default) adds SIMD engines; MIT OR Apache-2.0.
- sha1 0.11.0 (RustCrypto): depends on digest, cpufeatures, cfg-if; hardware acceleration via cpufeatures; Apache-2.0 OR MIT. The fetched page does not state no_std (unverified from this fetch; the crate family is generally no_std, unverified).
- sha1_smol 1.0.1: "A minimal implementation of SHA1 for rust"; no_std by default with an optional std feature; no required dependencies; BSD-3-Clause.
- httpdate 1.0.3: IMF-fixdate formatting and parsing on top of `SystemTime`, so it requires std; no dependencies; MIT OR Apache-2.0.
- itoa 1.0.18: "Fast conversion of integer primitives to decimal strings" with a stack `Buffer`; no_std status not stated on the fetched page (unverified).

### 6.4 Drogon comparison target
- HttpRequestParser.cc: byte-at-a-time state machine (kExpectMethod, kExpectRequestLine, kExpectHeaders, kExpectBody, kExpectChunkLen, kExpectChunkBody, kExpectLastEmptyChunk, kGotAll); lines via `buf->findCRLF()`; request line split with `std::find` on spaces; version check `end - start == 8 && std::equal(start, end - 1, "HTTP/1.")`; Content-Length via `std::stoull` in a try/catch (400 on failure); chunk size via `strtol(len.c_str(), &end, 16)`; rejects a request with both Content-Length and Transfer-Encoding (`if (!len.empty() && !encode.empty()) { return -k400BadRequest; }`); limits: method 7 bytes, URI 64 KB (414), header 64 KB (400), body from getClientMaxBodySize (413); no SIMD; pipelining through a `requestPipelining_` deque with `popReadyResponses()` popping consecutive completed responses.
- HttpResponseImpl.cc: `makeHeaderString()` builds the status line with `snprintf(... "HTTP/1.1 %d ", statusCode_)` and appends headers; `fullHeaderString_` caches rendered headers; when `expriedTime_ >= 0` the whole rendered response is cached in `httpString_` and only the Date bytes are patched: `memcpy((void *)&(*httpString_)[datePos_], newDate, httpFullDateStringLength)` when the second changes; the Server header is appended from `getServerHeaderString()` when enabled.

### 6.5 WebSocket crates
- tokio-websockets 0.13.3: "High performance, strict, tokio-util based WebSockets implementation"; SIMD masking on x86_64 (SSE2, AVX2, AVX512) and aarch64; UTF-8 validation via simdutf8; SHA-1 backends ring, aws-lc-rs, openssl, sha1_smol; "passes the Autobahn test suite without relaxations by default"; tokio-bound; MIT.
- fastwebsockets (Deno): RFC 6455, "Passes the Autobahn|TestSuite", "fuzzed with LLVM's libfuzzer", raw frame mode plus FragmentCollector, HTTP upgrade via hyper; tokio-bound; Apache-2.0.
- embedded-websocket 0.9.5: no_std framing for clients and servers over caller-owned buffers, "arbitrarily small buffers regardless of websocket frame size"; depends on base64, byteorder, httparse, sha1, heapless, rand_core, futures; about 51 percent documented; MIT OR Apache-2.0.

### 6.6 Rust SIMD facilities
- std::simd: "This is a nightly-only experimental API. (portable_simd #86656)". Not usable on a stable toolchain.
- core::arch is part of core and therefore available in no_std; stable modules x86, x86_64, aarch64, wasm32; `#[target_feature]` enables a feature for one function; the docs still describe the unsafe requirement for the attribute.
- Rust 1.86.0 stabilized `#[target_feature]` on safe functions: "Safe functions marked with the target feature attribute can only be safely called from other functions marked with the target feature attribute"; elsewhere the call needs an unsafe block with the caller guaranteeing the feature is present; such functions cannot be passed where `Fn*` bounds are required and coerce to function pointers only inside target_feature functions.
- `is_x86_feature_detected!` is provided by std, relies mostly on cpuid, and has no core equivalent on the fetched page.

### 6.7 QUIC and HTTP/3 crates
- quinn-proto: "Low-level protocol logic for the QUIC protocol", "a fully deterministic implementation of QUIC protocol logic" with no networking code; `Endpoint` and `Connection` state machines driven by `handle_event` and `poll_transmit`; docs.rs latest is 0.11.18, the main branch Cargo.toml is 0.12.0; TLS through rustls with ring or aws-lc-rs (features rustls-ring default, rustls-aws-lc-rs, aws-lc-rs-fips, platform-verifier, qlog, bloom); other deps bytes, slab, tinyvec (alloc), lru-slab, rustc-hash, rand, thiserror, tracing; MIT OR Apache-2.0; no no_std statement.
- h3 0.0.8: "HTTP/3 client and server"; modules client, server, quic (transport traits), error, ext; depends on tokio ^1, http ^1, bytes ^1, futures-util, pin-project-lite, fastrand; MIT; pre-release version line. h3-quinn 0.0.10 implements the h3 quic traits over quinn ^0.11.7 with tokio.
- quiche (Cloudflare): Rust, BSD-2-Clause, BoringSSL handshake via boring-sys, needs cmake and on Windows also NASM; caller-owned sockets with recv/send; RFC 9000 and RFC 9114; includes an HTTP/3 module; used at the Cloudflare edge, in Android's DNS resolver and curl.
- s2n-quic 1.89.0: IETF QUIC, TLS via s2n-tls or rustls, s2n-tls on Windows only with the GNU/MinGW toolchain (rustls recommended for MSVC), tokio required, no HTTP/3 layer mentioned, Apache-2.0.
- rustls::quic: "APIs for implementing QUIC TLS": ClientConnection, ServerConnection, Keys, DirectionalKeys, PacketKeySet, Secrets, Version (V1, V2), Suite for initial keys, PacketKey and HeaderProtectionKey traits.

### 6.8 Node.js status relevant to the bindings
- Node CLI docs: `--experimental-quic`, added in v25.0.0, stability 1.1 (active development), "Enable experimental support for the QUIC protocol"; no HTTP/3 mention.
- The v26.10.0 API index lists HTTP, HTTP/2 and HTTPS modules and no QUIC or HTTP/3 module; https://nodejs.org/api/quic.html returned 404.

## 7. Decisions per layer: in-house versus crate

Decision rule applied throughout: a protocol codec goes in-house when (a) the maintained crate is bound to tokio or std, which blocks the no_std, sans-I/O core and the three language bindings, or (b) the security-relevant framing rules are outside the crate anyway. A crate is adopted when it is zero-dependency, no_std, and covers exactly one narrow primitive whose reimplementation adds risk without adding control.

| Layer | Decision | Reason |
|---|---|---|
| HTTP/1.1 head parser | In-house `zero-http1-codec`, httparse as the differential oracle in tests and behind a `parser-httparse` feature during bring-up | httparse's runtime SIMD dispatch requires its std feature; under no_std it degrades to SWAR unless target features are fixed at compile time. The core needs runtime dispatch without std (cpufeatures), one-pass validation that emits the exact RFC 9112 rejection reasons, and a conformance-vector format shared with the bindings. httparse stays as the oracle because it is fuzzed and zero-dependency. |
| HTTP/1.1 framing, chunked coding, Host and smuggling rules | In-house | No crate provides them; hyper implements them privately. Rules are enumerated in Section 2. |
| Response serialization | In-house | Trivial code, and the cached Date plus precomputed header blocks need control of the write path. |
| Date formatting | In-house IMF-fixdate formatter from a caller-supplied unix timestamp | httpdate needs SystemTime (std). A civil-from-days conversion is a few dozen lines and is no_std. |
| Integer to decimal | In-house 20-byte stack formatter or itoa | itoa's no_std status was not confirmed on the fetched page; the in-house version is trivial and avoids a dependency. |
| Byte scanning | memchr (no_std, SSE2 baseline without std) or in-house SWAR | memchr is core-only capable, but its AVX2 path needs std for detection; the parser's own SIMD scanner covers the hot paths (Section 8), so memchr is optional and used only for CRLF search in the chunked and SSE decoders if profiling shows a win. |
| HTTP/2 framing, stream state, flow control | In-house `zero-h2-codec` (sans-I/O) | h2 requires tokio and is std-only, which blocks the no_std core and the binding model. h2 (as a client) and the hyper stack become the interoperability test peers. |
| HPACK | In-house inside `zero-h2-codec` | h2's HPACK is internal; the hpack crate has no no_std statement and unknown maintenance. The static table (61 entries), integer coding, Huffman table and dynamic table are fully specified and easy to vector-test. |
| WebSocket framing, masking, UTF-8 | In-house `zero-ws-codec` (no_std), simdutf8 for UTF-8 validation (no_std build) | tokio-websockets and fastwebsockets are tokio-bound; embedded-websocket is no_std but drags httparse, base64, sha1, heapless and futures and is half documented. Framing is small; masking is an XOR loop that the SIMD module covers. |
| WebSocket handshake hash and base64 | sha1_smol (no_std, no deps) or RustCrypto sha1; base64 with encode_slice | SHA-1 here is a protocol checksum, not a security primitive (RFC 6455 handshake), so the minimal crate is acceptable; the audited `zero-crypto` crate (research-nostd-and-security.md) may instead expose SHA-1 so the codec has one hashing dependency. |
| permessage-deflate | Behind a feature in the std layer, deferred | Needs a DEFLATE implementation with context takeover control; RFC 7692 documents the compression-plus-TLS exploit class. Default off. The DEFLATE crate choice is unverified in this task. |
| SSE | In-house encoder (no_std) and decoder for the client side | The format is a dozen rules (Section 5); no crate is justified. |
| HTTP/3 framing and QPACK | In-house `zero-h3-codec` (sans-I/O, no_std), initially static-table-only QPACK | Section 14. |
| QUIC transport | quinn-proto in the std runtime crate; no in-house QUIC | Section 14. |

## 8. HTTP/1.1 parser design

### 8.1 Shape
- Input: a caller-owned byte buffer; output: a `RequestHead<'buf>` of byte-range indices (method, target, version, N header name and value ranges) plus a `consumed` count, or `Partial`, or `Reject { status, reason, close: true }`. No allocation; the header table is a caller-owned fixed array like httparse's `EMPTY_HEADER` array (default 64 entries, hard limit configurable, excess is 431).
- The parser is a pure function of bytes: no clock, no I/O, no global state, so it is no_std and directly fuzzable; every malformed input returns `Reject`, never panics (clippy `indexing_slicing`, `arithmetic_side_effects`, `unwrap_used` at deny, per research-nostd-and-security.md).
- Two entry points: `parse_head` and a resumable `ChunkedDecoder` state machine (`chunk_size`, `chunk_data`, `chunk_crlf`, `trailers`, `done`) that consumes from the read buffer and reports body byte ranges without copying.

### 8.2 SIMD acceleration
- Facility: explicit `core::arch` intrinsics on stable Rust, never std::simd (nightly-only). Kernels are safe functions annotated `#[target_feature(enable = "avx2")]` and `#[target_feature(enable = "sse4.2")]` (stable since Rust 1.86); the single unsafe call site is the dispatcher that checks a cached detection token, satisfying the "caller guarantees the feature" rule.
- Detection: `cpufeatures::new!` on x86 and x86_64 (no_std, cpuid based, result cached in an InitToken). On aarch64 the NEON kernel is selected at compile time under `target_feature = "neon"` exactly as httparse does; cpufeatures' aarch64 detection is OS-specific and is not needed for NEON. Everything else uses the SWAR fallback.
- Kernels (mirroring the two scans httparse accelerates): (1) request-target scan for bytes outside the allowed set (0x21 to 0x7E excluding `?`-agnostic delimiters, SP, CTL, DEL); (2) header-value scan for bytes outside field-vchar plus SP and HTAB (rejects CR, LF, NUL, other CTLs early); (3) header-name scan for token characters and the colon; (4) CRLF search for chunk-size lines. Each kernel processes 32 bytes per AVX2 iteration, 16 per SSE4.2 or NEON iteration, and 8 per SWAR word, then hands the tail to the scalar path.
- Expected gain over Drogon: Drogon scans one byte at a time with `std::find` and `std::equal` (Section 6.4). Any measured speedup is unverified until the benchmark harness in research-techempower.md runs; the design claim is only that the parser does strictly less work per byte.
- Case-insensitive header-name matching for the few names the framing layer needs (host, content-length, transfer-encoding, connection, upgrade, expect) uses length-switch then a 64-bit OR-0x20 compare on 8-byte words, no allocation and no lowercase copy.

### 8.3 Limits (defaults, all configurable)
- Request-line 8,192 octets (RFC recommends supporting at least 8,000); headers 64 headers and 64 KiB total head; chunk-ext 256 octets; trailers 8 KiB; chunk size 16 hex digits and a per-message body limit enforced by the runtime; Expect: 100-continue handled by the runtime after head validation.

## 9. Response serialization

- Status lines: a compile-time table of `HTTP/1.1 NNN Reason\r\n` byte strings for every registered code; unknown codes fall back to `HTTP/1.1 NNN \r\n` written with the integer formatter.
- Date header: one 37-byte block `Date: Ddd, DD Mmm YYYY HH:MM:SS GMT\r\n` per worker, refreshed once per second by the runtime's timer wheel from the monotonic-to-wall clock mapping; the codec receives the bytes and copies them. This is the same idea as Drogon's `datePos_` memcpy patch but without a per-response second check on the hot path: the runtime updates the block, and every response written in that second copies the current one.
- Precomputed header blocks: a route or static asset can pre-render its fixed headers (`Server`, `Content-Type`, `Cache-Control`, `ETag`) once into an immutable byte block; per-response output is then status line, Date block, precomputed block, `Content-Length: N\r\n\r\n`, body. `Content-Length` is formatted from an integer without allocation.
- Write path: the codec appends into the connection's write buffer; the std runtime issues one vectored write per event loop turn (body slices are not copied when they are large, they are passed as separate iovecs). Bodies of unknown length use chunked coding; SSE and streaming responses flush per event.
- HEAD, 204, 304 and 1xx never carry a body; the serializer enforces it regardless of what the handler returns. Hop-by-hop fields are stripped before HTTP/2 or HTTP/3 emission.

## 10. Pipelining

- The read loop parses as many complete heads as the buffer holds. Each parsed request gets a sequence number; a per-connection in-order response queue (a small ring buffer, like Drogon's deque) emits responses strictly in request order as required by RFC 9112 Section 9.3.
- Handlers may run concurrently only for safe methods (GET, HEAD, OPTIONS, TRACE); a request with an unsafe method waits for all earlier responses to complete before it starts, which keeps the RFC 9112 Section 9.3 constraint and preserves observable ordering for writes.
- Responses completed out of order stay in their slot until the head of the queue completes; when the head completes, all consecutive ready slots are written in one vectored write.
- A rejection anywhere in the pipeline (400, 431, 414) marks the connection `close`, the queue drains the already-accepted responses, and the remaining input is discarded.
- The runtime must read the entire request body or close (RFC 9112 Section 9.3): after a handler finishes without consuming its body, the runtime drains up to a configurable byte budget and closes above it.
- Pipeline depth is capped (default 32 in-flight heads per connection) to bound memory; excess input stays unread in the socket buffer, which also applies TCP back pressure.

## 11. HTTP/2 design

- `zero-h2-codec` is a sans-I/O connection state machine: `recv(&[u8]) -> events`, `send(...) -> bytes into a caller buffer`, `poll_timeout`, and stream tables keyed by the 31-bit id. Frame decoding, HPACK, stream states (idle, open, half-closed local and remote, closed), flow control accounting (connection and per stream, windows bounded at 2^31-1), settings validation, CONTINUATION accumulation and GOAWAY logic all live there. The std runtime crate owns the socket, TLS with ALPN h2, and timers.
- HPACK: static table of 61 entries, dynamic table as a ring of (name, value) slices over an arena bounded by the negotiated size, entry cost name + value + 32, decoder integer limits (value fits in u32, at most 10 continuation octets, otherwise decoding error), Huffman decoder from a generated table with the padding rules in Section 3, encoder that never indexes Cookie, Authorization, Set-Cookie and any field the handler marks sensitive (RFC 7541 Section 7.1.3), size updates emitted at the start of the next header block.
- Denial-of-service limits from RFC 9113 Section 10.5, all configurable: max header list size (default 16 KiB; exceeding it is 431 on the stream, or connection error while in CONTINUATION), max CONTINUATION frames per header block, per-connection budgets for SETTINGS, PING, WINDOW_UPDATE, PRIORITY, empty DATA and RST_STREAM per unit time with ENHANCE_YOUR_CALM on breach (the RST_STREAM budget addresses the rapid reset attack class; that name is unverified in this task), max concurrent streams default 100, and a cap on streams the peer created but has not completed.
- Priorities: RFC 7540 priority frames are accepted and ignored; RFC 9218 Priority header and PRIORITY_UPDATE (type 0x10) are parsed into (urgency, incremental) and used by the response scheduler; SETTINGS_NO_RFC7540_PRIORITIES is advertised as 1.
- Extended CONNECT (RFC 8441) is advertised so WebSocket runs on an HTTP/2 stream; the WebSocket codec is transport-agnostic and takes a stream abstraction (TCP after 101, or an HTTP/2 stream after a 200 to Extended CONNECT).
- h2c via Upgrade is not implemented (deprecated in RFC 9113); prior-knowledge cleartext HTTP/2 is supported for internal and gRPC use because the existing Node product exposes gRPC over `app.listen({http2:true})` (salvage-map.md).
- Testing: interoperability against the h2 crate and hyper as clients (dev-dependencies only), plus the RFC 9113 and RFC 7541 examples as conformance vectors. h2spec as an external conformance tool is unverified in this task.

## 12. WebSocket design

- Handshake validation in the HTTP/1.1 layer: method GET, Upgrade token websocket, Connection includes Upgrade, Sec-WebSocket-Version 13, Sec-WebSocket-Key decodes to 16 bytes, Origin policy hook. Accept value computed with SHA-1 over key plus the GUID and written via base64 `encode_slice` into a 28-byte stack buffer.
- Frame decoder over a caller buffer: header (2 to 14 bytes), minimal-length rule enforced on receive (a 124-byte payload encoded with the 126 form is a protocol error, matching the RFC's example), RSV bits must be zero unless permessage-deflate was negotiated, control frames must be unfragmented and at most 125 bytes, unmasked client frames close the connection with 1002, fragment interleaving is rejected, the close body is 0 or 2 or more bytes with a validated status code and UTF-8 reason, and text messages are validated as UTF-8 across fragments (streaming validation keeps the incomplete code point across frame boundaries).
- Masking: XOR of the 4-byte key replicated to 32 bytes and applied with the same SIMD dispatcher as the HTTP parser (AVX2, SSE2, NEON, SWAR); tokio-websockets does the same on x86_64 and aarch64. Unmasking happens in place in the read buffer so message delivery is zero-copy.
- Server frames are never masked. Ping is answered with a Pong carrying the same payload; unsolicited Pongs are ignored; close is answered with a mirrored close and then the runtime half-closes.
- Limits: max message size (default 16 MiB), max fragments per message, control frame flood budget.
- Rooms, broadcast, and pools stay in the host binding layer or the std core (salvage-map.md lists `WebSocketPool`, rooms and `SSEStream` as reusable API shapes); the three bugs recorded in the Node audit (head bytes lost after upgrade, continuation frames dropped, write after close) become conformance vectors for the new codec.
- permessage-deflate: default off, feature gated, per-connection window and context takeover parameters honored, and disabled automatically for messages the application marks as secret-bearing.

## 13. SSE design

- Encoder (no_std): `event:`, `id:`, `retry:` and one `data:` line per LF-separated line in the payload, terminated by a blank line; ids containing NUL are rejected at the API; the encoder writes UTF-8 only.
- Transport rules: Content-Type text/event-stream, status 200, `Cache-Control: no-store`, no compression, and over HTTP/1.1 either `Connection: close` with an unframed body or chunked coding with one chunk per event and an immediate flush (the WHATWG warning about chunking applies to layers that buffer; the runtime flushes per event, so chunk boundaries coincide with event boundaries). Over HTTP/2 each event is a DATA frame.
- Keep-alive: the runtime writes a `:` comment line every 15 seconds by default (WHATWG author guidance) unless an event was sent in the interval; Last-Event-ID is exposed to the handler on reconnect; a 204 tells a client to stop reconnecting.
- A client-side decoder for the bindings' fetch client implements the same field rules and line-ending handling.

## 14. HTTP/3 head start

What the specifications require (all fetched):
- QUIC (RFC 9000) runs over UDP, is typically implemented in user space, provides bidirectional and unidirectional streams with per-stream and connection-level flow control, connection IDs and client-only migration, a 3x amplification limit before address validation, and a 1,200-byte minimum datagram.
- HTTP/3 (RFC 9114) uses ALPN h3, is advertised from HTTP/1.1 and HTTP/2 responses with Alt-Svc, maps each request to its own client-initiated bidirectional stream (stream 0, then 4, 8, and so on), and uses unidirectional streams: control 0x00 (first frame must be SETTINGS), push 0x01, QPACK encoder 0x02 and decoder 0x03. Frames: DATA 0x00, HEADERS 0x01, CANCEL_PUSH 0x03, SETTINGS 0x04, PUSH_PROMISE 0x05, GOAWAY 0x06, MAX_PUSH_ID 0x07. Field names are lowercase; connection-specific fields are forbidden (TE only with trailers). SETTINGS_MAX_FIELD_SECTION_SIZE 0x06 defaults to unlimited. Endpoints must allow at least 100 concurrent request streams and grant at least 1,024 bytes of credit to unidirectional streams.
- QPACK (RFC 9204): 99 static entries, 0-based indexing; SETTINGS_QPACK_MAX_TABLE_CAPACITY and SETTINGS_QPACK_BLOCKED_STREAMS both default to zero, and with zero capacity "compression relies entirely on the static table", which removes head-of-line blocking and the encoder and decoder stream logic.
- WebSocket over HTTP/3 (RFC 9220) reuses Extended CONNECT with setting 0x08.
- Priorities (RFC 9218) reuse the same Priority header, with PRIORITY_UPDATE types 0xF0700 and 0xF0701 in HTTP/3.

Strategy:
1. Do not write QUIC in-house. QUIC carries loss recovery, congestion control, path validation, migration, key updates and anti-amplification state; quinn-proto already ships exactly that as a deterministic, runtime-free state machine over rustls, which matches the TLS choice in research-tls-and-deps.md and the sans-I/O style of the rest of the core. It lives in the std runtime crate, driven by the same UDP socket and timer facilities. quiche is excluded because it builds BoringSSL through cmake (plus NASM on Windows), which conflicts with the pure-Rust, cargo-deny-audited build; s2n-quic is excluded because it requires tokio and its s2n-tls provider builds on Windows only with MinGW.
2. Write `zero-h3-codec` now as a no_std sans-I/O layer, because it shares almost everything with `zero-h2-codec`: varint framing, the field semantics rules, the same request and response types, and the same limits. Start with QPACK in static-only mode (advertise capacity 0 and blocked streams 0, which the RFC defaults to); dynamic QPACK is a later addition behind the same API.
3. Keep the h3 crate out of the product: it is 0.0.8, depends on tokio, and its transport traits would pull the runtime into the codec. Use h3 with h3-quinn as the interoperability test client, alongside curl.
4. Advertise `Alt-Svc: h3=":443"; ma=86400` from the HTTP/1.1 and HTTP/2 servers once the UDP listener is up; the binding API exposes a single `listen` with `http3: true` so the Node, Python and C# surfaces do not change shape.
5. Product angle verified from Node's own docs: Node v26.10.0 has no QUIC or HTTP/3 module in its API index and only an experimental `--experimental-quic` flag (stability 1.1, added in v25.0.0). A Rust core that serves HTTP/3 through the Node binding therefore offers something the platform itself does not.
6. Version note: quinn-proto docs.rs latest is 0.11.18 while the main branch Cargo.toml reads 0.12.0; pin the released line and track the 0.12 release before choosing the rustls provider feature (rustls-ring default, rustls-aws-lc-rs for FIPS).
7. Unverified performance items that need measurement rather than citation: UDP GSO and GRO batching, per-packet crypto cost, and whether HTTP/3 improves any TechEmpower-style number (the TechEmpower tests are HTTP/1.1 with pipelining, so HTTP/3 is a product feature, not a benchmark lever).

## 15. What no_std can cover

no_std plus alloc (byte slices in, byte slices or plain values out, no clock, socket, thread or event queue):
- `zero-http1-codec`: head parser, field validation, chunked decoder and encoder, framing decisions, status line table, response serializer into a caller buffer, IMF-fixdate formatter from a u64 unix timestamp, integer formatter. No alloc needed for the parser itself; alloc only for owned header copies when a binding asks for them.
- `zero-h2-codec`: frame codec, HPACK, stream state machine, flow control accounting, settings, priority parsing. Needs alloc for the dynamic table arena and stream map (hashbrown per research-nostd-and-security.md).
- `zero-h3-codec`: HTTP/3 frames, QPACK static mode, stream type demux, settings.
- `zero-ws-codec`: handshake computation, frame codec, masking, UTF-8 validation (simdutf8 built without std selects kernels at compile time), close code validation.
- `zero-sse`: encoder and decoder.
- `zero-simd`: the dispatch token and the AVX2, SSE4.2, SSE2, NEON and SWAR kernels; x86 detection via cpufeatures (no_std, cpuid), aarch64 NEON at compile time.

std only:
- Sockets, TLS I/O (rustls unbuffered API can be no_std but the handshake needs a time provider and the socket is std), timers and the once-per-second Date refresh, thread-per-core workers, the pipelining queue's async handler execution, the response scheduler, SSE keep-alive timers, permessage-deflate, quinn-proto and the UDP path, Alt-Svc advertisement, runtime metrics.

Rule for proving it: each no_std crate is built in CI for a target without std (research-nostd-and-security.md, Section 3) because `#![no_std]` alone does not prevent std from being linked through a dependency.

## 16. Risks and open items

- Writing HTTP/2 in-house is the largest scope item on this list and the most attack-exposed; the RFC 9113 Section 10.5 budgets, conformance vectors from the RFC examples, differential tests against h2 and hyper, and libFuzzer targets on the frame and HPACK decoders are the mitigation. Until those pass, the std runtime can expose an `h2-crate` feature that swaps in h2 for HTTP/2 only (std builds only).
- The in-house HTTP/1.1 parser is a security surface; httparse remains wired in as a differential oracle, and every rejection in Section 2 becomes a fuzz dictionary entry and a conformance vector.
- SIMD kernels are the only unsafe-adjacent code in the codecs (target_feature dispatch); keep them in `zero-simd` with Miri and sanitizer runs, and keep the SWAR path as the reference implementation that every kernel is property-tested against.
- The pipeline depth used by the TechEmpower load generator and any speedup number over Drogon are unverified until measured with the harness described in research-techempower.md.
- cpufeatures depends on libc; if the dependency budget rejects that, the x86 detection can be reimplemented over `core::arch::x86_64::__cpuid` (availability in core is unverified in this task).
- The DEFLATE crate for permessage-deflate and the h2spec conformance tool were not fetched; both are unverified.
- QPACK dynamic table support, HTTP/3 server push (deferred like HTTP/2 push, which salvage-map.md drops), and 0-RTT request replay policy are deferred; 0-RTT should stay disabled for non-idempotent methods, which is a policy choice rather than a fetched rule (unverified against RFC 9114 text in this task).
