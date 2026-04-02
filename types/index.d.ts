// Type definitions for zero-http
// Project: https://github.com/tonywied17/zero-http
// Definitions by: zero-http contributors

/// <reference types="node" />

// --- Re-exports from individual type modules ---------------------

export { App } from './app';
export { RouterInstance, RouteChain, RouteEntry, RouteInfo, RouteOptions, RouteHandler } from './router';
export { Request, RangeResult } from './request';
export { Response, SendFileOptions, CookieOptions } from './response';
export { SSEOptions, SSEStream } from './sse';
export { WebSocketOptions, WebSocketHandler, WebSocketConnection, WebSocketPool } from './websocket';
export {
    NextFunction, MiddlewareFunction, ErrorHandlerFunction,
    CorsOptions, cors,
    BodyParserOptions, JsonParserOptions, UrlencodedParserOptions, TextParserOptions,
    MultipartOptions, MultipartFile,
    json, urlencoded, text, raw, multipart,
    RateLimitOptions, rateLimit,
    LoggerOptions, logger,
    CompressOptions, compress,
    HelmetOptions, helmet,
    TimeoutOptions, timeout,
    RequestIdOptions, requestId,
    CookieParserStatic, cookieParser,
    StaticOptions,
    CsrfOptions, csrf,
    ValidationRule, ValidatorSchema, ValidatorOptions, ValidateFunction, validate,
} from './middleware';
export { static } from './middleware';
export {
    FetchOptions, FetchResponse, FetchHeaders, fetch,
} from './fetch';
export { Env, EnvFieldDef, EnvSchema, EnvLoadOptions, env } from './env';
export {
    TYPES, SchemaColumnDef, validateValue, validateFKAction, validateCheck,
    Query, Model, ModelHooks, ModelObserver, FindOrCreateResult, PaginatedResult,
    Database, AdapterType, RetryOptions,
    DatabaseView, DatabaseViewOptions,
    FullTextSearch, FullTextSearchOptions, SearchOptions, SuggestOptions,
    GeoQuery, GeoQueryOptions, NearOptions, WithinBounds,
    GeoJSONPoint, GeoJSONFeature, GeoJSONFeatureCollection,
    EARTH_RADIUS_KM, EARTH_RADIUS_MI,
    Migrator, MigrationDefinition, MigrateResult, RollbackResult, MigrationStatus, defineMigration,
    QueryCache, QueryCacheOptions, CacheStats,
    Seeder, SeederRunner, Factory, Fake,
    QueryProfiler, QueryProfilerOptions, ProfiledQuery, N1Detection, ProfilerMetrics,
    ReplicaManager, ReplicaManagerOptions, HealthCheckResult,
    // Phase 4
    TenantManager, TenantManagerOptions, TenantMiddlewareOptions,
    AuditLog, AuditLogOptions, AuditEntry, AuditTrailOptions, AuditMiddlewareOptions,
    PluginManager, PluginDefinition, PluginInfo,
    StoredProcedure, StoredProcedureOptions, ProcedureParam,
    StoredFunction, StoredFunctionOptions,
    TriggerManager, TriggerDefinition,
    CLI, runCLI,
} from './orm';
// Re-export validate from orm as schemaValidate to avoid collision with middleware validate
export { validate as schemaValidate } from './orm';
export {
    HttpError, HttpErrorOptions,
    BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError,
    MethodNotAllowedError, ConflictError, GoneError, PayloadTooLargeError,
    UnprocessableEntityError, ValidationError, TooManyRequestsError,
    InternalError, NotImplementedError, BadGatewayError, ServiceUnavailableError,
    DatabaseError, DatabaseErrorOptions,
    ConfigurationError, ConfigurationErrorOptions,
    MiddlewareError, MiddlewareErrorOptions,
    RoutingError, RoutingErrorOptions,
    TimeoutError, TimeoutErrorOptions,
    ConnectionError, ConnectionErrorOptions,
    MigrationError, MigrationErrorOptions,
    TransactionError, TransactionErrorOptions,
    QueryError, QueryErrorOptions,
    AdapterError, AdapterErrorOptions,
    CacheError, CacheErrorOptions,
    TenancyError, TenancyErrorOptions,
    AuditError, AuditErrorOptions,
    PluginError, PluginErrorOptions,
    ProcedureError, ProcedureErrorOptions,
    createError, isHttpError,
    ErrorHandlerOptions, errorHandler,
    Debug, DebugLogger, DebugLevels, debug,
} from './errors';

// --- Module Exports ----------------------------------------------

import { App } from './app';
import { RouterInstance } from './router';
import { WebSocketConnection, WebSocketPool } from './websocket';
import { SSEStream } from './sse';
import {
    cors, json, urlencoded, text, raw, multipart,
    rateLimit, logger, compress, helmet, timeout, requestId,
    CookieParserStatic, csrf, ValidateFunction,
} from './middleware';
import { fetch } from './fetch';
import { Env } from './env';
import { Database, Model, Query } from './orm';
import { TYPES, validateFKAction, validateCheck } from './orm';
import { Migrator, QueryCache, Seeder, SeederRunner, Factory, Fake, defineMigration } from './orm';
import { QueryProfiler, ReplicaManager } from './orm';
import { TenantManager, AuditLog, PluginManager, StoredProcedure, StoredFunction, TriggerManager, CLI, runCLI } from './orm';
import {
    HttpError, BadRequestError, UnauthorizedError, ForbiddenError,
    NotFoundError, MethodNotAllowedError, ConflictError, GoneError,
    PayloadTooLargeError, UnprocessableEntityError, ValidationError,
    TooManyRequestsError, InternalError, NotImplementedError,
    BadGatewayError, ServiceUnavailableError,
    DatabaseError, ConfigurationError, MiddlewareError, RoutingError, TimeoutError,
    ConnectionError, MigrationError, TransactionError, QueryError, AdapterError, CacheError,
    TenancyError, AuditError, PluginError, ProcedureError,
    createError, isHttpError, errorHandler, debug,
} from './errors';

declare function serveStatic(root: string, options?: import('./middleware').StaticOptions): import('./middleware').MiddlewareFunction;

declare const zeroServer: {
    createApp(): App;
    Router(): RouterInstance;
    cors: typeof cors;
    fetch: typeof fetch;
    json: typeof json;
    urlencoded: typeof urlencoded;
    text: typeof text;
    raw: typeof raw;
    multipart: typeof multipart;
    static: typeof serveStatic;
    rateLimit: typeof rateLimit;
    logger: typeof logger;
    compress: typeof compress;
    helmet: typeof helmet;
    timeout: typeof timeout;
    requestId: typeof requestId;
    cookieParser: CookieParserStatic;
    csrf: typeof csrf;
    validate: ValidateFunction;
    env: Env;
    Database: typeof Database;
    Model: typeof Model;
    TYPES: typeof TYPES;
    Query: typeof Query;
    validateFKAction: typeof validateFKAction;
    validateCheck: typeof validateCheck;
    // Error handling & debugging
    HttpError: typeof HttpError;
    BadRequestError: typeof BadRequestError;
    UnauthorizedError: typeof UnauthorizedError;
    ForbiddenError: typeof ForbiddenError;
    NotFoundError: typeof NotFoundError;
    MethodNotAllowedError: typeof MethodNotAllowedError;
    ConflictError: typeof ConflictError;
    GoneError: typeof GoneError;
    PayloadTooLargeError: typeof PayloadTooLargeError;
    UnprocessableEntityError: typeof UnprocessableEntityError;
    ValidationError: typeof ValidationError;
    TooManyRequestsError: typeof TooManyRequestsError;
    InternalError: typeof InternalError;
    NotImplementedError: typeof NotImplementedError;
    BadGatewayError: typeof BadGatewayError;
    ServiceUnavailableError: typeof ServiceUnavailableError;
    // Framework-specific errors
    DatabaseError: typeof DatabaseError;
    ConfigurationError: typeof ConfigurationError;
    MiddlewareError: typeof MiddlewareError;
    RoutingError: typeof RoutingError;
    TimeoutError: typeof TimeoutError;
    // ORM-specific errors
    ConnectionError: typeof ConnectionError;
    MigrationError: typeof MigrationError;
    TransactionError: typeof TransactionError;
    QueryError: typeof QueryError;
    AdapterError: typeof AdapterError;
    CacheError: typeof CacheError;
    // Phase 4 errors
    TenancyError: typeof TenancyError;
    AuditError: typeof AuditError;
    PluginError: typeof PluginError;
    ProcedureError: typeof ProcedureError;
    createError: typeof createError;
    isHttpError: typeof isHttpError;
    errorHandler: typeof errorHandler;
    debug: typeof debug;
    // ORM Extended 0.6.0 features
    Migrator: typeof Migrator;
    defineMigration: typeof defineMigration;
    QueryCache: typeof QueryCache;
    Seeder: typeof Seeder;
    SeederRunner: typeof SeederRunner;
    Factory: typeof Factory;
    Fake: typeof Fake;
    QueryProfiler: typeof QueryProfiler;
    ReplicaManager: typeof ReplicaManager;
    // ORM Enterprise (Phase 4)
    TenantManager: typeof TenantManager;
    AuditLog: typeof AuditLog;
    PluginManager: typeof PluginManager;
    StoredProcedure: typeof StoredProcedure;
    StoredFunction: typeof StoredFunction;
    TriggerManager: typeof TriggerManager;
    // CLI tooling
    CLI: typeof CLI;
    runCLI: typeof runCLI;
    // classes
    WebSocketConnection: WebSocketConnection;
    WebSocketPool: {
        new(): WebSocketPool;
    };
    SSEStream: SSEStream;
    /** Package version string */
    version: string;
};

export default zeroServer;
