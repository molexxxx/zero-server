# WebRTC

> WebRTC signaling hub, TURN credentials, STUN client, SFU adapter interface.

## Install

```bash
npm install @zero-server/webrtc
```

_Or install the full SDK to get everything at once:_

```bash
npm install @zero-server/sdk
```

## Overview

First-class WebRTC support: a pure-JS signaling broker built on the realtime WS layer, room / peer orchestration, RFC 8489 STUN client, RFC 7635 TURN credential issuance, optional embedded TURN server, SFrame E2EE key relay, and a pluggable SFU adapter interface (mediasoup / LiveKit / Janus) for enterprise media workloads.

## Usage

```js
const { createWebRTC } = require('@zero-server/webrtc')
```

## Public surface

`@zero-server/webrtc` exports the following public names:

| Symbol |
| --- |
| `createWebRTC` |
| `SignalingHub` |
| `Room` |
| `Peer` |
| `parseSdp` |
| `stringifySdp` |
| `parseCandidate` |
| `stringifyCandidate` |
| `filterCandidates` |
| `isPrivateIp` |
| `isLoopbackIp` |
| `isLinkLocalIp` |
| `isMdnsHostname` |
| `stunBinding` |
| `encodeBindingRequest` |
| `decodeMessage` |
| `encodeXorMappedAddress` |
| `decodeXorMappedAddress` |
| `STUN_MAGIC_COOKIE` |
| `STUN_METHOD` |
| `STUN_CLASS` |
| `STUN_ATTR` |
| `issueTurnCredentials` |
| `TurnServer` |
| `SfuAdapter` |
| `MemorySfuAdapter` |
| `MediasoupSfuAdapter` |
| `LiveKitSfuAdapter` |
| `loadSfuAdapter` |
| `signJoinToken` |
| `verifyJoinToken` |
| `spawnBotPeer` |
| `bindObservability` |
| `E2eeChannel` |
| `attachE2ee` |
| `generateE2eeKeyPair` |
| `sealKey` |
| `openSealedKey` |
| `useCluster` |
| `ClusterCoordinator` |
| `MemoryClusterAdapter` |
| `useCascade` |
| `CascadeCoordinator` |
| `CH_CASCADE` |
| `McuAdapter` |
| `MemoryMcuAdapter` |
| `FfmpegMcuAdapter` |
| `RecordingManager` |
| `IngressManager` |
| `runWebRTCCommand` |
| `WebRTCError` |
| `SignalingError` |
| `IceError` |
| `TurnError` |
| `SdpError` |

## See also

- [WebRTC scaling guide](./webrtc-scaling.md) — topology decision tree, cluster + cascade + MCU
- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/webrtc`](../../packages/webrtc)
