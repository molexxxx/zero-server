/**
 * @module grpc/client
 * @description Zero-dependency gRPC client using Node.js `http2.connect()`.
 *              Supports all four call types (unary, server-streaming,
 *              client-streaming, bidirectional), metadata, deadlines,
 *              automatic reconnection, and keep-alive.
 *
 * @example | Unary call
 *   const { GrpcClient, parseProto } = require('@zero-server/sdk');
 *   const schema = parseProto(fs.readFileSync('hello.proto', 'utf8'));
 *
 *   const client = new GrpcClient('http://localhost:50051', schema, 'Greeter');
 *   const reply = await client.call('SayHello', { name: 'World' });
 *   console.log(reply.message); // => 'Hello World'
 *   client.close();
 *
 * @example | Server streaming
 *   const stream = client.serverStream('ListUsers', { pageSize: 10 });
 *   for await (const user of stream) {
 *       console.log(user.name);
 *   }
 *
 * @example | Bidirectional streaming
 *   const bidi = client.bidiStream('Chat');
 *   bidi.write({ text: 'hello' });
 *   for await (const reply of bidi) {
 *       console.log(reply.text);
 *   }
 *   bidi.end();
 *
 * @example | With TLS and metadata
 *   const client = new GrpcClient('https://api.example.com:443', schema, 'MyService', {
 *       ca: fs.readFileSync('ca.pem'),
 *       metadata: { authorization: 'Bearer <token>' },
 *   });
 */

const http2 = require('http2');
const { EventEmitter } = require('events');
const log = require('../debug')('zero:grpc');
const { GrpcStatus, statusName } = require('./status');
const { Metadata } = require('./metadata');
const { frameEncode, FrameParser } = require('./frame');
const { encode, decode } = require('./codec');

// -- Client ------------------------------------------------

/**
 * gRPC client for making RPC calls to a gRPC server.
 * Supports single-address and multi-address (load-balanced) modes.
 *
 * @class
 * @extends EventEmitter
 *
 * @param {string|object} address - Server address (e.g. `http://localhost:50051`) or options object.
 * @param {string[]} [address.addresses] - Multiple backend addresses for load balancing.
 * @param {string} [address.address] - Single backend address (alternative to string form).
 * @param {string} [address.loadBalancing='pick-first'] - Load balancing policy ('pick-first' or 'round-robin').
 * @param {boolean} [address.healthCheck=false] - Enable health-aware balancing.
 * @param {object} schema - Parsed proto schema from `parseProto()`.
 * @param {string} serviceName - Name of the service to call.
 * @param {object} [opts] - Client options.
 * @param {Buffer|string} [opts.ca] - CA certificate for TLS.
 * @param {Buffer|string} [opts.key] - Client key for mTLS.
 * @param {Buffer|string} [opts.cert] - Client certificate for mTLS.
 * @param {object} [opts.metadata] - Default metadata sent with every call.
 * @param {number} [opts.maxMessageSize=16777216] - Max incoming message size (16 MB default).
 * @param {boolean} [opts.compress=false] - Compress outgoing messages.
 * @param {number} [opts.deadline] - Default deadline in ms for all calls.
 * @param {boolean} [opts.keepAlive=true] - Send HTTP/2 pings to keep connection alive.
 * @param {number} [opts.keepAliveInterval=15000] - Ping interval in ms.
 */
class GrpcClient extends EventEmitter
{
    constructor(address, schema, serviceName, opts = {})
    {
        super();

        const service = schema.services[serviceName];
        if (!service)
        {
            throw new Error(`Service "${serviceName}" not found in schema. ` +
                `Available: ${Object.keys(schema.services).join(', ') || 'none'}`);
        }

        // Support new multi-address API: new GrpcClient({ addresses: [...] }, schema, service, opts)
        if (typeof address === 'object' && address !== null && !Buffer.isBuffer(address))
        {
            /** @private */
            this._address = address.address || (address.addresses && address.addresses[0]) || '';
            /** @private */
            this._multiAddress = true;

            // Merge address-level options into opts
            if (address.ca) opts.ca = address.ca;
            if (address.key) opts.key = address.key;
            if (address.cert) opts.cert = address.cert;
            if (address.metadata) opts.metadata = address.metadata;
            if (address.rejectUnauthorized === false) opts.rejectUnauthorized = false;

            // Create load balancer
            if (address.addresses && address.addresses.length > 1)
            {
                const { LoadBalancer } = require('./balancer');
                const connectOpts = {};
                if (opts.ca) connectOpts.ca = opts.ca;
                if (opts.key) connectOpts.key = opts.key;
                if (opts.cert) connectOpts.cert = opts.cert;
                if (opts.rejectUnauthorized === false) connectOpts.rejectUnauthorized = false;

                /** @private */
                this._balancer = new LoadBalancer(address.addresses, {
                    policy: address.loadBalancing || 'pick-first',
                    connectOpts,
                });
            }
            else
            {
                this._balancer = null;
            }
        }
        else
        {
            /** @private */
            this._address = address;
            /** @private */
            this._multiAddress = false;
            /** @private */
            this._balancer = null;
        }

        /** @private */
        this._schema = schema;
        /** @private */
        this._service = service;
        /** @private */
        this._serviceName = serviceName;
        /** @private */
        this._opts = opts;
        /** @private */
        this._session = null;
        /** @private */
        this._closed = false;
        /** @private */
        this._keepAliveTimer = null;

        // Build the path prefix (e.g. /mypackage.MyService)
        const pkg = schema.package ? schema.package + '.' : '';
        /** @private */
        this._pathPrefix = '/' + pkg + serviceName;

        /** Default metadata for all calls. */
        this.defaultMetadata = new Metadata();
        if (opts.metadata)
        {
            for (const [k, v] of Object.entries(opts.metadata))
                this.defaultMetadata.set(k, v);
        }
    }

    /**
     * Lazily connect to the server. Reuses the HTTP/2 session if already connected.
     * Uses the load balancer if configured for multi-address mode.
     * @private
     * @returns {import('http2').ClientHttp2Session}
     */
    _connect()
    {
        // Load-balanced mode
        if (this._balancer)
        {
            const session = this._balancer.getSession();
            if (session) return session;
            // Fallback to direct connect if balancer returns null
        }

        if (this._session && !this._session.closed && !this._session.destroyed)
            return this._session;

        const connectOpts = {};
        if (this._opts.ca) connectOpts.ca = this._opts.ca;
        if (this._opts.key) connectOpts.key = this._opts.key;
        if (this._opts.cert) connectOpts.cert = this._opts.cert;
        // Allow self-signed certs in development
        if (this._opts.rejectUnauthorized === false)
            connectOpts.rejectUnauthorized = false;

        this._session = http2.connect(this._address, connectOpts);

        this._session.on('error', (err) =>
        {
            log.error('gRPC client session error: %s', err.message);
            this.emit('error', err);
        });

        this._session.on('close', () =>
        {
            log.debug('gRPC client session closed');
            this._session = null;
            this.emit('disconnect');
        });

        // Keep-alive pings
        if (this._opts.keepAlive !== false)
        {
            const interval = this._opts.keepAliveInterval || 15000;
            this._keepAliveTimer = setInterval(() =>
            {
                if (this._session && !this._session.closed)
                {
                    this._session.ping((err) =>
                    {
                        if (err) log.debug('keep-alive ping failed: %s', err.message);
                    });
                }
            }, interval);
            if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
        }

        log.info('gRPC client connected to %s', this._address);
        return this._session;
    }

    /**
     * Build the HTTP/2 headers for a gRPC request.
     * @private
     * @param {string} methodName
     * @param {Metadata|object} [extraMeta]
     * @param {number} [deadline] - Deadline in ms.
     * @returns {object}
     */
    _buildHeaders(methodName, extraMeta, deadline)
    {
        const headers = {
            ':method': 'POST',
            ':path': this._pathPrefix + '/' + methodName,
            'content-type': 'application/grpc+proto',
            'te': 'trailers',
        };

        if (this._opts.compress) headers['grpc-encoding'] = 'gzip';

        // Merge metadata
        const md = this.defaultMetadata.clone();
        if (extraMeta)
        {
            const extra = extraMeta instanceof Metadata ? extraMeta : Metadata.fromHeaders(extraMeta);
            md.merge(extra);
        }
        Object.assign(headers, md.toHeaders());

        // Deadline -> grpc-timeout
        const dl = deadline || this._opts.deadline;
        if (dl)
        {
            // Convert ms to grpc-timeout format
            if (dl >= 3600000) headers['grpc-timeout'] = Math.floor(dl / 3600000) + 'H';
            else if (dl >= 60000) headers['grpc-timeout'] = Math.floor(dl / 60000) + 'M';
            else if (dl >= 1000) headers['grpc-timeout'] = Math.floor(dl / 1000) + 'S';
            else headers['grpc-timeout'] = dl + 'm';
        }

        return headers;
    }

    // -- Unary Call -----------------------------------------

    /**
     * Make a unary gRPC call — send one message, receive one response.
     *
     * @param {string} methodName - RPC method name as defined in the proto service.
     * @param {object} request - Request message object.
     * @param {object} [opts] - Call options.
     * @param {Metadata|object} [opts.metadata] - Per-call metadata.
     * @param {number} [opts.deadline] - Deadline in ms.
     * @returns {Promise<object>} The decoded response message.
     *
     * @example
     *   const reply = await client.call('SayHello', { name: 'World' });
     */
    call(methodName, request, opts = {})
    {
        const methodDef = this._service.methods[methodName];
        if (!methodDef)
            return Promise.reject(new Error(`Method "${methodName}" not found in service "${this._serviceName}"`));

        const inputDesc = this._schema.messages[methodDef.inputType];
        const outputDesc = this._schema.messages[methodDef.outputType];
        if (!inputDesc) return Promise.reject(new Error(`Unknown input type: ${methodDef.inputType}`));
        if (!outputDesc) return Promise.reject(new Error(`Unknown output type: ${methodDef.outputType}`));

        return new Promise((resolve, reject) =>
        {
            const session = this._connect();
            const headers = this._buildHeaders(methodName, opts.metadata, opts.deadline);
            const stream = session.request(headers);

            const parser = new FrameParser({ maxMessageSize: this._opts.maxMessageSize });
            let response = null;
            let grpcStatus = null;
            let grpcMessage = null;

            parser.onMessage = (buf) =>
            {
                try { response = decode(buf, outputDesc, this._schema.messages); }
                catch (err) { reject(err); }
            };
            parser.onError = reject;

            stream.on('data', (chunk) => parser.push(chunk));

            // Trailers-Only response: grpc-status in initial headers
            stream.on('response', (headers) =>
            {
                if (headers['grpc-status'] !== undefined)
                {
                    grpcStatus = parseInt(headers['grpc-status'], 10);
                    grpcMessage = headers['grpc-message']
                        ? decodeURIComponent(headers['grpc-message'])
                        : null;
                }
            });

            stream.on('trailers', (trailers) =>
            {
                grpcStatus = parseInt(trailers['grpc-status'] || '0', 10);
                grpcMessage = trailers['grpc-message']
                    ? decodeURIComponent(trailers['grpc-message'])
                    : null;
            });

            stream.on('end', () =>
            {
                parser.destroy();
                if (grpcStatus !== null && grpcStatus !== GrpcStatus.OK)
                {
                    const err = new Error(grpcMessage || statusName(grpcStatus));
                    err.code = grpcStatus;
                    err.grpcCode = grpcStatus;
                    reject(err);
                }
                else
                {
                    resolve(response || {});
                }
            });

            stream.on('error', (err) =>
            {
                parser.destroy();
                reject(err);
            });

            // Deadline timeout
            const dl = opts.deadline || this._opts.deadline;
            if (dl)
            {
                const timer = setTimeout(() =>
                {
                    stream.close();
                    const err = new Error('Deadline exceeded');
                    err.code = GrpcStatus.DEADLINE_EXCEEDED;
                    err.grpcCode = GrpcStatus.DEADLINE_EXCEEDED;
                    reject(err);
                }, dl);
                if (timer.unref) timer.unref();
                stream.on('close', () => clearTimeout(timer));
            }

            // Send the request
            try
            {
                const buf = encode(request || {}, inputDesc, this._schema.messages);
                const frame = frameEncode(buf, { compress: this._opts.compress });

                if (frame instanceof Promise)
                {
                    frame.then((f) =>
                    {
                        stream.write(f);
                        stream.end();
                    }).catch(reject);
                }
                else
                {
                    stream.write(frame);
                    stream.end();
                }
            }
            catch (err) { reject(err); }
        });
    }

    // -- Server Streaming ----------------------------------

    /**
     * Make a server-streaming gRPC call — send one request, receive a stream of responses.
     * Returns an async-iterable that yields decoded response messages.
     *
     * @param {string} methodName - RPC method name.
     * @param {object} request - Request message object.
     * @param {object} [opts] - Call options.
     * @param {Metadata|object} [opts.metadata] - Per-call metadata.
     * @param {number} [opts.deadline] - Deadline in ms.
     * @returns {AsyncIterable<object> & { cancel: Function }} Async iterable of response messages.
     *
     * @example
     *   const stream = client.serverStream('ListUsers', { filter: 'active' });
     *   for await (const user of stream) {
     *       console.log(user);
     *   }
     */
    serverStream(methodName, request, opts = {})
    {
        const methodDef = this._service.methods[methodName];
        if (!methodDef) throw new Error(`Method "${methodName}" not found`);

        const inputDesc = this._schema.messages[methodDef.inputType];
        const outputDesc = this._schema.messages[methodDef.outputType];

        const session = this._connect();
        const headers = this._buildHeaders(methodName, opts.metadata, opts.deadline);
        const stream = session.request(headers);

        const parser = new FrameParser({ maxMessageSize: this._opts.maxMessageSize });
        const queue = [];
        let resolve = null;
        let ended = false;
        let error = null;

        parser.onMessage = (buf) =>
        {
            try
            {
                const msg = decode(buf, outputDesc, this._schema.messages);
                if (resolve) { const r = resolve; resolve = null; r({ value: msg, done: false }); }
                else queue.push(msg);
            }
            catch (err) { error = err; if (resolve) { const r = resolve; resolve = null; r(Promise.reject(err)); } }
        };
        parser.onError = (err) =>
        {
            error = err;
            if (resolve) { const r = resolve; resolve = null; r(Promise.reject(err)); }
        };

        stream.on('data', (chunk) => parser.push(chunk));

        // Trailers-Only response: grpc-status in initial headers
        stream.on('response', (hdrs) =>
        {
            if (hdrs['grpc-status'] !== undefined)
            {
                const code = parseInt(hdrs['grpc-status'], 10);
                if (code !== GrpcStatus.OK)
                {
                    const msg = hdrs['grpc-message']
                        ? decodeURIComponent(hdrs['grpc-message'])
                        : statusName(code);
                    error = new Error(msg);
                    error.code = code;
                    error.grpcCode = code;
                }
            }
        });

        stream.on('end', () =>
        {
            ended = true;
            parser.destroy();
            if (error && resolve) { const r = resolve; resolve = null; r(Promise.reject(error)); }
            else if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); }
        });
        stream.on('error', (err) =>
        {
            error = err;
            ended = true;
            parser.destroy();
            if (resolve) { const r = resolve; resolve = null; r(Promise.reject(err)); }
        });

        // Send request
        const buf = encode(request || {}, inputDesc, this._schema.messages);
        const frame = frameEncode(buf, { compress: this._opts.compress });
        if (frame instanceof Promise) frame.then((f) => { stream.write(f); stream.end(); });
        else { stream.write(frame); stream.end(); }

        const iterable = {
            [Symbol.asyncIterator]()
            {
                return {
                    next()
                    {
                        if (error) return Promise.reject(error);
                        if (queue.length > 0)
                            return Promise.resolve({ value: queue.shift(), done: false });
                        if (ended)
                            return Promise.resolve({ value: undefined, done: true });
                        return new Promise((r) => { resolve = r; });
                    },
                };
            },
            cancel() { stream.close(); },
        };

        return iterable;
    }

    // -- Client Streaming ----------------------------------

    /**
     * Make a client-streaming gRPC call — send a stream of requests, receive one response.
     * Returns a writable object with `write()`, `end()`, and a `response` Promise.
     *
     * @param {string} methodName - RPC method name.
     * @param {object} [opts] - Call options.
     * @param {Metadata|object} [opts.metadata] - Per-call metadata.
     * @param {number} [opts.deadline] - Deadline in ms.
     * @returns {{ write: Function, end: Function, response: Promise<object> }}
     *
     * @example
     *   const cs = client.clientStream('UploadChunks');
     *   cs.write({ data: chunk1 });
     *   cs.write({ data: chunk2 });
     *   cs.end();
     *   const result = await cs.response;
     */
    clientStream(methodName, opts = {})
    {
        const methodDef = this._service.methods[methodName];
        if (!methodDef) throw new Error(`Method "${methodName}" not found`);

        const inputDesc = this._schema.messages[methodDef.inputType];
        const outputDesc = this._schema.messages[methodDef.outputType];

        const session = this._connect();
        const headers = this._buildHeaders(methodName, opts.metadata, opts.deadline);
        const stream = session.request(headers);

        const parser = new FrameParser({ maxMessageSize: this._opts.maxMessageSize });
        let responseMsg = null;

        const response = new Promise((resolve, reject) =>
        {
            parser.onMessage = (buf) =>
            {
                try { responseMsg = decode(buf, outputDesc, this._schema.messages); }
                catch (err) { reject(err); }
            };
            parser.onError = reject;

            stream.on('data', (chunk) => parser.push(chunk));

            // Trailers-Only response: grpc-status in initial headers
            stream.on('response', (hdrs) =>
            {
                if (hdrs['grpc-status'] !== undefined)
                {
                    const code = parseInt(hdrs['grpc-status'], 10);
                    if (code !== GrpcStatus.OK)
                    {
                        const msg = hdrs['grpc-message']
                            ? decodeURIComponent(hdrs['grpc-message'])
                            : statusName(code);
                        const err = new Error(msg);
                        err.code = code;
                        err.grpcCode = code;
                        reject(err);
                    }
                }
            });

            stream.on('trailers', (trailers) =>
            {
                const code = parseInt(trailers['grpc-status'] || '0', 10);
                if (code !== GrpcStatus.OK)
                {
                    const msg = trailers['grpc-message']
                        ? decodeURIComponent(trailers['grpc-message'])
                        : statusName(code);
                    const err = new Error(msg);
                    err.code = code;
                    err.grpcCode = code;
                    reject(err);
                }
            });
            stream.on('end', () => { parser.destroy(); resolve(responseMsg || {}); });
            stream.on('error', (err) => { parser.destroy(); reject(err); });
        });

        const compress = this._opts.compress;
        const messages = this._schema.messages;

        return {
            write(msg)
            {
                const buf = encode(msg, inputDesc, messages);
                const frame = frameEncode(buf, { compress });
                if (frame instanceof Promise) frame.then((f) => stream.write(f));
                else stream.write(frame);
            },
            end() { stream.end(); },
            cancel() { stream.close(); },
            response,
        };
    }

    // -- Bidirectional Streaming ----------------------------

    /**
     * Make a bidirectional streaming gRPC call — send and receive streams simultaneously.
     * Returns an object that is both writable (`write`/`end`) and async-iterable.
     *
     * @param {string} methodName - RPC method name.
     * @param {object} [opts] - Call options.
     * @param {Metadata|object} [opts.metadata] - Per-call metadata.
     * @param {number} [opts.deadline] - Deadline in ms.
     * @returns {AsyncIterable<object> & { write: Function, end: Function, cancel: Function }}
     *
     * @example
     *   const bidi = client.bidiStream('Chat');
     *   bidi.write({ text: 'Hello' });
     *   for await (const reply of bidi) {
     *       console.log(reply.text);
     *       bidi.write({ text: 'got it' });
     *   }
     *   bidi.end();
     */
    bidiStream(methodName, opts = {})
    {
        const methodDef = this._service.methods[methodName];
        if (!methodDef) throw new Error(`Method "${methodName}" not found`);

        const inputDesc = this._schema.messages[methodDef.inputType];
        const outputDesc = this._schema.messages[methodDef.outputType];

        const session = this._connect();
        const headers = this._buildHeaders(methodName, opts.metadata, opts.deadline);
        const stream = session.request(headers);

        const parser = new FrameParser({ maxMessageSize: this._opts.maxMessageSize });
        const queue = [];
        let waitResolve = null;
        let ended = false;
        let error = null;

        parser.onMessage = (buf) =>
        {
            try
            {
                const msg = decode(buf, outputDesc, this._schema.messages);
                if (waitResolve) { const r = waitResolve; waitResolve = null; r({ value: msg, done: false }); }
                else queue.push(msg);
            }
            catch (err) { error = err; if (waitResolve) { const r = waitResolve; waitResolve = null; r(Promise.reject(err)); } }
        };
        parser.onError = (err) =>
        {
            error = err;
            if (waitResolve) { const r = waitResolve; waitResolve = null; r(Promise.reject(err)); }
        };

        stream.on('data', (chunk) => parser.push(chunk));

        // Trailers-Only response: grpc-status in initial headers
        stream.on('response', (hdrs) =>
        {
            if (hdrs['grpc-status'] !== undefined)
            {
                const code = parseInt(hdrs['grpc-status'], 10);
                if (code !== GrpcStatus.OK)
                {
                    const msg = hdrs['grpc-message']
                        ? decodeURIComponent(hdrs['grpc-message'])
                        : statusName(code);
                    error = new Error(msg);
                    error.code = code;
                    error.grpcCode = code;
                }
            }
        });

        stream.on('end', () =>
        {
            ended = true;
            parser.destroy();
            if (error && waitResolve) { const r = waitResolve; waitResolve = null; r(Promise.reject(error)); }
            else if (waitResolve) { const r = waitResolve; waitResolve = null; r({ value: undefined, done: true }); }
        });
        stream.on('error', (err) =>
        {
            error = err;
            ended = true;
            parser.destroy();
            if (waitResolve) { const r = waitResolve; waitResolve = null; r(Promise.reject(err)); }
        });

        const compress = this._opts.compress;
        const messages = this._schema.messages;

        return {
            write(msg)
            {
                const buf = encode(msg, inputDesc, messages);
                const frame = frameEncode(buf, { compress });
                if (frame instanceof Promise) frame.then((f) => stream.write(f));
                else stream.write(frame);
            },
            end() { stream.end(); },
            cancel() { stream.close(); },
            [Symbol.asyncIterator]()
            {
                return {
                    next()
                    {
                        if (error) return Promise.reject(error);
                        if (queue.length > 0)
                            return Promise.resolve({ value: queue.shift(), done: false });
                        if (ended)
                            return Promise.resolve({ value: undefined, done: true });
                        return new Promise((r) => { waitResolve = r; });
                    },
                };
            },
        };
    }

    // -- Lifecycle ------------------------------------------

    /**
     * Close the client connection.
     */
    close()
    {
        this._closed = true;
        if (this._keepAliveTimer)
        {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
        if (this._balancer)
        {
            this._balancer.shutdown();
            this._balancer = null;
        }
        if (this._session)
        {
            this._session.close();
            this._session = null;
        }
        log.info('gRPC client closed');
    }

    /**
     * Check if the client is connected.
     * @returns {boolean}
     */
    get connected()
    {
        return this._session && !this._session.closed && !this._session.destroyed;
    }
}

module.exports = { GrpcClient };
