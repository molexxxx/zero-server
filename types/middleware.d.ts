import { Request } from './request';
import { Response } from './response';

// --- Core Types --------------------------------------------------

export type NextFunction = (err?: any) => void;
export type MiddlewareFunction = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
export type ErrorHandlerFunction = (err: any, req: Request, res: Response, next: NextFunction) => void;

// --- CORS --------------------------------------------------------

export interface CorsOptions {
    origin?: string | string[];
    methods?: string;
    allowedHeaders?: string;
    exposedHeaders?: string;
    credentials?: boolean;
    maxAge?: number;
}

export function cors(options?: CorsOptions): MiddlewareFunction;

// --- Body Parsers ------------------------------------------------
// Declarations live in `./body` so the standalone `@zero-server/body`
// package has its own self-contained type file.  Re-exported here so
// callers using the aggregate middleware surface continue to work.

export {
    BodyParserOptions,
    JsonParserOptions,
    UrlencodedParserOptions,
    TextParserOptions,
    MultipartOptions,
    MultipartFile,
    json,
    urlencoded,
    text,
    raw,
    multipart,
} from './body';

// --- Rate Limiting -----------------------------------------------

export interface RateLimitOptions {
    /** Time window in ms. Default: 60000. */
    windowMs?: number;
    /** Max requests per window per IP. Default: 100. */
    max?: number;
    /** Custom error message. */
    message?: string;
    /** HTTP status for rate-limited responses. Default: 429. */
    statusCode?: number;
    /** Custom key extraction function. */
    keyGenerator?: (req: Request) => string;
    /** Return true to skip rate limiting for this request. */
    skip?: (req: Request) => boolean;
    /** Custom handler for rate-limited requests (replaces default 429 JSON response). */
    handler?: (req: Request, res: Response) => void;
}

export function rateLimit(opts?: RateLimitOptions): MiddlewareFunction;

// --- Logger ------------------------------------------------------

export interface LoggerOptions {
    /** Custom log function. Default: console.log. */
    logger?: (...args: any[]) => void;
    /** Colorize output. Default: true when TTY. */
    colors?: boolean;
    /** Format: 'tiny' | 'short' | 'dev'. Default: 'dev'. */
    format?: 'tiny' | 'short' | 'dev';
}

export function logger(opts?: LoggerOptions): MiddlewareFunction;

// --- Compression -------------------------------------------------

export interface CompressOptions {
    /** Minimum body size to compress. Default: 1024. */
    threshold?: number;
    /** Compression level. */
    level?: number;
    /** Force specific encoding(s). */
    encoding?: string | string[];
    /** Filter function - return false to skip compression. */
    filter?: (req: Request, res: Response) => boolean;
}

export function compress(opts?: CompressOptions): MiddlewareFunction;

// --- Helmet (Security Headers) ----------------------------------

export interface HelmetOptions {
    /** CSP directive object or `false` to disable. */
    contentSecurityPolicy?: { directives?: Record<string, string[]> } | false;
    /** Set COEP header. Default: false. */
    crossOriginEmbedderPolicy?: boolean;
    /** COOP value. Default: 'same-origin'. */
    crossOriginOpenerPolicy?: string | false;
    /** CORP value. Default: 'same-origin'. */
    crossOriginResourcePolicy?: string | false;
    /** Set X-DNS-Prefetch-Control. Default: true. */
    dnsPrefetchControl?: boolean | false;
    /** X-Frame-Options value. Default: 'deny'. */
    frameguard?: 'deny' | 'sameorigin' | false;
    /** Remove X-Powered-By. Default: true. */
    hidePoweredBy?: boolean;
    /** Set HSTS. Default: true. */
    hsts?: boolean | false;
    /** HSTS max-age in seconds. Default: 15552000. */
    hstsMaxAge?: number;
    /** HSTS includeSubDomains. Default: true. */
    hstsIncludeSubDomains?: boolean;
    /** HSTS preload. Default: false. */
    hstsPreload?: boolean;
    /** Set X-Download-Options. Default: true. */
    ieNoOpen?: boolean;
    /** Set X-Content-Type-Options: nosniff. Default: true. */
    noSniff?: boolean;
    /** X-Permitted-Cross-Domain-Policies. Default: 'none'. */
    permittedCrossDomainPolicies?: string | false;
    /** Referrer-Policy value. Default: 'no-referrer'. */
    referrerPolicy?: string | false;
    /** Set legacy X-XSS-Protection. Default: false. */
    xssFilter?: boolean;
}

export function helmet(opts?: HelmetOptions): MiddlewareFunction;

// --- Timeout -----------------------------------------------------

export interface TimeoutOptions {
    /** HTTP status code for timeout responses. Default: 408. */
    status?: number;
    /** Error message body. Default: 'Request Timeout'. */
    message?: string;
}

export function timeout(ms?: number, opts?: TimeoutOptions): MiddlewareFunction;

// --- Request ID --------------------------------------------------

export interface RequestIdOptions {
    /** Response header name. Default: 'X-Request-Id'. */
    header?: string;
    /** Custom ID generator. */
    generator?: () => string;
    /** Trust incoming X-Request-Id. Default: false. */
    trustProxy?: boolean;
}

export function requestId(opts?: RequestIdOptions): MiddlewareFunction;

// --- Cookie Parser -----------------------------------------------

export interface CookieParserStatic {
    (secret?: string | string[], opts?: { decode?: boolean }): MiddlewareFunction;
    /** Sign a value with a secret. */
    sign(val: string, secret: string): string;
    /** Unsign a signed value against one or more secrets. Returns the original value or false. */
    unsign(val: string, secrets: string | string[]): string | false;
    /** Serialize a value as a JSON cookie string (j: prefix). */
    jsonCookie(val: any): string;
    /** Parse a JSON cookie string (j: prefix). Returns parsed value or original string. */
    parseJSON(str: string): any;
}

export const cookieParser: CookieParserStatic;

// --- Static File Serving -----------------------------------------

export interface StaticOptions {
    /** Default file for directories. Default: 'index.html'. */
    index?: string | false;
    /** Cache-Control max-age in ms. Default: 0. */
    maxAge?: number;
    /** Dotfile policy: 'allow' | 'deny' | 'ignore'. Default: 'ignore'. */
    dotfiles?: 'allow' | 'deny' | 'ignore';
    /** Fallback extensions. */
    extensions?: string[];
    /** Custom header hook. */
    setHeaders?: (res: Response, filePath: string) => void;
    /** HTTP/2 push: list of asset paths or function returning them. Only triggers for HTML responses on HTTP/2 connections. */
    pushAssets?: string[] | ((filePath: string) => string[]);
}

declare function serveStatic(root: string, options?: StaticOptions): MiddlewareFunction;
export { serveStatic as static };

// --- CSRF Protection ---------------------------------------------

export interface CsrfOptions {
    /** Double-submit cookie name. Default: '_csrf'. */
    cookie?: string;
    /** Request header name for the token. Default: 'x-csrf-token'. */
    header?: string;
    /** Bytes of randomness for token generation. Default: 18. */
    saltLength?: number;
    /** HMAC secret. Auto-generated if not provided. */
    secret?: string;
    /** HTTP methods to skip CSRF checks. Default: ['GET', 'HEAD', 'OPTIONS']. */
    ignoreMethods?: string[];
    /** Path prefixes to skip CSRF checks. */
    ignorePaths?: string[];
    /** Custom error handler. Default: sends 403 JSON. */
    onError?: (req: Request, res: Response) => void;
}

export function csrf(options?: CsrfOptions): MiddlewareFunction;

// --- Request Validator -------------------------------------------

export interface ValidationRule {
    /** Type with coercion. */
    type?: 'string' | 'integer' | 'number' | 'float' | 'boolean' | 'array' | 'json' | 'date' | 'uuid' | 'email' | 'url';
    /** Field is required. */
    required?: boolean;
    /** Default value or factory function. */
    default?: any | (() => any);
    /** Minimum string length. */
    minLength?: number;
    /** Maximum string length. */
    maxLength?: number;
    /** Minimum numeric value. */
    min?: number;
    /** Maximum numeric value. */
    max?: number;
    /** Pattern match constraint. */
    match?: RegExp;
    /** Allowed values. */
    enum?: any[];
    /** Minimum array length. */
    minItems?: number;
    /** Maximum array length. */
    maxItems?: number;
    /** Custom validation function. Return a string to indicate an error. */
    validate?: (value: any) => string | void;
}

export interface ValidatorSchema {
    /** Rules for `req.body` fields. */
    body?: Record<string, ValidationRule>;
    /** Rules for `req.query` fields. */
    query?: Record<string, ValidationRule>;
    /** Rules for `req.params` fields. */
    params?: Record<string, ValidationRule>;
}

export interface ValidatorOptions {
    /** Remove fields not in schema. Default: true. */
    stripUnknown?: boolean;
    /** Custom error handler. Default: sends 422 JSON. */
    onError?: (errors: string[], req: Request, res: Response) => void;
}

export interface ValidateFunction {
    (schema: ValidatorSchema, options?: ValidatorOptions): MiddlewareFunction;

    /** Validate a single field value against a rule. */
    field(value: any, rule: ValidationRule, field: string): { value: any; error: string | null };

    /** Validate an object against a schema. */
    object(data: object, schema: Record<string, ValidationRule>, opts?: { stripUnknown?: boolean }): { sanitized: object; errors: string[] };
}

export const validate: ValidateFunction;
