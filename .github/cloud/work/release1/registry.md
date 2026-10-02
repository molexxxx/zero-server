# Release 1 audit: the standards registry

Scope: every row of `docs/standards.toml` at or below `current_release = 1`, the tests
those rows cite, the rows DESIGN-12-13 plans to satisfy, and the standards that release 1
crates implement without a row. Measured on 2026-10-02 against the working tree (HEAD
`e13e631` plus uncommitted edits by other agents, see "In flux"). Nothing in the
repository was edited; scratch scripts and build output live under the session
scratchpad and `target/release1-registry*`.

## Summary

- The register holds 669 rows: 279 at release 1, 139 at release 2, 251 at release 3.
  Committed HEAD holds 642 rows, 252 of them at release 1; the working tree adds the 27
  rows of DESIGN-12-13 section 12.
- Of the 279 release 1 rows, 250 cite a line that exists exactly once and is a
  `#[test]` function. All 250 functions compile as tests and pass. The run covered 503
  tests in the 17 crates those rows cite plus zero-qs: 503 passed, 0 failed, 0 ignored
  (Docker, 2026-10-02 19:44 to 19:47 UTC).
- 29 release 1 rows have no test: 28 cite a file that does not exist yet and 1
  (`routing-29`) cites a function that does not exist yet. DESIGN-12-13 assigns every
  one of them to a work package (WP-5, WP-8, WP-9, WP-10, WP-11, WP-13, WP-14), so they
  are planned, not missing. Two of them (`runtime-01`, `runtime-07`) are already red at
  HEAD.
- `cargo xtask standards --check` is red on every push and nobody sees it: CI runs it
  with `continue-on-error: true`, it stops at the first failing row, and it never checks
  that the cited line is a test. The release preflight blocks on it, so the tag cannot
  publish while any of the 29 is open.
- Judged sample of 78 rows across all seven chapters that have release 1 rows: 50
  Strong, 13 Adequate, 13 Partial, 2 Weak. The test bodies of 219 of the 250 tested rows
  were read; every Partial and Weak one found is in the sample.
- 17 gaps in all: R-01 is the 29 planned rows, and R-02 to R-17 are not covered by any
  plan. The ones that matter most for release 1: 11 rows already tested in release 1 crates are registered at release 2 and
  so are not enforced; zero-base64 and several other release 1 features have no row,
  although 15 statement-named tests exist that no row cites; the security-header rows
  are green at the rule level while zero-http's own error responses carry no security
  headers.

## Counts by chapter and status

All releases. "R1 tested" means the cited line exists once and is a compiled, passing
test; "R1 no test" is the 29 rows DESIGN-12-13 covers.

| Chapter | Rows | Release 1 | Release 2 | Release 3 | R1 tested | R1 no test |
| --- | --- | --- | --- | --- | --- | --- |
| http | 183 | 101 | 70 | 12 | 97 | 4 |
| http3 | 90 | 90 | 0 | 0 | 90 | 0 |
| realtime | 40 | 34 | 1 | 5 | 28 | 6 |
| runtime | 37 | 25 | 7 | 5 | 6 | 19 |
| tls | 26 | 26 | 0 | 0 | 26 | 0 |
| auth | 79 | 1 | 34 | 44 | 1 | 0 |
| observe | 28 | 2 | 0 | 26 | 2 | 0 |
| data | 98 | 0 | 27 | 71 | 0 | 0 |
| grpc | 40 | 0 | 0 | 40 | 0 | 0 |
| webrtc | 48 | 0 | 0 | 48 | 0 | 0 |
| Total | 669 | 279 | 139 | 251 | 250 | 29 |

Release 1 rows by anchor: `rule` 257, `interop` 12, `vector` 10 (http3 9, realtime 1).
No release 1 row is `internal`.

Release 1 rows by key prefix: routing 32, h1 19, static 17, body 7, policy 25, html 1,
qpack 32, h3 58, realtime 33, utf8 1, tls 24, h2 2, runtime 17, ffi 8, jwt 1, observe 2.

## Mechanical check of the release 1 rows

The script (Appendix B) parses the register with `tomllib`, and for every row at or
below `current_release` checks that the evidence file exists, counts the lines holding
`at`, and classifies the one line: a Rust `fn` whose attributes (walked upward over
doc comments and other attributes) include `#[test]` or a test-macro attribute, a
JavaScript `it(` or `test(` call, or a Python `def test_`. It also records gating
attributes (`ignore`, `cfg`, `should_panic`).

| Result | Rows |
| --- | --- |
| Evidence file exists | 251 |
| Evidence file missing | 28 |
| `at` on exactly one line | 250 |
| `at` on no line (file exists) | 1 (`routing-29`) |
| `at` on more than one line | 0 |
| Line is a test | 250 |
| Line is not a test (comment, helper, prose) | 0 |
| Test gated so it may not run | 0 (`realtime-04` is skipped under Miri only) |
| Two rows citing the same test | 0 |

Cross-checks:

- `cargo test -p <the 17 cited crates and zero-qs> -- --list`: every one of the 250 cited functions
  is in the compiled test list (prefix match, because `at` is often a prefix of a longer
  function name).
- `cargo test` of the same crates on the working tree: 503 passed, 0 failed, 0 ignored.
- `crates/zero-http/tests/driver.rs` and `routing.rs` (19 cited rows) are
  `#![cfg(feature = "io-tokio")]`; `io-tokio` is a default feature of zero-http, so
  `cargo test --workspace` runs them.
- `cargo run -p xtask -- standards` in the working tree prints only
  `xtask standards: standards.toml: routing-29: no line of crates/zero-http-types/src/method.rs contains "fn patch_is_a_recognized_method_that_is_neither_safe_nor_idempotent"`
  and stops, although 29 rows fail.
- The latest green CI run, 37048673426 on `e13e631`, step "Standards rows have their
  tests", prints `xtask standards: standards.toml: runtime-01: reading bindings/node/test/lifecycle.test.js: No such file or directory (os error 2)`
  and `Process completed with exit code 1`; the run is green because of
  `continue-on-error: true` (`.github/workflows/ci.yml` lines 156 to 158).

## Rows without a test, and the plan that covers them

Every row below is registered at release 1 and assigned by DESIGN-12-13 sections 12 and
14. Each package writes the test whose `at` text it is given, verbatim.

| Row | Evidence (planned) | Package | Anchor |
| --- | --- | --- | --- |
| routing-29 | `crates/zero-http-types/src/method.rs` (file exists, test does not) | WP-5 | rule |
| routing-30, routing-31 | `crates/zero-host/tests/access.rs` | WP-8 | rule |
| realtime-34 to realtime-39 | `crates/zero-host/tests/realtime.rs` | WP-8 | rule |
| runtime-21 | `crates/zero-host/tests/dispatch.rs` | WP-8 | rule |
| runtime-22 | `crates/zero-host/tests/dispatch.rs` | WP-8 | interop |
| ffi-01, ffi-02, ffi-04, ffi-05, ffi-06, ffi-08 | `crates/zero-ffi/tests/abi_table.rs` | WP-9 | rule |
| ffi-03 | `crates/zero-ffi/tests/header.rs` | WP-9 | rule |
| ffi-07 | `crates/zero-ffi/tests/plugin.rs` | WP-9 | rule |
| runtime-23 | `bindings/node/test/native/lifecycle.test.mjs` | WP-10 | interop |
| runtime-24, runtime-28 | `bindings/node/test/native/isolates.test.mjs` | WP-10 | interop |
| runtime-25 | `bindings/node/test/native/body.test.mjs` | WP-10 | interop |
| runtime-26 | `bindings/node/test/native/staging.test.mjs` | WP-10 | interop |
| runtime-01, runtime-07 | `bindings/node/test/lifecycle.test.js` | WP-11 | interop |
| runtime-27 | `bindings/node/test/facade/pool.test.mjs` | WP-11 | interop |
| runtime-29 | `bindings/python/tests/test_serve.py` | WP-13 | interop |
| routing-32 | `bindings/node/test/conformance/response-splitting.test.mjs` | WP-14 | rule |

Does the design really cover them? Yes for all 29, with these observations:

- The `at` text of every working-tree row matches the design's section 12 table
  exactly, including the amended `at` of `runtime-01` and `runtime-07`.
- Every URL fragment the new rows cite resolves (fetched 2026-10-02): the nine ANSSI
  ids on https://anssi-fr.github.io/rust-guide/unsafe/ffi.html (FFI-NOPANIC, FFI-CTYPE,
  FFI-CAPI, FFI-NOENUM, FFI-CK-PTR-VALID, FFI-MEM-OWNER, FFI-CKFUNPTR,
  FFI-MARKEDFUNPTR, FFI-CK-REF-MODEL), `#unwinding` on
  https://doc.rust-lang.org/reference/items/functions.html, and the five Node-API
  fragments on https://nodejs.org/docs/latest-v22.x/api/n-api.html. The design had
  flagged the ANSSI and Node.js fragments as not fetched as fragments; they are fine.
- `runtime-22` is anchored `interop` ("A value is queued only when the call returns
  napi_ok"), but its planned evidence is a Rust test in zero-host over a `TestTarget`.
  No Node-API call takes place, so the test can show only the dispatcher's reaction to a
  simulated `Full`. See gap R-08.
- `routing-32` was narrowed from the design's "in every binding" to "in the Node
  binding". The same refusal through the C ABI (`zero_res_header`, which the .NET smoke
  exercises per design section 11) has no row. See gap R-16.
- WP-0's exit criterion ("`cargo xtask standards --check` ... lists exactly the new
  rows, plus `runtime-01` and `runtime-07`, as missing tests") cannot be met by the
  current tool, which reports only the first failure. See gap R-02.
- `routing-01` asserts that `PATCH` resolves to `NotImplemented`; WP-5 makes PATCH a
  method and lists the router case for `PROPFIND` as 501, so that test changes in WP-5.

## Sampled judgment

Question asked of each test: does it check the statement the row quotes, or something
weaker? Verdicts:

- Strong: checks the statement directly, including the refusal side.
- Adequate: checks the statement at the layer the evidence crate owns, with a stated
  limit.
- Partial: checks a narrower claim than the subject.
- Weak: checks a constant or restates the implementation.

78 rows judged, at least one in every chapter that has release 1 rows (data, grpc and
webrtc have none):

| Chapter | Judged | Strong | Adequate | Partial | Weak |
| --- | --- | --- | --- | --- | --- |
| http | 34 | 20 | 8 | 6 | 0 |
| http3 | 15 | 13 | 1 | 1 | 0 |
| realtime | 12 | 8 | 0 | 3 | 1 |
| tls | 8 | 7 | 1 | 0 | 0 |
| runtime | 6 | 1 | 2 | 2 | 1 |
| auth | 1 | 0 | 0 | 1 | 0 |
| observe | 2 | 1 | 1 | 0 | 0 |
| Total | 78 | 50 | 13 | 13 | 2 |

Beyond the sample, the bodies of 219 of the 250 tested rows were read (all of http,
realtime, tls, runtime, auth and observe, `qpack-01` to `qpack-32`, `h3-01` to `h3-22`
and five later h3 rows). Every Partial or Weak test found is in the sample. Overall the
codec chapters are the strongest: QPACK and HTTP/3 assert the RFC's own octets (RFC 9204
Appendix B, RFC 7541 Appendix C, RFC 9000 Appendix A.1), TLS drives real rustls
handshakes and checks alert bytes on the wire, and the HTTP/1.1 parser rows feed raw
requests and assert status and close.

Rows below Strong, with what each test misses:

| Row | Verdict | What the test checks, and what it misses |
| --- | --- | --- |
| realtime-33 | Weak | Asserts `STOP_RECONNECTING == StatusCode::NO_CONTENT`. Nothing shows a 204 ends an SSE stream or that a handler can send one. |
| runtime-06 | Weak | Compares `DEFAULT_DRAIN` with a literal 30 s and parses `--drain`. Anchored `interop`, but no third-party implementation is involved. |
| routing-10 | Partial | The IMF-fixdate formatter against the RFC 9110 Section 5.6.7 example. The subject says Date, Last-Modified, Expires and cookie expiry use it; no generating site is checked. |
| h1-12 | Partial | The parser's `keep_alive` flag for `Connection: close`. The subject is that the server closes after the final response; the driver's close is not observed here. |
| body-06 | Partial | `ErrorKind::TooLarge` maps to `Error::Limit` "which the driver answers 413". No 413 is observed. |
| static-05 | Partial | A 304 keeps ETag, Cache-Control and Date. Expires and Vary, named in the subject, are neither configured nor asserted. |
| static-15 | Partial | `private` is emitted when configured. The subject says it is used whenever a response is user-specific. |
| policy-12 | Partial | Checks `Decision::Preflight` and its fields. The subject says the preflight is answered with an ok (2xx) status; no status is checked, and the test name ("answered without running the route") differs from the subject. |
| qpack-01 | Partial | Pins 17 of the 99 Appendix A entries, the count, 21 empty values and lowercase names. The other 82 entries are never compared with the published table. |
| realtime-25 | Partial | The constants `CONTENT_TYPE` and `RESPONSE_FIELDS`. No served SSE response is checked; zero-realtime has no row. |
| realtime-31 | Partial | The `KeepAlive` schedule type. That a stream actually emits the comment every 15 s is not observed. |
| realtime-32 | Partial | The `last_event_id` parsing helper. Exposure of Last-Event-ID to a handler is not observed. |
| runtime-02 | Partial | zero-http's own drain (idle closed at once, busy closed at the deadline). The subject and the source name Node's `server.close`, `closeIdleConnections` and `closeAllConnections`. It is anchored `interop`, yet nothing third-party runs, and it uses a fixed 50 ms sleep and wall-clock bounds. |
| runtime-05 | Partial | `session.going_away()` writes Close 1001 in the zero-ws codec. A server drain sending it is not observed; WP-4 adds that behavior to zero-realtime. |
| jwt-24 | Partial | Mismatching and differently sized tags never verify. The constant-time property in the subject is not observed: no timing test, and no assertion that `verify_mac` delegates to `aws_lc_rs::constant_time`. |
| routing-01, routing-02 | Adequate | Router `Resolution` values, not the 501 and 405 on the wire. The wire path is covered by other driver tests that rows do not cite. |
| routing-11 | Adequate | A Date of 29 octets ending in GMT on five statuses. The format itself is checked by routing-10. |
| routing-15 | Adequate | The server picks 307 and 308. Preserving method and content is the client's part. |
| h1-16 | Adequate | Upgrade on HTTP/1.0 answers 400 because the route requires an upgrade. "Ignored" is inferred from the status. |
| static-13 | Adequate | Encoded traversal never serves the file outside the root, but the wire check accepts 200, 400 or 404 as long as the body differs. |
| policy-18, policy-25 | Adequate | Rule-level rendering. zero-http's own 400, 408, 413, 421, 505 and post-error 500 carry no security headers; see R-07. The same applies to policy-17, -19, -20 and -26 to -29. |
| h3-48 | Adequate | The codec reports an oversized HEADERS frame. No HTTP/3 server exists in release 1 to answer 431. |
| tls-17 | Adequate | Handshake timeout with wall-clock bounds (at least 250 ms, under 5 s). The default is local policy. |
| runtime-03 | Adequate | Draining responses carry `Connection: close`; uses a fixed 50 ms sleep before shutdown. |
| runtime-09 | Adequate | A synthetic `/err/upstream` route answers 504; no proxy exists in release 1. |
| observe-28 | Adequate | Incoming id validation. "No code path treats it as an access capability" is stated in a comment only. |

The verdict for every judged row is also in Appendix A.

## Gaps

Ordered by release impact. Each gap has its evidence, why it matters for release 1, and
what closes it.

### R-01 Twenty-nine release 1 rows have no test (blocker, planned)

- Missing: the tests of `routing-29` to `routing-32`, `realtime-34` to `realtime-39`,
  `ffi-01` to `ffi-08`, `runtime-01`, `runtime-07` and `runtime-21` to `runtime-29`.
- Evidence: script output (Appendix A, "no test yet"); the xtask output above; CI run
  37048673426 for `runtime-01` at HEAD.
- Why it matters: `release-preflight.yml` runs `cargo run -p xtask -- standards --check`
  without `continue-on-error`, so the v0.1.0 tag cannot publish until all 29 exist.
- Closes it: WP-5, WP-8, WP-9, WP-10, WP-11, WP-13 and WP-14 as planned, then
  `standards --check` green (WP-16 exit).

### R-02 The check stops at the first failure and never checks the line is a test (high)

- Missing: `Standards::check` returns on the first problem (`crates/xtask/src/standards.rs`
  lines 363 to 402), and `locate` (lines 477 to 498) only requires `at` to appear on
  exactly one line. A row citing a comment, a doc page or a helper `fn` passes, and so
  does one whose test is `#[ignore]`d or gated off by `cfg`.
- Evidence: in the working tree the tool names only `routing-29` although 29 rows fail;
  at HEAD it names only `runtime-01` although `runtime-07` fails too. Today all 250
  cited lines are real tests (verified by the script and `cargo test -- --list`), so the
  weakness has not been hit yet.
- Why it matters: the WP-0 and WP-16 exit criteria rely on the tool listing every
  missing test. A later rename or a test turned into a helper would pass silently.
- Closes it: collect every problem and print them all before failing. Add a shape check
  per evidence type (Rust: a `#[test]` family attribute above an `fn` line and no
  `#[ignore]`; JavaScript: `it(` or `test(` with the quoted title; Python:
  `def test_`), with an xtask unit test for each.

### R-03 The registry gate is red on every push and hidden (high)

- Missing: `.github/workflows/ci.yml` lines 156 to 158 run the check with
  `continue-on-error: true`.
- Evidence: run 37048673426 (`e13e631`) exits 1 in that step and the run is reported
  green.
- Why it matters: a commit that renames or deletes a cited test passes CI and is found
  only at tag time, in the irreversible release.
- Closes it: drop `continue-on-error` once WP-16 lands (or now, after marking the 29
  rows' work as the expected failures in a separate advisory step).

### R-04 Eleven tested release 1 behaviors are registered at release 2 (high)

- Missing: `errors-01` to `errors-07` (RFC 9457 problem details, tests at
  `crates/zero-http/tests/driver.rs` lines 1208 to 1316) and `body-08` to `body-11`
  (URL Standard form decoding, tests at `crates/zero-qs/src/lib.rs` lines 177 to 215)
  are `release = 2`. Both crates are `release = 1` in `docs/capabilities.toml`, the
  tests exist and pass, and DESIGN-12-13 WP-3 ships the problem shape through
  `Handler::error_shape` in release 1.
- Why it matters: rows above the current release are reported as pending, not
  enforced, so these eleven shipped behaviors can lose their tests without any check
  failing.
- Closes it: set `release = 1` on the eleven rows (owner confirms the problem shape is
  part of release 1); `errors-08` to `errors-10` stay at 2 until their tests exist.

### R-05 Release 1 features without a row (medium)

- Missing: RULES says every feature maps to a row. With no row:
  - zero-base64 (RFC 4648 Sections 3.3, 3.5, 4, 5 and the Section 10 vectors).
  - The recipient side of zero-date (RFC 9110 Section 5.6.7: accept all three
    HTTP-date formats, and the 50-year rule for two-digit years).
  - zero-uri's own parser and `remove_dot_segments` examples (RFC 3986 Section 5.2.4);
    the router rows cover it only end to end.
  - zero-mime's media-type parser (RFC 9110 Section 8.3.1).
  - zero-http-types' field-value, method-property and status tables (RFC 9110
    Sections 5.5, 9.2, 15 and 15.1).
  - The QPACK constants and the full Huffman table.
  - zero-sys's FIFO open and signal exit status (POSIX).
  - zero-serve's HSTS-over-plain rule.
- Evidence: 15 statement-named tests in release 1 crates that no row cites, including
  `the_rfc_4648_test_vectors_encode_and_decode` (zero-base64),
  `a_recipient_that_parses_a_timestamp_value_in_an_http_field_must_accept_all_three_http_date_formats`
  (zero-date), `remove_dot_segments_follows_the_two_examples_of_section_5_2_4`
  (zero-uri), `field_values_follow_section_5_5`, `safe_and_idempotent_follow_section_9_2`,
  `the_table_is_rfc_9110_section_15_in_order`,
  `heuristic_cacheability_is_the_section_15_1_list` (zero-http-types),
  `the_code_table_is_complete_and_matches_the_appendix_b_examples`,
  `the_crate_constants_match_rfc_9204` (zero-qpack),
  `an_hsts_host_must_not_include_the_sts_header_field_over_non_secure_transport_section_7_2`
  (zero-serve), and two in zero-sys. A full `@see` scan of release 1 crates also shows
  documents cited in code with no row: RFC 8615 (zero-static, mentioned only in a note),
  the IANA WebSocket close-code registry (zero-ws, zero-realtime) and the IANA
  `text/event-stream` registration (zero-sse).
- Why it matters: the published standards page claims one row for each statement the
  core relies on. Several of these tests are published-vector tests, which would lift
  the page's "pinned to published vectors" count above the current 10.
- Closes it: add rows that cite the existing tests (anchor `vector` where the test uses
  the RFC's own examples). No new code is needed.

### R-06 Thirteen Partial and two Weak tests (medium)

- Missing: see the table in "Sampled judgment".
- Why it matters: the owner's bar is "heavily unit tested", and the public page says
  each row is pinned by a test of the statement.
- Closes it, test by test:
  - realtime-33: a served SSE request answered 204 with no body.
  - runtime-06: re-anchor to `rule`; optionally assert that the binary's default drain
    is used on a SIGTERM run.
  - routing-10: assert the format of Date on the wire and of Last-Modified from
    zero-static.
  - h1-12: a driver test that the connection closes after the response.
  - body-06: a 413 on the wire for an oversize JSON body.
  - static-05: configure Expires and a Vary source and assert both on the 304.
  - static-15: rephrase the subject as "a private option emits private", or test a
    per-response choice.
  - policy-12: assert the preflight status on the wire.
  - qpack-01: compare all 99 entries with Appendix A.
  - realtime-25, -31 and -32: zero-realtime end-to-end tests.
  - runtime-02: replace the Node API wording with the behavior this core implements,
    or move the row to the Node facade.
  - runtime-05: point at the WP-4 zero-realtime shutdown test.
  - jwt-24: assert delegation to the constant-time primitive.

### R-07 Security headers are checked at the rule only (medium)

- Missing: the policy rows (policy-17 to policy-20, policy-25 to policy-29) test
  `SecurityHeaders` rendering. Responses the HTTP layer writes itself carry none, and
  `crates/zero-serve/tests/serve.rs` line 379
  (`a_400_or_421_the_http_layer_writes_itself_carries_no_security_headers`) pins that
  as a documented exception.
- Evidence: STATUS.md "Release 1 work still open" lists "zero-http writing the security
  headers on its own responses".
- Why it matters: the rows read as satisfied while a class of responses (400, 408, 413,
  421, 505, the 500 after a handler error) does not follow them.
- Closes it: implement the configured field set in zero-http, invert the serve.rs test,
  and cite a wire-level test from policy-18 and policy-25, or add a row for "responses
  the HTTP layer writes carry the configured security headers".

### R-08 Anchor labels that misstate the evidence (medium)

- Missing:
  - `runtime-02` and `runtime-06` are `interop`, but their tests talk to no third-party
    implementation.
  - `runtime-22` (planned) is `interop` over a Rust `TestTarget`.
  - Several tests that assert a specification's own example are labeled `rule`:
    routing-10 (RFC 9110 Section 5.6.7), routing-23 (RFC 7239 Section 7.5),
    static-01 (RFC 9110 Section 8.8.3.2 Table 3), static-07 (RFC 9110 Section 14.1.2),
    static-16 (RFC 6266), realtime-08 and realtime-11 (RFC 6455 Section 5.7).
- Why it matters: the standards page renders "Live implementation" and "Published
  vector" from this field, and counts vectors on the page.
- Closes it: relabel. For `runtime-22`, either move the evidence to a Node test that
  fills a bounded ThreadsafeFunction (WP-10 already plans `status.test.mjs` with a
  16-entry queue) or change the anchor to `rule` and phrase the subject as the
  dispatcher's reaction to a full target.

### R-09 Node.js rows cite unversioned documentation (medium)

- Missing:
  - `runtime-01`, `runtime-02` and `runtime-07` name "Node.js v26.10.0" with
    `https://nodejs.org/api/...` URLs, and `tls-17` cites `https://nodejs.org/api/tls.html`.
  - The new rows cite `latest-v22.x` pages, and DESIGN-12-13 sets `engines` to
    `>=22`. The package manifests still say `"node": ">= 16"` today; WP-6 changes them.
- Evidence: https://nodejs.org/dist/index.json fetched 2026-10-02 lists v26.10.0
  (2026-09-21) as the newest release and v22.23.3 (2026-09-23) as the newest 22.x.
- Why it matters: RULES requires the documentation of the pinned engines line.
  Unversioned pages move with every Node major.
- Closes it: re-point the four rows at `https://nodejs.org/docs/latest-v22.x/api/...`
  after confirming the same text there, and record the fetch date.

### R-10 A release 1 note cites an obsoleted RFC (low)

- Missing: the `tls-06` note cites "RFC 7627 Section 5.2".
- Evidence: https://www.rfc-editor.org/rfc/rfc7627.json fetched 2026-10-02 reports
  `obsoleted_by: RFC9846`. Of the 74 RFCs the register names, only RFC 7627 and RFC 8446
  are obsoleted, and `h2-15` mentions RFC 8446 only to state that RFC 9846 obsoletes it.
- Why it matters: RULES says only the current document counts.
- Closes it: cite the RFC 9846 text that replaced it.

### R-11 RFC 9931 updates RFC 9112 and is not referenced (low)

- Evidence: https://www.rfc-editor.org/rfc/rfc9931.json and `.txt` fetched
  2026-10-02. "Security Considerations for Optimistic Protocol Transitions in
  HTTP/1.1", March 2026, updates RFC 9112 and RFC 9298. Its only new server MUST
  (Section 8) is for proxy servers rejecting CONNECT, which zero-server is not. Its
  Section 5 confirms that keeping the connection after a rejected upgrade is normal,
  which `h1-16` does.
- Why it matters: `h1-15` and `h1-16` are in exactly this area, and the registry rule
  is to follow updates.
- Closes it: add RFC 9931 to the notes of h1-15 and h1-16, and state in the driver's
  rustdoc that the server never tunnels CONNECT (or add a row that pins CONNECT being
  answered without a tunnel).

### R-12 Test names do not carry the section number (low, owner decision)

- Missing: RULES says conformance tests "are named after the statement they check and
  carry the section number". Only 37 of the 279 cited names do.
- Why it matters: it is a stated rule that the registry does not meet.
- Closes it: either rename the 242 tests and update their `at` text in the same commit,
  or amend RULES so that the row's `url` fragment and `note` carry the section.

### R-13 `@see` citations missing from implementing crates (low)

- Missing: 55 of the 251 rows whose evidence file exists have no `@see` of their
  document anywhere in the evidence crate's `src`. zero-router, zero-json, zero-mime,
  zero-uri, zero-qs and zero-base64 contain no `@see` at all. They name sections in
  plain rustdoc instead (for example zero-policy has 63 such lines and 2 `@see`).
- Why it matters: RULES asks for `@see <url>#section` on the implementing item. The
  public page's weaker claim ("names its section in its documentation") still holds.
- Closes it: add `@see` lines beside the existing plain-text citations.

### R-14 Release 1 URLs without a section fragment (low)

- Missing: 35 release 1 rows link a whole document. The WHATWG server-sent events page
  accounts for 11, Fetch for 8, CSP3 for 4 and Fetch Metadata for 2, and the rest are
  single rows.
- Closes it: deep-link the section each note already names.

### R-15 Fixed sleeps and wall-clock bounds in cited tests (low)

- Missing: `runtime-02` and `runtime-03` sleep 50 ms so that a request reaches the
  handler before shutdown. `h1-13` asserts under 300 ms, `runtime-02` under 300 ms and
  `tls-17` between 250 ms and 5 s.
- Why it matters: RULES forbids fixed sleeps. These are the likeliest flakes under a
  loaded CI runner or the Miri and sanitizer jobs.
- Closes it: poll the server log for the handler's start line instead of sleeping, and
  widen or drop the upper bounds.

### R-16 Host field-value refusal through the C ABI has no row (low)

- Missing: `routing-32` covers the Node binding only. The C ABI path (`zero_res_header`,
  used by .NET and Python) has no row; ffi-04 and ffi-05 cover closed-set integers and
  pointers, not field bytes.
- Closes it: an ffi row citing an `abi_table.rs` case that refuses CR, LF and NUL in a
  field value through the C ABI.

### R-17 Plan and page wording out of date (low)

- Missing:
  - ROADMAP R.3 step 9's exit says "the 33 WebSocket and SSE statements pass". 27 do;
    `realtime-19` to `realtime-23` moved to release 3 and `realtime-24` to release 2, a
    deferral recorded in STATUS.md lines 635 to 637.
  - `docs/about/standards.md` says a row holds "the file that implements it, and the
    test that pins it". A row holds only the test file (`evidence`) and line (`at`).
- Closes it: update the roadmap exit text and the page sentence.

## Currency checks (fetched 2026-10-02)

- rfc-editor.org metadata (`https://www.rfc-editor.org/rfc/rfcNNNN.json`) for all 74
  RFCs the register names in a URL, designation or note (no fetch failed):
  - RFC 7627 is obsoleted by RFC 9846 and named in a release 1 note (R-10).
  - RFC 8446 is obsoleted by RFC 9846 and named only to say so.
  - No other cited RFC is obsoleted.
  - The current TLS documents the rows rely on exist with the titles the rows assume:
    RFC 9846 ("The Transport Layer Security (TLS) Protocol Version 1.3"), RFC 9852
    ("New Protocols Using TLS Must Require TLS 1.3"), and RFC 10015 ("Deprecating
    Obsolete Key Exchange Methods in TLS 1.2 and DTLS 1.2").
  - RFC 9112 is updated by RFC 9931 (R-11).
- https://nodejs.org/dist/index.json: v26.10.0 (2026-09-21) newest, v24.21.0
  (2026-09-07, LTS Krypton), v22.23.3 (2026-09-23, LTS Jod).
- https://anssi-fr.github.io/rust-guide/unsafe/ffi.html: all nine FFI rule ids present.
- https://doc.rust-lang.org/reference/items/functions.html#unwinding and the five
  `latest-v22.x` Node-API fragments: present.
- GitHub Actions log of run 37048673426 through `gh run view --log`.

## In flux during the audit

- `docs/standards.toml`: +360 and -8 lines uncommitted. These are the WP-0 rows and the
  `runtime-01` and `runtime-07` `at` amendments; every count above uses the working tree.
- Untracked or modified while measuring: `crates/zero-host/` (untracked),
  `Cargo.toml`, `Cargo.lock`, `crates/zero-rt/**`, `crates/zero-http/src/**`,
  `crates/zero-router/src/lib.rs`, `crates/zero-io/**`, `docs/capabilities.toml`,
  `fuzz/` (new targets and dictionaries) and `docs/about/standards.md`.
- The 503-test run used the working tree as it was between 19:44 and 19:47 UTC. Line
  numbers in Appendix A move as those edits land; the `at` text does not.

## Reproduction

- Registry scan: `python registry_audit.py <repo> <out>` (Appendix B) writes
  `rows.tsv`, `rows.json`, a test-body dump per chapter, and the summary printed above.
- Compiled and run, in the lint image with
  `CARGO_TARGET_DIR=/work/target/release1-registry`:
  `cargo test -p zero-router -p zero-http -p zero-http-types -p zero-http1 -p zero-date -p zero-mime -p zero-json -p zero-static -p zero-policy -p zero-ws -p zero-sse -p zero-simd -p zero-qpack -p zero-h3 -p zero-tls -p zero-server-crypto -p zero-serve -p zero-qs --no-fail-fast -- --list`,
  then the same without `-- --list`. Output is in `target/release1-registry-out/`.
- xtask: `cargo run -q -p xtask -- standards` in the same image.
- RFC status: for each RFC number, `https://www.rfc-editor.org/rfc/rfcNNNN.json`,
  reading `obsoleted_by` and `updated_by`.

## Appendix A: every release 1 row

"`at` lines" is the number of lines in the evidence file containing the row's `at`
text. "Line" is the line the text was found on in the working tree. For rows without a
test, the planned work package is named.

| Key | Chapter | Anchor | File | `at` lines | Line is a test | Line | Sampled verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| routing-01 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:964` | Adequate |
| routing-02 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:997` | Adequate |
| routing-03 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:1026` | Strong |
| routing-04 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:982` |  |
| routing-05 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:329` | Strong |
| routing-06 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:356` |  |
| routing-07 | http | rule | yes | 1 | yes | `crates/zero-http-types/src/field.rs:484` |  |
| routing-08 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:753` |  |
| routing-09 | http | rule | yes | 1 | yes | `crates/zero-http1/src/response.rs:405` | Strong |
| routing-10 | http | rule | yes | 1 | yes | `crates/zero-date/src/imf.rs:171` | Partial |
| routing-11 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:363` | Adequate |
| routing-12 | http | rule | yes | 1 | yes | `crates/zero-http1/src/response.rs:492` |  |
| routing-13 | http | rule | yes | 1 | yes | `crates/zero-http1/src/response.rs:532` | Strong |
| routing-14 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:374` |  |
| routing-15 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:393` | Adequate |
| routing-16 | http | rule | yes | 1 | yes | `crates/zero-mime/src/accept.rs:222` |  |
| routing-17 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:411` | Strong |
| routing-18 | http | rule | yes | 1 | yes | `crates/zero-http/tests/routing.rs:443` |  |
| routing-19 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:1085` |  |
| routing-20 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:1107` |  |
| routing-21 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:1133` | Strong |
| routing-22 | http | rule | yes | 1 | yes | `crates/zero-router/src/lib.rs:1153` |  |
| routing-23 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:75` | Strong |
| routing-24 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:111` |  |
| routing-25 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:137` |  |
| routing-26 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:168` |  |
| routing-27 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:211` | Strong |
| routing-28 | http | rule | yes | 1 | yes | `crates/zero-http-types/src/status.rs:314` |  |
| routing-29 | http | rule | yes | 0 | no test yet, WP-5 | `crates/zero-http-types/src/method.rs` |  |
| routing-30 | http | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/access.rs` |  |
| routing-31 | http | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/access.rs` |  |
| routing-32 | http | rule | missing | - | no test yet, WP-14 | `bindings/node/test/conformance/response-splitting.test.mjs` |  |
| html-01 | http | rule | yes | 1 | yes | `crates/zero-http-types/src/escape.rs:80` | Strong |
| h1-01 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:846` | Strong |
| h1-02 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:861` | Strong |
| h1-03 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:900` |  |
| h1-04 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:943` |  |
| h1-05 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:962` | Strong |
| h1-06 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:1028` |  |
| h1-07 | http | rule | yes | 1 | yes | `crates/zero-http1/src/response.rs:449` |  |
| h1-08 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:1043` |  |
| h1-09 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:1061` |  |
| h1-10 | http | rule | yes | 1 | yes | `crates/zero-http1/src/chunked.rs:621` |  |
| h1-11 | http | rule | yes | 1 | yes | `crates/zero-http1/src/chunked.rs:639` |  |
| h1-12 | http | rule | yes | 1 | yes | `crates/zero-http1/src/head.rs:1086` | Partial |
| h1-13 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:385` | Strong |
| h1-14 | http | rule | yes | 1 | yes | `crates/zero-http-types/src/status.rs:403` |  |
| h1-15 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:628` | Strong |
| h1-16 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:662` | Adequate |
| h1-17 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:720` |  |
| h1-19 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:698` |  |
| h1-18 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:735` |  |
| h2-14 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:383` | Strong |
| h2-15 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:434` | Strong |
| tls-01 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:489` | Strong |
| tls-02 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:624` |  |
| tls-03 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:635` |  |
| tls-04 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:646` |  |
| tls-05 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:673` |  |
| tls-06 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:694` | Strong |
| tls-07 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:726` |  |
| tls-08 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:737` |  |
| tls-09 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:749` |  |
| tls-10 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:791` |  |
| tls-11 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:538` | Strong |
| tls-12 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:216` |  |
| tls-13 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:237` |  |
| tls-14 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:255` | Strong |
| tls-15 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:880` |  |
| tls-16 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:916` |  |
| tls-17 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:281` | Adequate |
| tls-18 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:466` | Strong |
| tls-19 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:537` |  |
| tls-20 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:599` |  |
| tls-21 | tls | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:931` |  |
| tls-22 | tls | rule | yes | 1 | yes | `crates/zero-tls/src/lib.rs:816` |  |
| tls-23 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:397` |  |
| tls-24 | tls | rule | yes | 1 | yes | `crates/zero-tls/tests/driver.rs:352` |  |
| qpack-01 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/table.rs:209` | Partial |
| qpack-02 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/integer.rs:343` | Strong |
| qpack-03 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/lib.rs:176` |  |
| qpack-04 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/integer.rs:377` |  |
| qpack-05 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/lib.rs:329` |  |
| qpack-06 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/huffman.rs:590` | Strong |
| qpack-07 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/huffman.rs:639` |  |
| qpack-08 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/huffman.rs:653` |  |
| qpack-09 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/huffman.rs:665` |  |
| qpack-10 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/string.rs:287` |  |
| qpack-11 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/lib.rs:414` | Strong |
| qpack-12 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/encoder.rs:271` |  |
| qpack-13 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/decoder.rs:351` | Strong |
| qpack-14 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/prefix.rs:232` |  |
| qpack-15 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/prefix.rs:272` |  |
| qpack-16 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/prefix.rs:332` |  |
| qpack-17 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/decoder.rs:422` |  |
| qpack-18 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/lib.rs:436` |  |
| qpack-19 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/decoder.rs:590` |  |
| qpack-20 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/encoder.rs:314` |  |
| qpack-21 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/encoder.rs:343` | Strong |
| qpack-22 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/lib.rs:467` |  |
| qpack-23 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:615` |  |
| qpack-24 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:638` |  |
| qpack-25 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:727` | Strong |
| qpack-26 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:800` |  |
| qpack-27 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:831` |  |
| qpack-28 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:862` |  |
| qpack-29 | http3 | vector | yes | 1 | yes | `crates/zero-qpack/src/decoder.rs:620` |  |
| qpack-30 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/error.rs:288` |  |
| qpack-31 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/instruction.rs:883` |  |
| qpack-32 | http3 | rule | yes | 1 | yes | `crates/zero-qpack/src/encoder.rs:393` |  |
| h3-01 | http3 | vector | yes | 1 | yes | `crates/zero-h3/src/varint.rs:193` | Strong |
| h3-02 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/varint.rs:226` |  |
| h3-03 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:978` |  |
| h3-04 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1004` | Strong |
| h3-05 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1057` |  |
| h3-06 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1091` |  |
| h3-07 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1136` |  |
| h3-08 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1156` |  |
| h3-09 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1175` |  |
| h3-10 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:235` |  |
| h3-11 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:265` |  |
| h3-12 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1200` |  |
| h3-13 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1221` |  |
| h3-14 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1245` | Strong |
| h3-15 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:348` |  |
| h3-16 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:386` |  |
| h3-17 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:419` |  |
| h3-18 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:450` |  |
| h3-19 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:483` |  |
| h3-20 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:516` |  |
| h3-21 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1272` |  |
| h3-22 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1301` |  |
| h3-23 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1336` |  |
| h3-24 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1360` |  |
| h3-25 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:287` |  |
| h3-26 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:312` |  |
| h3-27 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:339` | Strong |
| h3-28 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1384` |  |
| h3-29 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1406` |  |
| h3-30 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/control.rs:381` |  |
| h3-31 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1428` |  |
| h3-32 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1466` |  |
| h3-33 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1543` |  |
| h3-34 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1656` |  |
| h3-35 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1701` | Strong |
| h3-36 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:258` |  |
| h3-37 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:279` |  |
| h3-38 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:294` |  |
| h3-39 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:313` |  |
| h3-40 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:359` |  |
| h3-41 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:393` |  |
| h3-42 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:415` |  |
| h3-43 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:437` |  |
| h3-44 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/error.rs:607` | Strong |
| h3-45 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/error.rs:638` |  |
| h3-46 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/reserved.rs:73` |  |
| h3-47 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1730` |  |
| h3-48 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/decoder.rs:1773` | Adequate |
| h3-49 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/datagram.rs:120` |  |
| h3-50 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/datagram.rs:160` |  |
| h3-51 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:560` |  |
| h3-52 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/settings.rs:588` |  |
| h3-53 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/capsule.rs:361` |  |
| h3-54 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/capsule.rs:412` |  |
| h3-55 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/capsule.rs:433` | Strong |
| h3-56 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/capsule.rs:460` |  |
| h3-57 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/capsule.rs:491` |  |
| h3-58 | http3 | rule | yes | 1 | yes | `crates/zero-h3/src/stream.rs:457` |  |
| body-01 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:554` |  |
| body-02 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:577` |  |
| body-03 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:588` |  |
| body-04 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:609` | Strong |
| body-05 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:631` |  |
| body-06 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:656` | Partial |
| body-07 | http | rule | yes | 1 | yes | `crates/zero-json/src/parse.rs:698` |  |
| static-01 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:150` | Strong |
| static-02 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:185` |  |
| static-03 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:222` |  |
| static-04 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:267` |  |
| static-05 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:568` | Partial |
| static-06 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:323` |  |
| static-07 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:330` |  |
| static-08 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:365` |  |
| static-09 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:374` |  |
| static-10 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:419` |  |
| static-11 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:445` |  |
| static-12 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:609` |  |
| static-13 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:656` | Adequate |
| static-14 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:503` |  |
| static-15 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:533` | Partial |
| static-16 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:545` |  |
| static-17 | http | rule | yes | 1 | yes | `crates/zero-static/src/lib.rs:708` | Strong |
| policy-06 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:889` |  |
| policy-07 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:958` |  |
| policy-08 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:254` |  |
| policy-10 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:281` |  |
| policy-11 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:320` |  |
| policy-12 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:345` | Partial |
| policy-13 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:401` |  |
| policy-14 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:463` |  |
| policy-15 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:489` |  |
| policy-16 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:1085` |  |
| policy-17 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:572` |  |
| policy-18 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:594` | Adequate |
| policy-19 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:605` |  |
| policy-20 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:628` |  |
| policy-21 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:647` |  |
| policy-22 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:683` | Strong |
| policy-23 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:718` |  |
| policy-24 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:742` |  |
| policy-25 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:758` | Adequate |
| policy-26 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:776` |  |
| policy-27 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:803` |  |
| policy-28 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:859` |  |
| policy-29 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:1070` |  |
| policy-30 | http | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:548` | Strong |
| policy-31 | http | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:1106` | Strong |
| jwt-24 | auth | rule | yes | 1 | yes | `crates/zero-server-crypto/src/lib.rs:242` | Partial |
| realtime-01 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:189` | Strong |
| realtime-02 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:243` |  |
| realtime-03 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:267` |  |
| realtime-04 | realtime | vector | yes | 1 | yes (Miri skips) | `crates/zero-ws/src/lib.rs:290` | Strong |
| realtime-05 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:315` |  |
| realtime-06 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:340` |  |
| realtime-07 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:375` | Strong |
| realtime-08 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:390` |  |
| realtime-09 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:409` |  |
| realtime-10 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:418` |  |
| realtime-11 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:427` | Strong |
| realtime-12 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:463` |  |
| realtime-13 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:478` |  |
| realtime-14 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:519` |  |
| realtime-15 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:550` | Strong |
| realtime-16 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:604` |  |
| realtime-17 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:635` | Strong |
| utf8-01 | realtime | rule | yes | 1 | yes | `crates/zero-simd/src/utf8.rs:224` | Strong |
| realtime-18 | realtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:682` |  |
| realtime-25 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:97` | Partial |
| realtime-26 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:122` |  |
| realtime-27 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:142` | Strong |
| realtime-28 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:171` |  |
| realtime-29 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:202` |  |
| realtime-30 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:226` |  |
| realtime-31 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:261` | Partial |
| realtime-32 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:285` | Partial |
| realtime-33 | realtime | rule | yes | 1 | yes | `crates/zero-sse/src/lib.rs:300` | Weak |
| realtime-34 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| realtime-35 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| realtime-36 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| realtime-37 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| realtime-38 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| realtime-39 | realtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/realtime.rs` |  |
| observe-27 | observe | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:995` | Strong |
| observe-28 | observe | rule | yes | 1 | yes | `crates/zero-policy/src/lib.rs:1032` | Adequate |
| runtime-01 | runtime | interop | missing | - | no test yet, WP-11 | `bindings/node/test/lifecycle.test.js` |  |
| runtime-02 | runtime | interop | yes | 1 | yes | `crates/zero-http/tests/driver.rs:1442` | Partial |
| runtime-03 | runtime | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:1423` | Adequate |
| runtime-05 | runtime | rule | yes | 1 | yes | `crates/zero-ws/src/lib.rs:732` | Partial |
| runtime-06 | runtime | interop | yes | 1 | yes | `crates/zero-serve/src/lib.rs:997` | Weak |
| runtime-07 | runtime | interop | missing | - | no test yet, WP-11 | `bindings/node/test/lifecycle.test.js` |  |
| runtime-08 | runtime | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:1123` | Strong |
| runtime-09 | runtime | rule | yes | 1 | yes | `crates/zero-http/tests/driver.rs:1160` | Adequate |
| ffi-01 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| ffi-02 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| ffi-03 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/header.rs` |  |
| ffi-04 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| ffi-05 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| ffi-06 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| ffi-07 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/plugin.rs` |  |
| ffi-08 | runtime | rule | missing | - | no test yet, WP-9 | `crates/zero-ffi/tests/abi_table.rs` |  |
| runtime-21 | runtime | rule | missing | - | no test yet, WP-8 | `crates/zero-host/tests/dispatch.rs` |  |
| runtime-22 | runtime | interop | missing | - | no test yet, WP-8 | `crates/zero-host/tests/dispatch.rs` |  |
| runtime-23 | runtime | interop | missing | - | no test yet, WP-10 | `bindings/node/test/native/lifecycle.test.mjs` |  |
| runtime-24 | runtime | interop | missing | - | no test yet, WP-10 | `bindings/node/test/native/isolates.test.mjs` |  |
| runtime-25 | runtime | interop | missing | - | no test yet, WP-10 | `bindings/node/test/native/body.test.mjs` |  |
| runtime-26 | runtime | interop | missing | - | no test yet, WP-10 | `bindings/node/test/native/staging.test.mjs` |  |
| runtime-27 | runtime | interop | missing | - | no test yet, WP-11 | `bindings/node/test/facade/pool.test.mjs` |  |
| runtime-28 | runtime | interop | missing | - | no test yet, WP-10 | `bindings/node/test/native/isolates.test.mjs` |  |
| runtime-29 | runtime | interop | missing | - | no test yet, WP-13 | `bindings/python/tests/test_serve.py` |  |

## Appendix B: the registry scan script

```python
"""Audit docs/standards.toml rows at or below current_release.

For every row: does the evidence file exist, how many lines contain `at`, is the
matched line a test (Rust #[test]-style attribute above the fn, JS it()/test(),
Python def test_), which attributes gate it (ignore, cfg, feature), and the test
body for manual judgment. Writes rows.tsv, rows.json and bodies/<chapter>.txt and
prints the summary.
"""

import collections
import json
import os
import re
import sys
import tomllib

ROOT = sys.argv[1]
OUT = sys.argv[2]

TEST_ATTRS = re.compile(
    r"#\[\s*(test|tokio::test|async_std::test|test_case|rstest|proptest|compio::test|"
    r"zero_rt::test|zero_test::test|wasm_bindgen_test)\b"
)


def read_lines(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read().split("\n")


def rust_context(lines, idx):
    """Walk up from the fn line collecting attributes and doc comments."""
    attrs = []
    j = idx - 1
    depth_guard = 0
    while j >= 0 and depth_guard < 40:
        s = lines[j].strip()
        depth_guard += 1
        if s == "" or s.startswith("///") or s.startswith("//"):
            j -= 1
            continue
        if s.startswith("#["):
            attrs.append(s)
            j -= 1
            continue
        if s.endswith(")]") or s.endswith(",") or s.startswith(")"):
            # tail of a multi-line attribute
            attrs.append(s)
            j -= 1
            continue
        break
    return attrs


def in_cfg_test_module(lines, idx, path):
    if "/tests/" in path.replace("\\", "/") or path.replace("\\", "/").startswith("tests/"):
        return True
    for j in range(idx, -1, -1):
        if re.match(r"\s*#\[cfg\(test\)\]", lines[j]):
            return True
        if re.match(r"\s*#\[cfg\(all\(test", lines[j]):
            return True
    return False


def body(lines, idx, cap=70):
    out = []
    depth = 0
    opened = False
    for j in range(idx, min(len(lines), idx + 400)):
        line = lines[j]
        out.append(line)
        clean = re.sub(r'"(\\.|[^"\\])*"', '""', line)
        clean = re.sub(r"//.*", "", clean)
        depth += clean.count("{") - clean.count("}")
        if "{" in clean:
            opened = True
        if opened and depth <= 0:
            break
        if len(out) >= cap:
            out.append("    ... (truncated)")
            break
    return out


def classify(path, lines, idx):
    line = lines[idx]
    s = line.strip()
    ext = path.rsplit(".", 1)[-1]
    info = {"kind": "", "attrs": [], "gates": []}
    if ext == "rs":
        is_fn = bool(re.search(r"\bfn\s+\w+", s))
        attrs = rust_context(lines, idx) if is_fn else []
        info["attrs"] = attrs
        is_test = any(TEST_ATTRS.search(a) for a in attrs)
        for a in attrs:
            if re.search(r"#\[\s*ignore", a):
                info["gates"].append("ignored")
            if "cfg_attr(miri" in a and "ignore" in a:
                info["gates"].append("miri-ignored")
            m = re.search(r"#\[cfg\((.*)\)\]", a)
            if m:
                info["gates"].append("cfg(" + m.group(1) + ")")
            if "should_panic" in a:
                info["gates"].append("should_panic")
        if is_test:
            info["kind"] = "test"
        elif is_fn and in_cfg_test_module(lines, idx, path):
            info["kind"] = "helper-fn-in-test-code"
        elif is_fn:
            info["kind"] = "non-test-fn"
        elif re.search(r"fuzz_target!", s):
            info["kind"] = "fuzz-target"
        elif s.startswith("//"):
            info["kind"] = "comment"
        else:
            info["kind"] = "other-line"
    elif ext in ("js", "mjs", "ts", "cjs"):
        if re.search(r"\b(it|test)(\.\w+)?\s*\(", s):
            info["kind"] = "test"
            if re.search(r"\b(it|test)\.(skip|todo)", s):
                info["gates"].append("skipped")
        else:
            info["kind"] = "other-line"
    elif ext == "py":
        if re.search(r"def test_\w+", s):
            info["kind"] = "test"
        else:
            info["kind"] = "other-line"
    elif ext == "md":
        info["kind"] = "doc-page"
    else:
        info["kind"] = "other-line"
    return info


def main():
    reg = tomllib.load(open(os.path.join(ROOT, "docs/standards.toml"), "rb"))
    current = reg["current_release"]
    rows = []
    for e in reg["entry"]:
        if e["release"] > current:
            continue
        path = os.path.join(ROOT, e["evidence"])
        row = {
            "key": e["key"],
            "chapter": e["chapter"],
            "anchor": e["anchor"],
            "release": e["release"],
            "evidence": e["evidence"],
            "at": e["at"],
            "subject": e["subject"],
            "designation": e["designation"],
            "url": e["url"],
            "note": e.get("note", ""),
        }
        if not os.path.isfile(path):
            row.update(status="missing-file", matches=0, line=None, kind="", gates=[], attrs=[], text="")
            rows.append(row)
            continue
        lines = read_lines(path)
        hits = [i for i, l in enumerate(lines) if e["at"] in l]
        row["matches"] = len(hits)
        if len(hits) != 1:
            row.update(
                status="no-match" if not hits else "multi-match",
                line=[h + 1 for h in hits],
                kind="",
                gates=[],
                attrs=[],
                text="",
            )
            rows.append(row)
            continue
        idx = hits[0]
        info = classify(e["evidence"], lines, idx)
        row.update(
            status="ok" if info["kind"] == "test" else "not-a-test",
            line=idx + 1,
            kind=info["kind"],
            gates=info["gates"],
            attrs=info["attrs"],
            text=lines[idx].strip(),
            body=body(lines, idx),
        )
        rows.append(row)

    os.makedirs(os.path.join(OUT, "bodies"), exist_ok=True)
    with open(os.path.join(OUT, "rows.tsv"), "w", encoding="utf-8") as tsv:
        tsv.write("key\tchapter\tanchor\tstatus\tkind\tmatches\tline\tgates\tevidence\tat\n")
        for r in rows:
            tsv.write(
                "\t".join(
                    str(x)
                    for x in (
                        r["key"],
                        r["chapter"],
                        r["anchor"],
                        r["status"],
                        r["kind"],
                        r["matches"],
                        r["line"],
                        ";".join(r["gates"]),
                        r["evidence"],
                        r["at"],
                    )
                )
                + "\n"
            )
    with open(os.path.join(OUT, "rows.json"), "w", encoding="utf-8") as js:
        json.dump(rows, js, indent=1)

    by_chapter = collections.defaultdict(list)
    for r in rows:
        by_chapter[r["chapter"]].append(r)
    for chapter, rs in by_chapter.items():
        with open(os.path.join(OUT, "bodies", chapter + ".txt"), "w", encoding="utf-8") as fh:
            for r in rs:
                fh.write("=" * 8 + " " + r["key"] + " [" + r["anchor"] + "] " + r["status"] + "\n")
                fh.write("SUBJECT: " + r["subject"] + "\n")
                fh.write("SOURCE: " + r["designation"] + " " + r["url"] + "  NOTE: " + r["note"] + "\n")
                fh.write("AT: " + r["evidence"] + ":" + str(r["line"]) + "  gates=" + ",".join(r["gates"]) + "\n")
                for l in r.get("body", []):
                    fh.write("  | " + l + "\n")
                fh.write("\n")

    status = collections.Counter(r["status"] for r in rows)
    kinds = collections.Counter(r["kind"] for r in rows)
    print("current_release", current, "rows<=current", len(rows))
    print("status", dict(status))
    print("kinds", dict(kinds))
    print("by chapter x status")
    table = collections.Counter((r["chapter"], r["status"]) for r in rows)
    for k in sorted(table):
        print("  ", k, table[k])
    print("by chapter x anchor")
    table = collections.Counter((r["chapter"], r["anchor"]) for r in rows)
    for k in sorted(table):
        print("  ", k, table[k])
    print("gated rows")
    for r in rows:
        if r["gates"]:
            print("  ", r["key"], r["gates"], r["evidence"])
    print("non-ok rows")
    for r in rows:
        if r["status"] != "ok":
            print("  ", r["key"], r["status"], r["kind"], r["evidence"], r["line"], "|", r["text"][:100])
    files = collections.Counter(r["evidence"] for r in rows)
    print("distinct evidence files", len(files))
    for f, n in files.most_common():
        print("  ", n, f)


main()
```
