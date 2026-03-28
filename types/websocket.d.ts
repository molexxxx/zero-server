import { IncomingMessage, IncomingHttpHeaders } from 'http';

export interface WebSocketOptions {
    /** Maximum incoming frame size in bytes (default 1 MB). */
    maxPayload?: number;
    /** Auto-ping interval in ms. Set `0` to disable. */
    pingInterval?: number;
    /** Return false to reject the upgrade. */
    verifyClient?: (req: IncomingMessage) => boolean;
}

export type WebSocketHandler = (ws: WebSocketConnection, req: IncomingMessage) => void;

export interface WebSocketConnection {
    /** Unique connection identifier. */
    id: string;
    /** Current ready state (0-3). */
    readyState: number;
    /** Negotiated sub-protocol. */
    protocol: string;
    /** Requested extensions. */
    extensions: string;
    /** Request headers from the upgrade. */
    headers: IncomingHttpHeaders;
    /** Remote IP address. */
    ip: string | null;
    /** Parsed query params from the upgrade URL. */
    query: Record<string, string>;
    /** Full upgrade URL. */
    url: string;
    /** Whether connection is over TLS. */
    secure: boolean;
    /** Maximum incoming payload bytes. */
    maxPayload: number;
    /** Timestamp when connected. */
    connectedAt: number;
    /** Arbitrary user-data store. */
    data: Record<string, any>;
    /** Bytes waiting in send buffer. */
    readonly bufferedAmount: number;
    /** Milliseconds since connected. */
    readonly uptime: number;

    /**
     * Send a text or binary message.
     */
    send(data: string | Buffer, opts?: { binary?: boolean; callback?: Function }): boolean;

    /**
     * Send a JSON-serialised message.
     */
    sendJSON(obj: any, cb?: Function): boolean;

    /**
     * Send a ping frame.
     */
    ping(payload?: string | Buffer, cb?: Function): boolean;

    /**
     * Send a pong frame.
     */
    pong(payload?: string | Buffer, cb?: Function): boolean;

    /**
     * Close the connection.
     */
    close(code?: number, reason?: string): void;

    /**
     * Forcefully destroy the socket.
     */
    terminate(): void;

    // Event emitter
    on(event: 'message', fn: (data: string | Buffer) => void): WebSocketConnection;
    on(event: 'close', fn: (code: number, reason: string) => void): WebSocketConnection;
    on(event: 'error', fn: (err: Error) => void): WebSocketConnection;
    on(event: 'pong', fn: (payload: Buffer) => void): WebSocketConnection;
    on(event: 'ping', fn: (payload: Buffer) => void): WebSocketConnection;
    on(event: 'drain', fn: () => void): WebSocketConnection;
    once(event: string, fn: Function): WebSocketConnection;
    off(event: string, fn: Function): WebSocketConnection;
    removeAllListeners(event?: string): WebSocketConnection;
    listenerCount(event: string): number;
}

export interface WebSocketPool {
    /** Total active connections. */
    readonly size: number;
    /** All active room names. */
    readonly rooms: string[];
    /** All active connections. */
    readonly clients: WebSocketConnection[];

    /** Add a connection to the pool. */
    add(ws: WebSocketConnection): WebSocketPool;
    /** Remove a connection from the pool. */
    remove(ws: WebSocketConnection): WebSocketPool;
    /** Join a connection to a room. */
    join(ws: WebSocketConnection, room: string): WebSocketPool;
    /** Remove a connection from a room. */
    leave(ws: WebSocketConnection, room: string): WebSocketPool;
    /** Get all rooms a connection belongs to. */
    roomsOf(ws: WebSocketConnection): string[];
    /** Broadcast to ALL connections. */
    broadcast(data: string | Buffer, exclude?: WebSocketConnection): void;
    /** Broadcast JSON to ALL connections. */
    broadcastJSON(obj: any, exclude?: WebSocketConnection): void;
    /** Send to all connections in a room. */
    toRoom(room: string, data: string | Buffer, exclude?: WebSocketConnection): void;
    /** Send JSON to all connections in a room. */
    toRoomJSON(room: string, obj: any, exclude?: WebSocketConnection): void;
    /** Get all connections in a room. */
    in(room: string): WebSocketConnection[];
    /** Number of connections in a room. */
    roomSize(room: string): number;
    /** Close all connections. */
    closeAll(code?: number, reason?: string): void;
}
