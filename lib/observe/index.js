/**
 * @module observe
 * @description Observability suite — structured logging, metrics, tracing,
 *              and health checks. Zero external dependencies.
 */
const { Logger, structuredLogger, LEVELS, LEVEL_NAMES } = require('./logger');
const {
    Counter, Gauge, Histogram,
    MetricsRegistry, DEFAULT_BUCKETS,
    createDefaultMetrics, metricsMiddleware, metricsEndpoint,
} = require('./metrics');
const {
    Span, Tracer,
    parseTraceparent, formatTraceparent,
    tracingMiddleware, instrumentFetch,
} = require('./tracing');
const {
    healthCheck, createHealthHandlers,
    memoryCheck, eventLoopCheck, diskSpaceCheck,
} = require('./health');

module.exports = {
    // Structured Logging
    Logger,
    structuredLogger,
    LEVELS,
    LEVEL_NAMES,
    // Metrics
    Counter,
    Gauge,
    Histogram,
    MetricsRegistry,
    DEFAULT_BUCKETS,
    createDefaultMetrics,
    metricsMiddleware,
    metricsEndpoint,
    // Tracing
    Span,
    Tracer,
    parseTraceparent,
    formatTraceparent,
    tracingMiddleware,
    instrumentFetch,
    // Health Checks
    healthCheck,
    createHealthHandlers,
    memoryCheck,
    eventLoopCheck,
    diskSpaceCheck,
};
