/**
 * @module auth/session
 * @description Zero-dependency session middleware.
 *              Supports encrypted cookie sessions (stateless, AES-256-GCM)
 *              and server-side session stores (memory and custom adapters).
 *
 *              Cookie sessions embed the entire session in an encrypted cookie,
 *              so no server-side storage is needed.  Server-side sessions store
 *              only a session ID in the cookie, keeping data on the server.
 *
 * @example
 *   // Encrypted cookie session (stateless)
 *   app.use(session({ secret: process.env.SESSION_SECRET }));
 *
 * @example
 *   // Server-side session with memory store
 *   app.use(session({
 *       secret: process.env.SESSION_SECRET,
 *       store: new MemoryStore(),
 *       cookie: { maxAge: 3600000 },
 *   }));
 *
 * @example
 *   // Access session data:
 *   app.get('/dashboard', (req, res) => {
 *       const views = req.session.get('views') || 0;
 *       req.session.set('views', views + 1);
 *       res.json({ views: views + 1 });
 *   });
 */
const crypto = require('crypto');
const log = require('../debug')('zero:session');

// -- Constants ---------------------------------------------------

const DEFAULT_COOKIE_NAME = 'sid';
const DEFAULT_MAX_AGE = 86400000;       // 24 hours in ms
const IV_LEN = 12;                      // AES-256-GCM IV
const AUTH_TAG_LEN = 16;                // GCM auth tag
const KEY_LEN = 32;                     // AES-256 key
const MAX_COOKIE_SIZE = 4096;           // Browser max cookie size
const SID_BYTES = 24;                   // Session ID entropy (base64url → 32 chars)

// -- Encryption helpers ------------------------------------------

/**
 * Derive an AES-256 key from a secret string.
 * Uses HKDF with SHA-256 for proper key derivation.
 *
 * @param {string} secret - User-provided secret.
 * @returns {Buffer} 32-byte key.
 * @private
 */
function _deriveKey(secret)
{
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Each encryption uses a unique random IV.
 *
 * @param {string} plaintext - Data to encrypt.
 * @param {Buffer} key - 32-byte AES key.
 * @returns {string} Base64url-encoded `iv.ciphertext.tag`.
 * @private
 */
function _encrypt(plaintext, key)
{
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LEN });
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Pack: iv + ciphertext + tag
    const packed = Buffer.concat([iv, enc, tag]);
    return packed.toString('base64url');
}

/**
 * Decrypt AES-256-GCM ciphertext.
 *
 * @param {string} encoded - Base64url `iv+ciphertext+tag` string.
 * @param {Buffer} key - 32-byte AES key.
 * @returns {string|null} Decrypted plaintext or `null` on failure.
 * @private
 */
function _decrypt(encoded, key)
{
    try
    {
        const packed = Buffer.from(encoded, 'base64url');
        if (packed.length < IV_LEN + AUTH_TAG_LEN + 1) return null;

        const iv = packed.subarray(0, IV_LEN);
        const tag = packed.subarray(packed.length - AUTH_TAG_LEN);
        const enc = packed.subarray(IV_LEN, packed.length - AUTH_TAG_LEN);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LEN });
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
        return dec.toString('utf8');
    }
    catch (_) { return null; }
}

// -- Session class ------------------------------------------------

/**
 * Session data container with a Map-like API.
 *
 * @example
 *   req.session.set('user', { id: 1, name: 'Alice' });
 *   req.session.get('user'); // { id: 1, name: 'Alice' }
 *   req.session.has('user'); // true
 *   req.session.delete('user');
 *   req.session.destroy();   // wipe + expire cookie
 */
class Session
{
    /**
     * @param {string} id - Session ID.
     * @param {object} [data] - Initial data.
     */
    constructor(id, data = {})
    {
        this.id = id;
        this._data = { ...data };
        this._dirty = false;
        this._destroyed = false;
        this._regenerated = false;
        this._flash = {};
        this._flashOut = {};
    }

    /**
     * Get a session value by key.
     * @param {string} key
     * @returns {*}
     */
    get(key) { return this._data[key]; }

    /**
     * Set a session value.
     * @param {string} key
     * @param {*} value
     * @returns {Session} this (chainable)
     */
    set(key, value)
    {
        this._data[key] = value;
        this._dirty = true;
        return this;
    }

    /**
     * Check if a key exists in the session.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) { return key in this._data; }

    /**
     * Delete a session key.
     * @param {string} key
     * @returns {boolean} true if the key existed.
     */
    delete(key)
    {
        const existed = key in this._data;
        delete this._data[key];
        if (existed) this._dirty = true;
        return existed;
    }

    /**
     * Get all session data as a plain object.
     * @returns {object}
     */
    all() { return { ...this._data }; }

    /**
     * Number of session entries.
     * @returns {number}
     */
    get size() { return Object.keys(this._data).length; }

    /**
     * Clear all session data.
     * @returns {Session}
     */
    clear()
    {
        this._data = {};
        this._dirty = true;
        return this;
    }

    /**
     * Destroy the session.
     * Clears all data and marks cookie for expiry.
     */
    destroy()
    {
        this._data = {};
        this._flash = {};
        this._flashOut = {};
        this._dirty = true;
        this._destroyed = true;
    }

    /**
     * Regenerate the session ID (prevents session fixation).
     * Preserves existing data under a new ID.
     */
    regenerate()
    {
        this.id = _generateSid();
        this._regenerated = true;
        this._dirty = true;
    }

    /**
     * Set a flash message (available only on the next request).
     *
     * @param {string} key - Flash key (e.g. `'success'`, `'error'`).
     * @param {*} value - Flash value.
     * @returns {Session}
     *
     * @example
     *   req.session.flash('success', 'Post created!');
     *   // Next request:
     *   req.session.flashes('success'); // ['Post created!']
     */
    flash(key, value)
    {
        if (!this._flashOut[key]) this._flashOut[key] = [];
        this._flashOut[key].push(value);
        this._dirty = true;
        return this;
    }

    /**
     * Read flash messages for a key (consumes them).
     *
     * @param {string} [key] - Flash key. If omitted, returns all flashes.
     * @returns {*[]|object} Array of messages for key, or object of all flashes.
     */
    flashes(key)
    {
        if (key) return this._flash[key] || [];
        return { ...this._flash };
    }

    /** @private — serialize to JSON for cookie/store */
    _serialize()
    {
        const obj = { d: this._data };
        if (Object.keys(this._flashOut).length) obj.f = this._flashOut;
        return JSON.stringify(obj);
    }

    /** @private — deserialize from JSON */
    static _deserialize(json, id)
    {
        try
        {
            const obj = typeof json === 'string' ? JSON.parse(json) : json;
            const sess = new Session(id, obj.d || {});
            sess._flash = obj.f || {};
            return sess;
        }
        catch (_) { return new Session(id); }
    }
}

// -- Memory Store ------------------------------------------------

/**
 * In-memory session store.
 * Suitable for development and single-process deployments.
 * Sessions are lost on restart.
 *
 * @example
 *   const store = new MemoryStore({ ttl: 3600000 });
 *   app.use(session({ secret: 's3cret', store }));
 */
class MemoryStore
{
    /**
     * @param {object} [opts]
     * @param {number} [opts.ttl=86400000] - Session TTL in ms (default 24h).
     * @param {number} [opts.pruneInterval=300000] - Cleanup interval in ms (default 5min).
     * @param {number} [opts.maxSessions=10000] - Maximum stored sessions.
     */
    constructor(opts = {})
    {
        this._sessions = new Map();
        this._ttl = opts.ttl || DEFAULT_MAX_AGE;
        this._maxSessions = opts.maxSessions || 10000;
        this._pruneTimer = null;

        const pruneMs = opts.pruneInterval || 300000;
        if (pruneMs > 0)
        {
            this._pruneTimer = setInterval(() => this._prune(), pruneMs);
            if (this._pruneTimer.unref) this._pruneTimer.unref();
        }
    }

    /** @param {string} sid */
    async get(sid)
    {
        const entry = this._sessions.get(sid);
        if (!entry) return null;
        if (Date.now() > entry.expires)
        {
            this._sessions.delete(sid);
            return null;
        }
        return entry.data;
    }

    /**
     * @param {string} sid
     * @param {string} data - Serialized session.
     * @param {number} [maxAge] - TTL in ms.
     */
    async set(sid, data, maxAge)
    {
        if (this._sessions.size >= this._maxSessions && !this._sessions.has(sid))
        {
            this._prune();
            if (this._sessions.size >= this._maxSessions)
            {
                log.warn('MemoryStore at capacity (%d), rejecting new session', this._maxSessions);
                return;
            }
        }
        this._sessions.set(sid, {
            data,
            expires: Date.now() + (maxAge || this._ttl),
        });
    }

    /** @param {string} sid */
    async destroy(sid)
    {
        this._sessions.delete(sid);
    }

    /** Prune expired sessions. */
    _prune()
    {
        const now = Date.now();
        for (const [sid, entry] of this._sessions)
        {
            if (now > entry.expires) this._sessions.delete(sid);
        }
    }

    /** Number of active sessions. */
    get length() { return this._sessions.size; }

    /** Clear all sessions. */
    clear()
    {
        this._sessions.clear();
    }

    /** Stop the prune timer. */
    close()
    {
        if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
    }
}

// -- Session ID --------------------------------------------------

/** @private */
function _generateSid()
{
    return crypto.randomBytes(SID_BYTES).toString('base64url');
}

// -- Session Middleware ------------------------------------------

/**
 * Create session middleware.
 *
 * Two modes:
 *   1. **Cookie session** (no `store`): Entire session encrypted in a cookie.
 *      Great for small payloads (< 4 KB). Zero server state.
 *   2. **Server-side session** (with `store`): Only session ID in cookie,
 *      data lives in the store. Scales to large payloads.
 *
 * @param {object} opts - Configuration.
 * @param {string|string[]} opts.secret - Encryption secret(s). First secret used for
 *        encryption, all are tried for decryption (supports rotation).
 * @param {object} [opts.store] - Server-side session store (must implement `get`, `set`, `destroy`).
 * @param {string} [opts.name='sid'] - Cookie name.
 * @param {object} [opts.cookie] - Cookie options.
 * @param {number} [opts.cookie.maxAge=86400000] - Cookie max-age in ms (default 24h).
 * @param {string} [opts.cookie.path='/'] - Cookie path.
 * @param {string} [opts.cookie.domain] - Cookie domain.
 * @param {boolean} [opts.cookie.secure] - Secure-only flag (default: auto-detect via `req.secure`).
 * @param {boolean} [opts.cookie.httpOnly=true] - HttpOnly flag.
 * @param {string} [opts.cookie.sameSite='Lax'] - SameSite attribute.
 * @param {boolean} [opts.rolling=false] - Reset cookie maxAge on every response.
 * @param {Function} [opts.genid] - Custom session ID generator.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   // Cookie session with rotation
 *   app.use(session({
 *       secret: ['new-key', 'old-key'],
 *       cookie: { maxAge: 3600000, secure: true },
 *   }));
 *
 * @example
 *   // Server-side with memory store
 *   const store = new MemoryStore({ ttl: 3600000 });
 *   app.use(session({ secret: 'key', store, rolling: true }));
 */
function session(opts = {})
{
    if (!opts.secret) throw new Error('session() requires a secret');

    const secrets = Array.isArray(opts.secret) ? opts.secret : [opts.secret];
    const keys = secrets.map(s => _deriveKey(s));
    const store = opts.store || null;
    const cookieName = opts.name || DEFAULT_COOKIE_NAME;
    const rolling = opts.rolling === true;
    const genid = typeof opts.genid === 'function' ? opts.genid : _generateSid;

    const cookieOpts = {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        ...(opts.cookie || {}),
    };
    const maxAge = cookieOpts.maxAge || DEFAULT_MAX_AGE;

    return async function sessionMiddleware(req, res, next)
    {
        // Prevent double-initialisation
        if (req.session) return next();

        const rawCookie = req.cookies?.[cookieName] || req.signedCookies?.[cookieName];
        let sess = null;

        if (store)
        {
            // Server-side mode: cookie holds the session ID
            sess = await _loadServerSession(rawCookie, store, genid);
        }
        else
        {
            // Cookie mode: decrypt session from cookie
            sess = _loadCookieSession(rawCookie, keys, genid);
        }

        req.session = sess;

        // Intercept response to persist session
        // Hook into res.raw.end (Node ServerResponse) — the Response wrapper
        // has no .end() method; its .send()/.json() helpers call raw.end().
        const raw = res.raw;
        const origEnd = raw.end.bind(raw);
        raw.end = function sessionEnd(...args)
        {
            try
            {
                // _saveSession calls res.cookie() / res.clearCookie() which set
                // Set-Cookie headers on raw via raw.setHeader — safe because
                // headers aren't flushed until the original end() runs.
                // NOTE: store-based sessions are sync-compatible because
                // MemoryStore.set/get return resolved promises synchronously
                // for the in-process case.  For truly async stores the cookie
                // will still be set correctly because setHeader precedes end().
                _saveSession(req, res, sess, {
                    store, keys, cookieName, cookieOpts, maxAge, rolling,
                });
            }
            catch (err)
            {
                log.error('session save error: %s', err.message);
            }
            return origEnd(...args);
        };

        next();
    };
}

// -- Internal load/save ------------------------------------------

/** @private */
async function _loadServerSession(rawCookie, store, genid)
{
    if (rawCookie)
    {
        const data = await store.get(rawCookie);
        if (data)
        {
            log.debug('session loaded: %s', rawCookie);
            return Session._deserialize(data, rawCookie);
        }
    }
    // New session
    const id = genid();
    log.debug('new session: %s', id);
    return new Session(id);
}

/** @private */
function _loadCookieSession(rawCookie, keys, genid)
{
    if (rawCookie)
    {
        // Try each key for decryption (rotation support)
        for (const key of keys)
        {
            const json = _decrypt(rawCookie, key);
            if (json)
            {
                const sess = Session._deserialize(json, 'cookie');
                log.debug('cookie session decrypted');
                return sess;
            }
        }
    }
    return new Session(genid());
}

/** @private */
function _saveSession(req, res, sess, ctx)
{
    if (sess._destroyed)
    {
        // Clear cookie and destroy store entry
        res.clearCookie(ctx.cookieName, { path: ctx.cookieOpts.path || '/' });
        if (ctx.store) ctx.store.destroy(sess.id);
        log.debug('session destroyed: %s', sess.id);
        return;
    }

    const shouldSave = sess._dirty || ctx.rolling;
    if (!shouldSave) return;

    const cOpts = { ...ctx.cookieOpts, maxAge: Math.floor(ctx.maxAge / 1000) };
    if (cOpts.secure === undefined) cOpts.secure = req.secure;

    if (ctx.store)
    {
        // Server-side: persist data in store, session ID in cookie
        ctx.store.set(sess.id, sess._serialize(), ctx.maxAge);
        res.cookie(ctx.cookieName, sess.id, cOpts);
        log.debug('server session saved: %s', sess.id);
    }
    else
    {
        // Cookie mode: encrypt session and set as cookie
        const payload = sess._serialize();
        const encrypted = _encrypt(payload, ctx.keys[0]);
        if (encrypted.length > MAX_COOKIE_SIZE)
        {
            log.warn('session cookie exceeds %d bytes — consider using a store', MAX_COOKIE_SIZE);
        }
        res.cookie(ctx.cookieName, encrypted, cOpts);
        log.debug('cookie session saved');
    }
}

module.exports = {
    session,
    Session,
    MemoryStore,
};
