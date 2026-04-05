import { Request } from './request';
import { Response } from './response';
import { MiddlewareFunction } from './middleware';

// --- JWT ---------------------------------------------------------

export interface JwtHeader {
    alg: string;
    typ: string;
    kid?: string;
    [key: string]: any;
}

export interface JwtPayload {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    iat?: number;
    jti?: string;
    [key: string]: any;
}

export interface JwtDecoded {
    header: JwtHeader;
    payload: JwtPayload;
    signature: string;
}

export interface JwtSignOptions {
    algorithm?: string;
    expiresIn?: number;
    issuer?: string;
    audience?: string;
    subject?: string;
    jwtId?: string;
    notBefore?: number;
    header?: Record<string, any>;
}

export interface JwtVerifyOptions {
    algorithms?: string | string[];
    audience?: string | string[];
    issuer?: string | string[];
    subject?: string;
    clockTolerance?: number;
    maxAge?: number;
    ignoreExpiration?: boolean;
}

export interface JwtVerifyResult {
    header: JwtHeader;
    payload: JwtPayload;
}

export interface JwtMiddlewareOptions {
    secret?: string | Buffer;
    publicKey?: string | Buffer;
    getKey?: (header: JwtHeader, payload: JwtPayload) => string | Buffer | Promise<string | Buffer>;
    jwksUri?: string;
    algorithms?: string | string[];
    getToken?: (req: Request) => string | null;
    tokenLocation?: 'header' | 'cookie' | 'query';
    cookieName?: string;
    queryParam?: string;
    audience?: string | string[];
    issuer?: string | string[];
    subject?: string;
    clockTolerance?: number;
    maxAge?: number;
    credentialsRequired?: boolean;
    isRevoked?: (payload: JwtPayload) => boolean | Promise<boolean>;
    onError?: (err: { message: string; code: string; statusCode: number }, req: Request, res: Response) => void;
    fetcher?: Function;
    cacheTtl?: number;
}

export function jwt(opts: JwtMiddlewareOptions): MiddlewareFunction;
export function jwtSign(payload: Record<string, any>, secret: string | Buffer, opts?: JwtSignOptions): string;
export function jwtVerify(token: string, secretOrKey: string | Buffer, opts?: JwtVerifyOptions): JwtVerifyResult;
export function jwtDecode(token: string): JwtDecoded | null;

export interface JwksGetKey {
    (header: JwtHeader, payload?: JwtPayload): Promise<string>;
    _clearCache(): void;
}

export interface JwksOptions {
    fetcher?: Function;
    cacheTtl?: number;
    requestTimeout?: number;
}

export function jwks(jwksUri: string, opts?: JwksOptions): JwksGetKey;

export interface TokenPairConfig {
    accessSecret: string | Buffer;
    refreshSecret?: string | Buffer;
    accessExpiresIn?: number;
    refreshExpiresIn?: number;
    algorithm?: string;
}

export interface TokenPairInstance {
    generateTokens(payload: Record<string, any>): { accessToken: string; refreshToken: string };
    verifyRefreshToken(token: string): JwtVerifyResult;
    verifyAccessToken(token: string): JwtVerifyResult;
}

export function tokenPair(config: TokenPairConfig): TokenPairInstance;
export function createRefreshToken(payload: Record<string, any>, secret: string | Buffer, opts?: { expiresIn?: number; algorithm?: string }): string;
export const SUPPORTED_ALGORITHMS: string[];

// --- Session -----------------------------------------------------

export interface SessionData {
    [key: string]: any;
}

export declare class Session {
    id: string;
    constructor(id: string, data?: SessionData);
    get(key: string): any;
    set(key: string, value: any): Session;
    has(key: string): boolean;
    delete(key: string): boolean;
    all(): SessionData;
    readonly size: number;
    clear(): Session;
    destroy(): void;
    regenerate(): void;
    flash(key: string, value: any): Session;
    flashes(key?: string): any[] | Record<string, any[]>;
}

export interface SessionCookieOptions {
    maxAge?: number;
    path?: string;
    domain?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None' | string;
}

export interface SessionStore {
    get(sid: string): Promise<string | null>;
    set(sid: string, data: string, maxAge?: number): Promise<void>;
    destroy(sid: string): Promise<void>;
}

export interface MemoryStoreOptions {
    ttl?: number;
    pruneInterval?: number;
    maxSessions?: number;
}

export declare class MemoryStore implements SessionStore {
    constructor(opts?: MemoryStoreOptions);
    get(sid: string): Promise<string | null>;
    set(sid: string, data: string, maxAge?: number): Promise<void>;
    destroy(sid: string): Promise<void>;
    readonly length: number;
    clear(): void;
    close(): void;
}

export interface SessionOptions {
    secret: string | string[];
    store?: SessionStore;
    name?: string;
    cookie?: SessionCookieOptions;
    rolling?: boolean;
    genid?: () => string;
}

export function session(opts: SessionOptions): MiddlewareFunction;

// --- OAuth2 ------------------------------------------------------

export interface OAuthProviderPreset {
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string | null;
    scope: string;
    pkce: boolean;
    responseMode?: string;
}

export interface OAuthOptions {
    provider?: 'google' | 'github' | 'microsoft' | 'apple';
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    userInfoUrl?: string;
    scope?: string;
    pkce?: boolean;
    responseMode?: string;
    fetcher?: Function;
    timeout?: number;
}

export interface OAuthAuthorizeResult {
    url: string;
    state: string;
    codeVerifier?: string;
}

export interface OAuthTokens {
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    [key: string]: any;
}

export interface OAuthClient {
    authorize(params?: { scope?: string; state?: string; extra?: Record<string, string> }): OAuthAuthorizeResult;
    callback(query: { code?: string; state?: string; error?: string; error_description?: string }, verify?: { state?: string; codeVerifier?: string }): Promise<OAuthTokens>;
    refresh(refreshToken: string): Promise<OAuthTokens>;
    userInfo(accessToken: string): Promise<Record<string, any>>;
    readonly config: Readonly<OAuthOptions>;
}

export function oauth(opts: OAuthOptions): OAuthClient;
export function generatePKCE(length?: number): { codeVerifier: string; codeChallenge: string };
export function generateState(bytes?: number): string;
export const OAUTH_PROVIDERS: Record<string, OAuthProviderPreset>;

// --- Authorization -----------------------------------------------

export function authorize(...roles: (string | string[])[]): MiddlewareFunction;
export function can(...permissions: (string | string[])[]): MiddlewareFunction;
export function canAny(...permissions: (string | string[])[]): MiddlewareFunction;

export declare class Policy {
    before?(user: any, action: string, resource?: any): boolean | undefined;
    check(action: string, user: any, resource?: any): boolean | Promise<boolean>;
    [action: string]: any;
}

export function gate(
    policy: Policy,
    action: string,
    getResource?: (req: Request) => any | Promise<any>,
): MiddlewareFunction;

export function attachUserHelpers(): MiddlewareFunction;

// --- Two-Factor Authentication -----------------------------------

export interface TwoFactorSecret {
    raw: Buffer;
    base32: string;
    hex: string;
}

export interface TOTPOptions {
    period?: number;
    digits?: number;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    time?: number;
}

export interface TOTPVerifyOptions extends TOTPOptions {
    window?: number;
}

export interface TOTPVerifyResult {
    valid: boolean;
    delta: number | null;
}

export interface OtpauthURIOptions {
    secret: string | Buffer;
    issuer: string;
    account: string;
    period?: number;
    digits?: number;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
}

export interface BackupCodesResult {
    codes: string[];
    hashes: string[];
}

export interface BackupCodeVerifyResult {
    valid: boolean;
    index: number | null;
}

export interface Require2FAOptions {
    sessionKey?: string;
    errorMessage?: string;
    statusCode?: number;
    isEnabled?: (req: Request) => boolean | Promise<boolean>;
}

export interface VerifyTOTPMiddlewareOptions {
    getSecret: (req: Request) => string | Buffer | Promise<string | Buffer>;
    codeField?: string;
    sessionKey?: string;
    maxAttempts?: number;
    lockoutMs?: number;
    window?: number;
    period?: number;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    digits?: number;
    replayStore?: ReplayStore;
    getUserId?: (req: Request) => string | Promise<string>;
    onSuccess?: (req: Request, res: Response) => void;
    onFailure?: (req: Request, res: Response, attemptsLeft: number) => void;
}

export interface ReplayStore {
    get(userId: string): Promise<number | null>;
    set(userId: string, counter: number, ttlMs: number): Promise<void>;
}

export declare class InMemoryReplayStore implements ReplayStore {
    constructor();
    get(userId: string): Promise<number | null>;
    set(userId: string, counter: number, ttlMs: number): Promise<void>;
    clear(): void;
    destroy(): void;
}

export interface Verify2FAOptions {
    getSecret: (req: Request) => string | Buffer | Promise<string | Buffer>;
    getBackupHashes?: (req: Request) => string[] | Promise<string[]>;
    onBackupUsed?: (req: Request, index: number) => void | Promise<void>;
    getCredential?: (req: Request, credId: string) => any | Promise<any>;
    updateCredentialCounter?: (req: Request, credId: string, newCounter: number) => void | Promise<void>;
    expectedOrigin?: string;
    expectedRPID?: string;
    codeField?: string;
    backupField?: string;
    sessionKey?: string;
    maxAttempts?: number;
    lockoutMs?: number;
    window?: number;
    period?: number;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    digits?: number;
    replayStore?: ReplayStore;
    getUserId?: (req: Request) => string | Promise<string>;
    onSuccess?: (req: Request, res: Response, method: 'totp' | 'backup' | 'webauthn') => void;
    onFailure?: (req: Request, res: Response, attemptsLeft: number) => void;
}

export interface TwoFactor {
    generateSecret(bytes?: number): TwoFactorSecret;
    generateTOTP(secret: string | Buffer, opts?: TOTPOptions): string;
    verifyTOTP(token: string, secret: string | Buffer, opts?: TOTPVerifyOptions): TOTPVerifyResult;
    otpauthURI(opts: OtpauthURIOptions): string;
    generateBackupCodes(count?: number, bytes?: number): BackupCodesResult;
    verifyBackupCode(code: string, hashes: string[]): BackupCodeVerifyResult;
    require2FA(opts?: Require2FAOptions): MiddlewareFunction;
    verifyTOTPMiddleware(opts: VerifyTOTPMiddlewareOptions): MiddlewareFunction;
    verify2FA(opts: Verify2FAOptions): MiddlewareFunction;
    InMemoryReplayStore: typeof InMemoryReplayStore;
    DEFAULT_PERIOD: number;
    DEFAULT_DIGITS: number;
    DEFAULT_ALGORITHM: string;
    DEFAULT_WINDOW: number;
    SUPPORTED_TOTP_ALGORITHMS: string[];
}

export const twoFactor: TwoFactor;

// --- WebAuthn / Passkeys -----------------------------------------

export interface WebAuthnRegistrationOptions {
    rpName: string;
    rpId: string;
    userId: string;
    userName: string;
    userDisplayName?: string;
    challenge?: Buffer;
    challengeSize?: number;
    attestation?: 'none' | 'direct' | 'indirect';
    authenticatorSelection?: {
        authenticatorAttachment?: 'platform' | 'cross-platform';
        residentKey?: 'discouraged' | 'preferred' | 'required';
        requireResidentKey?: boolean;
        userVerification?: 'discouraged' | 'preferred' | 'required';
    };
    excludeCredentials?: Array<{ id: string | Buffer; type?: string; transports?: string[] }>;
    timeout?: number;
}

export interface WebAuthnRegistrationResult {
    verified: boolean;
    credential: {
        id: string;
        publicKey: Buffer;
        counter: number;
        type: string;
        transports?: string[];
    };
    authData: {
        rpIdHash: Buffer;
        flags: number;
        signCount: number;
        aaguid: Buffer;
        credentialId: Buffer;
    };
}

export interface WebAuthnVerifyRegistrationOptions {
    response: any;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
}

export interface WebAuthnAuthenticationOptions {
    rpId: string;
    challenge?: Buffer;
    challengeSize?: number;
    allowCredentials?: Array<{ id: string | Buffer; type?: string; transports?: string[] }>;
    userVerification?: 'discouraged' | 'preferred' | 'required';
    timeout?: number;
}

export interface WebAuthnAuthenticationResult {
    verified: boolean;
    authData: {
        rpIdHash: Buffer;
        flags: number;
        signCount: number;
    };
}

export interface WebAuthnVerifyAuthenticationOptions {
    response: any;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
    credential: { publicKey: Buffer; counter: number; id?: string };
}

export interface WebAuthn {
    generateRegistrationOptions(opts: WebAuthnRegistrationOptions): any;
    verifyRegistration(opts: WebAuthnVerifyRegistrationOptions): Promise<WebAuthnRegistrationResult>;
    generateAuthenticationOptions(opts: WebAuthnAuthenticationOptions): any;
    verifyAuthentication(opts: WebAuthnVerifyAuthenticationOptions): Promise<WebAuthnAuthenticationResult>;
}

export const webauthn: WebAuthn;

// --- Trusted Device / Remember Me --------------------------------

export interface TrustedDeviceIssueOptions {
    secret: string;
    maxAge?: number;
    cookieName?: string;
    fingerprint?: (req: Request) => string | Promise<string>;
    getUserId?: (req: Request) => string | Promise<string>;
}

export interface TrustedDeviceVerifyOptions {
    secret: string;
    previousSecrets?: string | string[];
    cookieName?: string;
    fingerprint?: (req: Request) => string | Promise<string>;
    getUserId?: (req: Request) => string | Promise<string>;
    checkIP?: boolean;
}

export interface TrustedDeviceRevokeOptions {
    cookieName?: string;
}

export interface TrustedDevice {
    issue(opts: TrustedDeviceIssueOptions): MiddlewareFunction;
    verify(opts: TrustedDeviceVerifyOptions): (req: Request) => Promise<boolean>;
    revoke(opts?: TrustedDeviceRevokeOptions): MiddlewareFunction;
}

export const trustedDevice: TrustedDevice;

// --- 2FA Enrollment Flow -----------------------------------------

export interface EnrollmentOptions {
    saveSecret: (req: Request, secret: string, backupHashes: string[]) => Promise<void>;
    removeSecret: (req: Request) => Promise<void>;
    issuer?: string;
    getAccount?: (req: Request) => string | Promise<string>;
    sessionKey?: string;
    ttl?: number;
    backupCount?: number;
    window?: number;
    period?: number;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    digits?: number;
    isEnabled?: (req: Request) => boolean | Promise<boolean>;
}

export interface EnrollmentDisableOptions {
    confirm?: (req: Request) => boolean | Promise<boolean>;
}

export interface EnrollmentVerifyOptions {
    codeField?: string;
}

export interface EnrollmentFlow {
    start(): MiddlewareFunction;
    verify(opts?: EnrollmentVerifyOptions): MiddlewareFunction;
    complete(): MiddlewareFunction;
    disable(opts?: EnrollmentDisableOptions): MiddlewareFunction;
}

export function enrollment(opts: EnrollmentOptions): EnrollmentFlow;
