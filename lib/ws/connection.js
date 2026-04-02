/**
 * @module ws/connection
 * @description Full-featured WebSocket connection wrapper over a raw TCP socket.
 *              Implements RFC 6455 framing for text, binary, ping, pong, and close.
 */

const log = require('../debug')('zero:ws');

/** Auto-incrementing connection ID counter. */
let _wsIdCounter = 0;

/**
 * WebSocket ready-state constants (mirrors the browser WebSocket API).
 * @enum {number}
 */
const WS_READY_STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
};

/**
 * Full-featured WebSocket connection wrapper over a raw TCP socket.
 * Implements RFC 6455 framing for text, binary, ping, pong, and close.
 *
 * @class
 *
 * @example
 *   app.ws('/chat', (ws, req) => {
 *       console.log('connected:', ws.id, 'from', ws.ip);
 *
 *       ws.on('message', data => {
 *           console.log('received:', data);
 *           ws.sendJSON({ echo: data });
 *       });
 *
 *       ws.on('close', (code, reason) => {
 *           console.log('disconnected:', code, reason);
 *       });
 *   });
 */
class WebSocketConnection
{
    /**
     * @constructor
     * @param {import('net').Socket} socket - The upgraded TCP socket.
     * @param {object} [meta] - Connection metadata from the upgrade handshake.
     * @param {number}  [meta.maxPayload=1048576] - Maximum incoming frame size in bytes.
     * @param {number}  [meta.pingInterval=30000] - Auto-ping interval in ms (0 to disable).
     * @param {string}  [meta.protocol] - Negotiated WebSocket sub-protocol.
     * @param {string}  [meta.extensions] - Negotiated WebSocket extensions.
     * @param {object}  [meta.headers] - HTTP headers from the upgrade request.
     * @param {string}  [meta.ip] - Remote IP address of the client.
     * @param {object}  [meta.query] - Parsed query-string parameters from the upgrade URL.
     * @param {string}  [meta.url] - The request URL path.
     * @param {boolean} [meta.secure=false] - Whether the connection is over TLS.
     */
    constructor(socket, meta = {})
    {
        this._socket = socket;
        this._buffer = Buffer.alloc(0);

        /** Unique connection identifier. */
        this.id = 'ws_' + (++_wsIdCounter) + '_' + Date.now().toString(36);
        log.info('connection opened id=%s ip=%s', this.id, socket.remoteAddress);

        /** Current ready state. */
        this.readyState = WS_READY_STATE.OPEN;

        /** Negotiated sub-protocol. */
        this.protocol = meta.protocol || '';

        /** Requested extensions. */
        this.extensions = meta.extensions || '';

        /** Request headers from the upgrade. */
        this.headers = meta.headers || {};

        /** Remote IP address. */
        this.ip = meta.ip || (socket.remoteAddress || null);

        /** Parsed query params from the upgrade URL. */
        this.query = meta.query || {};

        /** Full upgrade URL. */
        this.url = meta.url || '';

        /** `true` when the underlying connection is over TLS (WSS). */
        this.secure = !!meta.secure;

        /** Maximum incoming frame payload in bytes (default 1 MB). */
        this.maxPayload = meta.maxPayload || 1048576;

        /** Timestamp (ms) when the connection was established. */
        this.connectedAt = Date.now();

        /** Arbitrary user-data store. Attach anything you need. */
        this.data = {};

        /** @type {Object<string, Function[]>} */
        this._listeners = {};

        /** @private */
        this._pingTimer = null;

        // Set up auto-ping keep-alive
        const pingInterval = meta.pingInterval !== undefined ? meta.pingInterval : 30000;
        if (pingInterval > 0)
        {
            this._pingTimer = setInterval(() => this.ping(), pingInterval);
            if (this._pingTimer.unref) this._pingTimer.unref();
        }

        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () =>
        {
            if (this.readyState !== WS_READY_STATE.CLOSED)
            {
                this.readyState = WS_READY_STATE.CLOSED;
                this._clearPing();
                log.info('connection closed id=%s', this.id);
                this._emit('close', 1006, '');
            }
        });
        socket.on('error', (err) => { log.error('socket error id=%s: %s', this.id, err.message); this._emit('error', err); });
        socket.on('drain', () => this._emit('drain'));
    }

    // -- Event Emitter ---------------------------------

    /**
     * Register an event listener.
     * @param {'message'|'close'|'error'|'pong'|'ping'|'drain'} event - Event name.
     * @param {Function} fn - Callback function.
     * @returns {WebSocketConnection} this
     */
    on(event, fn)
    {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    /**
     * Register a one-time event listener.
     * @param {'message'|'close'|'error'|'pong'|'ping'|'drain'} event - Event name.
     * @param {Function} fn - Callback function.
     * @returns {WebSocketConnection} this
     */
    once(event, fn)
    {
        const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
        wrapper._original = fn;
        return this.on(event, wrapper);
    }

    /**
     * Remove a specific event listener.
     * @param {string} event - Event name.
     * @param {Function} fn - Callback function.
     * @returns {WebSocketConnection} this
     */
    off(event, fn)
    {
        const list = this._listeners[event];
        if (!list) return this;
        this._listeners[event] = list.filter(f => f !== fn && f._original !== fn);
        return this;
    }

    /**
     * Remove all listeners for an event, or all events if none specified.
     * @param {string} [event] - Event name.
     * @returns {WebSocketConnection} this
     */
    removeAllListeners(event)
    {
        if (event) delete this._listeners[event];
        else this._listeners = {};
        return this;
    }

    /**
     * Count listeners for a given event.
     * @param {string} event - Event name.
     * @returns {number} Number of listeners registered for the event.
     */
    listenerCount(event)
    {
        return (this._listeners[event] || []).length;
    }

    /** @private */
    _emit(event, ...args)
    {
        const fns = this._listeners[event];
        if (fns) fns.slice().forEach(fn => { try { fn(...args); } catch (e) { } });
    }

    // -- Sending ---------------------------------------

    /**
     * Send a text or binary message.
     * @param {string|Buffer} data - Payload.
     * @param {object} [opts] - Configuration options.
     * @param {boolean} [opts.binary] - Force binary frame (opcode 0x02).
     * @param {Function} [opts.callback] - Called after the data is flushed.
     * @returns {boolean} `false` if the socket buffer is full (backpressure).
     */
    send(data, opts)
    {
        if (this.readyState !== WS_READY_STATE.OPEN) return false;
        const cb = opts && opts.callback;
        const forceBinary = opts && opts.binary;
        const isBinary = forceBinary || Buffer.isBuffer(data);
        const opcode = isBinary ? 0x02 : 0x01;
        const payload = isBinary ? (Buffer.isBuffer(data) ? data : Buffer.from(data)) : Buffer.from(String(data), 'utf8');
        const frame = this._buildFrame(opcode, payload);
        try { return this._socket.write(frame, cb); } catch (e) { return false; }
    }

    /**
     * Send a JSON-serialised message (sets text frame).
     * @param {*} obj - Value to serialise.
     * @param {Function} [cb] - Called after the data is flushed.
     * @returns {boolean} `false` if the connection is not open or serialisation fails.
     */
    sendJSON(obj, cb)
    {
        let json;
        try { json = JSON.stringify(obj); }
        catch (e)
        {
            this._emit('error', new Error('Failed to serialize JSON: ' + e.message));
            return false;
        }
        return this.send(json, { callback: cb });
    }

    /**
     * Send a ping frame.
     * @param {string|Buffer} [payload] - Optional payload (max 125 bytes).
     * @param {Function} [cb] - Called after the frame is flushed.
     * @returns {boolean} `false` if the connection is not open.
     */
    ping(payload, cb)
    {
        if (this.readyState !== WS_READY_STATE.OPEN) return false;
        const data = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))) : Buffer.alloc(0);
        try { return this._socket.write(this._buildFrame(0x09, data), cb); } catch (e) { return false; }
    }

    /**
     * Send a pong frame.
     * @param {string|Buffer} [payload] - Optional payload.
     * @param {Function} [cb] - Called after the frame is flushed.
     * @returns {boolean} `false` if the connection is not open.
     */
    pong(payload, cb)
    {
        if (this.readyState !== WS_READY_STATE.OPEN) return false;
        const data = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))) : Buffer.alloc(0);
        try { return this._socket.write(this._buildFrame(0x0A, data), cb); } catch (e) { return false; }
    }

    /**
     * Close the WebSocket connection.
     * @param {number} [code=1000] - Close status code.
     * @param {string} [reason]    - Close reason string.
     */
    close(code, reason)
    {
        if (this.readyState === WS_READY_STATE.CLOSED || this.readyState === WS_READY_STATE.CLOSING) return;
        this.readyState = WS_READY_STATE.CLOSING;
        this._clearPing();
        const statusCode = code || 1000;
        const reasonBuf = reason ? Buffer.from(String(reason), 'utf8') : Buffer.alloc(0);
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(statusCode, 0);
        reasonBuf.copy(payload, 2);
        try
        {
            this._socket.write(this._buildFrame(0x08, payload));
            this._socket.end();
        }
        catch (e) { }
    }

    /**
     * Forcefully destroy the underlying socket without a close frame.
     */
    terminate()
    {
        this.readyState = WS_READY_STATE.CLOSED;
        this._clearPing();
        try { this._socket.destroy(); } catch (e) { }
    }

    // -- Computed Properties ---------------------------

    /**
     * Bytes waiting in the send buffer.
     * @type {number}
     */
    get bufferedAmount()
    {
        return this._socket ? (this._socket.writableLength || 0) : 0;
    }

    /**
     * How long this connection has been alive (ms).
     * @type {number}
     */
    get uptime()
    {
        return Date.now() - this.connectedAt;
    }

    // -- Internals -------------------------------------

    /** @private */
    _clearPing()
    {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    /** @private Build a WebSocket frame. */
    _buildFrame(opcode, payload)
    {
        const len = payload.length;
        let header;
        if (len < 126)
        {
            header = Buffer.alloc(2);
            header[0] = 0x80 | opcode; // FIN + opcode
            header[1] = len;
        }
        else if (len < 65536)
        {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        }
        else
        {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeUInt32BE(0, 2);
            header.writeUInt32BE(len, 6);
        }
        return Buffer.concat([header, payload]);
    }

    /** @private Parse incoming WebSocket frames. */
    _onData(chunk)
    {
        this._buffer = Buffer.concat([this._buffer, chunk]);

        while (this._buffer.length >= 2)
        {
            const firstByte = this._buffer[0];
            const secondByte = this._buffer[1];
            const opcode = firstByte & 0x0F;
            const masked = (secondByte & 0x80) !== 0;
            let payloadLen = secondByte & 0x7F;
            let offset = 2;

            if (payloadLen === 126)
            {
                if (this._buffer.length < 4) return;
                payloadLen = this._buffer.readUInt16BE(2);
                offset = 4;
            }
            else if (payloadLen === 127)
            {
                if (this._buffer.length < 10) return;
                // RFC 6455: 64-bit unsigned integer; read upper and lower 32-bit halves
                const upper = this._buffer.readUInt32BE(2);
                const lower = this._buffer.readUInt32BE(6);
                // Reject frames where upper 32 bits are set (>4GB not supported)
                if (upper > 0) { this.close(1009, 'Message too big'); this._buffer = Buffer.alloc(0); return; }
                payloadLen = lower;
                offset = 10;
            }

            // Enforce max payload
            if (payloadLen > this.maxPayload)
            {
                this.close(1009, 'Message too big');
                this._buffer = Buffer.alloc(0);
                return;
            }

            const maskSize = masked ? 4 : 0;
            const totalLen = offset + maskSize + payloadLen;
            if (this._buffer.length < totalLen) return;

            let payload = this._buffer.slice(offset + maskSize, totalLen);
            if (masked)
            {
                const mask = this._buffer.slice(offset, offset + 4);
                payload = Buffer.alloc(payloadLen);
                for (let i = 0; i < payloadLen; i++)
                {
                    payload[i] = this._buffer[offset + maskSize + i] ^ mask[i & 3];
                }
            }

            this._buffer = this._buffer.slice(totalLen);

            switch (opcode)
            {
                case 0x01: // text
                    this._emit('message', payload.toString('utf8'));
                    break;
                case 0x02: // binary
                    this._emit('message', payload);
                    break;
                case 0x08: // close
                {
                    const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                    const closeReason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
                    this.readyState = WS_READY_STATE.CLOSED;
                    this._clearPing();
                    try { this._socket.write(this._buildFrame(0x08, payload)); } catch (e) { }
                    this._socket.end();
                    this._emit('close', closeCode, closeReason);
                    return;
                }
                case 0x09: // ping
                    this._emit('ping', payload);
                    try { this._socket.write(this._buildFrame(0x0A, payload)); } catch (e) { }
                    break;
                case 0x0A: // pong
                    this._emit('pong', payload);
                    break;
            }
        }
    }
}

/** Ready-state constants exposed on the class for convenience. */
WebSocketConnection.CONNECTING = WS_READY_STATE.CONNECTING;
WebSocketConnection.OPEN = WS_READY_STATE.OPEN;
WebSocketConnection.CLOSING = WS_READY_STATE.CLOSING;
WebSocketConnection.CLOSED = WS_READY_STATE.CLOSED;

module.exports = WebSocketConnection;
