/**
 * @module grpc/balancer
 * @description Client-side load balancing for gRPC.
 *              Distributes requests across multiple backend addresses using
 *              pick-first (with failover) or round-robin policies.
 *
 *              Manages subchannels (HTTP/2 connections) per backend with
 *              automatic reconnection, exponential backoff, and health awareness.
 *
 * @example
 *   const { GrpcClient, parseProto } = require('@zero-server/sdk');
 *   const schema = parseProto(protoSource);
 *
 *   const client = new GrpcClient({
 *       addresses: ['backend-1:50051', 'backend-2:50051', 'backend-3:50051'],
 *       loadBalancing: 'round-robin',
 *   }, schema, 'Greeter');
 *
 *   const reply = await client.call('SayHello', { name: 'World' });
 */

const http2 = require('http2');
const { EventEmitter } = require('events');
const log = require('../debug')('zero:grpc:balancer');

// -- Subchannel States -----------------------------------------

/**
 * Connection state machine per subchannel.
 * @enum {string}
 */
const SubchannelState = {
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    READY: 'READY',
    TRANSIENT_FAILURE: 'TRANSIENT_FAILURE',
    SHUTDOWN: 'SHUTDOWN',
};

// -- Subchannel ------------------------------------------------

/**
 * Represents a persistent HTTP/2 connection to a single backend.
 *
 * @class
 * @private
 */
class Subchannel extends EventEmitter
{
    /**
     * @param {string} address - Backend address (host:port or full URL).
     * @param {object} [connectOpts] - HTTP/2 connection options (TLS, etc.).
     */
    constructor(address, connectOpts = {})
    {
        super();

        /** @type {string} */
        this.address = address;

        /** @type {string} */
        this.state = SubchannelState.IDLE;

        /** @private */
        this._connectOpts = connectOpts;

        /** @private @type {import('http2').ClientHttp2Session|null} */
        this._session = null;

        /** @private */
        this._backoff = 1000; // exponential backoff starting at 1s
        this._maxBackoff = 30000;
        this._reconnectTimer = null;

        /** @private */
        this._shutdown = false;

        /** @private */
        this._healthy = true;
    }

    /**
     * Connect to the backend.
     * @returns {import('http2').ClientHttp2Session|null}
     */
    connect()
    {
        if (this._shutdown) return null;
        if (this._session && !this._session.closed && !this._session.destroyed)
            return this._session;

        this._setState(SubchannelState.CONNECTING);

        try
        {
            // Normalize address to URL
            const url = this.address.includes('://') ? this.address : `http://${this.address}`;
            this._session = http2.connect(url, this._connectOpts);

            this._session.on('connect', () =>
            {
                this._backoff = 1000; // reset backoff on successful connect
                this._setState(SubchannelState.READY);
                this._healthy = true;
            });

            this._session.on('error', (err) =>
            {
                log.warn('subchannel %s error: %s', this.address, err.message);
                this._healthy = false;
                this._setState(SubchannelState.TRANSIENT_FAILURE);
                this._scheduleReconnect();
            });

            this._session.on('close', () =>
            {
                this._session = null;
                if (!this._shutdown)
                {
                    this._setState(SubchannelState.IDLE);
                    this._scheduleReconnect();
                }
            });

            this._session.on('goaway', () =>
            {
                log.info('subchannel %s received GOAWAY', this.address);
                this._healthy = false;
                this._setState(SubchannelState.IDLE);
            });

            return this._session;
        }
        catch (err)
        {
            log.error('subchannel %s connect error: %s', this.address, err.message);
            this._setState(SubchannelState.TRANSIENT_FAILURE);
            this._scheduleReconnect();
            return null;
        }
    }

    /**
     * Get the session, connecting if needed.
     * @returns {import('http2').ClientHttp2Session|null}
     */
    getSession()
    {
        if (this._session && !this._session.closed && !this._session.destroyed)
            return this._session;
        return this.connect();
    }

    /**
     * Whether this subchannel is ready to serve requests.
     * @returns {boolean}
     */
    get isReady()
    {
        return this.state === SubchannelState.READY &&
               this._session && !this._session.closed && !this._session.destroyed;
    }

    /**
     * Whether this subchannel is considered healthy.
     * @returns {boolean}
     */
    get isHealthy()
    {
        return this._healthy && this.isReady;
    }

    /**
     * Schedule a reconnection with exponential backoff.
     * @private
     */
    _scheduleReconnect()
    {
        if (this._shutdown || this._reconnectTimer) return;

        this._reconnectTimer = setTimeout(() =>
        {
            this._reconnectTimer = null;
            if (!this._shutdown) this.connect();
        }, this._backoff);
        if (this._reconnectTimer.unref) this._reconnectTimer.unref();

        this._backoff = Math.min(this._backoff * 2, this._maxBackoff);
    }

    /**
     * Update state and emit event.
     * @private
     */
    _setState(state)
    {
        const prev = this.state;
        this.state = state;
        if (prev !== state)
        {
            log.debug('subchannel %s: %s → %s', this.address, prev, state);
            this.emit('stateChange', state, prev);
        }
    }

    /**
     * Shut down this subchannel.
     */
    shutdown()
    {
        this._shutdown = true;
        this._setState(SubchannelState.SHUTDOWN);
        if (this._reconnectTimer)
        {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._session)
        {
            try { this._session.close(); }
            catch (_) { /* ignore */ }
            this._session = null;
        }
    }
}

// -- Load Balancing Policies -----------------------------------

/**
 * Pick-first policy: use the first ready subchannel, failover to next.
 * @private
 * @param {Subchannel[]} subchannels
 * @returns {Subchannel|null}
 */
function pickFirst(subchannels)
{
    // First, try the first ready subchannel
    for (const sc of subchannels)
    {
        if (sc.isHealthy) return sc;
    }
    // Fallback: try any that's ready even if not "healthy"
    for (const sc of subchannels)
    {
        if (sc.isReady) return sc;
    }
    // Connect the first idle one
    for (const sc of subchannels)
    {
        if (sc.state === SubchannelState.IDLE)
        {
            sc.connect();
            return sc;
        }
    }
    return subchannels[0] || null;
}

/**
 * Round-robin policy: distribute requests across all ready subchannels.
 * @private
 */
class RoundRobinPicker
{
    constructor()
    {
        /** @private */
        this._index = 0;
    }

    /**
     * Pick the next subchannel.
     * @param {Subchannel[]} subchannels
     * @returns {Subchannel|null}
     */
    pick(subchannels)
    {
        const ready = subchannels.filter(sc => sc.isHealthy);
        if (ready.length === 0)
        {
            // Fallback to any ready
            const anyReady = subchannels.filter(sc => sc.isReady);
            if (anyReady.length > 0)
            {
                this._index = (this._index + 1) % anyReady.length;
                return anyReady[this._index];
            }
            // Try to connect idle ones
            for (const sc of subchannels)
            {
                if (sc.state === SubchannelState.IDLE) sc.connect();
            }
            return subchannels[0] || null;
        }

        this._index = (this._index + 1) % ready.length;
        return ready[this._index];
    }
}

// -- Balancer --------------------------------------------------

/**
 * Load-balanced wrapper that manages multiple subchannels and
 * exposes a `pickSubchannel()` method for the GrpcClient to use.
 *
 * @class
 */
class LoadBalancer extends EventEmitter
{
    /**
     * @param {string[]} addresses - Backend addresses.
     * @param {object} [opts] - Options.
     * @param {string} [opts.policy='pick-first'] - 'pick-first' or 'round-robin'.
     * @param {object} [opts.connectOpts] - HTTP/2 connection options.
     */
    constructor(addresses, opts = {})
    {
        super();

        /** @type {Subchannel[]} */
        this.subchannels = addresses.map(addr => new Subchannel(addr, opts.connectOpts || {}));

        /** @private */
        this._policy = opts.policy || 'pick-first';

        /** @private */
        this._rrPicker = this._policy === 'round-robin' ? new RoundRobinPicker() : null;

        // Start connecting to all subchannels for round-robin
        if (this._policy === 'round-robin')
        {
            for (const sc of this.subchannels) sc.connect();
        }
        else
        {
            // Pick-first: connect only to the first
            if (this.subchannels.length > 0) this.subchannels[0].connect();
        }
    }

    /**
     * Pick a subchannel for the next request.
     * @returns {Subchannel|null}
     */
    pick()
    {
        if (this._rrPicker)
            return this._rrPicker.pick(this.subchannels);
        return pickFirst(this.subchannels);
    }

    /**
     * Get an HTTP/2 session from the selected subchannel.
     * @returns {import('http2').ClientHttp2Session|null}
     */
    getSession()
    {
        const sc = this.pick();
        if (!sc) return null;
        return sc.getSession();
    }

    /**
     * Shut down all subchannels.
     */
    shutdown()
    {
        for (const sc of this.subchannels) sc.shutdown();
    }
}

module.exports = {
    LoadBalancer,
    Subchannel,
    SubchannelState,
    RoundRobinPicker,
};
