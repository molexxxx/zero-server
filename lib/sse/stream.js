/**
 * @module sse/stream
 * @description SSE (Server-Sent Events) stream controller.
 *              Wraps a raw HTTP response and provides the full SSE text protocol.
 *              Tracks connection state, event counts, and bytes sent.
 *              Emits `'close'` when the client disconnects and `'error'` on write failures.
 *
 * @example
 *   app.get('/events', (req, res) => {
 *       const stream = res.sse();           // opens SSE connection
 *
 *       stream.send({ hello: 'world' });    // unnamed event
 *       stream.event('update', { id: 1 });  // named event
 *       stream.retry(3000);                 // set client reconnect delay
 *       stream.keepAlive(15000);            // auto-ping every 15s
 *
 *       stream.on('close', () => {
 *           console.log('client disconnected after', stream.uptime, 'ms');
 *       });
 *   });
 */
class SSEStream
{
    /**
     * @constructor
     * @param {import('http').ServerResponse} raw - Raw HTTP response stream.
     * @param {object} [opts] - Configuration options.
     * @param {boolean} [opts.secure]    - Whether the connection is over TLS.
     * @param {boolean} [opts.autoId]    - Auto-increment event IDs.
     * @param {number}  [opts.startId]   - Starting value for auto-ID (default 1).
     * @param {string}  [opts.lastEventId] - Last-Event-ID from the client reconnection header.
     * @param {number}  [opts.keepAlive] - Interval (ms) for automatic keep-alive pings. 0 to disable.
     * @param {string}  [opts.keepAliveComment] - Comment text for keep-alive pings (default `'ping'`).
     */
    constructor(raw, opts = {})
    {
        this._raw = raw;
        this._closed = false;
        this._log = require('../debug')('zero:sse');

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
            this._log.debug('stream closed, %d events sent', this.eventCount);
            this._emit('close');
        });

        raw.on('error', (err) => { this._log.error('stream error: %s', err.message); this._emit('error', err); });
    }

    // -- Event Emitter ---------------------------------

    /**
     * Register an event listener.
     * @param {'close'|'error'} event - Event name.
     * @param {Function} fn - Callback function.
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
     * @param {'close'|'error'} event - Event name.
     * @param {Function} fn - Callback function.
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
     * @param {string} event - Event name.
     * @param {Function} fn - Callback function.
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
     * @param {string} [event] - Event name.
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
     * @param {string} event - Event name.
     * @returns {number} Number of registered listeners.
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
     * @param {string} str - String to write.
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
     * @param {string|object} data - Record data object.
     * @returns {string} Formatted string.
     */
    _formatData(data)
    {
        let payload;
        if (typeof data === 'object')
        {
            try { payload = JSON.stringify(data); }
            catch (e) { payload = '[Serialization Error]'; }
        }
        else { payload = String(data); }
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
     * @param {*} obj - Data object to send.
     * @param {string|number} [id] - Unique identifier.
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
        // Escape newlines to prevent SSE frame injection
        const safe = String(text).split('\n').join('\n: ');
        this._write(`: ${safe}\n\n`);
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
     * @returns {void}
     */
    close()
    {
        if (this._closed) return;
        this._closed = true;
        this._clearKeepAlive();
        try { this._raw.end(); } catch (e) { }
    }

    /**
     * Whether the connection is still open.
     * @returns {boolean} `true` if the stream has not been closed.
     */
    get connected() { return !this._closed; }

    /**
     * How long this stream has been open (ms).
     * @returns {number} Milliseconds since the stream was opened.
     */
    get uptime() { return Date.now() - this.connectedAt; }

    /** @private */
    _clearKeepAlive()
    {
        if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
    }
}

module.exports = SSEStream;
