/**
 * @module sse/stream
 * @description SSE (Server-Sent Events) stream controller.
 *              Wraps a raw HTTP response and provides the full SSE text protocol.
 *
 * Properties:
 *   - `connected`    {boolean}  Whether the stream is still open.
 *   - `lastEventId`  {string|null}  The `Last-Event-ID` header from the client reconnection.
 *   - `eventCount`   {number}  Total events sent on this stream.
 *   - `bytesSent`    {number}  Total bytes written to the stream.
 *   - `connectedAt`  {number}  Timestamp (ms) when the stream was opened.
 *   - `uptime`       {number}  Milliseconds since the stream was opened (computed).
 *   - `data`         {object}  Arbitrary user-data store.
 *
 * Events (via `.on()`):
 *   - `'close'`  — Client disconnected or `.close()` was called.
 *   - `'error'`  (err: Error) — Write error on the underlying response.
 */
class SSEStream
{
    /**
     * @param {import('http').ServerResponse} raw
     * @param {object} opts
     */
    constructor(raw, opts = {})
    {
        this._raw = raw;
        this._closed = false;

        /** `true` when the underlying connection is over TLS (HTTPS). */
        this.secure = !!opts.secure;

        /** Auto-increment counter for event IDs. */
        this._autoId = opts.autoId || false;
        this._nextId = opts.startId || 1;

        /** The Last-Event-ID sent by the client on reconnection. */
        this.lastEventId = opts.lastEventId || null;

        /** Total number of events pushed. */
        this.eventCount = 0;

        /** Total bytes written to the stream. */
        this.bytesSent = 0;

        /** Timestamp when the stream was opened. */
        this.connectedAt = Date.now();

        /** Arbitrary user-data store. */
        this.data = {};

        /** @type {Object<string, Function[]>} */
        this._listeners = {};

        /** @private */
        this._keepAliveTimer = null;

        // Auto keep-alive
        if (opts.keepAlive && opts.keepAlive > 0)
        {
            const commentText = opts.keepAliveComment || 'ping';
            this._keepAliveTimer = setInterval(() => this.comment(commentText), opts.keepAlive);
            if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
        }

        raw.on('close', () =>
        {
            this._closed = true;
            this._clearKeepAlive();
            this._emit('close');
        });

        raw.on('error', (err) => this._emit('error', err));
    }

    // -- Event Emitter ---------------------------------

    /**
     * Register an event listener.
     * @param {'close'|'error'} event
     * @param {Function} fn
     * @returns {SSEStream} this
     */
    on(event, fn)
    {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    /**
     * Register a one-time listener.
     * @param {'close'|'error'} event
     * @param {Function} fn
     * @returns {SSEStream} this
     */
    once(event, fn)
    {
        const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
        wrapper._original = fn;
        return this.on(event, wrapper);
    }

    /**
     * Remove a listener.
     * @param {string} event
     * @param {Function} fn
     * @returns {SSEStream} this
     */
    off(event, fn)
    {
        const list = this._listeners[event];
        if (!list) return this;
        this._listeners[event] = list.filter(f => f !== fn && f._original !== fn);
        return this;
    }

    /**
     * Remove all listeners for an event (or all events).
     * @param {string} [event]
     * @returns {SSEStream} this
     */
    removeAllListeners(event)
    {
        if (event) delete this._listeners[event];
        else this._listeners = {};
        return this;
    }

    /**
     * Count listeners for an event.
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

    // -- Writing Helpers -------------------------------

    /**
     * Write a raw string to the underlying response.
     * @private
     * @param {string} str
     */
    _write(str)
    {
        if (this._closed) return;
        try
        {
            this._raw.write(str);
            this.bytesSent += Buffer.byteLength(str, 'utf8');
        }
        catch (e) { }
    }

    /**
     * Format a payload into `data:` lines per the SSE spec.
     * Objects are JSON-serialised automatically.
     * @private
     * @param {string|object} data
     * @returns {string}
     */
    _formatData(data)
    {
        const payload = typeof data === 'object' ? JSON.stringify(data) : String(data);
        return payload.split('\n').map(line => `data: ${line}\n`).join('');
    }

    // -- Public API ------------------------------------

    /**
     * Send an unnamed data event.
     * Objects are automatically JSON-serialised.
     *
     * @param {string|object} data - Payload to send.
     * @param {string|number} [id] - Optional event ID (overrides auto-ID).
     * @returns {SSEStream} this
     */
    send(data, id)
    {
        if (this._closed) return this;
        let msg = '';
        const eventId = id !== undefined ? id : (this._autoId ? this._nextId++ : undefined);
        if (eventId !== undefined) msg += `id: ${eventId}\n`;
        msg += this._formatData(data);
        msg += '\n';
        this._write(msg);
        this.eventCount++;
        return this;
    }

    /**
     * Convenience: send an object as JSON data (same as `.send(obj)`).
     * @param {*} obj
     * @param {string|number} [id]
     * @returns {SSEStream} this
     */
    sendJSON(obj, id)
    {
        return this.send(obj, id);
    }

    /**
     * Send a named event with data.
     *
     * @param {string} eventName   - Event type (appears as `event:` field).
     * @param {string|object} data - Payload.
     * @param {string|number} [id] - Optional event ID (overrides auto-ID).
     * @returns {SSEStream} this
     */
    event(eventName, data, id)
    {
        if (this._closed) return this;
        let msg = `event: ${eventName}\n`;
        const eventId = id !== undefined ? id : (this._autoId ? this._nextId++ : undefined);
        if (eventId !== undefined) msg += `id: ${eventId}\n`;
        msg += this._formatData(data);
        msg += '\n';
        this._write(msg);
        this.eventCount++;
        return this;
    }

    /**
     * Send a comment line.  Comments are ignored by EventSource clients
     * but useful as a keep-alive mechanism.
     *
     * @param {string} text - Comment text.
     * @returns {SSEStream} this
     */
    comment(text)
    {
        if (this._closed) return this;
        this._write(`: ${text}\n\n`);
        return this;
    }

    /**
     * Send (or update) the retry interval hint.
     * The client's EventSource will use this value for reconnection delay.
     *
     * @param {number} ms - Retry interval in milliseconds.
     * @returns {SSEStream} this
     */
    retry(ms)
    {
        if (this._closed) return this;
        this._write(`retry: ${ms}\n\n`);
        return this;
    }

    /**
     * Start or restart an automatic keep-alive timer that sends comment
     * pings at the given interval.
     *
     * @param {number} intervalMs - Interval in ms. Pass `0` to stop.
     * @param {string} [comment='ping'] - Comment text to send.
     * @returns {SSEStream} this
     */
    keepAlive(intervalMs, comment)
    {
        this._clearKeepAlive();
        if (intervalMs && intervalMs > 0)
        {
            const text = comment || 'ping';
            this._keepAliveTimer = setInterval(() => this.comment(text), intervalMs);
            if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
        }
        return this;
    }

    /**
     * Flush the response (hint to Node to push buffered data to the network).
     * Useful when piping through reverse proxies that buffer.
     *
     * @returns {SSEStream} this
     */
    flush()
    {
        if (this._closed) return this;
        try
        {
            if (typeof this._raw.flushHeaders === 'function') this._raw.flushHeaders();
        }
        catch (e) { }
        return this;
    }

    /**
     * Close the SSE connection from the server side.
     */
    close()
    {
        if (this._closed) return;
        this._closed = true;
        this._clearKeepAlive();
        try { this._raw.end(); } catch (e) { }
    }

    /** Whether the connection is still open. */
    get connected() { return !this._closed; }

    /** How long this stream has been open (ms). */
    get uptime() { return Date.now() - this.connectedAt; }

    /** @private */
    _clearKeepAlive()
    {
        if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
    }
}

module.exports = SSEStream;
