/**
 * TypeScript surface for @zero-server/webrtc.
 *
 * Mirrors the runtime surface exported from `lib/webrtc/index.js` and
 * re-exported from the top-level SDK in `index.js`.  Every entry listed
 * in `.tools/scope-manifest.js` under the `webrtc` scope MUST have a
 * matching declaration here - this is enforced by
 * `test/packages/webrtc-types.test.js`.
 */

import type { EventEmitter } from 'node:events';
import type { KeyObject } from 'node:crypto';

// ---------------------------------------------------------------------------
//  Shared option / config types
// ---------------------------------------------------------------------------

export interface IceServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface TurnCredentials {
    urls: string[];
    username: string;
    credential: string;
    ttl: number;
}

export interface IssueTurnCredentialsOptions {
    secret: string;
    userId: string;
    ttl?: string | number;
    servers: string[];
    realm?: string;
}

export interface SignalingHubOptions {
    maxSdpSize?: number;
    maxCandidatesPerOffer?: number;
    peerMessageRate?: number;
    maxProtocolErrors?: number;
    ipAttachRate?: number;
    originAllowlist?: string[];
    joinTokenSecret?: string | Buffer;
    autoCreateRooms?: boolean;
    topology?: 'mesh' | 'sfu' | 'mcu' | 'auto';
    maxMeshPeers?: number;
    sfu?: SfuAdapter | 'memory' | 'mediasoup' | 'livekit' | string;
    sfuOpts?: Record<string, unknown>;
}

export interface WebRTCOptions extends SignalingHubOptions {
    path?: string;
    iceServers?: IceServerConfig[] | 'auto';
    metrics?: unknown;
    tracer?: unknown;
}

export interface PeerAttachInfo {
    user?: unknown;
    ip?: string;
    origin?: string;
    [extra: string]: unknown;
}

export interface PeerTransport {
    send(data: string): void;
    on(event: 'message' | 'close', cb: (...args: unknown[]) => void): void;
    close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------
//  SDP / ICE helpers
// ---------------------------------------------------------------------------

export interface ParsedSdpMedia {
    type: string;
    port: number;
    proto: string;
    formats: string[];
    iceUfrag?: string;
    icePwd?: string;
    fingerprint?: { algorithm: string; hash: string };
    candidates?: ParsedIceCandidate[];
    [key: string]: unknown;
}

export interface ParsedSdp {
    version: number;
    origin: Record<string, unknown>;
    sessionName: string;
    media: ParsedSdpMedia[];
    [key: string]: unknown;
}

export interface ParsedIceCandidate {
    foundation: string;
    component: number;
    transport: string;
    priority: number;
    address: string;
    port: number;
    type: string;
    relatedAddress?: string;
    relatedPort?: number;
    tcpType?: string;
    [key: string]: unknown;
}

export declare function parseSdp(sdp: string, opts?: { maxBytes?: number }): ParsedSdp;
export declare function stringifySdp(parsed: ParsedSdp): string;

export declare function parseCandidate(line: string): ParsedIceCandidate;
export declare function stringifyCandidate(parsed: ParsedIceCandidate): string;
export declare function filterCandidates(
    candidates: ParsedIceCandidate[],
    opts?: { allowPrivate?: boolean; allowLoopback?: boolean; allowLinkLocal?: boolean; allowMdns?: boolean }
): ParsedIceCandidate[];

export declare function isPrivateIp(addr: string): boolean;
export declare function isLoopbackIp(addr: string): boolean;
export declare function isLinkLocalIp(addr: string): boolean;
export declare function isMdnsHostname(addr: string): boolean;

export declare const CANDIDATE_TYPES: Readonly<{ HOST: string; SRFLX: string; PRFLX: string; RELAY: string }>;
export declare const TCP_TYPES: Readonly<{ ACTIVE: string; PASSIVE: string; SO: string }>;

// ---------------------------------------------------------------------------
//  STUN / TURN
// ---------------------------------------------------------------------------

export declare function stunBinding(opts: {
    host: string;
    port?: number;
    timeoutMs?: number;
    retries?: number;
    socketType?: 'udp4' | 'udp6';
}): Promise<{ family: 4 | 6; address: string; port: number }>;

export declare function encodeBindingRequest(transactionId?: Buffer): { buffer: Buffer; transactionId: Buffer };
export declare function decodeMessage(buf: Buffer): {
    method: number;
    class: number;
    transactionId: Buffer;
    attributes: Array<{ type: number; value: Buffer }>;
};
export declare function encodeXorMappedAddress(address: string, port: number, transactionId: Buffer): Buffer;
export declare function decodeXorMappedAddress(value: Buffer, transactionId: Buffer): { family: 4 | 6; address: string; port: number };

export declare const STUN_MAGIC_COOKIE: number;
export declare const STUN_METHOD: Readonly<{ BINDING: number }>;
export declare const STUN_CLASS: Readonly<{ REQUEST: number; INDICATION: number; SUCCESS: number; ERROR: number }>;
export declare const STUN_ATTR: Readonly<{ MAPPED_ADDRESS: number; XOR_MAPPED_ADDRESS: number; ERROR_CODE: number; SOFTWARE: number }>;

export declare function issueTurnCredentials(opts: IssueTurnCredentialsOptions): TurnCredentials;

export declare class TurnServer {
    constructor(opts: {
        secret: string;
        realm?: string;
        listeners: Array<{ proto: 'udp' | 'tcp' | 'tls'; port: number; host?: string; tls?: { cert: Buffer; key: Buffer } }>;
        quotas?: { maxAllocationsPerUser?: number; maxBytesPerMinute?: number };
        defaultLifetime?: number;
        maxLifetime?: number;
        relayHost?: string;
    });
    readonly realm: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    address(): { address: string; port: number } | null;
    on(event: 'allocation', listener: (ev: { userId: string; relay: { address: string; port: number }; client: { address: string; port: number } }) => void): this;
    on(event: 'deallocation', listener: (ev: { userId: string; client: { address: string; port: number }; reason?: string }) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
}

// ---------------------------------------------------------------------------
//  Signaling core
// ---------------------------------------------------------------------------

export type PeerState = 'stable' | 'have-local-offer' | 'have-remote-offer';

export declare const PEER_STATE: Readonly<{
    STABLE: 'stable';
    HAVE_LOCAL_OFFER: 'have-local-offer';
    HAVE_REMOTE_OFFER: 'have-remote-offer';
}>;

export declare class Peer {
    readonly id: string;
    readonly user: unknown;
    readonly ip: string | null;
    readonly transport: PeerTransport;
    state: PeerState;
    room: Room | null;
    errors: number;
    readonly connectedAt: number;
    closed: boolean;
    e2ee?: E2eeChannel;
    constructor(transport: PeerTransport, info?: PeerAttachInfo);
    send(type: string, payload?: object): void;
    sendError(code: string, message: string): void;
    close(code?: number, reason?: string): void;
}

export declare class Room {
    readonly name: string;
    readonly hub: SignalingHub | null;
    isOpen: boolean;
    topology: 'mesh' | 'sfu' | 'mcu';
    topologyMode: 'mesh' | 'sfu' | 'mcu' | 'auto';
    constructor(name: string, opts?: { hub?: SignalingHub });
    open(): this;
    require(fn: (peer: Peer) => boolean | Promise<boolean>): this;
    canPublish(fn: (peer: Peer) => boolean): this;
    canSubscribe(fn: (peer: Peer) => boolean): this;
    setTopology(topology: 'mesh' | 'sfu' | 'mcu'): this;
    readonly size: number;
    peers(): Peer[];
    canJoin(peer: Peer): boolean | Promise<boolean>;
    broadcast(type: string, payload?: object, exceptPeerId?: string): void;
    close(reason?: string): void;
}

export interface SignalingHubEvents {
    join:            (ev: { peer: Peer; room: Room }) => void;
    leave:           (ev: { peer: Peer; room: Room }) => void;
    offer:           (ev: { peer: Peer; target: Peer | null; room: Room; sdp: string }) => void;
    answer:          (ev: { peer: Peer; target: Peer | null; room: Room; sdp: string }) => void;
    signal:          (ev: { peer: Peer; type: string }) => void;
    joinFailed:      (ev: { peer: Peer; reason: string; room?: string }) => void;
    publishFailed:   (ev: { peer: Peer; reason: string; room: string }) => void;
    subscribeFailed: (ev: { peer: Peer; reason: string; room: string }) => void;
    wireError:       (ev: { peer: Peer; code: string }) => void;
    e2eeKey:         (ev: { peer: Peer; room: Room; epoch: number; key: string }) => void;
    clusterError:    (err: Error) => void;
    'peer:limit:reached':  (ev: { room: Room; size: number; limit: number }) => void;
    'topology:promoted':   (ev: { room: Room; from: string; to: string; size: number }) => void;
    'topology:demoted':    (ev: { room: Room; from: string; to: string; size: number }) => void;
    'topology:changed':    (ev: { room: Room; topology: string; previous: string }) => void;
}

export interface HubStatsRoom {
    name: string;
    size: number;
    topology: 'mesh' | 'sfu' | 'mcu';
    topologyMode: 'mesh' | 'sfu' | 'mcu' | 'auto';
}

export interface HubStats {
    topology: 'mesh' | 'sfu' | 'mcu' | 'auto';
    maxMeshPeers: number;
    peers: number;
    rooms: HubStatsRoom[];
    mediaPlane: SfuStats | { error: string } | null;
}

export interface MediaFacade {
    readonly adapter: SfuAdapter | null;
    readonly configured: boolean;
    onEvent(handler: SfuEventHandler): () => void;
    createRouter(opts?: unknown): Promise<SfuRouter>;
    createTransport(router: SfuRouter, peer: SfuPeerInfo): Promise<SfuTransport>;
    produce(transport: SfuTransport, kind: 'audio' | 'video', rtpParams: unknown): Promise<SfuProducer>;
    consume(transport: SfuTransport, producerId: string, rtpCaps: unknown): Promise<SfuConsumer>;
    pauseProducer(producerId: string): Promise<void>;
    resumeProducer(producerId: string): Promise<void>;
    closeRouter(routerId: string): Promise<void>;
    stats(scope?: string): Promise<SfuStats>;
    setConsumerPreferredLayers(consumerId: string, layers: { spatialLayer: number; temporalLayer?: number }): Promise<void>;
    setConsumerPriority(consumerId: string, priority: number): Promise<void>;
    requestKeyFrame(consumerId: string): Promise<void>;
    pauseConsumer(consumerId: string): Promise<void>;
    resumeConsumer(consumerId: string): Promise<void>;
    setTransportBitrates(transportId: string, opts: { initial?: number; min?: number; max?: number; maxIncoming?: number; maxOutgoing?: number }): Promise<void>;
    produceData(transport: SfuTransport, opts?: { label?: string; protocol?: string; ordered?: boolean }): Promise<SfuDataProducer>;
    consumeData(transport: SfuTransport, dataProducerId: string, opts?: { ordered?: boolean }): Promise<SfuDataConsumer>;
    observeAudioLevels(routerId: string, opts?: { interval?: number; threshold?: number; maxEntries?: number }): Promise<SfuObserver>;
    observeActiveSpeaker(routerId: string, opts?: { interval?: number }): Promise<SfuObserver>;
    pipeToRouter(opts: { producerId: string; localRouterId: string; remoteRouter: SfuRouter }): Promise<SfuPipeHandle>;
    getProducerStats(producerId: string): Promise<Array<Record<string, unknown>>>;
    getConsumerStats(consumerId: string): Promise<Array<Record<string, unknown>>>;
    getTransportStats(transportId: string): Promise<Array<Record<string, unknown>>>;
    enableTraceEvent(routerId: string, types: string[]): Promise<void>;
}

export declare class SignalingHub extends EventEmitter {
    constructor(opts?: SignalingHubOptions);
    readonly size: number;
    readonly sfu: SfuAdapter | null;
    readonly media: MediaFacade;
    defaultTopology: 'mesh' | 'sfu' | 'mcu' | 'auto';
    maxMeshPeers: number;
    room(name: string): Room;
    rooms(): Room[];
    attach(transport: PeerTransport, info?: PeerAttachInfo): Peer;
    stats(): Promise<HubStats>;
    close(): void;
    on<E extends keyof SignalingHubEvents>(event: E, listener: SignalingHubEvents[E]): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    off<E extends keyof SignalingHubEvents>(event: E, listener: SignalingHubEvents[E]): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    emit<E extends keyof SignalingHubEvents>(event: E, ...args: Parameters<SignalingHubEvents[E]>): boolean;
    emit(event: string, ...args: unknown[]): boolean;
}

export declare function createWebRTC(app: unknown, opts?: WebRTCOptions): SignalingHub;

// ---------------------------------------------------------------------------
//  Join tokens
// ---------------------------------------------------------------------------

export interface SignJoinTokenOptions {
    secret: string | Buffer;
    user: string | { id?: string; userId?: string; sub?: string; [k: string]: unknown };
    room: string;
    ttl?: number;
    claims?: Record<string, unknown>;
    algorithm?: string;
    audience?: string;
}

export interface VerifyJoinTokenOptions {
    secret: string | Buffer;
    room?: string;
    audience?: string | string[];
    algorithms?: string | string[];
    clockTolerance?: number;
}

export declare function signJoinToken(opts: SignJoinTokenOptions): string;

export declare function verifyJoinToken(
    token: string,
    opts: VerifyJoinTokenOptions
): { room: string; user: unknown; sub?: string; aud?: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
//  Observability
// ---------------------------------------------------------------------------

export interface ObservabilityBindOptions {
    metrics?: unknown;
    tracer?: unknown;
    prefix?: string;
}

export declare function bindObservability(
    hub: SignalingHub,
    opts?: ObservabilityBindOptions
): () => void;

// ---------------------------------------------------------------------------
//  E2EE key relay
// ---------------------------------------------------------------------------

export interface E2eeKeyEvent {
    from: string;
    epoch: number;
    key: Buffer;
}

export declare class E2eeChannel {
    readonly peer: Peer;
    readonly hub: SignalingHub;
    epoch: number;
    constructor(peer: Peer, hub: SignalingHub);
    publish(epoch: number | null, key: Buffer | Uint8Array | string): number;
    subscribe(fn: (ev: E2eeKeyEvent) => void): () => void;
}

export declare function attachE2ee(peer: Peer, hub: SignalingHub): E2eeChannel;
export declare function generateE2eeKeyPair(): { publicKey: KeyObject; privateKey: KeyObject };
export declare function sealKey(plaintext: Buffer | Uint8Array, recipientPubKey: KeyObject | Buffer): Buffer;
export declare function openSealedKey(sealed: Buffer | Uint8Array, recipientPrivKey: KeyObject | Buffer): Buffer;

// ---------------------------------------------------------------------------
//  Cluster adapter
// ---------------------------------------------------------------------------

export interface ClusterAdapter {
    publish(channel: string, message: unknown): void | Promise<void>;
    subscribe(channel: string, handler: (message: unknown) => void): (() => void) | void;
}

export interface UseClusterOptions {
    nodeId?: string;
    region?: string;
    loadProbe?: () => (object | Promise<object>);
    loadIntervalMs?: number;
}

export interface ClusterNodeInfo {
    nodeId: string;
    region: string | null;
    load: Record<string, unknown> | null;
    lastSeen: number;
}

export type BridgeSelectorStrategy =
    | 'local-only'
    | 'least-loaded'
    | 'region-aware'
    | 'region-aware-least-loaded';

export interface SelectBridgeOptions {
    strategy?: BridgeSelectorStrategy;
    preferRegion?: string | null;
    compare?: (a: ClusterNodeInfo, b: ClusterNodeInfo) => number;
}

export declare class ClusterCoordinator {
    readonly hub: SignalingHub;
    readonly adapter: ClusterAdapter;
    readonly nodeId: string;
    readonly region: string | null;
    constructor(hub: SignalingHub, adapter: ClusterAdapter, opts?: UseClusterOptions);
    locate(peerId: string): { nodeId: string; room: string } | null;
    routeDirect(toPeerId: string, type: string, payload: object): boolean;
    fanoutRoom(roomName: string, type: string, payload: object, excludeId?: string): void;
    publishLoad(): Promise<Record<string, unknown> | null>;
    nodes(): ClusterNodeInfo[];
    selectBridge(opts?: SelectBridgeOptions): string;
    close(): void;
}

export declare function useCluster(
    hub: SignalingHub,
    adapter: ClusterAdapter,
    opts?: UseClusterOptions
): ClusterCoordinator;

export declare class MemoryClusterAdapter implements ClusterAdapter {
    publish(channel: string, message: unknown): void;
    subscribe(channel: string, handler: (message: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
//  Cross-node SFU cascade

export interface UseCascadeOptions {
    nodeId?: string;
    sfu?: SfuAdapter;
    listenInfo?: Record<string, unknown>;
    enableSrtp?: boolean;
}

export interface CascadeRemoteProducer {
    producerId: string;
    room: string;
    nodeId: string;
    routerId: string;
    kind: string;
    rtpParameters: Record<string, unknown> | null;
}

export interface CascadeBridgeStats {
    room: string;
    routerId: string;
    localProducers: number;
    peers: number;
    pipes: number;
}

export interface CascadeStats {
    nodeId: string;
    bridges: CascadeBridgeStats[];
    remoteProducers: number;
}

export declare class CascadeCoordinator {
    readonly hub: SignalingHub;
    readonly sfu: SfuAdapter;
    readonly nodeId: string;
    readonly listenInfo: Record<string, unknown>;
    readonly enableSrtp: boolean;
    constructor(hub: SignalingHub, opts?: UseCascadeOptions);
    registerLocalBridge(roomName: string, router: { id?: string; routerId?: string }): unknown;
    closeLocalBridge(roomName: string): void;
    announceProducer(roomName: string, producer: { id?: string; producerId?: string; kind?: string; rtpParameters?: unknown }): void;
    retractProducer(roomName: string, producerId: string): void;
    locateRemoteProducer(producerId: string): CascadeRemoteProducer | null;
    stats(): CascadeStats;
    close(): void;
}

export declare function useCascade(hub: SignalingHub, opts?: UseCascadeOptions): CascadeCoordinator;

export declare const CH_CASCADE: string;

// ---------------------------------------------------------------------------
//  MCU (multipoint control unit)

export type McuLayout = 'grid' | 'presenter' | 'presenter-strip' | 'dominant' | 'pip' | 'audio-only' | string;

export interface McuMixOptions {
    producerIds?: string[];
    kind?: 'audio' | 'video' | 'av';
    layout?: McuLayout | { name: string };
    inputs?: Array<Record<string, unknown>>;
    outputs?: Array<Record<string, unknown>>;
    output?: Record<string, unknown>;
    args?: string[];
}

export interface McuMixResult {
    mixedProducerId: string;
    kind: string;
    layout: McuLayout;
    sources: string[];
    pid?: number;
}

export interface McuStats {
    mixes: Array<{
        id: string;
        room?: string;
        sources: string[];
        layout: McuLayout;
        kind: string;
        pid?: number;
        exited?: boolean;
    }>;
}

export declare class McuAdapter {
    readonly sfu: SfuAdapter | null;
    readonly name: string;
    constructor(opts?: { sfu?: SfuAdapter; name?: string });
    mix(roomId: string, opts?: McuMixOptions): Promise<McuMixResult>;
    unmix(mixedProducerId: string): Promise<boolean>;
    setLayout(mixedProducerId: string, layout: McuLayout | { name: string }): Promise<McuLayout>;
    addSource(mixedProducerId: string, producerId: string): Promise<number>;
    removeSource(mixedProducerId: string, producerId: string): Promise<number>;
    stats(): McuStats;
    close(): Promise<void>;
}

export declare class MemoryMcuAdapter extends McuAdapter {}

export declare class FfmpegMcuAdapter extends McuAdapter {
    constructor(opts?: { sfu?: SfuAdapter; ffmpegPath?: string; spawn?: (...args: unknown[]) => unknown });
}

// ---------------------------------------------------------------------------
//  Recording / Egress / Ingress facade
// ---------------------------------------------------------------------------

export type RecordingPipeline = 'livekit' | 'livekit-track' | 'ffmpeg' | 'memory';

export interface RecordingStartOptions {
    pipeline?: RecordingPipeline;
    kind?: string;
    layout?: 'grid' | 'presenter' | 'presenter-strip' | 'dominant' | 'speaker' | 'audio-only' | string;
    format?: 'mp4' | 'webm' | 'mka' | 'ogg' | 'hls' | string;
    sink?: { file?: string; url?: string; format?: string };
    inputs?: Array<{ sdp?: string; url?: string }>;
    args?: string[];
    trackId?: string;
    [extra: string]: unknown;
}

export interface RecordingInfo {
    id: string;
    roomName: string;
    kind: string;
    backend: RecordingPipeline | string;
    status: 'starting' | 'recording' | 'stopping' | 'stopped' | 'failed';
    startedAt: number;
    stoppedAt: number | null;
    pid?: number;
    native: { id: string | null } | null;
    error: string | null;
}

export interface RecordingHandle {
    id: string;
    status: string;
    stop(): Promise<boolean>;
    info(): RecordingInfo;
}

export interface RecordingStats {
    recording: number;
    stopped:   number;
    failed:    number;
    total:     number;
}

export declare class RecordingManager {
    constructor(opts: { adapter: SfuAdapter | object; spawn?: (...args: unknown[]) => unknown; ffmpegPath?: string });
    startRecording(roomName: string, opts?: RecordingStartOptions): Promise<RecordingHandle>;
    stopRecording(id: string): Promise<boolean>;
    list(): RecordingInfo[];
    stats(): RecordingStats;
    close(): Promise<void>;
}

export interface IngressStartOptions {
    kind?: 'rtmp' | 'whip' | 'url-pull' | 'sip' | string;
    inputType?: string;
    roomName?: string;
    room?: string;
    name?: string;
    [extra: string]: unknown;
}

export interface IngressInfo {
    id: string;
    kind: string;
    roomName: string | null;
    createdAt: number;
    native: { id: string | null; url: string | null } | null;
}

export interface IngressHandle {
    id: string;
    native: unknown;
    info(): IngressInfo;
}

export declare class IngressManager {
    constructor(opts: { adapter: SfuAdapter | object });
    createIngress(opts: IngressStartOptions): Promise<IngressHandle>;
    deleteIngress(id: string): Promise<boolean>;
    list(): IngressInfo[];
    close(): Promise<void>;
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------

export interface WebRTCCommandDeps {
    out?: (line: string) => void;
    err?: (line: string) => void;
    setExit?: (code: number) => void;
    stunBinding?: typeof stunBinding;
}

export declare function runWebRTCCommand(
    subcmd: 'stun' | 'turn-creds' | 'join-token' | 'verify-token' | 'help' | string,
    flags?: Map<string, string>,
    deps?: WebRTCCommandDeps
): Promise<number>;

// ---------------------------------------------------------------------------
//  SFU adapter (interface only - real implementations land in later PRs)
// ---------------------------------------------------------------------------

export interface SfuPeerInfo {
    id: string;
    user?: unknown;
    room: string;
    joinedAt: number;
}

export interface SfuRouter { id: string; routerId: string; }
export interface SfuTransport {
    id: string;
    transportId: string;
    routerId: string;
    peer: SfuPeerInfo | null;
    iceParameters: unknown;
    dtlsParameters: unknown;
}
export interface SfuProducer {
    id: string;
    producerId: string;
    transportId: string;
    kind: 'audio' | 'video';
    rtpParams: unknown;
    paused: boolean;
}
export interface SfuConsumer {
    id: string;
    consumerId: string;
    transportId: string;
    producerId: string;
    kind: 'audio' | 'video';
    rtpParams: unknown;
    rtpCaps: unknown;
}
export interface SfuStats {
    kind: 'global' | 'router' | 'transport';
    [key: string]: unknown;
}

export interface SfuDataProducer {
    id: string;
    dataProducerId: string;
    transportId: string;
    label: string;
    protocol: string;
    ordered: boolean;
}

export interface SfuDataConsumer {
    id: string;
    dataConsumerId: string;
    transportId: string;
    dataProducerId: string;
    label: string;
    protocol: string;
    ordered: boolean;
}

export interface SfuObserver {
    id: string;
    routerId: string;
    kind: 'audio-level' | 'active-speaker';
    interval: number;
    threshold?: number;
    maxEntries?: number;
    close(): void;
    emit(payload: unknown): void;
}

export interface SfuPipeHandle {
    id: string;
    pipeId: string;
    producerId: string;
    localRouterId: string;
    remoteRouterId: string;
    pipeProducerId: string;
    pipeConsumerId: string;
}

export type SfuEventHandler = (event: string, payload: unknown) => void;

export declare class SfuAdapter {
    constructor();
    createRouter(opts?: unknown): Promise<SfuRouter>;
    createTransport(router: SfuRouter, peer: SfuPeerInfo): Promise<SfuTransport>;
    produce(transport: SfuTransport, kind: 'audio' | 'video', rtpParams: unknown): Promise<SfuProducer>;
    consume(transport: SfuTransport, producerId: string, rtpCaps: unknown): Promise<SfuConsumer>;
    pauseProducer(producerId: string): Promise<void>;
    resumeProducer(producerId: string): Promise<void>;
    closeRouter(routerId: string): Promise<void>;
    stats(scope?: string): Promise<SfuStats>;
    setConsumerPreferredLayers(consumerId: string, layers: { spatialLayer: number; temporalLayer?: number }): Promise<void>;
    setConsumerPriority(consumerId: string, priority: number): Promise<void>;
    requestKeyFrame(consumerId: string): Promise<void>;
    pauseConsumer(consumerId: string): Promise<void>;
    resumeConsumer(consumerId: string): Promise<void>;
    setTransportBitrates(transportId: string, opts: { initial?: number; min?: number; max?: number; maxIncoming?: number; maxOutgoing?: number }): Promise<void>;
    produceData(transport: SfuTransport, opts?: { label?: string; protocol?: string; ordered?: boolean }): Promise<SfuDataProducer>;
    consumeData(transport: SfuTransport, dataProducerId: string, opts?: { ordered?: boolean }): Promise<SfuDataConsumer>;
    observeAudioLevels(routerId: string, opts?: { interval?: number; threshold?: number; maxEntries?: number }): Promise<SfuObserver>;
    observeActiveSpeaker(routerId: string, opts?: { interval?: number }): Promise<SfuObserver>;
    pipeToRouter(opts: { producerId: string; localRouterId: string; remoteRouter: SfuRouter }): Promise<SfuPipeHandle>;
    getProducerStats(producerId: string): Promise<Array<Record<string, unknown>>>;
    getConsumerStats(consumerId: string): Promise<Array<Record<string, unknown>>>;
    getTransportStats(transportId: string): Promise<Array<Record<string, unknown>>>;
    enableTraceEvent(routerId: string, types: string[]): Promise<void>;
    onEvent(handler: SfuEventHandler): () => void;
}

export declare class MemorySfuAdapter extends SfuAdapter {
    constructor(opts?: Record<string, unknown>);
}

export interface MediasoupAdapterOptions {
    mediasoup?: unknown;
    worker?: unknown;
    workerSettings?: Record<string, unknown>;
    mediaCodecs?: Array<Record<string, unknown>>;
    webRtcTransportOptions?: Record<string, unknown>;
    webRtcServer?: unknown;
    webRtcServerOptions?: Record<string, unknown>;
}

export declare class MediasoupSfuAdapter extends SfuAdapter {
    constructor(opts?: MediasoupAdapterOptions);
    close(): Promise<void>;
}

export interface LiveKitAdapterOptions {
    url: string;
    apiKey: string;
    apiSecret: string;
    livekit?: unknown;
    client?: unknown;
    defaultRoomOpts?: Record<string, unknown>;
    defaultGrants?: Record<string, unknown>;
    tokenTtl?: string | number;
}

export declare class LiveKitSfuAdapter extends SfuAdapter {
    constructor(opts: LiveKitAdapterOptions);
    getRoomInfo(routerId: string): Promise<Record<string, unknown> | null>;
    listParticipants(routerId: string): Promise<Array<Record<string, unknown>>>;
    removeParticipant(routerId: string, identity: string): Promise<void>;
    updateRoomMetadata(routerId: string, metadata: string | Record<string, unknown>): Promise<void>;
    sendData(routerId: string, payload: unknown, opts?: { kind?: number; destinationIdentities?: string[]; destinations?: string[] }): Promise<void>;
    startRoomCompositeEgress(routerId: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    startTrackEgress(routerId: string, trackId: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    stopEgress(egressId: string): Promise<Record<string, unknown>>;
    listEgress(opts?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    createIngress(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
    deleteIngress(ingressId: string): Promise<Record<string, unknown>>;
}

export declare function loadSfuAdapter(
    spec: SfuAdapter | 'memory' | 'mediasoup' | 'livekit' | string,
    opts?: Record<string, unknown>,
): SfuAdapter;

// ---------------------------------------------------------------------------
//  Server-side bot peer (wrtc)
// ---------------------------------------------------------------------------

export interface BotPeerOptions {
    hub:            SignalingHub;
    room:           string;
    user?:          unknown;
    ip?:            string;
    joinToken?:     string;
    iceServers?:    Array<Record<string, unknown>>;
    rtcConfig?:     Record<string, unknown>;
    wrtc?:          unknown;
    onTrack?:       (track: unknown, streams: unknown[], fromPeerId: string) => void;
    onDataChannel?: (channel: unknown, fromPeerId: string) => void;
    onPeerJoin?:    (remotePeerId: string) => void;
    onPeerLeave?:   (remotePeerId: string) => void;
    onError?:       (err: Error) => void;
}

export interface BotPeerHandle {
    peer:               Peer;
    peerConnections:    Map<string, unknown>;
    getPeerConnection:  (remotePeerId: string) => unknown | undefined;
    ready:              Promise<{ peerId: string }>;
    close:              () => void;
}

export declare function spawnBotPeer(opts: BotPeerOptions): BotPeerHandle;

// ---------------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------------

export declare class WebRTCError extends Error { readonly code: string; }
export declare class SignalingError extends WebRTCError {}
export declare class IceError extends WebRTCError {}
export declare class TurnError extends WebRTCError {}
export declare class SdpError extends WebRTCError {}
