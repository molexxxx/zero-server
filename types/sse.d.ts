export interface SSEOptions {
    retry?: number;
    headers?: Record<string, string>;
    keepAlive?: number;
    keepAliveComment?: string;
    autoId?: boolean;
    startId?: number;
    pad?: number;
    status?: number;
}

export interface SSEStream {
    /** Whether the stream is still open. */
    readonly connected: boolean;
    /** The Last-Event-ID from client reconnection. */
    lastEventId: string | null;
    /** Total events sent. */
    eventCount: number;
    /** Total bytes written. */
    bytesSent: number;
    /** Timestamp when stream was opened. */
    connectedAt: number;
    /** Milliseconds since opened. */
    readonly uptime: number;
    /** Whether connection is over TLS. */
    secure: boolean;
    /** Arbitrary user-data store. */
    data: Record<string, any>;

    /**
     * Send an unnamed data event.
     */
    send(data: string | object, id?: string | number): SSEStream;

    /**
     * Send a JSON event (alias for send).
     */
    sendJSON(obj: any, id?: string | number): SSEStream;

    /**
     * Send a named event.
     */
    event(eventName: string, data: string | object, id?: string | number): SSEStream;

    /**
     * Send a comment line.
     */
    comment(text: string): SSEStream;

    /**
     * Send or update the retry interval.
     */
    retry(ms: number): SSEStream;

    /**
     * Start/restart keep-alive timer.
     */
    keepAlive(intervalMs: number, comment?: string): SSEStream;

    /**
     * Flush buffered data.
     */
    flush(): SSEStream;

    /**
     * Close the SSE connection.
     */
    close(): void;

    // Event emitter
    on(event: 'close', fn: () => void): SSEStream;
    on(event: 'error', fn: (err: Error) => void): SSEStream;
    once(event: 'close', fn: () => void): SSEStream;
    once(event: 'error', fn: (err: Error) => void): SSEStream;
    off(event: string, fn: Function): SSEStream;
    removeAllListeners(event?: string): SSEStream;
    listenerCount(event: string): number;
}
