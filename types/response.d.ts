import { ServerResponse } from 'http';
import { App } from './app';
import { SSEStream, SSEOptions } from './sse';

export interface SendFileOptions {
    headers?: Record<string, string>;
    root?: string;
}

export interface CookieOptions {
    domain?: string;
    path?: string;
    expires?: Date | number;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    /** Auto-sign the cookie value using req.secret. */
    signed?: boolean;
    /** Cookie priority: 'Low', 'Medium', or 'High'. */
    priority?: 'Low' | 'Medium' | 'High';
    /** Partitioned attribute (CHIPS). Requires secure: true. */
    partitioned?: boolean;
}

export interface PushOptions {
    /** Absolute path to a file to stream as the push body. */
    filePath?: string;
    /** Additional headers to include in the push promise. */
    headers?: Record<string, string>;
}

export interface Response {
    /** Original Node response. */
    raw: ServerResponse;
    /** Request-scoped locals store. */
    locals: Record<string, any>;
    /** Reference to the parent App instance. */
    app: App | null;
    /** Whether this response supports HTTP/2 server push. */
    readonly supportsPush: boolean;

    /**
     * Set HTTP status code. Chainable.
     */
    status(code: number): Response;

    /**
     * Set a response header. Chainable.
     */
    set(name: string, value: string): Response;

    /**
     * Get a previously-set response header.
     */
    get(name: string): string | undefined;

    /**
     * Append a value to a header.
     */
    append(name: string, value: string): Response;

    /**
     * Add a field to the Vary response header.
     */
    vary(field: string): Response;

    /**
     * Set the Content-Type header. Chainable.
     */
    type(ct: string): Response;

    /**
     * Whether headers have been sent.
     */
    readonly headersSent: boolean;

    /**
     * Send a response body and finalize.
     */
    send(body?: string | Buffer | object | null): void;

    /**
     * Send a JSON response.
     */
    json(obj: any): void;

    /**
     * Send a plain-text response.
     */
    text(str: string): void;

    /**
     * Send an HTML response.
     */
    html(str: string): void;

    /**
     * Send only the status code with reason phrase.
     */
    sendStatus(code: number): void;

    /**
     * Send a file as the response.
     */
    sendFile(filePath: string, opts?: SendFileOptions, cb?: (err: Error | null) => void): void;
    sendFile(filePath: string, cb?: (err: Error | null) => void): void;

    /**
     * Prompt a file download.
     */
    download(filePath: string, filename?: string, cb?: (err: Error | null) => void): void;
    download(filePath: string, cb?: (err: Error | null) => void): void;

    /**
     * Set a cookie. Objects are auto-serialized as JSON cookies (j: prefix).
     */
    cookie(name: string, value: string | object, opts?: CookieOptions): Response;

    /**
     * Clear a cookie.
     */
    clearCookie(name: string, opts?: CookieOptions): Response;

    /**
     * Redirect to a URL.
     */
    redirect(url: string): void;
    redirect(status: number, url: string): void;

    /**
     * Open a Server-Sent Events stream.
     */
    sse(opts?: SSEOptions): SSEStream;

    /**
     * Content-negotiated response based on Accept header.
     * Keys are MIME types, values are handler functions.
     */
    format(types: Record<string, () => void> & { default?: () => void }): void;

    /**
     * Set the Link header from a map of rel → URL.
     */
    links(links: Record<string, string>): Response;

    /**
     * Set the Location response header.
     */
    location(url: string): Response;

    /**
     * Initiate an HTTP/2 server push.
     * Returns null if the connection is not HTTP/2 or the stream is closed.
     */
    push(path: string, opts?: PushOptions): any;
}
