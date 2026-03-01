/**
 * @module ws/connection
 * @description Full-featured WebSocket connection wrapper over a raw TCP socket.
 *              Implements RFC 6455 framing for text, binary, ping, pong, and close.
 */

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
 * Properties:
 *   - `id`            {string}  Unique connection identifier.
 *   - `readyState`    {number}  Current state (0-3, see WS_READY_STATE).
 *   - `protocol`      {string}  Negotiated sub-protocol (or '').
 *   - `extensions`    {string}  Requested extensions header (or '').
 *   - `headers`       {object}  Request headers from the upgrade.
 *   - `ip`            {string|null}  Remote IP address.
 *   - `query`         {object}  Parsed query-string params from the upgrade URL.
 *   - `url`           {string}  Full upgrade request URL.
 *   - `bufferedAmount`{number}  Bytes waiting to be flushed to the network.
 *   - `maxPayload`    {number}  Maximum accepted incoming payload (bytes).
 *
 * Events (via `.on()`):
 *   - `'message'`  (data: string|Buffer)  — Text or binary message received.
 *   - `'close'`    (code?: number, reason?: string) — Connection closed.
 *   - `'error'`    (err: Error)           — Socket error.
 *   - `'pong'`     (payload: Buffer)      — Pong frame received.
 *   - `'ping'`     (payload: Buffer)      — Ping frame received (auto-ponged).
 *   - `'drain'`                           — Socket write buffer drained.
 */
class WebSocketConnection
{
    /**
     * @param {import('net').Socket} socket - The upgraded TCP socket.
     * @param {object} [meta]
     * @param {number}  [meta.maxPayload=1048576]
     * @param {number}  [meta.pingInterval=30000]
     * @param {string}  [meta.protocol]
     * @param {string}  [meta.extensions]
     * @param {object}  [meta.headers]
     * @param {string}  [meta.ip]
     * @param {object}  [meta.query]
     * @param {string}  [meta.url]
     * @param {boolean} [meta.secure=false]
     */
    constructor(socket, meta = {})
    {
        this._socket = socket;
        this._buffer = Buffer.alloc(0);

        /** Unique connection identifier. */
        this.id = 'ws_' + (++_wsIdCounter) + '_' + Date.now().toString(36);

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
                this._emit('close', 1006, '');
            }
        });
        socket.on('error', (err) => this._emit('error', err));
        socket.on('drain', () => this._emit('drain'));
    }

    // -- Event Emitter ---------------------------------

    /**
     * Register an event listener.
     * @param {'message'|'close'|'error'|'pong'|'ping'|'drain'} event
     * @param {Function} fn
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
     * @param {'message'|'close'|'error'|'pong'|'ping'|'drain'} event
     * @param {Function} fn
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
     * @param {string} event
     * @param {Function} fn
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
     * @param {string} [event]
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
     * @param {string} event
     * @returns {number}
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
     * @param {object} [opts]
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
     * @returns {boolean}
     */
    sendJSON(obj, cb)
    {
        return this.send(JSON.stringify(obj), { callback: cb });
    }

    /**
     * Send a ping frame.
     * @param {string|Buffer} [payload] - Optional payload (max 125 bytes).
     * @param {Function} [cb] - Called after the frame is flushed.
     * @returns {boolean}
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
     * @returns {boolean}
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
                payloadLen = this._buffer.readUInt32BE(6);
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
