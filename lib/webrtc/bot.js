/**
 * @module webrtc/bot
 * @description Server-side WebRTC peer ("bot") built on the `wrtc`
 *   peerDependency.
 *
 *   `spawnBotPeer({hub, room, ...})` attaches an in-process peer to a
 *   {@link SignalingHub}, joins a room, and drives a real
 *   {@link RTCPeerConnection} per remote peer (using the Node.js `wrtc`
 *   binding).  It implements the standard JSEP perfect-negotiation
 *   pattern and is designed for headless workloads such as recording,
 *   transcription, AI agents, and SFU verification harnesses.
 *
 *   The `wrtc` peerDependency is loaded lazily; in production any of
 *   `wrtc` or `@roamhq/wrtc` is acceptable.  Tests inject a fake via
 *   `opts.wrtc`.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { WebRTCError }  = require('../errors');

/**
 * Spawn a server-side bot peer that joins `room` on the given hub.
 *
 * @param {object} opts
 * @param {object} opts.hub                The {@link SignalingHub} instance.
 * @param {string} opts.room               Room name to join.
 * @param {*}      [opts.user]             Opaque user object attached to the peer.
 * @param {string} [opts.ip='127.0.0.1']   IP recorded on the attached peer.
 * @param {string} [opts.joinToken]        Optional join token forwarded to the hub.
 * @param {Array}  [opts.iceServers=[]]    RTCConfiguration.iceServers.
 * @param {object} [opts.rtcConfig]        Additional RTCConfiguration fields.
 * @param {object} [opts.wrtc]             Injected `wrtc` module (testing).
 * @param {Function} [opts.onTrack]        (track, streams, fromPeerId) => void
 * @param {Function} [opts.onDataChannel]  (channel, fromPeerId) => void
 * @param {Function} [opts.onPeerJoin]     (remotePeerId) => void
 * @param {Function} [opts.onPeerLeave]    (remotePeerId) => void
 * @param {Function} [opts.onError]        (err) => void  (non-fatal errors)
 * @returns {{
 *   peer:               object,
 *   peerConnections:    Map<string, object>,
 *   getPeerConnection: (remotePeerId: string) => object | undefined,
 *   ready:              Promise<{ peerId: string }>,
 *   close:              () => void,
 * }}
 */
function spawnBotPeer(opts)
{
    const o = opts || {};
    if (!o.hub || typeof o.hub.attach !== 'function')
    {
        throw new WebRTCError('spawnBotPeer requires { hub }', { code: 'WEBRTC_BOT_INVALID_CONFIG' });
    }
    if (!o.room || typeof o.room !== 'string')
    {
        throw new WebRTCError('spawnBotPeer requires { room }', { code: 'WEBRTC_BOT_INVALID_CONFIG' });
    }

    const wrtc = o.wrtc || _tryRequireWrtc();
    const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;
    if (typeof RTCPeerConnection !== 'function')
    {
        throw new WebRTCError(
            "spawnBotPeer: provided 'wrtc' module is missing RTCPeerConnection",
            { code: 'WEBRTC_BOT_INVALID_WRTC' },
        );
    }

    const rtcConfig = {
        iceServers: Array.isArray(o.iceServers) ? o.iceServers : [],
        ...(o.rtcConfig || {}),
    };

    const onTrack       = typeof o.onTrack       === 'function' ? o.onTrack       : null;
    const onDataChannel = typeof o.onDataChannel === 'function' ? o.onDataChannel : null;
    const onPeerJoin    = typeof o.onPeerJoin    === 'function' ? o.onPeerJoin    : null;
    const onPeerLeave   = typeof o.onPeerLeave   === 'function' ? o.onPeerLeave   : null;
    const onError       = typeof o.onError       === 'function' ? o.onError       : (() => {});

    // In-process transport that satisfies the hub's contract.
    const transport = new BotTransport();

    const pcs = new Map(); // remotePeerId -> RTCPeerConnection
    let myPeerId = null;
    let closed   = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

    function pushToHub(msg)
    {
        if (closed) return;
        try { transport._inject(msg); }
        catch (err) { onError(err); }
    }

    function getOrCreatePc(remoteId)
    {
        let pc = pcs.get(remoteId);
        if (pc) return pc;
        pc = new RTCPeerConnection(rtcConfig);
        pcs.set(remoteId, pc);

        pc.onicecandidate = (ev) =>
        {
            if (ev && ev.candidate && ev.candidate.candidate)
            {
                pushToHub({
                    type:      'ice',
                    target:    remoteId,
                    candidate: ev.candidate.candidate,
                });
            }
        };
        if (onTrack)
        {
            pc.ontrack = (ev) =>
            {
                try { onTrack(ev.track, ev.streams || [], remoteId); }
                catch (err) { onError(err); }
            };
        }
        if (onDataChannel)
        {
            pc.ondatachannel = (ev) =>
            {
                try { onDataChannel(ev.channel, remoteId); }
                catch (err) { onError(err); }
            };
        }
        return pc;
    }

    async function offerTo(remoteId)
    {
        try
        {
            const pc    = getOrCreatePc(remoteId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            pushToHub({ type: 'offer', target: remoteId, sdp: pc.localDescription.sdp });
        }
        catch (err) { onError(err); }
    }

    async function answerTo(remoteId, sdp)
    {
        try
        {
            const pc = getOrCreatePc(remoteId);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            pushToHub({ type: 'answer', target: remoteId, sdp: pc.localDescription.sdp });
        }
        catch (err) { onError(err); }
    }

    async function applyAnswer(remoteId, sdp)
    {
        try
        {
            const pc = pcs.get(remoteId);
            if (!pc) return;
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        }
        catch (err) { onError(err); }
    }

    async function applyIce(remoteId, candidate)
    {
        try
        {
            const pc = pcs.get(remoteId);
            if (!pc || !candidate) return;
            await pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 }));
        }
        catch (err) { onError(err); }
    }

    function dropPc(remoteId)
    {
        const pc = pcs.get(remoteId);
        if (!pc) return;
        try { pc.close(); } catch (_) { /* noop */ }
        pcs.delete(remoteId);
    }

    // The hub calls `transport.send(json)` for every outbound message.
    // We intercept those, parse them, and drive the negotiation state machine.
    transport._onOutbound = (data) =>
    {
        let msg;
        try { msg = JSON.parse(data); }
        catch (err) { onError(err); return; }

        switch (msg.type)
        {
            case 'hello':
                myPeerId = msg.peerId;
                pushToHub({ type: 'join', room: o.room, token: o.joinToken });
                break;

            case 'joined':
                if (resolveReady)
                {
                    resolveReady({ peerId: myPeerId });
                    resolveReady = null;
                    rejectReady  = null;
                }
                // Existing peers in the room - bot is the newcomer, so it offers first.
                // The hub's `peers` list includes the bot itself; skip self.
                if (Array.isArray(msg.peers))
                {
                    for (const id of msg.peers)
                    {
                        if (id !== myPeerId) offerTo(id);
                    }
                }
                break;

            case 'peer-joined':
                if (onPeerJoin)
                {
                    try { onPeerJoin(msg.id); }
                    catch (err) { onError(err); }
                }
                // New peer joined after us - they are the newcomer and will offer; we wait.
                break;

            case 'peer-left':
                dropPc(msg.id);
                if (onPeerLeave)
                {
                    try { onPeerLeave(msg.id); }
                    catch (err) { onError(err); }
                }
                break;

            case 'offer':
                answerTo(msg.from, msg.sdp);
                break;

            case 'answer':
                applyAnswer(msg.from, msg.sdp);
                break;

            case 'ice':
                applyIce(msg.from, msg.candidate);
                break;

            case 'error':
                if (rejectReady)
                {
                    rejectReady(new WebRTCError(
                        `bot peer error: ${msg.message || msg.code}`,
                        { code: msg.code || 'WEBRTC_BOT_HUB_ERROR' },
                    ));
                    rejectReady  = null;
                    resolveReady = null;
                }
                onError(new WebRTCError(msg.message || msg.code, { code: msg.code || 'WEBRTC_BOT_HUB_ERROR' }));
                break;

            default:
                // Unhandled message types are passed through silently; tests / consumers
                // can subscribe to `peer` events on the hub if they need them.
                break;
        }
    };

    // Attach AFTER the outbound handler is wired so that the synchronous
    // `hello` frame the hub sends inside attach() is delivered to us.
    const peer = o.hub.attach(transport, { user: o.user || null, ip: o.ip || '127.0.0.1' });

    function close()
    {
        if (closed) return;
        closed = true;
        for (const id of Array.from(pcs.keys())) dropPc(id);
        try { transport.close(1000, 'bot-close'); } catch (_) { /* noop */ }
        if (rejectReady)
        {
            rejectReady(new WebRTCError('bot peer closed before ready', { code: 'WEBRTC_BOT_CLOSED' }));
            rejectReady  = null;
            resolveReady = null;
        }
    }

    return {
        peer,
        peerConnections: pcs,
        getPeerConnection: (remoteId) => pcs.get(remoteId),
        ready,
        close,
    };
}

/**
 * @private
 * In-process transport that bridges the hub <-> bot peer.
 *
 *   The hub calls `send(string)` for every outbound message; the bot
 *   sets `_onOutbound` to receive those messages.  The bot uses
 *   `_inject(obj)` to push inbound messages back to the hub (which
 *   listens via the standard `'message'` event).
 */
class BotTransport extends EventEmitter
{
    constructor()
    {
        super();
        this.closed       = false;
        this._onOutbound  = null;
    }

    send(data)
    {
        if (this.closed) return;
        if (typeof this._onOutbound === 'function')
        {
            try { this._onOutbound(data); }
            catch (_) { /* swallow */ }
        }
    }

    _inject(obj)
    {
        if (this.closed) return;
        const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
        this.emit('message', data);
    }

    close(code, reason)
    {
        if (this.closed) return;
        this.closed = true;
        this.emit('close', code || 1000, reason || '');
    }
}

/**
 * @private
 * Try to `require('wrtc')` then `require('@roamhq/wrtc')`.
 * Throws a clean `WEBRTC_BOT_NOT_INSTALLED` error if neither is present.
 */
function _tryRequireWrtc()
{
    const tried = [];
    for (const name of ['wrtc', '@roamhq/wrtc'])
    {
        try { return require(name); }
        catch (err) { tried.push(`${name} (${err.code || err.message})`); }
    }
    throw new WebRTCError(
        `spawnBotPeer requires the 'wrtc' (or '@roamhq/wrtc') peerDependency: npm install wrtc - tried: ${tried.join(', ')}`,
        { code: 'WEBRTC_BOT_NOT_INSTALLED' },
    );
}

module.exports = { spawnBotPeer };
