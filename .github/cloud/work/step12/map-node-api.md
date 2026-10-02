# zero-server-node public API map for the release 1 Node facade

Reader notes for roadmap steps 12 and 13. Source: the working tree of
`C:\Users\tonyw\Desktop\projects\zero-server` (`@zero-server/sdk` 1.1.0, uncommitted
changes included; none of the files read changed after 2026-09-30), read only.
Cross-checked against `zero-core/conformance/api-surface.json`,
`api-surface.node.json` and the generator `zero-core/scripts/api-surface-from-zero-server.mjs`,
and against the core crates that will carry these features (`zero-router`,
`zero-http-types`, `zero-policy`, `zero-static`). Binding context read: zero-core
`.github/cloud/RULES.md`, `.github/cloud/RULES.md`, DESIGN sections 5, 7, 8, 10.1, 10.2, 12.3, 15,
ROADMAP R.3 (steps 12 to 14) and R.5. Line numbers refer to the files as read on
2026-10-01.

This file replaces the version written earlier the same day. Every claim below was
re-read in source, and the behavioral ones were run (see "Verification run").
Corrections to the earlier version: `clearCookie` emits `Max-Age=0` and no `Expires`;
`next(err)` from `app.use(prefix, fn)` is ignored rather than routed to the error
path; `app.use(errorHandler())` breaks every request instead of doing nothing. Added:
lost headers on static and SSE responses, wildcard routes that capture no parameters,
PATCH missing from the core, zero-router's root-mount, duplicate and
parameter-conflict refusals, trust-proxy and request-id differences, the generator's
nested-brace defect, and the `verifyClient` Promise hole.

## Files read

- SDK: `index.js`, `lib/app.js`, `lib/router/index.js`, `lib/http/{request,response}.js`,
  `lib/middleware/{index,cors,static,errorHandler,requestId,validator}.js` plus the
  header-setting lines of every other middleware, `lib/errors.js`, `lib/env/index.js`
  (exports), `lib/sse/stream.js`, `lib/ws/{handshake,connection}.js`, `lib/lifecycle.js`
  (states, signals), `lib/debug.js` (exports, defaults), `types/index.d.ts`,
  `types/app.d.ts` (App members), `test/_helpers.js`, `test/routing/router.test.js`
  (server setup, PATCH cases), and counts over the R.5 release 1 suites.
- Core: `crates/zero-router/src/lib.rs` (pattern grammar, `route`, `mount`, `resolve`),
  `crates/zero-http-types/src/method.rs`, `crates/zero-policy/src/{cors,request_id,forwarded}.rs`,
  `crates/zero-static/src/files.rs` (`Options`), `crates/zero-ffi` (only `zero_version`
  today), `bindings/node/packages/{core,native,sdk}` (version stubs, no facade yet).

## Verdict in brief

- `index.js` exports exactly 228 names, and `api-surface.json` has 228 entries with the
  same names; `api-surface.node.json` maps all 228 (checked by loading all three in
  Node). DESIGN 8.7 and 15.1 say "238 exports"; that figure is stale.
- `api-surface.json` marks 50 exports as release 1: 8 facade, 8 ffi, 34 host-only. It
  records exports only, with no class members, so `app.use`, `app.get`, `app.listen`,
  `app.ws`, `res.json`, `res.sse`, `req.params` and every other member the step 13 exit
  names have no canonical id, and the canonical-id diff does not see them.
- The generator drops any `@param` whose JSDoc type contains a nested `}` and truncates
  such return types (`handleUpgrade` lost its fourth parameter; 16 return types are cut,
  one of them at release 1). Since CI diffs parameter lists, the contract file is wrong
  for those entries until the generator is fixed and the file regenerated.
- Several 1.x behaviors the legacy tests pin differ from what the core crates already
  do: PATCH (the core answers 501), 405 and automatic HEAD, mounting at `/`, duplicate
  routes, CORS, static, trust proxy, and error bodies. Under R.5, each one is either
  reproduced in the facade, or becomes a 2.0.0 CHANGELOG entry with its test moved to
  `dropped`. They are listed under "Core conflicts".
- Owner decision from the brief: nothing is published to npm before 2.0.0, so step 13
  ships no `2.0.0-alpha.1` (R.3 and R.5 still say it does).

## Cross-check against api-surface.json

Counts by release, status and kind (verified by script): release 1 kept: 8 facade, 8
ffi, 34 host-only; release 2 kept: 3 facade, 21 ffi; release 3 kept: 13 facade, 81 ffi,
36 host-only; release 3 shim: 3 facade; release 3 dropped: 19 ffi, 2 host-only.

Release 1 ids (all `kept`):

| Canonical id | Node name | Kind | Note |
| --- | --- | --- | --- |
| core.create_app | createApp | facade | 1.x takes no arguments (`index.js:89`) |
| core.router | Router | facade | recorded as `class`, but 1.x exports an arrow factory (`index.js:95`); `new Router()` throws `TypeError: ... is not a constructor` (run) |
| core.version | version | facade | from package.json |
| middleware.cors | cors | ffi | tier 0 rule; semantics differ from zero-policy (conflict 6) |
| middleware.static | static | ffi | tier 0 rule; option set differs from zero-static (conflict 7) |
| middleware.helmet | helmet | ffi | tier 0 security headers |
| middleware.request_id | requestId | ffi | tier 0; `generator` option is a host callback (conflict 9) |
| middleware.logger | logger | facade | needs a response-finished hook |
| middleware.validate | validate | facade | reads `req.body`, which no release 1 export fills (decision D3) |
| middleware.error_handler | errorHandler | facade | works only through `app.onError` (D9) |
| errors.* (31 classes) | HttpError ... ProcedureError | host-only | the 16 HTTP classes and 15 framework/ORM classes of `lib/errors.js`; the 5 WebRTC error classes are release 3 |
| errors.create_error, errors.is_http_error | createError, isHttpError | host-only | |
| errors.debug | debug | host-only | the namespaced logger, not an error; return type truncated by the generator |
| realtime.web_socket_connection | WebSocketConnection | ffi | constructor takes a `net.Socket`; only the instance shape survives |
| realtime.handle_upgrade | handleUpgrade | ffi | `(req: IncomingMessage, socket: net.Socket, head: Buffer, wsHandlers: Map)`; the surface lists only 3 params; cannot exist over the core (D5) |
| realtime.web_socket_pool | WebSocketPool | ffi | legacy tests drive it with mock objects; must stay host-side JS (D6) |
| realtime.sse_stream | SSEStream | ffi | constructor takes a Node response; only the instance shape survives |
| lifecycle.lifecycle_manager | LifecycleManager | facade | constructed with an App |
| lifecycle.lifecycle_state | LIFECYCLE_STATE | facade | `{ RUNNING: 'running', DRAINING: 'draining', CLOSED: 'closed' }` |

Release 2 ids: `fetch`, `json`, `urlencoded`, `text`, `raw`, `multipart`, `rateLimit`,
`timeout`, `cookieParser`, `csrf`, `env`, `CLI`, `runCLI`, `jwt`, `jwtSign`, `jwtVerify`,
`jwtDecode`, `jwks`, `tokenPair`, `createRefreshToken`, `SUPPORTED_ALGORITHMS`, `session`,
`Session`, `MemoryStore`.

Release 3 kept: `compress`; observe (16 ffi plus `Logger`, `structuredLogger`), including
`healthCheck` and `createHealthHandlers`; the auth remainder (`oauth`, `generatePKCE`,
`generateState`, `OAUTH_PROVIDERS`, `twoFactor`, `webauthn`, `trustedDevice`, `enrollment`,
`authorize`, `can`, `canAny`, `Policy`, `gate`, `attachUserHelpers`); gRPC (25 ffi plus
`watchProto`); WebRTC (31 ffi plus 3 facade and 5 error classes); the ORM (`Database`
facade plus 26 host-only). Shim: `ClusterManager`, `cluster`, `clusterize`. Dropped:
`memoryCheck`, `eventLoopCheck`, `diskSpaceCheck`, `DatabaseView`, `PluginManager`, and the
SFU adapters, MCU, cascade, recording, ingress and E2EE exports.

Generator defect (`scripts/api-surface-from-zero-server.mjs:202` and `:212`): the type
pattern `\{([^}]*)\}` stops at the first `}`. A `@param` with a nested-brace type fails
the whole match and is dropped silently; a `@returns` keeps a truncated type and puts the
remainder (`}` or `|null}`) at the start of its description. Affected entries found:
`realtime.handle_upgrade` (param `wsHandlers` dropped), and return types of
`errors.debug` (release 1), `auth.jwt_verify`, `auth.jwt_decode`, `auth.token_pair`
(release 2), and `orm.define_migration`, `observe.parse_traceparent`,
`observe.create_health_handlers`, `auth.oauth`, `auth.generate_pkce`, `auth.enrollment`,
`grpc.create_rotating_credentials`, `grpc.watch_proto`, `webrtc.encode_binding_request`,
`webrtc.decode_message`, `webrtc.decode_xor_mapped_address`,
`webrtc.generate_e2ee_key_pair` (release 3). In `lib/` there are 22 `@param` lines with
nested-brace types (most are on members or internal functions). The script and the JSON
are outside this reader's write scope; the fix is a balanced-brace scan, followed by a
regeneration.

The facade helpers named in DESIGN 8.5 (`ok()`, `files()`, `query()`, `cached()`) have
no canonical id because 1.x has no such export; adding them needs new ids, or the diff
will not see them.

## Shapes the facade keeps at release 1

### Module shape

- CommonJS object of 228 names. `createApp()` returns a fresh App; `Router()` is a
  factory, so callers must not use `new`. `static` is a reserved word: TypeScript and ES
  modules can export it only as `export { serveStatic as static }`, and consumers can
  import it only under an alias. The types re-export it with `export { static } from
  './middleware'`.
- Debug logging is on by default in 1.x: with no `DEBUG` set, every namespace is enabled
  (`debug.js:84`), and a run prints DEBUG and INFO lines (observed). DESIGN 15.2 drops
  default-on logging; `debug(namespace)` keeps its shape (a callable with `trace`,
  `debug`, `info`, `warn`, `error`, `fatal`, `enabled`, plus `debug.level(...)`).

### App object

- `createApp()` takes no arguments in 1.x (`createApp.length === 0`); an options
  argument is additive. Public fields: `router`, `middlewares`, `locals` (plain object;
  `app.handle` gives every request `req.locals = Object.create(app.locals)` and a
  separate `res.locals = Object.create(app.locals)`, `app.js:309-310`), `handler` (bound
  `(req, res) => app.handle(req, res)` over Node objects).
- Prototype members (verified by reflection): `set`, `enable`, `disable`, `enabled`,
  `disabled`, `use`, `onError`, `param`, `handle`, `listen`, `close`, `shutdown`, `on`,
  `off`, `registerPool`, `unregisterPool`, `trackSSE`, `registerDatabase`,
  `unregisterDatabase`, `shutdownTimeout`, `lifecycleState` (getter), `health`, `ready`,
  `addHealthCheck`, `metrics`, `metricsEndpoint`, `ws`, `routes`, `route`, `get`, `post`,
  `put`, `delete`, `patch`, `options`, `head`, `all`, `chain`, `group`, `grpc`,
  `grpcInterceptor`, `grpcHealth`, `setServiceStatus`, `grpcReflection`, `jwtAuth`,
  `sessions`, `oauth`.
- Settings: `app.set(key, val)` returns `this`; `app.set(key)` returns the value;
  `app.get(key)` with exactly one string argument is the same getter (`app.js:846`);
  `enable` and `disable` return `this`; `enabled` and `disabled` return booleans. Only
  `'trust proxy'` changes behavior. `'json spaces'`, `'etag'`, `'env'`, `'view engine'`,
  `'views'` and `'case sensitive routing'` are documented (`app.js:109-119`) but read
  nowhere in `lib/`.
- `'trust proxy'` values (`request.js:161-233`): `true` or `'loopback'` (127.0.0.0/8,
  `::1`, `::ffff:127.0.0.1`); `false`, `0`, unset; a hop count (number); a
  comma-separated string or an array of IPs, CIDRs and the names `loopback`,
  `linklocal`, `uniquelocal`; or a function `(addr, hopIndex) => boolean`. It drives
  `req.ip`, `req.ips`, `req.protocol`, `req.secure` and `req.hostname` through
  `X-Forwarded-For` (walked right to left, stopping at the first untrusted address),
  `X-Forwarded-Proto` (first value, only `http` or `https`) and `X-Forwarded-Host`.

### Routes, parameters, sub-routers and mounts

- Verb helpers on App and Router: `get`, `post`, `put`, `delete`, `patch`, `options`,
  `head`, `all`, each `(path, [options], ...handlers)`, returning `this`
  (`app.js:846-895`, `router/index.js:416-465`). The optional leading plain object is
  `{ secure: boolean }`: `true` matches only HTTPS (as `req.secure` resolves it), `false`
  only HTTP.
- `app.route(method, path, ...fns)` returns `undefined` (the d.ts says App).
  `app.chain(path)` and `router.route(path)` return a chain object with the eight verb
  methods, each returning the chain.
- `app.group(prefix, ...middleware, (router) => {})` builds a Router, mounts it at the
  prefix, and returns `this`. Its middleware runs as app-level middleware for any URL at
  or under the prefix (including 404s), and it does not strip the prefix, unlike
  `use(prefix, fn)`. A sync throw or a rejection goes to the app error path; an argument
  passed to its `next` is ignored.
- `app.param(name, (req, res, next, value) => {})` returns `this`; param handlers run
  after router middleware and before route handlers, once per matched key.
- Router (`Router()`): fields `routes`; methods `add(method, path, handlers[], options)`,
  `use`, the verb helpers, `route`, `handle`, `inspect(prefix)`.
- Router `use` forms (`router/index.js:136-172`): `use(fn, ...fns)` router-wide
  middleware; `use(prefix, fn, ...fns)` prefix-scoped middleware; `use(prefix, router)`
  mount. Any other shape throws `TypeError`; returns `this`. Router middleware runs only
  when a route in that router or a mounted child matches (a 404 runs none), and a
  parent's applicable middleware is inherited by mounted children.
- App `use` forms (`app.js:196-226`): `use(fn)` global middleware; `use(prefix, fn)`
  path-scoped middleware, which strips the prefix from `req.url` while `fn` runs and
  restores it when `fn` calls `next`; `use(prefix, router)` mounts on the app router.
  Returns `undefined` (the d.ts says App; run confirms `undefined`). `App.use` reads
  only two arguments (`use(pathOrFn, fn)`, `app.js:196`): `use(fn1, fn2)` registers
  `fn1` alone, `use(prefix, fn1, fn2)` drops `fn2`, and any other shape (`use(router)`
  without a prefix, a non-string prefix) is ignored silently, where `Router.use` throws
  `TypeError` (source reading). The facade can accept the variadic form (additive) but
  should throw on unknown shapes only as a documented change.
- `app.onError(fn)` stores one handler and returns `undefined` (`app.js:235-238`); a
  second call replaces the first.
- Pattern grammar (`router/index.js:33-51`): `:name` segments match `[^/]+`; a trailing
  slash is optional (`/?$`); matching is case-sensitive; no regex, optional or repeated
  parameters. A pattern ending in `*` becomes `^<prefix>(.*)$`, exposed as
  `req.params['0']`, and in that branch every other character is literal, so
  `/w/:id/*` captures nothing and does not match `/w/7/rest` (run: 404). `/api/*` matches
  `/api/` and below but not `/api`. Parameter values go through `decodeURIComponent`
  (`router/index.js:254`), outside any try block.
- Matching order (`router/index.js:233-389`): a router's own routes first in
  registration order, then mounted children in mount order, whatever the interleaving;
  so an app-level `get('/*')` shadows every mounted router, and the JSDoc workaround is
  to mount the catch-all router at `/` last (`app.js:175-191`). A mount match sets
  `req.baseUrl` and rewrites `req.url` to the remainder (`'/'` plus any query for an
  exact prefix hit), restoring both if the child misses. `req.path` stays the full path
  (run: `/r/x?z=1` gives `baseUrl '/r'`, `url '/x?z=1'`, `path '/r/x'`,
  `originalUrl '/r/x?z=1'`).
- Miss: `404` with JSON `{ "error": "Not Found" }` (`router/index.js:204`). There is no
  405, no `Allow`, no automatic HEAD for GET and no 501: HEAD and DELETE to a GET-only
  path both answer 404 (run), and `test/routing/router.test.js:108-111` pins a PATCH to a
  chained route as 404.
- Handler chains: `next()` advances within the matched route's chain only. Calling it
  after the last handler does nothing: there is no fall-through to a later matching
  route, and the request stays open (run: no response after 1,200 ms). Inside route
  handlers, router middleware and param handlers, `next(err)` ignores its argument and
  simply advances (run: router middleware calling `next(new Error())` still reaches the
  handler).
- `app.routes()` returns `{ method, path, secure? }[]` over the router tree, plus
  `{ method: 'WS', path, maxPayload?, pingInterval? }` for each `app.ws` path, plus gRPC
  routes.

### Middleware pipeline and error flow

`app.handle` (`app.js:273-344`) runs every app-level middleware in order for every
request, before any route matching, then calls `router.handle`. Consequences the facade
must preserve or document:

- Global middleware runs on requests that match no route. A CORS preflight to a path
  with no OPTIONS route works only because of this; the logger logs 404s.
- A global middleware may rewrite `req.url`, and the router then matches the rewritten
  URL.
- `app.use(static(...))` runs before all routes, so a file shadows a route of the same
  path.
- A middleware may return a Promise; for `use(fn)`, a rejection or a sync throw goes to
  the error path.
- `next(err)` reaches the error path only from `use(fn)` global middleware. The
  `use(prefix, fn)` wrapper passes `() => { req.url = origUrl; next(); }`, which drops
  the argument, so the request continues to routing (run: a path-scoped middleware that
  calls `next(new NotFoundError())` produces the router's 404 body, not the error).

### app.listen, close, shutdown, lifecycle

- `listen(port = 3000, opts?, cb?)`; `listen(port, cb)` is accepted (`app.js:375-446`).
  `opts` is flat: `http2`, TLS options passed straight to `https.createServer` or
  `http2.createSecureServer` (`key`, `cert`, `pfx`, `ca` and any other Node TLS option),
  `allowHTTP1` (default true on h2 over TLS), and `settings` (HTTP/2 SETTINGS). Any of
  `key`, `cert` or `pfx` selects TLS.
- Returns the Node server from `server.listen(port, cb)`. Tests rely on
  `server.address().port` after `listen(0)`, `server.on('listening', ...)` and
  `server.close()`.
- `listen` always installs SIGTERM and SIGINT handlers that call `shutdown` and then
  `process.exit(0)` or `process.exit(1)` (`lifecycle.js:253-275`).
- `app.close(cb)` closes the server. `app.shutdown({ timeout })` returns one memoized
  Promise; it drains in-flight requests (default 30000 ms or `app.shutdownTimeout(ms)`),
  closes registered WebSocket pools with 1001, tracked SSE streams, gRPC and databases.
- While draining, every new request gets `503` with `Content-Type: application/json`,
  `Retry-After: 5`, `Connection: close` on HTTP/1.x, and body
  `{ "error": "Service Unavailable", "message": "Server is shutting down" }`
  (`app.js:280-290`).
- `app.on('beforeShutdown' | 'shutdown', fn)`, `app.off(...)`, `registerPool`,
  `unregisterPool`, `trackSSE` and `shutdownTimeout` return `this`;
  `app.lifecycleState` is `'running' | 'draining' | 'closed'`.
- DESIGN 8.5 adds the object form `listen({ port, tls, http2, http3 })`. The facade
  must accept both: the legacy suites call the positional form.

### app.ws and the WebSocket objects

- `app.ws(path, handler)` or `app.ws(path, opts, handler)` returns `undefined`
  (`app.js:770-777`). Options: `maxPayload` (default 1048576 bytes), `pingInterval`
  (default 30000 ms, `0` disables), `verifyClient(req) => boolean`.
- Upgrade handling (`ws/handshake.js`): an exact match on the path without the query (no
  parameters, no wildcard); app middleware does not run on upgrades. `verifyClient`
  receives the raw `IncomingMessage` and is called synchronously: a Promise return value
  is truthy, so an `async verifyClient` accepts every client (`handshake.js:46`).
  Outcomes: no handler 404, `verifyClient` false 403, `verifyClient` throws 500, missing
  `Sec-WebSocket-Key` 400 (each a bare status line, then the socket is destroyed);
  handler throws synchronously: close 1011 `'Internal error'`. The `head` buffer is
  ignored.
- The handler receives `(ws, req)`, where `req` is the raw `IncomingMessage`, not the
  wrapped Request (`handshake.js:117`); tests read `req.headers` from it.
- Connection instance (`connection.js`): fields `id` (`'ws_<n>_<base36 ms>'`),
  `readyState` (0 to 3), `protocol` (the client's first offered subprotocol, echoed),
  `extensions` (the client's raw `Sec-WebSocket-Extensions` value, though the 101 sends
  none), `headers`, `ip` (socket address; trust proxy is not applied), `query` (via
  `URLSearchParams`, so `+` decodes to a space here), `url`, `secure`, `maxPayload`,
  `connectedAt`, `data` (user store); getters `bufferedAmount`, `uptime`. Methods:
  `send(data, { binary, callback }) -> boolean`, `sendJSON(obj, cb) -> boolean`,
  `ping(payload?, cb?)`, `pong(payload?, cb?)`, `close(code = 1000, reason?)`,
  `terminate()`, `on`, `once`, `off`, `removeAllListeners`, `listenerCount`. Events:
  `message` (a string for text, a Buffer for binary), `close(code, reason)` (1006 and
  `''` on an abnormal close), `error`, `ping(payload)` (a pong is sent automatically),
  `pong(payload)`, `drain`.
- WebSocketPool (`ws/room.js`): `add`, `remove`, `join(ws, room)`, `leave(ws, room)`,
  `roomsOf(ws)`, `broadcast(data, exclude?)`, `broadcastJSON(obj, exclude?)`,
  `toRoom(room, data, exclude?)`, `toRoomJSON(room, obj, exclude?)`, `in(room)`; getters
  `size`, `rooms`, `clients`; `roomSize(room)`,
  `closeAll(code = 1001, reason = 'Server shutdown')`. It sends only to members with
  `readyState === 1`.

### res.sse and SSEStream

- `res.sse(opts)` returns an SSEStream, or `null` if the response was already sent
  (`response.js:754-796`). Options: `retry` (writes `retry: <ms>` once), `headers`,
  `keepAlive` (ms, comment ping), `keepAliveComment` (default `'ping'`), `autoId`,
  `startId` (default 1), `pad` (bytes of initial comment padding), `status` (default 200).
- It calls `raw.writeHead(status, { 'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...opts.headers })`, plus
  `Connection: keep-alive` off HTTP/2. Headers stored earlier with `res.set()` are not
  merged, so CORS and `X-Request-Id` are missing from SSE responses while helmet's
  (written through `raw.setHeader`) survive (run).
- SSEStream (`sse/stream.js`): `send(data, id?)`, `sendJSON(obj, id?)`,
  `event(name, data, id?)`, `comment(text)`, `retry(ms)`, `keepAlive(ms, comment?)` and
  `flush()` all return `this`; `close()` returns nothing. `on`, `once`, `off`,
  `removeAllListeners` and `listenerCount` cover `'close'` and `'error'`. Fields:
  `secure`, `lastEventId`, `eventCount`, `bytesSent`, `connectedAt`, `data`; getters
  `connected`, `uptime`. Objects (including `null`) are JSON-serialized, and data is
  split on LF into `data:` lines. `comment` escapes LF but not CR; `event` names and `id`
  values are not checked for CR, LF or NUL; `retry(ms)` is not checked for digits.

### Request (req)

- Fields: `raw`, `method` (HTTP/2 `:method` first), `url` (HTTP/2 `:path` first; path
  plus query; mutable), `path` (fixed at construction), `headers` (Node's lowercased
  object), `query`, `params`, `body` (null until a parser sets it), `httpVersion`,
  `isHTTP2`, `alpnProtocol`, `cookies` (`{}` until cookieParser), `locals`,
  `originalUrl`, `baseUrl`, `app`. Set by middleware: `id` (requestId), `rawBody` (body
  parsers), `secret`, `signedCookies`, `csrfToken`, `timedOut`.
- Getters: `ip`, `ips`, `protocol`, `secure`, `hostname` (port stripped, IPv6 brackets
  kept, `:authority` fallback), `fresh` (exact If-None-Match equality against the
  response ETag, or If-Modified-Since against Last-Modified), `stale`, `xhr`.
- Methods: `get(name)`, `is(type)` (substring match on Content-Type), `subdomains(offset
  = 2)`, `accepts(...types)` (returns the first type whenever Accept contains `*/*`; no
  q-values), `range(size)` (returns `{ type, ranges }`; `-1` unsatisfiable; `-2`
  malformed or absent).
- `req.query` (`request.js:470-501`): `{}` (a normal object) when the URL has no `?`;
  otherwise a null-prototype object. Values are strings; the last duplicate wins; only the
  first 100 `&`-separated parts are read; keys `__proto__`, `constructor` and `prototype`
  are skipped; pairs with malformed percent-encoding are dropped silently; `+` is kept
  literally (run: `b=x+y` gives `"x+y"`).

### Response (res)

- Fields: `raw`, `locals`, `app`. Getters `headersSent` (from the raw response) and
  `supportsPush`.
- `status(code)` is chainable and unvalidated; Node accepts any code from 100 to 999
  (run: `status(799)` is sent as 799).
- `set(name, value)` is chainable. It throws `Error('Header values must not contain CR
  or LF characters')` when the name or the value contains CR or LF (`response.js:80-91`;
  tests match `/CR or LF/`). Headers are stored in a private map and written only by
  `send`, `json`, `text`, `html`, `sendStatus`, `redirect` and `sendFile`; keys are
  case-sensitive in the map, so `set('content-type')` and `set('Content-Type')` are two
  entries.
- `get(name)` is case-insensitive. `append(name, value)` comma-joins (CR and LF are
  checked on the value only). Also `vary(field)`; `type(ct)`, with aliases `json`,
  `html`, `text`, `xml`, `form` and `bin` (written without the CR/LF check);
  `location(url)`; `links({ rel: url })`.
- `send(body)` is a no-op after a send. `undefined` or `null` ends with no body; a
  Buffer gets `application/octet-stream`; a string gets `text/html` if its first
  non-blank character is `<`, else `text/plain` (no charset); anything else is JSON, and
  a stringify failure becomes `500 { "error": "Failed to serialize response body" }`
  (run).
- `json(obj)` sets `Content-Type: application/json` (no charset) and sends; `text(str)`
  and `html(str)` work the same way; `sendStatus(code)` sends the reason phrase from a
  21-entry table, else the number as text (run: `sendStatus(418)` sends `418`).
- `redirect(url)` or `redirect(status, url)`: default 302, sets `Location`, sends an
  empty `text/plain` body.
- `sendFile(path, opts?, cb?)`: `opts.root` confines the path (403 on escape); NUL gives
  400; a missing file 404; with a callback, the error goes to the callback instead of a
  response. Without `root`, the path resolves against the process working directory, and
  any absolute path is served. It flushes stored headers, then `opts.headers`, then
  forces Content-Type from a 24-entry extension table, plus Content-Length. There is no
  ETag, Last-Modified, range or conditional handling (static does those).
  `download(path, filename?, cb?)` adds `Content-Disposition: attachment;
  filename="..."` (only `"` escaped).
- `cookie(name, value, opts)` writes straight to the raw `Set-Cookie` header, one field
  line per call (run: four cookies, four lines). It throws `Error('Cookie name must not
  contain =, ;, comma, or whitespace')` on a bad name. Objects become `j:` plus JSON.
  `signed: true` gives `s:<value>.<HMAC-SHA256 base64 without padding>`, keyed by
  `req.secret` or `opts.secret`, and throws `Error('cookieParser(secret) required for
  signed cookies')` when neither exists. Name and value are percent-encoded. Attributes:
  `Domain`; `Path` (default `/`); `Max-Age` (seconds, floored; wins over `expires`) or
  `Expires`; `HttpOnly` (default on); `Secure`; `SameSite` (default `Lax`); `Priority`;
  `Partitioned`. `domain`, `path`, `sameSite` and `priority` are concatenated unchecked.
- `clearCookie(name, opts)` emits `name=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  with no `Expires`, because `maxAge: 0` takes the `Max-Age` branch (run).
- `format({ type: fn, default })` negotiates content; it answers 406 JSON when nothing
  matches.
- `sse(opts)` as above. `push` and `supportsPush` are HTTP/2 push, which DESIGN 15.2
  drops.

### Middleware factories kept at release 1

- `cors(options)` (`cors.js:31-91`): `origin` (default `'*'`; a string, an array that may
  hold `.suffix` entries, or falsy to disable), `methods` (default
  `'GET,POST,PUT,DELETE,OPTIONS'`), `allowedHeaders` (default
  `'Content-Type,Authorization'`), `exposedHeaders`, `credentials`, `maxAge`. Throws at
  construction when `credentials` is set with `'*'`. It sets Allow-Methods, Allow-Headers,
  Expose-Headers and Max-Age on every response, CORS or not, and answers every OPTIONS
  request with 204 and no body (run: `OPTIONS /nope` gives 204). A disallowed origin only
  omits the Allow-Origin header. A single string origin is echoed as configured, whatever
  the request's Origin. The JSDoc's "string starting with `.` for suffix matching" works
  only inside an array. All of its headers go through `res.set`, so static and SSE
  responses lose them.
- `static(root, options)` (`static.js:208-324`): `index` (default `'index.html'`, or
  `false`), `maxAge` in milliseconds (rendered as `max-age` seconds; omitted when 0),
  `dotfiles` (`'ignore'` falls through to `next()`, `'deny'` answers 403, `'allow'`),
  `extensions` fallback list, `setHeaders(res, filePath)` callback, `pushAssets`
  (HTTP/2 push, dropped). Only GET and HEAD; a miss calls `next()`; traversal and dotfile
  denial answer 403 JSON; bad percent-encoding or NUL answers 400 JSON. It writes only
  through `raw.setHeader`: weak ETag `W/"<size hex>-<mtimeMs hex>"`, Last-Modified,
  Accept-Ranges; one `bytes=a-b` range with 206 and 416 (other range forms get a full
  200); 304 on an exact If-None-Match, or on If-Modified-Since when If-None-Match is
  absent. Headers stored by earlier `res.set` calls are never flushed (run: a static file
  served behind `cors()` and `requestId()` carries neither).
- `helmet(opts)`: `contentSecurityPolicy`, `crossOriginEmbedderPolicy` (default off),
  `crossOriginOpenerPolicy` and `crossOriginResourcePolicy` (default `'same-origin'`),
  `dnsPrefetchControl`, `frameguard` (default `'deny'`), `hidePoweredBy`, `hsts`,
  `hstsMaxAge` (15552000), `hstsIncludeSubDomains` (true), `hstsPreload` (false),
  `ieNoOpen`, `noSniff`, `permittedCrossDomainPolicies` (`'none'`), `referrerPolicy`
  (`'no-referrer'`), `xssFilter` (default off). It writes through `raw.setHeader`
  immediately.
- `requestId({ header = 'X-Request-Id', generator, trustProxy = false })`: sets `req.id`
  and, through `res.set`, the response header. A trusted incoming id is kept when it is
  a string of at most 128 characters (no character check); the default generator is
  `crypto.randomUUID()` (UUID v4).
- `logger({ logger = console.log, colors, format: 'dev' | 'tiny' | 'short' })`: logs on
  the raw response `finish` event, so the facade needs a completion hook.
- `validate({ body, query, params }, { stripUnknown = true, onError })`: replaces
  `req.body`, `req.query` and `req.params` with sanitized values; a failure answers
  `422 { errors: ["body.<field> ...", ...] }`, or calls `onError(errors, req, res)`.
- `errorHandler({ stack, log, logger, formatter, onError })`: a 4-argument
  `(err, req, res, next)` function.

### Errors and how thrown values become responses

Classes (`errors.js`): `HttpError(statusCode, message?, { code, details })`, with `name`
set to the constructor name; `statusCode`; `code` (default: the status text in upper
snake case from a 20-entry table, such as `NOT_FOUND` or `I_M_A_TEAPOT`, else `ERROR`);
optional `details`; and `toJSON()` returning `{ error: message, code, statusCode,
details? }`. The message defaults to the status text. Subclasses take
`(message?, opts?)`: 400 BadRequest, 401 Unauthorized, 403 Forbidden, 404 NotFound, 405
MethodNotAllowed, 409 Conflict, 410 Gone, 413 PayloadTooLarge, 422 UnprocessableEntity,
429 TooManyRequests, 500 Internal, 501 NotImplemented, 502 BadGateway, 503
ServiceUnavailable. `ValidationError(message?, errors?, opts?)` is 422 with code
`VALIDATION_FAILED` and `details` set to the errors. The framework classes are 500
(`TimeoutError` is 408 with code `TIMEOUT`), with fixed codes (`DATABASE_ERROR`,
`CONFIGURATION_ERROR`, `MIDDLEWARE_ERROR`, `ROUTING_ERROR`, `CONNECTION_ERROR`,
`MIGRATION_ERROR`, `TRANSACTION_ERROR`, `QUERY_ERROR`, `ADAPTER_ERROR`, `CACHE_ERROR`,
`TENANCY_ERROR`, `AUDIT_ERROR`, `PLUGIN_ERROR`, `PROCEDURE_ERROR`); the database
subclasses extend `DatabaseError`. Only the base class defines `toJSON`.
`createError(status, message, opts)` maps 400, 401, 403, 404, 405, 408, 409, 410, 413,
422, 429, 500, 501, 502 and 503 to their classes, and anything else to a plain HttpError.
`isHttpError(err)` is `err instanceof Error && (err instanceof HttpError || typeof
err.statusCode === 'number')`.

Error paths (each verified by a run unless marked):

1. A route handler, param handler or router middleware throws or rejects
   (`router/index.js:501-518`): with `app.onError(fn)` registered, the router calls
   `fn(err, req, res, () => {})`. Otherwise the status is `err.statusCode || err.status
   || 500` (unvalidated), and, unless headers were sent, the body is `err.toJSON()` when
   it exists, else `{ error: err.message || 'Internal Server Error' }`. Runs: a plain
   Error gives `500 {"error":"secret detail"}`; a NotFoundError with details gives
   `404 {"error":"nope","code":"NOT_FOUND","statusCode":404,"details":{"a":1}}`; an
   async `HttpError(418)` gives 418 with code `I_M_A_TEAPOT`.
2. A `use(fn)` global middleware throws, rejects or calls `next(err)` (`app.js:313-321`):
   with `onError`, the app calls `fn(err, req, res, next)`, where `next` continues the
   pipeline. Otherwise it always answers `500 { error: err.message || 'Internal Server
   Error' }`, ignoring `statusCode` and `toJSON` and not checking `headersSent`.
3. A plain `Error` therefore leaks its message on a 500 by default. The legacy suite pins
   this: `errors.test.js:779-807` expects 500 with `data.error` containing `'sync boom'`
   and `'async boom'`.
4. `errorHandler()` through `app.onError` (run): the status is clamped to 100..599, else
   500. The body comes from `formatter`; else `toJSON()` for HttpErrors (plus `stack`
   lines in dev); else `{ error, statusCode, code? }`, with the message of a 5xx hidden
   only when not in dev (the `stack` option, else `NODE_ENV !== 'production'`). Run with
   `stack: false`: a plain Error gives `500 {"error":"Internal Server Error","statusCode":500}`.
5. `app.use(errorHandler())`, the form the JSDoc and README examples show, makes every
   request fail: `app.use` calls it as `(req, res, next)`, so it reads `res` as the
   request and calls `next.status`, and the app answers `500 {"error":"res.status is
   not a function"}` for every path, 404s included (run).
6. Malformed percent-encoding in a route parameter throws `URIError` inside the matcher.
   With no app-level middleware, it escapes `app.handle`: the process gets an uncaught
   `URIError: URI malformed` and the client gets no response (run). With any app-level
   middleware in the chain, the throw lands in that middleware's try block and becomes
   `500 {"error":"URI malformed"}` (run). This is the audit's URIError crash that DESIGN
   7.1 cites.
7. Errors thrown from callbacks outside the returned Promise (timers, event handlers)
   are uncaught in 1.x (source reading).

### env

`env` is a callable Proxy: `env(key)`, `env.KEY`, `env.get`, `env.require`, `env.has`,
`env.all`, `env.reset`, `env.parse`, and `env.load(schema?, { path, override })` or
`env.load(pathString)`. It reads `.env`, `.env.local`, `.env.<NODE_ENV>` and
`.env.<NODE_ENV>.local` in that order; existing `process.env` values win unless
`override` is true; file values are written back to `process.env` unless
`override === false`; it supports `${VAR}` interpolation. Types: `string`, `number`,
`boolean`, `integer`, `array` (`separator`), `json`, `url`, `port` and `enum`
(`values`); fields take `required` and `default` (a value or a function). Failures throw
one `Error` listing every problem. It needs nothing from the core. (Source reading of
exports and option handling; not run.)

## Release split for the Node facade

### Release 1 (step 13)

- Exports: the 50 release 1 ids above, with `handleUpgrade` resolved per D5.
- App: `use` (three forms), the eight verb helpers (PATCH per conflict 1), `route`,
  `chain`, `group`, `param`, `set`/`get(key)`/`enable`/`disable`/`enabled`/`disabled`,
  `locals`, `onError`, `listen(port, opts?, cb?)` plus `listen({ port, tls })`, `close`,
  `shutdown`, `on`/`off`, `shutdownTimeout`, `lifecycleState`, `registerPool`,
  `unregisterPool`, `trackSSE`, `ws`, `routes`.
- Router: `Router()`, `use` (three forms), verb helpers, `route`, `inspect`.
- req: every field, getter and method listed above, except those whose producers wait:
  `body` (D3), `rawBody`, `cookies` content, `secret`, `signedCookies`, `csrfToken`,
  `timedOut`.
- res: `status`, `set`, `get`, `append`, `vary`, `type`, `location`, `links`, `send`,
  `json`, `text`, `html`, `sendStatus`, `redirect`, `format`, `sendFile`, `download`,
  `cookie`, `clearCookie` (with `opts.secret` for signing), `sse`, `headersSent`, `locals`.
- WebSocket and SSE instance shapes listed above; WebSocketPool as host-side JS.
- TLS on listen: `key`, `cert`, `ca` (step 10 delivers zero-tls in release 1).
- Candidates the lead should rule on: `app.health()` and `app.ready()` without checks
  are tier 0 probes in DESIGN 7.2, but `healthCheck` and `createHealthHandlers` are
  release 3 in the surface. `env` is release 2 in the surface, yet R.5 runs the env suite
  at release 1 (D2).

### Waits

- Release 2: HTTP/2 (`http2`, `allowHTTP1`, `settings` on listen; step 15); streaming
  bodies (step 16); body parsers with `req.body` and `req.rawBody`; `fetch`;
  `rateLimit`, `timeout`, `cookieParser` (`req.cookies`, `req.secret`, signed cookies)
  and `csrf` (step 18); JWT and sessions, including `app.jwtAuth` and `app.sessions`
  (steps 18 and 19); `env` per the surface (zero-env is step 22; see D2); the CLI.
- Release 3: `compress`; observability (`app.health`, `app.ready`, `app.addHealthCheck`,
  `app.metrics`, `app.metricsEndpoint`, `metricsMiddleware`, tracing); `app.oauth` and
  the auth remainder; gRPC (`app.grpc`, `grpcInterceptor`, `grpcHealth`,
  `setServiceStatus`, `grpcReflection`); WebRTC; the ORM with `app.registerDatabase` and
  `app.unregisterDatabase`; `app.handler` and `app.handle` (the Node request and response
  emulation, step 32); HTTP/3 (`http3` on listen, step 23); the cluster shims.
- Dropped: `res.push`, `res.supportsPush`, static's `pushAssets`, and the health checks,
  media and E2EE exports of DESIGN 15.2.
- Unknown release: `pfx` and encrypted keys on listen (see Unverified).

## Core conflicts the facade must resolve

Each conflict needs one of two outcomes: the facade reproduces 1.x, or the difference
becomes a 2.0.0 CHANGELOG entry and the pinning tests move to `dropped` (R.5).

1. PATCH. `zero_http_types::Method` holds only the eight RFC 9110 methods, and
   `Method::parse(b"PATCH")` is `None` (pinned at `method.rs:172`). zero-router
   therefore resolves PATCH as `NotImplemented` (501), and `zero-http/tests/routing.rs:316`
   and the router conformance vector "unimplemented token" (`conformance_vectors.rs:522`)
   pin that. 1.x ships `app.patch`, `router.patch` and chain `.patch`, and
   `router.test.js` uses PATCH three times: line 109 (expects 404 for an unregistered
   PATCH), line 253 (`all()` must match PATCH) and line 389 (registers `.patch`).
   RFC 5789 defines PATCH (fetched), and `docs/standards.toml` has no row for it. Keeping
   `app.patch` at release 1 needs a registry row, a ninth method id in zero-http-types,
   the C header and the vectors, and an updated 501 vector. That is a step 12 ABI
   decision, because the method enum is part of `zero.h`.
2. 405, automatic HEAD and 501. zero-router answers 405 with `Allow`, serves HEAD from
   GET, answers OPTIONS on a known path with `Allow`, and answers 501 for an unknown
   method (`lib.rs:662-688`, RFC 9110 9.1 fetched). 1.x answers 404 for all of these;
   `router.test.js:32-35` and `:108-111` pin 404.
3. Mount at the root. `Router::mount` refuses `/` with `RouteError::RootMount`
   (`lib.rs:498-504`), but the 1.x JSDoc tells users to mount a catch-all router at `/`
   last (`app.js:181-191`). zero-router also resolves mounts before the parent's
   catch-all routes, and treats a request under a mount as the child's 404, which is the
   behavior that JSDoc works around. The facade can flatten a root mount into the parent
   table; otherwise both are CHANGELOG entries.
4. Duplicates and parameter names. `Router::route` refuses a second route for the same
   method and pattern (`Duplicate`), and a parameter named differently at the same
   position as an existing route (`ParameterConflict`, for example `/u/:id` beside
   `/u/:userId/posts`). 1.x accepts both: the first registration wins, and each route
   keeps its own names. A facade that registers straight into zero-router would throw at
   registration for apps that load today.
5. Patterns and paths. zero-router normalizes the path before matching (RFC 3986
   unreserved decoding, dot-segment removal, `%2F` never a separator), allows parameters
   before a final `*` or `*name` (1.x does not, see above), caps routes at 16 parameters
   and paths at 64 segments (a longer path is 404), and refuses a pattern without a
   leading `/`. The unnamed catch-all is named `*` in the core, while 1.x exposes it as
   `req.params['0']`, so the facade has to map it.
6. CORS. zero-policy `Cors` (`cors.rs`) differs from 1.x `cors()` in every observable
   default. The core adds the allow fields only to a preflight (1.x: every response); a
   preflight needs `Origin` and `Access-Control-Request-Method` (1.x: any OPTIONS); a
   refused preflight is 403 (1.x: 204); origins must be exact serialized origins and
   `null` never matches (1.x: echoes a configured string, and supports `.suffix` matching
   in arrays); `Any` with credentials reflects the origin (1.x: throws at construction);
   the defaults are methods `GET, HEAD, POST` and no headers (1.x:
   `GET,POST,PUT,DELETE,OPTIONS` and `Content-Type,Authorization`). The facade can
   translate options into a rule with 1.x defaults (suffix matching would need a new
   `AllowOrigin` variant), or the differences become CHANGELOG entries.
7. Static. zero-static `Options` (`files.rs:44-80`) has `index`, `cache`, `ranges`
   (multipart ranges included), `attachment`, cache sizes and a boolean `dotfiles`
   (refused paths answer 404). 1.x adds `extensions`, `setHeaders` (a host callback),
   tri-state `dotfiles` with 403 for deny, `maxAge` in milliseconds, fall-through to
   later middleware and routes on a miss, and 403 or 400 JSON refusals. The tier 0 rule
   needs fall-through and extensions, or these become CHANGELOG entries; `setHeaders`
   cannot be tier 0.
8. Trust proxy. zero-policy `TrustProxy` (`forwarded.rs:308-370`) trusts a CIDR list
   only. For a trusted peer, it takes the first `for` of `Forwarded` (RFC 7239), else
   the first (leftmost) `X-Forwarded-For` address. 1.x ignores `Forwarded`, walks
   `X-Forwarded-For` right to left and stops at the first untrusted hop, and supports hop
   counts, named ranges and a function. Behind two trusted proxies, the leftmost address
   is whatever the client sent, so the core's rule is easier to spoof than 1.x's. This is
   a security judgment for the lead, not only a compatibility one; a function setting
   cannot be tier 0.
9. Request id. The core generates UUID v7 by default and accepts an incoming id only
   when it is 1 to 128 bytes of letters, digits, `-`, `_`, `.` and `:`
   (`request_id.rs:44-71`). 1.x generates v4 and accepts any string of at most 128
   characters. A custom `generator` is a host callback, which cannot be tier 0.
10. Header loss on static and SSE. In 1.x, CORS and `X-Request-Id` headers are missing
    from static-file and SSE responses (run). A tier 0 composition will add them, which
    is a behavior change (an improvement); no legacy test was found that asserts their
    absence (not searched exhaustively).
11. Error bodies. Keeping the legacy suite green means a plain thrown `Error` still
    answers `500 { error: message }`, which discloses internal messages. Hiding the
    message (as `errorHandler` does in production) is the safer default, and moves
    `errors.test.js:779-807` and `:903-919` to `dropped` with a CHANGELOG anchor. The
    inconsistency between error paths 1 and 2 (path 2 ignores `statusCode` and `toJSON`)
    should be resolved one way in the facade's try/catch mapping, which DESIGN 7.2 places
    in Rust.
12. `res.set` validation. The core rejects more than CR and LF: non-token names, NUL,
    and surrounding whitespace (DESIGN 8.1). The facade should throw on
    `InvalidArgument` with a message that still matches `/CR or LF/` for CR and LF input,
    and treat header names case-insensitively.
13. `res.status`. 1.x accepts any value and Node sends 100..999; `zero_res_status`
    rejects values outside 100..599. Choose between throwing in `status()` and failing at
    send.
14. `sendFile` without `root` serves any path relative to the working directory or any
    absolute path in 1.x, while `zero_res_file` goes through the zero-static policy,
    which needs a root. The no-root case needs a definition.
15. `req.query` keeps `+` literally and drops malformed pairs. If zero-qs decodes `+` to
    a space, the facade must not, or the change is documented. (The ws query already
    decodes `+`.)
16. `app.listen` TLS options are any Node TLS option in 1.x; the facade accepts a fixed
    set, and should reject unknown keys with a clear error rather than ignore them.

## Decisions for the step 13 lead

- D1. Member-level contract. `api-surface.json` has no class members, so the
  canonical-id diff cannot catch a missing `res.sse` or a changed `app.listen`. Either
  extend the generator to emit members of App, Router, Request, Response, SSEStream,
  WebSocketConnection and WebSocketPool from their JSDoc, or keep a facade member
  manifest beside it and test against that. Fix the nested-brace parsing in the same
  change.
- D2. `env` release. The surface puts `env.env` at release 2 and zero-env is step 22, but
  R.5 runs the env suite (80 cases) at release 1, and DESIGN 15.3 keeps the loader's
  shape. The 1.x loader is pure JS with no core dependency. Shipping it as host-side
  TypeScript at release 1 resolves the conflict, but it moves the id to release 1 in the
  generator's table; otherwise the env suite is `skip` until release 2.
- D3. `req.body` at release 1. The release 1 ABI has a buffered `zero_req_body` (a copy
  in Node), yet `json()` and the other parsers are release 2, and the release 1
  `validate` reads `req.body`. Choose between a release 1 facade `json()` over the body
  copy and `JSON.parse`, and leaving `req.body` null, with validate's body rules and the
  cases that post JSON marked `skip`.
- D4. `fetch` and `app.handler` in the legacy runner. `test/_helpers.js:1` takes `fetch`
  from the SDK (`require('../')`), which is release 2; the shim map must supply Node's
  global `fetch` under that name, or `fetch` moves to release 1. Separately, the release
  1 suites build servers with `http.createServer(app.handler)`: `routing/router.test.js`
  12 times, `realtime/sse.test.js` twice, and `app/api-helpers`, `app/cookies-orm` and
  `errors/subsystem-errors` 9, 11 and 14 times. `app.handler` needs the step 32
  emulation. Unless the scripted rewrite also maps `require('http')` to a shim whose
  `createServer(app.handler)` returns an object that calls `app.listen` (the facade
  could tag `handler` with its App), those suites are `skip` until release 3, and
  R.5's "routing and realtime at release 1" does not hold.
- D5. `handleUpgrade` is `ffi`, release 1, but its parameters are `IncomingMessage`,
  `net.Socket`, `Buffer` and a handler map. It cannot exist over the core before the
  step 32 emulation; move it to release 3 or `dropped` in the generator.
- D6. WebSocketPool and per-isolate state. The legacy tests drive WebSocketPool with mock
  objects (`websocket.test.js:87-160`), so it has to stay a host-side class. With one
  isolate per core, a pool, `app.locals`, closures and in-memory stores exist once per
  isolate, so a 1.x broadcast that reached every client reaches only the clients on that
  core. Cross-core fan-out needs the `zero_room_*` entry points behind the pool, and the
  per-isolate semantics are a 2.0.0 CHANGELOG entry.
- D7. Isolate pool and tests. DESIGN 8.5 has `app.listen()` spawn `worker_threads` that
  each rerun the entry module. A vitest file cannot be rerun in a worker, and the legacy
  cases capture test-local state in handler closures. The facade needs a single-isolate
  mode (`threads: 1`, running handlers on the calling isolate with no workers) for the
  legacy suite and for apps that share module state. In pool mode: `listen(0)` must
  resolve one ephemeral port shared by every worker's listener; the returned object must
  provide `address()`, `close(cb)` and the `'listening'`, `'error'` and `'close'`
  events; the callback must run once, on the main isolate; and `listen` in a worker must
  register routes without binding.
- D8. Global middleware and routing. 1.x runs every `app.use` function before matching,
  on every request including 404s, and lets middleware rewrite `req.url` before
  matching. The core resolves a route id before dispatch, and DESIGN 7.2 sends only
  matched tier 3 routes to the host. If any host-side global middleware is registered,
  either every request (misses included) is dispatched to the isolate and matched by a
  JS-side copy of the 1.x router, or URL rewriting and miss-time middleware are
  documented breaks. Tier 0 rules (cors, helmet, requestId, static) also lose their
  position in the `use` chain relative to user middleware.
- D9. Documentation defects to fix in the guides rather than copy:
  `app.use(errorHandler())` breaks every request (error path 5); only
  `app.onError(errorHandler())` works. The router module example `new Router()` throws on
  the exported factory. `use` and `route` return `undefined` although the d.ts says App;
  returning `this` is additive. `verifyClient` must be synchronous, and an async one
  accepts every client; the facade should await it or refuse a non-boolean result.
- D10. Owner decision vs the roadmap: R.3 step 13's exit and R.5 still name
  `@zero-server/sdk@2.0.0-alpha.1` under `next`; the brief says nothing is published
  before 2.0.0. The roadmap rows need the matching edit.

## ABI needs found against DESIGN 8.1 (input for step 12)

- Methods: PATCH needs a method id (conflict 1). Any change to the `Method` enum or its
  ids changes `zero.h`, so it belongs in step 12, before the header is committed.
- SSE: `zero_sse_send(conn, event, id, data)` has no comment line, no `retry` field, no
  initial padding and no keep-alive. The facade needs `comment`, `retry` and `pad`,
  either as entry points or as a raw-field write. `res.sse` also needs a status and extra
  headers before `zero_res_sse_open`, which `zero_res_status` and `zero_res_header`
  cover if they are legal before the open. Field values must reject CR, LF and NUL in
  `event` and `id` (WHATWG 9.2.5 and 9.2.6, fetched), which 1.x does not.
- SSE `lastEventId`: 1.x never reads the request's `Last-Event-ID`; it reads a response
  header slot `_sse_last_event_id` that nothing sets (`response.js:786`). The facade
  should read the request header through `zero_req_header_id`.
- WebSocket: `zero_ws_ping(conn)` has no payload; there is no pong, no terminate (close
  without a close frame), no per-send flush callback, and only a boolean `writable` where
  1.x exposes `bufferedAmount`. `zero_res_ws_accept(slot)` has no subprotocol argument,
  and RFC 6455 4.2.2 (fetched) requires the server to choose from the client's list, so
  the route needs a server-side protocol list. Per-route `maxPayload` and `pingInterval`
  need a place in route registration. `verifyClient` and the `(ws, req)` handler need the
  upgrade request's headers, URL, query and peer captured before the slot is released,
  since the connection id outlives it.
- Rooms: `zero_room_broadcast(room, opcode, ptr, len)` has no exclude argument, which
  every 1.x `broadcast` and `toRoom` call accepts; a pool-wide `broadcast` needs an
  implicit room per pool.
- Headers: `Set-Cookie` needs append semantics, one field line per cookie (RFC 9110 5.3,
  fetched; run confirms 1.x emits separate lines). DESIGN 8.1 does not say whether
  `zero_res_header` adds or replaces.
- Completion hook: `logger` and the lifecycle's request tracking need a per-request
  finished event (status code and time) after `zero_res_send`.

## Standards facts fetched in this task (2026-10-01)

- RFC 5789 (https://www.rfc-editor.org/rfc/rfc5789.html), Proposed Standard, March 2010:
  Section 2, "The PATCH method requests that a set of changes described in the request
  entity be applied to the resource identified by the Request-URI", and "PATCH is
  neither safe nor idempotent". Its Section 4 registers the `Accept-Patch` header field.
- RFC 9110 (https://www.rfc-editor.org/rfc/rfc9110.html): Section 9.1, "An origin
  server that receives a request method that is unrecognized or not implemented SHOULD
  respond with the 501 (Not Implemented) status code" and "A method recognized and
  implemented but not allowed for the target resource SHOULD respond with the 405
  (Method Not Allowed) status code"; Section 15, "A status code is a three-digit
  integer"; Section 5.3, "the 'Set-Cookie' header field ... often appears in a response
  message across multiple field lines and does not use the list syntax".
- WHATWG HTML, server-sent events
  (https://html.spec.whatwg.org/multipage/server-sent-events.html): 9.2.5
  `end-of-line = ( cr lf / cr / lf )`, and lines are separated by CRLF, LF or CR; 9.2.4
  "The `Last-Event-ID` HTTP request header reports an `EventSource` object's last event
  ID string to the server when the user agent is to reestablish the connection"; 9.2.6
  an `id` value containing U+0000 is ignored, and `retry` is applied only when it
  "consists of only ASCII digits". Against 1.x: `_formatData` splits on LF only, so a CR
  inside `data` starts a new field line; `event` names and `id` values are not checked;
  `retry(ms)` is not checked for digits.
- RFC 6455 (https://www.rfc-editor.org/rfc/rfc6455.html): 4.2.1 requires a GET,
  `Host`, `Upgrade` containing `websocket`, `Connection` including `Upgrade`, a
  `Sec-WebSocket-Key` that decodes to 16 bytes, and `Sec-WebSocket-Version: 13`; 4.2.2,
  the subprotocol "MUST be derived from the client's handshake, specifically by selecting
  one of the values ... that the server is willing to use", and "Extensions not listed by
  the client MUST NOT be listed"; 4.4, a server that does not support the version "MUST
  respond with a |Sec-WebSocket-Version| header field ... containing all versions it is
  willing to use". Against 1.x: `handshake.js` checks only that the key is present,
  echoes the client's first subprotocol with no server list, never answers a version
  mismatch, and reports the client's extension offer in `ws.extensions` although none is
  negotiated.

## Verification run in this task

Scripts in this scratch folder, run with Node v24.13.0 against the SDK working tree:

- `verify-surface.cjs`: export and surface name equality (228/228), counts by release,
  status and kind, release 1 entries with params, the `new Router()` failure, and App
  prototype reflection.
- `probe-node-api.cjs`: header survival on static, SSE and JSON responses behind cors,
  requestId and helmet; error bodies for a plain Error, a NotFoundError and an async
  HttpError(418); parameter decoding; the wildcard-plus-parameter miss; query parsing;
  HEAD, DELETE and OPTIONS behavior; mount `baseUrl`, `url`, `path` and `originalUrl`;
  `status(799)`; the `app.use` return value.
- `probe-node-api2.cjs`: Set-Cookie lines from `clearCookie`, `cookie` and signed and JSON
  cookies; the cookie-name and CR/LF throws; `next(err)` from path-scoped app middleware
  and from router middleware; URIError with app middleware present; redirect,
  sendStatus, Buffer, HTML detection and circular JSON; `errorHandler` through `onError`
  and through `app.use`; the open request after `next()` past the last handler.
- `probe-node-api3.cjs`: URIError with no app middleware (an uncaught exception and no
  response).
- Test counts over `test/{app,routing,realtime,errors,env}` (cases, `app.handler`,
  `createServer`, `listen`, `doFetch` per file).

On a later pass the same day, `verify-surface.cjs` was rerun with identical output (228
exports, 228 surface entries, 228 Node names, the same release, status and kind counts);
no file under `lib/`, `types/` or `index.js` had changed since 2026-09-30; and the cited
lines for `createApp`, `Router`, `App.use`, `listen`, the router 404, parameter decoding,
`res.set`, both error paths and the `cors` defaults were re-read and match.

No repository file was edited. A local Docker check showed one running
`zero-server-lint` container; this task did not use or stop it.

## Unverified

- The RFC 9110 fetch did not return a sentence giving the 100..599 status range, so that
  bound is taken from DESIGN 8.1, not from the RFC.
- The rfc-editor.org info page for RFC 5789 did not show "Obsoleted by" or "Updated by"
  fields in the fetched text; whether any RFC updates it was not confirmed.
- Whether rustls (the zero-tls provider) can load `pfx` (PKCS#12) bundles or encrypted
  private keys was not checked; the release for those listen options is open.
- DESIGN 12.3's 724 facade-only cases were not recounted; the per-file counts above use
  a regular expression over `it(` and `test(` lines, not a parse.
- `api-surface.json` says it was generated from 1.1.0, while this map reads the working
  tree, which has uncommitted changes (for example in `lib/app.js` and `lib/errors.js`);
  the two can differ where those changes touched JSDoc.
- Whether Node's global `fetch` satisfies every `doFetch` call site in the legacy suite
  (the helper uses `headers.get`, `json()`, `text()` and `status`) was not run.
- `env` behavior is from source reading only (no run).
- No legacy test was found asserting that CORS headers are absent from static or SSE
  responses, but the search was not exhaustive.
