// --- Error Classes -----------------------------------------------

export interface HttpErrorOptions {
    code?: string;
    details?: any;
}

export class HttpError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly name: string;
    details?: any;
    constructor(statusCode: number, message?: string, opts?: HttpErrorOptions);
    toJSON(): { error: string; code: string; statusCode: number; details?: any };
}

export class BadRequestError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class UnauthorizedError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class ForbiddenError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class NotFoundError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class MethodNotAllowedError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class ConflictError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class GoneError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class PayloadTooLargeError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class UnprocessableEntityError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class ValidationError extends HttpError {
    readonly errors: Record<string, string> | string[];
    constructor(message?: string, errors?: Record<string, string> | string[], opts?: HttpErrorOptions);
}

export class TooManyRequestsError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class InternalError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class NotImplementedError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class BadGatewayError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

export class ServiceUnavailableError extends HttpError {
    constructor(message?: string, opts?: HttpErrorOptions);
}

// --- Framework Error Classes -------------------------------------

export interface DatabaseErrorOptions extends HttpErrorOptions {
    query?: string;
    adapter?: string;
}

export class DatabaseError extends HttpError {
    readonly query?: string;
    readonly adapter?: string;
    constructor(message?: string, opts?: DatabaseErrorOptions);
}

export interface ConfigurationErrorOptions extends HttpErrorOptions {
    setting?: string;
}

export class ConfigurationError extends HttpError {
    readonly setting?: string;
    constructor(message?: string, opts?: ConfigurationErrorOptions);
}

export interface MiddlewareErrorOptions extends HttpErrorOptions {
    middleware?: string;
}

export class MiddlewareError extends HttpError {
    readonly middleware?: string;
    constructor(message?: string, opts?: MiddlewareErrorOptions);
}

export interface RoutingErrorOptions extends HttpErrorOptions {
    path?: string;
    method?: string;
}

export class RoutingError extends HttpError {
    readonly path?: string;
    readonly method?: string;
    constructor(message?: string, opts?: RoutingErrorOptions);
}

export interface TimeoutErrorOptions extends HttpErrorOptions {
    timeout?: number;
}

export class TimeoutError extends HttpError {
    readonly timeout?: number;
    constructor(message?: string, opts?: TimeoutErrorOptions);
}

export function createError(statusCode: number, message?: string, opts?: HttpErrorOptions): HttpError;
export function isHttpError(err: any): err is HttpError;

// --- ORM Error Classes -------------------------------------------

export interface ConnectionErrorOptions extends DatabaseErrorOptions {
    attempt?: number;
    maxRetries?: number;
    host?: string;
    port?: number;
}

export class ConnectionError extends DatabaseError {
    readonly attempt?: number;
    readonly maxRetries?: number;
    readonly host?: string;
    readonly port?: number;
    constructor(message?: string, opts?: ConnectionErrorOptions);
}

export interface MigrationErrorOptions extends DatabaseErrorOptions {
    migration?: string;
    direction?: 'up' | 'down';
    batch?: number;
}

export class MigrationError extends DatabaseError {
    readonly migration?: string;
    readonly direction?: 'up' | 'down';
    readonly batch?: number;
    constructor(message?: string, opts?: MigrationErrorOptions);
}

export interface TransactionErrorOptions extends DatabaseErrorOptions {
    phase?: 'begin' | 'commit' | 'rollback';
}

export class TransactionError extends DatabaseError {
    readonly phase?: 'begin' | 'commit' | 'rollback';
    constructor(message?: string, opts?: TransactionErrorOptions);
}

export interface QueryErrorOptions extends DatabaseErrorOptions {
    sql?: string;
    params?: any[];
    table?: string;
}

export class QueryError extends DatabaseError {
    readonly sql?: string;
    readonly params?: any[];
    readonly table?: string;
    constructor(message?: string, opts?: QueryErrorOptions);
}

export interface AdapterErrorOptions extends DatabaseErrorOptions {
    operation?: string;
}

export class AdapterError extends DatabaseError {
    readonly operation?: string;
    constructor(message?: string, opts?: AdapterErrorOptions);
}

export interface CacheErrorOptions extends HttpErrorOptions {
    operation?: string;
    key?: string;
}

export class CacheError extends HttpError {
    readonly operation?: string;
    readonly key?: string;
    constructor(message?: string, opts?: CacheErrorOptions);
}

// --- Error Handler Middleware ------------------------------------

import { Request } from './request';
import { Response } from './response';

export interface ErrorHandlerOptions {
    /** Include stack traces in responses (default: true when NODE_ENV !== 'production'). */
    stack?: boolean;
    /** Log errors to console (default: true). */
    log?: boolean;
    /** Custom log function (default: console.error). */
    logger?: (...args: any[]) => void;
    /** Custom response formatter: (err, req, isDev) => responseBody. */
    formatter?: (err: Error, req: Request, isDev: boolean) => any;
    /** Callback on every error. */
    onError?: (err: Error, req: Request, res: Response) => void;
}

export function errorHandler(opts?: ErrorHandlerOptions): (err: any, req: Request, res: Response, next: (err?: any) => void) => void;

// --- Debug Logger ------------------------------------------------

export interface DebugLogger {
    (...args: any[]): void;
    trace(...args: any[]): void;
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    fatal(...args: any[]): void;
    readonly enabled: boolean;
    readonly namespace: string;
}

export interface DebugLevels {
    trace: 0;
    debug: 1;
    info: 2;
    warn: 3;
    error: 4;
    fatal: 5;
    silent: 6;
}

export interface Debug {
    (namespace: string): DebugLogger;
    /** Set minimum log level globally. */
    level(level: keyof DebugLevels | number): void;
    /** Enable/disable namespaces (same syntax as DEBUG env var). */
    enable(patterns: string): void;
    /** Disable all debug output. */
    disable(): void;
    /** Enable structured JSON output. */
    json(on?: boolean): void;
    /** Enable/disable timestamps. */
    timestamps(on?: boolean): void;
    /** Enable/disable colors. */
    colors(on?: boolean): void;
    /** Set custom output stream. */
    output(stream: { write(s: string): void }): void;
    /** Reset all settings to defaults. */
    reset(): void;
    /** Level constants. */
    readonly LEVELS: DebugLevels;
}

export const debug: Debug;
