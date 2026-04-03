import { IncomingMessage, IncomingHttpHeaders } from 'http';
import { App } from './app';

export interface RangeResult {
    type: string;
    ranges: Array<{ start: number; end: number }>;
}

export interface Request {
    /** Original Node request. */
    raw: IncomingMessage;
    /** HTTP method (e.g. 'GET'). */
    method: string;
    /** Full request URL including query string. */
    url: string;
    /** URL path without query string. */
    path: string;
    /** Lower-cased request headers. */
    headers: IncomingHttpHeaders;
    /** Parsed query-string key/value pairs. */
    query: Record<string, string>;
    /** Route parameters populated by the router. */
    params: Record<string, string>;
    /** Request body (set by body-parsing middleware). */
    body: any;
    /** Raw request body as a Buffer (set by body-parsing middleware before parsing). */
    rawBody?: Buffer;
    /** Remote IP address (trust-proxy-aware). */
    readonly ip: string | null;
    /** Proxy chain addresses from X-Forwarded-For when trust proxy is enabled. */
    readonly ips: string[];
    /** `true` when the connection is over TLS (trust-proxy-aware). */
    readonly secure: boolean;
    /** Protocol string — `'https'` or `'http'` (trust-proxy-aware). */
    readonly protocol: 'http' | 'https';
    /** HTTP version string (e.g. '1.1', '2.0'). */
    httpVersion: string;
    /** Whether this request arrived over HTTP/2. */
    isHTTP2: boolean;
    /** ALPN protocol negotiated on the TLS socket (e.g. 'h2'), or null. */
    alpnProtocol: string | null;
    /** Parsed cookies (populated by cookieParser middleware). */
    cookies: Record<string, string>;
    /** Verified signed cookies (populated by cookieParser middleware). */
    signedCookies?: Record<string, string>;
    /** Request-scoped locals store. */
    locals: Record<string, any>;
    /** Request ID (populated by requestId middleware). */
    id?: string;
    /** Whether the request timed out (populated by timeout middleware). */
    timedOut?: boolean;
    /** The original URL as received — never rewritten by middleware. */
    originalUrl: string;
    /** The URL path on which the current router was mounted. */
    baseUrl: string;
    /** Reference to the parent App instance. */
    app: App | null;
    /** CSRF token (populated by csrf middleware). */
    csrfToken?: string;
    /** First signing secret (populated by cookieParser middleware). */
    secret?: string;
    /** All signing secrets (populated by cookieParser middleware). */
    secrets?: string[];

    /**
     * Get a specific request header (case-insensitive).
     */
    get(name: string): string | undefined;

    /**
     * Check if the request Content-Type matches the given type.
     */
    is(type: string): boolean;

    /**
     * Get the hostname from the Host header.
     */
    readonly hostname: string;

    /**
     * Get the subdomains as an array.
     */
    subdomains(offset?: number): string[];

    /**
     * Content negotiation — check which types the client accepts.
     */
    accepts(...types: string[]): string | false;

    /**
     * Check if the request is "fresh" (client cache valid).
     */
    readonly fresh: boolean;

    /**
     * Inverse of `fresh`.
     */
    readonly stale: boolean;

    /**
     * Check whether this request was made with XMLHttpRequest.
     */
    readonly xhr: boolean;

    /**
     * Parse the Range header.
     */
    range(size: number): RangeResult | -1 | -2;
}
