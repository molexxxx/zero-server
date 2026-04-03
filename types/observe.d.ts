/// <reference types="node" />

import { Request } from './request';
import { Response } from './response';
import { MiddlewareFunction } from './middleware';

// -- Structured Logger --------------------------------------------

export interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    [key: string]: any;
}

export interface LoggerOptions {
    /** Minimum log level. */
    level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent' | number;
    /** Bound context fields merged into every entry. */
    context?: Record<string, any>;
    /** Custom transport function. */
    transport?: (entry: LogEntry) => void;
    /** Force JSON output. */
    json?: boolean;
    /** Enable ANSI colors. Default: TTY detection. */
    colors?: boolean;
    /** Include timestamps. Default: true. */
    timestamps?: boolean;
    /** Output stream override. */
    stream?: NodeJS.WritableStream;
}

export class Logger {
    constructor(opts?: LoggerOptions);
    /** Create a child logger with additional bound context. */
    child(context: Record<string, any>): Logger;
    /** Set the minimum log level. */
    setLevel(level: string | number): Logger;
    trace(message: string, fields?: Record<string, any> | Error): void;
    debug(message: string, fields?: Record<string, any> | Error): void;
    info(message: string, fields?: Record<string, any> | Error): void;
    warn(message: string, fields?: Record<string, any> | Error): void;
    error(message: string, fields?: Record<string, any> | Error): void;
    fatal(message: string, fields?: Record<string, any> | Error): void;
}

export interface StructuredLoggerOptions {
    /** Minimum log level. */
    level?: string | number;
    /** Output format. Default: 'json' in production, 'pretty' otherwise. */
    format?: 'json' | 'pretty';
    /** Custom transport function. */
    transport?: (entry: LogEntry) => void;
    /** Enable ANSI colors. */
    colors?: boolean;
    /** Include timestamps. */
    timestamps?: boolean;
    /** Output stream override. */
    stream?: NodeJS.WritableStream;
    /** Skip logging for certain requests. */
    skip?: (req: Request, res: Response) => boolean;
    /** Extra fields to merge into each request log entry. */
    customFields?: (req: Request, res: Response) => Record<string, any>;
    /** Custom message template. Supports :method, :url, :status, :duration. */
    msg?: string;
}

export function structuredLogger(opts?: StructuredLoggerOptions): MiddlewareFunction;

// -- Metrics -------------------------------------------------------

export interface CounterOptions {
    name: string;
    help: string;
    labels?: string[];
}

export class Counter {
    readonly name: string;
    readonly help: string;
    readonly type: 'counter';
    constructor(opts: CounterOptions);
    inc(labels?: Record<string, string>, value?: number): void;
    inc(value?: number): void;
    get(labels?: Record<string, string>): number;
    reset(): void;
    collect(): string;
}

export interface GaugeOptions {
    name: string;
    help: string;
    labels?: string[];
    /** Callback invoked before collection to set dynamic values. */
    collect?: (gauge: Gauge) => void;
}

export class Gauge {
    readonly name: string;
    readonly help: string;
    readonly type: 'gauge';
    constructor(opts: GaugeOptions);
    set(labels: Record<string, string>, value: number): void;
    set(value: number): void;
    inc(labels?: Record<string, string>, value?: number): void;
    inc(value?: number): void;
    dec(labels?: Record<string, string>, value?: number): void;
    dec(value?: number): void;
    get(labels?: Record<string, string>): number;
    reset(): void;
    collect(): string;
}

export interface HistogramOptions {
    name: string;
    help: string;
    labels?: string[];
    /** Upper bounds for histogram buckets. */
    buckets?: number[];
}

export class Histogram {
    readonly name: string;
    readonly help: string;
    readonly type: 'histogram';
    constructor(opts: HistogramOptions);
    observe(labels: Record<string, string>, value: number): void;
    observe(value: number): void;
    startTimer(labels?: Record<string, string>): () => void;
    get(labels?: Record<string, string>): { sum: number; count: number } | null;
    reset(): void;
    collect(): string;
}

export interface MetricsRegistryOptions {
    /** Global prefix for all metric names. */
    prefix?: string;
}

export class MetricsRegistry {
    constructor(opts?: MetricsRegistryOptions);
    counter(opts: CounterOptions): Counter;
    gauge(opts: GaugeOptions): Gauge;
    histogram(opts: HistogramOptions): Histogram;
    getMetric(name: string): Counter | Gauge | Histogram | undefined;
    removeMetric(name: string): boolean;
    clear(): void;
    resetAll(): void;
    /** Serialize all metrics to Prometheus text format. */
    metrics(): string;
    /** Return all metrics as a plain object for JSON export or IPC transfer. */
    toJSON(): Record<string, any>;
    /** Merge a metrics snapshot from toJSON() into this registry. */
    merge(snapshot: Record<string, any>): void;
}

export const DEFAULT_BUCKETS: number[];

export interface DefaultMetrics {
    httpRequestsTotal: Counter;
    httpRequestDuration: Histogram;
    httpActiveConnections: Gauge;
    wsConnectionsActive: Gauge;
    sseStreamsActive: Gauge;
    dbQueryDuration: Histogram;
    dbPoolActive: Gauge;
    dbPoolIdle: Gauge;
}

export function createDefaultMetrics(registry: MetricsRegistry): DefaultMetrics;

export interface MetricsMiddlewareOptions {
    registry?: MetricsRegistry;
    /** Extract route label for metrics. */
    routeLabel?: (req: Request) => string;
    /** Skip metrics for certain requests. */
    skip?: (req: Request) => boolean;
}

export function metricsMiddleware(opts?: MetricsMiddlewareOptions): MiddlewareFunction;
export function metricsEndpoint(registry: MetricsRegistry): (req: Request, res: Response) => void;

// -- Tracing -------------------------------------------------------

export class Span {
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string | null;
    readonly kind: string;
    readonly attributes: Record<string, any>;
    readonly events: Array<{ name: string; timestamp: number; attributes: Record<string, any> }>;
    readonly status: { code: number; message?: string };
    readonly startTime: number;
    endTime: number | null;
    readonly duration: number | null;
    readonly traceparent: string;

    constructor(opts: {
        name: string;
        traceId: string;
        parentSpanId?: string;
        kind?: string;
        attributes?: Record<string, any>;
        tracer?: Tracer;
    });

    setAttribute(key: string, value: string | number | boolean): Span;
    setAttributes(attrs: Record<string, any>): Span;
    addEvent(name: string, attributes?: Record<string, any>): Span;
    setOk(): Span;
    setError(message?: string): Span;
    recordException(err: Error): Span;
    end(): Span;
    toJSON(): Record<string, any>;
}

export interface TracerOptions {
    /** Service name for all spans. */
    serviceName?: string;
    /** Exporter function called with batches of serialised spans. */
    exporter?: (spans: Record<string, any>[]) => void | Promise<void>;
    /** Max spans per export batch. Default: 100. */
    batchSize?: number;
    /** Auto-flush interval in ms. Default: 5000. */
    flushInterval?: number;
    /** Sampling rate (0.0 to 1.0). Default: 1.0. */
    sampleRate?: number;
    /** Extra resource attributes. */
    resource?: Record<string, any>;
}

export class Tracer {
    readonly serviceName: string;
    constructor(opts?: TracerOptions);
    startSpan(name: string, opts?: {
        traceId?: string;
        parentSpanId?: string;
        kind?: string;
        attributes?: Record<string, any>;
    }): Span;
    shouldSample(): boolean;
    onSpanEnd(fn: (span: Span) => void): Tracer;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
}

export function parseTraceparent(header: string): { traceId: string; parentSpanId: string; traceFlags: number } | null;
export function formatTraceparent(traceId: string, spanId: string, flags?: number): string;

export interface TracingMiddlewareOptions {
    tracer?: Tracer;
    /** Extract route label for span name. */
    routeLabel?: (req: Request) => string;
    /** Skip tracing for certain requests. */
    skip?: (req: Request) => boolean;
    /** Propagate W3C trace context via response headers. Default: true. */
    propagate?: boolean;
}

export function tracingMiddleware(opts?: TracingMiddlewareOptions): MiddlewareFunction;
export function instrumentFetch(fetchFn: Function, tracer: Tracer): Function;

// -- Health Checks -------------------------------------------------

export interface HealthCheckResult {
    healthy: boolean;
    details?: Record<string, any>;
}

export interface HealthCheckOptions {
    /** Named check functions. */
    checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>;
    /** Max time to wait for all checks in ms. Default: 5000. */
    timeout?: number;
    /** Include check details in response. Default: true. */
    verbose?: boolean;
    /** Called when any check fails. */
    onFailure?: (results: Record<string, any>) => void;
}

export function healthCheck(opts?: HealthCheckOptions): (req: Request, res: Response) => Promise<void>;

export interface CreateHealthHandlersOptions {
    checks?: Record<string, () => HealthCheckResult | boolean | Promise<HealthCheckResult | boolean>>;
    includeMemory?: boolean;
    includeEventLoop?: boolean;
    timeout?: number;
    onFailure?: (results: Record<string, any>) => void;
    memoryOpts?: { maxHeapUsedPercent?: number; maxRssBytes?: number };
    eventLoopOpts?: { maxLagMs?: number };
}

export function createHealthHandlers(opts?: CreateHealthHandlersOptions): {
    health: (req: Request, res: Response) => Promise<void>;
    ready: (req: Request, res: Response) => Promise<void>;
};

export function memoryCheck(opts?: { maxHeapUsedPercent?: number; maxRssBytes?: number }): () => HealthCheckResult;
export function eventLoopCheck(opts?: { maxLagMs?: number }): (() => HealthCheckResult) & { _cleanup(): void };
export function diskSpaceCheck(opts?: { minFreeBytes?: number }): () => HealthCheckResult;
