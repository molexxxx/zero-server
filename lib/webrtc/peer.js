/**
 * @module webrtc/peer
 * @description Per-connection state machine for a WebRTC signaling peer.
 *
 *   A `Peer` wraps a transport object (typically a `WebSocketConnection`
 *   but any duck-typed `{ send, on, close }` works - see the unit tests
 *   for a minimal in-memory transport) and exposes the JSEP message
 *   types as ordinary events.  The hub is responsible for routing.
 */

'use strict';

let _peerCounter = 0;

/**
 * JSEP signaling state strings, matching RFC 8829 §4.1.
 * @enum {string}
 */
const PEER_STATE = Object.freeze({
    STABLE:             'stable',
    HAVE_LOCAL_OFFER:   'have-local-offer',
    HAVE_REMOTE_OFFER:  'have-remote-offer',
});

/**
 * One signaling peer attached to a `SignalingHub` via some transport.
 *
 * @class
 * @section Peers
 *
 * @example
 *   hub.on('join', ({ peer, room }) => {
 *       peer.send('welcome', { roomSize: room.size });
 *       peer.on('mute', ev => audit('mute', peer.id, ev.kind));
 *   });
 */
class Peer
{
    /**
     * @constructor
     * @param {object} transport - Anything with `send(string)`, `on('message'|'close', cb)`, `close(code?, reason?)`.
     * @param {object} [info]    - Connection metadata.
     * @param {*}      [info.user] - Authenticated user object (if any).
     * @param {string} [info.ip]   - Remote IP for audit / rate limits.
     */
    constructor(transport, info = {})
    {
        /** @type {string} Globally-unique peer id within a hub. */
        this.id = 'peer_' + (++_peerCounter) + '_' + Date.now().toString(36);

        /** @type {*} Authenticated user object (if any). */
        this.user = info.user || null;

        /** @type {string|null} Remote IP for audit / rate limits. */
        this.ip = info.ip || null;

        /** @type {object} Underlying transport (WS connection or mock). */
        this.transport = transport;

        /** @type {string} Current JSEP state. */
        this.state = PEER_STATE.STABLE;

        /** @type {import('./room')|null} Current room membership. */
        this.room = null;

        /** @type {number} Count of malformed frames received - rate-limit material. */
        this.errors = 0;

        /** @type {number} ms timestamp the peer was created. */
        this.connectedAt = Date.now();

        /** @type {boolean} */
        this.closed = false;
    }

    /**
     * Send a JSON envelope to this peer.  `type` is added to `payload` and
     * the result is serialised once.  Silently drops sends after close.
     * @param {string} type
     * @param {object} [payload]
     */
    send(type, payload)
    {
        if (this.closed) return;
        const frame = Object.assign({ type }, payload || {});
        try { this.transport.send(JSON.stringify(frame)); }
        catch { /* transport may already be closed; ignore */ }
    }

    /**
     * Send a typed error frame.  Callers SHOULD use this rather than throwing,
     * because exceptions escape the message handler and tear down the process.
     * @param {string} code
     * @param {string} message
     */
    sendError(code, message)
    {
        this.send('error', { code, message });
    }

    /**
     * Close the underlying transport with a WebSocket-style code and reason.
     * Defaults to 1000 (normal closure).
     * @param {number} [code=1000]
     * @param {string} [reason='']
     */
    close(code = 1000, reason = '')
    {
        if (this.closed) return;
        this.closed = true;
        try { this.transport.close(code, reason); }
        catch { /* already closed */ }
    }
}

module.exports = { Peer, PEER_STATE };
