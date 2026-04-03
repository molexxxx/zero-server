/// <reference types="node" />

import { ServerResponse } from 'http';

export type LifecycleState = 'running' | 'draining' | 'closed';

export declare const LIFECYCLE_STATE: {
    readonly RUNNING: 'running';
    readonly DRAINING: 'draining';
    readonly CLOSED: 'closed';
};

export declare class LifecycleManager {
    constructor(app: import('./app').App);

    /** Current lifecycle state. */
    readonly state: LifecycleState;

    /** Number of currently active HTTP requests. */
    readonly activeRequests: number;

    /** Whether the server is draining. */
    readonly isDraining: boolean;

    /** Whether the server has fully shut down. */
    readonly isClosed: boolean;

    /** Register a lifecycle event listener. */
    on(event: 'beforeShutdown' | 'shutdown', fn: () => void | Promise<void>): LifecycleManager;

    /** Remove a lifecycle event listener. */
    off(event: 'beforeShutdown' | 'shutdown', fn: () => void | Promise<void>): LifecycleManager;

    /** Track an active HTTP request. */
    trackRequest(res: ServerResponse): void;

    /** Register a WebSocket pool for graceful shutdown. */
    registerPool(pool: import('./websocket').WebSocketPool): LifecycleManager;

    /** Unregister a WebSocket pool. */
    unregisterPool(pool: import('./websocket').WebSocketPool): LifecycleManager;

    /** Track an SSE stream for graceful shutdown. */
    trackSSE(stream: import('./sse').SSEStream): LifecycleManager;

    /** Register an ORM Database for shutdown. */
    registerDatabase(db: { close(): Promise<void> }): LifecycleManager;

    /** Unregister an ORM Database. */
    unregisterDatabase(db: { close(): Promise<void> }): LifecycleManager;

    /** Install SIGTERM/SIGINT process signal handlers. */
    installSignalHandlers(): void;

    /** Remove installed signal handlers. */
    removeSignalHandlers(): void;

    /** Perform a full graceful shutdown. */
    shutdown(opts?: { timeout?: number }): Promise<void>;
}
