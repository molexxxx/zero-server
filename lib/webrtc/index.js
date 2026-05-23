/**
 * @module @zero-server/webrtc
 * @description First-class, batteries-included WebRTC support for Zero Server.
 *
 *   `@zero-server/webrtc` is a complete signaling + NAT-traversal toolkit you
 *   can drop into any Zero Server app.  Everything is pure JavaScript with
 *   zero hard dependencies — bring your own media engine (`wrtc`, browsers,
 *   `mediasoup`, LiveKit, ...) and the library handles the rest.
 *
 *   Surface area:
 *
 *   - **Signaling** — {@link SignalingHub}, {@link Room}, {@link Peer}.  A
 *     transport-agnostic WS broker that owns the room registry, validates
 *     JSEP traffic (offer / answer / ICE / `e2ee-key`), enforces per-peer
 *     and per-IP rate limits, supports policy gates (`require()`,
 *     `canPublish()`), and emits lifecycle events.
 *   - **JSEP parsing** — {@link parseSdp}, {@link stringifySdp},
 *     {@link parseCandidate}, {@link stringifyCandidate},
 *     {@link filterCandidates}.  RFC 8866 / 8839 compliant pure-JS codecs.
 *   - **STUN client** — {@link stunBinding} (RFC 5389 / 8489) for public-IP
 *     discovery, plus low-level attribute encoders.
 *   - **TURN** — {@link issueTurnCredentials} (RFC 7635 ephemeral creds) and
 *     a full embedded {@link TurnServer} that speaks STUN/TURN over UDP.
 *   - **Join tokens** — {@link signJoinToken} / {@link verifyJoinToken}: HS256
 *     JWTs scoped to `room:<name>` with publish / subscribe claims.
 *   - **End-to-end encryption** — {@link E2eeChannel}, {@link attachE2ee},
 *     {@link generateE2eeKeyPair}, {@link sealKey}, {@link openSealedKey}.
 *     SFrame-compatible key-relay primitives; the hub never sees media.
 *   - **SFU adapters** — {@link SfuAdapter} interface plus first-party
 *     {@link MemorySfuAdapter} (tests), {@link MediasoupSfuAdapter},
 *     {@link LiveKitSfuAdapter}.  Pluggable via {@link loadSfuAdapter}.
 *   - **Cluster** — {@link useCluster}, {@link ClusterCoordinator}, and the
 *     {@link MemoryClusterAdapter} so multiple hub instances can share a
 *     room registry behind a load balancer.
 *   - **Server-side peer** — {@link spawnBotPeer} for headless recorders,
 *     transcribers, or AI participants using `node-wrtc`.
 *   - **Observability** — {@link bindObservability} wires Prometheus
 *     counters / histograms and structured logs into a hub.
 *   - **CLI** — {@link runWebRTCCommand} powers `zs webrtc:*` for STUN
 *     probes, TURN credential issuance, and join-token sign / verify.
 *
 * @example | Bind a signaling hub to a Zero Server `app.ws()` route
 *   const { createApp } = require('@zero-server/sdk');
 *   const { SignalingHub, bindObservability } = require('@zero-server/webrtc');
 *
 *   const app = createApp();
 *   const hub = new SignalingHub({
 *       joinTokenSecret: process.env.WEBRTC_JWT_SECRET,
 *       ipAttachRate: 60,          // max 60 attaches / IP / min
 *       maxSdpSize: 64 * 1024,
 *   });
 *
 *   bindObservability(hub, { app }); // exposes /metrics for Prometheus
 *
 *   app.ws('/rtc', (ws, req) =>
 *   {
 *       const peer = hub.attach(ws, {
 *           user: req.user,
 *           ip: req.ip,
 *           origin: req.headers.origin,
 *       });
 *       ws.on('close', () => peer.close());
 *   });
 *
 *   app.listen(3000);
 *
 * @example | Issue a join token and a TURN credential to a browser
 *   const {
 *       signJoinToken, issueTurnCredentials,
 *   } = require('@zero-server/webrtc');
 *
 *   app.get('/rtc/session/:room', (req, res) =>
 *   {
 *       const token = signJoinToken({
 *           secret: process.env.WEBRTC_JWT_SECRET,
 *           room: req.params.room,
 *           userId: req.user.id,
 *           publish: req.user.isHost,
 *           ttlSec: 60 * 30,
 *       });
 *       const turn = issueTurnCredentials({
 *           secret: process.env.TURN_SHARED_SECRET,
 *           userId: req.user.id,
 *           ttlSec: 60 * 60,
 *           uris: ['turn:turn.example.com:3478?transport=udp'],
 *       });
 *       res.json({ token, iceServers: turn.iceServers });
 *   });
 */

'use strict';

const {
    WebRTCError, SignalingError, IceError, TurnError, SdpError,
} = require('../errors');

const { parseSdp, stringifySdp } = require('./sdp');
const {
    parseCandidate, stringifyCandidate, filterCandidates,
    isPrivateIp, isLoopbackIp, isLinkLocalIp, isMdnsHostname,
    CANDIDATE_TYPES, TCP_TYPES,
} = require('./ice');
const {
    stunBinding, encodeBindingRequest, decodeMessage,
    encodeXorMappedAddress, decodeXorMappedAddress,
    STUN_MAGIC_COOKIE, STUN_METHOD, STUN_CLASS, STUN_ATTR,
} = require('./stun');
const { issueTurnCredentials } = require('./turn/credentials');
const { TurnServer } = require('./turn/server');
const { SignalingHub, Room, Peer, PEER_STATE } = require('./signaling');
const { signJoinToken, verifyJoinToken } = require('./joinToken');
const { bindObservability } = require('./observe');
const {
    E2eeChannel, attachE2ee,
    generateE2eeKeyPair, sealKey, openSealedKey,
} = require('./e2ee');
const {
    useCluster, ClusterCoordinator, MemoryClusterAdapter,
} = require('./cluster');
const { runWebRTCCommand } = require('./cli');
const { SfuAdapter, loadSfuAdapter } = require('./sfu');
const { MemorySfuAdapter } = require('./sfu/memory');
const { MediasoupSfuAdapter } = require('./sfu/mediasoup');
const { LiveKitSfuAdapter }   = require('./sfu/livekit');
const { spawnBotPeer }        = require('./bot');

/**
 * @private
 * Sentinel for surfaces that are intentionally not exported yet.  Reserved
 * for future top-level shortcuts; current consumers should construct a
 * `SignalingHub` directly and use `bindObservability(hub, { app })`.
 */
const notImplemented = (name) =>
{
    throw new WebRTCError(
        `${name} is not implemented yet - construct \`new SignalingHub(opts)\` directly and wire it via \`app.ws()\`.`,
        { code: 'WEBRTC_NOT_IMPLEMENTED' },
    );
};

module.exports = {
    // Signaling
    createWebRTC:          () => notImplemented('createWebRTC'),
    SignalingHub,
    Room,
    Peer,
    PEER_STATE,

    // SDP / JSEP
    parseSdp,
    stringifySdp,

    // ICE candidate utilities
    parseCandidate,
    stringifyCandidate,
    filterCandidates,
    isPrivateIp,
    isLoopbackIp,
    isLinkLocalIp,
    isMdnsHostname,
    CANDIDATE_TYPES,
    TCP_TYPES,

    // STUN client + low-level codecs
    stunBinding,
    encodeBindingRequest,
    decodeMessage,
    encodeXorMappedAddress,
    decodeXorMappedAddress,
    STUN_MAGIC_COOKIE,
    STUN_METHOD,
    STUN_CLASS,
    STUN_ATTR,

    // TURN
    issueTurnCredentials,
    TurnServer,

    // SFU adapters + tokens
    SfuAdapter,
    MemorySfuAdapter,
    MediasoupSfuAdapter,
    LiveKitSfuAdapter,
    loadSfuAdapter,
    signJoinToken,
    verifyJoinToken,

    // Server-side WebRTC peer (node-wrtc bot)
    spawnBotPeer,

    // Observability
    bindObservability,

    // SFrame E2EE key relay
    E2eeChannel,
    attachE2ee,
    generateE2eeKeyPair,
    sealKey,
    openSealedKey,

    // Cluster coordination
    useCluster,
    ClusterCoordinator,
    MemoryClusterAdapter,

    // CLI
    runWebRTCCommand,

    // Errors (re-exported from lib/errors.js so consumers can `instanceof` them
    // through @zero-server/webrtc without also requiring @zero-server/errors).
    WebRTCError, SignalingError, IceError, TurnError, SdpError,
};
