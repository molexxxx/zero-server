/**
 * @module grpc
 * @description Full gRPC support for zero-server — zero external dependencies.
 *              Provides a proto3 parser, protobuf codec, gRPC framing, call objects,
 *              a service server, and a client for all four RPC patterns.
 *
 *              Features:
 *              - Proto3 schema parsing (messages, enums, services, imports)
 *              - Full protobuf binary encoding/decoding (all scalar types, nested, repeated, map, oneof, packed)
 *              - gRPC over HTTP/2 with length-prefixed framing and optional gzip compression
 *              - All four call types: unary, server-streaming, client-streaming, bidirectional
 *              - Server interceptors (middleware for gRPC calls)
 *              - Client with lazy connect, keep-alive, deadlines, and metadata
 *              - Graceful shutdown with call draining
 *              - Message size limits and deadline enforcement
 *
 * @example | Quick Start — Server
 *   const { createApp, parseProto } = require('@zero-server/sdk');
 *   const app = createApp();
 *   const schema = parseProto(`
 *       syntax = "proto3";
 *       package myapp;
 *       service Greeter {
 *           rpc SayHello (HelloRequest) returns (HelloReply);
 *       }
 *       message HelloRequest { string name = 1; }
 *       message HelloReply { string message = 1; }
 *   `);
 *
 *   app.grpc(schema, 'Greeter', {
 *       SayHello(call) {
 *           return { message: 'Hello ' + call.request.name };
 *       },
 *   });
 *
 *   app.listen(50051, { http2: true });
 *
 * @example | Quick Start — Client
 *   const { GrpcClient, parseProto } = require('@zero-server/sdk');
 *   const schema = parseProto(fs.readFileSync('hello.proto', 'utf8'));
 *   const client = new GrpcClient('http://localhost:50051', schema, 'Greeter');
 *   const reply = await client.call('SayHello', { name: 'World' });
 *   console.log(reply.message);
 *   client.close();
 */

const { GrpcStatus, grpcToHttp, statusName, STATUS_NAMES } = require('./status');
const { Metadata } = require('./metadata');
const { Writer, Reader, encode, decode, WIRE_TYPE, TYPE_INFO } = require('./codec');
const { parseProto, parseProtoFile, tokenize } = require('./proto');
const { frameEncode, FrameParser, FRAME_HEADER_SIZE, MAX_FRAME_SIZE } = require('./frame');
const { BaseCall, UnaryCall, ServerStreamCall, ClientStreamCall, BidiStreamCall } = require('./call');
const { GrpcServiceRegistry } = require('./server');
const { GrpcClient } = require('./client');
const { HealthService, ServingStatus } = require('./health');
const { ReflectionService } = require('./reflection');
const { LoadBalancer, Subchannel, SubchannelState } = require('./balancer');
const { ChannelCredentials, createRotatingCredentials } = require('./credentials');
const { watchProto } = require('./watch');

module.exports = {
    // Status codes
    GrpcStatus,
    grpcToHttp,
    statusName,
    STATUS_NAMES,

    // Metadata
    Metadata,

    // Protobuf codec
    Writer,
    Reader,
    encode,
    decode,
    WIRE_TYPE,
    TYPE_INFO,

    // Proto3 parser
    parseProto,
    parseProtoFile,
    tokenize,

    // gRPC framing
    frameEncode,
    FrameParser,
    FRAME_HEADER_SIZE,
    MAX_FRAME_SIZE,

    // Call objects
    BaseCall,
    UnaryCall,
    ServerStreamCall,
    ClientStreamCall,
    BidiStreamCall,

    // Server
    GrpcServiceRegistry,

    // Client
    GrpcClient,

    // Health check
    HealthService,
    ServingStatus,

    // Server reflection
    ReflectionService,

    // Load balancing
    LoadBalancer,
    Subchannel,
    SubchannelState,

    // Channel credentials
    ChannelCredentials,
    createRotatingCredentials,

    // Proto hot-reload
    watchProto,
};
