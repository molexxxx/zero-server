/**
 * @module grpc/call
 * @description gRPC call objects for the four RPC patterns.
 *              Wraps HTTP/2 streams with protobuf encode/decode, metadata,
 *              framing, deadline enforcement, and cancellation support.
 *
 *              - `UnaryCall` — single request, single response
 *              - `ServerStreamCall` — single request, stream of responses
 *              - `ClientStreamCall` — stream of requests, single response
 *              - `BidiStreamCall` — bidirectional streaming
 *
 * @example | Unary handler
 *   async function GetUser(call) {
 *       const user = await db.findById(call.request.id);
 *       return user; // auto-encoded and sent
 *   }
 *
 * @example | Server streaming handler
 *   async function ListUsers(call) {
 *       for (const user of users) {
 *           call.write(user);
 *       }
 *       call.end();
 *   }
 *
 * @example | Bidirectional streaming handler
 *   async function Chat(call) {
 *       for await (const msg of call) {
 *           call.write({ echo: msg.text, ts: Date.now() });
 *       }
 *   }
 */

const { EventEmitter } = require('events');
const log = require('../debug')('zero:grpc');
const { GrpcStatus, statusName } = require('./status');
const { Metadata } = require('./metadata');
const { frameEncode, FrameParser } = require('./frame');
const { encode, decode } = require('./codec');

// -- Base Call ---------------------------------------------

/**
 * Base class for all gRPC call types. Manages the HTTP/2 stream,
 * metadata, deadlines, cancellation, and common lifecycle.
 *
 * @class
 * @private
 */
class BaseCall extends EventEmitter
{
    /**
     * @constructor
     * @param {import('http2').Http2Stream} stream - The HTTP/2 stream for this call.
     * @param {object} methodDef - Method descriptor from the proto schema.
     * @param {object} messageTypes - Map of all message descriptors.
     * @param {Metadata} metadata - Initial metadata from the client.
     * @param {object} [opts] - Call options.
     * @param {number} [opts.maxMessageSize] - Max message size in bytes.
     * @param {boolean} [opts.compress=false] - Whether to compress outgoing messages.
     */
    constructor(stream, methodDef, messageTypes, metadata, opts = {})
    {
        super();

        /** The underlying HTTP/2 stream. */
        this.stream = stream;

        /** Method descriptor from the parsed proto. */
        this.method = methodDef;

        /** Initial metadata from the client. */
        this.metadata = metadata;

        /** Response (trailing) metadata to be sent with the status. */
        this.trailingMetadata = new Metadata();

        /** @private */
        this._messageTypes = messageTypes;
        /** @private */
        this._inputDesc = messageTypes[methodDef.inputType];
        /** @private */
        this._outputDesc = messageTypes[methodDef.outputType];
        /** @private */
        this._compress = !!opts.compress;
        /** @private */
        this._cancelled = false;
        /** @private */
        this._ended = false;
        /** @private */
        this._headersSent = false;
        /** @private */
        this._deadlineTimer = null;

        if (!this._inputDesc)
            throw new Error(`Unknown input message type: ${methodDef.inputType}`);
        if (!this._outputDesc)
            throw new Error(`Unknown output message type: ${methodDef.outputType}`);

        /** @private */
        this._parser = new FrameParser({ maxMessageSize: opts.maxMessageSize });

        // Parse the deadline from grpc-timeout header
        this._deadline = null;
        const timeoutHeader = stream.sentHeaders && stream.sentHeaders['grpc-timeout'];
        if (timeoutHeader) this._setupDeadline(timeoutHeader);

        // Cancellation via stream reset
        stream.on('close', () =>
        {
            if (!this._ended)
            {
                this._cancelled = true;
                this.emit('cancelled');
            }
            this._cleanup();
        });

        stream.on('error', (err) =>
        {
            log.error('stream error on %s: %s', methodDef.name, err.message);
            this.emit('error', err);
        });

        /** Peer IP address (from stream session). */
        this.peer = stream.session && stream.session.socket
            ? stream.session.socket.remoteAddress || 'unknown'
            : 'unknown';
    }

    // -- Metadata Sending ----------------------------------

    /**
     * Send initial response metadata (HTTP/2 headers).
     * Must be called before writing any messages.
     * If not called explicitly, headers are sent automatically on the first write.
     *
     * @param {Metadata|object} [md] - Additional metadata to merge into the response headers.
     */
    sendMetadata(md)
    {
        if (this._headersSent || this._ended) return;
        this._headersSent = true;

        const headers = {
            ':status': 200,
            'content-type': 'application/grpc+proto',
        };

        if (this._compress) headers['grpc-encoding'] = 'gzip';

        if (md)
        {
            const extra = md instanceof Metadata ? md.toHeaders() : md;
            Object.assign(headers, extra);
        }

        try { this.stream.respond(headers, { waitForTrailers: true }); }
        catch (e) { log.warn('failed to send metadata: %s', e.message); }
    }

    // -- Status / End --------------------------------------

    /**
     * Send a gRPC status and close the call.
     * Trailers carry `grpc-status` and optionally `grpc-message`.
     *
     * @param {number} code - gRPC status code.
     * @param {string} [message] - Human-readable status message.
     */
    sendStatus(code, message)
    {
        if (this._ended) return;
        this._ended = true;

        const trailHeaders = {
            'grpc-status': String(code),
            ...this.trailingMetadata.toHeaders(),
        };
        if (message) trailHeaders['grpc-message'] = encodeURIComponent(message);

        if (!this._headersSent)
        {
            // Trailers-Only response — include status in initial HEADERS frame
            this._headersSent = true;
            try
            {
                this.stream.respond({
                    ':status': 200,
                    'content-type': 'application/grpc+proto',
                    ...trailHeaders,
                }, { endStream: true });
            }
            catch (_)
            {
                try { this.stream.close(); }
                catch (__) { /* nothing to do */ }
            }
        }
        else
        {
            // Headers already sent — send trailing HEADERS after final DATA
            this.stream.on('wantTrailers', () =>
            {
                try { this.stream.sendTrailers(trailHeaders); }
                catch (_) { /* stream may already be closed */ }
            });

            try { this.stream.end(); }
            catch (_)
            {
                try { this.stream.close(); }
                catch (__) { /* nothing to do */ }
            }
        }

        this._cleanup();

        if (code !== GrpcStatus.OK)
            log.warn('call %s ended with status %s: %s', this.method.name, statusName(code), message || '');
        else
            log.debug('call %s completed OK', this.method.name);
    }

    /**
     * Send an error status and close the call.
     * Convenience wrapper around `sendStatus`.
     *
     * @param {number} code - gRPC status code.
     * @param {string} message - Error description.
     */
    sendError(code, message)
    {
        this.sendStatus(code, message);
    }

    // -- Writing -------------------------------------------

    /**
     * Write a response message. The object is encoded to protobuf, framed,
     * and sent on the HTTP/2 stream.
     *
     * @param {object} message - JavaScript object matching the output message schema.
     * @returns {boolean} `false` if the stream is not writable.
     */
    write(message)
    {
        if (this._ended || this._cancelled) return false;
        if (!this._headersSent) this.sendMetadata();

        try
        {
            const buf = encode(message, this._outputDesc, this._messageTypes);
            const frame = frameEncode(buf, { compress: this._compress });

            if (frame instanceof Promise)
            {
                frame.then((f) =>
                {
                    if (!this._ended && !this._cancelled)
                        this.stream.write(f);
                }).catch((err) =>
                {
                    log.error('compression error: %s', err.message);
                    this.sendError(GrpcStatus.INTERNAL, 'Compression failed');
                });
                return true;
            }

            return this.stream.write(frame);
        }
        catch (err)
        {
            log.error('encode error in %s: %s', this.method.name, err.message);
            this.sendError(GrpcStatus.INTERNAL, 'Failed to encode response');
            return false;
        }
    }

    // -- Deadline ------------------------------------------

    /**
     * Parse and set up a deadline from the `grpc-timeout` header.
     * Format: `{value}{unit}` where unit is n(nano), u(micro), m(milli), S(seconds), M(minutes), H(hours).
     * @private
     * @param {string} timeoutStr
     */
    _setupDeadline(timeoutStr)
    {
        const match = /^(\d+)([nmuSMH])$/.exec(timeoutStr);
        if (!match)
        {
            log.warn('invalid grpc-timeout: %s', timeoutStr);
            return;
        }

        const val = parseInt(match[1], 10);
        let ms;

        switch (match[2])
        {
            case 'n': ms = val / 1e6; break;        // nanoseconds
            case 'u': ms = val / 1e3; break;        // microseconds
            case 'm': ms = val; break;               // milliseconds
            case 'S': ms = val * 1000; break;        // seconds
            case 'M': ms = val * 60 * 1000; break;   // minutes
            case 'H': ms = val * 3600 * 1000; break; // hours
            default: return;
        }

        this._deadline = Date.now() + ms;
        this._deadlineTimer = setTimeout(() =>
        {
            if (!this._ended)
            {
                log.warn('deadline exceeded for %s (%dms)', this.method.name, ms);
                this.sendError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded');
            }
        }, Math.max(1, ms));

        if (this._deadlineTimer.unref) this._deadlineTimer.unref();
    }

    /**
     * Check if the call has been cancelled.
     *
     * @returns {boolean}
     */
    get cancelled()
    {
        return this._cancelled;
    }

    /**
     * Cancel the call from the server side.
     */
    cancel()
    {
        if (this._ended) return;
        this._cancelled = true;
        this.sendError(GrpcStatus.CANCELLED, 'Cancelled by server');
    }

    /**
     * Clean up timers and references.
     * @private
     */
    _cleanup()
    {
        if (this._deadlineTimer)
        {
            clearTimeout(this._deadlineTimer);
            this._deadlineTimer = null;
        }
        this._parser.destroy();
    }
}

// -- Unary Call --------------------------------------------

/**
 * A unary gRPC call — single request message, single response message.
 *
 * @class
 * @extends BaseCall
 *
 * @example
 *   // In a service handler:
 *   async function GetUser(call) {
 *       const user = await db.users.findById(call.request.id);
 *       if (!user) call.sendError(GrpcStatus.NOT_FOUND, 'User not found');
 *       return user; // returned value is sent as the response
 *   }
 */
class UnaryCall extends BaseCall
{
    /**
     * @constructor
     * @param {import('http2').Http2Stream} stream
     * @param {object} methodDef
     * @param {object} messageTypes
     * @param {Metadata} metadata
     * @param {object} [opts]
     */
    constructor(stream, methodDef, messageTypes, metadata, opts)
    {
        super(stream, methodDef, messageTypes, metadata, opts);

        /** The decoded request message (populated after receiving the full request). */
        this.request = null;
    }

    /**
     * Initialize the call — collect the full request body and decode it.
     * @private
     * @returns {Promise<void>}
     */
    _init()
    {
        return new Promise((resolve, reject) =>
        {
            this._parser.onMessage = (buf) =>
            {
                try
                {
                    this.request = decode(buf, this._inputDesc, this._messageTypes);
                    resolve();
                }
                catch (err) { reject(err); }
            };
            this._parser.onError = reject;

            this.stream.on('data', (chunk) => this._parser.push(chunk));
            this.stream.on('end', () =>
            {
                if (!this.request) resolve(); // empty body = default message
            });
        });
    }
}

// -- Server Streaming Call ---------------------------------

/**
 * A server-streaming gRPC call — single request, multiple responses.
 * The handler calls `call.write(msg)` for each response and `call.end()` to finish.
 *
 * @class
 * @extends BaseCall
 *
 * @example
 *   async function ListUsers(call) {
 *       const cursor = db.users.cursor();
 *       for await (const user of cursor) {
 *           call.write(user);
 *       }
 *       call.end();
 *   }
 */
class ServerStreamCall extends BaseCall
{
    constructor(stream, methodDef, messageTypes, metadata, opts)
    {
        super(stream, methodDef, messageTypes, metadata, opts);
        this.request = null;
    }

    /**
     * End the server stream with OK status.
     */
    end()
    {
        this.sendStatus(GrpcStatus.OK);
    }

    /** @private */
    _init()
    {
        return new Promise((resolve, reject) =>
        {
            this._parser.onMessage = (buf) =>
            {
                try
                {
                    this.request = decode(buf, this._inputDesc, this._messageTypes);
                    resolve();
                }
                catch (err) { reject(err); }
            };
            this._parser.onError = reject;

            this.stream.on('data', (chunk) => this._parser.push(chunk));
            this.stream.on('end', () =>
            {
                if (!this.request) resolve();
            });
        });
    }
}

// -- Client Streaming Call ---------------------------------

/**
 * A client-streaming gRPC call — multiple requests, single response.
 * The handler iterates `for await (const msg of call)` to consume messages,
 * then returns the response object.
 *
 * @class
 * @extends BaseCall
 *
 * @example
 *   async function UploadChunks(call) {
 *       let total = 0;
 *       for await (const chunk of call) {
 *           total += chunk.data.length;
 *       }
 *       return { bytesReceived: total };
 *   }
 */
class ClientStreamCall extends BaseCall
{
    constructor(stream, methodDef, messageTypes, metadata, opts)
    {
        super(stream, methodDef, messageTypes, metadata, opts);

        /** @private */
        this._messageQueue = [];
        /** @private */
        this._messageResolve = null;
        /** @private */
        this._streamEnded = false;
    }

    /**
     * Initialize — set up the frame parser to enqueue decoded messages.
     * @private
     */
    _init()
    {
        this._parser.onMessage = (buf) =>
        {
            try
            {
                const msg = decode(buf, this._inputDesc, this._messageTypes);
                if (this._messageResolve)
                {
                    const resolve = this._messageResolve;
                    this._messageResolve = null;
                    resolve({ value: msg, done: false });
                }
                else
                {
                    this._messageQueue.push(msg);
                }
            }
            catch (err)
            {
                log.error('decode error in client stream: %s', err.message);
                this.sendError(GrpcStatus.INTERNAL, 'Failed to decode client message');
            }
        };
        this._parser.onError = (err) =>
        {
            this.sendError(GrpcStatus.INTERNAL, err.message);
        };

        this.stream.on('data', (chunk) => this._parser.push(chunk));
        this.stream.on('end', () =>
        {
            this._streamEnded = true;
            if (this._messageResolve)
            {
                const resolve = this._messageResolve;
                this._messageResolve = null;
                resolve({ value: undefined, done: true });
            }
        });

        return Promise.resolve();
    }

    /**
     * Async iterator — enables `for await (const msg of call)`.
     *
     * @returns {AsyncIterator<object>}
     */
    [Symbol.asyncIterator]()
    {
        return {
            next: () =>
            {
                if (this._messageQueue.length > 0)
                {
                    return Promise.resolve({ value: this._messageQueue.shift(), done: false });
                }
                if (this._streamEnded)
                {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) =>
                {
                    this._messageResolve = resolve;
                });
            },
        };
    }
}

// -- Bidirectional Streaming Call ---------------------------

/**
 * A bidirectional streaming gRPC call — multiple requests AND multiple responses.
 * The handler can `for await` incoming messages while simultaneously
 * calling `call.write()` to send responses.
 *
 * @class
 * @extends BaseCall
 *
 * @example
 *   async function Chat(call) {
 *       for await (const msg of call) {
 *           // Echo back with a timestamp
 *           call.write({ text: msg.text, ts: Date.now() });
 *       }
 *       call.end();
 *   }
 */
class BidiStreamCall extends BaseCall
{
    constructor(stream, methodDef, messageTypes, metadata, opts)
    {
        super(stream, methodDef, messageTypes, metadata, opts);

        /** @private */
        this._messageQueue = [];
        /** @private */
        this._messageResolve = null;
        /** @private */
        this._streamEnded = false;
    }

    /**
     * End the bidirectional stream with OK status.
     */
    end()
    {
        this.sendStatus(GrpcStatus.OK);
    }

    /** @private */
    _init()
    {
        this._parser.onMessage = (buf) =>
        {
            try
            {
                const msg = decode(buf, this._inputDesc, this._messageTypes);
                if (this._messageResolve)
                {
                    const resolve = this._messageResolve;
                    this._messageResolve = null;
                    resolve({ value: msg, done: false });
                }
                else
                {
                    this._messageQueue.push(msg);
                }
            }
            catch (err)
            {
                log.error('decode error in bidi stream: %s', err.message);
                this.sendError(GrpcStatus.INTERNAL, 'Failed to decode message');
            }
        };
        this._parser.onError = (err) =>
        {
            this.sendError(GrpcStatus.INTERNAL, err.message);
        };

        this.stream.on('data', (chunk) => this._parser.push(chunk));
        this.stream.on('end', () =>
        {
            this._streamEnded = true;
            if (this._messageResolve)
            {
                const resolve = this._messageResolve;
                this._messageResolve = null;
                resolve({ value: undefined, done: true });
            }
        });

        return Promise.resolve();
    }

    /**
     * Async iterator — enables `for await (const msg of call)`.
     *
     * @returns {AsyncIterator<object>}
     */
    [Symbol.asyncIterator]()
    {
        return {
            next: () =>
            {
                if (this._messageQueue.length > 0)
                {
                    return Promise.resolve({ value: this._messageQueue.shift(), done: false });
                }
                if (this._streamEnded)
                {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) =>
                {
                    this._messageResolve = resolve;
                });
            },
        };
    }
}

module.exports = {
    BaseCall,
    UnaryCall,
    ServerStreamCall,
    ClientStreamCall,
    BidiStreamCall,
};
