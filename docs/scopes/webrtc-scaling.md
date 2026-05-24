# WebRTC scaling

> Topology decision tree, capacity guidance, and the cluster / cascade / MCU surfaces that let a zero-server WebRTC deployment scale from a single 3-peer call to a multi-region 1000-peer broadcast.

## Topology decision tree

```
peers ≤ 3                  → mesh   (no media server)
peers ≤ 50                 → SFU on a single node (`createWebRTC({ sfu })`)
peers ≤ 500                → SFU + cluster (`useCluster`) + cascade (`useCascade`)
peers > 500 OR multi-region→ cascade + region-aware BridgeSelector + egress fanout
SIP / regulated record / very low-bandwidth clients
                           → MCU mix on top of SFU (`MemoryMcuAdapter` / `FfmpegMcuAdapter`)
```

## Capacity rules of thumb

| Topology | Producer cost | Consumer cost | Recommended cap |
|---|---|---|---|
| Mesh (P2P) | N-1 uplinks per peer | N-1 downlinks per peer | 3-4 video peers |
| SFU (single node) | 1 uplink + RTCP | N downlinks | ~500 consumers/worker (mediasoup); ~1000 audio-only |
| SFU + cascade | 1 uplink + 1 pipe per bridge | N downlinks per bridge | scales near-linearly with bridge count |
| MCU (audio mix) | 1 uplink per source | 1 downlink (mixed) | bounded by mixer CPU, not network |
| MCU (video grid) | 1 uplink per source | 1 downlink (tiled) | bounded by encoder CPU (use GPU or LiveKit egress) |

## Surfaces by phase

### 1 — Signaling-only mesh (default)

```js
const { createWebRTC } = require('@zero-server/webrtc');
const hub = createWebRTC(app, { topology: 'mesh', joinTokenSecret: 'jwt-secret' });
```

No media server, no extra deps. Peers negotiate `RTCPeerConnection`s directly.

### 2 — Single-node SFU

```js
const { createWebRTC, MediasoupSfuAdapter } = require('@zero-server/webrtc');
const hub = createWebRTC(app, {
    topology: 'sfu',
    sfu: new MediasoupSfuAdapter({
        webRtcServer: { listenInfos: [{ protocol: 'udp', ip: '0.0.0.0', port: 44444 }] },
    }),
});
```

Available adapter methods (Phase 2 + 3 surface): `produce({ encodings, scalabilityMode })`, `setConsumerPreferredLayers`, `setConsumerPriority`, `requestKeyFrame`, `pauseConsumer/resumeConsumer`, `setTransportBitrates`, `produceData/consumeData`, `observeAudioLevels`, `observeActiveSpeaker`, `pipeToRouter`, `getProducerStats/getConsumerStats/getTransportStats`, `enableTraceEvent`.

LiveKit-equivalent surface: REST passthroughs (`getRoomInfo`, `listParticipants`, `removeParticipant`, `updateRoomMetadata`, `sendData`) + egress (`startRoomCompositeEgress`, `startTrackEgress`, `stopEgress`, `listEgress`) + ingress (`createIngress`, `deleteIngress`).

### 3 — Multi-node SFU with cluster + cascade

```js
const {
    createWebRTC, MediasoupSfuAdapter,
    useCluster, useCascade, MemoryClusterAdapter,
} = require('@zero-server/webrtc');

const bus = new MemoryClusterAdapter(); // replace with Redis/NATS in prod
const hub = createWebRTC(app, { topology: 'sfu', sfu: new MediasoupSfuAdapter() });

useCluster(hub, bus, {
    nodeId:    process.env.NODE_ID,
    region:    process.env.REGION,
    loadProbe: () => ({ cpu: os.loadavg()[0] / os.cpus().length, producers: countProducers() }),
});

const cascade = useCascade(hub, { nodeId: process.env.NODE_ID });

// On first peer joining room "lobby" on this node:
const router = await hub.sfu.createRouter();
cascade.registerLocalBridge('lobby', router);
```

Cascade bus protocol (channel `zs:rtc:cascade`):

| `kind` | direction | purpose |
|---|---|---|
| `hello` | broadcast | request peer replay |
| `bridge:open` | any → all | "I host room R on router X" |
| `bridge:accept` | replies | acknowledge peer bridge |
| `bridge:close` | any → all | tear down peer bridge |
| `producer:new` | any → all | new local producer to fanout |
| `producer:close` | any → all | producer gone |

When a peer node receives `producer:new` it records the producer in its remote directory (`locateRemoteProducer(id)`) and attempts `sfu.pipeToRouter(...)`. Adapters that can't pipe a remote producer (e.g. the memory adapter, or any SFU lacking PipeTransport) emit `cascade:producer-pipe-failed`; the directory entry survives so apps can still reason about availability.

### 4 — Region-aware selection

```js
const target = hub._cluster.selectBridge({
    strategy:     'region-aware-least-loaded', // default
    preferRegion: req.geoip.region,
});
// hand back `target` (a nodeId) to the client so it joins that node
```

Built-in strategies:

| Strategy | Behavior |
|---|---|
| `local-only` | Always return own nodeId. |
| `least-loaded` | Pick lowest `load.cpu` (falls back to `load.producers`). |
| `region-aware` | Prefer nodes in `preferRegion`. |
| `region-aware-least-loaded` (default) | Same-region first, then lowest load. |

A custom comparator may be passed via `compare(a, b)` for bespoke policy.

### 5 — Optional MCU mix

```js
const { MemoryMcuAdapter } = require('@zero-server/webrtc');
const mcu = new MemoryMcuAdapter({ sfu: hub.sfu });

const { mixedProducerId } = await mcu.mix('lobby', {
    producerIds: [...currentProducers()],
    kind:        'audio',
});
// publish `mixedProducerId` to low-bandwidth clients
```

For real mixing, use the `FfmpegMcuAdapter` stub (gated on `npm i ffmpeg-static`) and wire its RTP I/O against mediasoup's `PlainTransport` — see the [mediasoup recording sample](https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransport) for the exact handshake.

### 6 — Recording / egress / ingress

Use the LiveKit adapter's `startRoomCompositeEgress` / `startTrackEgress` / `createIngress` for managed recording. For mediasoup, combine `spawnBotPeer` (a `node-wrtc` headless consumer) with `MediaRecorder` or pipe a `PlainTransport` into ffmpeg.

## Migration matrix

| From | To | What changes |
|---|---|---|
| `topology: 'mesh'` | `topology: 'sfu'` | Add `sfu:` option to `createWebRTC()`; clients keep using the same JSEP signaling. |
| Single SFU node | Cluster | Add `useCluster(hub, bus)` per node; `Room#broadcast` and direct frames now fan across nodes automatically. |
| Cluster (signaling only) | Cascade | Add `useCascade(hub)` per node + `registerLocalBridge(roomName, router)` for each room owned on that node. |
| SFU+cascade | Region-aware | Pass `region` + `loadProbe` to `useCluster`; route new clients through `selectBridge()`. |
| SFU | SFU + MCU | Wrap with `new FfmpegMcuAdapter({ sfu })`; mix `producerIds` and publish `mixedProducerId` to constrained clients. |

## Failure modes & observability

- Every coordinator emits errors on the hub: `clusterError`, `cascadeError`, `cascade:producer-pipe-failed`. Wire them to your logger.
- `bindObservability(hub, { metrics, tracer })` adds Prometheus counters and OTel spans for signaling, room churn, and adapter calls.
- `hub._cluster.nodes()` and `hub._cascade.stats()` return JSON-serializable snapshots for ops dashboards.

## See also

- [`docs/scopes/webrtc.md`](./webrtc.md) — base API reference
- [`lib/webrtc/cascade.js`](../../lib/webrtc/cascade.js) — cascade orchestrator
- [`lib/webrtc/cluster.js`](../../lib/webrtc/cluster.js) — cluster + BridgeSelector
- [`lib/webrtc/mcu/`](../../lib/webrtc/mcu/) — MCU adapters
- [mediasoup `pipeToRouter`](https://mediasoup.org/documentation/v3/mediasoup/api/#router-pipeToRouter)
- [Jitsi Octo design](https://jitsi.org/blog/scaling-jitsi-meet-in-the-cloud/)
