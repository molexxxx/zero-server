/**
 * @module webrtc/room
 * @description Room / channel abstraction for the WebRTC signaling hub.
 *
 *   A `Room` holds a set of `Peer`s plus a list of `require()` policy gates
 *   that decide whether a given peer may join.  Membership is in-process;
 *   the cluster adapter (PR 8) will fan room state out via pub/sub.
 */

'use strict';

const { SignalingError } = require('../errors');

/**
 * One signaling room.
 *
 * Constructed lazily by `SignalingHub#room(name)`.  Application code never
 * calls `new Room()` directly.
 *
 * @class
 * @section Rooms
 *
 * @example
 *   hub.room('lobby').open();
 *   hub.room('boardroom')
 *       .require(peer => peer.user && peer.user.role === 'exec')
 *       .canPublish(peer => peer.user.isHost);
 */
class Room
{
    /**
     * @constructor
     * @param {string} name        - Room name, used as routing key.
     * @param {object} [opts]
     * @param {import('./signaling').SignalingHub} [opts.hub] - Owning hub.
     */
    constructor(name, opts = {})
    {
        if (typeof name !== 'string' || name.length === 0)
            throw new SignalingError('Room name must be a non-empty string');

        /** @type {string} */
        this.name = name;

        /** @type {import('./signaling').SignalingHub|null} */
        this.hub = opts.hub || null;

        /** @type {Set<import('./peer').Peer>} */
        this._peers = new Set();

        /** @type {Array<(peer:import('./peer').Peer) => boolean>} */
        this._gates = [];

        /** @type {((peer:import('./peer').Peer) => boolean)|null} */
        this._canPublish = null;

        /** @type {((peer:import('./peer').Peer) => boolean)|null} */
        this._canSubscribe = null;

        /** @type {boolean} `true` once `.open()` has been called. */
        this.isOpen = false;
    }

    // -- Configuration (fluent) --

    /** Mark the room as public.  Returns `this` for chaining. */
    open()
    {
        this.isOpen = true;
        return this;
    }

    /**
     * Add a policy gate.  Called on every join; first falsy return rejects.
     * @param {(peer:import('./peer').Peer) => boolean | Promise<boolean>} fn
     * @returns {Room}
     */
    require(fn)
    {
        if (typeof fn !== 'function')
            throw new SignalingError('Room.require(fn) requires a function');
        this._gates.push(fn);
        return this;
    }

    /**
     * Set the publish-permission check.  Hub calls this before relaying offers.
     * @param {(peer:import('./peer').Peer) => boolean} fn
     */
    canPublish(fn)   { this._canPublish   = fn; return this; }

    /**
     * Set the subscribe-permission check.  Hub calls this before relaying answers.
     * @param {(peer:import('./peer').Peer) => boolean} fn
     */
    canSubscribe(fn) { this._canSubscribe = fn; return this; }

    // -- Membership --

    /** Current member count. */
    get size() { return this._peers.size; }

    /** @returns {import('./peer').Peer[]} */
    peers() { return Array.from(this._peers); }

    /** @returns {boolean} */
    has(peer) { return this._peers.has(peer); }

    /**
     * Evaluate every `require()` gate against the candidate peer.
     * @param {import('./peer').Peer} peer
     * @returns {boolean}
     */
    canJoin(peer)
    {
        for (const gate of this._gates)
        {
            try { if (!gate(peer)) return false; }
            catch { return false; }
        }
        return true;
    }

    /** Internal - hub uses this; do not call from application code. */
    _add(peer)
    {
        this._peers.add(peer);
        peer.room = this;
    }

    /** Internal - hub uses this; do not call from application code. */
    _remove(peer)
    {
        if (!this._peers.has(peer)) return;
        this._peers.delete(peer);
        if (peer.room === this) peer.room = null;
    }

    // -- Fan-out --

    /**
     * Send a `{type, ...payload}` JSON frame to every peer in the room.
     * @param {string} type
     * @param {object} [payload]
     * @param {string} [exceptPeerId] - Optional peer id to skip (e.g. the originator).
     */
    broadcast(type, payload, exceptPeerId)
    {
        for (const p of this._peers)
        {
            if (exceptPeerId && p.id === exceptPeerId) continue;
            p.send(type, payload);
        }
        if (this.hub && this.hub._cluster)
            this.hub._cluster.fanoutRoom(this.name, type, payload, exceptPeerId);
    }

    /** Kick every peer with code 1001 (going-away) and unregister from the hub. */
    close(reason = 'room-closed')
    {
        for (const p of Array.from(this._peers))
        {
            p.send('bye', { reason });
            p.close(1001, reason);
        }
        this._peers.clear();
        if (this.hub) this.hub._removeRoom(this);
    }
}

module.exports = { Room };
