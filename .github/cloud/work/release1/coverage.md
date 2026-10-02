# Release 1: measured test coverage

Measured 2026-10-02 between 19:41 and 19:55 UTC on the working tree at `e13e631` plus the
uncommitted changes listed under "In flux", in the `zero-server-lint` container on the owner's
machine (14 CPUs given to Docker, kernel 6.18.33 WSL2), with
`--security-opt seccomp=unconfined` so the io-compio backend ran on io_uring.

## Summary

- Production code (inline `#[cfg(test)]` modules and test-only files removed): **92.15 % of
  lines** (13,708 of 14,876) and **90.33 % of regions** (22,778 of 25,216) across the 27
  release 1 library crates. 164 production functions never ran.
- llvm-cov's own figure, which counts the inline test modules as covered code: 94.79 % lines,
  94.07 % regions, 93.76 % functions (the raw summary is at the end of this file).
- 629 tests in the release 1 library crates (527 unit, 87 integration, 15 doctests), all
  passing; xtask adds 122 (11 ignored) and zero-bench 8. The io-compio reruns add 21 (zero-io)
  and 51 (zero-http), the accept-handoff rerun 46.
- The codecs are in good shape: zero-http1 96.4 %, zero-qpack 98.5 %, zero-h3 97.6 %, zero-ws
  98.2 %, zero-sse 98.3 %, zero-simd 97.9 %, zero-http-types 98.9 %.
- The weak layer is everything that carries bytes rather than parsing them: zero-tls 79.9 %,
  zero-io 84.8 %, zero-realtime 86.7 %, zero-serve 86.4 %, zero-http 90.9 %. The request path
  has untested branches that real networks hit every day (a head split across two reads, a
  malformed chunked body reaching the driver).
- 17 gaps below; the binding work in DESIGN-12-13 already plans the zero-host, zero-ffi, loom,
  slot-recycle sanitizer and Node tests, and those are listed as planned, not as gaps.

## Tooling (fetched live)

- cargo-llvm-cov **0.9.1**: `https://crates.io/api/v1/crates/cargo-llvm-cov`, fetched
  2026-10-02: `max_stable_version` 0.9.1, published 2026-09-06, not yanked, `rust_version` 1.87,
  repository `https://github.com/taiki-e/cargo-llvm-cov`. Installed into the `zero-core-cargo`
  volume with `cargo install --locked cargo-llvm-cov --version 0.9.1`.
- Documentation read at the pinned tag:
  `https://raw.githubusercontent.com/taiki-e/cargo-llvm-cov/v0.9.1/README.md` (2026-10-02): the
  merge procedure (`--no-report` passes then `report`), and the default ignore list, which drops
  `tests/`, `examples/` and `benches/` directories and `*tests.rs` files from the report.
- `rustup component add llvm-tools-preview` installed `llvm-tools-x86_64-unknown-linux-gnu` on
  the stable channel `rust-toolchain.toml` selects, which resolved to rustc 1.99.0 (b940084d7
  2026-09-28) and cargo 1.99.0 in the `zero-core-rustup` volume.
- The RFC sections cited below were checked against the texts fetched from
  `https://www.rfc-editor.org/rfc/rfc<n>.txt` on 2026-10-02 for RFC 9110, 9112, 3986, 4648,
  6455 and 7239.
- Scripts: `target/cov-audit-run.sh`, `target/cov-audit-report.sh`, `target/cov-audit-full.sh`,
  `target/cov-audit-doctest.sh`; outputs in `target/cov-audit-out/` (logs, `merged.lcov`,
  `merged-summary.json`, `merged-full.json`); `CARGO_TARGET_DIR=/work/target/cov-audit`.

## Method

The five passes mirror what CI's `rust` and `seam` jobs run on Linux:

1. `cargo llvm-cov --no-report --workspace --no-fail-fast` (158 s, every test passed)
2. `cargo llvm-cov --no-report -p zero-io --no-default-features --features io-compio`
3. `cargo llvm-cov --no-report -p zero-http --features io-compio`
4. `ZERO_TEST_HANDOFF=1 cargo llvm-cov --no-report -p zero-io -p zero-http --test echo --test driver --test routing --test no_alloc`
5. `cargo llvm-cov --no-report -p zero-bench --features io-compio`

Report: `cargo llvm-cov report --ignore-filename-regex 'crates/(xtask|zero-bench|zero-examples)/'`
(text, `--json --summary-only`, `--lcov`, and the full `--json` export for per-function
regions). Their tests still ran; only their files leave the report. The io-compio backend ran on
io_uring: the `zero-server` binary built in pass 5 printed
`zero-server listening on 0.0.0.0:8080 with 1 core(s) (io-compio on io_uring)`.

Production-only figures: lines come from the lcov `DA` records, regions from the code regions of
the full export (deduplicated across instantiations, best count kept); a line or region is
dropped when it sits between a `#[cfg(test)]` (or `#[cfg(all(test, ...))]`) attribute and the
closing brace of the item it gates, or in a test-only file (`zero-h3/src/xorshift.rs`,
`zero-qpack/src/xorshift.rs`, `zero-simd/src/test_support.rs`, `zero-http1/src/no_alloc.rs`).

Limits of the measurement:

- Linux only. Windows and macOS code paths (`SO_EXCLUSIVEADDRUSE`, `SetThreadAffinityMask`,
  the Ctrl+C path, zero-static's `cfg!(windows)` rules) are not in these numbers.
- Doctests are not instrumented (`--doctests` is nightly only); they were run separately and
  counted (15 in the library crates, all pass).
- Branch coverage is nightly only and was not measured.
- zero-ffi's merged figure is an artifact: its `#[no_mangle]` exports keep one symbol name in
  the two feature builds (pass 1 and pass 5), so the profile merge drops counts on the hash
  mismatch. Its default-pass figure is used (11 of 12 raw lines).
- One lcov counter wrapped to 18446744073709551609 (non-atomic counters under threads); it was
  treated as executed.
- Two line bases: llvm-cov's summary counts 27,317 lines (1,422 missed), while the lcov `DA`
  records hold 26,531 distinct physical lines (1,282 missed; 95.17 %). The difference is
  consistent with the summary counting the lines of closures and async blocks once more inside
  their enclosing function: `zero-http/src/server.rs` has `LF:169` against 161 `DA` records and
  eight nested function spans in the full export (among them the two `map_err` closures at
  lines 250-263). The production figures use the `DA` basis; the "Raw" columns and the raw
  summary use llvm-cov's.
- A few unexecuted "functions" are `Debug::fmt` impls, `Default` impls and a `const fn` used
  only in constant evaluation (`zero-qpack/src/table.rs:26`); they are listed but are not gaps.

## Per crate

Prod = production code only. Raw = llvm-cov's figure including inline test modules. Tests are
from pass 1; doctests from `cargo test --workspace --doc`. Randomized = a deterministic
in-crate generator drives inputs (no crate uses proptest). Miri and ASan/TSan = the crate is in
that `ci.yml` job. A `*` marks a fuzz target that is untracked in git (added by the
binding-foundation workflow, in flux).

| Crate | Prod lines | Missed | Line % | Prod regions | Missed | Region % | Raw line % | Raw region % | Unexecuted fns | Unit tests | Integration tests | Doctests | Randomized | Miri | ASan/TSan | Fuzz targets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| zero-ffi (placeholder) | 5 | see note | see note | 9 | see note | see note | 91.67 | 95.24 | 1 | 1 | 0 | 0 | no | yes | yes | none |
| zero-tls | 1060 | 213 | 79.91 | 1953 | 463 | 76.29 | 84.77 | 83.60 | 32 | 19 | 12 | 0 | no | no | no | tls_hello* |
| zero-io | 1771 | 269 | 84.81 | 2892 | 521 | 81.98 | 85.53 | 83.73 | 44 | 10 | 10 | 0 | no | no | no | none |
| zero-serve | 464 | 63 | 86.42 | 767 | 95 | 87.61 | 89.19 | 90.08 | 6 | 12 | 10 | 0 | no | no | no | none |
| zero-realtime | 437 | 58 | 86.73 | 761 | 112 | 85.28 | 86.09 | 85.02 | 12 | 0 | 10 | 0 | no | no | no | none |
| zero-base64 | 177 | 19 | 89.27 | 365 | 38 | 89.59 | 92.58 | 92.79 | 2 | 4 | 0 | 0 | no | yes | no | base64_decode* |
| zero-router | 440 | 45 | 89.77 | 682 | 63 | 90.76 | 91.73 | 93.51 | 11 | 12 | 0 | 0 | no | yes | no | router_resolve |
| zero-static | 620 | 59 | 90.48 | 1183 | 124 | 89.52 | 94.53 | 93.68 | 5 | 18 | 0 | 0 | no | no | no | none |
| zero-http | 1795 | 164 | 90.86 | 2829 | 299 | 89.43 | 90.14 | 89.58 | 20 | 8 | 43 | 0 | no | no | no | none |
| zero-rt | 395 | 34 | 91.39 | 600 | 60 | 90.00 | 94.35 | 94.56 | 6 | 15 | 0 | 0 | no | no | yes | none |
| zero-core | 247 | 21 | 91.50 | 320 | 33 | 89.69 | 95.06 | 94.35 | 3 | 26 | 0 | 2 | no | no | no | none |
| zero-sys | 620 | 38 | 93.87 | 1057 | 88 | 91.67 | 96.16 | 95.56 | 6 | 36 | 0 | 1 | no | yes (18 syscall tests ignored) | no | cmsg_decode |
| zero-uri | 255 | 15 | 94.12 | 492 | 28 | 94.31 | 95.54 | 95.71 | 2 | 5 | 0 | 0 | no | yes | no | uri_normalize |
| zero-policy | 781 | 35 | 95.52 | 1386 | 95 | 93.15 | 96.89 | 95.49 | 3 | 31 | 0 | 0 | no | no | no | forwarded_parse*, cors_fields* |
| zero-json | 555 | 24 | 95.68 | 926 | 61 | 93.41 | 96.12 | 93.43 | 5 | 13 | 2 | 0 | no | yes | no | json_parse |
| zero-http1 | 921 | 33 | 96.42 | 1606 | 61 | 96.20 | 97.51 | 96.96 | 3 | 38 | 0 | 1 | no | yes | no | http1_head, http1_chunked |
| zero-mime | 308 | 8 | 97.40 | 617 | 33 | 94.65 | 97.87 | 96.20 | 0 | 7 | 0 | 0 | no | yes | no | mime_parse* |
| zero-h3 | 915 | 22 | 97.60 | 1378 | 48 | 96.52 | 99.09 | 98.84 | 0 | 88 | 0 | 2 | yes | yes | no | h3_frames, h3_settings, h3_streams, h3_capsules |
| zero-simd | 475 | 10 | 97.89 | 891 | 22 | 97.53 | 98.33 | 98.11 | 0 | 21 | 0 | 1 | yes | yes | no | simd_kernels, utf8_validate |
| zero-ws | 510 | 9 | 98.24 | 825 | 16 | 98.06 | 98.54 | 98.65 | 1 | 23 | 0 | 0 | no | yes | no | ws_frames*, ws_session* |
| zero-sse | 233 | 4 | 98.28 | 414 | 5 | 98.79 | 99.12 | 99.35 | 0 | 10 | 0 | 0 | no | yes | no | sse_decode* |
| zero-qpack | 987 | 15 | 98.48 | 1629 | 41 | 97.48 | 99.21 | 98.80 | 1 | 69 | 0 | 1 | yes | yes | no | qpack_field_section, qpack_instructions, qpack_huffman, qpack_primitives |
| zero-http-types | 359 | 4 | 98.89 | 541 | 14 | 97.41 | 99.43 | 98.70 | 0 | 27 | 0 | 1 | no | yes | no | none (reached through http1_head) |
| zero-date | 337 | 2 | 99.41 | 817 | 110 | 86.54 | 98.25 | 90.54 | 0 | 20 | 0 | 1 | no | yes | no | none |
| zero-limits | 88 | 0 | 100.00 | 64 | 0 | 100.00 | 100.00 | 100.00 | 0 | 4 | 0 | 1 | no | no | no | none |
| zero-server-crypto | 49 | 0 | 100.00 | 82 | 2 | 97.56 | 99.14 | 99.16 | 1 | 6 | 0 | 3 | no | no | no | none |
| zero-qs | 72 | 0 | 100.00 | 130 | 0 | 100.00 | 100.00 | 100.00 | 0 | 4 | 0 | 0 | no | yes | no | qs_parse |
| zero-server (bundle, re-exports) | 0 | 0 | n/a | 0 | 0 | n/a | n/a | n/a | 0 | 0 | 0 | 1 | no | no | no | none |
| zero-host (placeholder) | 0 | 0 | n/a | 0 | 0 | n/a | n/a | n/a | 0 | 0 | 0 | 0 | no | no | no | none |
| **total** | **14876** | **1168** | **92.15** | **25216** | **2438** | **90.33** | **94.79** | **94.07** | **164** | **527** | **87** | **15** | | | | |

Notes: zero-ffi's default pass measures 11 of 12 raw lines; it is the 63-line `zero_version`
placeholder that WP-9 replaces. zero-date's region figure (86.5 %) sits far below its line
figure because the no_std lint table forces checked arithmetic, and the `?` on each checked
step adds a region that never fails on valid calendar input; that is expected, not a gap. Test
counts by binary: zero-http unit 8, `tests/driver.rs` 34, `tests/routing.rs` 8,
`tests/no_alloc.rs` 1; zero-io unit 10, `echo` 3, `datagram` 6, `cancel` 1; zero-tls unit 19,
`tests/driver.rs` 12; zero-realtime `tests/realtime.rs` 10; zero-serve unit 12, `tests/serve.rs`
10; zero-json unit 13, `tests/suite.rs` 2.

## The 30 least covered files that matter

Production lines only, files with at least 10 such lines, zero-ffi and zero-limits left out.
By missed lines the order differs: `zero-tls/src/unbuffered.rs` 82, `zero-http/src/conn.rs` 81
(91.4 %, the largest absolute gap on the request path), `zero-serve/src/lib.rs` 63,
`zero-tls/src/buffered.rs` 61, `zero-io/src/compio_rt/tcp.rs` 49, `zero-static/src/files.rs` 48,
`zero-router/src/lib.rs` 45.

| # | File | Prod lines | Missed | Line % | Prod regions | Missed | Region % | Area |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `zero-io/src/tokio_rt/tcp.rs` | 77 | 39 | 49.4 | 132 | 62 | 53.0 | runtime seam |
| 2 | `zero-core/src/error.rs` | 12 | 5 | 58.3 | 27 | 12 | 55.6 | error model (Display arms) |
| 3 | `zero-tls/src/buffered.rs` | 192 | 61 | 68.2 | 386 | 137 | 64.5 | TLS |
| 4 | `zero-io/src/tokio_rt/listen.rs` | 41 | 13 | 68.3 | 86 | 27 | 68.6 | runtime seam |
| 5 | `zero-io/src/compio_rt/tcp.rs` | 161 | 49 | 69.6 | 301 | 98 | 67.4 | runtime seam |
| 6 | `zero-tls/src/unbuffered.rs` | 306 | 82 | 73.2 | 553 | 151 | 72.7 | TLS |
| 7 | `zero-io/src/compio_rt/udp.rs` | 81 | 21 | 74.1 | 143 | 42 | 70.6 | runtime seam |
| 8 | `zero-tls/src/accept.rs` | 160 | 37 | 76.9 | 299 | 74 | 75.3 | TLS |
| 9 | `zero-io/src/compio_rt/listen.rs` | 125 | 27 | 78.4 | 201 | 55 | 72.6 | runtime seam |
| 10 | `zero-sys/src/random.rs` | 28 | 6 | 78.6 | 48 | 7 | 85.4 | system calls |
| 11 | `zero-tls/src/outbox.rs` | 29 | 6 | 79.3 | 49 | 15 | 69.4 | TLS |
| 12 | `zero-io/src/tokio_rt/udp.rs` | 76 | 15 | 80.3 | 133 | 32 | 75.9 | runtime seam |
| 13 | `zero-realtime/src/sse.rs` | 114 | 21 | 81.6 | 202 | 42 | 79.2 | realtime |
| 14 | `zero-static/src/files.rs` | 304 | 48 | 84.2 | 587 | 96 | 83.6 | static files, path policy |
| 15 | `zero-http/src/takeover.rs` | 52 | 8 | 84.6 | 58 | 14 | 75.9 | request path (upgrade) |
| 16 | `zero-tls/src/config.rs` | 48 | 7 | 85.4 | 54 | 9 | 83.3 | TLS |
| 17 | `zero-realtime/src/websocket.rs` | 188 | 27 | 85.6 | 350 | 49 | 86.0 | realtime |
| 18 | `zero-http/src/server.rs` | 161 | 23 | 85.7 | 230 | 38 | 83.5 | request path (accept loop) |
| 19 | `zero-io/src/compio_rt/worker.rs` | 213 | 30 | 85.9 | 323 | 48 | 85.1 | runtime seam |
| 20 | `zero-serve/src/lib.rs` | 461 | 63 | 86.3 | 762 | 95 | 87.5 | the `zero` binary |
| 21 | `zero-qpack/src/table.rs` | 23 | 3 | 87.0 | 34 | 3 | 91.2 | artifact: `const fn` used in const evaluation |
| 22 | `zero-io/src/date.rs` | 39 | 5 | 87.2 | 65 | 8 | 87.7 | runtime seam |
| 23 | `zero-core/src/value.rs` | 89 | 11 | 87.6 | 104 | 12 | 88.5 | value model |
| 24 | `zero-io/src/net.rs` | 146 | 17 | 88.4 | 226 | 59 | 73.9 | runtime seam (socket options) |
| 25 | `zero-sys/src/fs.rs` | 26 | 3 | 88.5 | 46 | 5 | 89.1 | system calls (`open_nofollow`) |
| 26 | `zero-base64/src/lib.rs` | 177 | 19 | 89.3 | 365 | 38 | 89.6 | parser |
| 27 | `zero-h3/src/error.rs` | 196 | 21 | 89.3 | 251 | 23 | 90.8 | parser (error labels) |
| 28 | `zero-rt/src/arena.rs` | 112 | 12 | 89.3 | 220 | 21 | 90.5 | runtime |
| 29 | `zero-rt/src/worker.rs` | 86 | 9 | 89.5 | 115 | 15 | 87.0 | runtime |
| 30 | `zero-sys/src/signal.rs` | 67 | 7 | 89.6 | 99 | 13 | 86.9 | system calls |

## Weakest crates: public functions and error paths with no test

Line numbers are in the working tree as measured. Debug and Default impls are left out.

### zero-tls (79.9 %)

- The `zero_io::Stream` methods other than `read_leased`, `writev` and `close_write` never run
  on any TLS stream: `readable`, `read_into`, `write`, `shutdown_write`, `peer_addr` on
  `TlsStream` (`accept.rs:79`, `93`, `100`, `114`, `128`), `BufferedStream` (`buffered.rs:172`,
  `207`, `240`, `277`, `288`) and `UnbufferedStream` (`unbuffered.rs:349`, `370`, `386`, `418`,
  `433`). The HTTP driver calls only the three, so any other consumer of the seam (zero-host's
  tier 3 path, a takeover over TLS) runs untested code.
- `Acceptor::in_progress()` (`accept.rs:230`), the per-core handshake count, is never read.
- Refusals at the listener: a client hello larger than one handshake message (`accept.rs:148`),
  the hello reader's refusal and the `missing_extension` refusal (`accept.rs:243`, `254-258`;
  reached today only by the `tls_hello` fuzz target, which compiles `hello.rs` alone), a pool
  with no budget during the handshake (`accept.rs:155`, `buffered.rs:87-88`,
  `unbuffered.rs:139-140`), end of stream mid-handshake (`unbuffered.rs:131`).
- Configuration branches: a TLS 1.3-only version set (`config.rs:127`), tickets off with
  `NoServerSessionStorage` (`config.rs:140`), the ticket lifetime over `MAX_TICKET_LIFETIME`
  refusal (`config.rs:147-150`), `Driver::Unbuffered` as the chosen default (`config.rs:65`),
  limits that allow no handshake (`lib.rs:93-96`).
- The unbuffered driver's record buffer growth on `InsufficientSize` for encode and encrypt
  (`unbuffered.rs:452-459`, `481-488`), the `ReadEarlyData` arm that discards 0-RTT records
  (`unbuffered.rs:181-188`; unreachable while early data is off, so either test it with early
  data offered or delete it), and the outbox's partial-write requeue (`outbox.rs:64-68`).
- Identity loading errors: a PEM with no certificate (`identity.rs:68-70`), unreadable chain or
  key files (`identity.rs:127-129`).

### zero-io (84.8 %)

- `Stream::readable`, `Stream::read_into` and `Stream::peer_addr` never run on either backend
  (`tokio_rt/tcp.rs:48`, `81-119`, `139`; `compio_rt/tcp.rs:221`, `248-268`, `312`), although
  the seam traits are the frozen public interface of R.3 step 4.
- `zero_io::rt::driver()` on both backends (`tokio_rt/mod.rs:33`, `compio_rt/executor.rs:373`),
  `Core::count()`, `Core::pinned()`, `Core::live_tasks()` (both backends) and
  `Core::is_io_uring()` (compio), `UdpSocket::set_tos()` (both backends), compio
  `TcpStream::local_addr()`.
- Listener and accept errors: the transient-error backoff and the closed-listener error on both
  backends (`tokio_rt/listen.rs:52-54`, `100-103`; `compio_rt/listen.rs:210-212`, `256-262`),
  a worker that fails to start and the cleanup that joins the others (`tokio_rt/worker.rs:312-317`,
  `compio_rt/worker.rs:288-293`).
- Listener socket options are never set by a test: `SO_INCOMING_CPU`, `TCP_DEFER_ACCEPT`,
  `TCP_FASTOPEN`, `SO_REUSEPORT` on the handoff path and the path-MTU probe (`net.rs:75`, `86`,
  `89`, `160`, `179`); a short datagram send and an IPv6 source address in packet info
  (`net.rs:261-262`, `288-290`).
- Datagram batch errors after a partial batch on both backends (`tokio_rt/udp.rs:136-170`,
  `compio_rt/udp.rs:117-158`).

### zero-http (90.9 %)

- Public request accessors never called by any test: `Request::target()`, `query()`,
  `route_path()`, `params()`, `authority()`, `peer()` (`call.rs:379`, `392`, `398`, `433`,
  `439`, `499`), and the default `Handler::taken` that drops a takeover (`handler.rs:76`).
- The connection driver (`conn.rs`, 81 lines): a head that arrives in two reads, joined into the
  current block or moved to the heap when it outgrows the block (`Input::absorb`, `244-261`;
  heap compaction `222-228`); a chunked body that stalls mid-size-line (`930`), a chunked
  framing error or a refused trailer section at the driver (`938`, `945`); a read that finds the
  pool without budget and its retry (`554`, `677`); a response head that outgrows its first
  buffer and the bare 500 written when it cannot be serialized (`1329-1346`).
- The accept loop: the `EMFILE`-class pause and the transient-error retry (`server.rs:317-328`),
  shutdown while the memory budget holds accepts (`server.rs:312`), and configuration refusals
  (invalid limits, an invalid `Server` value: `server.rs:251-263`).
- Problem details: JSON escaping of `\`, CR, TAB and other control bytes (`error.rs:177-183`).

### zero-realtime (86.7 %, no unit tests)

- `EventStream::comment()`, `EventStream::request()`, `WebSocket::leave()`,
  `WebSocket::request()`, `WebSocket::token()` (`sse.rs:149`, `110`; `websocket.rs:196`, `225`,
  `231`), and the room leave path (`rooms.rs:246-266`).
- Errors: an SSE write that writes zero bytes (`sse.rs:246-248`), a WebSocket peer that drops
  (`websocket.rs:355`, `365`, `379`), the pool-budget retry on both (`sse.rs:209-210`,
  `websocket.rs:412-415`).

### zero-serve (86.4 %)

- Usage errors: an unknown option and a non-UTF-8 argument (`lib.rs:341-344`, `460-464`).
- Start failures: an unreadable directory (`lib.rs:569-581`), the signal or join thread failing
  to start (`lib.rs:533-548`), a stop-signal wait error (`lib.rs:716-737`).
- Running: the `TaskPanic` and `WorkerPanic` reports (`lib.rs:683-690`), a core that stops while
  the server runs (`lib.rs:828-835`), a failed join (`lib.rs:842-843`), security header
  rendering errors (`lib.rs:868-873`), the 404 when the root no longer resolves (`lib.rs:924`).

### zero-router (89.8 %)

- `Params::len()`, `Params::is_empty()`, `Params::by_name()` (the by-name lookup the facades
  need), `Allow::is_empty()`, `Router::default()` (`lib.rs:184`, `190`, `207`, `120`, `359`).
- Refusals: `RouteError::TooManyParameters` and `RouteError::ParameterConflict`
  (`lib.rs:472`, `478`), `RouteError`'s message and its mapping to `Error::Protocol`
  (`lib.rs:72-89`), the mount ordering tie-break between equal-length prefixes (`lib.rs:514-518`).

### zero-static (90.5 %)

- The Windows path rules, a colon (alternate data stream) and a tilde followed by a digit (8.3
  short name), are behind `cfg!(windows)` (`files.rs:168-177`) and run nowhere: no test names
  them and zero-static is not in the Windows leg of the `seam` job. R.3 step 9 names these
  rules in its deliverable.
- The post-open swap check (device and inode at the path differ from the opened file,
  `files.rs:289-293`): the symlink-swap vector of R.3 step 9's exit criterion never reaches it;
  the existing test `a_symbolic_link_inside_the_root_never_serves_a_file_outside_it` stops at
  `O_NOFOLLOW` or the canonical-root check.
- The per-core cache: eviction past the budget (`files.rs:120-125`) and invalidation of an entry
  whose file changed (`files.rs:320-324`).
- Responses: 412 Precondition Failed (`files.rs:430-431`), `Content-Disposition` for a download
  (`files.rs:442-448`), a directory path with no index file (`files.rs:263`), `Files::root()`,
  `Files::options()`.

### zero-rt, zero-core and the small codecs

- zero-rt: arena refusals (`Error::Closed`, the readers-counted `Error::Limit`, stale or full:
  `arena.rs:178-193`), the compare-and-swap retry arm of every slot transition (`slot.rs:143`,
  `182`, `214`, `236`, `275`), `Worker::report()`, `Arena::limit()`, a contained future polled
  after its panic (`contain.rs:51-53`). Planned: WP-2 tests every transition and refusal and
  the loom models drive the retry arms.
- zero-core: `OwnedBuf::into_vec()`, `From<u32>` and `From<String>` for `Value`, the `None`
  arms of the `Value` accessors, the `Display` text of `Error::Io`, `Auth`, `Unsupported` and
  `Limit`.
- zero-http1 rejections with no named test (the fuzz targets reach them but assert only "no
  panic"): leading empty lines past `max_head_bytes` (`head.rs:321`), a CR not followed by LF
  where a field line starts (`head.rs:389`), a head past `max_head_bytes` (`head.rs:442`), a
  CONNECT authority-form target with no port (`head.rs:566`); in trailers, a CR not followed by
  LF (`chunked.rs:244`), a section past `max_trailer_bytes` (`chunked.rs:250-253`), a partial or
  invalid line end (`chunked.rs:259-260`, `488`), a line starting with whitespace, which is
  obs-fold (`chunked.rs:472`), and a field past `max_header_field` (`chunked.rs:498`).
- zero-uri: `remove_dot_segments` step 2A, a leading `../` or `./` (`lib.rs:297-298`; the two
  RFC 3986 section 5.2.4 examples never start that way), a path without authority that starts
  with `//` (`lib.rs:412`), a percent triplet cut off by the range end (`lib.rs:448`),
  `is_gen_delim()`.
- zero-base64: the three `InvalidPadding` refusals (`lib.rs:270`, `275`, `285`, RFC 4648 section
  3.2), `DecodeError`'s messages and its mapping (`Full` to `Error::Limit`, the rest to
  `Error::Codec`, `lib.rs:98-103`).
- zero-date: an asctime date with a two-digit day (`parse.rs:180`; only the single-digit RFC
  9110 example is tested), an RFC 850 date with trailing bytes (`parse.rs:150`).
- zero-policy: quoted-pair escapes in `Forwarded` (`forwarded.rs:150-153`, `197-202`) and five
  malformed-node refusals (`forwarded.rs:257-287`), `SecurityHeader::name()`, a policy that
  needs a nonce rendered without one (`security.rs:223-225`).
- zero-ws: a ping over 125 bytes refused on send (`session.rs:442-445`), an internal-error close
  (`session.rs:277`). zero-sse: an event past `max_event` (`decode.rs:187-190`).
- zero-sys: `getrandom` interrupted or returning nothing (`random.rs:61-69`), a `getsockopt`
  result that is not a C int (`sockopt.rs:545-548`), the `MSG_PEEK` and `MSG_ERRQUEUE` flags
  (`msg.rs:50`, `54`), signal setup failures (`signal.rs:201-240`), `fcntl` failures
  (`fs.rs:71`, `90`).

## Property and randomized tests

- No crate depends on proptest (no manifest, no `deny.toml` entry, no `supply-chain` entry).
- Three crates draw inputs from a deterministic in-crate xorshift generator with fixed seeds and
  no shrinking: zero-simd (`test_support.rs`, 28 randomized loops plus exhaustive byte grids,
  every kernel against SWAR), zero-qpack (`xorshift.rs`, 29 loops), zero-h3 (`xorshift.rs`, 37
  loops). All three scale the count down under Miri.
- Every other parser of untrusted input has only example tests plus its fuzz target: zero-http1
  (request head, chunked decoder, trailers), zero-uri, zero-qs, zero-json, zero-router,
  zero-mime, zero-base64, zero-ws, zero-sse, zero-policy (`Forwarded`, CORS fields), zero-static
  (`Range`, conditional fields, the request path), zero-date (`parse_http_date`), zero-tls (the
  hello reader). RULES (Testing) says "Parsers of untrusted input carry proptest tests and a
  libFuzzer target"; STATUS records the decision to use the in-crate generator in zero-simd
  instead of proptest.

## Miri and sanitizers in ci.yml

- Miri (`ci.yml:370-402`, `MIRIFLAGS=-Zmiri-strict-provenance -Zmiri-many-seeds=0..4`, 90-minute
  limit, 9 min 15 s on run 37048673426, green): zero-simd, zero-sys, zero-ffi, zero-http-types,
  zero-date, zero-http1, zero-router, zero-uri, zero-qs, zero-mime, zero-base64, zero-json,
  zero-ws, zero-sse, zero-qpack, zero-h3. Ignored under Miri: 18 zero-sys tests (every test that
  makes a system call), one zero-simd test (`every_two_byte_prefix_matches_core`), one zero-ws
  test. Under Miri zero-simd's feature detection is compiled out (`detect.rs:85-154`), so only
  the SSE2 kernels run; the AVX2 kernels are never interpreted.
- ASan and TSan (`ci.yml:404-445`, nightly with `-Zbuild-std`): `-p zero-rt -p zero-ffi`, that
  is 15 zero-rt tests and zero-ffi's single `zero_version` test. The second step,
  `cargo +nightly test ... -p zero-rt -- --include-ignored slot_recycle`, matches no test: no
  test named `slot_recycle` exists in the tree (grep), so it runs zero tests and passes.
- Not under any sanitizer in unit tests: zero-sys (36 `unsafe` sites: `sendmsg`, `recvmsg`,
  `getsockopt` and `setsockopt`, affinity, signals, `fcntl`, `getrandom`) and zero-simd (37
  `unsafe` sites). They get ASan only through the 60-second fuzz smoke of `cmsg_decode`,
  `simd_kernels` and `utf8_validate`.
- No loom job yet (WP-2 adds the models, WP-16 the job).

## Fuzz targets per parser

25 targets under `fuzz/fuzz_targets`: 17 committed, 8 untracked (in flux). Every target has a
seed set and a dictionary. The fuzz smoke runs each for 60 s under ASan on every push.

| Crate | Parser entry points | Target | In git | Seeds | 24 CPU-hour run (`target/fuzz-campaign/progress.txt`) |
| --- | --- | --- | --- | ---: | --- |
| zero-sys | `cmsg::messages`, `Builder` | cmsg_decode | yes | 6 | done, 0 artifacts |
| zero-simd | the kernels | simd_kernels | yes | 9 | queued |
| zero-simd | `validate_utf8`, `Utf8Validator` | utf8_validate | yes | 11 | queued |
| zero-http1 | `parse_request` | http1_head | yes | 14 | done, 0 artifacts |
| zero-http1 | `ChunkedDecoder`, `parse_trailers` | http1_chunked | yes | 8 | done, 0 artifacts |
| zero-uri | `parse`, `normalize_path`, `percent_decode`, `remove_dot_segments`, `split_query` | uri_normalize | yes | 5 | queued |
| zero-qs | `parse`, `decode` | qs_parse | yes | 2 | running since 19:36 UTC |
| zero-json | `parse`, `parse_with` | json_parse | yes | 5 | done, 0 artifacts |
| zero-router | `Router::resolve` | router_resolve | yes | 4 | queued |
| zero-qpack | field sections, encoder and decoder instructions, Huffman, integers and strings | qpack_field_section, qpack_instructions, qpack_huffman, qpack_primitives | yes | 10, 7, 16, 8 | not in the campaign |
| zero-h3 | frames, settings, stream types, capsules and datagrams | h3_frames, h3_settings, h3_streams, h3_capsules | yes | 9, 7, 6, 6 | not in the campaign |
| zero-ws | frame header, close payload; the session | ws_frames, ws_session | no | 13, 10 | not in the campaign |
| zero-sse | `Decoder`, `last_event_id` | sse_decode | no | 10 | not in the campaign |
| zero-tls | `HelloReader` (compiles `hello.rs` in place) | tls_hello | no | 12 | not in the campaign |
| zero-base64 | `decode`, `decode_slice` | base64_decode | no | 17 | not in the campaign |
| zero-mime | `parse`, `negotiate`, `from_path` | mime_parse | no | 10 | not in the campaign |
| zero-policy | `forwarded::parse`, `TrustProxy` | forwarded_parse | no | 13 | not in the campaign |
| zero-policy | `Cors` decisions | cors_fields | no | 7 | not in the campaign |

Parsers of untrusted input with no target: zero-date `parse_http_date` (`If-Modified-Since`,
`If-Unmodified-Since`, `If-Range`); zero-static `range::resolve` (`Range`), `EntityTag::parse`
and `cond::evaluate` (`If-Match`, `If-None-Match`, `If-Range`), and `Files::locate` (the request
path to a file system path); zero-ws `handshake::negotiate` and `handshake::accept`
(`Sec-WebSocket-Protocol`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version`); zero-policy
`fetch_metadata::Site::parse` (`Sec-Fetch-Site`) and the incoming request id check
(`request_id.rs`); zero-http1 `ResponseWriter`, the outbound validator of DESIGN 6.3, whose
input becomes untrusted host data once a binding passes JavaScript strings through it.

The campaign (`target/fuzz-campaign.sh`, container `zero-fuzz`, 6 workers for 4 hours per
target) listed its 9 targets when it started at 03:33 UTC, so the 16 targets added since are
not in it. `fuzz/corpus` is gitignored and no workflow runs the long campaign on a schedule.

## In flux during the measurement

- Uncommitted edits in the measured sources (rustdoc cleanup and WP-1 plumbing, 80 lines added,
  76 removed): zero-http (`call.rs`, `conn.rs`, `error.rs`, `lib.rs`, `ring.rs`), zero-io (seven
  files), zero-rt (six files), zero-router `lib.rs`, zero-sys `affinity.rs`, zero-http1
  `no_alloc.rs`. Line numbers here are from that state; later edits may shift them a little.
- `crates/zero-host` is untracked (a crate doc and `pub const VERSION` only); zero-ffi is the
  `zero_version` placeholder; both are replaced by WP-8 and WP-9.
- The 8 untracked fuzz targets with their seeds and dictionaries; `fuzz/Cargo.toml` and
  `fuzz/Cargo.lock` modified.
- `Cargo.toml`, `Cargo.lock`, `deny.toml`, `docs/standards.toml`, `docs/capabilities.toml` and
  `supply-chain/config.toml` modified by other agents; the workspace built and every test passed
  in that state.

## Planned by DESIGN-12-13 (not counted as gaps)

Checked against section 14 of `.github/cloud/work/step12/DESIGN-12-13.md`:

- zero-host tests (WP-8): end to end over loopback, every refusal, realtime events, every
  vector section against `vectors.json` (today no Rust test reads `conformance/vectors.json`;
  only the generator example touches it), `no_alloc_tier3`, the TSan test.
- zero-ffi tests (WP-9): the table-driven header test of section 6.16, lifecycle, plugin
  validation, Miri over the pointer helpers and handles, TSan and ASan on `slot_recycle_c_abi`.
- zero-rt (WP-2): one test per transition and refusal, the ten loom models (which drive the CAS
  retry arms that never run today), `slot_recycle_word_race`; WP-16 adds the `loom` job, puts
  zero-host beside zero-rt and zero-ffi in the sanitizer step and checks that the three
  `slot_recycle` tests actually ran, which fixes the empty step described above.
- zero-http (WP-3): export and import round trips, the held-connection and leased-bytes tests.
- zero-realtime (WP-4): outbox ordering including join and leave, shutdown behavior.
- Node (WP-10, WP-11, WP-14): native `node:test` files, the facade tests per member group, the
  conformance runner and the legacy runner (which also runs the zero-server-node
  `test/routing/router.test.js` cases whose manifest release is 1). .NET and Python smoke tests
  (WP-12, WP-13) match R.3 step 13's scope.

## Gaps

Ordered by what they risk for the release. "Planned" marks a gap that DESIGN-12-13 closes in part.

### 1. The request driver's fragmented-input and malformed-body paths are untested

- Missing: a head split across two reads (`zero-http/src/conn.rs:244-261`), a head larger than
  one block (heap path, `222-228`, `249-256`), a chunked body stalled mid-line (`930`), a
  chunked framing error and a refused trailer section reaching the driver (`938`, `945`), the
  no-budget read retry (`554`, `677`), response head growth and the bare 500 fallback
  (`1329-1346`), the accept loop's `EMFILE` pause and transient retry (`server.rs:317-328`).
- Evidence: lcov `DA` count 0 on those lines after all five passes (`target/cov-audit-out/merged.lcov`).
- Why it matters: on a real network a head routinely arrives in more than one segment; the
  slow-header timeout and the per-connection memory accounting both depend on this path, and a
  malformed chunked body must end in 400 and a closed connection, which only the codec's unit
  tests check today. The benchmark load generators pipeline and fragment too.
- Close: driver tests that force multiple reads deterministically by setting
  `zero_io::rt::Config::receive_block` (a public field, default
  `zero_limits::http1::RECEIVE_BLOCK`; `tokio_rt/worker.rs:37`, `compio_rt/worker.rs:36`) to a
  few dozen bytes, so every head spans several blocks and a long one moves to the heap, with no
  sleep involved; run them on both backends; a chunked body
  with a bad size line, a bad CRLF and an obs-fold trailer, each answered 400 with
  `Connection: close`; a response with more header bytes than the first buffer; an accept loop
  test that lowers `RLIMIT_NOFILE` in a child process.

### 2. The TLS stream layer is the least covered code in the product (79.9 %)

- Missing: see the zero-tls list above; in short, five `Stream` methods on all three stream
  types, every listener refusal outside the fuzz target, the no-budget paths, the TLS 1.3-only
  and tickets-off configurations, the ticket lifetime refusal, the unbuffered driver's buffer
  growth, identity loading errors.
- Evidence: `zero-tls/src/buffered.rs` 68.2 %, `unbuffered.rs` 73.2 %, `accept.rs` 76.9 %,
  `outbox.rs` 79.3 %; 32 production functions never ran.
- Why it matters: this crate terminates untrusted bytes for every HTTPS request and `zero serve`
  exposes it; the unbuffered driver is the io-compio path the benchmark will run.
- Close: listener tests for each refusal with the alert asserted (a hello split over records
  past one handshake message; a TLS 1.3 hello that omits an extension the reader requires, which
  `fuzz/fuzz_targets/tls_hello.rs` documents as the `missing_extension` case); a client that offers early
  data, or the `ReadEarlyData` arm removed; a configuration test per branch; records larger than
  the initial buffer on the unbuffered driver; one seam conformance test generic over
  `zero_io::Stream` (see gap 3) run against both TLS drivers.

### 3. The seam's public `Stream` surface is only half tested on every backend

- Missing: `readable`, `read_into`, `peer_addr` on tokio and compio TCP streams, `write` and
  `shutdown_write` on TLS streams, `driver()`, `Core::count/pinned/live_tasks/is_io_uring`,
  `UdpSocket::set_tos`, the listener socket options, the worker start failure cleanup.
- Evidence: `zero-io/src/tokio_rt/tcp.rs` 49.4 %, `compio_rt/tcp.rs` 69.6 %,
  `tokio_rt/listen.rs` 68.3 %, `compio_rt/listen.rs` 78.4 %; 44 production functions never ran.
- Why it matters: R.3 step 4 freezes these traits; zero-host and the bindings build on them, and
  a method that is wrong on one backend fails only in production.
- Close: one generic test module, `fn conformance<S: Stream>(...)`, instantiated for tokio,
  compio, buffered TLS and unbuffered TLS, covering every method including drop-mid-flight;
  configuration tests that set each listener option and read it back with the zero-sys getters.

### 4. zero-static's Windows path rules and the symlink-swap check never run

- Missing: the colon and short-name refusals (`zero-static/src/files.rs:168-177`), the
  device and inode swap check (`289-293`), cache eviction and invalidation (`120-125`,
  `320-324`), 412 (`430-431`), the download `Content-Disposition` (`442-448`).
- Evidence: the lines are uncovered; `ci.yml`'s `seam` job tests only `-p zero-io -p zero-sys
  -p zero-rt -p zero-http` on Windows and macOS (`ci.yml:258`); grep finds no Windows test in
  zero-static.
- Why it matters: R.3 step 9 lists "Windows colon and short-name rules" in the deliverable and
  "the symlink-swap and traversal vectors refuse" as the exit criterion; a stale cache entry
  serves a file after it changed.
- Close: take the platform rule set as a parameter of `segment_allowed` (or add a test-only
  entry) so every host tests both rule sets, and add `-p zero-static` to the Windows and macOS
  legs; a swap test through a hook between the open and the metadata check; tests for a cache
  budget smaller than two files, a file modified after caching, `If-Match` mismatch, and
  `download`.

### 5. RFC 9112 rejection paths in zero-http1 have no named test

- Missing: ten rejection branches (listed under "zero-rt, zero-core and the small codecs"): bare
  CR at a field line start, leading empty lines past the head limit, a head past
  `max_head_bytes`, CONNECT without a port, and six trailer-section refusals including obs-fold.
- Evidence: `head.rs:321`, `389`, `442`, `566`; `chunked.rs:244`, `250-253`, `259-260`, `472`,
  `488`, `498` uncovered by `cargo test`.
- Why it matters: R.2 and R.3 step 3 require every framing statement as a named test with its
  section number; the fuzz targets only assert that nothing panics, not the status.
- Close: one test per branch named after the statement (RFC 9112 sections 2.2, 3.2.3, 5.2 and
  7.1.2), each asserting the `Reject` status and the close flag.

### 6. The httparse differential oracle does not exist

- Missing: R.3 step 3 ("the httparse oracle behind a dev feature") and R.2 ("the httparse
  differential oracle and the zero-http1 fuzz target have run for at least 24 CPU-hours").
- Evidence: grep for `httparse` over `crates/`, `fuzz/`, `deny.toml` and `Cargo.lock` finds
  nothing.
- Why it matters: it is a stated exit criterion of the thesis deliverable, and a differential
  check is the only way the fuzzer finds a head the parser accepts with the wrong spans.
- Close: an `http1_differential` fuzz target (httparse as a fuzz-only dependency, version
  fetched from crates.io and vetted), or record an owner decision dropping the criterion.

### 7. 21 of 25 fuzz targets have not had their 24 CPU-hours, and no schedule exists

- Missing: 24 CPU-hours for the 8 QPACK and HTTP/3 targets (R.3 step 11 exit), the 8 targets
  added on 2026-10-02, and the 4 queued original targets; a scheduled long-run workflow; the
  committed corpus.
- Evidence: `target/fuzz-campaign/progress.txt` (4 of 9 done, `qs_parse` running); the campaign
  enumerated its targets at 03:33 UTC; `ci.yml:474` says "the long runs are a separate
  schedule" but no workflow has a fuzz schedule (only `codeql.yml` and `pypi-backfill.yml` carry
  `schedule:`); ROADMAP R.7 item 14 asks for "the weekly job with the crash corpus committed";
  `fuzz/.gitignore` ignores `corpus`.
- Why it matters: step 11's exit criterion and RULES' "never panic on arbitrary bytes" are not
  demonstrated for most targets.
- Close: rerun `target/fuzz-campaign.sh` with `FUZZ_TARGETS` naming the 16 (16 targets at 24
  CPU-hours is 384 CPU-hours, about 27 hours of wall clock on 14 CPUs); add a weekly workflow;
  commit a minimized corpus (`cargo fuzz cmin`) into `fuzz/seeds`.

### 8. Parsers of untrusted input without a fuzz target

- Missing: zero-date `parse_http_date`; zero-static `Range`, the conditional fields and
  `Files::locate`; zero-ws handshake fields; zero-policy `Sec-Fetch-Site` and the incoming
  request id; zero-http1 `ResponseWriter` (host data once bindings exist).
- Evidence: the table above; STATUS lists "the small field parsers" as open.
- Why it matters: RULES requires a libFuzzer target for every parser of untrusted input.
- Close: one target each with seeds and a dictionary, added to the campaign of gap 7.

### 9. Property tests: the rule says proptest, the code says otherwise, and most parsers have neither

- Missing: any property or randomized test in zero-http1, zero-uri, zero-qs, zero-json,
  zero-router, zero-mime, zero-base64, zero-ws, zero-sse, zero-policy, zero-static, zero-date
  and zero-tls; WP-8 of DESIGN-12-13 also names "a proptest of arbitrary bytes per section",
  which no manifest, `deny.toml` or `supply-chain` entry allows.
- Evidence: no `proptest` anywhere in the tree; the generators exist only in zero-simd,
  zero-qpack and zero-h3.
- Why it matters: RULES (Testing) makes it a requirement, and the fuzz targets run only on
  demand, not in `cargo test`.
- Close: decide once (planned in part: WP-8 needs the same decision): either amend RULES and
  WP-8 to accept the in-crate generator, then move the properties each fuzz target asserts
  (prefix partiality, one-byte-at-a-time equivalence, round trips) into generator-driven unit
  tests per parser; or adopt proptest as a dev-dependency through `deny.toml`, `cargo vet` and
  a version fetched from crates.io.

### 10. No sanitizer covers zero-sys's system calls or zero-simd's AVX2 kernels in unit tests

- Missing: ASan (and for zero-sys, TSan) over the two audited crates with the most `unsafe`.
- Evidence: `ci.yml:429-435` tests only `-p zero-rt -p zero-ffi`; the 18 zero-sys syscall tests
  are ignored under Miri; zero-simd's detection is compiled out under Miri (`detect.rs:85-154`),
  so AVX2 never runs there.
- Why it matters: these are 73 of the workspace's `unsafe` sites (a grep for `unsafe {`,
  `unsafe fn` and `unsafe impl` under `src/`), in an audited crate list that
  SECURITY.md will publish.
- Close: add `-p zero-sys -p zero-simd` and `-p zero-io --test datagram` to the ASan leg (WP-16
  extends the step to zero-host only, so this is not planned).

### 11. zero-tls, zero-static, zero-realtime and zero-serve never run on Windows or macOS

- Missing: test runs of those crates on the two platforms the release ships prebuilt binaries
  for; this report itself is Linux only.
- Evidence: the `seam` job's package list (`ci.yml:258`, `277`, `286-287`).
- Why it matters: platform-specific code (gap 4's rules, the Ctrl+C path of `zero serve`, file
  identity checks) ships untested.
- Close: run `cargo test --workspace` (or the four crates) on `windows-latest` and
  `macos-latest`.

### 12. No coverage measurement in CI

- Missing: a job that measures coverage and fails on a drop.
- Evidence: no `llvm-cov` in `.github/workflows/` (grep); this report is the first measurement.
- Why it matters: the owner's bar is "heavily unit tested"; without a recorded number nothing
  shows it, and nothing stops it eroding.
- Close: a `coverage` job running the five passes above with cargo-llvm-cov 0.9.1 (fetched
  2026-10-02; recheck before adding), uploading the lcov, and an xtask check over the JSON that
  fails when a crate's production line figure falls below the floor recorded in the repository
  (`--fail-under-lines` applies only to the total).

### 13. zero-http's public request accessors are never called

- Missing: `Request::target()`, `query()`, `route_path()`, `params()`, `authority()`, `peer()`,
  `Handler::taken`'s default.
- Evidence: `zero-http/src/call.rs:379-501`, `handler.rs:76`.
- Why it matters: they are the tier 4 Rust handler API that the README's Rust example leads to;
  `peer()` feeds trust-proxy decisions. DESIGN-12-13 adds C ABI accessors that read the record
  directly, so the binding work does not exercise these.
- Close: one routing test that reads each accessor for a request with a query, parameters, an
  absolute-form target and a known peer.

### 14. zero-realtime has no unit tests and five public methods never run (planned in part)

- Missing: `EventStream::comment()`, `EventStream::request()`, `WebSocket::request()`,
  `WebSocket::token()`, and the drop and zero-write errors; `WebSocket::leave()` is covered by
  WP-4's "join and leave apply in send order".
- Evidence: `zero-realtime/src/sse.rs` 81.6 %, `websocket.rs` 85.6 %.
- Close: integration tests for the comment line (`: text`), the request view after the upgrade,
  and a peer that drops mid-message.

### 15. The `zero` binary's failure paths are untested

- Missing: the zero-serve list above (usage errors, start failures, panic reports, a core that
  stops, header rendering errors, the 404 when the root disappears).
- Evidence: `zero-serve/src/lib.rs` 86.3 %.
- Why it matters: `zero serve` is a shipped binary; its messages and exit codes are its
  interface.
- Close: process tests in `tests/serve.rs` for each, asserting stderr and the exit status.

### 16. Router refusals and parameter lookup by name (planned in part)

- Missing: `TooManyParameters`, `ParameterConflict`, `Params::by_name`, `Params::len`,
  `Params::is_empty`, the mount tie-break.
- Evidence: `zero-router/src/lib.rs:207`, `472`, `478`, `514-518`; zero-router has 12 unit tests
  plus 6 routing tests in zero-http, against 45 in zero-server-node's
  `test/routing/router.test.js` (R.3 step 6 says those "pass"; WP-14's legacy runner runs the
  release 1 cases through the facade, which reaches zero-router only through the binding).
- Close: Rust tests for the two refusals, the by-name lookup and the tie-break; port the
  router.test.js cases that describe matching rules rather than facade behavior.

### 17. Spec branches and error mappings in the small codecs

- Missing: RFC 3986 section 5.2.4 step 2A and two zero-uri refusals; RFC 4648 section 3.2
  padding refusals in zero-base64; the asctime two-digit day of RFC 9110 section 5.6.7
  (`date3 = month SP ( 2DIGIT / ( SP 1DIGIT ))`) in zero-date; RFC 6455 section 5.5's 125-byte
  control frame limit on send in zero-ws; `Forwarded` quoted-pair escapes and five refusals;
  the zero-sse event limit; the `Display` text and `zero_core::Error` mapping of `DecodeError`,
  `RouteError`, `UriError`, the zero-json errors and `zero_core::Error` itself.
- Evidence: the per-crate lists above.
- Why it matters: the error variant decides the status a client sees (`zero_http::status_for`,
  `zero-http/src/error.rs:45-57`: `Limit` answers 413, `Codec` and `Protocol` 400, `Io` 500), so
  base64's `Full` mapped to `Limit` is a 413 that no test pins; the spec branches are the
  statements those RFC sections make.
- Close: one table-driven test per crate over every error variant and its mapping, plus a named
  test per spec branch.

## Raw summary output

`cargo llvm-cov report --ignore-filename-regex 'crates/(xtask|zero-bench|zero-examples)/'`
after the five passes (`target/cov-audit-out/merged-summary.txt`). Figures include inline test
modules; zero-ffi's row carries the merge artifact described under Method. Branch columns are
zero because branch coverage needs nightly.

```text
Filename                              Regions    Missed Regions     Cover   Functions  Missed Functions  Executed       Lines      Missed Lines     Cover    Branches   Missed Branches     Cover
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
zero-base64/src/lib.rs                    541                39    92.79%          20                 2    90.00%         256                19    92.58%           0                 0         -
zero-core/src/buf.rs                      303                14    95.38%          31                 1    96.77%         173                 5    97.11%           0                 0         -
zero-core/src/codec.rs                     34                 1    97.06%           5                 0   100.00%          18                 0   100.00%           0                 0         -
zero-core/src/error.rs                     33                15    54.55%           2                 0   100.00%          17                 6    64.71%           0                 0         -
zero-core/src/primitive.rs                156                 7    95.51%          14                 1    92.86%          78                 3    96.15%           0                 0         -
zero-core/src/slot.rs                     159                 0   100.00%          22                 0   100.00%          94                 0   100.00%           0                 0         -
zero-core/src/value.rs                    183                12    93.44%          25                 2    92.00%         126                11    91.27%           0                 0         -
zero-date/src/civil.rs                    367                41    88.83%          14                 0   100.00%         176                 8    95.45%           0                 0         -
zero-date/src/decimal.rs                  153                 1    99.35%          16                 0   100.00%          86                 0   100.00%           0                 0         -
zero-date/src/imf.rs                      292                12    95.89%          26                 0   100.00%         130                 0   100.00%           0                 0         -
zero-date/src/parse.rs                    425                63    85.18%          15                 0   100.00%         178                 2    98.88%           0                 0         -
zero-ffi/src/lib.rs                        21                 6    71.43%           3                 1    66.67%          12                 5    58.33%           0                 0         -
zero-h3/src/capsule.rs                    538                 4    99.26%          22                 0   100.00%         268                 0   100.00%           0                 0         -
zero-h3/src/control.rs                    402                 0   100.00%          23                 0   100.00%         211                 0   100.00%           0                 0         -
zero-h3/src/datagram.rs                   199                 1    99.50%          16                 0   100.00%         122                 0   100.00%           0                 0         -
zero-h3/src/decoder.rs                   1914                 9    99.53%          61                 0   100.00%        1290                 6    99.53%           0                 0         -
zero-h3/src/error.rs                      426                23    94.60%          16                 0   100.00%         477                21    95.60%           0                 0         -
zero-h3/src/frame.rs                      395                 9    97.72%          20                 0   100.00%         198                 0   100.00%           0                 0         -
zero-h3/src/reserved.rs                    80                 1    98.75%           4                 0   100.00%          41                 1    97.56%           0                 0         -
zero-h3/src/settings.rs                   657                 5    99.24%          35                 0   100.00%         353                 0   100.00%           0                 0         -
zero-h3/src/stream.rs                     364                 1    99.73%          25                 0   100.00%         220                 0   100.00%           0                 0         -
zero-h3/src/varint.rs                     343                 5    98.54%          15                 0   100.00%         159                 0   100.00%           0                 0         -
zero-h3/src/xorshift.rs                    92                 5    94.57%          13                 0   100.00%          58                 3    94.83%           0                 0         -
zero-http-types/src/escape.rs              92                 0   100.00%           9                 0   100.00%          48                 0   100.00%           0                 0         -
zero-http-types/src/field.rs              474                 9    98.10%          45                 0   100.00%         246                 3    98.78%           0                 0         -
zero-http-types/src/head.rs               105                 1    99.05%           8                 0   100.00%          70                 1    98.57%           0                 0         -
zero-http-types/src/header.rs             145                 2    98.62%          12                 0   100.00%          75                 0   100.00%           0                 0         -
zero-http-types/src/method.rs             137                 0   100.00%          11                 0   100.00%          78                 0   100.00%           0                 0         -
zero-http-types/src/status.rs             281                 4    98.58%          32                 0   100.00%         179                 0   100.00%           0                 0         -
zero-http/src/call.rs                     536                42    92.16%          59                10    83.05%         381                28    92.65%           0                 0         -
zero-http/src/conn.rs                    1640               184    88.78%          89                 5    94.38%         995               100    89.95%           0                 0         -
zero-http/src/error.rs                    178                15    91.57%          12                 1    91.67%         115                 8    93.04%           0                 0         -
zero-http/src/handler.rs                    9                 5    44.44%           3                 2    33.33%           8                 4    50.00%           0                 0         -
zero-http/src/record.rs                   131                 0   100.00%          12                 0   100.00%          76                 0   100.00%           0                 0         -
zero-http/src/ring.rs                     367                23    93.73%          28                 1    96.43%         212                17    91.98%           0                 0         -
zero-http/src/server.rs                   230                45    80.43%          18                 3    83.33%         169                33    80.47%           0                 0         -
zero-http/src/takeover.rs                  58                14    75.86%          11                 1    90.91%          53                 8    84.91%           0                 0         -
zero-http1/src/chunked.rs                 867                34    96.08%          33                 1    96.97%         458                17    96.29%           0                 0         -
zero-http1/src/error.rs                    36                 4    88.89%           6                 0   100.00%          30                 2    93.33%           0                 0         -
zero-http1/src/head.rs                   1281                22    98.28%          54                 2    96.30%         751                15    98.00%           0                 0         -
zero-http1/src/list.rs                    335                 3    99.10%          25                 0   100.00%         172                 2    98.84%           0                 0         -
zero-http1/src/no_alloc.rs                187                20    89.30%          11                 0   100.00%          78                 2    97.44%           0                 0         -
zero-http1/src/response.rs                645                19    97.05%          37                 0   100.00%         317                 7    97.79%           0                 0         -
zero-io/src/compio_rt/executor.rs         363                32    91.18%          31                 4    87.10%         230                21    90.87%           0                 0         -
zero-io/src/compio_rt/listen.rs           201                55    72.64%          16                 3    81.25%         131                29    77.86%           0                 0         -
zero-io/src/compio_rt/shutdown.rs         168                 4    97.62%          16                 0   100.00%         101                 1    99.01%           0                 0         -
zero-io/src/compio_rt/tcp.rs              301                98    67.44%          32                 9    71.88%         174                53    69.54%           0                 0         -
zero-io/src/compio_rt/time.rs             381                14    96.33%          26                 0   100.00%         203                 7    96.55%           0                 0         -
zero-io/src/compio_rt/udp.rs              143                42    70.63%          11                 2    81.82%          84                21    75.00%           0                 0         -
zero-io/src/compio_rt/worker.rs           323                69    78.64%          27                 8    70.37%         219                40    81.74%           0                 0         -
zero-io/src/date.rs                       111                 8    92.79%          13                 3    76.92%          69                 7    89.86%           0                 0         -
zero-io/src/net.rs                        226                59    73.89%          11                 3    72.73%         148                19    87.16%           0                 0         -
zero-io/src/pool.rs                       197                 3    98.48%          12                 0   100.00%          92                 0   100.00%           0                 0         -
zero-io/src/seam.rs                        46                 0   100.00%           5                 0   100.00%          30                 0   100.00%           0                 0         -
zero-io/src/tokio_rt/listen.rs             86                27    68.60%           7                 2    71.43%          46                15    67.39%           0                 0         -
zero-io/src/tokio_rt/mod.rs                 7                 7     0.00%           1                 1     0.00%           7                 7     0.00%           0                 0         -
zero-io/src/tokio_rt/shutdown.rs          147                 0   100.00%          17                 0   100.00%          90                 0   100.00%           0                 0         -
zero-io/src/tokio_rt/tcp.rs               132                62    53.03%          14                 4    71.43%          81                40    50.62%           0                 0         -
zero-io/src/tokio_rt/time.rs               40                 0   100.00%           7                 0   100.00%          28                 0   100.00%           0                 0         -
zero-io/src/tokio_rt/udp.rs               133                32    75.94%          12                 1    91.67%          80                15    81.25%           0                 0         -
zero-io/src/tokio_rt/worker.rs            327                30    90.83%          28                 6    78.57%         226                20    91.15%           0                 0         -
zero-json/src/parse.rs                    810                27    96.67%          38                 3    92.11%         470                17    96.38%           0                 0         -
zero-json/src/write.rs                    620                67    89.19%          50                 2    96.00%         354                15    95.76%           0                 0         -
zero-limits/src/http1.rs                    3                 0   100.00%           1                 0   100.00%           3                 0   100.00%           0                 0         -
zero-limits/src/lib.rs                    164                 0   100.00%           6                 0   100.00%         151                 0   100.00%           0                 0         -
zero-limits/src/services.rs                15                 0   100.00%           5                 0   100.00%          15                 0   100.00%           0                 0         -
zero-limits/src/transport.rs                9                 0   100.00%           3                 0   100.00%           9                 0   100.00%           0                 0         -
zero-mime/src/accept.rs                   339                 9    97.35%          22                 0   100.00%         173                 3    98.27%           0                 0         -
zero-mime/src/lib.rs                      581                26    95.52%          36                 0   100.00%         296                 7    97.64%           0                 0         -
zero-policy/src/body_limit.rs              90                 0   100.00%          10                 0   100.00%          59                 0   100.00%           0                 0         -
zero-policy/src/cors.rs                   305                19    93.77%          25                 1    96.00%         168                 3    98.21%           0                 0         -
zero-policy/src/fetch_metadata.rs          37                 0   100.00%           3                 0   100.00%          29                 0   100.00%           0                 0         -
zero-policy/src/forwarded.rs              498                44    91.16%          39                 0   100.00%         272                18    93.38%           0                 0         -
zero-policy/src/lib.rs                   1383                30    97.83%          49                 0   100.00%         803                13    98.38%           0                 0         -
zero-policy/src/request_id.rs             111                 8    92.79%           9                 0   100.00%          66                 1    98.48%           0                 0         -
zero-policy/src/security.rs               345                24    93.04%          33                 2    93.94%         245                16    93.47%           0                 0         -
zero-qpack/src/decoder.rs                 575                 3    99.48%          30                 0   100.00%         432                 0   100.00%           0                 0         -
zero-qpack/src/encoder.rs                 479                 9    98.12%          22                 0   100.00%         245                 4    98.37%           0                 0         -
zero-qpack/src/error.rs                   197                 0   100.00%          11                 0   100.00%         176                 0   100.00%           0                 0         -
zero-qpack/src/huffman.rs                 666                 7    98.95%          32                 0   100.00%         306                 3    99.02%           0                 0         -
zero-qpack/src/instruction.rs             855                12    98.60%          36                 0   100.00%         543                 3    99.45%           0                 0         -
zero-qpack/src/integer.rs                 469                 6    98.72%          17                 0   100.00%         249                 1    99.60%           0                 0         -
zero-qpack/src/lib.rs                     477                 4    99.16%          24                 0   100.00%         298                 2    99.33%           0                 0         -
zero-qpack/src/prefix.rs                  319                 5    98.43%          17                 0   100.00%         179                 1    99.44%           0                 0         -
zero-qpack/src/representation.rs          373                 1    99.73%          12                 0   100.00%         256                 0   100.00%           0                 0         -
zero-qpack/src/string.rs                  406                 6    98.52%          15                 0   100.00%         207                 5    97.58%           0                 0         -
zero-qpack/src/table.rs                   126                 3    97.62%           8                 1    87.50%          86                 3    96.51%           0                 0         -
zero-qpack/src/xorshift.rs                 78                 4    94.87%          10                 0   100.00%          44                 2    95.45%           0                 0         -
zero-qs/src/lib.rs                        202                 0   100.00%          16                 0   100.00%         114                 0   100.00%           0                 0         -
zero-realtime/src/rooms.rs                209                21    89.95%          22                 4    81.82%         140                12    91.43%           0                 0         -
zero-realtime/src/sse.rs                  202                44    78.22%          19                 5    73.68%         121                25    79.34%           0                 0         -
zero-realtime/src/websocket.rs            350                49    86.00%          28                 4    85.71%         199                27    86.43%           0                 0         -
zero-router/src/lib.rs                   1386                90    93.51%          71                11    84.51%         738                61    91.73%           0                 0         -
zero-rt/src/arena.rs                      444                28    93.69%          23                 2    91.30%         188                12    93.62%           0                 0         -
zero-rt/src/cancel.rs                      78                 7    91.03%           6                 0   100.00%          38                 1    97.37%           0                 0         -
zero-rt/src/contain.rs                     99                 7    92.93%          15                 1    93.33%          69                 8    88.41%           0                 0         -
zero-rt/src/slot.rs                       376                14    96.28%          23                 1    95.65%         218                 9    95.87%           0                 0         -
zero-rt/src/tier.rs                        29                 0   100.00%           3                 0   100.00%          19                 0   100.00%           0                 0         -
zero-rt/src/worker.rs                     335                18    94.63%          36                 3    91.67%         212                12    94.34%           0                 0         -
zero-serve/src/lib.rs                    1174               117    90.03%          67                 6    91.04%         746                81    89.14%           0                 0         -
zero-serve/src/main.rs                      5                 0   100.00%           1                 0   100.00%           3                 0   100.00%           0                 0         -
zero-server-crypto/src/lib.rs             239                 2    99.16%          25                 1    96.00%         116                 1    99.14%           0                 0         -
zero-simd/src/detect.rs                   111                 6    94.59%           9                 0   100.00%          76                 4    94.74%           0                 0         -
zero-simd/src/lib.rs                      145                 0   100.00%          10                 0   100.00%          68                 0   100.00%           0                 0         -
zero-simd/src/scalar.rs                   139                 0   100.00%          18                 0   100.00%          79                 0   100.00%           0                 0         -
zero-simd/src/swar.rs                     340                 2    99.41%          33                 0   100.00%         194                 0   100.00%           0                 0         -
zero-simd/src/test_support.rs             133                 5    96.24%          13                 0   100.00%          67                 2    97.01%           0                 0         -
zero-simd/src/utf8.rs                     399                 3    99.25%          18                 0   100.00%         203                 1    99.51%           0                 0         -
zero-simd/src/x86.rs                      585                19    96.75%          43                 0   100.00%         271                 9    96.68%           0                 0         -
zero-sse/src/decode.rs                    233                 4    98.28%          10                 0   100.00%         138                 4    97.10%           0                 0         -
zero-sse/src/encode.rs                    169                 1    99.41%          13                 0   100.00%          94                 0   100.00%           0                 0         -
zero-sse/src/lib.rs                       367                 0   100.00%          15                 0   100.00%         224                 0   100.00%           0                 0         -
zero-static/src/cond.rs                   200                 8    96.00%          21                 0   100.00%         120                 7    94.17%           0                 0         -
zero-static/src/files.rs                  587                98    83.30%          26                 5    80.77%         314                51    83.76%           0                 0         -
zero-static/src/headers.rs                125                 4    96.80%           7                 0   100.00%          76                 0   100.00%           0                 0         -
zero-static/src/lib.rs                    937                 8    99.15%          40                 0   100.00%         539                 3    99.44%           0                 0         -
zero-static/src/range.rs                  271                16    94.10%          15                 0   100.00%         139                 4    97.12%           0                 0         -
zero-sys/src/affinity.rs                   87                 1    98.85%           7                 0   100.00%          57                 1    98.25%           0                 0         -
zero-sys/src/alloc.rs                     117                 3    97.44%          21                 1    95.24%          66                 3    95.45%           0                 0         -
zero-sys/src/cmsg.rs                      514                21    95.91%          36                 0   100.00%         233                 1    99.57%           0                 0         -
zero-sys/src/error.rs                      23                 0   100.00%           2                 0   100.00%          20                 0   100.00%           0                 0         -
zero-sys/src/fs.rs                        172                 9    94.77%          10                 0   100.00%          83                 5    93.98%           0                 0         -
zero-sys/src/msg.rs                       331                15    95.47%          20                 3    85.00%         214                 9    95.79%           0                 0         -
zero-sys/src/packet.rs                    227                11    95.15%          13                 0   100.00%         135                 4    97.04%           0                 0         -
zero-sys/src/random.rs                    115                 8    93.04%           8                 0   100.00%          57                 6    89.47%           0                 0         -
zero-sys/src/signal.rs                    200                14    93.00%          19                 1    94.74%         123                 7    94.31%           0                 0         -
zero-sys/src/sockopt.rs                   419                16    96.18%          34                 1    97.06%         209                10    95.22%           0                 0         -
zero-tls/src/accept.rs                    299                74    75.25%          33                 9    72.73%         172                40    76.74%           0                 0         -
zero-tls/src/buffered.rs                  386               137    64.51%          30                11    63.33%         205                66    67.80%           0                 0         -
zero-tls/src/config.rs                     54                 9    83.33%           5                 2    60.00%          50                 9    82.00%           0                 0         -
zero-tls/src/hello.rs                     327                48    85.32%          15                 1    93.33%         162                12    92.59%           0                 0         -
zero-tls/src/identity.rs                  235                24    89.79%          24                 7    70.83%         134                11    91.79%           0                 0         -
zero-tls/src/lib.rs                      1170                46    96.07%          54                 4    92.59%         639                31    95.15%           0                 0         -
zero-tls/src/outbox.rs                     49                15    69.39%           4                 0   100.00%          30                 6    80.00%           0                 0         -
zero-tls/src/unbuffered.rs                553               151    72.69%          37                10    72.97%         322                86    73.29%           0                 0         -
zero-uri/src/lib.rs                       652                28    95.71%          46                 2    95.65%         359                16    95.54%           0                 0         -
zero-ws/src/close.rs                       52                 1    98.08%           3                 0   100.00%          32                 0   100.00%           0                 0         -
zero-ws/src/frame.rs                      169                 2    98.82%           6                 0   100.00%          94                 1    98.94%           0                 0         -
zero-ws/src/handshake.rs                  211                 5    97.63%          18                 1    94.44%         144                 2    98.61%           0                 0         -
zero-ws/src/lib.rs                       1172                11    99.06%          46                 1    97.83%         578                 6    98.96%           0                 0         -
zero-ws/src/session.rs                    393                 8    97.96%          20                 0   100.00%         251                 7    97.21%           0                 0         -
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
TOTAL                                   47269              2804    94.07%        2964               185    93.76%       27317              1422    94.79%           0                 0         -
```

The default pass alone over the whole workspace, xtask, zero-bench and zero-examples included (`target/cov-audit-out/report-default-summary.log`, last line):

```text
TOTAL                                       62871              7935    87.38%        3913               534    86.35%       36604              4478    87.77%           0                 0         -
```

Pass status (`target/cov-audit-out/status.txt`):

```text
pass1-workspace exit 0 seconds 158
report-default-summary exit 0 seconds 5
report-default-json exit 0 seconds 6
pass2-io-compio exit 0 seconds 13
pass3-http-compio exit 0 seconds 18
pass4-handoff exit 0 seconds 18
pass5-bench-compio exit 0 seconds 79
done
merged-summary exit 0
merged-json exit 0
merged-lcov exit 0
merged-text exit 0
report-done
merged-full exit 0
doctests exit 0
```

Environment (`target/cov-audit-out/env.txt`):

```text
2026-10-02T19:41:13Z
rustc 1.99.0 (b940084d7 2026-09-28)
cargo 1.99.0 (5f94df478 2026-08-27)
cargo-llvm-cov 0.9.1
Linux 043f8bb72c48 6.18.33.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026 x86_64 GNU/Linux
14
e13e631cbd0d6be5766e30d15c17094671242a97
```
