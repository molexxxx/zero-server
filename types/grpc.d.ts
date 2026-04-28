// Type definitions for zero-server gRPC module

/// <reference types="node" />

import { EventEmitter } from 'events';
import { Http2Stream, ClientHttp2Session } from 'http2';

// --- Status Codes -------------------------------------------

export declare enum GrpcStatus {
    OK = 0,
    CANCELLED = 1,
    UNKNOWN = 2,
    INVALID_ARGUMENT = 3,
    DEADLINE_EXCEEDED = 4,
    NOT_FOUND = 5,
    ALREADY_EXISTS = 6,
    PERMISSION_DENIED = 7,
    RESOURCE_EXHAUSTED = 8,
    FAILED_PRECONDITION = 9,
    ABORTED = 10,
    OUT_OF_RANGE = 11,
    UNIMPLEMENTED = 12,
    INTERNAL = 13,
    UNAVAILABLE = 14,
    DATA_LOSS = 15,
    UNAUTHENTICATED = 16,
}

export declare const STATUS_NAMES: Record<number, string>;
export declare function grpcToHttp(code: number): number;
export declare function statusName(code: number): string;

// --- Metadata -----------------------------------------------

export declare class Metadata {
    constructor();
    set(key: string, value: string | Buffer): void;
    add(key: string, value: string | Buffer): void;
    get(key: string): string | Buffer | undefined;
    getAll(key: string): (string | Buffer)[];
    has(key: string): boolean;
    remove(key: string): void;
    clear(): void;
    merge(other: Metadata): void;
    clone(): Metadata;
    entries(): [string, (string | Buffer)[]][];
    keys(): string[];
    readonly size: number;
    toHeaders(): Record<string, string>;
    static fromHeaders(headers: Record<string, string | string[]>): Metadata;
}

// --- Protobuf Codec -----------------------------------------

export declare const WIRE_TYPE: {
    VARINT: 0;
    FIXED64: 1;
    LENGTH_DELIMITED: 2;
    START_GROUP: 3;
    END_GROUP: 4;
    FIXED32: 5;
};

export declare const TYPE_INFO: Record<string, { wireType: number; default: any }>;

export declare class Writer {
    constructor();
    writeVarint(value: number): void;
    writeSVarint(value: number): void;
    writeFixed32(value: number): void;
    writeFixed64(lo: number, hi: number): void;
    writeSFixed32(value: number): void;
    writeSFixed64(lo: number, hi: number): void;
    writeFloat(value: number): void;
    writeDouble(value: number): void;
    writeBool(value: boolean): void;
    writeString(value: string): void;
    writeBytes(value: Buffer): void;
    writeTag(fieldNumber: number, wireType: number): void;
    finish(): Buffer;
    readonly length: number;
}

export declare class Reader {
    constructor(buffer: Buffer);
    readVarint(): number;
    readSVarint(): number;
    readFixed32(): number;
    readFixed64(): [number, number];
    readSFixed32(): number;
    readSFixed64(): [number, number];
    readFloat(): number;
    readDouble(): number;
    readBool(): boolean;
    readString(): string;
    readBytes(): Buffer;
    readTag(): { fieldNumber: number; wireType: number };
    skipField(wireType: number): void;
    readSubReader(length: number): Reader;
    readonly done: boolean;
    readonly remaining: number;
}

export declare function encode(obj: Record<string, any>, messageDesc: MessageDescriptor, allMessages?: Record<string, MessageDescriptor>): Buffer;
export declare function decode(buffer: Buffer, messageDesc: MessageDescriptor, allMessages?: Record<string, MessageDescriptor>): Record<string, any>;

// --- Proto Parser -------------------------------------------

export interface FieldDescriptor {
    name: string;
    type: string;
    number: number;
    repeated?: boolean;
    optional?: boolean;
    map?: boolean;
    mapKeyType?: string;
    mapValueType?: string;
    oneofName?: string;
    options?: Record<string, any>;
    enumDef?: EnumDescriptor;
}

export interface MessageDescriptor {
    name: string;
    fields: FieldDescriptor[];
    nested?: Record<string, MessageDescriptor>;
    enums?: Record<string, EnumDescriptor>;
}

export interface EnumDescriptor {
    name: string;
    values: Record<string, number>;
    options?: Record<string, any>;
}

export interface MethodDescriptor {
    name: string;
    inputType: string;
    outputType: string;
    clientStreaming: boolean;
    serverStreaming: boolean;
    options?: Record<string, any>;
}

export interface ServiceDescriptor {
    name: string;
    methods: Record<string, MethodDescriptor>;
    options?: Record<string, any>;
}

export interface ProtoSchema {
    syntax: string;
    package: string;
    imports: string[];
    options: Record<string, any>;
    messages: Record<string, MessageDescriptor>;
    enums: Record<string, EnumDescriptor>;
    services: Record<string, ServiceDescriptor>;
}

export interface ParseProtoOptions {
    resolveImports?: boolean;
    basePath?: string;
}

export declare function parseProto(source: string, opts?: ParseProtoOptions): ProtoSchema;
export declare function parseProtoFile(filePath: string, opts?: ParseProtoOptions): ProtoSchema;
export declare function tokenize(source: string): { type: string; value: string; line: number }[];

// --- Frame --------------------------------------------------

export declare const FRAME_HEADER_SIZE: 5;
export declare const MAX_FRAME_SIZE: number;

export interface FrameEncodeOptions {
    compress?: boolean;
}

export declare function frameEncode(message: Buffer, opts?: FrameEncodeOptions): Buffer | Promise<Buffer>;

export interface FrameParserOptions {
    maxMessageSize?: number;
}

export declare class FrameParser {
    constructor(opts?: FrameParserOptions);
    onMessage: ((buf: Buffer) => void) | null;
    onError: ((err: Error) => void) | null;
    push(chunk: Buffer): void;
    reset(): void;
    destroy(): void;
}

// --- Call Objects --------------------------------------------

export interface CallOptions {
    maxMessageSize?: number;
    compress?: boolean;
}

export declare class BaseCall extends EventEmitter {
    readonly stream: Http2Stream;
    readonly method: MethodDescriptor;
    readonly metadata: Metadata;
    trailingMetadata: Metadata;
    readonly peer: string;
    readonly cancelled: boolean;

    sendMetadata(md?: Metadata | Record<string, string>): void;
    sendStatus(code: number, message?: string): void;
    sendError(code: number, message: string): void;
    write(message: Record<string, any>): boolean;
    cancel(): void;
}

export declare class UnaryCall extends BaseCall {
    request: Record<string, any> | null;
}

export declare class ServerStreamCall extends BaseCall {
    request: Record<string, any> | null;
    end(): void;
}

export declare class ClientStreamCall extends BaseCall implements AsyncIterable<Record<string, any>> {
    [Symbol.asyncIterator](): AsyncIterator<Record<string, any>>;
}

export declare class BidiStreamCall extends BaseCall implements AsyncIterable<Record<string, any>> {
    end(): void;
    [Symbol.asyncIterator](): AsyncIterator<Record<string, any>>;
}

// --- Server -------------------------------------------------

export interface GrpcServiceOptions {
    interceptors?: GrpcInterceptor[];
    maxMessageSize?: number;
    compress?: boolean;
}

export type GrpcInterceptor = (call: BaseCall, next: () => Promise<void>) => void | Promise<void>;
export type GrpcHandler = (call: BaseCall) => any | Promise<any>;

export declare class GrpcServiceRegistry {
    constructor();
    addService(schema: ProtoSchema, serviceName: string, handlers: Record<string, GrpcHandler>, opts?: GrpcServiceOptions): void;
    addInterceptor(fn: GrpcInterceptor): void;
    handleStream(stream: Http2Stream, headers: Record<string, string>): boolean;
    drain(timeout?: number): Promise<void>;
    routes(): { method: string; path: string; type: string; implemented: boolean }[];
}

// --- Client -------------------------------------------------

export interface GrpcClientOptions {
    ca?: Buffer | string;
    key?: Buffer | string;
    cert?: Buffer | string;
    metadata?: Record<string, string>;
    maxMessageSize?: number;
    compress?: boolean;
    deadline?: number;
    keepAlive?: boolean;
    keepAliveInterval?: number;
    rejectUnauthorized?: boolean;
}

export interface GrpcCallOptions {
    metadata?: Metadata | Record<string, string>;
    deadline?: number;
}

export interface ClientStreamHandle<TResponse = Record<string, any>> {
    write(msg: Record<string, any>): void;
    end(): void;
    cancel(): void;
    response: Promise<TResponse>;
}

export interface BidiStreamHandle<TResponse = Record<string, any>> extends AsyncIterable<TResponse> {
    write(msg: Record<string, any>): void;
    end(): void;
    cancel(): void;
}

export interface ServerStreamHandle<TResponse = Record<string, any>> extends AsyncIterable<TResponse> {
    cancel(): void;
}

export interface GrpcClientMultiAddressOptions {
    addresses: string[];
    address?: string;
    loadBalancing?: 'pick-first' | 'round-robin';
    healthCheck?: boolean;
    ca?: Buffer | string;
    key?: Buffer | string;
    cert?: Buffer | string;
    metadata?: Record<string, string>;
    rejectUnauthorized?: boolean;
}

export declare class GrpcClient extends EventEmitter {
    constructor(address: string | GrpcClientMultiAddressOptions, schema: ProtoSchema, serviceName: string, opts?: GrpcClientOptions);

    defaultMetadata: Metadata;
    readonly connected: boolean;

    call(methodName: string, request: Record<string, any>, opts?: GrpcCallOptions): Promise<Record<string, any>>;
    serverStream(methodName: string, request: Record<string, any>, opts?: GrpcCallOptions): ServerStreamHandle;
    clientStream(methodName: string, opts?: GrpcCallOptions): ClientStreamHandle;
    bidiStream(methodName: string, opts?: GrpcCallOptions): BidiStreamHandle;
    close(): void;
}

// --- Health Check Service -----------------------------------

export declare enum ServingStatus {
    UNKNOWN = 0,
    SERVING = 1,
    NOT_SERVING = 2,
    SERVICE_UNKNOWN = 3,
}

export declare class HealthService {
    constructor();
    setStatus(serviceName: string, status: ServingStatus | string | number): void;
    getStatus(serviceName: string): ServingStatus;
    setAllNotServing(): void;
    getSchema(): ProtoSchema;
    getHandlers(): Record<string, GrpcHandler>;
}

// --- Server Reflection --------------------------------------

export declare class ReflectionService {
    constructor(opts?: { production?: boolean });
    addSchema(schema: ProtoSchema, filename?: string): void;
    getSchema(): ProtoSchema;
    getHandlers(): Record<string, GrpcHandler>;
}

export declare function buildFileDescriptorProto(schema: ProtoSchema, filename?: string): Buffer;

// --- Load Balancing -----------------------------------------

export declare enum SubchannelState {
    IDLE = 0,
    CONNECTING = 1,
    READY = 2,
    TRANSIENT_FAILURE = 3,
    SHUTDOWN = 4,
}

export declare class Subchannel extends EventEmitter {
    constructor(address: string, connectOpts?: Record<string, any>);
    readonly state: SubchannelState;
    readonly address: string;
    readonly healthy: boolean;
    connect(): void;
    getSession(): ClientHttp2Session | null;
    shutdown(): void;
}

export declare class LoadBalancer {
    constructor(addresses: string[], opts?: { policy?: 'pick-first' | 'round-robin'; connectOpts?: Record<string, any> });
    pick(): Subchannel | null;
    getSession(): ClientHttp2Session | null;
    shutdown(): void;
}

export declare class RoundRobinPicker {
    constructor(subchannels: Subchannel[]);
    pick(): Subchannel | null;
}

// --- Channel Credentials ------------------------------------

export declare enum CredentialType {
    INSECURE = 'insecure',
    SSL = 'ssl',
    METADATA = 'metadata',
    COMPOSITE = 'composite',
}

export declare class ChannelCredentials {
    readonly type: string;

    static createInsecure(): ChannelCredentials;
    static createSsl(rootCerts?: Buffer | string | null, clientKey?: Buffer | string | null, clientCert?: Buffer | string | null, opts?: { rejectUnauthorized?: boolean }): ChannelCredentials;
    static createSslFromFiles(caPath?: string | null, keyPath?: string | null, certPath?: string | null, opts?: { rejectUnauthorized?: boolean }): ChannelCredentials;
    static createFromMetadata(metadataGenerator: (params?: { serviceUrl?: string; methodName?: string }) => Record<string, string> | Promise<Record<string, string>>): ChannelCredentials;
    static combine(...credentials: ChannelCredentials[]): ChannelCredentials;

    isSecure(): boolean;
    getConnectionOptions(): Record<string, any> | null;
    generateMetadata(params?: { serviceUrl?: string; methodName?: string }): Promise<Record<string, string>>;
}

export interface RotatingCredentialsOptions {
    caPath: string;
    keyPath?: string;
    certPath?: string;
    pollInterval?: number;
    sslOpts?: { rejectUnauthorized?: boolean };
}

export declare function createRotatingCredentials(opts: RotatingCredentialsOptions): {
    getCurrent(): ChannelCredentials;
    stop(): void;
};

// --- Proto Hot-Reload ---------------------------------------

export interface WatchProtoOptions {
    interceptors?: GrpcInterceptor[];
    maxMessageSize?: number;
    compress?: boolean;
    debounce?: number;
    production?: boolean;
    onReload?: (schema: ProtoSchema) => void;
    onError?: (err: Error) => void;
}

export declare function watchProto(
    app: any,
    protoPath: string,
    serviceName: string,
    handlers: Record<string, GrpcHandler>,
    opts?: WatchProtoOptions,
): { stop(): void; readonly schema: ProtoSchema };
