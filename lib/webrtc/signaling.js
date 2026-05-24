/**
 * @module webrtc/signaling
 * @description WebRTC signaling hub. Central WS broker that owns the room
 *   registry, attaches peers, validates JSEP messages, and routes
 *   offer / answer / ICE traffic. Transport-agnostic — bind to `app.ws()`
 *   in production, an `EventEmitter` shim in tests.
 *
 *   SDP validation is cross-browser by design: session-level
 *   `a=fingerprint` / `a=ice-ufrag` / `a=ice-pwd` lines are accepted as a
 *   fallback for media sections that omit their own copy (RFC 8839 §5.4,
 *   RFC 8122 §5). This is required for Firefox interop — Firefox emits
 *   `a=fingerprint` only at session level.
 *
 * @example | Bind a hub to an `app.ws()` route with all production knobs
 *   const app = createApp();
 *   const hub = new SignalingHub({
 *       joinTokenSecret:        process.env.WEBRTC_JWT_SECRET,
 *       maxSdpSize:             64 * 1024,
 *       maxCandidatesPerOffer:  20,
 *       peerMessageRate:        30,
 *       maxProtocolErrors:      5,
 *       ipAttachRate:           60,
 *       originAllowlist:        ['https://meet.acme.com'],
 *       autoCreateRooms:        false,
 *   });
 *
 *   hub.room('lobby').open();
 *
 *   app.ws('/rtc', (ws, req) => {
 *       hub.attach(ws, {
 *           user:   req.user,
 *           ip:     req.ip,
 *           origin: req.headers.origin,
 *       });
 *   });
 *
 * @example | Observe lifecycle events
 *   hub.on('join',      ({ peer, room }) => log.info({ peer: peer.id, room: room.name }, 'joined'));
 *   hub.on('leave',     ({ peer, room }) => log.info({ peer: peer.id, room: room.name }, 'left'));
 *   hub.on('wireError', ({ peer, code })  => log.warn({ peer: peer.id, code }, 'wire-error'));
 */

'use strict';

const { EventEmitter } = require('node:events');

const { SignalingError, SdpError, IceError } = require('../errors');
const { parseSdp } = require('./sdp');
const { parseCandidate } = require('./ice');
const { Peer, PEER_STATE } = require('./peer');
const { Room } = require('./room');
const { verifyJoinToken } = require('./joinToken');
const { loadSfuAdapter } = require('./sfu');

// --- Constants ---

/** Default hard cap on incoming SDP size, in bytes. */
const DEFAULT_MAX_SDP_BYTES = 64 * 1024;

/** Default hard cap on `a=candidate:` lines per SDP. */
const DEFAULT_MAX_CANDIDATES = 30;

/** Default per-peer signaling message rate, msg/sec. */
const DEFAULT_PEER_MSG_RATE = 30;

/** Default max protocol errors (BAD_FRAME / UNKNOWN_TYPE) before disconnect. */
const DEFAULT_MAX_PROTOCOL_ERRORS = 5;

/** Default rolling window (sec) for the per-IP attach rate limit. */
const IP_ATTACH_WINDOW_SEC = 60;

/** Allowed values for the room topology hint. */
const VALID_TOPOLOGIES = new Set(['mesh', 'sfu', 'mcu', 'auto']);

/**
 * Default peer count at which an `auto` room is promoted from full mesh
 * to SFU. Past this count an N-peer mesh costs O(N²) uplink and quickly
 * saturates mobile radios; standard guidance (bloggeek.me, Jitsi, Daily)
 * is to break the mesh between 4 and 6 participants.
 */
const DEFAULT_MAX_MESH_PEERS = 4;

/** Set of message `type`s the hub will dispatch. */
const VALID_TYPES = new Set([
    'join', 'leave', 'offer', 'answer', 'ice',
    'mute', 'unmute', 'bye', 'e2ee-key',
]);

// --- Helpers ---

/** Count `a=candidate:` lines in a raw SDP blob without re-parsing. */
function _countCandidatesInSdp(sdp)
{
    let n = 0;
    const re = /^a=candidate:/gm;
    while (re.exec(sdp) !== null) n++;
    return n;
}

/**
 * Validate that an SDP has the required RFC 8829 attributes on every media
 * section and uses DTLS-SRTP transport.  Returns an error code string, or
 * `null` if the SDP is acceptable.
 *
 * Accepts both RTP/SAVPF audio/video sections (RFC 8829) and SCTP data-channel
 * sections (RFC 8841 m=application ... UDP/DTLS/SCTP). When BUNDLE is in use
 * (every browser since ~2018), only the first m-section is required to carry
 * iceUfrag/icePwd; other bundled sections inherit them via a=group:BUNDLE.
 *
 * Session-level `a=fingerprint`, `a=ice-ufrag`, and `a=ice-pwd` lines are
 * honoured: per RFC 8839 §5.4 and RFC 8122 §5 they apply to every media
 * section that omits its own copy.  Firefox emits `a=fingerprint` only at
 * session level, so this fallback is required for cross-browser interop.
 */
function _validateSdpStructure(sdp)
{
    let desc;
    try { desc = parseSdp(sdp, { maxBytes: 64 * 1024 }); }
    catch (err)
    {
        if (err instanceof SdpError) return 'INVALID_SDP';
        return 'INVALID_SDP';
    }
    if (!desc.media || desc.media.length === 0) return 'INVALID_SDP';

    // BUNDLE: collect bundled mids so per-section ice credentials are optional
    // on every section except the first (the BUNDLE owner).
    // Also collect session-level fingerprint / ice-ufrag / ice-pwd, which per
    // RFC 8839 §5.4 and RFC 8122 §5 apply to every media section that omits
    // its own copy (Firefox emits fingerprint only at session level).
    const bundleMids = new Set();
    let sessFingerprint = null, sessIceUfrag = null, sessIcePwd = null;
    for (const a of desc.attributes || [])
    {
        if (a.key === 'group')
        {
            const parts = String(a.value || '').split(/\s+/);
            if (parts[0] === 'BUNDLE')
                for (let i = 1; i < parts.length; i++) bundleMids.add(parts[i]);
        }
        else if (a.key === 'fingerprint' && a.value) sessFingerprint = a.value;
        else if (a.key === 'ice-ufrag'   && a.value) sessIceUfrag   = a.value;
        else if (a.key === 'ice-pwd'     && a.value) sessIcePwd     = a.value;
    }

    let firstBundleMid = null;
    for (const m of desc.media)
    {
        if (typeof m.proto !== 'string') return 'INVALID_SDP';

        // RTP audio/video (RFC 8829) OR SCTP data channels (RFC 8841).
        const isRtp  = /^UDP\/TLS\/RTP\/SAVPF?$/i.test(m.proto);
        const isSctp = /^(UDP|TCP)\/DTLS\/SCTP$/i.test(m.proto);
        if (!isRtp && !isSctp) return 'INVALID_SDP';

        const fp    = m.fingerprint || sessFingerprint;
        const ufrag = m.iceUfrag    || sessIceUfrag;
        const pwd   = m.icePwd      || sessIcePwd;

        if (!fp) return 'INVALID_SDP';

        // ice-ufrag / ice-pwd: required on the BUNDLE owner; optional on
        // every other bundled section (inherited per RFC 8843 §9.2).
        const bundled = m.mid && bundleMids.has(m.mid);
        if (bundled && firstBundleMid === null) firstBundleMid = m.mid;
        const isBundleOwner = !bundled || m.mid === firstBundleMid;
        if (isBundleOwner && (!ufrag || !pwd)) return 'INVALID_SDP';
    }
    return null;
}

// --- SignalingHub ---

/**
 * Central WebRTC signaling broker.  Owns rooms, attaches peers, validates
 * JSEP traffic, and emits `join` / `leave` / `error` lifecycle events.
 *
 * Interop: SDP validation accepts session-level `a=fingerprint`,
 * `a=ice-ufrag`, and `a=ice-pwd` as a fallback when a media section omits
 * them (RFC 8839 §5.4 / RFC 8122 §5). Required for Firefox.
 *
 * @class
 * @section Signaling
 *
 * @example | Minimal in-memory use (no WS layer)
 *   const { SignalingHub } = require('@zero-server/webrtc');
 *   const hub = new SignalingHub();
 *   hub.room('lobby').open();
 *   const peer = hub.attach(myWsConnection, { user: req.user, ip: req.ip });
 *
 * @example | Policy-gated room
 *   hub.room('boardroom')
 *       .require(p => p.user && p.user.role === 'exec')
 *       .canPublish(p => p.user.isHost);
 */
class SignalingHub extends EventEmitter
{
    /**
     * @constructor
     * @param {object} [opts]
     * @param {number}  [opts.maxSdpSize=65536]         - Hard cap on offer / answer size (bytes).
     * @param {number}  [opts.maxCandidatesPerOffer=30] - Hard cap on `a=candidate:` lines per SDP.
     * @param {number}  [opts.peerMessageRate=30]       - Per-peer signaling message rate, msg / sec.
     * @param {number}  [opts.maxProtocolErrors=5]      - Disconnect after this many malformed frames.
     * @param {number}  [opts.ipAttachRate=0]           - Max attaches per IP per minute.  `0` disables.
     * @param {string[]} [opts.originAllowlist]         - If set, transports whose `info.origin` is not
     *                                                    on this list are rejected at attach time.
     * @param {string|Buffer} [opts.joinTokenSecret]    - If set, every `join` must include a valid
     *                                                    JWT signed with this secret and audience `room:<name>`.
     * @param {boolean} [opts.autoCreateRooms=true]     - If false, joins targeting an unknown room are rejected.
     * @param {'mesh'|'sfu'|'mcu'|'auto'} [opts.topology='auto'] - Default room topology. `auto` starts every room
     *                                                    as full mesh and promotes to `sfu` once the peer count
     *                                                    exceeds `maxMeshPeers`. Pure signaling is unchanged;
     *                                                    the hint is broadcast to peers and surfaced via
     *                                                    `hub.stats()` so clients can switch transports.
     * @param {number} [opts.maxMeshPeers=4]            - Peer count at which an `auto` room is promoted from
     *                                                    mesh to SFU (and at which a `mesh` room emits
     *                                                    `peer:limit:reached` for capacity alarms).
     * @param {SfuAdapter|string} [opts.sfu]            - Optional SFU adapter or spec string (memory|mediasoup|livekit|<pkg>).
     *                                                    Mounts a `hub.media` facade backed by this adapter so
     *                                                    application code can drive routers/transports/producers
     *                                                    through the hub without importing the adapter directly.
     * @param {object} [opts.sfuOpts]                   - Adapter constructor options, forwarded when `opts.sfu` is a string.
     */
    constructor(opts = {})
    {
        super();

        /** @type {number} */
        this.maxSdpSize = opts.maxSdpSize ?? DEFAULT_MAX_SDP_BYTES;

        /** @type {number} */
        this.maxCandidatesPerOffer = opts.maxCandidatesPerOffer ?? DEFAULT_MAX_CANDIDATES;

        /** @type {number} */
        this.peerMessageRate = opts.peerMessageRate ?? DEFAULT_PEER_MSG_RATE;

        /** @type {number} */
        this.maxProtocolErrors = opts.maxProtocolErrors ?? DEFAULT_MAX_PROTOCOL_ERRORS;

        /** @type {number} 0 disables. */
        this.ipAttachRate = Number.isFinite(opts.ipAttachRate) ? opts.ipAttachRate : 0;

        /** @type {Set<string>|null} */
        this.originAllowlist = Array.isArray(opts.originAllowlist) && opts.originAllowlist.length > 0
            ? new Set(opts.originAllowlist)
            : null;

        /** @type {string|Buffer|null} */
        this.joinTokenSecret = opts.joinTokenSecret || null;

        /** @type {boolean} */
        this.autoCreateRooms = opts.autoCreateRooms !== false;

        /** @type {'mesh'|'sfu'|'mcu'|'auto'} */
        if (opts.topology != null && !VALID_TOPOLOGIES.has(opts.topology))
        {
            throw new SignalingError(
                `invalid topology "${opts.topology}" (expected mesh|sfu|mcu|auto)`,
                { code: 'WEBRTC_INVALID_TOPOLOGY' },
            );
        }
        this.defaultTopology = opts.topology || 'auto';

        /** @type {number} */
        this.maxMeshPeers = Number.isFinite(opts.maxMeshPeers) && opts.maxMeshPeers > 0
            ? Math.floor(opts.maxMeshPeers)
            : DEFAULT_MAX_MESH_PEERS;

        /** @type {Map<string, Room>} */
        this._rooms = new Map();

        /** @type {Map<string, Peer>} */
        this._peers = new Map();

        /** @type {Map<string, number[]>} peer.id -> sliding window of message timestamps (ms). */
        this._rate = new Map();

        /** @type {Map<string, number[]>} ip -> attach timestamps in the rolling window. */
        this._ipAttachLog = new Map();

        // -- Optional media plane (SFU adapter facade) --
        /** @type {import('./sfu').SfuAdapter|null} */
        this.sfu = null;
        if (opts.sfu)
        {
            this.sfu = (typeof opts.sfu === 'string' || (opts.sfu && typeof opts.sfu === 'object' && typeof opts.sfu.createRouter !== 'function'))
                ? loadSfuAdapter(opts.sfu, opts.sfuOpts)
                : loadSfuAdapter(opts.sfu);
        }

        /**
         * Media-plane facade. Always present so application code can write
         * `hub.media.createRouter(...)` regardless of whether an adapter is
         * mounted; calls without an adapter throw `WEBRTC_SFU_NOT_CONFIGURED`.
         */
        this.media = _buildMediaFacade(this);
    }

    // -- Public surface --

    /** Live peer count across all rooms (and unattached). */
    get size() { return this._peers.size; }

    /**
     * Get or lazily create a room.
     * @param {string} name
     * @returns {Room}
     */
    room(name)
    {
        if (typeof name !== 'string' || name.length === 0)
            throw new SignalingError('Hub.room: name must be a non-empty string');
        let r = this._rooms.get(name);
        if (!r)
        {
            r = new Room(name, { hub: this });
            // Apply the hub's default topology preference; `auto` rooms start
            // as mesh and are promoted in _onRoomMembershipChange().
            r.topologyMode = this.defaultTopology;
            r.topology     = this.defaultTopology === 'auto' ? 'mesh' : this.defaultTopology;
            this._rooms.set(name, r);
        }
        return r;
    }

    /** @returns {Room[]} */
    rooms() { return Array.from(this._rooms.values()); }

    /**
     * Attach a transport (WS connection or mock) as a new signaling peer.
     * Wires up message and close handlers, performs origin / IP-rate
     * pre-checks, sends a `hello` frame with the new peer id, and returns
     * the `Peer`.  The returned peer is also registered in `hub.size`.
     *
     * Called from your `app.ws()` upgrade handler in production:
     *
     * ```js
     * app.ws('/rtc', (ws, req) => hub.attach(ws, {
     *     user:   req.user,
     *     ip:     req.ip,
     *     origin: req.headers.origin,
     * }));
     * ```
     *
     * @param {object} transport - `{ send, on, close }`-shaped object.
     * @param {object} [info]
     * @param {*}      [info.user]   - Authenticated user (forwarded to room gates).
     * @param {string} [info.ip]     - Remote IP for audit + `ipAttachRate`.
     * @param {string} [info.origin] - Origin header for `originAllowlist`.
     * @returns {Peer}
     *
     * @example | Test harness: attach a mock transport
     *   const mock = new EventEmitter();
     *   mock.send  = (frame) => mock.emit('out', frame);
     *   mock.close = ()      => mock.emit('close');
     *   const peer = hub.attach(mock, { user: { id: 'u1' }, ip: '127.0.0.1' });
     *   mock.emit('message', JSON.stringify({ type: 'join', room: 'lobby' }));
     */
    attach(transport, info = {})
    {
        const peer = new Peer(transport, info);
        this._peers.set(peer.id, peer);

        const onMessage = (raw) => this._onMessage(peer, raw);
        const onClose   = () => this._onClose(peer);

        transport.on('message', onMessage);
        transport.on('close',   onClose);

        // -- Origin allowlist --
        if (this.originAllowlist && info.origin && !this.originAllowlist.has(info.origin))
        {
            peer.sendError('ORIGIN_NOT_ALLOWED', 'origin not on allowlist');
            peer.close(1008, 'origin-not-allowed');
            return peer;
        }

        // -- Per-IP attach rate limit --
        if (this.ipAttachRate > 0 && peer.ip && !this._allowIpAttach(peer.ip))
        {
            peer.sendError('IP_RATE_LIMITED', 'too many connections from this address');
            peer.close(1008, 'ip-rate-limited');
            return peer;
        }

        peer.send('hello', { peerId: peer.id });
        return peer;
    }

    /** Shut down every peer and clear every room. */
    close()
    {
        for (const peer of Array.from(this._peers.values()))
        {
            peer.close(1001, 'hub-closed');
        }
        this._peers.clear();
        this._rate.clear();
        for (const room of Array.from(this._rooms.values()))
            room._peers.clear();
        this._rooms.clear();
    }

    /** Internal: room.close() calls this so the registry stays consistent. */
    _removeRoom(room)
    {
        if (this._rooms.get(room.name) === room) this._rooms.delete(room.name);
    }

    // -- Wire dispatch --

    /**
     * Handle one inbound frame from a peer's transport.
     * @private
     */
    _onMessage(peer, raw)
    {
        if (peer.closed) return;

        // Rate limit
        if (!this._allowRate(peer))
        {
            peer.sendError('RATE_LIMITED', 'too many signaling messages');
            peer.close(1008, 'rate-limited');
            return;
        }

        const text = typeof raw === 'string' ? raw : (raw && raw.toString ? raw.toString('utf8') : String(raw));
        let msg;
        try { msg = JSON.parse(text); }
        catch
        {
            peer.errors++;
            peer.sendError('BAD_FRAME', 'malformed JSON');
            this.emit('wireError', { peer, code: 'BAD_FRAME' });
            this._checkErrorBackoff(peer);
            return;
        }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string')
        {
            peer.errors++;
            peer.sendError('BAD_FRAME', 'missing message type');
            this._checkErrorBackoff(peer);
            return;
        }
        if (!VALID_TYPES.has(msg.type))
        {
            peer.errors++;
            peer.sendError('UNKNOWN_TYPE', `unknown message type "${msg.type}"`);
            this._checkErrorBackoff(peer);
            return;
        }

        try
        {
            this.emit('signal', { peer, type: msg.type, msg });
            switch (msg.type)
            {
                case 'join':    return this._handleJoin(peer, msg);
                case 'leave':   return this._handleLeave(peer);
                case 'offer':
                case 'answer':  return this._handleSdp(peer, msg);
                case 'ice':     return this._handleIce(peer, msg);
                case 'mute':
                case 'unmute':  return this._handleMuteState(peer, msg);
                case 'bye':     return peer.close(1000, 'bye');
                case 'e2ee-key':return this._handleE2eeKey(peer, msg);
            }
        }
        catch (err)
        {
            peer.errors++;
            peer.sendError('INTERNAL', err && err.message ? err.message : 'internal error');
            this.emit('wireError', { peer, code: 'INTERNAL', error: err });
        }
    }

    /** @private */
    _onClose(peer)
    {
        if (!this._peers.has(peer.id)) return;
        const room = peer.room;
        this._peers.delete(peer.id);
        this._rate.delete(peer.id);
        if (room)
        {
            room._remove(peer);
            this.emit('leave', { peer, room });
            // Tell other peers in the room
            room.broadcast('peer-left', { id: peer.id }, peer.id);
        }
        peer.closed = true;
    }

    // -- Handlers --

    /** @private */
    _handleJoin(peer, msg)
    {
        if (typeof msg.room !== 'string' || msg.room.length === 0)
        {
            this.emit('joinFailed', { peer, reason: 'BAD_FRAME' });
            return peer.sendError('BAD_FRAME', 'join.room must be a string');
        }

        if (peer.room)
        {
            this.emit('joinFailed', { peer, reason: 'ALREADY_JOINED', room: peer.room.name });
            return peer.sendError('ALREADY_JOINED', 'peer is already in a room');
        }

        // -- Join-token enforcement --
        if (this.joinTokenSecret)
        {
            if (typeof msg.token !== 'string' || msg.token.length === 0)
            {
                this.emit('joinFailed', { peer, reason: 'TOKEN_REQUIRED', room: msg.room });
                return peer.sendError('TOKEN_REQUIRED', 'join token required');
            }
            let claims;
            try { claims = verifyJoinToken(msg.token, { secret: this.joinTokenSecret, room: msg.room }); }
            catch (err)
            {
                this.emit('joinFailed', { peer, reason: 'INVALID_TOKEN', room: msg.room });
                return peer.sendError('INVALID_TOKEN', err && err.message ? err.message : 'invalid token');
            }
            // Token's user claim wins when the transport didn't already authenticate one.
            if (!peer.user && claims && claims.user) peer.user = claims.user;
        }

        let room = this._rooms.get(msg.room);
        if (!room)
        {
            if (!this.autoCreateRooms)
            {
                this.emit('joinFailed', { peer, reason: 'UNKNOWN_ROOM', room: msg.room });
                return peer.sendError('UNKNOWN_ROOM', `no such room "${msg.room}"`);
            }
            room = this.room(msg.room).open();
        }

        if (!room.canJoin(peer))
        {
            this.emit('joinFailed', { peer, reason: 'FORBIDDEN', room: room.name });
            return peer.sendError('FORBIDDEN', `not allowed to join "${room.name}"`);
        }

        room._add(peer);
        peer.send('joined', {
            room:     room.name,
            peerId:   peer.id,
            peers:    room.peers().map(p => p.id),
            topology: room.topology,
        });
        room.broadcast('peer-joined', { id: peer.id }, peer.id);
        this.emit('join', { peer, room });
    }

    /** @private */
    _handleLeave(peer)
    {
        const room = peer.room;
        if (!room) return;
        room._remove(peer);
        peer.send('left', { room: room.name });
        room.broadcast('peer-left', { id: peer.id }, peer.id);
        this.emit('leave', { peer, room });
    }

    /** @private */
    _handleSdp(peer, msg)
    {
        if (typeof msg.sdp !== 'string')
            return peer.sendError('BAD_FRAME', `${msg.type}.sdp must be a string`);
        if (msg.sdp.length > this.maxSdpSize)
            return peer.sendError('SDP_TOO_LARGE', `sdp exceeds ${this.maxSdpSize} bytes`);

        const structErr = _validateSdpStructure(msg.sdp);
        if (structErr) return peer.sendError(structErr, 'sdp failed validation');

        if (_countCandidatesInSdp(msg.sdp) > this.maxCandidatesPerOffer)
            return peer.sendError('TOO_MANY_CANDIDATES', `>${this.maxCandidatesPerOffer} candidates`);

        if (!peer.room)
            return peer.sendError('NOT_IN_ROOM', 'peer must join a room first');

        if (typeof msg.target !== 'string')
            return peer.sendError('BAD_FRAME', `${msg.type}.target must be a string`);

        const target = this._peers.get(msg.target);
        const remote = (!target && this._cluster) ? this._cluster.locate(msg.target) : null;
        const targetRoomName = target ? (target.room && target.room.name) : (remote ? remote.room : null);
        if (!targetRoomName || targetRoomName !== peer.room.name)
            return peer.sendError('TARGET_NOT_IN_ROOM', `peer "${msg.target}" not in this room`);

        // Publish / subscribe gates
        if (msg.type === 'offer' && peer.room._canPublish && !peer.room._canPublish(peer))
        {
            this.emit('publishFailed', { peer, reason: 'FORBIDDEN', room: peer.room.name });
            return peer.sendError('FORBIDDEN', 'peer may not publish');
        }
        if (msg.type === 'answer' && peer.room._canSubscribe && !peer.room._canSubscribe(peer))
        {
            this.emit('subscribeFailed', { peer, reason: 'FORBIDDEN', room: peer.room.name });
            return peer.sendError('FORBIDDEN', 'peer may not subscribe');
        }

        // Advance JSEP state machine
        if (msg.type === 'offer')
        {
            peer.state = PEER_STATE.HAVE_LOCAL_OFFER;
            if (target) target.state = PEER_STATE.HAVE_REMOTE_OFFER;
        }
        else // answer
        {
            peer.state = PEER_STATE.STABLE;
            if (target) target.state = PEER_STATE.STABLE;
        }

        if (target)
            target.send(msg.type, { from: peer.id, sdp: msg.sdp });
        else
            this._cluster.routeDirect(msg.target, msg.type, { from: peer.id, sdp: msg.sdp });
        this.emit(msg.type, { peer, target: target || null, room: peer.room, sdp: msg.sdp });
    }

    /** @private */
    _handleIce(peer, msg)
    {
        if (typeof msg.candidate !== 'string' || msg.candidate.length === 0)
            return peer.sendError('BAD_FRAME', 'ice.candidate must be a non-empty string');

        // Validate candidate.  parseCandidate expects the wire form with or without "a=" prefix.
        const line = msg.candidate.startsWith('candidate:') ? msg.candidate : ('candidate:' + msg.candidate.replace(/^a=candidate:/, ''));
        try { parseCandidate(line); }
        catch (err)
        {
            if (err instanceof IceError) return peer.sendError('INVALID_ICE', err.message);
            return peer.sendError('INVALID_ICE', 'malformed candidate');
        }

        if (!peer.room) return peer.sendError('NOT_IN_ROOM', 'peer must join a room first');
        if (typeof msg.target !== 'string') return peer.sendError('BAD_FRAME', 'ice.target must be a string');

        const target = this._peers.get(msg.target);
        const remote = (!target && this._cluster) ? this._cluster.locate(msg.target) : null;
        const targetRoomName = target ? (target.room && target.room.name) : (remote ? remote.room : null);
        if (!targetRoomName || targetRoomName !== peer.room.name)
            return peer.sendError('TARGET_NOT_IN_ROOM', `peer "${msg.target}" not in this room`);

        if (target)
            target.send('ice', { from: peer.id, candidate: msg.candidate });
        else
            this._cluster.routeDirect(msg.target, 'ice', { from: peer.id, candidate: msg.candidate });
    }

    /** @private */
    _handleMuteState(peer, msg)
    {
        if (!peer.room) return peer.sendError('NOT_IN_ROOM', 'peer must join a room first');
        const kind = msg.kind === 'video' ? 'video' : 'audio';
        peer.room.broadcast(msg.type, { from: peer.id, kind }, peer.id);
    }

    /** @private */
    _handleE2eeKey(peer, msg)
    {
        if (!peer.room) return peer.sendError('NOT_IN_ROOM', 'peer must join a room first');
        if (typeof msg.epoch !== 'number' || typeof msg.key !== 'string')
            return peer.sendError('BAD_FRAME', 'e2ee-key requires {epoch:number, key:string}');
        peer.room.broadcast('e2ee-key', { from: peer.id, epoch: msg.epoch, key: msg.key }, peer.id);
        this.emit('e2eeKey', { peer, room: peer.room, epoch: msg.epoch, key: msg.key });
    }

    // -- Rate limiter --

    /** @private */
    _allowRate(peer)
    {
        const now = Date.now();
        const win = this._rate.get(peer.id) || [];
        // Drop entries older than 1 s
        while (win.length && (now - win[0]) > 1000) win.shift();
        win.push(now);
        this._rate.set(peer.id, win);
        return win.length <= this.peerMessageRate;
    }

    /** @private Per-IP attach throttle. */
    _allowIpAttach(ip)
    {
        const now = Date.now();
        const win = this._ipAttachLog.get(ip) || [];
        const cutoff = now - (IP_ATTACH_WINDOW_SEC * 1000);
        while (win.length && win[0] < cutoff) win.shift();
        win.push(now);
        this._ipAttachLog.set(ip, win);
        return win.length <= this.ipAttachRate;
    }

    /** @private Disconnect a peer that has exceeded the protocol-error budget. */
    _checkErrorBackoff(peer)
    {
        if (this.maxProtocolErrors > 0 && peer.errors >= this.maxProtocolErrors)
        {
            peer.sendError('TOO_MANY_ERRORS', 'protocol-error budget exhausted');
            peer.close(1008, 'too-many-errors');
        }
    }

    // -- Topology / capacity --

    /**
     * Internal callback fired by `Room#_add` / `Room#_remove`.  Drives
     * auto-promotion (`mesh` → `sfu`) and capacity alarms for fixed-mesh
     * rooms.  Pure signaling: media transports do not move; the hub only
     * advertises the new topology to peers so client SDKs can switch.
     * @private
     */
    _onRoomMembershipChange(room, action, peer)
    {
        const size = room.size;
        if (action === 'add' && size === this.maxMeshPeers + 1)
        {
            // Crossed the mesh limit.
            this.emit('peer:limit:reached', { room, size, limit: this.maxMeshPeers });
            if (room.topologyMode === 'auto' && room.topology === 'mesh')
            {
                room.setTopology('sfu');
                this.emit('topology:promoted', { room, from: 'mesh', to: 'sfu', size });
            }
        }
        else if (action === 'remove' && size === this.maxMeshPeers
            && room.topologyMode === 'auto' && room.topology === 'sfu')
        {
            // Demote back to mesh if the room drops to / below the limit.
            room.setTopology('mesh');
            this.emit('topology:demoted', { room, from: 'sfu', to: 'mesh', size });
        }
    }

    /**
     * Snapshot of hub state for dashboards and health checks. Includes
     * the configured topology defaults, current peer/room counts, and a
     * coarse media-plane summary when an SFU adapter is mounted.
     * @returns {Promise<{topology:string, maxMeshPeers:number, peers:number, rooms:object[], mediaPlane:object|null}>}
     */
    async stats()
    {
        const rooms = [];
        for (const r of this._rooms.values())
        {
            rooms.push({
                name:         r.name,
                size:         r.size,
                topology:     r.topology,
                topologyMode: r.topologyMode,
            });
        }
        let mediaPlane = null;
        if (this.sfu)
        {
            try { mediaPlane = await this.sfu.stats(); }
            catch (err) { mediaPlane = { error: err && err.message }; }
        }
        return {
            topology:     this.defaultTopology,
            maxMeshPeers: this.maxMeshPeers,
            peers:        this._peers.size,
            rooms,
            mediaPlane,
        };
    }
}

// -- Media-plane facade --

/**
 * @private
 * Build the `hub.media` proxy. Every adapter method on `SfuAdapter` is
 * exposed; calls without a mounted adapter throw
 * `WEBRTC_SFU_NOT_CONFIGURED` so misconfiguration is loud.
 */
function _buildMediaFacade(hub)
{
    const proxiedMethods = [
        'createRouter', 'createTransport', 'produce', 'consume',
        'pauseProducer', 'resumeProducer', 'closeRouter', 'stats',
        'setConsumerPreferredLayers', 'setConsumerPriority', 'requestKeyFrame',
        'pauseConsumer', 'resumeConsumer', 'setTransportBitrates',
        'produceData', 'consumeData',
        'observeAudioLevels', 'observeActiveSpeaker', 'pipeToRouter',
        'getProducerStats', 'getConsumerStats', 'getTransportStats',
        'enableTraceEvent',
    ];
    const facade = {
        get adapter() { return hub.sfu; },
        get configured() { return !!hub.sfu; },
        onEvent(fn)
        {
            if (!hub.sfu)
                throw new SignalingError('hub.media is not configured; pass `sfu` to SignalingHub or call useSfu()',
                    { code: 'WEBRTC_SFU_NOT_CONFIGURED' });
            return hub.sfu.onEvent(fn);
        },
    };
    for (const name of proxiedMethods)
    {
        facade[name] = async (...args) =>
        {
            if (!hub.sfu)
                throw new SignalingError('hub.media is not configured; pass `sfu` to SignalingHub or call useSfu()',
                    { code: 'WEBRTC_SFU_NOT_CONFIGURED' });
            return hub.sfu[name](...args);
        };
    }
    return facade;
}

module.exports = { SignalingHub, Room, Peer, PEER_STATE };
