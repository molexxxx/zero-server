/**
 * scope-manifest.js — Source of truth for the scoped @zero-server/* packages.
 *
 * Every section of the SDK that gets its own published scoped package is
 * defined here. Each scope lists:
 *   - name        package suffix (e.g. "core" -> "@zero-server/core")
 *   - title       human-readable section title
 *   - summary     one-line summary used in tables / cards
 *   - description multi-line description for the scope page / npm README
 *   - exports     names re-exported from `@zero-server/sdk` for this scope
 *
 * The generator scripts (.tools/generate-package-stubs.js,
 * .tools/generate-scope-docs.js, .tools/publish-package-stubs.js) read this
 * file. To grow or shrink a scope's surface, edit `exports` and re-run
 * `npm run packages:generate`.
 */

/**
 * @typedef {object} ScopeDefinition
 * @property {string} name
 * @property {string} title
 * @property {string} summary
 * @property {string} description
 * @property {string[]} exports
 */

/** @type {ScopeDefinition[]} */
const scopes = [
    {
        name: 'core',
        title: 'Core — App, Router, Request/Response',
        summary: 'App factory, Router, and the HTTP Request/Response wrappers.',
        description:
            'The HTTP foundation of @zero-server/sdk: `createApp()`, the Router primitive, and the Request/Response wrappers. Everything else builds on this surface.',
        exports: ['createApp', 'Router', 'version'],
    },
    {
        name: 'body',
        title: 'Body parsers',
        summary: 'json, urlencoded, text, raw, multipart parsers.',
        description:
            'Streaming-aware request body parsers. Includes JSON, URL-encoded forms (flat or nested), plain text, raw bytes, and a multipart/form-data parser with file uploads.',
        exports: ['json', 'urlencoded', 'text', 'raw', 'multipart'],
    },
    {
        name: 'middleware',
        title: 'Middleware',
        summary: '20+ zero-dependency middleware.',
        description:
            'Cross-cutting middleware: CORS, security headers (helmet), compression (br/gzip/deflate), rate limiting, request logging, timeout enforcement, request IDs, cookie parsing, CSRF tokens, validation, central error handling, and static file serving.',
        exports: [
            'cors',
            'helmet',
            'compress',
            'rateLimit',
            'logger',
            'timeout',
            'requestId',
            'cookieParser',
            'csrf',
            'validate',
            'errorHandler',
            'static',
        ],
    },
    {
        name: 'auth',
        title: 'Authentication & Authorization',
        summary: 'JWT, sessions, OAuth, authorize, MFA stack.',
        description:
            'Full auth layer with no external libraries: JWT (sign/verify/decode/JWKS/refresh pairs), session middleware with pluggable stores, OAuth 2.0 with PKCE and pre-configured providers, role/permission policies, and the MFA stack (TOTP/WebAuthn/trusted-device/enrollment).',
        exports: [
            'jwt', 'jwtSign', 'jwtVerify', 'jwtDecode', 'jwks', 'tokenPair', 'createRefreshToken', 'SUPPORTED_ALGORITHMS',
            'session', 'Session', 'MemoryStore',
            'oauth', 'generatePKCE', 'generateState', 'OAUTH_PROVIDERS',
            'authorize', 'can', 'canAny', 'Policy', 'gate', 'attachUserHelpers',
            'twoFactor', 'webauthn', 'trustedDevice', 'enrollment',
        ],
    },
    {
        name: 'orm',
        title: 'ORM',
        summary: 'Database, Model, Query, migrations, seeds, search, geo, tenancy, audit.',
        description:
            'Full-featured ORM with seven adapters (memory, JSON file, SQLite, MySQL, PostgreSQL, MongoDB, Redis) plus migrations, seeders, query caching, read replicas, full-text search, geo queries, multi-tenancy, audit logging, schema snapshots, query profiling, views, stored procedures/functions/triggers, and a plugin manager.',
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
    },
    {
        name: 'realtime',
        title: 'Real-Time (WebSocket + SSE)',
        summary: 'WebSocket connection + room manager and SSE stream controller.',
        description:
            'Real-time primitives: RFC 6455 WebSocket connection wrapper, a `WebSocketPool` for rooms / broadcasting / sub-protocols, and the `SSEStream` controller used by `res.sse()`.',
        exports: ['WebSocketConnection', 'WebSocketPool', 'SSEStream'],
    },
    {
        name: 'grpc',
        title: 'gRPC',
        summary: 'gRPC server, client, codec, framing, status, metadata, health, reflection, balancer.',
        description:
            'Full HTTP/2 gRPC stack with no external dependencies: a service registry, client, proto3 parser, protobuf codec, framing, status codes, metadata, health and reflection services, load balancer, channel credentials, and a proto file watcher.',
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
    },
    {
        name: 'observe',
        title: 'Observability',
        summary: 'Metrics, structured logging, distributed tracing, health checks.',
        description:
            'Prometheus-compatible metrics (Counter / Gauge / Histogram / Registry), structured logging, W3C Trace Context tracing (`Tracer`/`Span`/`traceparent`), and pluggable health checks (memory, event loop, disk).',
        exports: [
            'Logger', 'structuredLogger',
            'Counter', 'Gauge', 'Histogram', 'MetricsRegistry', 'DEFAULT_BUCKETS',
            'createDefaultMetrics', 'metricsMiddleware', 'metricsEndpoint',
            'Span', 'Tracer', 'parseTraceparent', 'formatTraceparent', 'tracingMiddleware', 'instrumentFetch',
            'healthCheck', 'createHealthHandlers', 'memoryCheck', 'eventLoopCheck', 'diskSpaceCheck',
        ],
    },
    {
        name: 'lifecycle',
        title: 'Lifecycle & Clustering',
        summary: 'Graceful shutdown manager and multi-worker clustering.',
        description:
            'Graceful shutdown with signal handlers, in-flight request draining, automatic WebSocket / SSE / database cleanup, plus multi-worker clustering with auto-respawn and exponential backoff.',
        exports: ['LifecycleManager', 'LIFECYCLE_STATE', 'ClusterManager', 'cluster'],
    },
    {
        name: 'env',
        title: 'Environment',
        summary: 'Typed .env loader with schema validation.',
        description:
            'Typed `.env` loader with multi-file support (`.env`, `.env.local`, `.env.{NODE_ENV}`, `.env.{NODE_ENV}.local`), variable interpolation, and schema-driven type coercion (string, number, integer, port, boolean, array, json, url, enum).',
        exports: ['env'],
    },
    {
        name: 'fetch',
        title: 'fetch (HTTP client)',
        summary: 'Server-side fetch with mTLS, timeouts, AbortSignal.',
        description:
            'Built-in `fetch()` for outbound HTTP/HTTPS calls. Supports mTLS, custom CA bundles, timeouts, `AbortSignal`, progress callbacks, JSON / form / stream bodies, and retries.',
        exports: ['fetch'],
    },
    {
        name: 'errors',
        title: 'Errors',
        summary: 'HttpError + 25+ typed framework and ORM errors.',
        description:
            'Every typed error class shipped by the SDK: HTTP status errors, framework errors (configuration / middleware / routing / timeout), ORM errors (database / connection / migration / transaction / query / adapter / cache), and the Phase 4 errors (tenancy / audit / plugin / procedure). Plus the `createError` factory and `isHttpError` guard.',
        exports: [
            'HttpError', 'BadRequestError', 'UnauthorizedError', 'ForbiddenError',
            'NotFoundError', 'MethodNotAllowedError', 'ConflictError', 'GoneError',
            'PayloadTooLargeError', 'UnprocessableEntityError', 'ValidationError',
            'TooManyRequestsError', 'InternalError', 'NotImplementedError',
            'BadGatewayError', 'ServiceUnavailableError',
            'DatabaseError', 'ConfigurationError', 'MiddlewareError', 'RoutingError', 'TimeoutError',
            'ConnectionError', 'MigrationError', 'TransactionError', 'QueryError', 'AdapterError', 'CacheError',
            'TenancyError', 'AuditError', 'PluginError', 'ProcedureError',
            'createError', 'isHttpError',
            'debug',
        ],
    },
    {
        name: 'cli',
        title: 'CLI runner',
        summary: 'Programmatic access to the `zh` / `zs` CLI.',
        description:
            'Programmatic entry points for the bundled CLI (`zh` / `zs`): scaffolding, migrations, seeding, rollback, status. Useful when embedding the CLI inside your own tooling.',
        exports: ['CLI', 'runCLI'],
    },
];

module.exports = { scopes };
