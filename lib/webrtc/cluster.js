/**
 * @module webrtc/cluster
 * @description Cluster adapter for the WebRTC signaling hub.
 *
 *   `useCluster(hub, adapter)` glues a `SignalingHub` to any pub/sub
 *   adapter that implements `{ publish(channel, message), subscribe(
 *   channel, cb) -> unsubscribe }`.  Once attached:
 *
 *   - Every local `join` / `leave` is announced cluster-wide so other
 *     nodes can resolve a `peer.id` to its owning node.
 *   - Every `room.broadcast(...)` is mirrored to peers in the same room
 *     on other nodes.
 *   - Direct frames (`offer`, `answer`, `ice`) addressed to a peer that
 *     lives on a different node are forwarded to that node's inbox.
 *
 *   The adapter itself is intentionally tiny so production deployments
 *   can wire it up to Redis, NATS, Kafka, or any in-house bus.  A
 *   `MemoryClusterAdapter` is provided for tests and single-process
 *   simulations.
 *
 * @section Cluster
 */

'use strict';

const crypto = require('node:crypto');

// --- Channel naming ---

const CH_ANNOUNCE = 'zs:rtc:announce';
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
     */
    constructor(hub, adapter, opts = {})
    {
        /** @type {import('./signaling').SignalingHub} */
        this.hub = hub;
        /** @type {{publish:Function, subscribe:Function}} */
        this.adapter = adapter;
        /** @type {string} */
        this.nodeId = opts.nodeId || crypto.randomBytes(8).toString('hex');

        /**
         * Remote peer directory.  `peerId -> { nodeId, room }`.
         * @type {Map<string, {nodeId: string, room: string}>}
         */
        this._remotePeers = new Map();

        /** @type {Map<string, Function|null>} */
        this._roomSubs = new Map();

        /** @type {Function[]} */
        this._unsubs = [];

        /** @type {boolean} */
        this._closed = false;

        this._wire();
    }

    /** @private */
    _wire()
    {
        const offAnnounce = this.adapter.subscribe(CH_ANNOUNCE, (m) => this._onAnnounce(m));
        const offNode     = this.adapter.subscribe(chNode(this.nodeId), (m) => this._onNodeMsg(m));
        if (typeof offAnnounce === 'function') this._unsubs.push(offAnnounce);
        if (typeof offNode === 'function')     this._unsubs.push(offNode);

        this._onJoin = ({ peer, room }) =>
        {
            this._ensureRoomSub(room.name);
            this._safePub(CH_ANNOUNCE, {
                kind: 'join', nodeId: this.nodeId, peerId: peer.id, room: room.name,
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
        this._safePub(CH_ANNOUNCE, { kind: 'hello', nodeId: this.nodeId });
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
                        kind: 'join', nodeId: this.nodeId, peerId: peer.id, room: peer.room.name,
                    });
                }
            }
        }
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

    /** Tear down all subscriptions and clear remote state. */
    close()
    {
        if (this._closed) return;
        this._closed = true;
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
};
