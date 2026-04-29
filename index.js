/**
 * @module @zero-server/sdk
 * @description Public entry point for the @zero-server/sdk package.
 *              Re-exports every middleware, the app factory, and the fetch helper.
 */
const App = require('./lib/app');
const Router = require('./lib/router');
const cors = require('./lib/middleware/cors');
const fetch = require('./lib/fetch');
const body = require('./lib/body');
const serveStatic = require('./lib/middleware/static');
const rateLimit = require('./lib/middleware/rateLimit');
const logger = require('./lib/middleware/logger');
const compress = require('./lib/middleware/compress');
const helmet = require('./lib/middleware/helmet');
const timeout = require('./lib/middleware/timeout');
const requestId = require('./lib/middleware/requestId');
const cookieParser = require('./lib/middleware/cookieParser');
const csrf = require('./lib/middleware/csrf');
const validate = require('./lib/middleware/validator');
const errorHandler = require('./lib/middleware/errorHandler');
const { WebSocketConnection, handleUpgrade, WebSocketPool } = require('./lib/ws');
const { SSEStream } = require('./lib/sse');
const env = require('./lib/env');
const { Database, Model, TYPES, Query, validateFKAction, validateCheck, Migrator, defineMigration, QueryCache, Seeder, SeederRunner, Factory, Fake, QueryProfiler, ReplicaManager, DatabaseView, FullTextSearch, GeoQuery, EARTH_RADIUS_KM, EARTH_RADIUS_MI, TenantManager, AuditLog, PluginManager, StoredProcedure, StoredFunction, TriggerManager, buildSnapshot, loadSnapshot, saveSnapshot, diffSnapshots, hasNoChanges, generateMigrationCode, discoverModels, SNAPSHOT_FILE } = require('./lib/orm');
const { CLI, runCLI } = require('./lib/cli');
const errors = require('./lib/errors');
const debug = require('./lib/debug');
const { LifecycleManager, LIFECYCLE_STATE } = require('./lib/lifecycle');
const { ClusterManager, clusterize } = require('./lib/cluster');
const {
    Logger, structuredLogger,
    Counter, Gauge, Histogram, MetricsRegistry, DEFAULT_BUCKETS,
    createDefaultMetrics, metricsMiddleware, metricsEndpoint: metricsEndpointHandler,
    Span, Tracer, parseTraceparent, formatTraceparent, tracingMiddleware, instrumentFetch,
    healthCheck, createHealthHandlers, memoryCheck, eventLoopCheck, diskSpaceCheck,
} = require('./lib/observe');
const {
    jwt, sign: jwtSign, verify: jwtVerify, decode: jwtDecode, jwks, tokenPair, createRefreshToken, SUPPORTED_ALGORITHMS,
    session, Session, MemoryStore,
    oauth, generatePKCE, generateState, PROVIDERS: OAUTH_PROVIDERS,
    authorize, can, canAny, Policy, gate, attachUserHelpers,
    twoFactor,
    webauthn,
    trustedDevice,
    enrollment,
} = require('./lib/auth');
const {
    GrpcStatus, grpcToHttp, statusName: grpcStatusName, STATUS_NAMES: GRPC_STATUS_NAMES,
    Metadata: GrpcMetadata,
    Writer: ProtoWriter, Reader: ProtoReader, encode: protoEncode, decode: protoDecode,
    WIRE_TYPE, TYPE_INFO,
    parseProto, parseProtoFile,
    frameEncode, FrameParser,
    GrpcServiceRegistry, GrpcClient,
    HealthService: GrpcHealthService, ServingStatus: GrpcServingStatus,
    ReflectionService: GrpcReflectionService,
    LoadBalancer: GrpcLoadBalancer, Subchannel: GrpcSubchannel, SubchannelState: GrpcSubchannelState,
    ChannelCredentials, createRotatingCredentials,
    watchProto,
} = require('./lib/grpc');
const { version } = require('./package.json');

module.exports = {
    /**
     * Create a new application instance.
     * @returns {import('./lib/app')} Fresh App with an empty middleware stack.
     */
    createApp: () => new App(),
    /**
     * Create a standalone Router for modular route grouping.
     * Mount on an App with `app.use('/prefix', router)`.
     * @returns {import('./lib/router')} Fresh Router instance.
     */
    Router: () => new Router(),
    /** @see module:cors */
    cors,
    /** @see module:fetch */
    fetch,
    // body parsers
    /** @see module:body/json */
    json: body.json,
    /** @see module:body/urlencoded */
    urlencoded: body.urlencoded,
    /** @see module:body/text */
    text: body.text,
    /** @see module:body/raw */
    raw: body.raw,
    /** @see module:body/multipart */
    multipart: body.multipart,
    // serving
    /** @see module:static */
    static: serveStatic,
    // middleware
    /** @see module:rateLimit */
    rateLimit,
    /** @see module:logger */
    logger,
    /** @see module:compress */
    compress,
    /** @see module:helmet */
    helmet,
    /** @see module:timeout */
    timeout,
    /** @see module:requestId */
    requestId,
    /** @see module:cookieParser */
    cookieParser,
    /** @see module:csrf */
    csrf,
    /** @see module:validator */
    validate,
    /** @see module:middleware/errorHandler */
    errorHandler,
    // env
    /** @see module:env */
    env,
    // ORM
    /** @see module:orm */
    Database,
    /** @see module:orm/model */
    Model,
    /** @see module:orm/schema */
    TYPES,
    /** @see module:orm/query */
    Query,
    /** @see module:orm/schema */
    validateFKAction,
    /** @see module:orm/schema */
    validateCheck,
    // ORM: Migration framework
    /** @see module:orm/migrate */
    Migrator,
    /** @see module:orm/migrate */
    defineMigration,
    // ORM: Schema snapshots (EF Core–style auto-migrations)
    /** @see module:orm/snapshot */
    buildSnapshot,
    loadSnapshot,
    saveSnapshot,
    diffSnapshots,
    hasNoChanges,
    generateMigrationCode,
    discoverModels,
    SNAPSHOT_FILE,
    // ORM: Query caching
    /** @see module:orm/cache */
    QueryCache,
    // ORM: Seeding
    /** @see module:orm/seed */
    Seeder,
    /** @see module:orm/seed */
    SeederRunner,
    /** @see module:orm/seed */
    Factory,
    /** @see module:orm/seed */
    Fake,
    // ORM: Performance & Scalability
    /** @see module:orm/profiler */
    QueryProfiler,
    /** @see module:orm/replicas */
    ReplicaManager,
    // ORM: Advanced Features (Phase 3)
    /** @see module:orm/views */
    DatabaseView,
    /** @see module:orm/search */
    FullTextSearch,
    /** @see module:orm/geo */
    GeoQuery,
    /** @see module:orm/geo */
    EARTH_RADIUS_KM,
    /** @see module:orm/geo */
    EARTH_RADIUS_MI,
    // ORM: Enterprise Infrastructure (Phase 4)
    /** @see module:orm/tenancy */
    TenantManager,
    /** @see module:orm/audit */
    AuditLog,
    /** @see module:orm/plugin */
    PluginManager,
    /** @see module:orm/procedures */
    StoredProcedure,
    /** @see module:orm/procedures */
    StoredFunction,
    /** @see module:orm/procedures */
    TriggerManager,
    // Error handling & debugging
    /** @see module:errors */
    HttpError: errors.HttpError,
    BadRequestError: errors.BadRequestError,
    UnauthorizedError: errors.UnauthorizedError,
    ForbiddenError: errors.ForbiddenError,
    NotFoundError: errors.NotFoundError,
    MethodNotAllowedError: errors.MethodNotAllowedError,
    ConflictError: errors.ConflictError,
    GoneError: errors.GoneError,
    PayloadTooLargeError: errors.PayloadTooLargeError,
    UnprocessableEntityError: errors.UnprocessableEntityError,
    ValidationError: errors.ValidationError,
    TooManyRequestsError: errors.TooManyRequestsError,
    InternalError: errors.InternalError,
    NotImplementedError: errors.NotImplementedError,
    BadGatewayError: errors.BadGatewayError,
    ServiceUnavailableError: errors.ServiceUnavailableError,
    // Framework-specific errors
    DatabaseError: errors.DatabaseError,
    ConfigurationError: errors.ConfigurationError,
    MiddlewareError: errors.MiddlewareError,
    RoutingError: errors.RoutingError,
    TimeoutError: errors.TimeoutError,
    // ORM-specific errors
    ConnectionError: errors.ConnectionError,
    MigrationError: errors.MigrationError,
    TransactionError: errors.TransactionError,
    QueryError: errors.QueryError,
    AdapterError: errors.AdapterError,
    CacheError: errors.CacheError,
    // Phase 4 errors
    TenancyError: errors.TenancyError,
    AuditError: errors.AuditError,
    PluginError: errors.PluginError,
    ProcedureError: errors.ProcedureError,
    createError: errors.createError,
    isHttpError: errors.isHttpError,
    /** @see module:debug */
    debug,
    // ORM: CLI tooling
    /** @see module:cli */
    CLI,
    /** @see module:cli */
    runCLI,
    // classes (for advanced / direct usage)
    /** @see module:ws/connection */
    WebSocketConnection,
    /** @see module:ws/handshake */
    handleUpgrade,
    /** @see module:ws/room */
    WebSocketPool,
    /** @see module:sse/stream */
    SSEStream,
    // Lifecycle & Clustering
    /** @see module:lifecycle */
    LifecycleManager,
    /** @see module:lifecycle */
    LIFECYCLE_STATE,
    /** @see module:cluster */
    ClusterManager,
    /** @see module:cluster */
    cluster: clusterize,
    // Observability — Structured Logging
    /** @see module:observe/logger */
    Logger,
    /** @see module:observe/logger */
    structuredLogger,
    // Observability — Metrics
    /** @see module:observe/metrics */
    Counter,
    /** @see module:observe/metrics */
    Gauge,
    /** @see module:observe/metrics */
    Histogram,
    /** @see module:observe/metrics */
    MetricsRegistry,
    /** @see module:observe/metrics */
    DEFAULT_BUCKETS,
    /** @see module:observe/metrics */
    createDefaultMetrics,
    /** @see module:observe/metrics */
    metricsMiddleware,
    /** @see module:observe/metrics */
    metricsEndpoint: metricsEndpointHandler,
    // Observability — Tracing
    /** @see module:observe/tracing */
    Span,
    /** @see module:observe/tracing */
    Tracer,
    /** @see module:observe/tracing */
    parseTraceparent,
    /** @see module:observe/tracing */
    formatTraceparent,
    /** @see module:observe/tracing */
    tracingMiddleware,
    /** @see module:observe/tracing */
    instrumentFetch,
    // Observability — Health Checks
    /** @see module:observe/health */
    healthCheck,
    /** @see module:observe/health */
    createHealthHandlers,
    /** @see module:observe/health */
    memoryCheck,
    /** @see module:observe/health */
    eventLoopCheck,
    /** @see module:observe/health */
    diskSpaceCheck,
    // Authentication & Sessions (Phase 3)
    /** @see module:auth/jwt */
    jwt,
    /** @see module:auth/jwt */
    jwtSign,
    /** @see module:auth/jwt */
    jwtVerify,
    /** @see module:auth/jwt */
    jwtDecode,
    /** @see module:auth/jwt */
    jwks,
    /** @see module:auth/jwt */
    tokenPair,
    /** @see module:auth/jwt */
    createRefreshToken,
    /** @see module:auth/jwt */
    SUPPORTED_ALGORITHMS,
    // Auth: Sessions
    /** @see module:auth/session */
    session,
    /** @see module:auth/session */
    Session,
    /** @see module:auth/session */
    MemoryStore,
    // Auth: OAuth2
    /** @see module:auth/oauth */
    oauth,
    /** @see module:auth/oauth */
    generatePKCE,
    /** @see module:auth/oauth */
    generateState,
    /** @see module:auth/oauth */
    OAUTH_PROVIDERS,
    // Auth: Authorization
    /** @see module:auth/authorize */
    authorize,
    /** @see module:auth/authorize */
    can,
    /** @see module:auth/authorize */
    canAny,
    /** @see module:auth/authorize */
    Policy,
    /** @see module:auth/authorize */
    gate,
    /** @see module:auth/authorize */
    attachUserHelpers,
    // Auth: Two-Factor Authentication
    /** @see module:auth/twoFactor */
    twoFactor,
    // Auth: WebAuthn / Passkeys
    /** @see module:auth/webauthn */
    webauthn,
    // Auth: Trusted Device / Remember Me
    /** @see module:auth/trustedDevice */
    trustedDevice,
    // Auth: 2FA Enrollment Flow
    /** @see module:auth/enrollment */
    enrollment,
    // gRPC
    /** @see module:grpc/status */
    GrpcStatus,
    /** @see module:grpc/status */
    grpcToHttp,
    /** @see module:grpc/status */
    grpcStatusName,
    /** @see module:grpc/status */
    GRPC_STATUS_NAMES,
    /** @see module:grpc/metadata */
    GrpcMetadata,
    /** @see module:grpc/codec */
    ProtoWriter,
    /** @see module:grpc/codec */
    ProtoReader,
    /** @see module:grpc/codec */
    protoEncode,
    /** @see module:grpc/codec */
    protoDecode,
    /** @see module:grpc/codec */
    WIRE_TYPE,
    /** @see module:grpc/codec */
    TYPE_INFO,
    /** @see module:grpc/proto */
    parseProto,
    /** @see module:grpc/proto */
    parseProtoFile,
    /** @see module:grpc/frame */
    frameEncode,
    /** @see module:grpc/frame */
    FrameParser,
    /** @see module:grpc/server */
    GrpcServiceRegistry,
    /** @see module:grpc/client */
    GrpcClient,
    // gRPC: Health check
    /** @see module:grpc/health */
    GrpcHealthService,
    /** @see module:grpc/health */
    GrpcServingStatus,
    // gRPC: Server reflection
    /** @see module:grpc/reflection */
    GrpcReflectionService,
    // gRPC: Load balancing
    /** @see module:grpc/balancer */
    GrpcLoadBalancer,
    /** @see module:grpc/balancer */
    GrpcSubchannel,
    /** @see module:grpc/balancer */
    GrpcSubchannelState,
    // gRPC: Channel credentials
    /** @see module:grpc/credentials */
    ChannelCredentials,
    /** @see module:grpc/credentials */
    createRotatingCredentials,
    // gRPC: Proto hot-reload
    /** @see module:grpc/watch */
    watchProto,
    /** Package version */
    version,
};
