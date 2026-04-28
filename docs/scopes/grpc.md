# gRPC

> gRPC server, client, codec, framing, status, metadata, health, reflection, balancer.

## Install

```bash
npm install @zero-server/grpc
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Full HTTP/2 gRPC stack with no external dependencies: a service registry, client, proto3 parser, protobuf codec, framing, status codes, metadata, health and reflection services, load balancer, channel credentials, and a proto file watcher.

## Usage

```js
const { createRotatingCredentials } = require('@zero-server/grpc')
```

## Public surface

`@zero-server/grpc` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `GrpcStatus` |
| `grpcToHttp` |
| `grpcStatusName` |
| `GRPC_STATUS_NAMES` |
| `GrpcMetadata` |
| `ProtoWriter` |
| `ProtoReader` |
| `protoEncode` |
| `protoDecode` |
| `WIRE_TYPE` |
| `TYPE_INFO` |
| `parseProto` |
| `parseProtoFile` |
| `frameEncode` |
| `FrameParser` |
| `GrpcServiceRegistry` |
| `GrpcClient` |
| `GrpcHealthService` |
| `GrpcServingStatus` |
| `GrpcReflectionService` |
| `GrpcLoadBalancer` |
| `GrpcSubchannel` |
| `GrpcSubchannelState` |
| `ChannelCredentials` |
| `createRotatingCredentials` |
| `watchProto` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/grpc`](../../packages/grpc)
