/**
 * @module @zero-server/webrtc
 * @description First-class WebRTC support for Zero Server.
 *
 *   Signaling hub, room / peer orchestration, RFC 8489 STUN client,
 *   RFC 7635 TURN credential issuance, optional embedded TURN server,
 *   SFrame E2EE key relay, and a pluggable SFU adapter interface.
 *
 *   Implementation is landing PR-by-PR per `.myshit/WEBRTC-ROADMAP.md`.
 *   Real exports already live in this barrel; the rest throw
 *   `WEBRTC_NOT_IMPLEMENTED` so accidental production use fails loud.
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
 * Sentinel for surfaces that have not yet been implemented.  Each PR in the
 * roadmap replaces one of these with a real function/class export.
 */
const notImplemented = (name) =>
{
    throw new WebRTCError(
        `${name} is not implemented yet - see .myshit/WEBRTC-ROADMAP.md for the implementation plan.`,
        { code: 'WEBRTC_NOT_IMPLEMENTED' },
    );
};

module.exports = {
    // Signaling - landing in a later PR
    createWebRTC:          () => notImplemented('createWebRTC'),
    SignalingHub,
    Room,
    Peer,
    PEER_STATE,

    // SDP - PR 1
    parseSdp,
    stringifySdp,

    // ICE - PR 1
    parseCandidate,
    stringifyCandidate,
    filterCandidates,
    isPrivateIp,
    isLoopbackIp,
    isLinkLocalIp,
    isMdnsHostname,
    CANDIDATE_TYPES,
    TCP_TYPES,

    // NAT traversal - later PRs
    stunBinding,
    encodeBindingRequest,
    decodeMessage,
    encodeXorMappedAddress,
    decodeXorMappedAddress,
    STUN_MAGIC_COOKIE,
    STUN_METHOD,
    STUN_CLASS,
    STUN_ATTR,
    issueTurnCredentials,
    TurnServer,

    // SFU + tokens - later PRs
    SfuAdapter,
    MemorySfuAdapter,
    MediasoupSfuAdapter,
    LiveKitSfuAdapter,
    loadSfuAdapter,
    signJoinToken,
    verifyJoinToken,

    // Server-side WebRTC peer (wrtc bot)
    spawnBotPeer,

    // Observability - PR 6
    bindObservability,

    // E2EE key relay - PR 7
    E2eeChannel,
    attachE2ee,
    generateE2eeKeyPair,
    sealKey,
    openSealedKey,

    // Cluster - PR 8
    useCluster,
    ClusterCoordinator,
    MemoryClusterAdapter,

    // CLI
    runWebRTCCommand,

    // Errors (re-exported from lib/errors.js so consumers can `instanceof` them
    // through @zero-server/webrtc without also requiring @zero-server/errors).
    WebRTCError, SignalingError, IceError, TurnError, SdpError,
};
