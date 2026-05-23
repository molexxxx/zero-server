// TypeScript declarations for the bundled body parsers
// (`json`, `urlencoded`, `text`, `raw`, `multipart`).
//
// These live in `lib/body/*` at runtime and are surfaced both via the
// top-level SDK and the standalone `@zero-server/body` scope.  They are
// declared here (not in `./middleware`) so the body-parser package has
// a self-contained declaration file.

import { MiddlewareFunction } from './middleware';
import { Request } from './request';
import { Response } from './response';

export interface BodyParserOptions {
    /** Max body size (e.g. '10kb', '1mb'). Default: '1mb'. */
    limit?: string | number;
    /** Content-Type(s) to match. Accepts a string, an array of strings, or a predicate function. */
    type?: string | string[] | ((ct: string) => boolean);
    /** Reject non-HTTPS requests with 403. */
    requireSecure?: boolean;
    /**
     * Verification callback invoked with the raw buffer before parsing.
     * Throw an error to reject the request with 403.
     * Useful for webhook signature verification (e.g. Stripe, GitHub).
     */
    verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void;
    /** Decompress gzip/deflate/br request bodies. Default: true. When false, compressed bodies return 415. */
    inflate?: boolean;
}

export interface JsonParserOptions extends BodyParserOptions {
    /** JSON.parse reviver function. */
    reviver?: (key: string, value: any) => any;
    /** Reject non-object/array roots. Default: true. */
    strict?: boolean;
}

export interface UrlencodedParserOptions extends BodyParserOptions {
    /** Enable nested bracket parsing. Default: false. */
    extended?: boolean;
    /** Max number of parameters. Default: 1000. Prevents parameter flooding DoS. */
    parameterLimit?: number;
    /** Max nesting depth for bracket syntax. Default: 32. Prevents deep-nesting DoS. */
    depth?: number;
}

export interface TextParserOptions extends BodyParserOptions {
    /** Fallback character encoding when Content-Type has no charset. Default: 'utf8'. */
    encoding?: BufferEncoding;
}

export interface MultipartOptions {
    /** Upload directory (default: OS temp). */
    dir?: string;
    /** Maximum size per file in bytes. */
    maxFileSize?: number;
    /** Reject non-HTTPS requests with 403. */
    requireSecure?: boolean;
    /** Maximum number of non-file fields. Default: 1000. */
    maxFields?: number;
    /** Maximum number of uploaded files. Default: 10. */
    maxFiles?: number;
    /** Maximum size of a single field value in bytes. Default: 1 MB. */
    maxFieldSize?: number;
    /** Whitelist of allowed MIME types for uploaded files (e.g. ['image/png', 'image/jpeg']). */
    allowedMimeTypes?: string[];
    /** Maximum combined size of all uploaded files in bytes. */
    maxTotalSize?: number;
}

export interface MultipartFile {
    originalFilename: string;
    storedName: string;
    path: string;
    contentType: string;
    size: number;
}

export function json(options?: JsonParserOptions): MiddlewareFunction;
export function urlencoded(options?: UrlencodedParserOptions): MiddlewareFunction;
export function text(options?: TextParserOptions): MiddlewareFunction;
export function raw(options?: BodyParserOptions): MiddlewareFunction;
export function multipart(options?: MultipartOptions): MiddlewareFunction;
