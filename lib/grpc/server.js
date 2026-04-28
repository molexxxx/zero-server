/**
 * @module grpc/server
 * @description gRPC server for zero-server.
 *              Intercepts HTTP/2 streams with `content-type: application/grpc`,
 *              routes by `:path` pseudo-header (`/package.Service/Method`),
 *              and dispatches to registered service handlers.
 *
 *              Handles all four gRPC call types:
 *              - Unary (single request → single response)
 *              - Server streaming (single request → multiple responses)
 *              - Client streaming (multiple requests → single response)
 *              - Bidirectional streaming (multiple requests ↔ multiple responses)
 *
 *              Supports interceptors (server-side middleware), deadline enforcement,
 *              message size limits, and graceful shutdown with call draining.
 *
 * @example
 *   const { createApp, parseProto } = require('@zero-server/sdk');
 *   const app = createApp();
 *   const schema = parseProto(fs.readFileSync('hello.proto', 'utf8'));
 *
 *   app.grpc(schema, 'Greeter', {
 *       SayHello(call) {
 *           return { message: 'Hello ' + call.request.name };
 *       },
 *   });
 *
 *   app.listen(50051, { http2: true });
 *
 * @example | Server streaming
 *   app.grpc(schema, 'DataService', {
 *       StreamData(call) {
 *           for (let i = 0; i < 100; i++) {
 *               call.write({ seq: i, payload: 'chunk-' + i });
 *           }
 *           call.end();
 *       },
 *   });
 *
 * @example | Bidirectional streaming with interceptors
 *   app.grpc(schema, 'ChatService', {
 *       Chat(call) {
 *           for await (const msg of call) {
 *               call.write({ echo: msg.text, ts: Date.now() });
 *           }
 *           call.end();
 *       },
 *   }, {
 *       interceptors: [authInterceptor, loggingInterceptor],
 *   });
 */

const log = require('../debug')('zero:grpc');
const { GrpcStatus, statusName } = require('./status');
const { Metadata } = require('./metadata');
const { UnaryCall, ServerStreamCall, ClientStreamCall, BidiStreamCall } = require('./call');

// -- Service Registry --------------------------------------

/**
 * Registry of gRPC services and their handlers.
 * Manages routing of HTTP/2 streams to the correct service method.
 *
 * @class
 *
 * @example
 *   const registry = new GrpcServiceRegistry();
 *   registry.addService(schema, 'Greeter', handlers, opts);
 */
class GrpcServiceRegistry
{
    constructor()
    {
        /**
         * Map of path → handler descriptor.
         * Keys are in the format `/package.ServiceName/MethodName`.
         * @type {Map<string, { service: string, method: object, handler: Function, schema: object, opts: object }>}
         */
        this._routes = new Map();

        /**
         * Global interceptors applied to all services.
         * @type {Function[]}
         */
        this._interceptors = [];

        /**
         * Active calls for graceful shutdown draining.
         * @type {Set<import('./call').BaseCall>}
         */
        this._activeCalls = new Set();

        /**
         * Whether the server is draining (rejecting new calls).
         * @type {boolean}
         */
        this._draining = false;
    }

    /**
     * Register a service with its handlers.
     *
     * @param {object} schema - Parsed proto schema from `parseProto()`.
     * @param {string} serviceName - Name of the service as defined in the proto file.
     * @param {Object<string, Function>} handlers - Map of method names to handler functions.
     * @param {object} [opts] - Service options.
     * @param {Function[]} [opts.interceptors] - Per-service interceptors.
     * @param {number} [opts.maxMessageSize] - Max incoming message size in bytes.
     * @param {boolean} [opts.compress=false] - Whether to compress outgoing messages.
     *
     * @example
     *   registry.addService(schema, 'Greeter', {
     *       SayHello(call) { return { message: 'Hello ' + call.request.name }; },
     *   });
     */
    addService(schema, serviceName, handlers, opts = {})
    {
        const service = schema.services[serviceName];
        if (!service)
        {
            throw new Error(`Service "${serviceName}" not found in proto schema. ` +
                `Available: ${Object.keys(schema.services).join(', ') || 'none'}`);
        }

        // Build the package prefix for routing
        const packagePrefix = schema.package ? schema.package + '.' : '';
        const pathPrefix = '/' + packagePrefix + serviceName;

        for (const [methodName, methodDef] of Object.entries(service.methods))
        {
            if (!handlers[methodName])
            {
                log.warn('no handler for %s/%s — will return UNIMPLEMENTED', serviceName, methodName);
            }

            const routePath = pathPrefix + '/' + methodName;
            this._routes.set(routePath, {
                service: serviceName,
                method: methodDef,
                handler: handlers[methodName] || null,
                schema,
                opts,
            });

            log.info('registered gRPC method %s [%s]', routePath,
                _callType(methodDef));
        }
    }

    /**
     * Add a global interceptor that runs before every gRPC call.
     * Interceptors receive `(call, next)` and must call `next()` to continue.
     *
     * @param {Function} fn - Interceptor function `(call, next) => void`.
     *
     * @example
     *   registry.addInterceptor(async (call, next) => {
     *       const token = call.metadata.get('authorization');
     *       if (!token) return call.sendError(GrpcStatus.UNAUTHENTICATED, 'Missing auth');
     *       await next();
     *   });
     */
    addInterceptor(fn)
    {
        this._interceptors.push(fn);
    }

    /**
     * Handle an incoming HTTP/2 stream. Determines if it's a gRPC call,
     * routes to the correct handler, and manages the call lifecycle.
     *
     * @param {import('http2').Http2Stream} stream - The HTTP/2 stream.
     * @param {object} headers - HTTP/2 headers from the stream event.
     * @returns {boolean} `true` if this was handled as a gRPC call.
     */
    handleStream(stream, headers)
    {
        const contentType = headers['content-type'] || '';
        if (!contentType.startsWith('application/grpc'))
        {
            return false; // Not a gRPC request — let the normal HTTP pipeline handle it
        }

        const grpcPath = headers[':path'];
        const method = headers[':method'];

        // gRPC always uses POST
        if (method !== 'POST')
        {
            _sendError(stream, GrpcStatus.UNIMPLEMENTED,
                'gRPC requires POST method');
            return true;
        }

        // Reject new calls during shutdown drain
        if (this._draining)
        {
            _sendError(stream, GrpcStatus.UNAVAILABLE,
                'Server is shutting down');
            return true;
        }

        // Look up the route
        const route = this._routes.get(grpcPath);
        if (!route)
        {
            log.warn('unregistered gRPC path: %s', grpcPath);
            _sendError(stream, GrpcStatus.UNIMPLEMENTED,
                `Method not found: ${grpcPath}`);
            return true;
        }

        if (!route.handler)
        {
            _sendError(stream, GrpcStatus.UNIMPLEMENTED,
                `Method not implemented: ${grpcPath}`);
            return true;
        }

        // Dispatch the call
        this._dispatch(stream, headers, route)
            .catch((err) =>
            {
                log.error('unhandled error in gRPC handler %s: %s', grpcPath, err.message);
            });

        return true;
    }

    /**
     * Dispatch a gRPC call to the appropriate handler.
     * @private
     * @param {import('http2').Http2Stream} stream
     * @param {object} headers
     * @param {object} route
     */
    async _dispatch(stream, headers, route)
    {
        const { method: methodDef, handler, schema, opts } = route;

        // Parse metadata from headers
        const metadata = Metadata.fromHeaders(headers);

        // Create the appropriate call object
        const CallClass = _pickCallClass(methodDef);
        const call = new CallClass(stream, methodDef, schema.messages, metadata, {
            maxMessageSize: opts.maxMessageSize,
            compress: opts.compress,
        });

        // Track for graceful shutdown
        this._activeCalls.add(call);
        stream.on('close', () => this._activeCalls.delete(call));

        try
        {
            // Initialize the call (collect request body / set up streaming)
            await call._init();

            // Run interceptors + handler
            const interceptors = [
                ...this._interceptors,
                ...(opts.interceptors || []),
            ];

            await _runInterceptors(interceptors, call, async () =>
            {
                if (call.cancelled) return;

                const result = await handler(call);

                // For unary and client-streaming: if the handler returned
                // a value, send it as the response automatically
                if (result !== undefined && result !== null && !call._ended)
                {
                    call.write(result);
                    call.sendStatus(GrpcStatus.OK);
                }
            });
        }
        catch (err)
        {
            log.error('gRPC handler error in %s: %s', methodDef.name, err.message);
            if (!call._ended)
            {
                const code = err.grpcCode || GrpcStatus.INTERNAL;
                call.sendError(code, err.message);
            }
        }
    }

    /**
     * Begin draining — reject new calls and wait for active calls to finish.
     *
     * @param {number} [timeout=30000] - Maximum time to wait in ms.
     * @returns {Promise<void>}
     */
    async drain(timeout = 30000)
    {
        this._draining = true;
        log.info('gRPC draining, %d active calls', this._activeCalls.size);

        if (this._activeCalls.size === 0) return;

        return new Promise((resolve) =>
        {
            const check = () =>
            {
                if (this._activeCalls.size === 0)
                {
                    clearTimeout(timer);
                    resolve();
                }
            };

            // Check periodically
            const interval = setInterval(check, 100);
            if (interval.unref) interval.unref();

            const timer = setTimeout(() =>
            {
                clearInterval(interval);
                log.warn('gRPC drain timed out with %d active calls', this._activeCalls.size);
                // Force-close remaining calls
                for (const call of this._activeCalls)
                {
                    call.sendError(GrpcStatus.UNAVAILABLE, 'Server shutting down');
                }
                resolve();
            }, timeout);
            if (timer.unref) timer.unref();
        });
    }

    /**
     * Get all registered routes for introspection.
     *
     * @returns {{ method: string, path: string, type: string }[]}
     *
     * @example
     *   registry.routes();
     *   // [{ method: 'GRPC', path: '/myapp.Greeter/SayHello', type: 'unary' }]
     */
    routes()
    {
        const list = [];
        for (const [path, route] of this._routes)
        {
            list.push({
                method: 'GRPC',
                path,
                type: _callType(route.method),
                implemented: !!route.handler,
            });
        }
        return list;
    }
}

// -- Helpers -----------------------------------------------

/**
 * Pick the Call class based on method streaming flags.
 * @private
 * @param {object} methodDef
 * @returns {typeof import('./call').BaseCall}
 */
function _pickCallClass(methodDef)
{
    if (methodDef.clientStreaming && methodDef.serverStreaming) return BidiStreamCall;
    if (methodDef.clientStreaming) return ClientStreamCall;
    if (methodDef.serverStreaming) return ServerStreamCall;
    return UnaryCall;
}

/**
 * Describe the call type for logging/introspection.
 * @private
 * @param {object} methodDef
 * @returns {string}
 */
function _callType(methodDef)
{
    if (methodDef.clientStreaming && methodDef.serverStreaming) return 'bidi';
    if (methodDef.clientStreaming) return 'client-stream';
    if (methodDef.serverStreaming) return 'server-stream';
    return 'unary';
}

/**
 * Run a chain of interceptors with final handler.
 * @private
 * @param {Function[]} interceptors
 * @param {import('./call').BaseCall} call
 * @param {Function} finalHandler
 */
async function _runInterceptors(interceptors, call, finalHandler)
{
    let idx = 0;

    async function next()
    {
        if (call._ended || call._cancelled) return;
        if (idx < interceptors.length)
        {
            const fn = interceptors[idx++];
            await fn(call, next);
        }
        else
        {
            await finalHandler();
        }
    }

    await next();
}

/**
 * Send a gRPC error on a raw HTTP/2 stream (before a Call object is created).
 * @private
 * @param {import('http2').Http2Stream} stream
 * @param {number} code
 * @param {string} message
 */
function _sendError(stream, code, message)
{
    try
    {
        stream.respond({
            ':status': 200,
            'content-type': 'application/grpc+proto',
            'grpc-status': String(code),
            'grpc-message': encodeURIComponent(message),
        }, { endStream: true });
    }
    catch (_)
    {
        try { stream.close(); }
        catch (__) { /* stream already closed */ }
    }
}

module.exports = {
    GrpcServiceRegistry,
};
