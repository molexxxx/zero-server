# TechEmpower Framework Benchmarks as the "faster than Drogon" yardstick

Research notes, written incrementally. Every claim marked with a source was fetched during this task (2026-09-29 and 2026-09-30) or measured locally. Anything not backed by a fetched source or a local measurement is labeled unverified.

## 1. Status of the benchmark project (fetched)

- The TechEmpower/FrameworkBenchmarks GitHub repository is archived and read-only as of March 24, 2026 (archive banner observed on https://github.com/TechEmpower/FrameworkBenchmarks/tree/master/frameworks/C++/drogon; GitHub API reported `archived: true`, `pushed_at: 2026-03-24T01:39:18Z` in the sibling salvage-map research).
- Round 23 is the last published round. Announcement: https://www.techempower.com/blog/2025/03/17/framework-benchmarks-round-23/ (fetched 2026-09-30). Completion issue: https://github.com/TechEmpower/FrameworkBenchmarks/issues/9589 "Round 23 Complete" (web search hit, 2026-09-30).
- No Round 24 announcement exists (web search, 2026-09-29).
- The results page https://www.techempower.com/benchmarks/ is a JavaScript shell; a plain fetch returns only the title (re-confirmed 2026-09-30). https://tfb-status.techempower.com/ refused the connection on both days (ECONNREFUSED 173.196.11.130:443).
- The results data used below is the local file `round23-ph.json` (5,027,231 bytes) in this scratch directory, downloaded by the interrupted run. Its header identifies it: `name: "Continuous Benchmarking Run 2025-01-30 18:47:41"`, `uuid: 91a66052-9d86-446c-b31a-eadbd669ed08`, `environmentDescription: "Citrine"`, `git.commitId: 523534bb61450e3522d775a749ad060753e26e3a`, `startTime 1738262861611` (2025-01-30), `completionTime 1738823949043` (2025-02-06). A web search for that uuid resolves it to the Round 23 results at tfb-status.techempower.com/results/91a66052-9d86-446c-b31a-eadbd669ed08, and the Round 23 completion issue is dated February 11, 2025. The file `round22-ph.json` (run 2023-10-11, commit 625684fc) is also present for cross-round comparison.

Consequence for the product goal: "faster than Drogon on TechEmpower" cannot be certified by a future official round. The target has to be defined as a reproducible self-run of the archived toolset (or a fork) against the pinned Round 23 Drogon implementation on identical hardware, with the Round 23 numbers as the reference ordering.

## 2. Hardware and methodology

### 2.1 Round 23 hardware (fetched: Round 23 announcement)

- HPE ProLiant DL360 Gen10 Plus servers, Intel Xeon Gold 6330 at 2.00 GHz, "56 cores" (the announcement's wording; 6330 is a 28-core part, so 56 is the logical thread count: unverified inference), 64 GB memory, Mellanox ConnectX-6 40 Gbps Ethernet. Microsoft provided the hardware.
- The announcement reports roughly 3x improvement on "practical network-bound tests" and 4x on "theoretical network-bound tests" versus the previous environment, and does not state the OS.
- The results JSON still labels the environment "Citrine". The wiki page https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Environment (fetched 2026-09-29) describes the older Citrine machines: Xeon Gold 5120 at 2.20 GHz, 28 hyperthreaded cores, 32 GB, 10 GbE, Ubuntu 18.04.3, kernel 4.15.0-88. Treat the wiki page as stale for Round 23; the announcement is authoritative for the hardware.
- Sysctl tuning documented on the wiki: TCP backlog 65535, connection queue 65535, time-wait reuse, vm.max_map_count 1048576.

### 2.2 Run parameters (measured from round23-ph.json header)

- `duration: 15` seconds per measurement.
- `concurrencyLevels: [16, 32, 64, 128, 256, 512]` for json, db, fortune.
- `pipelineConcurrencyLevels: [256, 1024, 4096, 16384]` for plaintext (pipelined).
- `queryIntervals: [1, 5, 10, 15, 20]` for query and update (at 512 connections).
- `cachedQueryIntervals: [1, 10, 20, 50, 100]` for cached-query.
- Each sample carries `latencyAvg`, `latencyStdev`, `latencyMax`, `totalRequests`, `startTime`, `endTime`, plus error counters. Requests per second in this document = `totalRequests / (endTime - startTime)`, computed by `tfb-extract.js` in this directory; the "best" figure is the maximum over levels, which is how the official results page ranks entries (unverified: the page's exact ranking rule was not fetchable because the page is a JS shell).

### 2.3 Test requirements (fetched: wiki Project-Information-Framework-Tests-Overview)

- JSON: serialize `{"message":"Hello, World!"}`, `Content-Type: application/json`.
- Single query: one random World row (id 1..10000) from a 10,000-row table, ORM where practical.
- Multiple queries: `queries` parameter clamped to 1..500, rows fetched individually (no IN clauses), JSON array.
- Fortunes: fetch all Fortune rows, add "Additional fortune added at request time." in memory, sort by message, render a server-side template with XSS escaping, `text/html; charset=utf-8`.
- Updates: read then update `queries` rows individually (clamped 1..500), persist.
- Plaintext: `Hello, World!`, `text/plain`, must support HTTP pipelining (levels 256 to 16,384 connections).
- Cached queries: `count` 1..500 from CachedWorld via an in-process or separate-process cache.
- Required headers on every response: `Server`, `Date` (may update once per second), `Content-Type`, `Content-Length` or `Transfer-Encoding`.
- No disk logging, no gzip, case-sensitive JSON keys, no application-level caching of database results outside the cached-query test, "Stripped" designation for minimalist HTTP implementations.

## 3. Round 23 numbers per test (measured from round23-ph.json)

All figures are best requests per second across levels (see 2.2). Rank is among all entries in that test. Error counts are the sum of 5xx, write, read, connect and timeout counters across levels.

### 3.1 Plaintext (533 entries, pipelined)

| Rank | Entry | Best RPS | Per level [256, 1024, 4096, 16384] | Errors |
|---|---|---|---|---|
| 1 | mrhttp (Python/C) | 28,384,306 | 18.49M, 28.38M, 27.35M, 18.50M | 2,028 |
| 2 | faf (Rust) | 28,034,705 | 21.93M, 26.27M, 28.03M, 23.20M | 0 |
| 3 | pico.v | 28,025,838 | | 0 |
| 5 | uwebsockets.js (Node) | 27,991,649 | 18.64M, 27.97M, 27.99M, 22.01M | 0 |
| 6 | xitca-web-unrealistic (Rust) | 27,970,357 | 18.33M, 26.19M, 27.97M, 22.18M | 0 |
| 7 | ultimate-express (Node) | 27,324,164 | 18.35M, 27.32M, 24.55M, 22.14M | 0 |
| 8 | ntex-plt (Rust) | 24,925,516 | 18.31M, 24.93M, 22.71M, 17.67M | 0 |
| 10 | ntex-plt-compio (Rust) | 23,164,471 | | 0 |
| 14 | xitca-web (Rust) | 18,436,533 | 13.07M, 18.44M, 16.05M, 15.47M | 0 |
| 27 | ntex (Rust) | 12,706,501 | | 0 |
| 80 | salvo (Rust) | 2,692,195 | | 0 |
| 108 | nodejs | 1,460,302 | | 3,488 |
| 238 | libreactor (C) | 28,025,993 | | 0 |
| 239 | lithium (C++) | 27,953,333 | | 0 |
| 241 | may-minihttp (Rust) | 27,906,423 | 18.32M, 24.42M, 27.91M, 23.75M | 974 |
| 246 | drogon (C++) | 14,655,006 | 12.73M, 14.66M, 13.23M, 11.69M | 0 |
| 304 | aspnetcore-aot | 27,770,995 | | 878 |
| 314 | hyper (Rust) | 17,468,474 | | 0 |
| 325 | axum (Rust) | 12,048,256 | | 0 |

Note on rank ordering: `tfb-extract.js` ranks by the `best` value, but the plaintext ranks above 200 for entries with 27M+ RPS mean the ranking in my first extract pass was computed on a different key for those rows (they were appended after the sort because of a regex-filter side effect in the script). The RPS values themselves are correct; ignore rank numbers above 200 in this table. The corrected ordering by best RPS puts libreactor, lithium, may-minihttp and aspnetcore-aot in the top 10 with 27.8M to 28.0M, and drogon at 14.66M is roughly half of the leaders.

### 3.2 JSON (540 entries)

| Rank | Entry | Best RPS | Per level [16 .. 512] | Errors |
|---|---|---|---|---|
| 1 | libreactor-server (C) | 3,118,331 | | 0 |
| 2 | may-minihttp (Rust) | 3,102,063 | 27.7K, 61.3K, 1.11M, 1.61M, 2.38M, 3.10M | 0 |
| 5 | xitca-web-unrealistic (Rust) | 3,023,263 | | 0 |
| 9 | ntex-plt (Rust) | 2,963,471 | | 0 |
| 12 | ntex-plt-compio (Rust) | 2,899,760 | | 0 |
| 14 | hyper (Rust) | 2,885,610 | | 0 |
| 24 | ntex (Rust) | 2,767,355 | | 0 |
| 28 | uwebsockets.js (Node) | 2,731,253 | | 0 |
| 29 | xitca-web (Rust) | 2,720,330 | 31.1K, 639K, 995K, 1.46M, 1.99M, 2.72M | 0 |
| 34 | axum (Rust) | 2,709,795 | | 0 |
| 55 | aspnetcore | 2,546,481 | | 0 |
| 66 | drogon (C++) | 2,474,350 | 24.9K, 61.6K, 969K, 1.43M, 1.89M, 2.47M | 0 |
| 98 | salvo (Rust) | 2,089,153 | | 0 |
| 146 | ultimate-express (Node) | 1,568,342 | | 0 |
| 197 | nodejs | 1,147,305 | | 0 |
| 229 | fastify (Node) | 844,960 | | 0 |
| 384 | express (Node) | 224,163 | | 0 |

### 3.3 Single query, db (554 entries)

| Rank | Entry | Best RPS | Errors |
|---|---|---|---|
| 1 | xitca-web-unrealistic (Rust) | 1,379,909 | 0 |
| 2 | wizzardo-http (Java) | 1,372,101 | 0 |
| 3 | may-minihttp (Rust) | 1,357,757 | 0 |
| 4 | h2o (C) | 1,348,681 | 0 |
| 5 | ntex-db-compio (Rust) | 1,334,739 | 0 |
| 8 | ntex-db (Rust) | 1,294,048 | 0 |
| 10 | xitca-web (Rust) | 1,266,381 | 0 |
| 13 | xitca-web-orm (Rust) | 1,241,938 | 0 |
| 14 | salvo-pg (Rust) | 1,239,261 | 0 |
| 15 | axum-pg (Rust) | 1,190,767 | 0 |
| 31 | drogon-core (C++) | 1,033,970 | 0 |
| 33 | drogon (C++) | 1,014,116 | 0 |
| 49 | aspnetcore | 844,156 | 0 |
| 69 | uwebsockets.js-postgres (Node) | 711,561 | 0 |
| 114 | ultimate-express-postgres (Node) | 524,416 | 0 |
| 152 | fastify-postgres (Node) | 437,130 | 0 |
| 180 | nodejs-postgresjs-raw (Node) | 371,704 | 0 |
| 326 | nodejs-postgres (Node) | 138,986 | 0 |

### 3.4 Multiple queries, query (535 entries; best is always the 1-query level, so the 20-query level is also listed)

| Rank | Entry | Best RPS (q=1) | RPS at q=20 | Errors |
|---|---|---|---|---|
| 1 | may-minihttp (Rust) | 1,440,112 | 88,108 | 0 |
| 2 | ntex-db (Rust) | 1,378,950 | 88,589 | 0 |
| 3 | xitca-web-unrealistic (Rust) | 1,364,269 | 84,062 | 0 |
| 8 | xitca-web (Rust) | 1,252,762 | 88,535 | 0 |
| 9 | ntex-db-compio (Rust) | 1,245,795 | 88,150 | 0 |
| 10 | axum-pg (Rust) | 1,243,171 | 87,231 | 0 |
| 18 | salvo-pg (Rust) | 1,109,003 | 89,195 | 0 |
| 29 | drogon-core (C++) | 999,446 | 65,211 | 0 |
| 32 | drogon (C++) | 985,657 | 59,192 | 0 |
| 45 | aspnetcore | 846,600 | 85,517 | 0 |
| 69 | uwebsockets.js-postgres (Node) | 686,684 | 81,365 | 0 |
| 146 | fastify-postgres (Node) | 399,710 | 76,157 | 0 |
| 153 | nodejs-postgresjs-raw (Node) | 383,015 | 53,495 | 0 |

Observation: at q=20 the leaders converge at about 88K to 89K RPS (database-bound), while drogon reaches 59K to 65K, so Drogon loses about 30 percent to the Rust leaders at the high end of this test.

### 3.5 Fortunes (518 entries)

| Rank | Entry | Best RPS | Errors |
|---|---|---|---|
| 1 | may-minihttp (Rust) | 1,327,379 | 0 |
| 2 | xitca-web-unrealistic (Rust) | 1,240,072 | 0 |
| 3 | h2o (C) | 1,226,814 | 0 |
| 4 | ntex-db-compio (Rust) | 1,197,352 | 0 |
| 5 | ntex-db (Rust) | 1,134,702 | 0 |
| 6 | xitca-web-orm (Rust) | 1,115,124 | 0 |
| 7 | axum-pg (Rust) | 1,114,266 | 0 |
| 8 | xitca-web (Rust) | 1,075,043 | 0 |
| 13 | drogon-core (C++) | 1,042,653 | 0 |
| 17 | salvo-pg (Rust) | 969,747 | 0 |
| 20 | drogon (C++) | 947,069 | 0 |
| 34 | aspnetcore | 741,878 | 0 |
| 70 | uwebsockets.js-postgres (Node) | 483,035 | 0 |
| 108 | ultimate-express-postgres (Node) | 352,482 | 0 |
| 152 | nodejs-postgresjs-raw (Node) | 283,446 | 0 |
| 164 | fastify-postgres (Node) | 265,827 | 0 |

### 3.6 Updates (484 entries; best is the 1-query level, 20-query level also listed)

| Rank | Entry | Best RPS (q=1) | RPS at q=20 | Errors |
|---|---|---|---|---|
| 1 | xitca-web-unrealistic (Rust) | 560,808 | 63,029 | 0 |
| 3 | ntex-db-compio (Rust) | 477,805 | 55,085 | 0 |
| 4 | may-minihttp (Rust) | 474,901 | 58,532 | 0 |
| 5 | ntex-db (Rust) | 474,071 | 58,143 | 0 |
| 18 | xitca-web (Rust) | 460,416 | 55,676 | 0 |
| 19 | drogon (C++) | 454,275 | 24,034 | 0 |
| 20 | drogon-core (C++) | 454,002 | 39,419 | 0 |
| 23 | salvo-pg (Rust) | 440,075 | 54,695 | 0 |
| 27 | axum-pg (Rust) | 421,458 | 55,709 | 0 |
| 34 | uwebsockets.js-postgres (Node) | 340,883 | 57,876 | 0 |
| 89 | fastify-postgres (Node) | 253,588 | 53,223 | 0 |
| 103 | aspnetcore | 231,891 | 13,854 | 0 |

Observation: Drogon is competitive at q=1 (454K, within 5 percent of the Rust pack) but collapses at q=20 (24K for drogon, 39K for drogon-core versus 55K to 63K for the Rust entries), consistent with its updates being issued as many individual statements rather than one batched statement.

### 3.7 Cached queries (128 entries)

| Rank | Entry | Best RPS (count=1) | RPS at count=100 | Errors |
|---|---|---|---|---|
| 1 | lithium (C++) | 2,986,487 | 283,217 | 0 |
| 4 | wizzardo-http (Java) | 2,813,323 | 254,491 | 0 |
| 8 | salvo-lru (Rust) | 2,391,162 | 1,410,295 | 0 |
| 11 | hyperexpress-mysql (Node) | 2,039,207 | 499,881 | 0 |
| 14 | ultimate-express-postgres (Node) | 1,576,081 | 615,605 | 0 |
| 25 | nodejs-mysql-raw (Node) | 771,297 | 176,801 | 0 |
| n/a | h2o (C) | 2,847,013 | 1,056,212 | 0 |
| n/a | aspnetcore | 2,494,860 | 973,650 | 0 |
| n/a | axum-sqlx (Rust) | 1,112,890 | 657,832 | 0 |

Neither drogon nor drogon-core, nor may-minihttp, xitca-web, ntex or actix, submitted a cached-query implementation in Round 23 (their benchmark_config.json files fetched below contain no `cached_query_url`). salvo-lru is the only entry among the studied Rust frameworks. Beating Drogon here is therefore vacuous; the credible target is the leaders.

### 3.8 Where actix stands (measured from the results JSON status fields)

The Round 23 file's `completed` map records `"actix": "ERROR: Problem starting actix"` and the same error for actix-http, actix-server, actix-web-diesel, actix-web-mongodb and actix-web-pg-deadpool, so actix has no Round 23 numbers at all. Conversely the Round 22 file records `"drogon": "ERROR: Problem starting drogon"` and the same for drogon-core, so Drogon has no Round 22 numbers. Round 22 (October 2023, older Citrine hardware, 10 GbE) figures for actix, measured with `tfb-extract2.js`:

| Test | actix-server | actix | actix-http | actix-web-pg-deadpool | Round 22 leader |
|---|---|---|---|---|---|
| plaintext | 6,970,301 (rank 15) | 4,321,822 | | | aspcore-aot 7,014,299 |
| json | 1,194,186 (rank 9) | 1,140,653 | | | libreactor-server 1,211,777 |
| db | | | 429,377 (rank 21) | 95,275 | ntex-db 628,505 |
| query (q=1) | | | 428,411 (rank 19) | 91,626 | ntex-db 627,981 |
| fortune | | | 405,145 (rank 12) | 97,224 | may-minihttp 585,122 |
| update (q=1) | | | 161,186 (rank 29) | 44,037 | ntex-db-astd 223,590 |

In Round 22 the Rust leaders were ntex-db, xitca-web and may-minihttp in the database tests, the same three that lead in Round 23, so the ordering among Rust entries is stable across two rounds and two hardware generations.

### 3.9 Corrected Round 23 ranks

The first extraction pass had a sort defect (samples with a missing `totalRequests` produced NaN and broke the comparator), which is why some ranks above 200 appeared next to 27M+ plaintext figures in the first draft of this document. `tfb-extract2.js` treats those samples as zero and yields the corrected ranks used throughout section 3: plaintext libreactor 3, lithium 8, libreactor-server 9, may-minihttp 10, aspnetcore-aot 11, aspnetcore 13, just 17, ntex-plt 18, ntex-plt-compio 23, xitca-web 29, hyper 34, drogon 43, ntex 56, axum 64, h2o 75, salvo 165, nodejs 230; cached-query h2o 4, aspnetcore-aot 10, aspnetcore 12, salvo-lru 16, ultimate-express-postgres 30.

### 3.10 The plaintext ceiling is the network link (measured plus arithmetic)

- In Round 23 eleven entries from five languages land between 27.53M and 28.38M RPS (mrhttp, faf, libreactor, pico.v, silverlining-prefork, uwebsockets.js, xitca-web-unrealistic, lithium, libreactor-server, may-minihttp, aspnetcore-aot, aspnetcore). In Round 22 the same kind of cluster sits at 6.97M to 7.01M. The ratio is 4.0, which is exactly the "4x improvements in theoretical network-bound tests" the Round 23 announcement attributes to the new hardware (40 GbE replacing 10 GbE).
- Arithmetic on the fetched request format: pipeline.sh sends `Host: tfb-server`, the plaintext Accept header from plaintext.py (95 characters) and `Connection: keep-alive`, so one pipelined request line plus headers is about 174 bytes. 28.0M requests per second times 174 bytes is 4.87 GB/s, about 39 Gbit/s of inbound payload on a 40 Gbit/s link. On Round 22's 10 GbE link, 7.0M times 174 bytes is 9.7 Gbit/s. The plaintext top is therefore the inbound link bandwidth, not server CPU.
- Consequence: "beating Drogon" on plaintext (14.66M, 52 percent of the ceiling) is a matter of reaching the ceiling with zero errors; no entry can be more than about 1 to 2 percent above 28.0M on that hardware, so "fastest plaintext" is a tie among everyone who saturates the link.
- The JSON test at 512 non-pipelined connections tops out at 3.1M RPS, which is 6,090 requests per connection per second or about 164 microseconds per round trip; Drogon's 2.47M corresponds to 207 microseconds. The JSON test measures per-request latency of the full stack (client, network, server) rather than throughput capacity.

### 3.11 Within-run noise (measured from near-identical pairs in Round 23)

Pairs that share the same HTTP code path in the same run:

- libreactor vs libreactor-server (same C server, two configurations): json 3,098,627 vs 3,118,331 (0.6 percent), plaintext 28,025,993 vs 27,943,941 (0.3 percent).
- xitca-web-orm vs xitca-web-sync (same xitca HTTP stack without io-uring, different ORM path): json 2,692,568 vs 2,697,697 (0.2 percent), plaintext 16,625,598 vs 16,615,548 (0.06 percent).
- elysia-postgres vs elysia-compiled: db 608,945 vs 609,417 (0.08 percent), fortune 284,991 vs 284,974, update 215,348 vs 215,244.
- lithium-postgres vs lithium-postgres-beta: fortune 1,073,846 vs 1,068,560 (0.5 percent).
- drogon vs drogon-core in db (same HTTP stack, ORM vs raw): 1,014,116 vs 1,033,970 (1.9 percent).

So the same code measured in the same run lands within about 1 percent for every test type. Run-to-run variance across separate runs could not be verified (tfb-status.techempower.com, which hosts the continuous runs, was unreachable on both days), so the margins in section 7 assume a run-to-run band wider than the within-run band and require repeated interleaved runs.

## 4. Techniques used by the top entries (fetched from source)

### 4.1 Drogon (C++), frameworks/C++/drogon

- Build: ubuntu:22.04 image, Drogon checked out at commit 96919df488e0ebaa0ed304bbd76bba33508df3cc, `-DCMAKE_BUILD_TYPE=release -DCMAKE_CXX_FLAGS=-flto`, mimalloc 1.6.7 compiled in, launched as `./drogon_benchmark config.json` (drogon) or `config-core.json` (drogon-core). Both dockerfiles fetched.
- config.json and config-core.json (fetched): `threads_num: 0` (defaults to the processor count), one listener on 0.0.0.0:8080, `db_clients: [{rdbms: postgreSQL, host: tfb-database, connection_number: 1, is_fast: true, auto_batch: false}]`, `max_connections: 100000`, `keepalive_requests: 0` and `pipelining_requests: 0` (unlimited), `idle_connection_timeout: 0`, log level WARN, `use_sendfile: true`, `use_gzip: false`. `is_fast: true` is Drogon's per-event-loop fast database client mode (Drogon documentation not yet fetched; see 4.1 follow-up below).
- benchmark_config.json (fetched): `default` = ORM "Micro", `core` = ORM "Raw"; both Postgres, approach Realistic, classification Fullstack; URLs /json, /plaintext, /db, /fortunes, /queries?queries=, /updates?queries= (core omits json and plaintext). No cached_query_url.
- Controllers directory (fetched listing): DbCtrl, DbCtrlRaw, FortuneCtrl, FortuneCtrlRaw, JsonCtrl, PlaintextCtrl, QueriesCtrl, QueriesCtrlRaw, UpdatesCtrl, UpdatesCtrlRaw, World_raw.h. main.cc only loads the config file and calls `drogon::app().run()`.

### 4.2 may-minihttp (Rust), frameworks/Rust/may-minihttp

- Cargo.toml (fetched): may 0.3, may_minihttp 0.1, may_postgres (git rev 917ed78), yarte 0.15 with `bytes-buf` and `json` features (JSON and HTML template), mimalloc, nanorand (wyrand), atoi, smallvec, buf-min. Release profile: opt-level 3, codegen-units 1, panic abort, lto thin, overflow-checks off.
- main.rs (fetched): `may::config().set_pool_capacity(1000).set_stack_size(0x1000)` (4 KiB coroutine stacks), worker threads = `num_cpus::get()`, one `PgConnectionPool` per process sized to the CPU count, connection selected by `id % pool_size`; prepared statements for the world select, the fortune select and 500 pre-prepared UPDATE ... CASE statements (one per query count). JSON encoded by yarte `Serialize` into the response `BytesMut`; fortunes rendered by `ywrite_html!` after appending the extra fortune and sorting.
- may_minihttp crate source (fetched from github.com/Xudong-Huang/may_minihttp master): one coroutine per connection (`go!`), 32 KiB read buffer (`BUF_LEN = 4096 * 8`), nonblocking read loop until WouldBlock, inner loop decodes every complete request in the buffer and writes all responses with one `nonblock_write` (pipelining), `set_nodelay` commented out. Parser: `httparse::Request::parse_with_uninit_headers` with 16/32/64/128 header variants; request headers are borrowed slices into the read buffer (zero-copy). Response encoder: hard-coded prefix `HTTP/1.1 200 Ok\r\nServer: M\r\nDate: ` for 200, `itoa` for Content-Length, date appended from a cached date module; body variants Str, Vec, and in-place buffer.
- I/O model: may is a stackful coroutine runtime over epoll on Linux (unverified from this task's fetches; may's own docs were not fetched). Not io_uring.

### 4.3 xitca-web (Rust), frameworks/Rust/xitca-web

- Cargo.toml (fetched, summarized by the fetch tool): binaries xitca-web (features io-uring, pg, router, template, zero-copy), xitca-web-compio, xitca-web-barebone, xitca-web-diesel, xitca-web-toasty; xitca-http 0.8.2, xitca-server 0.6.1, xitca-web 0.8; optional mimalloc and sonic-rs; several git-pinned dependencies (xitca-postgres, toasty). Release: lto, opt-level 3, codegen-units 1, panic abort.
- benchmark_config.json (fetched): default (Micro, webserver xitca-server), barebone (Platform), compio (Platform), diesel and toasty (Fullstack); all Postgres. The "unrealistic" entry that tops several tables is built from src/db_unrealistic.rs (file list fetched) and is not in the fetched benchmark_config.json summary, so its config entry is unverified.
- main.rs (fetched): `HttpServiceBuilder::h1().io_uring()` on xitca_server::Builder bound to 0.0.0.0:8080; handlers call `cli.db()`, `cli.queries(num)`, `cli.updates(num)`, `cli.fortunes().await?.render_once()`.
- db.rs (fetched): xitca_postgres; statements `SELECT id,message FROM fortune`, `SELECT id,randomNumber FROM world WHERE id=$1`, and a single UPDATE using `unnest` over two INT4 arrays. Multiple queries are issued as a Vec of bound query futures against one borrowed client and then awaited in order (the driver pipelines them on the connection).
- db_pool.rs (fetched): `xitca_postgres::pool::Pool::builder(DB_URL)` with `capacity(1)`, `pool.get().await` per request.
- ser.rs (fetched): JSON via `sonic_rs::to_vec` under the `perf-json` feature, else `serde_json::to_vec`; fortunes rendered by a hand-written Sailfish-style `render_once` using `render_escaped` for id and message.
- util.rs (fetched): `u16::from_radix_10(...).0.clamp(1, 500)` for the queries parameter (atoi crate), `Rand(SmallRng)` for ids 1..10000, DB_URL `postgres://benchmarkdbuser:benchmarkdbpass@tfb-database/hello_world`.
- main_compio.rs (fetched): thread-per-core, `available_parallelism()` threads (56 on the Round 23 box), `core_affinity::set_for_current(id)`, one `compio::runtime::RuntimeBuilder` runtime per thread, `TcpOpts` with reuse_address and reuse_port, xitca-http `Dispatcher::<_, _, _, 64, usize::MAX, usize::MAX>` (64 header slots, unbounded read and write limits), postgres over a `CompIoDriver::from_tcp()` wrapper.

### 4.4 ntex (Rust), frameworks/Rust/ntex

- Cargo.toml (fetched): ntex 3.4.0, ntex-io 3.9, ntex-service 4.5; 12 binaries: ntex, ntex-compio, ntex-neon, ntex-neon-uring (main.rs, web framework), ntex-db* (main_db.rs), ntex-plt* (main_plt.rs, platform); features tokio, compio, neon (polling), neon-uring (io-uring); mimalloc and snmalloc-rs, yarte, sonic-rs and serde_json, custom postgres driver from a GitHub branch. Release: opt-level 3, codegen-units 1, lto thin, panic abort.
- benchmark_config.json (fetched): default/neon/neon-uring (Micro, /json /plaintext), db/db-neon/db-neon-uring (Micro, /db /fortunes /query?q= /update?q=), plt/plt-neon/plt-neon-uring (Stripped, Platform). Only the tokio and compio variants appear in the Round 23 results (ntex, ntex-compio, ntex-db, ntex-db-compio, ntex-plt, ntex-plt-compio); the neon variants were added after the run (unverified).
- main_plt.rs (fetched): `backlog(1024)`, `enable_affinity()`, ntex `h1::Codec` for parsing (not hand parsing), static byte arrays for the JSON, plaintext and 404 heads, `DateService.bset_date_header(buf)` cached date, `sonic_rs::to_writer` JSON, write-backpressure aware poll loop (pipelining), mimalloc global allocator.
- utils.rs (fetched): `IoConfig::new().set_read_buf(65535, 2048, 128).set_write_buf(65535, 2048, 128)` for both the HTTP side and the database side (thread-local SharedCfg), queries parameter clamped `min(500, max(1, q))`.
- main_db.rs and db.rs (fetched): one `db::PgConnection` per worker created by the app factory; tokio_postgres `connect` with the connection task spawned on `ntex::rt::spawn`; three prepared statements (fortune select, world select by id, batch UPDATE via `unnest` arrays); multiple queries pushed as futures into a Vec and awaited in order (pipelined on the one connection); fortunes fetched with `query_raw`, extra row added, sorted with `sort_by`, yarte template.
- main.rs (fetched): ntex web server, `backlog(1024)`, `enable_affinity()`, sonic_rs JSON into a 256-byte buffer, plaintext from a static `Bytes`, mimalloc.

### 4.5 actix (Rust), frameworks/Rust/actix

- Cargo.toml (fetched): package tfb-actix 4.0.0, edition 2024, actix-web 4.9.0; binaries tfb-web, tfb-web-diesel, tfb-http, tfb-server, tfb-web-mongodb, tfb-web-pg-deadpool; diesel, tokio-postgres, deadpool-postgres, mongodb 3.2.5, askama and yarte, serde and simd-json variants; release lto, opt-level 3, codegen-units 1.
- benchmark_config.json (fetched): default (Micro, /json /plaintext), web-diesel, http (Platform, /db /fortunes /queries /updates), server (Stripped Platform, /json /plaintext), web-mongodb, web-pg-deadpool.
- main_server.rs (fetched): actix-server `backlog(1024)`, one `App` future per connection, `actix_http::h1::Codec` decode loop over a 32 KiB read buffer, pre-built HEAD_JSON, HEAD_PLAIN, HEAD_NOT_FOUND byte slices, codec-managed cached date header, simd_json_derive serialization, buffers grown when fewer than 512 bytes remain, snmalloc global allocator.
- main_http.rs (fetched): actix-http, `backlog(1024)`, `KeepAlive::Os`, `client_request_timeout(Duration::ZERO)`, one `Rc<PgConnection>` per worker, yarte `ywrite_html!` fortunes, serde_json `to_writer`.
- main_pg_deadpool.rs (fetched): deadpool pool sized by `CONNECTION_POOL_SIZE`, `/queries` via `FuturesUnordered` of independent pooled queries, updates as one `UPDATE world SET randomnumber = CASE id WHEN $1 THEN $2 ...` statement, yarte fortunes.

### 4.6 salvo (Rust), frameworks/Rust/salvo

- Cargo.toml (fetched, summarized): salvo on hyper, diesel, sqlx, mongodb, deadpool, serde; release lto, codegen-units 1.
- benchmark_config.json (fetched): default (/json /plaintext, webserver Hyper), diesel, pg, pg-pool, mongo, mongo-raw, sqlx, lru (`/cached_queries?q=`).
- main.rs (fetched): thread-per-core with `tokio::runtime::Builder::new_current_thread()` per OS thread (`available_parallelism()` threads), `pipeline_flush(true)` on hyper, SO_REUSEPORT listener via `utils::reuse_listener()`, serde_json `to_vec`, static plaintext body, mimalloc commented out.
- main_pg.rs (fetched): one `PgConnection` per handler per thread, queries clamped `min(500, max(1, count))`, fortunes rendered through a `Display` implementation (markup crate per Cargo.toml summary, unverified).

### 4.7 Fastest Node entries in Round 23

- uwebsockets.js: plaintext 27,991,649 (rank 5), json 2,731,253 (rank 28); uwebsockets.js-postgres: db 711,561, query 686,684, fortune 483,035, update 340,883.
- ultimate-express: plaintext 27,324,164 (rank 7), json 1,568,342; ultimate-express-postgres: db 524,416, fortune 352,482, cached 1,576,081.
- nodejs (bare http module): plaintext 1,460,302 with 3,488 errors, json 1,147,305; nodejs-postgresjs-raw: db 371,704, fortune 283,446.
- fastify: json 844,960, plaintext 1,175,038; express: json 224,163, plaintext 278,631.
- uwebsockets.js (benchmark_config.json and package.json at the Round 23 commit, fetched): classification Platform, `versus: nodejs`, uWebSockets.js pinned to `uNetworking/uWebSockets.js#v20.44.0`, `postgres` 3.4.4 (postgres.js), `slow-json-stringify`; the dockerfile (node:20-slim) runs `npm start` which is `node src/clustered.js`, so it is a multi-process cluster (the worker count is in clustered.js, not fetched). src/server.js uses `DeclarativeResponse` for plaintext, `response.cork()` on database routes, `Server: uWS`.
- ultimate-express (benchmark_config.json fetched): classification Micro, webserver "µws" (uWebSockets.js), Postgres and MySQL variants with `/cached-worlds?count=` cached-query support, `versus: nodejs`.
- The takeaway for the zero-server product: the only Node entries in the top tier are thin JavaScript layers over the C++ uWebSockets core, and even those fall to 690K to 710K on the database tests where the Rust leaders reach 1.3M to 1.4M.

### 4.8 Corrections from the Round 23 commit (523534bb) versus master

Several files above were first fetched from master, which moved on after the run. Re-fetched at the Round 23 commit:

- ntex: package "ntex-bench" 2.0.0 with ntex 2.8, ntex-compio 0.2, ntex-bytes 0.1.21 (simd feature), sonic-rs 0.3.16, yarte 0.15, tokio-postgres fork, mimalloc 0.1.25, snmalloc-rs 0.3.3; six binaries (ntex, ntex-compio, ntex-db, ntex-db-compio, ntex-plt, ntex-plt-compio); features tokio and compio only, io-uring via compio-driver on Linux. The neon variants and ntex 3.x are post-round. The pinned db.rs prepares 500 parameterized `UPDATE ... CASE` statements (one per query count) at connect time and serializes with sonic_rs; the `unnest` form seen on master is post-round. main_plt.rs and main_db.rs: `backlog(1024)`, memory pool `PoolId::P1` with 65535-byte parameters, workers equal to the CPU count, per-worker CPU affinity, `KeepAlive::Os`, timeouts disabled, read and write rate limits disabled.
- xitca-web: five entries in benchmark_config.json: default (Realistic, Micro, io-uring build via tokio-uring), unrealistic (Stripped, Platform, features perf + pg + template), wasm (json and plaintext only), orm (Fullstack, diesel-async), sync (Micro, diesel). Cargo: xitca-http, xitca-io, xitca-server, xitca-service, xitca-unsafe-collection, optional xitca-postgres, sailfish, tokio-uring, core_affinity, mimalloc; release lto true, opt-level 3, codegen-units 1, panic abort; git patches to github.com/HFQR/xitca-web. The pinned db.rs builds `Pool::builder(DB_URL).capacity(1)` and issues multiple queries through `Pipeline::with_capacity_from_buf` (one pipelined batch per request); updates use pre-generated statement strings indexed by count with sorted parameters.
- xitca-web-unrealistic (main_unrealistic.rs and db_unrealistic.rs, fetched): `available_parallelism()` threads (fallback 56), `core_affinity::set_for_current`, `SO_REUSEADDR` and `SO_REUSEPORT` per thread, one `tokio::runtime::Builder::new_current_thread()` runtime per thread with `spawn_local` per connection, xitca-http `Dispatcher` with an "unrealistic" h1 handler, mimalloc, one `xitca_postgres::Client` per thread driven by a `while drv.try_next().await?.is_some() {}` task, `Pipeline::unsync_with_capacity_from_buf(len + 1, buf)` for updates with the source comment "unrealistic as all queries are sent with only one sync point", and the module header pointing at issue 8790. Its own comments list what it omits: no HTTP method check, no dynamic path matching, no error handling ("any db/serialization error will cause process crash"), no signal or shutdown handling, no middleware, no body streaming. Issue 8790 (fetched) is "Most of the best-performing frameworks don't survive temporary db connectivity loss" by itrofimow, March 5, 2024: only 7 of the top 20 recovered from a database restart, and the resilient axum configuration ran at about one sixth of the fast configuration's throughput.
- may-minihttp: pinned Cargo.toml and main.rs match master (may 0.3, may_minihttp 0.1, may_postgres rev 917ed78, yarte 0.15, mimalloc, nanorand wyrand). Verbatim get_worlds: pushes `num` `query_raw` calls into a `SmallVec<[_; 32]>` first, then drains them, so all queries are in flight on the connection before the first result is read (client-side pipelining on one connection). updates: same read pattern, then one `query_one` on `statement.updates[num - 1]` (one of 500 pre-prepared CASE statements) with `num * 3` parameters. Pool: `num_cpus::get()` connections created by parallel coroutines, sorted by `client.id() % size`, `get_connection(id)` clones the client for `id % len`. may's I/O backend is epoll on Linux and kqueue on BSD (src/io/sys/unix contains epoll.rs and kqueue.rs; may's Cargo.toml lists nix and libc, no io-uring, mio or polling; default features io_cancel, io_timeout, work_steal). may_minihttp date.rs: a background coroutine refreshes a fixed 29-byte httpdate string every 500 ms in an `UnsafeCell` behind `unsafe impl Sync`, and `append_date` copies the bytes.
- actix: pinned Cargo.toml lists actix ecosystem 0.13 to 4.3.1, mongodb 2.2.0, askama 0.11, yarte 0.15, v_htmlescape 0.14; the same six binaries. Irrelevant for Round 23 numbers since every actix entry failed to start.
- drogon: pinned dockerfile identical to master (ubuntu:22.04, Drogon commit 96919df488e0ebaa0ed304bbd76bba33508df3cc, `-flto`, mimalloc v1.6.7). The GitHub API dates that Drogon commit April 9, 2024 ("Fix typo in HttpAppFrameworkImpl.cc (#1992)"), so Round 23 measured a Drogon snapshot from April 2024. Pinned config.json adds `"server_header_field": "dg"` and a `SyncPlugin` plugin; SyncPlugin.cc (fetched) registers a `registerSyncAdvice` callback that answers `/json` (jsoncpp `Json::Value` to `newHttpJsonResponse`) and `/plaintext` (`newHttpResponse` with `setBody`) synchronously before routing. This is Drogon's fast path for the two non-database tests; it still allocates a jsoncpp value and a response object per request.
- Drogon FastDbClient (wiki page ENG-08-4, fetched): "FastDbClient will provide higher performance than the normal DbClient" because it shares "the event loop with network IO threads and the main thread"; the framework creates "a separate FastDbClient for each IO's event loop and the main event loop" and "The number of the DB connections per event loop is the value of the DB client connection_number option", so total connections are (threads_num + 1) times connection_number, 57 on the Round 23 box with `connection_number: 1`; it may be used only from IO threads or the main thread, never through the blocking interface, and synchronous transaction creation returns null. Claimed gain "10% to 20%" under extreme load. Drogon's own README (fetched): "C++17/20 based HTTP application framework", "non-blocking I/O network lib based on epoll (kqueue under macOS/FreeBSD)", asynchronous PostgreSQL and MySQL clients, sqlite3 via thread pool, "Support HTTP 1.0/1.1 (server side and client side)"; no HTTP/2 or HTTP/3 statement.
- Drogon controllers (fetched): DbCtrlRaw runs `select * from world where id=$1` through `getFastDbClient()` (lazily cached per controller) and returns `newHttpJsonResponse(obj.toJson())`; QueriesCtrlRaw issues all `queries` selects concurrently with a shared counter and appends `w.toJson()` into a `Json::Value` array; UpdatesCtrlRaw selects individually and then runs one `update world set randomnumber=case id when $1 then $2 ... where id in (...)` statement; UpdatesCtrl (ORM) does `mapper.findByPrimaryKey()` then `mapper.update()` per row, one statement per row, which explains drogon's collapse to 24K at q=20 versus drogon-core's 39K; FortuneCtrlRaw runs `select * from fortune`, sorts with `std::sort` on message, and renders a CSP view via `HttpViewData` and `bodyTemplate_->genText(data)`.
- faf (Rust, plaintext rank 2 at 28,034,705, fetched at the pinned commit): depends only on `faf` from github.com/errantmind/faf, release opt-level 3, lto thin, panic abort, codegen-units 1. main.rs is `#![feature(start, lang_items)]` nightly-only code with `core::intrinsics`, `faf::epoll::go(8080, cb)`, `memcmp` on method and path pointers, and responses assembled at compile time with `const_concat_bytes!` plus a copied date buffer; it serves plaintext only (no JSON in the fetched file). faf's README: "Linux webserver written in Rust", "has no Rust dependencies and can be converted into a `#![no_std]` project", about "400 lines of assembly TEXT, and 7KB binary", epoll in about 200 lines, unsafe throughout, Linux x86_64 and nightly required, payload sizes bounded by `RES_BUFF_SIZE`. This is the existence proof that a no_std-style Rust server reaches the link ceiling; it is also the clearest example of what the "Stripped" classification means.

### 4.9 Technique matrix for the Round 23 Rust leaders

| Technique | may-minihttp | xitca-web (default) | xitca-web-unrealistic | ntex-plt / ntex-db | drogon |
|---|---|---|---|---|---|
| Runtime | may stackful coroutines, work stealing, 4 KiB stacks | xitca-server workers (CPU count) on tokio-uring | one current-thread tokio runtime per core | ntex on tokio (or compio with io-uring) | trantor event loops, threads_num = CPU count |
| Kernel I/O | epoll | io_uring | epoll (tokio) | epoll (tokio) or io_uring (compio) | epoll |
| Thread model | N worker threads, coroutine per connection | worker per logical CPU | thread per core, affinity, SO_REUSEPORT | worker per logical CPU, affinity, backlog 1024 | one event loop per thread |
| HTTP/1 parse | httparse, zero-copy header slices, 16 to 128 header slots | xitca-http h1 | xitca-http Dispatcher, 64 header slots, no method check | ntex h1::Codec | Drogon HttpRequestParser (not fetched) |
| Response write | fixed status prefix, cached 500 ms date, itoa lengths, one write per pipelined batch | xitca-http | precomputed bytes | static header byte arrays, DateService cached date, write backpressure loop | new HttpResponse per request, SyncPlugin short-circuit for json and plaintext |
| JSON | yarte derive into BytesMut | sonic-rs (perf-json) or serde_json | sonic-rs | sonic-rs into a 256-byte buffer | jsoncpp Json::Value |
| DB client | may_postgres, CPU-count pool, client per coroutine by id modulo | xitca-postgres pool capacity 1 per worker | one xitca-postgres Client per thread | tokio-postgres fork, one connection per worker | Drogon FastDbClient, one connection per event loop |
| Multi-query | all query_raw issued before any read (pipelined) | Pipeline batch per request | Pipeline with a single sync point | futures pushed then awaited in order (pipelined) | concurrent callbacks with a counter |
| Updates | 500 pre-prepared CASE statements | pre-generated statement per count, sorted params | same, one sync point | 500 pre-prepared CASE statements | one CASE statement (raw) or one UPDATE per row (ORM) |
| Templating | yarte ywrite_html | sailfish-style render_once with render_escaped | same | yarte | Drogon CSP view |
| Allocator | mimalloc | default (mimalloc optional) | mimalloc | mimalloc (snmalloc available) | mimalloc 1.6.7 |
| Build | opt-level 3, thin LTO, codegen-units 1, panic abort, overflow checks off | fat LTO, codegen-units 1, panic abort | same | thin LTO, codegen-units 1, panic abort | -O release, -flto |

## 5. Load generation and verification details (fetched at the Round 23 commit)

- Load generator: wrk from the Ubuntu 24.04 package (toolset/wrk/wrk.dockerfile installs `wrk` with apt, no pinned version), driven by concurrency.sh, pipeline.sh, query.sh and pipeline.lua.
- concurrency.sh: primer `wrk -d 5 -c 8 -t 8`, then warmup at `-d $duration -c $max_concurrency -t $max_threads` (max_threads = nproc on the client), then one 15-second run per level with `-t min(c, nproc)`, `--timeout 8`, `--latency`, headers `Host`, `Accept`, `Connection: keep-alive`, 2-second sleep between levels. Each level is run once.
- pipeline.sh: same shape with `-s pipeline.lua -- $pipeline`; pipeline.lua concatenates `depth` copies of `wrk.format()` into one request string. plaintext.py sets the depth to 16 and the Accept header to `text/plain,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7`.
- run-tests.py defaults: duration 15, concurrency levels [16, 32, 64, 128, 256, 512], pipeline levels [256, 1024, 4096, 16384], query levels [1, 5, 10, 15, 20], cached-query levels [1, 10, 20, 50, 100], server host tfb-server, database host tfb-database.
- verifications.py: required headers Server, Date, Content-Type, and Content-Length or Transfer-Encoding; Date must parse as `%a, %d %b %Y %H:%M:%S %Z` and must differ between two requests 3 seconds apart (a frozen Date fails); Content-Type regexes `^application/json(; ?charset=(UTF|utf)-8)?$`, `^text/html; ?charset=(UTF|utf)-8$`, `^text/plain(; ?charset=(UTF|utf)-8)?$`; plaintext body must contain "hello, world!" case-insensitively and the route must be at least 10 characters; oversize responses produce a warning.
- PostgreSQL server (toolset/databases/postgres/postgresql.conf): `max_connections = 2000`, `shared_buffers = 256MB`, `work_mem = 64MB`, `wal_level = minimal`, `synchronous_commit = off`, `random_page_cost = 2`, `effective_cache_size = 8GB`, `pg_stat_statements` preloaded; fsync left at default. A 56-thread server with one connection per thread uses 56 or 57 of the 2000 connections; deadpool-style shared pools were the slowest Rust database entries in both rounds (actix-web-pg-deadpool 95K in Round 22, salvo-pg-pool 28K and axum-pg-pool 70K in Round 23 on the db test).

## 6. HTTP versions and the HTTP/3 question

- The whole suite is HTTP/1.1 over plain TCP: wrk builds request strings with `wrk.format` and pipelines by concatenation, every top entry's hand-written encoder writes `HTTP/1.1` status lines (may_minihttp response.rs: `HTTP/1.1 200 Ok\r\nServer: M\r\nDate: `), and there is no TLS, HTTP/2 or HTTP/3 test type in the fetched test-type modules. wrk's README and SCRIPTING file do not state a protocol version, so "wrk is HTTP/1.1 only" is unverified in the strict sense, but nothing in the toolset can exercise anything else.
- Drogon's README lists HTTP 1.0/1.1 only. xitca-web 0.8.3 exposes `http1`, `http2`, `http3` (QUIC through xitca-http, xitca-io, xitca-server), `io-uring`, `openssl` and `rustls` feature flags (docs.rs, fetched). ntex 3.12.3's docs.rs feature list shows tokio, compio, neon, neon-iocp, neon-polling, neon-uring, openssl, rustls and no http2 or http3 flags.
- Consequence for the owner's HTTP/3 head start: it neither helps nor hurts the TechEmpower yardstick. What matters is that the HTTP/3 transport is a separate crate or feature that leaves the HTTP/1.1 hot path free of extra dispatch, and that the shared pieces (router, handler ABI, header map, date cache, JSON writer, database pipeline) are protocol-agnostic so the numbers below apply to both.

## 7. Measurable "beat Drogon" targets

### 7.1 Ground rules for the comparison

1. Self-run the archived toolset at commit 523534bb (or a fork) with the Round 23 Drogon implementation unchanged (Drogon commit 96919df4, config.json with `threads_num: 0`, `is_fast: true`, `connection_number: 1`, SyncPlugin), on the same three-machine layout with a 40 GbE or faster link between client and server, PostgreSQL configured from the toolset's postgresql.conf. Anything else is a different benchmark.
2. Report the Round 23 metric: best 15-second RPS across levels, plus the per-level curve and the highest-level figure, plus the error counters, which must be zero.
3. Because the within-run band for identical code is about 1 percent (section 3.11) and the run-to-run band is unverified, run the Drogon and zero-core pairs interleaved five times and compare medians; a win must hold in every one of the five runs, not only on the median.
4. Publish the ratio (zero-core / drogon) per test, since absolute numbers do not transfer between machines, together with the absolute numbers and the hardware description.

### 7.2 Targets per test (Round 23 reference values, medians of five interleaved runs)

| Test | Drogon Round 23 (best entry) | Minimum credible win | Target that puts zero-core in the Rust top tier | Round 23 top tier reference |
|---|---|---|---|---|
| plaintext (pipelined) | 14,655,006 (drogon; 11.69M at 16,384 connections) | ratio >= 1.10 at every one of the four levels, zero socket errors | >= 27.5M best level on Round 23 hardware (the 40 GbE ceiling) and >= 22M at 16,384 connections | faf 28.03M, may-minihttp 27.91M, aspnetcore-aot 27.77M |
| json | 2,474,350 (drogon) | ratio >= 1.10, so >= 2.72M on Round 23 hardware | >= 3.0M (within 4 percent of the leader) | libreactor-server 3.12M, may-minihttp 3.10M, ntex-plt 2.96M |
| db (single query) | 1,033,970 (drogon-core) | ratio >= 1.10, so >= 1.14M | >= 1.30M | may-minihttp 1.36M, ntex-db-compio 1.33M, ntex-db 1.29M |
| query (q=1 best level) | 999,446 (drogon-core) | ratio >= 1.10, so >= 1.10M | >= 1.30M | may-minihttp 1.44M, ntex-db 1.38M |
| query (q=20 level) | 65,211 (drogon-core), 59,192 (drogon) | ratio >= 1.25, so >= 81.5K | >= 88K (database-bound plateau shared by all leaders) | may-minihttp 88.1K, ntex-db 88.6K, salvo-pg 89.2K |
| fortunes | 1,042,653 (drogon-core) | ratio >= 1.10, so >= 1.15M | >= 1.25M | may-minihttp 1.33M, h2o 1.23M, ntex-db-compio 1.20M |
| updates (q=1 best level) | 454,275 (drogon) | ratio >= 1.10, so >= 500K | >= 520K | ntex-db-compio 478K, may-minihttp 475K (xitca-web-unrealistic 561K is Stripped) |
| updates (q=20 level) | 39,419 (drogon-core), 24,034 (drogon) | ratio >= 1.40 versus drogon-core, so >= 55K | >= 58K | may-minihttp 58.5K, ntex-db 58.1K |
| cached queries (count=1 and count=100) | no Drogon entry | not applicable | >= 2.5M at count=1 and >= 1.0M at count=100 | h2o 2.85M and 1.06M, salvo-lru 2.39M and 1.41M |

Notes on the margins:

- 10 percent is ten times the within-run band measured in section 3.11 and about twice the spread of the Round 23 json top ten (3.12M to 2.95M, 5.5 percent), so a 10 percent win cannot be explained by placement noise. For the q=20 columns the gap between Drogon and the plateau is already 25 to 60 percent, so a larger ratio is required to be meaningful there; falling short of the plateau on those columns would mean the database pipeline is not saturating the connection.
- The plaintext "top tier" target is a ceiling, not a race: once the link is saturated with zero errors the entry is tied for first. On other hardware, state the ceiling measured with a reference server (faf or libreactor) and target 98 percent of it.
- Every target applies to the Realistic classification. A Stripped or unrealistic build (no method check, no error handling, single sync point) may be published for comparison but does not count.
- Resilience gate (from issue 8790): the entry must survive a database restart during the run without hanging or returning 5xx afterward, at no more than a 5 percent throughput cost versus the non-resilient configuration. None of the Round 23 Rust leaders documented this.

### 7.3 Techniques that the numbers say are mandatory

Derived from sections 3 and 4 (each line is an inference from fetched code and measured results):

1. One database connection per worker thread with client-side pipelining (all statements written before the first read) and prepared statements; every top-ten database entry does this and every shared-pool entry is 5 to 20 times slower.
2. Batched updates as one statement (CASE or unnest); Drogon's per-row ORM path is the single biggest gap in the table (24K versus 58K at q=20).
3. Precomputed response heads, a cached Date string refreshed on a timer, integer formatting without allocation, and one write per batch of pipelined responses; needed to reach the plaintext ceiling.
4. Zero-copy request parsing with bounded header counts (16 to 64 slots) into borrowed slices.
5. A JSON writer that serializes directly into the output buffer (yarte or sonic-rs style); jsoncpp-style DOM building is Drogon's cost on the json test.
6. Worker per logical CPU with affinity; io_uring is not required (may-minihttp leads three tests on epoll), but the compio io_uring variants of ntex are 1 to 5 percent ahead of their tokio siblings on db and fortunes, and 7 percent behind on plaintext.
7. mimalloc or snmalloc as the global allocator; every leader ships one.
8. Release profile: opt-level 3, LTO, codegen-units 1, panic abort. Overflow checks were disabled by may-minihttp and ntex; the security goal argues for keeping them on and measuring the cost, which is unverified.

## 8. Sources fetched in this task

- https://www.techempower.com/blog/2025/03/17/framework-benchmarks-round-23/
- https://github.com/TechEmpower/FrameworkBenchmarks/issues/9589
- https://github.com/TechEmpower/FrameworkBenchmarks/issues/8790
- https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Framework-Tests-Overview
- https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Environment (fetched 2026-09-29)
- FrameworkBenchmarks at master and at commit 523534bb61450e3522d775a749ad060753e26e3a: frameworks/C++/drogon (benchmark_config.json, README.md, config.toml, drogon.dockerfile, drogon-core.dockerfile, drogon_benchmark/main.cc, config.json, config-core.json, controllers listing, DbCtrlRaw.cc, QueriesCtrlRaw.cc, UpdatesCtrlRaw.cc, UpdatesCtrl.cc, JsonCtrl.cc, PlaintextCtrl.cc, FortuneCtrlRaw.cc, plugins/SyncPlugin.cc); frameworks/Rust/may-minihttp (Cargo.toml, src/main.rs); frameworks/Rust/xitca-web (Cargo.toml, benchmark_config.json, src listing, main.rs, db.rs, db_pool.rs, ser.rs, util.rs, main_compio.rs, main_unrealistic.rs, db_unrealistic.rs); frameworks/Rust/ntex (Cargo.toml, benchmark_config.json, main.rs, main_plt.rs, main_db.rs, db.rs, utils.rs); frameworks/Rust/actix (Cargo.toml, benchmark_config.json, src listing, main_server.rs, main_http.rs, main_pg_deadpool.rs); frameworks/Rust/salvo (Cargo.toml, benchmark_config.json, main.rs, main_pg.rs); frameworks/Rust/faf (Cargo.toml, src/main.rs); frameworks/JavaScript/uwebsockets.js (benchmark_config.json, package.json, dockerfile, src/server.js); frameworks/JavaScript/ultimate-express/benchmark_config.json; toolset/wrk (pipeline.sh, concurrency.sh, pipeline.lua, wrk.dockerfile); toolset/run-tests.py; toolset/test_types/plaintext/plaintext.py; toolset/test_types/verifications.py; toolset/test_types/abstract_test_type.py; toolset/databases/postgres/postgresql.conf; toolset/utils/benchmark_config.py; toolset/benchmark/benchmarker.py.
- https://github.com/Xudong-Huang/may_minihttp (src/http_server.rs, request.rs, response.rs, date.rs)
- https://github.com/Xudong-Huang/may (README, Cargo.toml, src/io/sys and src/io/sys/unix listings), https://docs.rs/may/latest/may/
- https://github.com/Xudong-Huang/may_postgres
- https://github.com/drogonframework/drogon (README), https://github.com/drogonframework/drogon/wiki/ENG-08-4-Database-FastDbClient, https://github.com/drogonframework/drogon/wiki/ENG-08-1-DataBase-DbClient, GitHub API commit 96919df488e0ebaa0ed304bbd76bba33508df3cc
- https://github.com/errantmind/faf (README)
- https://github.com/wg/wrk (README, SCRIPTING)
- https://docs.rs/xitca-server/latest/xitca_server/struct.Builder.html, https://docs.rs/crate/xitca-web/latest/features, https://docs.rs/ntex/latest/ntex/server/struct.ServerBuilder.html, https://docs.rs/crate/ntex/latest/features
- Local measurements: round23-ph.json and round22-ph.json processed by tfb-extract.js and tfb-extract2.js in this directory (Node v24.13.0).

Failed fetches: https://www.techempower.com/benchmarks/ (JavaScript shell, no data), https://tfb-status.techempower.com/ and its results endpoint (ECONNREFUSED), https://drogon.docsforge.com/ (DNS failure), several master-branch paths that no longer exist (xitca-web src/main_iou.rs, actix src/main.rs, ntex src/utils.rs at the pinned commit, uwebsockets.js src/cluster.js, toolset/benchmark/test_types/* at the pinned commit).

## 9. Unverified items

- The 56 "cores" in the Round 23 announcement being 28 physical cores with hyperthreading (the announcement says 56 cores; the part number's core count was not fetched).
- Run-to-run variance across separate TechEmpower runs (continuous-run host unreachable). Only within-run noise was measured.
- The exact ranking rule of the official results page (assumed: maximum RPS across levels).
- The worker count in uwebsockets.js src/clustered.js (file not fetched) and the ultimate-express process model.
- Whether wrk can speak anything other than HTTP/1.1 (its documentation does not say).
- may's scheduler details beyond "work_steal" being a default feature; the Xeon Gold 6330 core count; Drogon's HttpRequestParser implementation (not fetched).
- The runtime cost of keeping overflow checks on in the hot path.
