# zero-server TechEmpower entries

The two entries a self-run of the TechEmpower toolset measures beside the
pinned Round 23 Drogon entry, in the layout of the archived
TechEmpower/FrameworkBenchmarks tree at commit 523534bb
(`frameworks/Rust/<framework>/benchmark_config.json` plus one dockerfile per
test; the ntex entry was the template, read 2026-10-01).

- `default` is the Realistic entry: `crates/zero-bench/src/bin/zero-server.rs`,
  every request through `zero-router`, the `zero-limits` defaults, `Server`
  and `Date` on every response, the json object instantiated and serialized
  per request through `zero-json`'s buffer-direct writer.
- `plt` is the Platform entry: `crates/zero-bench/src/bin/zero-server-plt.rs`,
  the raw HTTP/1.1 handler with no router, declared Stripped and compared with
  the ceiling reference only.

To run the entries in the archived toolset, copy this directory to
`frameworks/Rust/zero-server/` of the tree, with the repository checked out
beside it as the build context the dockerfiles add (`ADD ./ /zero-server`), and
run `tfb --test zero-server zero-server-plt`. The entries bind `0.0.0.0:8080`,
take `--threads <n>` (0, the default, is one worker per logical CPU) and
`--handoff` (one listener with accept handoff instead of a listener per core).

The release profile of the workspace applies: `opt-level = 3`, fat LTO, one
codegen unit, `overflow-checks = true`, `panic = "unwind"`.
