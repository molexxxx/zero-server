import { Readable } from 'stream';

export interface FetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | object | Readable | URLSearchParams | ArrayBuffer | Uint8Array;
    timeout?: number;
    signal?: AbortSignal;
    agent?: any;
    onDownloadProgress?: (progress: { loaded: number; total: number | null }) => void;
    onUploadProgress?: (progress: { loaded: number; total: number | null }) => void;
    // TLS options
    rejectUnauthorized?: boolean;
    ca?: string | Buffer | Array<string | Buffer>;
    cert?: string | Buffer;
    key?: string | Buffer;
    pfx?: string | Buffer;
    passphrase?: string;
    servername?: string;
    ciphers?: string;
    secureProtocol?: string;
    minVersion?: string;
    maxVersion?: string;
}

export interface FetchHeaders {
    get(name: string): string | undefined;
    raw: Record<string, string | string[]>;
}

export interface FetchResponse {
    status: number;
    statusText: string;
    ok: boolean;
    secure: boolean;
    url: string;
    headers: FetchHeaders;
    arrayBuffer(): Promise<Buffer>;
    text(): Promise<string>;
    json(): Promise<any>;
}

export function fetch(url: string, opts?: FetchOptions): Promise<FetchResponse>;
