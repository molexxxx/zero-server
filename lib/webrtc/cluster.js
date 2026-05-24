/**
 * @module webrtc/cluster
 * @description Cluster adapter for the signaling hub. `useCluster(hub,
 *   adapter)` glues a `SignalingHub` to any `{ publish, subscribe }`
 *   pub/sub bus so joins, leaves, broadcasts, and direct frames flow
 *   across nodes. Ships with `MemoryClusterAdapter`; wire to Redis, NATS,
 *   Kafka, or any in-house bus in production.
 *
 * @section Cluster
 */

'use strict';

const crypto = require('node:crypto');

// --- Channel naming ---

const CH_ANNOUNCE = 'zs:rtc:announce';
const CH_LOAD     = 'zs:rtc:load';
const chRoom = (name) => `zs:rtc:room:${name}`;
const chNode = (id) => `zs:rtc:node:${id}`;

// --- ClusterCoordinator ---

/**
 * Per-hub cluster glue.  Created by {@link useCluster} and parked on
 * `hub._cluster`.  Owns the directory of remote peers and the set of
 * pub/sub subscriptions.
 *
 * @class
 * @section Cluster
 */
class ClusterCoordinator
{
    /**
     * @constructor
     * @param {import('./signaling').SignalingHub} hub
     * @param {{publish:Function, subscribe:Function}} adapter
     * @param {object} [opts]
     * @param {string} [opts.nodeId] - Stable id for this node.  Defaults to
     *                                  a random 8-byte hex string.
     * @param {string} [opts.region] - Region tag (e.g. `'us-east'`).  Surfaces
     *                                  in load announcements and lets the
     *                                  cascade's bridge selector prefer
     *                                  same-region peers.
     * @param {Function} [opts.loadProbe] - `() => { cpu?:number, producers?:number,
     *                                  consumers?:number, bandwidthIn?:number,
     *                                  bandwidthOut?:number, custom?:object }`.
     *                                  Sync or async.  When provided, the
     *                                  coordinator publishes a load snapshot
     *                                  every `opts.loadIntervalMs` ms.
     * @param {number} [opts.loadIntervalMs=5000] - 0 disables the periodic timer
     *                                  (callers can call `publishLoad()` manually).
     */
    constructor(hub, adapter, opts = {})
    {
        /** @type {import('./signaling').SignalingHub} */
        this.hub = hub;
        /** @type {{publish:Function, subscribe:Function}} */
        this.adapter = adapter;
        /** @type {string} */
        this.nodeId = opts.nodeId || crypto.randomBytes(8).toString('hex');
        /** @type {string|null} */
        this.region = opts.region || null;
        /** @type {Function|null} */
        this._loadProbe = typeof opts.loadProbe === 'function' ? opts.loadProbe : null;
        /** @type {number} */
        this._loadIntervalMs = opts.loadIntervalMs == null ? 5000 : opts.loadIntervalMs;

        /**
         * Remote peer directory.  `peerId -> { nodeId, room }`.
         * @type {Map<string, {nodeId: string, room: string}>}
         */
        this._remotePeers = new Map();

        /**
         * Remote node directory.  `nodeId -> { region, load, lastSeen }`.
         * Populated from `zs:rtc:load` and `hello` announcements.
         * @type {Map<string, {region:string|null, load:object|null, lastSeen:number}>}
         */
        this._nodes = new Map();
        this._nodes.set(this.nodeId, { region: this.region, load: null, lastSeen: Date.now() });

        /** @type {Map<string, Function|null>} */
        this._roomSubs = new Map();

        /** @type {Function[]} */
        this._unsubs = [];

        /** @type {boolean} */
        this._closed = false;

        /** @type {NodeJS.Timeout|null} */
        this._loadTimer = null;

        this._wire();
    }

    /** @private */
    _wire()
    {
        const offAnnounce = this.adapter.subscribe(CH_ANNOUNCE, (m) => this._onAnnounce(m));
        const offNode     = this.adapter.subscribe(chNode(this.nodeId), (m) => this._onNodeMsg(m));
        const offLoad     = this.adapter.subscribe(CH_LOAD,     (m) => this._onLoad(m));
        if (typeof offAnnounce === 'function') this._unsubs.push(offAnnounce);
        if (typeof offNode === 'function')     this._unsubs.push(offNode);
        if (typeof offLoad === 'function')     this._unsubs.push(offLoad);

        this._onJoin = ({ peer, room }) =>
        {
            this._ensureRoomSub(room.name);
            this._safePub(CH_ANNOUNCE, {
                kind: 'join', nodeId: this.nodeId, region: this.region, peerId: peer.id, room: room.name,
            });
        };
        this._onLeave = ({ peer, room }) =>
        {
            this._safePub(CH_ANNOUNCE, {
                kind: 'leave', nodeId: this.nodeId, peerId: peer.id, room: room.name,
            });
        };
        this.hub.on('join',  this._onJoin);
        this.hub.on('leave', this._onLeave);

        // Ask existing nodes to rebroadcast their directory.
        this._safePub(CH_ANNOUNCE, { kind: 'hello', nodeId: this.nodeId, region: this.region });

        // Periodic load broadcast.
        if (this._loadProbe && this._loadIntervalMs > 0)
        {
            this._loadTimer = setInterval(() => { this.publishLoad().catch(() => {}); }, this._loadIntervalMs);
            if (this._loadTimer && typeof this._loadTimer.unref === 'function') this._loadTimer.unref();
        }
    }

    /** @private */
    _ensureRoomSub(roomName)
    {
        if (this._roomSubs.has(roomName)) return;
        const off = this.adapter.subscribe(chRoom(roomName), (m) => this._onRoomMsg(roomName, m));
        this._roomSubs.set(roomName, typeof off === 'function' ? off : null);
    }

    /** @private */
    _onAnnounce(m)
    {
        if (!m || m.nodeId === this.nodeId || this._closed) return;
        if (m.region !== undefined) this._touchNode(m.nodeId, { region: m.region });
        if (m.kind === 'join')
        {
            this._remotePeers.set(m.peerId, { nodeId: m.nodeId, room: m.room });
            this._ensureRoomSub(m.room);
        }
        else if (m.kind === 'leave')
        {
            const entry = this._remotePeers.get(m.peerId);
            if (entry && entry.nodeId === m.nodeId) this._remotePeers.delete(m.peerId);
        }
        else if (m.kind === 'hello')
        {
            // Replay our local directory so the newcomer learns about us.
            for (const peer of this.hub._peers.values())
            {
                if (peer.room)
                {
                    this._safePub(CH_ANNOUNCE, {
                        kind: 'join', nodeId: this.nodeId, region: this.region, peerId: peer.id, room: peer.room.name,
                    });
                }
            }
            // Also replay our latest load so the newcomer's selector works immediately.
            const me = this._nodes.get(this.nodeId);
            if (me && me.load)
            {
                this._safePub(CH_LOAD, { nodeId: this.nodeId, region: this.region, load: me.load, at: Date.now() });
            }
        }
    }

    /** @private */
    _onLoad(m)
    {
        if (!m || !m.nodeId || m.nodeId === this.nodeId || this._closed) return;
        this._touchNode(m.nodeId, { region: m.region == null ? null : m.region, load: m.load || null });
    }

    /** @private */
    _touchNode(nodeId, patch)
    {
        const cur = this._nodes.get(nodeId) || { region: null, load: null, lastSeen: 0 };
        if (patch.region !== undefined) cur.region = patch.region;
        if (patch.load   !== undefined) cur.load   = patch.load;
        cur.lastSeen = Date.now();
        this._nodes.set(nodeId, cur);
    }

    /** @private */
    _onNodeMsg(m)
    {
        if (!m || m.nodeId === this.nodeId || this._closed) return;
        const target = this.hub._peers.get(m.target);
        if (!target) return;
        target.send(m.type, m.payload);
    }

    /** @private */
    _onRoomMsg(roomName, m)
    {
        if (!m || m.nodeId === this.nodeId || this._closed) return;
        const room = this.hub._rooms.get(roomName);
        if (!room) return;
        for (const p of room._peers)
        {
            if (m.exclude && p.id === m.exclude) continue;
            p.send(m.type, m.payload);
        }
    }

    /**
     * Look up the node that owns a remote peer, if any.
     * @param {string} peerId
     * @returns {{nodeId:string, room:string}|null}
     */
    locate(peerId)
    {
        return this._remotePeers.get(peerId) || null;
    }

    /**
     * Forward a direct frame to a peer on another node.  Called by the
     * hub when a routed message (`offer` / `answer` / `ice`) targets a
     * peer id that is not in the local registry.
     *
     * @param {string} toPeerId
     * @param {string} type
     * @param {object} payload
     * @returns {boolean} `true` if a remote node was addressed.
     */
    routeDirect(toPeerId, type, payload)
    {
        const entry = this._remotePeers.get(toPeerId);
        if (!entry) return false;
        this._safePub(chNode(entry.nodeId), {
            nodeId: this.nodeId, target: toPeerId, type, payload,
        });
        return true;
    }

    /**
     * Mirror a `room.broadcast(...)` to peers in the same room on other
     * nodes.  Called automatically from `Room#broadcast`.
     *
     * @param {string} roomName
     * @param {string} type
     * @param {object} payload
     * @param {string} [excludeId]
     */
    fanoutRoom(roomName, type, payload, excludeId)
    {
        this._safePub(chRoom(roomName), {
            nodeId: this.nodeId, type, payload, exclude: excludeId || null,
        });
    }

    /**
     * Publish a load snapshot now.  Returns the snapshot that was sent.
     * Called automatically on the configured interval when `loadProbe`
     * is set, but can also be invoked manually (e.g. from tests, or to
     * publish immediately after a producer count changes).
     */
    async publishLoad()
    {
        if (!this._loadProbe || this._closed) return null;
        let load;
        try { load = await this._loadProbe(); }
        catch (err) { this.hub.emit('clusterError', err); return null; }
        if (!load || typeof load !== 'object') return null;
        this._touchNode(this.nodeId, { load });
        this._safePub(CH_LOAD, { nodeId: this.nodeId, region: this.region, load, at: Date.now() });
        return load;
    }

    /**
     * Snapshot of every known node (including self).
     * @returns {Array<{nodeId:string, region:string|null, load:object|null, lastSeen:number}>}
     */
    nodes()
    {
        const out = [];
        for (const [nodeId, n] of this._nodes)
            out.push({ nodeId, region: n.region, load: n.load, lastSeen: n.lastSeen });
        return out;
    }

    /**
     * Pick a node for a new bridge using one of the built-in selectors
     * or a custom comparator.  Returns the chosen `nodeId` (which may be
     * this node's own id when it wins).
     *
     * @param {object} [opts]
     * @param {'local-only'|'least-loaded'|'region-aware'|'region-aware-least-loaded'} [opts.strategy='region-aware-least-loaded']
     * @param {string} [opts.preferRegion] - Override the local region preference.
     * @param {(a, b) => number} [opts.compare] - Custom comparator; smaller wins.
     * @returns {string} nodeId
     */
    selectBridge(opts)
    {
        const o = opts || {};
        const strategy = o.strategy || 'region-aware-least-loaded';
        if (strategy === 'local-only') return this.nodeId;
        const preferRegion = o.preferRegion !== undefined ? o.preferRegion : this.region;
        const candidates = this.nodes();
        if (candidates.length === 0) return this.nodeId;
        const loadScore = (n) =>
        {
            const l = n.load;
            if (!l) return Number.POSITIVE_INFINITY;
            if (typeof l.cpu === 'number') return l.cpu;
            if (typeof l.producers === 'number') return l.producers;
            return Number.POSITIVE_INFINITY;
        };
        let compare;
        if (typeof o.compare === 'function') compare = o.compare;
        else if (strategy === 'least-loaded') compare = (a, b) => loadScore(a) - loadScore(b);
        else if (strategy === 'region-aware')
            compare = (a, b) =>
            {
                const aHit = a.region && a.region === preferRegion ? 0 : 1;
                const bHit = b.region && b.region === preferRegion ? 0 : 1;
                return aHit - bHit;
            };
        else /* region-aware-least-loaded (default) */
            compare = (a, b) =>
            {
                const aHit = a.region && a.region === preferRegion ? 0 : 1;
                const bHit = b.region && b.region === preferRegion ? 0 : 1;
                if (aHit !== bHit) return aHit - bHit;
                return loadScore(a) - loadScore(b);
            };
        const sorted = candidates.slice().sort(compare);
        return sorted[0].nodeId;
    }

    /** Tear down all subscriptions and clear remote state. */
    close()
    {
        if (this._closed) return;
        this._closed = true;
        if (this._loadTimer) { try { clearInterval(this._loadTimer); } catch { /* ignore */ } this._loadTimer = null; }
        try { this.hub.off('join',  this._onJoin);  } catch { /* ignore */ }
        try { this.hub.off('leave', this._onLeave); } catch { /* ignore */ }
        for (const off of this._unsubs) { try { off(); } catch { /* ignore */ } }
        for (const off of this._roomSubs.values())
        {
            if (typeof off === 'function') { try { off(); } catch { /* ignore */ } }
        }
        this._unsubs.length = 0;
        this._roomSubs.clear();
        this._remotePeers.clear();
        this._nodes.clear();
        if (this.hub._cluster === this) this.hub._cluster = null;
    }

    /** @private */
    _safePub(channel, message)
    {
        try
        {
            const result = this.adapter.publish(channel, message);
            if (result && typeof result.catch === 'function')
                result.catch((err) => this.hub.emit('clusterError', err));
        }
        catch (err)
        {
            this.hub.emit('clusterError', err);
        }
    }
}

// --- useCluster ---

/**
 * Attach a cluster adapter to a `SignalingHub`.
 *
 * @param {import('./signaling').SignalingHub} hub
 * @param {{publish:Function, subscribe:Function}} adapter
 * @param {object} [opts]
 * @param {string} [opts.nodeId]
 * @returns {ClusterCoordinator}
 *
 * @section Cluster
 *
 * @example | In-memory cluster (tests / single-process simulation)
 *   const { SignalingHub, useCluster, MemoryClusterAdapter } = require('@zero-server/webrtc');
 *   const adapter = new MemoryClusterAdapter();
 *   const a = new SignalingHub(); useCluster(a, adapter, { nodeId: 'a' });
 *   const b = new SignalingHub(); useCluster(b, adapter, { nodeId: 'b' });
 *
 * @example | Redis adapter (BYO ioredis)
 *   const Redis = require('ioredis');
 *   const pub = new Redis(), sub = new Redis();
 *   const adapter = {
 *       publish:   (ch, msg) => pub.publish(ch, JSON.stringify(msg)),
 *       subscribe: (ch, cb) => {
 *           sub.subscribe(ch);
 *           const on = (c, raw) => { if (c === ch) cb(JSON.parse(raw)); };
 *           sub.on('message', on);
 *           return () => { sub.off('message', on); sub.unsubscribe(ch); };
 *       },
 *   };
 *   useCluster(hub, adapter);
 */
function useCluster(hub, adapter, opts)
{
    if (!adapter || typeof adapter.publish !== 'function' || typeof adapter.subscribe !== 'function')
        throw new TypeError('useCluster: adapter must implement { publish, subscribe }');
    const coord = new ClusterCoordinator(hub, adapter, opts);
    hub._cluster = coord;
    return coord;
}

// --- MemoryClusterAdapter ---

/**
 * In-memory pub/sub adapter for tests and single-process simulations.
 * Delivers synchronously to all subscribers on the same channel.
 *
 * @class
 * @section Cluster
 *
 * @example
 *   const adapter = new MemoryClusterAdapter();
 *   useCluster(hubA, adapter); useCluster(hubB, adapter);
 */
class MemoryClusterAdapter
{
    constructor()
    {
        /** @type {Map<string, Function[]>} */
        this._channels = new Map();
    }

    /**
     * @param {string} channel
     * @param {*} message
     */
    publish(channel, message)
    {
        const list = this._channels.get(channel);
        if (!list || list.length === 0) return;
        for (const fn of list.slice())
        {
            try { fn(message); } catch { /* swallow subscriber errors */ }
        }
    }

    /**
     * @param {string} channel
     * @param {(msg:*) => void} fn
     * @returns {() => void} unsubscribe
     */
    subscribe(channel, fn)
    {
        let list = this._channels.get(channel);
        if (!list) { list = []; this._channels.set(channel, list); }
        list.push(fn);
        return () =>
        {
            const cur = this._channels.get(channel);
            if (!cur) return;
            const i = cur.indexOf(fn);
            if (i >= 0) cur.splice(i, 1);
            if (cur.length === 0) this._channels.delete(channel);
        };
    }
}

module.exports = {
    useCluster,
    ClusterCoordinator,
    MemoryClusterAdapter,
    CH_ANNOUNCE,
    CH_LOAD,
};
