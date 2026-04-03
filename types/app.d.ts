/// <reference types="node" />

import { Server as HttpServer } from 'http';
import { Server as HttpsServer, ServerOptions as TlsOptions } from 'https';
import { Http2Server, Http2SecureServer } from 'http2';
import { Request } from './request';
import { Response } from './response';
import { RouterInstance, RouteChain, RouteInfo, RouteOptions, RouteHandler } from './router';
import { MiddlewareFunction, ErrorHandlerFunction, NextFunction } from './middleware';
import { WebSocketHandler, WebSocketOptions, WebSocketPool } from './websocket';
import { SSEStream } from './sse';
import { LifecycleState } from './lifecycle';
import { MetricsRegistry, HealthCheckResult } from './observe';

export interface ListenOptions {
    /** Create an HTTP/2 server. Combined with TLS options for h2 over TLS, or h2c (cleartext) otherwise. */
    http2?: boolean;
    /** Allow HTTP/1.1 fallback on HTTP/2 TLS servers (ALPN negotiation). Default: true. */
    allowHTTP1?: boolean;
}

export interface App {
    /** Internal router instance. */
    router: RouterInstance;
    /** Middleware stack. */
    middlewares: MiddlewareFunction[];
    /** Application-level locals, merged into every request/response locals. */
    locals: Record<string, any>;

    /**
     * Register middleware or mount a sub-router.
     */
    use(fn: MiddlewareFunction): App;
    use(path: string, fn: MiddlewareFunction): App;
    use(path: string, router: RouterInstance): App;

    /**
     * Register a global error handler.
     */
    onError(fn: ErrorHandlerFunction): void;

    /**
     * Core request handler for use with `http.createServer()`.
     */
    handler(req: import('http').IncomingMessage, res: import('http').ServerResponse): void;

    /**
     * Start listening for connections.
     * Pass `{ http2: true }` to create an HTTP/2 server (h2c cleartext or TLS with ALPN).
     */
    listen(port?: number, cb?: () => void): HttpServer;
    listen(port: number, opts: TlsOptions, cb?: () => void): HttpsServer;
    listen(port: number, opts: ListenOptions & { http2: true } & TlsOptions, cb?: () => void): Http2SecureServer;
    listen(port: number, opts: ListenOptions & { http2: true }, cb?: () => void): Http2Server;
    listen(port: number, opts: ListenOptions, cb?: () => void): HttpServer | HttpsServer | Http2Server | Http2SecureServer;

    /**
     * Gracefully close the server.
     */
    close(cb?: (err?: Error) => void): void;

    /**
     * Perform a full graceful shutdown.
     */
    shutdown(opts?: { timeout?: number }): Promise<void>;

    /**
     * Register a lifecycle event listener.
     */
    on(event: 'beforeShutdown' | 'shutdown', fn: () => void | Promise<void>): App;

    /**
     * Remove a lifecycle event listener.
     */
    off(event: 'beforeShutdown' | 'shutdown', fn: () => void | Promise<void>): App;

    /**
     * Register a WebSocket pool for graceful shutdown.
     */
    registerPool(pool: WebSocketPool): App;

    /**
     * Unregister a WebSocket pool from lifecycle management.
     */
    unregisterPool(pool: WebSocketPool): App;

    /**
     * Track an SSE stream for graceful shutdown.
     */
    trackSSE(stream: SSEStream): App;

    /**
     * Register an ORM Database for graceful shutdown.
     */
    registerDatabase(db: { close(): Promise<void> }): App;

    /**
     * Unregister an ORM Database from lifecycle management.
     */
    unregisterDatabase(db: { close(): Promise<void> }): App;

    /**
     * Configure the shutdown timeout in milliseconds.
     */
    shutdownTimeout(ms: number): App;

    /**
     * Current lifecycle state.
     */
    readonly lifecycleState: LifecycleState;

    /**
     * Register a liveness health check endpoint.
     */
    health(path?: string, checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>): App;
    health(checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>): App;

    /**
     * Register a readiness health check endpoint.
     */
    ready(path?: string, checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>): App;
    ready(checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>): App;

    /**
     * Register a custom health check.
     */
    addHealthCheck(name: string, fn: () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>): App;

    /**
     * Get the application metrics registry.
     */
    metrics(): MetricsRegistry;

    /**
     * Mount a Prometheus metrics endpoint.
     */
    metricsEndpoint(path?: string, opts?: { registry?: MetricsRegistry }): App;

    /**
     * Register a WebSocket upgrade handler.
     */
    ws(path: string, handler: WebSocketHandler): void;
    ws(path: string, opts: WebSocketOptions, handler: WebSocketHandler): void;

    /**
     * Return a flat list of all registered routes.
     */
    routes(): RouteInfo[];

    /**
     * Register a route with a specific HTTP method.
     */
    route(method: string, path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;

    /**
     * Get a setting value (1 arg) or set a setting value (2 args).
     */
    set(key: string): any;
    set(key: string, val: any): App;

    /**
     * Get a setting value, or register a GET route.
     * With 1 string arg: returns the setting value.
     * With path + handlers: registers a GET route.
     */
    get(key: string): any;
    get(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;

    /**
     * Enable a boolean setting (set to `true`).
     */
    enable(key: string): App;

    /**
     * Disable a boolean setting (set to `false`).
     */
    disable(key: string): App;

    /**
     * Check if a setting is truthy.
     */
    enabled(key: string): boolean;

    /**
     * Check if a setting is falsy.
     */
    disabled(key: string): boolean;

    /**
     * Register a parameter pre-processing handler.
     */
    param(name: string, fn: (req: Request, res: Response, next: NextFunction, value: string) => void): App;

    /**
     * Create a route group under a prefix with shared middleware.
     */
    group(prefix: string, ...args: [...MiddlewareFunction[], (router: RouterInstance) => void]): App;

    /**
     * Create a chainable route builder for the given path.
     */
    chain(path: string): RouteChain;

    // HTTP method shortcuts
    post(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    put(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    delete(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    patch(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    options(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    head(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
    all(path: string, ...handlers: (RouteOptions | RouteHandler)[]): App;
}
