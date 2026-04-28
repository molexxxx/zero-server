/**
 * @module grpc/health
 * @description gRPC Health Checking Protocol implementation (grpc.health.v1.Health).
 *              Supports `Check` (unary) and `Watch` (server-stream) RPCs.
 *
 *              Required for production deployments behind Kubernetes, Envoy,
 *              AWS ALB, and any load balancer that uses standard gRPC health probes.
 *
 * @see https://github.com/grpc/grpc/blob/master/doc/health-checking.md
 *
 * @example
 *   const { createApp } = require('@zero-server/sdk');
 *   const app = createApp();
 *   app.grpcHealth();
 *   app.listen(50051, { http2: true });
 *
 * @example | Per-service health status
 *   app.grpcHealth();
 *   app.setServiceStatus('myapp.UserService', 'SERVING');
 *   app.setServiceStatus('myapp.OrderService', 'NOT_SERVING');
 */

const log = require('../debug')('zero:grpc:health');
const { GrpcStatus } = require('./status');
const { encode, decode } = require('./codec');
const { frameEncode, FrameParser } = require('./frame');
const { Metadata } = require('./metadata');

// -- Health Status Enum -----------------------------------

/**
 * Health check status values.
 * Mirrors `grpc.health.v1.HealthCheckResponse.ServingStatus`.
 * @enum {number}
 */
const ServingStatus = {
    UNKNOWN: 0,
    SERVING: 1,
    NOT_SERVING: 2,
    SERVICE_UNKNOWN: 3,
};

/** Reverse mapping for logging. */
const STATUS_NAME = {
    0: 'UNKNOWN',
    1: 'SERVING',
    2: 'NOT_SERVING',
    3: 'SERVICE_UNKNOWN',
};

// -- Health proto descriptors (hand-coded to avoid parsing) --

/** @private HealthCheckRequest message descriptor */
const _healthRequestDesc = {
    name: 'HealthCheckRequest',
    fields: [
        { name: 'service', type: 'string', number: 1, repeated: false, optional: false, map: false },
    ],
};

/** @private HealthCheckResponse message descriptor */
const _healthResponseDesc = {
    name: 'HealthCheckResponse',
    fields: [
        { name: 'status', type: 'int32', number: 1, repeated: false, optional: false, map: false, enumType: 'ServingStatus' },
    ],
};

/** @private Message type map for encode/decode */
const _healthMessages = {
    HealthCheckRequest: _healthRequestDesc,
    HealthCheckResponse: _healthResponseDesc,
};

// -- Health Service Manager --------------------------------

/**
 * Manages per-service health status and Watch subscriptions.
 * Cached serialized response bytes are invalidated only on status change.
 *
 * @class
 */
class HealthService
{
    constructor()
    {
        /**
         * Current status per service name. Empty string = overall server health.
         * @type {Map<string, number>}
         */
        this._statuses = new Map();

        /**
         * Watch subscribers per service name.
         * Each subscriber is a function `(status) => void` that pushes to the client stream.
         * @type {Map<string, Set<Function>>}
         */
        this._watchers = new Map();

        /**
         * Cached serialized response bytes per service name.
         * Invalidated on status change for zero-allocation hot path.
         * @type {Map<string, Buffer>}
         */
        this._cache = new Map();

        // Overall server health defaults to SERVING
        this._statuses.set('', ServingStatus.SERVING);
    }

    /**
     * Set the health status for a service.
     *
     * @param {string} serviceName - Service name (empty string for overall).
     * @param {number|string} status - Status value or name.
     */
    setStatus(serviceName, status)
    {
        const code = typeof status === 'string' ? ServingStatus[status] : status;
        if (code === undefined || STATUS_NAME[code] === undefined)
            throw new Error(`Invalid health status: ${status}`);

        const prev = this._statuses.get(serviceName);
        this._statuses.set(serviceName, code);

        // Invalidate cached response
        this._cache.delete(serviceName);

        // Notify watch subscribers if status changed
        if (prev !== code)
        {
            log.info('health status changed: "%s" → %s', serviceName || '<overall>', STATUS_NAME[code]);
            const watchers = this._watchers.get(serviceName);
            if (watchers)
            {
                for (const notify of watchers) notify(code);
            }
        }
    }

    /**
     * Get the current status for a service.
     *
     * @param {string} serviceName - Service name.
     * @returns {number} Status code, or SERVICE_UNKNOWN if not registered.
     */
    getStatus(serviceName)
    {
        if (this._statuses.has(serviceName))
            return this._statuses.get(serviceName);
        return ServingStatus.SERVICE_UNKNOWN;
    }

    /**
     * Set all registered services to NOT_SERVING for graceful shutdown.
     */
    setAllNotServing()
    {
        for (const [name] of this._statuses)
        {
            this.setStatus(name, ServingStatus.NOT_SERVING);
        }
    }

    /**
     * Build and cache the serialized response for a given status.
     * @private
     * @param {number} status - Status code.
     * @returns {Buffer}
     */
    _getResponseBytes(status)
    {
        return encode({ status }, _healthResponseDesc, _healthMessages);
    }

    /**
     * Subscribe a watcher for status changes on a service.
     * @param {string} serviceName
     * @param {Function} callback - `(status: number) => void`
     * @returns {Function} Unsubscribe function.
     */
    _watch(serviceName, callback)
    {
        if (!this._watchers.has(serviceName))
            this._watchers.set(serviceName, new Set());
        this._watchers.get(serviceName).add(callback);

        return () =>
        {
            const set = this._watchers.get(serviceName);
            if (set) { set.delete(callback); if (set.size === 0) this._watchers.delete(serviceName); }
        };
    }

    /**
     * Handle a Check RPC — unary request for current health of a service.
     * @param {import('./call').UnaryCall} call
     */
    Check(call)
    {
        const serviceName = call.request.service || '';
        const status = this.getStatus(serviceName);
        log.debug('health Check for "%s" → %s', serviceName || '<overall>', STATUS_NAME[status]);
        return { status };
    }

    /**
     * Handle a Watch RPC — server-stream that pushes status changes.
     * Sends the current status immediately, then pushes on every change.
     * @param {import('./call').ServerStreamCall} call
     */
    Watch(call)
    {
        const serviceName = call.request.service || '';
        const currentStatus = this.getStatus(serviceName);

        // Send current status immediately
        call.write({ status: currentStatus });

        // Subscribe to changes
        const unsubscribe = this._watch(serviceName, (newStatus) =>
        {
            if (!call._ended && !call._cancelled)
            {
                call.write({ status: newStatus });
            }
        });

        // Cleanup on stream close
        call.stream.on('close', unsubscribe);
    }

    /**
     * Get the schema object needed for server registration.
     * Avoids requiring proto parsing — returns descriptors directly.
     * @returns {object} Schema compatible with GrpcServiceRegistry.addService
     */
    getSchema()
    {
        return {
            package: 'grpc.health.v1',
            services: {
                Health: {
                    methods: {
                        Check: {
                            name: 'Check',
                            inputType: 'HealthCheckRequest',
                            outputType: 'HealthCheckResponse',
                            clientStreaming: false,
                            serverStreaming: false,
                        },
                        Watch: {
                            name: 'Watch',
                            inputType: 'HealthCheckRequest',
                            outputType: 'HealthCheckResponse',
                            clientStreaming: false,
                            serverStreaming: true,
                        },
                    },
                },
            },
            messages: _healthMessages,
            enums: {
                ServingStatus: { values: ServingStatus },
            },
        };
    }

    /**
     * Get the handler map for server registration.
     * Binds methods to this instance.
     * @returns {Object<string, Function>}
     */
    getHandlers()
    {
        return {
            Check: (call) => this.Check(call),
            Watch: (call) => this.Watch(call),
        };
    }
}

module.exports = {
    HealthService,
    ServingStatus,
    STATUS_NAME,
};
