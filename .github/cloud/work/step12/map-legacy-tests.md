# Legacy test map: the zero-server-node vitest corpus for the step 13 legacy runner

Reader notes for steps 12 and 13. Date 2026-10-01. Source tree: `C:\Users\tonyw\Desktop\projects\zero-server\test` (working tree, read only; 25 test files carry uncommitted edits, among them `grpc/grpc.test.js` with 7 more cases than HEAD). Read first: BRIEF.md, zero-core .github/cloud/RULES.md, `.github/cloud/RULES.md`, DESIGN sections 4.4, 5, 7, 8, 10.1, 10.2, 12.3, 15.2, 15.3, ROADMAP R.3 steps 12 and 13 and R.5, and `conformance/api-surface.json` (228 exports, each with `status` and `release`). Cross-checked against the sibling note `map-node-api.md` (D4, D6, D7, D8).

Helper scripts and their raw outputs are beside this file in the scratch directory: `count-tests.js` (12.3 reproduction), `count-head.js` (HEAD versus working tree), `refine.js`, `surface-map.js` (imports mapped onto api-surface releases), `describes.js` (per-describe case counts), `runtime-counts.js` over `vitest-list.json` (runtime case names from `vitest list --json`, which collects without running), `classify.js` (the classification data) and `gen-notes.js` (which writes this file from it). `probe/` holds the two vitest probes cited in section 6.

## 1. Findings

- F1. The 12.3 figures reproduce exactly (128 files, 7,684 static cases; 40 files and 2,970 cases on the Node-object side, 88 and 4,714 off it; the ten suites hold 3,383 = 2,659 + 724), but only when `errors/errors.test.js` (82 cases) is counted on the Node-object side. The pattern list printed in 12.3 does not flag that file (it never touches `res.setHeader`, `req.headers` and the rest; it builds a mock `res` with `headersSent` and `raw`), so a literal rerun of 12.3 gives 39 files and 2,888 cases, and 806 facade-only cases in the ten suites. Which extra pattern flagged it is unknown.
- F2. The 724 are 18 files (table in section 3). None of them starts a server, none calls `doFetch`, and 16 of them load `../../lib/...` paths directly. They are unit tests of 1.x JS modules: ClusterManager (84), LifecycleManager coverage (29), oauth, the 2FA replay store, trustedDevice and webauthn (186), the WebSocket frame codec (60), five gRPC helper classes (158), health checks and cluster metrics (58), error and debug coverage (69), and the env loader (80). Against api-surface.json and section 15.2, only the 69 error and debug cases test something that exists at release 1 in the shape they test it; env is release 2; auth, gRPC and observe are release 3; cluster, lifecycle-coverage and the frame codec are dropped. R.5's "the 724 facade-only cases ... are run at release 1 where their feature exists (app, routing, realtime, errors, env)" therefore yields 69 cases, and routing contributes none of the 724 at all.
- F3. The files that do exercise the facade over HTTP sit on the Node-object side of 12.3 for two lexical reasons that are not Node-object dependencies: they start the server with `http.createServer(app.handler)` (router 12 times, static 12, request 16, response 17, subsystem-errors 14, middleware/integration 35, and so on), and their handlers read `req.url`, `req.method` and `req.headers`, which are own properties of the 1.x `Request` wrapper (`lib/http/request.js` assigns `url`, `method`, `headers`, `query`, `params`, `body`, `locals`, `raw` and more), not `IncomingMessage`. Real Node-object use is `res.raw` and `req.raw` (for example static 2, middleware/security 5, middleware/unit 55, body/security 12) and hand-built mock req/res objects passed to `lib/` internals.
- F4. Proposed release 1 set (section 9): 685 static cases run at release 1, drawn from 20 files through file entries and describe overrides. About 320 of them need the `http.createServer(app.handler)` patch of requirement H2; the rest start servers with `app.listen(0, cb)` or start none.
- F5. `_helpers.doFetch` calls the SDK's own `fetch` (`require('../')`), which api-surface.json places at release 2 (zero-fetch, step 19). The suites depend on 1.x client behavior that WHATWG fetch does not have: router.test.js sends `TRACE` (a forbidden method in the Fetch Standard, section 2.2.1, fetched), request.test.js overrides `Host` (a forbidden request-header, section 2.2.2), object bodies are JSON-encoded by the client, redirects are never followed (WHATWG default mode is `follow`, section 2.2.5), `headers.get` joins arrays and `headers.raw` exists, `arrayBuffer()` returns a Buffer. The legacy runner should therefore carry the 1.x `lib/fetch/index.js` client verbatim as a test utility, not map `fetch` to Node's global `fetch` (map-node-api D4 offers the latter). `errors/errors.test.js` alone uses Node's global `fetch` directly, for plain GET and POST.
- F6. The runner needs the facade to support: one isolate running handlers in the test's own process with no worker spawn (handlers close over test-local state; a vitest file cannot be re-run in a worker), several independent apps per process with overlapping lifetimes (errors.test.js closes one app without awaiting and listens again in the next case), the positional `app.listen(port, [opts], [cb])` returning a server-like EventEmitter with `address()`, `close(cb)` and `listening`, an `app.handler` value the http patch can recognize, and 1.x private members (`app._lifecycle`, `app._server`, `app._extractOpts`, `app._paramHandlers`). Details in section 6.
- F7. `zero-http-types` recognizes only the eight RFC 9110 methods (`crates/zero-http-types/src/method.rs:63-75`; its own test asserts `Method::parse(b"PATCH") == None`), so the router answers PATCH with 501 (`zero-router` test `an_unrecognized_or_unimplemented_method_is_answered_with_501_not_implemented` uses PATCH). The 1.x surface has `app.patch()` and `router.patch()`; router.test.js sends PATCH twice (`all() matches PATCH`, the chained-route case) and http/integration.test.js has a PATCH case too. Either PATCH (RFC 5789) gets a standards row and a method id, or losing it is a 2.0.0 break with a CHANGELOG entry.
- F8. The 2,659 "Node-object" cases are not all recoverable by the step 32 emulation. Large blocks construct mock objects and call 1.x internals directly: middleware/unit (244, every factory called with mock req/res), http/req-res-branches (163, `new Request(mockRaw)`), trust-proxy units (81), the SSEStream unit block (31), the handshake blocks (24), body/security mocks. A Readable and Writable emulation over slot accessors does not give them the 1.x JS functions they call. This proposal drops them as implementation detail (with an exception for the facade-JS modules errorHandler, validate and logger, decision Q4).
- F9. No legacy file exercises release 1 TLS on HTTP/1.1: the only server-side TLS is in http/http2.test.js (h2 over TLS with an `https.get` fallback, release 2) and http/fetch-coverage.test.js (an HTTPS peer for the client, dropped). `createApp()` is never called with options anywhere in the corpus. TLS and listener options need new tests in `bindings/node`.
- F10. Static `it(` counts understate runtime counts where tests are generated: router 45 static, 49 runtime; errors 82, 96 (`it.each`); docs/code-examples 255, 268; docs/manifest-validation 35, 264; packages/scopes 10, 62 (from `vitest list --json`; the other 56 collected files match). `it.each` names embed `%s` of the error class, i.e. the class source text (`class BadRequestError extends HttpError ...`), so case names in errors.test.js change if the classes are reimplemented; manifest overrides should key on describe paths, not those names.

## 2. Method

- Case count: `(^|[^\w.$])(it|test)\(` per file, plus `it.each`/`.skip`/`.only`/`.todo` modifiers counted separately (5 in the corpus: errors 1, manifest-validation 2, webrtc/ice 2). This is the 12.3 method and gives 7,684.
- 12.3 flag: the 14 patterns printed in 12.3, word-anchored. Flag differences between HEAD and the working tree: only `grpc/grpc.test.js` (380 cases and unflagged at HEAD; 387 and flagged by `req.on` now).
- Release mapping: names destructured from `require('../../')` and from `lib/` paths, looked up by name in `conformance/api-surface.json`; app, req and res members extracted by regex; describe-level counts by attributing each `it(` to the nearest preceding `describe(`.
- Runtime names: `npx vitest list --json` over app, routing, realtime, errors, env, http, middleware, body, auth, grpc, observe, docs and packages (61 files, 4,288 runtime cases). `vitest list` collects without running tests (v4.1.11 CLI docs, fetched); installed vitest is 4.1.11 (`RUN v4.1.11` banner), package.json pins `^4.1.2`. ORM and WebRTC files were not collected (they may open drivers at collection). The repository status after the run showed no new or changed file.

## 3. The 724 facade-only cases (12.3), file by file

| File | Cases | What it tests | Starts a server | Proposed |
| --- | ---: | --- | --- | --- |
| `app/cluster-coverage.test.js` | 25 | ClusterManager fork, exit, respawn, reload, clusterize over node:cluster (mocked) | no | dropped r3 |
| `app/cluster.test.js` | 59 | ClusterManager IPC, broadcast, sticky sessions, metrics, clusterize | no | dropped r3 |
| `app/lifecycle-coverage.test.js` | 29 | LifecycleManager signal handlers, process.exit paths, _drainRequests over Node res mocks | no | dropped r1 |
| `auth/oauth.test.js` | 37 | oauth(), generatePKCE, generateState, provider presets | no | skip r3 |
| `auth/replayStore.test.js` | 14 | InMemoryReplayStore (internal class of twoFactor) | no | skip r3 |
| `auth/trustedDevice.test.js` | 42 | trustedDevice with private _encrypt/_decrypt/_deriveKey/_matchIPSubnet | no | skip r3 |
| `auth/webauthn.test.js` | 93 | webauthn with private CBOR/COSE helpers | no | skip r3 |
| `env/env.test.js` | 80 | env parse(), load() with schema, coercion, accessors, process.env sync | no | skip r2 |
| `errors/debug-coverage.test.js` | 29 | debug logger branches (colors, timestamps, JSON mode, levels) | no | run r1 |
| `errors/errors-coverage.test.js` | 40 | HttpError and framework error class branches, createError | no | run r1 |
| `grpc/balancer.test.js` | 53 | gRPC LoadBalancer, Subchannel, RoundRobinPicker | no | skip r3 |
| `grpc/credentials.test.js` | 35 | gRPC ChannelCredentials, rotating credentials | no | skip r3 |
| `grpc/health.test.js` | 26 | gRPC HealthService | no | skip r3 |
| `grpc/reflection.test.js` | 32 | gRPC ReflectionService, FileDescriptorProto builder | no | skip r3 |
| `grpc/watch.test.js` | 12 | watchProto file watcher | no | skip r3 |
| `observe/health.test.js` | 31 | healthCheck, createHealthHandlers, memory/event-loop/disk checks | no | skip r3 |
| `observe/integration.test.js` | 27 | _defaultIpHash, ClusterManager metrics and sticky, app.health/ready/metrics | no | skip r3 |
| `realtime/connection.test.js` | 60 | WebSocketConnection frame codec (_buildFrame, _onData), send/ping/close over a mock socket | no | dropped r1 |
| total | 724 | | | |

Release 1 runnable in this set: `errors/errors-coverage` (40) and `errors/debug-coverage` (29), both proposed as exceptions to the 12.3 coverage-only drop because they test public behavior of host-only modules that stay JS; `app/cluster.test.js` contributes 2 export checks (LIFECYCLE_STATE, LifecycleManager). Everything else is release 2, release 3 or dropped.

## 4. Suites that exercise the facade over HTTP: server start and client

| File | Server start | Client | Notes |
| --- | --- | --- | --- |
| `routing/router.test.js` | `http.createServer(app.handler)` + `server.listen(0, r)` + `server.address().port`, per describe in `beforeAll`, closed in `afterAll` | `doFetch`, `fetch` (1.x client) | TRACE and PATCH requests |
| `errors/errors.test.js` | `app.listen(0, cb)` returning the server; `server.close()` not awaited, one app per case | Node global `fetch` | 74 of 82 cases run without a server (error classes, errorHandler over a mock res, debug, export checks) |
| `errors/subsystem-errors.test.js` | `http.createServer(app.handler)` | `doFetch` | several describes require `lib/` internals at collection |
| `app/lifecycle.test.js` | `app.listen(0, cb)`; closes through `app._server.close` and `app.shutdown({ timeout })` | `doFetch`, `waitFor` | reads `app._lifecycle` privates throughout |
| `app/api-helpers.test.js` | `http.createServer(app.handler)`; `app.listen(0)` + `app.close()` once | `doFetch`, `fetch` with `redirect: 'manual'` | |
| `app/cookies-orm.test.js` | `http.createServer(app.handler)`; `app.listen(0, cb)` in the branch-coverage describe | `doFetch`, `fetch` | ORM and cookies later releases |
| `http/request.test.js` | `http.createServer(app.handler)` | `doFetch` with `Host` override | |
| `http/response.test.js` | `http.createServer(app.handler)` | `doFetch`, `fetch` | |
| `http/trust-proxy.test.js` | `http.createServer(app.handler)` in 4 describes | `doFetch` with `X-Forwarded-*` | 81 unit cases over `new Request(mockRaw)` |
| `middleware/static.test.js` | `http.createServer(app.handler)` | `doFetch`, `fetch` (HEAD, `If-None-Match`, `Range`) | writes fixture dirs under the test folder |
| `middleware/integration.test.js` | `http.createServer(app.handler)` | `doFetch`, `fetch`, `http.get` | |
| `middleware/security.test.js` | `http.createServer(app.handler)` | `doFetch`, `fetch`, `http.get` | |
| `middleware/csrf-validator.test.js` | `http.createServer(app.handler)` | `doFetch`, `fetch`, raw `http.request` | |
| `realtime/sse.test.js` | `http.createServer(app.handler)` | `http.get` reading the whole stream | streams closed by `setTimeout` after the handler returns |
| `realtime/websocket.test.js` | `app.listen(0)` then `server.on('listening', r)` | raw `net.connect` WebSocket client with hand-built frames | |
| `http/integration.test.js` | one shared `http.createServer(app.handler)` app plus `app.listen(0, cb)` | `doFetch`, `http.request`, `net.connect` | shared setup needs release 2 and 3 features |
| `http/http2.test.js` | `app.listen(0, { http2: true, key, cert })` | `http2.connect`, `https.get` | openssl from `child_process` |

Client-side Node http (`http.get`, `http.request`, `net.connect`) acts as a peer over TCP and needs nothing from the binding. Server-side Node http (`http.createServer(app.handler)`) is the one blocker; `app.handler` is a Node request listener in 1.x (`lib/app.js:97-98`).

## 5. 1.x API calls made by the proposed release 1 set

- `createApp()`: always without arguments (no file passes options).
- App methods: `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `all`, `use(fn)`, `use(prefix, fn | router)`, `route` via `chain(path)`, `group(prefix, ...mw, fn)`, `param(name, fn)` (sync and async), `onError(fn)`, `routes()`, `set`/`get(key)`/`enable`/`enabled`/`disable`/`disabled` (`'trust proxy'` with true, a hop count or CIDR list), `locals`, `ws(path, [opts], handler)`, `listen(port, [opts], [cb])`, `close(cb)`, `shutdown({ timeout })`, `shutdownTimeout(ms)`, `on`/`off('beforeShutdown' | 'shutdown')`, `registerPool`/`unregisterPool`, `trackSSE`, `registerDatabase`/`unregisterDatabase`, `lifecycleState`, `handler`.
- App privates read by tests: `_lifecycle` (`isDraining`, `isClosed`, `activeRequests`, `_emit`, `installSignalHandlers`, `removeSignalHandlers`, `_signalsInstalled`, `_shutdownPromise`, `registerGrpc`, `trackRequest`, `_wsPools`, `_sseStreams`, `_databases`, `_closeWebSockets`, `_closeSSEStreams`, `_closeDatabases`, `_closeServer`), `_server`, `_shutdownPromise`, `_extractOpts`, `_paramHandlers`.
- Router: `Router()`, verbs as on App, `route(path).get().post().delete()`, `use` argument validation (TypeError), `inspect()` with `secure` flags, `routes` array, `{ secure: true }` route option.
- Request: `params` (named and `params[0]`/`params['0']` for wildcards), `query` (100-parameter cap, `__proto__`/`constructor`/`prototype` stripped, malformed escapes tolerated), `url`, `originalUrl`, `baseUrl`, `path`, `method`, `headers`, `get(name)`, `is(type)`, `accepts(...)`, `range(size)`, `fresh`, `stale`, `xhr`, `protocol`, `secure`, `hostname` (X-Forwarded-Host, IPv6 brackets), `subdomains(offset)`, `ip`, `ips`, `locals`, `app`, `body` (null without a parser), `cookies` (`{}` without cookieParser), `id` (requestId).
- Response: `status`, `set` (CR/LF rejected by throwing), `append`, `get`, `vary`, `type` shorthands, `send` (Buffer, string, HTML sniffing, object, null), `json` (circular and BigInt safe), `text`, `html`, `sendStatus`, `redirect([status], url)`, `location`, `links`, `format`, `sendFile(path, { root }, cb)`, `download`, `headersSent`, `sse(opts)`; double-send protection.
- SSE (`res.sse({ retry, autoId, startId, pad, status, headers })`): `send(data, [id])`, `event(name, data, [id])`, `comment`, `sendJSON`, `close`, `connected`, `eventCount`, `bytesSent`, `connectedAt`, `uptime`, `secure`, `data`; response headers asserted: `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`, `x-accel-buffering: no`.
- WebSocket: `app.ws(path, { pingInterval, verifyClient(req) }, (ws, req) => ...)`, `ws.on('message')`, `ws.send`, `ws.sendJSON`; 403 on a refused `verifyClient`, 404 on an unknown path. `WebSocketPool`: `add`, `remove`, `join`, `leave`, `in`, `rooms`, `roomSize`, `roomsOf`, `broadcast(msg, except)`, `broadcastJSON`, `toRoom`, `toRoomJSON`, `clients`, `size`, `closeAll(code, reason)`.
- Middleware factories: `static(dir, { index, extensions, maxAge, setHeaders, dotfiles })` (also through `lib/middleware/static`), `cors({ origin: string | array | suffix, credentials, exposedHeaders, maxAge, methods, allowedHeaders })` (credentials with `*` throws), `helmet({ crossOriginEmbedderPolicy, contentSecurityPolicy, hstsPreload, hstsMaxAge })`, `requestId({ trustProxy, generator, header })`, `logger({ logger, format, colors })`, `validate` (middleware, `validate.field`, `validate.object`), `errorHandler({ log, stack, logger, formatter, onError })`.
- Errors: every class in `lib/errors.js` (HTTP 4xx and 5xx classes, ValidationError, DatabaseError, ConfigurationError, MiddlewareError, RoutingError, TimeoutError, ConnectionError, MigrationError, TransactionError, QueryError, AdapterError, CacheError, TenancyError, AuditError, PluginError, ProcedureError), `createError`, `isHttpError`, `toJSON` shape `{ error, code, statusCode, details }`.
- debug: `debug(ns)` with `info/warn/error/fatal/trace`, `namespace`, `enabled`; module `level`, `enable`, `disable`, `json`, `colors`, `timestamps`, `output`, `reset`, `LEVELS`; `DEBUG` and `DEBUG_LEVEL` env vars.
- env: not in the release 1 set (api-surface release 2); the env suite calls `parse`, `load(schema | path, { override })`, `get`, `has`, `require`, `all`, `reset`, proxy and call access, and `.env.local` handling.
- Deep `lib/` paths a release 1 file loads at collection (must resolve, even where only dropped cases use them, because a skipped describe's callback still runs; section 6): `lib/debug`, `lib/errors`, `lib/middleware/errorHandler`, `lib/middleware/static`, `lib/sse/stream`, `lib/ws/handshake`, `lib/ws/connection`, `lib/http/request` (`compileTrust` destructured at top level), `lib/middleware/{compress,cookieParser,csrf,timeout}`, and for middleware/unit every `lib/middleware/*` plus `lib/errors`. The corpus as a whole references 96 distinct relative paths besides the package root.

## 6. Harness and facade requirements

- H1. Client. Copy 1.x `lib/fetch/index.js` into the shim as the client behind `_helpers.js`'s `require('../')` (the rewrite maps that one require to a client module, so the SDK export `fetch` stays release 2 and `app/exports` does not pass by accident).
- H2. Server start. A vitest `setupFiles` module replaces `require('http').createServer` with a wrapper that returns a server-like EventEmitter (`listen(port, [host], cb)`, `address()`, `close(cb)`, `listening` and `close` events) when the last argument is a facade `app.handler`, and calls the real function otherwise (peer servers in fetch and docs tests). Probed on vitest 4.1.11 and Node 24.13.0: the patch made in a setup file is seen by `require('http')` inside the test file and plain listeners still reach node:http (`probe/http.setup.js`, `probe/http.test.js`, 2 of 2 passed). This replaces adding `http` to the scripted require rewrite. The facade must expose `app.handler` as a tagged value (calling it can throw).
- H3. Inline isolate. `app.listen` in the legacy runner must run handlers on the calling isolate with no `worker_threads` spawn (DESIGN 8.5 spawns workers that re-run the entry module, which in vitest is the runner, and handlers close over test state). Same as map-node-api D7.
- H4. Multiple apps. Several apps per process, each with its own routes, listening on port 0, with overlapping lifetimes (a new listen while the previous app is still closing). The process-global route table of DESIGN 8.5 and `map-abi-state.md` must become per-server (a handle from `zero_server_start`) or the legacy files cannot run. vitest 4 runs each file in its own child process by default (`pool` default `'forks'`, v4.vitest.dev, fetched), so cross-file sharing is not an issue; within-file sharing is.
- H5. Positional listen. `listen(port, [opts], [cb])` returning the server synchronously (websocket.test.js attaches `on('listening')` after the call; errors.test.js reads `address()` in the callback). The release 1 `listen({ port, tls })` form can coexist (map-node-api already notes both forms).
- H6. Privates. LifecycleManager ported from 1.x with its member names (lifecycle.test.js reads `app._lifecycle` and 17 LifecycleManager members, most of them private); `app._server` with `close(cb)`; `app._extractOpts` and `app._paramHandlers` for cookies-orm branch coverage (or drop that describe).
- H7. Manifest gate. A second setup file wraps the globals `describe`, `it` and `test` (and their `.each`, `.skip`, `.only`, `.todo`) so a manifest entry that is not `run` registers as `it.skip`. Probed: a named case was skipped without editing the test file (`probe/gate.setup.js`, `probe/gate.test.js`: 1 passed, 1 skipped). Also probed: the callback of `describe.skip` still executes at collection (requires inside it run) while its `beforeAll` does not, and a describe whose cases are all skipped does not run its `beforeAll` (`probe/skip.test.js`). Consequences: a describe-level override keeps a later-release `beforeAll` from running; a file-level `run` file must still load every `lib/` path it references, so the shim provides stub modules that throw on use, not on require.
- H8. Copy hygiene. Copy from a pinned commit of zero-server-node, not the working tree. Exclude `test/test.js` (a standalone script, not collected: vitest 4 `include` default is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, fetched) and `test/body/tmp-mp-boost-31488/` (16 stray multipart upload files). static.test.js and others create fixture folders next to themselves at run time, so the legacy folder must be writable in CI.

## 7. Behavior deltas the release 1 set will hit

- 405 versus 404: router.test.js expects 404 for a method a path does not allow (TRACE on a GET route, PATCH on a chained route); zero-router answers 405 with `Allow`, and 501 for PATCH today (F7). Proposed as `dropped` with a CHANGELOG anchor (overrides in the manifest).
- PATCH: `all() matches PATCH` fails until PATCH is a method (F7).
- Trailing slash: 1.x matches `/path/` for `/path`; zero-router defaults to `TrailingSlash::Ignore` (`lib.rs:365-371`), so it passes.
- Global middleware before matching: router.test.js `Error Handling Edge Cases` throws from an `app.use` function keyed on `req.url` and expects the custom `onError` 500; 404 cases run through global middleware in 1.x. Same issue as map-node-api D8.
- Error bodies: errors.test.js expects a plain thrown `Error` to answer 500 with its message in `error` (map-node-api item 11 notes the same pin).
- SSE headers: the suite asserts `connection: keep-alive` and `x-accel-buffering: no` on an HTTP/1.1 SSE response; zero-sse must emit both or the case moves to `dropped` with an anchor.
- Static MIME: static.test.js expects `application/javascript` for `.js`; whichever type zero-mime emits decides the case (not checked in zero-mime here).
- Response header validation: response.test.js and security.test.js expect `res.set`/`res.append` to throw on CR or LF so the handler can catch it; DESIGN 8.1 has `zero_res_header` return `InvalidArgument`, so the facade must turn that status into a throw.

## 8. Inventory: every file

Side: `node` means the file is on the Node-object side of the 12.3 split as reproduced in F1 (40 files, errors.test.js included); `facade` means the other 88 files, of which the 18 in the ten HTTP suites hold the 724. Release and status are the proposed file-level entry; describe overrides are in section 10.

| File | Cases | Runtime | Side | 1.x feature | Release | Status | Reason |
| --- | ---: | ---: | --- | --- | ---: | --- | --- |
| `app/api-helpers.test.js` | 28 | 28 | node | App settings, chain(), group(), param(), req.app/originalUrl/baseUrl, res.location/links/format, app.close(), debug | 1 | run | createApp surface (release 1 facade) and debug (host-only, release 1) |
| `app/cluster-coverage.test.js` | 25 | 25 | facade | ClusterManager fork, exit, respawn, reload, clusterize over node:cluster (mocked) | 3 | dropped | 15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads); 12.3 coverage-only file |
| `app/cluster.test.js` | 59 | 59 | facade | ClusterManager IPC, broadcast, sticky sessions, metrics, clusterize | 3 | dropped (+overrides) | 15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads) |
| `app/cookies-orm.test.js` | 66 | 66 | node | cookieParser, res.cookie options, ORM scopes and queries, app locals, App private branches | 3 | skip (+overrides) | ORM describes need step 25; cookie describes need step 18 |
| `app/exports.test.js` | 40 | 40 | node | Export presence per name; d.ts and runtime shape checks | 3 | skip (+overrides) | one case per export, each at that export's api-surface release |
| `app/lifecycle-coverage.test.js` | 29 | 29 | facade | LifecycleManager signal handlers, process.exit paths, _drainRequests over Node res mocks | 1 | dropped | 12.3 coverage-only file; force-close now happens in Rust |
| `app/lifecycle.test.js` | 53 | 53 | node | LifecycleManager, app.on/off, shutdown and drain, registerPool/trackSSE/registerDatabase, signal handlers | 1 | run | LifecycleManager and LIFECYCLE_STATE are release 1 facade exports |
| `auth/authorize.test.js` | 29 | 29 | node | authorize, can, canAny, Policy, gate over jwt | 3 | skip | authorize is release 3 (step 26) |
| `auth/enrollment.test.js` | 22 | 22 | node | 2FA enrollment flow over mock res | 3 | skip | enrollment is release 3 (step 26) |
| `auth/integration.test.js` | 17 | 17 | node | JWT, sessions, OAuth, authorize together over HTTP | 3 | skip | needs steps 18, 19 and 26 |
| `auth/jwt.test.js` | 79 | 79 | node | jwt middleware, jwtSign/Verify/Decode, jwks, tokenPair, refresh tokens | 2 | skip | JWT and JWKS are release 2 (step 19) |
| `auth/oauth.test.js` | 37 | 37 | facade | oauth(), generatePKCE, generateState, provider presets | 3 | skip | OAuth is release 3 (step 26) |
| `auth/replayStore.test.js` | 14 | 14 | facade | InMemoryReplayStore (internal class of twoFactor) | 3 | skip | two-factor is release 3 (step 26); not an api-surface export, drop at step 26 if 2.0 does not export it |
| `auth/session.test.js` | 37 | 37 | node | session middleware, Session, MemoryStore over cookies | 2 | skip | sessions are release 2 (step 18) |
| `auth/trustedDevice.test.js` | 42 | 42 | facade | trustedDevice with private _encrypt/_decrypt/_deriveKey/_matchIPSubnet | 3 | skip | release 3 (step 26); private-helper cases are drop candidates there |
| `auth/twoFactor.test.js` | 86 | 86 | node | TOTP, backup codes, 2FA middleware over HTTP | 3 | skip | release 3 (step 26) |
| `auth/verify2fa.test.js` | 37 | 37 | node | verify2FA, TOTP middleware over mock res | 3 | skip | release 3 (step 26) |
| `auth/webauthn.test.js` | 93 | 93 | facade | webauthn with private CBOR/COSE helpers | 3 | skip | release 3 (step 26); _cbor/_parseAuthData/_coseToPublicKey cases are drop candidates there |
| `body/multipart-branches.test.js` | 29 | 29 | node | multipart parser branches | 2 | dropped | 12.3 coverage-only file |
| `body/parsers-features.test.js` | 101 | 101 | node | json/urlencoded/text/raw/multipart options | 2 | skip | body parsers are release 2 (step 18) |
| `body/parsers.test.js` | 59 | 59 | node | json/urlencoded/text/raw/multipart basics and limits | 2 | skip | body parsers are release 2 (step 18) |
| `body/security.test.js` | 157 | 157 | node | body parser limits, inflate, prototype pollution, lib/body internals with mocks | 2 | skip | release 2 (step 18); the lib/body/* mock describes are drop candidates there |
| `body/urlencoded.test.js` | 36 | 36 | node | urlencoded extended, depth, parameterLimit, verify | 2 | skip | release 2 (step 18) |
| `docs/code-examples.test.js` | 255 | 268 | facade | Documentation code examples evaluated | 3 | skip | docs data format and guides (step 33) |
| `docs/integration.test.js` | 242 | 242 | node | Documentation examples run against live servers (every capability) | 3 | skip | step 33; spans every capability |
| `docs/manifest-validation.test.js` | 35 | 264 | facade | Docs data format validation and example runner | 3 | skip | transfers with the docs data format (12.3, step 33) |
| `env/env.test.js` | 80 | 80 | facade | env parse(), load() with schema, coercion, accessors, process.env sync | 2 | skip | env.env is release 2 in api-surface.json (zero-env, step 22); see conflict C3 |
| `errors/debug-coverage.test.js` | 29 | 29 | facade | debug logger branches (colors, timestamps, JSON mode, levels) | 1 | run | debug is host-only, release 1; proposed exception to the 12.3 coverage-only drop (public behavior of a module that stays JS) |
| `errors/errors-coverage.test.js` | 40 | 40 | facade | HttpError and framework error class branches, createError | 1 | run | error classes are host-only, release 1; proposed exception to the 12.3 coverage-only drop |
| `errors/errors.test.js` | 82 | 96 | node | Error classes, createError, isHttpError, errorHandler over mocks, debug, thrown errors through routes, app.onError, exports | 1 | run | error registry, errorHandler and debug are release 1 |
| `errors/subsystem-errors.test.js` | 43 | 43 | node | Error paths across param handlers, child routers, res.json safety, ws/sse internals, compress, csrf, cookies, timeout, ORM, rateLimit, errorHandler | 1 | run (+overrides) | release 1 describes run; later describes overridden |
| `grpc/balancer.test.js` | 53 | 53 | facade | gRPC LoadBalancer, Subchannel, RoundRobinPicker | 3 | skip | gRPC is release 3 (step 27) |
| `grpc/credentials.test.js` | 35 | 35 | facade | gRPC ChannelCredentials, rotating credentials | 3 | skip | release 3 (step 27) |
| `grpc/grpc.test.js` | 387 | 387 | node | protobuf codec, framing, metadata, server and client over HTTP/2 | 3 | skip | release 3 (step 27) |
| `grpc/health.test.js` | 26 | 26 | facade | gRPC HealthService | 3 | skip | release 3 (step 27) |
| `grpc/reflection.test.js` | 32 | 32 | facade | gRPC ReflectionService, FileDescriptorProto builder | 3 | skip | release 3 (step 27) |
| `grpc/watch.test.js` | 12 | 12 | facade | watchProto file watcher | 3 | skip | release 3 (step 27) |
| `http/fetch-coverage.test.js` | 26 | 26 | node | 1.x fetch client branches against Node and HTTPS peers | 2 | dropped | 12.3 coverage-only file |
| `http/fetch.test.js` | 20 | 20 | node | 1.x fetch client: JSON, timeout, AbortSignal, progress, User-Agent | 2 | skip | fetch is release 2 in api-surface.json (zero-fetch, step 19) |
| `http/http2.test.js` | 37 | 37 | node | HTTP/2 h2c and TLS, ALPN fallback, res.push, pushAssets | 2 | skip (+overrides) | HTTP/2 is release 2 (step 15); push describes dropped |
| `http/integration.test.js` | 58 | 58 | node | One shared app: body parsers, static, res helpers, methods, multipart, router, SSE, compression, WebSocket, requireSecure, secure routes | 3 | skip | the shared beforeAll registers json/urlencoded/text/raw/multipart (step 18) and compress (step 30) |
| `http/req-res-branches.test.js` | 163 | 163 | node | lib/http/request and response classes over mock raw objects | 1 | dropped | 12.3 coverage-only file; 12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate |
| `http/request.test.js` | 58 | 58 | node | Request: path, hostname, xhr, protocol, fresh/stale, accepts, range, get, is, subdomains, query limits, __proto__ stripping, ip | 1 | run | Request facade over the release 1 head accessors; trust proxy is in the release 1 policy subset |
| `http/response.test.js` | 57 | 57 | node | Response: set/append CRLF guard, sendStatus, vary, cookie, sendFile/download, redirect, type, send, get, text/html, status chain, format | 1 | run (+overrides) | Response facade; cookie describes overridden to release 2 |
| `http/trust-proxy.test.js` | 91 | 91 | node | compileTrust, req.ip/ips/protocol/secure/hostname over mock raw, integration through a server | 1 | run (+overrides) | integration describes run; unit describes over new Request(mockRaw) dropped |
| `middleware/csrf-validator.test.js` | 42 | 42 | node | csrf middleware and validate middleware and helpers | 2 | skip (+overrides) | csrf and json() are release 2; validator helper describes overridden to release 1 |
| `middleware/integration.test.js` | 73 | 73 | node | helmet, timeout, requestId, cookieParser, cors, rateLimit, compress, logger, chaining, path-scoped middleware over HTTP | 1 | run (+overrides) | helmet, cors, requestId and logger describes are release 1; others overridden |
| `middleware/security.test.js` | 127 | 127 | node | CRLF, prototype pollution, traversal, body limits, cookies, helmet, ORM adapter injection guards, cors, rateLimit, compress | 3 | skip (+overrides) | mixed; release 1 describes overridden to run |
| `middleware/static.test.js` | 31 | 31 | node | static(): traversal, null byte, dotfiles, index, extensions, maxAge, setHeaders, MIME, HEAD, ETag, 304, Range, 416 | 1 | run (+overrides) | static files are release 1 (zero-static, step 9) |
| `middleware/unit.test.js` | 244 | 244 | node | Every middleware factory called directly with mock req/res | 1 | dropped (+overrides) | 12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (tier 0 rules in zero-policy and zero-static) |
| `observe/health.test.js` | 31 | 31 | facade | healthCheck, createHealthHandlers, memory/event-loop/disk checks | 3 | skip (+overrides) | observability is release 3 (step 28); the three checks are dropped |
| `observe/integration.test.js` | 27 | 27 | facade | _defaultIpHash, ClusterManager metrics and sticky, app.health/ready/metrics | 3 | skip (+overrides) | release 3 (step 28); ClusterManager describes dropped |
| `observe/logger.test.js` | 38 | 38 | node | Logger and structuredLogger | 3 | skip | release 3 (step 28) |
| `observe/metrics.test.js` | 57 | 57 | node | Counter, Gauge, Histogram, MetricsRegistry, metrics middleware and endpoint | 3 | skip | release 3 (step 28) |
| `observe/tracing.test.js` | 66 | 66 | node | Span, Tracer, traceparent, tracing middleware, instrumentFetch | 3 | skip | release 3 (step 28) |
| `orm/adapters/constructors.test.js` | 77 |  | facade | Adapter constructors and option validation | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/initialization.test.js` | 77 |  | facade | Adapter initialization, including the JSON file adapter | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/methods.test.js` | 66 |  | facade | Adapter method surface | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/mongo.test.js` | 63 |  | facade | Mongo adapter over a mocked driver | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/mysql.test.js` | 88 |  | facade | MySQL adapter over a mocked driver | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/postgres-coverage.test.js` | 92 |  | facade | PostgreSQL adapter branches over a mocked driver | 3 | dropped | 12.3 coverage-only file |
| `orm/adapters/postgres.test.js` | 83 |  | facade | PostgreSQL adapter over a mocked driver | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/redis.test.js` | 168 |  | facade | Redis adapter | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/sql-base.test.js` | 49 |  | facade | Shared SQL adapter base | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/adapters/sqlite-coverage.test.js` | 48 |  | facade | SQLite adapter branches | 3 | dropped | 12.3 coverage-only file |
| `orm/adapters/sqlite.test.js` | 50 |  | facade | SQLite adapter | 3 | skip | assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates |
| `orm/audit.test.js` | 84 |  | facade | ORM audit | 3 | skip | ORM is release 3 (step 25) |
| `orm/branches.test.js` | 776 |  | facade | ORM branches | 3 | dropped | 12.3 coverage-only file |
| `orm/cache-redis.test.js` | 17 |  | facade | ORM cache redis | 3 | skip | ORM is release 3 (step 25); Query.cache() cases are dropped by 15.2 at step 25 |
| `orm/cache.test.js` | 47 |  | facade | ORM cache | 3 | skip | ORM is release 3 (step 25); Query.cache() cases are dropped by 15.2 at step 25 |
| `orm/cli-coverage.test.js` | 28 |  | facade | ORM cli coverage | 3 | dropped | 12.3 coverage-only file |
| `orm/cli.test.js` | 47 |  | facade | ORM cli | 3 | skip | ORM is release 3 (step 25) |
| `orm/computed-casts.test.js` | 31 |  | facade | ORM computed casts | 3 | skip | ORM is release 3 (step 25) |
| `orm/database-schema.test.js` | 34 |  | facade | ORM database schema | 3 | skip | ORM is release 3 (step 25) |
| `orm/events-observers.test.js` | 30 |  | facade | ORM events observers | 3 | skip | ORM is release 3 (step 25) |
| `orm/geo.test.js` | 49 |  | facade | ORM geo | 3 | skip | ORM is release 3 (step 25) |
| `orm/linq.test.js` | 201 |  | facade | ORM linq | 3 | skip | ORM is release 3 (step 25) |
| `orm/migrate.test.js` | 31 |  | facade | ORM migrate | 3 | skip | ORM is release 3 (step 25) |
| `orm/model.test.js` | 104 |  | facade | ORM model | 3 | skip | ORM is release 3 (step 25) |
| `orm/performance.test.js` | 54 |  | facade | ORM performance | 3 | skip | ORM is release 3 (step 25) |
| `orm/plugin.test.js` | 43 |  | facade | ORM plugin | 3 | dropped | 15.2 PluginManager |
| `orm/procedures-coverage.test.js` | 63 |  | facade | ORM procedures coverage | 3 | dropped | 12.3 coverage-only file |
| `orm/procedures.test.js` | 71 |  | facade | ORM procedures | 3 | skip | ORM is release 3 (step 25) |
| `orm/relationships.test.js` | 40 |  | facade | ORM relationships | 3 | skip | ORM is release 3 (step 25) |
| `orm/schema.test.js` | 57 |  | facade | ORM schema | 3 | skip | ORM is release 3 (step 25) |
| `orm/search.test.js` | 45 |  | facade | ORM search | 3 | skip | ORM is release 3 (step 25) |
| `orm/seed-fake.test.js` | 217 |  | facade | ORM seed fake | 3 | skip | ORM is release 3 (step 25); see conflict C6 (Fake, Factory, Seeder) |
| `orm/seed.test.js` | 75 |  | facade | ORM seed | 3 | skip | ORM is release 3 (step 25); see conflict C6 (Fake, Factory, Seeder) |
| `orm/snapshot.test.js` | 45 |  | facade | ORM snapshot | 3 | skip | ORM is release 3 (step 25) |
| `orm/tenancy-coverage.test.js` | 24 |  | node | ORM tenancy coverage | 3 | dropped | 12.3 coverage-only file |
| `orm/tenancy.test.js` | 46 |  | facade | ORM tenancy | 3 | skip | ORM is release 3 (step 25) |
| `orm/views-coverage.test.js` | 18 |  | facade | ORM views coverage | 3 | dropped | 15.2 DatabaseView; 12.3 coverage-only file |
| `orm/views.test.js` | 42 |  | facade | ORM views | 3 | dropped | 15.2 DatabaseView |
| `packages/scopes.test.js` | 10 | 62 | facade | Generated scoped packages manifest and stubs | 3 | dropped | 15.2 packages/ generator and its 14 runtime stubs |
| `packages/webrtc-types.test.js` | 6 | 6 | facade | Generated WebRTC scoped package types | 3 | dropped | 15.2 packages/ generator and its 14 runtime stubs |
| `realtime/connection.test.js` | 60 | 60 | facade | WebSocketConnection frame codec (_buildFrame, _onData), send/ping/close over a mock socket | 1 | dropped | 12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (RFC 6455 framing in zero-ws, asserted by the ws vector section) |
| `realtime/sse.test.js` | 41 | 41 | node | res.sse() over HTTP (headers, retry, ids, pad, status, sendJSON, multiline, comment escaping); SSEStream over a fake raw writable | 1 | run (+overrides) | SSE is release 1; the SSEStream Unit describe is overridden to dropped |
| `realtime/websocket.test.js` | 42 | 42 | node | WebSocketPool with mock connections, app.ws over a raw net client, handleUpgrade over mock sockets | 1 | run (+overrides) | WebSocket is release 1; handshake describes and the bare handshake block are overridden to dropped |
| `routing/router.test.js` | 45 | 49 | node | Wildcards, params, route() chains, inspect(), nested routers, query on mount root, all(), HEAD, handler chains, decoding, trailing slash, router-level middleware, use() validation | 1 | run (+overrides) | router is release 1 (zero-router, step 6) |
| `webrtc/auth.test.js` | 16 |  | facade | Join token auth | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/bot.test.js` | 15 |  | facade | spawnBotPeer | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/cascade-pipe-success.test.js` | 2 |  | facade | Cascade pipe | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/cascade.test.js` | 11 |  | facade | Cascade coordinator | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/cli.test.js` | 16 |  | facade | runWebRTCCommand | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/cluster-region-load.test.js` | 11 |  | facade | Cluster region load | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/cluster.test.js` | 20 |  | facade | Signaling cluster coordinator | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/coverage-batch2.test.js` | 35 |  | facade | Branch coverage | 3 | dropped | 12.3 coverage-only file |
| `webrtc/coverage-batch3.test.js` | 12 |  | facade | Branch coverage | 3 | dropped | 12.3 coverage-only file |
| `webrtc/coverage-small-branches.test.js` | 32 |  | facade | Branch coverage | 3 | dropped | 12.3 coverage-only file |
| `webrtc/createWebRTC.test.js` | 8 |  | facade | createWebRTC | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/e2ee.test.js` | 12 |  | facade | E2EE helpers | 3 | dropped | 15.2 E2EE helpers |
| `webrtc/ice.test.js` | 41 |  | facade | ICE candidate parsing and filtering | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/joinToken-branches.test.js` | 9 |  | facade | Join token branches | 3 | dropped | 12.3 coverage-only file |
| `webrtc/mcu-ffmpeg-branches.test.js` | 11 |  | facade | ffmpeg MCU | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade); 12.3 coverage-only file |
| `webrtc/mcu.test.js` | 15 |  | facade | MCU adapter | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/observe-tracer-branches.test.js` | 4 |  | facade | WebRTC tracer branches | 3 | dropped | 12.3 coverage-only file |
| `webrtc/observe.test.js` | 11 |  | facade | bindObservability | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/recording-branches.test.js` | 8 |  | facade | Recording branches | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade); 12.3 coverage-only file |
| `webrtc/recording.test.js` | 15 |  | facade | Recording and ingress | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/sdp.test.js` | 27 |  | facade | SDP parse and stringify | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/sfu-livekit.test.js` | 30 |  | facade | LiveKit SFU adapter | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/sfu-mediasoup.test.js` | 28 |  | facade | mediasoup SFU adapter | 3 | dropped | 15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade) |
| `webrtc/sfu-memory-branches.test.js` | 4 |  | facade | Memory SFU branches | 3 | dropped | 12.3 coverage-only file |
| `webrtc/sfu.test.js` | 36 |  | facade | SfuAdapter and memory SFU | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/signaling.test.js` | 49 |  | facade | SignalingHub, rooms, peers | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/stun.test.js` | 19 |  | facade | STUN codec and binding | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/turn-credentials.test.js` | 14 |  | facade | TURN REST credentials | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |
| `webrtc/turn-server.test.js` | 17 |  | facade | TURN server | 3 | skip | WebRTC signaling, STUN and TURN are release 3 (step 29) |

Not collected by vitest: `test/test.js` (standalone integration script, 34,973 bytes), `test/_helpers.js` (helpers), `test/body/tmp-mp-boost-31488/*` (16 leftover upload files).

Coverage-only files by name (22; 12.3 says 21 and does not list them): app/cluster-coverage, app/lifecycle-coverage, errors/debug-coverage, errors/errors-coverage, http/fetch-coverage, orm/adapters/postgres-coverage, orm/adapters/sqlite-coverage, orm/cli-coverage, orm/procedures-coverage, orm/tenancy-coverage, orm/views-coverage, webrtc/coverage-batch2, webrtc/coverage-batch3, webrtc/coverage-small-branches, body/multipart-branches, http/req-res-branches, orm/branches, webrtc/joinToken-branches, webrtc/mcu-ffmpeg-branches, webrtc/observe-tracer-branches, webrtc/recording-branches, webrtc/sfu-memory-branches. Two more say "coverage" in their header comment: http/trust-proxy and webrtc/cascade-pipe-success.

## 9. Totals (static cases, after describe overrides)

| Status | Release 1 | Release 2 | Release 3 | Total |
| --- | ---: | ---: | ---: | ---: |
| run | 685 | 0 | 0 | 685 |
| skip | 0 | 715 | 4170 | 4885 |
| dropped | 556 | 74 | 1484 | 2114 |
| total | | | | 7684 |

The release on a `dropped` entry is the release of the feature the file covers, which is when the drop is decided. Release 1 `run` files with every case at release 1: routing/router (45, of which 2 dropped by override), errors/errors (82), errors/errors-coverage (40), errors/debug-coverage (29), app/lifecycle (53), app/api-helpers (28), http/request (58). Files contributing through overrides: middleware/static 30, http/response 50, middleware/integration 50, middleware/security 34, errors/subsystem-errors 19, app/cookies-orm 19, websocket 18, app/exports 15, csrf-validator 13, sse 10, trust-proxy 10, app/cluster 2, middleware/unit 82 (decision Q4). Without Q4 the release 1 total is 603. Under 12.3 as written the release 1 figure would be 724 with only 69 of them runnable.

## 10. Proposed legacy-manifest.json

Shape: R.5's per-file `{ release, status, reason }` plus `needs` (harness requirements of section 6) and `overrides`, a list of `{ match, release, status, reason }` where `match` equals a vitest full name (describe path and case name joined with ` > `, as `vitest list` prints it) or a prefix of one that ends at a ` > ` boundary. The gate resolves a case by the longest matching override, else the file entry. CI rules from R.5 apply to the resolved per-case entry: `run` at or below the current release must pass, `skip` at or below the current release fails the build, `dropped` cites a 15.2 item, a CHANGELOG anchor, or (proposed, conflict C4) a 12.3 implementation-detail or coverage-only reason. CHANGELOG anchors below are proposals.

```json
{
  "schema": 1,
  "source": {"repository":"molexxxx/zero-server-node","path":"test/","commit":"<pinned sha>","note":"copied by the scripted rewrite; tests are never edited"},
  "currentRelease": 1,
  "files": {
    "app/api-helpers.test.js": {"release":1,"status":"run","reason":"createApp surface (release 1 facade) and debug (host-only, release 1)","needs":["httpPatch","legacyFetch","inlineIsolate","lib/debug"]},
    "app/cluster-coverage.test.js": {"release":3,"status":"dropped","reason":"15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads); 12.3 coverage-only file"},
    "app/cluster.test.js": {"release":3,"status":"dropped","reason":"15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads)", "overrides": [
      {"match":"Module exports > exports LIFECYCLE_STATE","release":1,"status":"run","reason":"release 1 facade exports"},
      {"match":"Module exports > exports LifecycleManager","release":1,"status":"run","reason":"release 1 facade exports"},
      {"match":"Module exports > exports ClusterManager class","release":3,"status":"skip","reason":"shim exports, release 3 in api-surface.json"},
      {"match":"Module exports > exports cluster function","release":3,"status":"skip","reason":"shim exports, release 3 in api-surface.json"},
      {"match":"clusterize > returns a ClusterManager instance","release":3,"status":"skip","reason":"clusterize shim, release 3"}
    ]},
    "app/cookies-orm.test.js": {"release":3,"status":"skip","reason":"ORM describes need step 25; cookie describes need step 18","needs":["httpPatch","legacyFetch","inlineIsolate"], "overrides": [
      {"match":"CookieParser - JSON cookies","release":2,"status":"skip","reason":"cookieParser and cookie serialization, release 2 (step 18)"},
      {"match":"CookieParser - static helpers","release":2,"status":"skip","reason":"cookieParser and cookie serialization, release 2 (step 18)"},
      {"match":"CookieParser - timing-safe verification","release":2,"status":"skip","reason":"cookieParser and cookie serialization, release 2 (step 18)"},
      {"match":"res.cookie() - enhanced options","release":2,"status":"skip","reason":"cookieParser and cookie serialization, release 2 (step 18)"},
      {"match":"App locals prototype chain","release":1,"status":"run","reason":"app.locals, release 1"},
      {"match":"app - deep branch coverage","release":1,"status":"run","reason":"createApp verbs, ws(), listen(); reads private _extractOpts and _paramHandlers (privateMembers)"}
    ]},
    "app/exports.test.js": {"release":3,"status":"skip","reason":"one case per export, each at that export's api-surface release", "overrides": [
      {"match":"Module Exports > createApp","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > Router","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > cors","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > static","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > logger","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > helmet","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > requestId","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > WebSocketPool","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > validate","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > version","release":1,"status":"run","reason":"release 1 exports (10 cases)"},
      {"match":"Module Exports > fetch","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > json","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > urlencoded","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > text","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > raw","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > multipart","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > rateLimit","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > timeout","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > cookieParser","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > csrf","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > env","release":2,"status":"skip","reason":"release 2 exports (11 cases)"},
      {"match":"Module Exports > compress","release":3,"status":"skip","reason":"release 3 exports (5 cases)"},
      {"match":"Module Exports > Database","release":3,"status":"skip","reason":"release 3 exports (5 cases)"},
      {"match":"Module Exports > Model","release":3,"status":"skip","reason":"release 3 exports (5 cases)"},
      {"match":"Module Exports > TYPES","release":3,"status":"skip","reason":"release 3 exports (5 cases)"},
      {"match":"Module Exports > Query","release":3,"status":"skip","reason":"release 3 exports (5 cases)"},
      {"match":"TypeScript type definitions validation > index.d.ts exports match runtime exports","release":3,"status":"dropped","reason":"15.2 hand-written types; the generated index.d.ts is checked by the api-surface diff"},
      {"match":"TypeScript type definitions validation > type definition files exist","release":3,"status":"dropped","reason":"15.2 hand-written types; the generated index.d.ts is checked by the api-surface diff"},
      {"match":"TypeScript type definitions validation > createApp returns an object with expected methods","release":1,"status":"run","reason":"release 1 shapes (5 cases)"},
      {"match":"TypeScript type definitions validation > error classes have correct inheritance","release":1,"status":"run","reason":"release 1 shapes (5 cases)"},
      {"match":"TypeScript type definitions validation > WebSocketConnection has expected properties on class","release":1,"status":"run","reason":"release 1 shapes (5 cases)"},
      {"match":"TypeScript type definitions validation > WebSocketPool has expected methods","release":1,"status":"run","reason":"release 1 shapes (5 cases)"},
      {"match":"TypeScript type definitions validation > SSEStream is a constructor","release":1,"status":"run","reason":"release 1 shapes (5 cases)"},
      {"match":"TypeScript type definitions validation > env has expected methods and proxy behavior","release":2,"status":"skip","reason":"env, release 2"},
      {"match":"TypeScript type definitions validation > body parsers return middleware functions","release":2,"status":"skip","reason":"body parsers, release 2"},
      {"match":"TypeScript type definitions validation > Database has expected static/instance methods","release":3,"status":"skip","reason":"ORM and compress, release 3"},
      {"match":"TypeScript type definitions validation > Model has expected static methods","release":3,"status":"skip","reason":"ORM and compress, release 3"},
      {"match":"TypeScript type definitions validation > Query has expected instance methods","release":3,"status":"skip","reason":"ORM and compress, release 3"},
      {"match":"TypeScript type definitions validation > TYPES enum has all expected type constants","release":3,"status":"skip","reason":"ORM and compress, release 3"},
      {"match":"TypeScript type definitions validation > middleware factories return functions","release":3,"status":"skip","reason":"ORM and compress, release 3"}
    ]},
    "app/lifecycle-coverage.test.js": {"release":1,"status":"dropped","reason":"12.3 coverage-only file; force-close now happens in Rust"},
    "app/lifecycle.test.js": {"release":1,"status":"run","reason":"LifecycleManager and LIFECYCLE_STATE are release 1 facade exports","needs":["appListenPositional","legacyFetch","inlineIsolate","privateMembers"]},
    "auth/authorize.test.js": {"release":3,"status":"skip","reason":"authorize is release 3 (step 26)"},
    "auth/enrollment.test.js": {"release":3,"status":"skip","reason":"enrollment is release 3 (step 26)"},
    "auth/integration.test.js": {"release":3,"status":"skip","reason":"needs steps 18, 19 and 26"},
    "auth/jwt.test.js": {"release":2,"status":"skip","reason":"JWT and JWKS are release 2 (step 19)"},
    "auth/oauth.test.js": {"release":3,"status":"skip","reason":"OAuth is release 3 (step 26)"},
    "auth/replayStore.test.js": {"release":3,"status":"skip","reason":"two-factor is release 3 (step 26); not an api-surface export, drop at step 26 if 2.0 does not export it"},
    "auth/session.test.js": {"release":2,"status":"skip","reason":"sessions are release 2 (step 18)"},
    "auth/trustedDevice.test.js": {"release":3,"status":"skip","reason":"release 3 (step 26); private-helper cases are drop candidates there"},
    "auth/twoFactor.test.js": {"release":3,"status":"skip","reason":"release 3 (step 26)"},
    "auth/verify2fa.test.js": {"release":3,"status":"skip","reason":"release 3 (step 26)"},
    "auth/webauthn.test.js": {"release":3,"status":"skip","reason":"release 3 (step 26); _cbor/_parseAuthData/_coseToPublicKey cases are drop candidates there"},
    "body/multipart-branches.test.js": {"release":2,"status":"dropped","reason":"12.3 coverage-only file"},
    "body/parsers-features.test.js": {"release":2,"status":"skip","reason":"body parsers are release 2 (step 18)"},
    "body/parsers.test.js": {"release":2,"status":"skip","reason":"body parsers are release 2 (step 18)"},
    "body/security.test.js": {"release":2,"status":"skip","reason":"release 2 (step 18); the lib/body/* mock describes are drop candidates there"},
    "body/urlencoded.test.js": {"release":2,"status":"skip","reason":"release 2 (step 18)"},
    "docs/code-examples.test.js": {"release":3,"status":"skip","reason":"docs data format and guides (step 33)"},
    "docs/integration.test.js": {"release":3,"status":"skip","reason":"step 33; spans every capability"},
    "docs/manifest-validation.test.js": {"release":3,"status":"skip","reason":"transfers with the docs data format (12.3, step 33)"},
    "env/env.test.js": {"release":2,"status":"skip","reason":"env.env is release 2 in api-surface.json (zero-env, step 22); see conflict C3"},
    "errors/debug-coverage.test.js": {"release":1,"status":"run","reason":"debug is host-only, release 1; proposed exception to the 12.3 coverage-only drop (public behavior of a module that stays JS)","needs":["lib/debug"]},
    "errors/errors-coverage.test.js": {"release":1,"status":"run","reason":"error classes are host-only, release 1; proposed exception to the 12.3 coverage-only drop","needs":["lib/errors"]},
    "errors/errors.test.js": {"release":1,"status":"run","reason":"error registry, errorHandler and debug are release 1","needs":["appListenPositional","inlineIsolate","lib/debug","lib/errors","lib/middleware/errorHandler"]},
    "errors/subsystem-errors.test.js": {"release":1,"status":"run","reason":"release 1 describes run; later describes overridden","needs":["httpPatch","legacyFetch","inlineIsolate","stubs"], "overrides": [
      {"match":"WebSocket sendJSON Safety","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new WebSocketConnection over a mock socket)"},
      {"match":"SSE _formatData Safety","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (private SSEStream._formatData)"},
      {"match":"Compression Error Handling","release":3,"status":"skip","reason":"compress is release 3 (step 30)"},
      {"match":"CSRF Crypto Safety","release":2,"status":"skip","reason":"csrf is release 2 (step 18)"},
      {"match":"CookieParser Safety","release":2,"status":"skip","reason":"cookieParser is release 2 (step 18)"},
      {"match":"Timeout Middleware","release":2,"status":"skip","reason":"timeout is release 2 (step 18)"},
      {"match":"ORM Error Handling","release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
      {"match":"Rate Limiter Error Handling","release":2,"status":"skip","reason":"rateLimit is release 2 (step 18)"},
      {"match":"errorHandler middleware","release":2,"status":"skip","reason":"beforeAll registers json() (release 2, step 18)"}
    ]},
    "grpc/balancer.test.js": {"release":3,"status":"skip","reason":"gRPC is release 3 (step 27)"},
    "grpc/credentials.test.js": {"release":3,"status":"skip","reason":"release 3 (step 27)"},
    "grpc/grpc.test.js": {"release":3,"status":"skip","reason":"release 3 (step 27)"},
    "grpc/health.test.js": {"release":3,"status":"skip","reason":"release 3 (step 27)"},
    "grpc/reflection.test.js": {"release":3,"status":"skip","reason":"release 3 (step 27)"},
    "grpc/watch.test.js": {"release":3,"status":"skip","reason":"release 3 (step 27)"},
    "http/fetch-coverage.test.js": {"release":2,"status":"dropped","reason":"12.3 coverage-only file"},
    "http/fetch.test.js": {"release":2,"status":"skip","reason":"fetch is release 2 in api-surface.json (zero-fetch, step 19)"},
    "http/http2.test.js": {"release":2,"status":"skip","reason":"HTTP/2 is release 2 (step 15); push describes dropped", "overrides": [
      {"match":"res.push() - unit level","release":2,"status":"dropped","reason":"15.2 HTTP/2 server push"},
      {"match":"res.supportsPush","release":2,"status":"dropped","reason":"15.2 HTTP/2 server push"},
      {"match":"HTTP/2 server push - h2c integration","release":2,"status":"dropped","reason":"15.2 HTTP/2 server push"},
      {"match":"serveStatic - pushAssets (unit level)","release":2,"status":"dropped","reason":"15.2 HTTP/2 server push"}
    ]},
    "http/integration.test.js": {"release":3,"status":"skip","reason":"the shared beforeAll registers json/urlencoded/text/raw/multipart (step 18) and compress (step 30)"},
    "http/req-res-branches.test.js": {"release":1,"status":"dropped","reason":"12.3 coverage-only file; 12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate"},
    "http/request.test.js": {"release":1,"status":"run","reason":"Request facade over the release 1 head accessors; trust proxy is in the release 1 policy subset","needs":["httpPatch","legacyFetch","inlineIsolate"]},
    "http/response.test.js": {"release":1,"status":"run","reason":"Response facade; cookie describes overridden to release 2","needs":["httpPatch","legacyFetch","inlineIsolate"], "overrides": [
      {"match":"Response Cookies","release":2,"status":"skip","reason":"cookie serialization rows ship with zero-cookie (step 18)"},
      {"match":"Response - cookie option combinations","release":2,"status":"skip","reason":"cookie serialization rows ship with zero-cookie (step 18)"}
    ]},
    "http/trust-proxy.test.js": {"release":1,"status":"run","reason":"integration describes run; unit describes over new Request(mockRaw) dropped","needs":["httpPatch","legacyFetch","inlineIsolate","lib/http/request"], "overrides": [
      {"match":"compileTrust()","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (trust evaluation in zero-policy)"},
      {"match":"req.ip - trust proxy","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new Request(mockRaw))"},
      {"match":"req.ips - proxy chain","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new Request(mockRaw))"},
      {"match":"req.protocol - trust proxy","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new Request(mockRaw))"},
      {"match":"req.secure","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new Request(mockRaw))"},
      {"match":"req.hostname - trust proxy","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new Request(mockRaw))"},
      {"match":"Request - HTTP/2 pseudo-headers","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (mock HTTP/2 raw request)"},
      {"match":"Trust Proxy - internal caching","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (_getTrustFn, _resolveProxy)"}
    ]},
    "middleware/csrf-validator.test.js": {"release":2,"status":"skip","reason":"csrf and json() are release 2; validator helper describes overridden to release 1","needs":["httpPatch","legacyFetch","inlineIsolate"], "overrides": [
      {"match":"Validator - standalone helpers","release":1,"status":"run","reason":"validate is a release 1 facade export"},
      {"match":"validator - params validation","release":1,"status":"run","reason":"validate over route params, release 1"},
      {"match":"validator - custom validate function","release":1,"status":"run","reason":"release 1"},
      {"match":"validator - uuid type","release":1,"status":"run","reason":"release 1"}
    ]},
    "middleware/integration.test.js": {"release":1,"status":"run","reason":"helmet, cors, requestId and logger describes are release 1; others overridden","needs":["httpPatch","legacyFetch","inlineIsolate"], "overrides": [
      {"match":"Timeout Middleware","release":2,"status":"skip","reason":"timeout is release 2 (step 18)"},
      {"match":"Cookie Parser","release":2,"status":"skip","reason":"cookieParser is release 2 (step 18)"},
      {"match":"Rate Limiter","release":2,"status":"skip","reason":"rateLimit is release 2 (step 18)"},
      {"match":"Compression Edge Cases","release":3,"status":"skip","reason":"compress is release 3 (step 30)"},
      {"match":"Compression - deflate","release":3,"status":"skip","reason":"compress is release 3 (step 30)"},
      {"match":"Compression - threshold","release":3,"status":"skip","reason":"compress is release 3 (step 30)"},
      {"match":"Timeout - custom status and message","release":2,"status":"skip","reason":"release 2 (step 18)"},
      {"match":"Rate Limiter - headers","release":2,"status":"skip","reason":"release 2 (step 18)"},
      {"match":"Cookie Parser - decode disabled","release":2,"status":"skip","reason":"release 2 (step 18)"},
      {"match":"Cookie Parser - multiple secrets","release":2,"status":"skip","reason":"release 2 (step 18)"},
      {"match":"timeout - custom status code","release":2,"status":"skip","reason":"release 2 (step 18)"},
      {"match":"timeout - timedOut property","release":2,"status":"skip","reason":"release 2 (step 18)"}
    ]},
    "middleware/security.test.js": {"release":3,"status":"skip","reason":"mixed; release 1 describes overridden to run","needs":["httpPatch","legacyFetch","inlineIsolate","stubs"], "overrides": [
      {"match":"Security - CRLF Header Injection","release":1,"status":"run","reason":"outbound header validation, release 1"},
      {"match":"Security - Static Path Traversal","release":1,"status":"run","reason":"zero-static, release 1"},
      {"match":"Security - sendFile Traversal","release":1,"status":"run","reason":"zero_res_file through zero-static policy, release 1"},
      {"match":"Security - Helmet Headers","release":1,"status":"run","reason":"security headers, release 1 policy subset"},
      {"match":"Security - Query String Prototype Pollution","release":1,"status":"run","reason":"zero-qs, release 1"},
      {"match":"CORS credentials + wildcard validation","release":1,"status":"run","reason":"cors, release 1"},
      {"match":"cors - suffix matching","release":1,"status":"run","reason":"cors, release 1"},
      {"match":"cors - custom methods and allowedHeaders","release":1,"status":"run","reason":"cors, release 1"},
      {"match":"cors - credentials validation","release":1,"status":"run","reason":"cors, release 1"},
      {"match":"cors - preflight OPTIONS returns 204","release":1,"status":"run","reason":"cors, release 1"},
      {"match":"helmet - HSTS with preload","release":1,"status":"run","reason":"security headers, release 1"},
      {"match":"Security - Prototype Pollution","release":2,"status":"skip","reason":"body parsers, release 2 (step 18)"},
      {"match":"Security - Body Size Limits","release":2,"status":"skip","reason":"body parsers, release 2 (step 18)"},
      {"match":"Security - requireSecure on Body Parsers","release":2,"status":"skip","reason":"body parsers, release 2 (step 18)"},
      {"match":"Security - Double Send Protection","release":2,"status":"skip","reason":"body parsers, release 2 (step 18)"},
      {"match":"Security - Multipart Filename Sanitization","release":2,"status":"skip","reason":"body parsers, release 2 (step 18)"},
      {"match":"Security - Cookie Name Validation","release":2,"status":"skip","reason":"cookies and csrf, release 2 (step 18)"},
      {"match":"Security - Signed Cookie Integrity","release":2,"status":"skip","reason":"cookies and csrf, release 2 (step 18)"},
      {"match":"CSRF Secure flag","release":2,"status":"skip","reason":"cookies and csrf, release 2 (step 18)"},
      {"match":"Rate Limiter - skip and handler options","release":2,"status":"skip","reason":"rate limiting, release 2 (step 18)"},
      {"match":"rateLimit - headers and options","release":2,"status":"skip","reason":"rate limiting, release 2 (step 18)"},
      {"match":"rateLimit - keyGenerator option","release":2,"status":"skip","reason":"rate limiting, release 2 (step 18)"},
      {"match":"rateLimit - skip option","release":2,"status":"skip","reason":"rate limiting, release 2 (step 18)"},
      {"match":"rateLimit - custom handler","release":2,"status":"skip","reason":"rate limiting, release 2 (step 18)"},
      {"match":"helmet - advanced options","release":3,"status":"skip","reason":"route handler writes res.raw.setHeader (step 32 emulation)"},
      {"match":"helmet - disabled options","release":3,"status":"skip","reason":"route handler writes res.raw.setHeader (step 32 emulation)"},
      {"match":"compress - SSE exclusion","release":3,"status":"skip","reason":"compress (step 30) and res.raw.writeHead (step 32)"}
    ]},
    "middleware/static.test.js": {"release":1,"status":"run","reason":"static files are release 1 (zero-static, step 9)","needs":["httpPatch","legacyFetch","inlineIsolate","lib/middleware/static"], "overrides": [
      {"match":"Static - setHeaders hook","release":3,"status":"skip","reason":"the hook writes res.raw.setHeader; needs the step 32 emulation, and a JS hook on a tier 0 route is an open design question"}
    ]},
    "middleware/unit.test.js": {"release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (tier 0 rules in zero-policy and zero-static)","needs":["lib/middleware/*"], "overrides": [
      {"match":"errorHandler","release":1,"status":"run","reason":"errorHandler is a release 1 facade function; passes only while the facade keeps the 1.x module body (decision Q4)"},
      {"match":"errorHandler - uncovered branches","release":1,"status":"run","reason":"errorHandler is a release 1 facade function; passes only while the facade keeps the 1.x module body (decision Q4)"},
      {"match":"validator middleware","release":1,"status":"run","reason":"validate is a release 1 facade function; same condition (decision Q4)"},
      {"match":"validate.field standalone","release":1,"status":"run","reason":"validate is a release 1 facade function; same condition (decision Q4)"},
      {"match":"validator - additional coerce and constraint coverage","release":1,"status":"run","reason":"validate is a release 1 facade function; same condition (decision Q4)"},
      {"match":"validator - COERCE and type-validation branch coverage","release":1,"status":"run","reason":"validate is a release 1 facade function; same condition (decision Q4)"},
      {"match":"logger middleware","release":1,"status":"run","reason":"logger is a release 1 facade function; same condition (decision Q4)"}
    ]},
    "observe/health.test.js": {"release":3,"status":"skip","reason":"observability is release 3 (step 28); the three checks are dropped", "overrides": [
      {"match":"memoryCheck","release":3,"status":"dropped","reason":"15.2 memory, event-loop and disk checks"},
      {"match":"eventLoopCheck","release":3,"status":"dropped","reason":"15.2 memory, event-loop and disk checks"},
      {"match":"diskSpaceCheck","release":3,"status":"dropped","reason":"15.2 memory, event-loop and disk checks"}
    ]},
    "observe/integration.test.js": {"release":3,"status":"skip","reason":"release 3 (step 28); ClusterManager describes dropped", "overrides": [
      {"match":"_defaultIpHash","release":3,"status":"dropped","reason":"15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads)"},
      {"match":"ClusterManager metrics integration","release":3,"status":"dropped","reason":"15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads)"},
      {"match":"ClusterManager.enableSticky","release":3,"status":"dropped","reason":"15.2 lib/cluster.js as a feature (kept only as a shim forwarding to threads)"}
    ]},
    "observe/logger.test.js": {"release":3,"status":"skip","reason":"release 3 (step 28)"},
    "observe/metrics.test.js": {"release":3,"status":"skip","reason":"release 3 (step 28)"},
    "observe/tracing.test.js": {"release":3,"status":"skip","reason":"release 3 (step 28)"},
    "orm/adapters/constructors.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/initialization.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/methods.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/mongo.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/mysql.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/postgres-coverage.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/adapters/postgres.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/redis.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/sql-base.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/adapters/sqlite-coverage.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/adapters/sqlite.test.js": {"release":3,"status":"skip","reason":"assigned at step 24 (R.5); 1.x JS adapter internals over mocked drivers are 12.3 drop candidates"},
    "orm/audit.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/branches.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/cache-redis.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25); Query.cache() cases are dropped by 15.2 at step 25"},
    "orm/cache.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25); Query.cache() cases are dropped by 15.2 at step 25"},
    "orm/cli-coverage.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/cli.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/computed-casts.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/database-schema.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/events-observers.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/geo.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/linq.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/migrate.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/model.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/performance.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/plugin.test.js": {"release":3,"status":"dropped","reason":"15.2 PluginManager"},
    "orm/procedures-coverage.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/procedures.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/relationships.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/schema.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/search.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/seed-fake.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25); see conflict C6 (Fake, Factory, Seeder)"},
    "orm/seed.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25); see conflict C6 (Fake, Factory, Seeder)"},
    "orm/snapshot.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/tenancy-coverage.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "orm/tenancy.test.js": {"release":3,"status":"skip","reason":"ORM is release 3 (step 25)"},
    "orm/views-coverage.test.js": {"release":3,"status":"dropped","reason":"15.2 DatabaseView; 12.3 coverage-only file"},
    "orm/views.test.js": {"release":3,"status":"dropped","reason":"15.2 DatabaseView"},
    "packages/scopes.test.js": {"release":3,"status":"dropped","reason":"15.2 packages/ generator and its 14 runtime stubs"},
    "packages/webrtc-types.test.js": {"release":3,"status":"dropped","reason":"15.2 packages/ generator and its 14 runtime stubs"},
    "realtime/connection.test.js": {"release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (RFC 6455 framing in zero-ws, asserted by the ws vector section)"},
    "realtime/sse.test.js": {"release":1,"status":"run","reason":"SSE is release 1; the SSEStream Unit describe is overridden to dropped","needs":["httpPatch","inlineIsolate","lib/sse/stream"], "overrides": [
      {"match":"SSEStream Unit","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (new SSEStream over a fake raw writable; 2.0 streams are connection ids over zero_sse_send)"}
    ]},
    "realtime/websocket.test.js": {"release":1,"status":"run","reason":"WebSocket is release 1; handshake describes and the bare handshake block are overridden to dropped","needs":["appListenPositional","inlineIsolate","lib/ws/handshake"], "overrides": [
      {"match":"ws/handshake - function coverage","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; RFC 6455 handshake in zero-ws)"},
      {"match":"404 when no handler registered for path","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"400 when missing sec-websocket-key","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"403 when verifyClient returns false","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"500 when verifyClient throws","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"101 successful upgrade with handler call","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"parses query string parameters","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"echoes sub-protocol from client","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"handler error closes connection with 1011","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"passes extensions header to connection","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"detects secure connection from encrypted socket","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"verifyClient returning true allows connection","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"passes maxPayload and pingInterval to connection","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"socket error handler absorbs errors without throwing","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"URL without query string gives empty query object","release":1,"status":"dropped","reason":"12.3 implementation detail: drives a 1.x JS module through mock objects or private members; the behavior moves into a Rust crate (handleUpgrade over mock sockets; coverage block from coverage/boost.test.js)"},
      {"match":"WebSocket Pool","release":1,"status":"run","reason":"runs only if WebSocketPool stays a host-side class accepting objects with send/close/on/readyState (map-node-api D6); otherwise dropped with a CHANGELOG anchor"}
    ]},
    "routing/router.test.js": {"release":1,"status":"run","reason":"router is release 1 (zero-router, step 6)","needs":["httpPatch","legacyFetch","inlineIsolate"], "overrides": [
      {"match":"Router Edge Cases > unregistered method returns 404","release":1,"status":"dropped","reason":"CHANGELOG#2.0.0-405-method-not-allowed (proposed): a GET route answers TRACE with 405 and Allow, RFC 9110 section 15.5.6; 1.x answered 404"},
      {"match":"Router - route() chaining > unregistered method on chained route returns 404","release":1,"status":"dropped","reason":"CHANGELOG#2.0.0-405-method-not-allowed (proposed); today the core answers PATCH with 501 because Method has no PATCH (finding F7)"},
      {"match":"Router - all() catches all methods > all() matches PATCH","release":1,"status":"run","reason":"fails until PATCH (RFC 5789) is a recognized method in zero-http-types (finding F7); otherwise a 2.0.0 break needing its own CHANGELOG entry"}
    ]},
    "webrtc/auth.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/bot.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/cascade-pipe-success.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/cascade.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/cli.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/cluster-region-load.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/cluster.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/coverage-batch2.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/coverage-batch3.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/coverage-small-branches.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/createWebRTC.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/e2ee.test.js": {"release":3,"status":"dropped","reason":"15.2 E2EE helpers"},
    "webrtc/ice.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/joinToken-branches.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/mcu-ffmpeg-branches.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade); 12.3 coverage-only file"},
    "webrtc/mcu.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/observe-tracer-branches.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/observe.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/recording-branches.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade); 12.3 coverage-only file"},
    "webrtc/recording.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/sdp.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/sfu-livekit.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/sfu-mediasoup.test.js": {"release":3,"status":"dropped","reason":"15.2 WebRTC media adapters (mediasoup, LiveKit, ffmpeg MCU, recording, ingress, cascade)"},
    "webrtc/sfu-memory-branches.test.js": {"release":3,"status":"dropped","reason":"12.3 coverage-only file"},
    "webrtc/sfu.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/signaling.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/stun.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/turn-credentials.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"},
    "webrtc/turn-server.test.js": {"release":3,"status":"skip","reason":"WebRTC signaling, STUN and TURN are release 3 (step 29)"}
  }
}
```

## 11. Conflicts with DESIGN and ROADMAP

- C1. 12.3 describes the 724 as "facade API alone (`doFetch` against an app)" and R.5 names routing and realtime among the suites they come from; the 724 contain no `doFetch`, no server and no routing file (F2, F3). The release 1 acceptance number in step 13's exit ("The 724 facade-only vitest cases ... every case whose manifest release is 1 passes") should be replaced by the manifest's computed release 1 `run` count.
- C2. 12.3 and R.5 send the 2,659 Node-object cases to the step 32 emulation; at least 540 of them are mock-object unit tests of 1.x internals that no emulation reaches (F8), and about 320 need only the http patch to run at release 1 (F4).
- C3. R.5 lists env among the release 1 suites; api-surface.json has `env.env` at release 2 (zero-env, step 22). Either carry the 1.x JS loader in the release 1 facade (then env.test.js runs at release 1, 80 cases) or keep release 2.
- C4. R.5's parity gate requires every `dropped` entry to cite a 15.2 item or a CHANGELOG anchor, while 12.3 drops coverage-only and implementation-detail suites on its own authority. Add "1.x coverage-only and implementation-detail tests" as a 15.2 item, or let the gate accept a 12.3 reason.
- C5. api-surface.json marks `handleUpgrade` (realtime.handle_upgrade) as `ffi`, release 1, kept; its 1.x parameters are Node objects and every test of it uses mock sockets (map-node-api D5 says the same). Proposed: drop the tests; move the export to dropped or release 3.
- C6. R.5's 1.2.0 deprecation list names `Fake`, `Factory`, `Seeder`, `SeederRunner` "as core features"; api-surface.json keeps all four at release 3. orm/seed and orm/seed-fake (292 cases) follow whichever wins; marked `skip` release 3 here.
- C7. R.3 step 13 publishes `2.0.0-alpha.1`; the brief records the owner decision that nothing is published before 2.0.0. Not a test-map issue, noted for consistency.
- C8. DESIGN 8.5's process-global route table conflicts with the multi-app pattern of every HTTP suite (H4).

## 12. Decisions needed

- Q1. Accept the http.createServer patch (H2) so router, request, response, static and the middleware integration suites run at release 1, or leave them `skip` until release 3.
- Q2. 405 and 501 versus 1.x 404: keep the core behavior and drop the two router cases with a CHANGELOG entry (proposed), or emulate 404 in the facade.
- Q3. Add PATCH as a method (RFC 5789 row in docs/standards.toml) or document its loss.
- Q4. Port errorHandler, validate and logger from 1.x with their module bodies intact so their mock-based unit describes (82 cases) run, or drop those describes.
- Q5. WebSocketPool as a host-side class accepting plain objects (13 cases, map-node-api D6) or dropped.
- Q6. Whether the error and debug coverage files (69 cases) are kept as release 1 runs (proposed) despite the 12.3 coverage-only rule.

## 13. Unverified

- Which extra pattern made the 12.3 script count errors/errors.test.js on the Node-object side (F1); the arithmetic match (one 82-case file) is exact, the cause is not known.
- The 12.3 count of 21 coverage-only files; 22 match by name and 24 by header comment.
- Whether Node's global `fetch` (undici) actually rejects `TRACE` or a `Host` override: the Fetch Standard text was fetched (forbidden method CONNECT, TRACE, TRACK; forbidden request-header list includes Host, Connection, Content-Length, Transfer-Encoding), the Request-constructor step and Node's implementation were not. The recommendation in H1 does not depend on it.
- vitest docs fetched for v4.1.11 (pool default `forks`, include default, `vitest list`); the describe.skip and hook behavior is from the local probe on 4.1.11, not from documentation (the v4 describe page does not state it).
- Runtime case counts for the ORM and WebRTC suites (not collected); their static counts are used.
- Per-describe case attribution is by nearest preceding `describe(` in source order; nested and bare blocks were checked by hand only for the release 1 files (websocket's bare block of 14 cases verified against `vitest list`).
- The zero-mime type for `.js`, zero-sse's `Connection` and `X-Accel-Buffering` headers, and how zero-router and the facade order global middleware: not read in this task.
- RFC 5789 (PATCH) was not fetched; the standards row Q3 implies needs a fetch first.
