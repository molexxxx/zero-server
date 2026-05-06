/**
 * scope-manifest.js — Source of truth for the scoped @zero-server/* packages.
 *
 * Each scope defines what gets published as @zero-server/<name>.  The packages
 * are NOW true standalone bundles — they ship their own copy of the relevant
 * lib/ source, with no runtime dependency on @zero-server/sdk.
 *
 * Field reference
 * ---------------
 *   name          package suffix  (e.g. "core" → "@zero-server/core")
 *   title         human-readable section title
 *   summary       one-line description used in tables / cards
 *   description   multi-line description for the scope README
 *   exports       public API names (used for validation + .d.ts generation)
 *
 * Source bundling (used by generate-package-stubs.js)
 *   sourceDir     single lib/ subdirectory to copy recursively
 *                 e.g. 'auth' → copies lib/auth/** into packages/auth/lib/auth/
 *   sourceDirs    array of lib/ subdirectories to copy (each becomes lib/<dir>/)
 *   sourceFile    single lib/ file  e.g. 'errors.js' → packages/errors/lib/errors.js
 *   sourceFiles   array of lib/ files  (placed flat in packages/<name>/lib/)
 *   bundleDebug   copy lib/debug.js alongside source as packages/<name>/lib/debug.js
 *
 * Dependency wiring
 *   requireRewrites  { oldStr: newStr }  applied to every copied source file
 *   pkgDependencies  { '@zero-server/pkg': true }  added to package.json deps
 *                    true → use the same version as the SDK
 *   extraShims       [{ file, content }]  files created inside packages/<name>/lib/
 *                    used to redirect cross-scope requires without touching source
 *
 * index.js generation
 *   localMap      { publicName: 'localName' }  when the lib export name differs
 *                 from the public API name (e.g. { jwtSign: 'sign' })
 *   indexJs       explicit index.js body (string) — overrides auto-generation.
 *                 Used for scopes with multiple entry modules or special factories.
 *                 The banner comment is prepended automatically.
 */

/**
 * @typedef {object} ScopeDefinition
 * @property {string}   name
 * @property {string}   title
 * @property {string}   summary
 * @property {string}   description
 * @property {string[]} exports
 * @property {string}   [sourceDir]
 * @property {string[]} [sourceDirs]
 * @property {string}   [sourceFile]
 * @property {string[]} [sourceFiles]
 * @property {boolean}  [bundleDebug]
 * @property {Record<string,string>}  [requireRewrites]
 * @property {Record<string,boolean|string>} [pkgDependencies]
 * @property {Array<{file:string,content:string}>} [extraShims]
 * @property {Record<string,string>} [localMap]
 * @property {string}   [indexJs]
 */

/** @type {ScopeDefinition[]} */
const scopes = [
    // -------------------------------------------------------------------------
    //  CORE
    // -------------------------------------------------------------------------
    {
        name: 'core',
        title: 'Core — App, Router, Request/Response',
        summary: 'App factory, Router, and the HTTP Request/Response wrappers.',
        description:
            'The HTTP foundation of @zero-server/sdk: `createApp()`, the Router primitive, ' +
            'and the Request/Response wrappers. Everything else builds on this surface.',
        exports: ['createApp', 'Router', 'version'],

        // lib/app.js + lib/router/ + lib/http/ are the core source
        sourceDirs: ['router', 'http'],
        sourceFiles: ['app.js'],
        bundleDebug: true,

        // All cross-scope requires in app.js and http/response.js are satisfied
        // by thin shim files so the originals never need editing.
        requireRewrites: {},
        extraShims: [
            // http/response.js needs SSEStream from realtime
            { file: 'sse/stream.js',        content: "module.exports = require('@zero-server/realtime').SSEStream;\n" },
            // app.js needs ws upgrade handler + room manager
            { file: 'ws/index.js',           content: "module.exports = require('@zero-server/realtime');\n" },
            // app.js needs gRPC service registry, health, reflection
            { file: 'grpc/server.js',        content: "module.exports = require('@zero-server/grpc');\n" },
            { file: 'grpc/health.js',        content: "module.exports = require('@zero-server/grpc');\n" },
            { file: 'grpc/reflection.js',    content: "module.exports = require('@zero-server/grpc');\n" },
            // app.js needs lifecycle manager
            { file: 'lifecycle.js',          content: "module.exports = require('@zero-server/lifecycle');\n" },
            // app.js needs observe (health checks, metrics, tracing)
            { file: 'observe/health.js',     content: "module.exports = require('@zero-server/observe');\n" },
            { file: 'observe/metrics.js',    content: "module.exports = require('@zero-server/observe');\n" },
            { file: 'observe/tracing.js',    content: "module.exports = require('@zero-server/observe');\n" },
            // app.js needs auth (jwt, session, oauth)
            { file: 'auth/jwt.js',           content: "module.exports = require('@zero-server/auth');\n" },
            { file: 'auth/session.js',       content: "module.exports = require('@zero-server/auth');\n" },
            { file: 'auth/oauth.js',         content: "module.exports = require('@zero-server/auth');\n" },
        ],
        typesFiles: ['app', 'router'],
        pkgDependencies: {
            '@zero-server/realtime':  true,
            '@zero-server/grpc':      true,
            '@zero-server/lifecycle': true,
            '@zero-server/observe':   true,
            '@zero-server/auth':      true,
        },
        indexJs: [
            "'use strict';",
            "const App    = require('./lib/app');",
            "const Router = require('./lib/router');",
            "const pkg    = require('./package.json');",
            "module.exports = {",
            "    createApp: () => new App(),",
            "    Router:    () => new Router(),",
            "    version:   pkg.version,",
            "};",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  BODY
    // -------------------------------------------------------------------------
    {
        name: 'body',
        title: 'Body parsers',
        summary: 'json, urlencoded, text, raw, multipart parsers.',
        description:
            'Streaming-aware request body parsers. Includes JSON, URL-encoded forms ' +
            '(flat or nested), plain text, raw bytes, and a multipart/form-data parser ' +
            'with file uploads.',
        exports: ['json', 'urlencoded', 'text', 'raw', 'multipart'],

        sourceDir: 'body',
        bundleDebug: false,
        requireRewrites: {},
        pkgDependencies: {},
        localMap: {},
        typesFiles: ['body'],
    },

    // -------------------------------------------------------------------------
    //  MIDDLEWARE
    // -------------------------------------------------------------------------
    {
        name: 'middleware',
        title: 'Middleware',
        summary: '20+ zero-dependency middleware.',
        description:
            'Cross-cutting middleware: CORS, security headers (helmet), compression ' +
            '(br/gzip/deflate), rate limiting, request logging, timeout enforcement, ' +
            'request IDs, cookie parsing, CSRF tokens, validation, central error handling, ' +
            'and static file serving.',
        exports: [
            'cors', 'helmet', 'compress', 'rateLimit', 'logger', 'timeout',
            'requestId', 'cookieParser', 'csrf', 'validate', 'errorHandler', 'static',
        ],

        sourceDir: 'middleware',
        bundleDebug: true,
        // errorHandler.js does require('../errors') — redirect to the scoped package
        requireRewrites: {
            "require('../errors')": "require('@zero-server/errors')",
        },
        pkgDependencies: {
            '@zero-server/errors': true,
        },
        localMap: {},
        typesFiles: ['middleware'],
    },

    // -------------------------------------------------------------------------
    //  AUTH
    // -------------------------------------------------------------------------
    {
        name: 'auth',
        title: 'Authentication & Authorization',
        summary: 'JWT, sessions, OAuth, authorize, MFA stack.',
        description:
            'Full auth layer with no external libraries: JWT (sign/verify/decode/JWKS/refresh ' +
            'pairs), session middleware with pluggable stores, OAuth 2.0 with PKCE and ' +
            'pre-configured providers, role/permission policies, and the MFA stack ' +
            '(TOTP/WebAuthn/trusted-device/enrollment).',
        exports: [
            'jwt', 'jwtSign', 'jwtVerify', 'jwtDecode', 'jwks', 'tokenPair',
            'createRefreshToken', 'SUPPORTED_ALGORITHMS',
            'session', 'Session', 'MemoryStore',
            'oauth', 'generatePKCE', 'generateState', 'OAUTH_PROVIDERS',
            'authorize', 'can', 'canAny', 'Policy', 'gate', 'attachUserHelpers',
            'twoFactor', 'webauthn', 'trustedDevice', 'enrollment',
        ],

        sourceDir: 'auth',
        bundleDebug: true,
        // jwt.js and oauth.js do require('../fetch') — redirect to the scoped package
        requireRewrites: {
            "require('../fetch')": "require('@zero-server/fetch')",
        },
        pkgDependencies: {
            '@zero-server/fetch': true,
        },
        // lib/auth/index.js uses internal names that differ from the public API
        localMap: {
            jwtSign:       'sign',
            jwtVerify:     'verify',
            jwtDecode:     'decode',
            OAUTH_PROVIDERS: 'PROVIDERS',
        },
        typesFiles: ['auth'],
    },

    // -------------------------------------------------------------------------
    //  ORM
    // -------------------------------------------------------------------------
    {
        name: 'orm',
        title: 'ORM',
        summary: 'Database, Model, Query, migrations, seeds, search, geo, tenancy, audit.',
        description:
            'Full-featured ORM with seven adapters (memory, JSON file, SQLite, MySQL, ' +
            'PostgreSQL, MongoDB, Redis) plus migrations, seeders, query caching, read ' +
            'replicas, full-text search, geo queries, multi-tenancy, audit logging, schema ' +
            'snapshots, query profiling, views, stored procedures/functions/triggers, and ' +
            'a plugin manager.',
        exports: [
            'Database', 'Model', 'TYPES', 'Query', 'validateFKAction', 'validateCheck',
            'Migrator', 'defineMigration',
            'QueryCache', 'Seeder', 'SeederRunner', 'Factory', 'Fake',
            'QueryProfiler', 'ReplicaManager',
            'DatabaseView', 'FullTextSearch', 'GeoQuery', 'EARTH_RADIUS_KM', 'EARTH_RADIUS_MI',
            'TenantManager', 'AuditLog', 'PluginManager',
            'StoredProcedure', 'StoredFunction', 'TriggerManager',
            'buildSnapshot', 'loadSnapshot', 'saveSnapshot', 'diffSnapshots',
            'hasNoChanges', 'generateMigrationCode', 'discoverModels', 'SNAPSHOT_FILE',
        ],

        sourceDir: 'orm',
        bundleDebug: true,
        // model.js does require('../errors') — redirect to the scoped package
        requireRewrites: {
            "require('../errors')": "require('@zero-server/errors')",
        },
        pkgDependencies: {
            '@zero-server/errors': true,
        },
        localMap: {},
        typesFiles: ['orm'],
    },

    // -------------------------------------------------------------------------
    //  REALTIME  (WebSocket + SSE)
    // -------------------------------------------------------------------------
    {
        name: 'realtime',
        title: 'Real-Time (WebSocket + SSE)',
        summary: 'WebSocket connection + room manager and SSE stream controller.',
        description:
            'Real-time primitives: RFC 6455 WebSocket connection wrapper, a `WebSocketPool` ' +
            'for rooms / broadcasting / sub-protocols, and the `SSEStream` controller used ' +
            'by `res.sse()`.',
        // handleUpgrade is added here so @zero-server/core can destructure it
        exports: ['WebSocketConnection', 'handleUpgrade', 'WebSocketPool', 'SSEStream'],

        // ws/ and sse/ are sibling subdirs — each goes into packages/realtime/lib/<dir>/
        // debug.js is placed at packages/realtime/lib/debug.js so that
        //   ../debug from lib/ws/* and lib/sse/* resolves correctly without any rewrites.
        sourceDirs: ['ws', 'sse'],
        bundleDebug: true,
        requireRewrites: {},
        pkgDependencies: {},
        typesFiles: ['sse', 'websocket'],
        indexJs: [
            "'use strict';",
            "const ws  = require('./lib/ws');",
            "const sse = require('./lib/sse');",
            "module.exports = {",
            "    WebSocketConnection: ws.WebSocketConnection,",
            "    handleUpgrade:       ws.handleUpgrade,",
            "    WebSocketPool:       ws.WebSocketPool,",
            "    SSEStream:           sse.SSEStream,",
            "};",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  gRPC
    // -------------------------------------------------------------------------
    {
        name: 'grpc',
        title: 'gRPC',
        summary: 'gRPC server, client, codec, framing, status, metadata, health, reflection, balancer.',
        description:
            'Full HTTP/2 gRPC stack with no external dependencies: a service registry, client, ' +
            'proto3 parser, protobuf codec, framing, status codes, metadata, health and ' +
            'reflection services, load balancer, channel credentials, and a proto file watcher.',
        exports: [
            'GrpcStatus', 'grpcToHttp', 'grpcStatusName', 'GRPC_STATUS_NAMES',
            'GrpcMetadata',
            'ProtoWriter', 'ProtoReader', 'protoEncode', 'protoDecode',
            'WIRE_TYPE', 'TYPE_INFO',
            'parseProto', 'parseProtoFile',
            'frameEncode', 'FrameParser',
            'GrpcServiceRegistry', 'GrpcClient',
            'GrpcHealthService', 'GrpcServingStatus',
            'GrpcReflectionService',
            'GrpcLoadBalancer', 'GrpcSubchannel', 'GrpcSubchannelState',
            'ChannelCredentials', 'createRotatingCredentials',
            'watchProto',
        ],

        sourceDir: 'grpc',
        bundleDebug: true,
        requireRewrites: {},
        pkgDependencies: {},
        typesFiles: ['grpc'],
        // lib/grpc/index.js exports under internal names; the SDK aliased them
        localMap: {
            grpcStatusName:       'statusName',
            GRPC_STATUS_NAMES:    'STATUS_NAMES',
            GrpcMetadata:         'Metadata',
            ProtoWriter:          'Writer',
            ProtoReader:          'Reader',
            protoEncode:          'encode',
            protoDecode:          'decode',
            GrpcHealthService:    'HealthService',
            GrpcServingStatus:    'ServingStatus',
            GrpcReflectionService:'ReflectionService',
            GrpcLoadBalancer:     'LoadBalancer',
            GrpcSubchannel:       'Subchannel',
            GrpcSubchannelState:  'SubchannelState',
        },
    },

    // -------------------------------------------------------------------------
    //  OBSERVE
    // -------------------------------------------------------------------------
    {
        name: 'observe',
        title: 'Observability',
        summary: 'Metrics, structured logging, distributed tracing, health checks.',
        description:
            'Prometheus-compatible metrics (Counter / Gauge / Histogram / Registry), ' +
            'structured logging, W3C Trace Context tracing (`Tracer`/`Span`/`traceparent`), ' +
            'and pluggable health checks (memory, event loop, disk).',
        exports: [
            'Logger', 'structuredLogger',
            'Counter', 'Gauge', 'Histogram', 'MetricsRegistry', 'DEFAULT_BUCKETS',
            'createDefaultMetrics', 'metricsMiddleware', 'metricsEndpoint',
            'Span', 'Tracer', 'parseTraceparent', 'formatTraceparent',
            'tracingMiddleware', 'instrumentFetch',
            'healthCheck', 'createHealthHandlers',
            'memoryCheck', 'eventLoopCheck', 'diskSpaceCheck',
        ],

        // observe/* has zero cross-scope imports — fully self-contained
        sourceDir: 'observe',
        bundleDebug: false,
        requireRewrites: {},
        pkgDependencies: {},
        localMap: {},
        typesFiles: ['observe'],
    },

    // -------------------------------------------------------------------------
    //  LIFECYCLE  (+ Cluster)
    // -------------------------------------------------------------------------
    {
        name: 'lifecycle',
        title: 'Lifecycle & Clustering',
        summary: 'Graceful shutdown manager and multi-worker clustering.',
        description:
            'Graceful shutdown with signal handlers, in-flight request draining, automatic ' +
            'WebSocket / SSE / database cleanup, plus multi-worker clustering with ' +
            'auto-respawn and exponential backoff.',
        exports: ['LifecycleManager', 'LIFECYCLE_STATE', 'ClusterManager', 'cluster'],

        // Both lifecycle.js and cluster.js use require('./debug') — the bundled
        // debug.js at packages/lifecycle/lib/debug.js satisfies that path.
        sourceFiles: ['lifecycle.js', 'cluster.js'],
        bundleDebug: true,
        requireRewrites: {},
        pkgDependencies: {},
        typesFiles: ['lifecycle', 'cluster'],
        // Two separate modules — must use explicit indexJs
        indexJs: [
            "'use strict';",
            "const lifecycle = require('./lib/lifecycle');",
            "const cluster   = require('./lib/cluster');",
            "module.exports = {",
            "    LifecycleManager: lifecycle.LifecycleManager,",
            "    LIFECYCLE_STATE:  lifecycle.LIFECYCLE_STATE,",
            "    ClusterManager:   cluster.ClusterManager,",
            "    cluster:          cluster.clusterize,",
            "};",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  ENV
    // -------------------------------------------------------------------------
    {
        name: 'env',
        title: 'Environment',
        summary: 'Typed .env loader with schema validation.',
        description:
            'Typed `.env` loader with multi-file support (`.env`, `.env.local`, ' +
            '`.env.{NODE_ENV}`, `.env.{NODE_ENV}.local`), variable interpolation, and ' +
            'schema-driven type coercion (string, number, integer, port, boolean, array, ' +
            'json, url, enum).',
        exports: ['env'],

        sourceDir: 'env',
        bundleDebug: false,
        requireRewrites: {},
        pkgDependencies: {},
        localMap: {},
        typesFiles: ['env'],
        // lib/env/index.js exports the env object as module.exports directly
        indexJs: [
            "'use strict';",
            "const env = require('./lib/env');",
            "module.exports = { env };",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  FETCH
    // -------------------------------------------------------------------------
    {
        name: 'fetch',
        title: 'fetch (HTTP client)',
        summary: 'Server-side fetch with mTLS, timeouts, AbortSignal.',
        description:
            'Built-in `fetch()` for outbound HTTP/HTTPS calls. Supports mTLS, custom CA ' +
            'bundles, timeouts, `AbortSignal`, progress callbacks, JSON / form / stream ' +
            'bodies, and retries.',
        exports: ['fetch'],

        sourceDir: 'fetch',
        bundleDebug: false,
        requireRewrites: {},
        pkgDependencies: {},
        localMap: {},
        typesFiles: ['fetch'],
        // lib/fetch/index.js exports the fetch function as module.exports directly
        indexJs: [
            "'use strict';",
            "const fetch = require('./lib/fetch');",
            "module.exports = { fetch };",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  ERRORS
    // -------------------------------------------------------------------------
    {
        name: 'errors',
        title: 'Errors',
        summary: 'HttpError + 25+ typed framework and ORM errors.',
        description:
            'Every typed error class shipped by the SDK: HTTP status errors, framework ' +
            'errors (configuration / middleware / routing / timeout), ORM errors (database ' +
            '/ connection / migration / transaction / query / adapter / cache), and the ' +
            'Phase 4 errors (tenancy / audit / plugin / procedure). Plus the `createError` ' +
            'factory, `isHttpError` guard, and the lightweight `debug` logger.',
        exports: [
            'HttpError', 'BadRequestError', 'UnauthorizedError', 'ForbiddenError',
            'NotFoundError', 'MethodNotAllowedError', 'ConflictError', 'GoneError',
            'PayloadTooLargeError', 'UnprocessableEntityError', 'ValidationError',
            'TooManyRequestsError', 'InternalError', 'NotImplementedError',
            'BadGatewayError', 'ServiceUnavailableError',
            'DatabaseError', 'ConfigurationError', 'MiddlewareError', 'RoutingError',
            'TimeoutError', 'ConnectionError', 'MigrationError', 'TransactionError',
            'QueryError', 'AdapterError', 'CacheError',
            'TenancyError', 'AuditError', 'PluginError', 'ProcedureError',
            'createError', 'isHttpError',
            'debug',
        ],

        // errors.js is a single file; debug.js is bundled alongside it
        sourceFile: 'errors.js',
        bundleDebug: true,
        requireRewrites: {},
        pkgDependencies: {},
        typesFiles: ['errors'],
        // errors is a single module; debug is a separate file — explicit indexJs
        indexJs: [
            "'use strict';",
            "const errors = require('./lib/errors');",
            "const debug  = require('./lib/debug');",
            "module.exports = {",
            "    HttpError:                  errors.HttpError,",
            "    BadRequestError:            errors.BadRequestError,",
            "    UnauthorizedError:          errors.UnauthorizedError,",
            "    ForbiddenError:             errors.ForbiddenError,",
            "    NotFoundError:              errors.NotFoundError,",
            "    MethodNotAllowedError:      errors.MethodNotAllowedError,",
            "    ConflictError:              errors.ConflictError,",
            "    GoneError:                  errors.GoneError,",
            "    PayloadTooLargeError:       errors.PayloadTooLargeError,",
            "    UnprocessableEntityError:   errors.UnprocessableEntityError,",
            "    ValidationError:            errors.ValidationError,",
            "    TooManyRequestsError:       errors.TooManyRequestsError,",
            "    InternalError:              errors.InternalError,",
            "    NotImplementedError:        errors.NotImplementedError,",
            "    BadGatewayError:            errors.BadGatewayError,",
            "    ServiceUnavailableError:    errors.ServiceUnavailableError,",
            "    DatabaseError:              errors.DatabaseError,",
            "    ConfigurationError:         errors.ConfigurationError,",
            "    MiddlewareError:            errors.MiddlewareError,",
            "    RoutingError:               errors.RoutingError,",
            "    TimeoutError:               errors.TimeoutError,",
            "    ConnectionError:            errors.ConnectionError,",
            "    MigrationError:             errors.MigrationError,",
            "    TransactionError:           errors.TransactionError,",
            "    QueryError:                 errors.QueryError,",
            "    AdapterError:               errors.AdapterError,",
            "    CacheError:                 errors.CacheError,",
            "    TenancyError:               errors.TenancyError,",
            "    AuditError:                 errors.AuditError,",
            "    PluginError:                errors.PluginError,",
            "    ProcedureError:             errors.ProcedureError,",
            "    createError:                errors.createError,",
            "    isHttpError:                errors.isHttpError,",
            "    debug,",
            "};",
        ].join('\n') + '\n',
    },

    // -------------------------------------------------------------------------
    //  CLI
    // -------------------------------------------------------------------------
    {
        name: 'cli',
        title: 'CLI runner',
        summary: 'Programmatic access to the `zh` / `zs` CLI.',
        description:
            'Programmatic entry points for the bundled CLI (`zh` / `zs`): scaffolding, ' +
            'migrations, seeding, rollback, status. Useful when embedding the CLI inside ' +
            'your own tooling.',
        exports: ['CLI', 'runCLI'],

        sourceFile: 'cli.js',
        bundleDebug: false,
        requireRewrites: {
            // cli.js lazy-requires orm and orm/snapshot at runtime
            "require('./orm')":          "require('@zero-server/orm')",
            "require('./orm/snapshot')": "require('@zero-server/orm')",
        },
        pkgDependencies: {
            '@zero-server/orm': true,
        },
        localMap: {},
        typesFiles: ['cli'],
    },
];

module.exports = { scopes };
