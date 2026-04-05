/**
 * @module grpc/metadata
 * @description gRPC metadata container — typed key-value pairs transmitted as
 *              HTTP/2 headers (initial metadata) and trailers (trailing metadata).
 *              Keys ending in `-bin` carry binary values (base64-encoded on the wire).
 *              All other keys carry ASCII string values.
 *
 * @example
 *   const md = new Metadata();
 *   md.set('x-request-id', '123');
 *   md.add('x-tags', 'alpha');
 *   md.add('x-tags', 'beta');
 *   md.getAll('x-tags');  // ['alpha', 'beta']
 *
 * @example | Binary metadata
 *   md.set('icon-bin', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
 *   md.get('icon-bin');  // <Buffer 89 50 4e 47>
 */

const log = require('../debug')('zero:grpc');

/**
 * Reserved HTTP/2 pseudo-headers that must not be treated as gRPC metadata.
 * @type {Set<string>}
 * @private
 */
const RESERVED = new Set([':authority', ':method', ':path', ':scheme', ':status']);

/**
 * Headers managed by the gRPC framing layer, not user metadata.
 * @type {Set<string>}
 * @private
 */
const GRPC_INTERNAL = new Set([
    'content-type', 'te', 'grpc-timeout', 'grpc-encoding',
    'grpc-accept-encoding', 'grpc-status', 'grpc-message',
    'user-agent', 'host',
]);

/**
 * Maximum metadata key length (prevents abuse).
 * @type {number}
 */
const MAX_KEY_LENGTH = 256;

/**
 * Maximum total metadata size in bytes (soft limit — 8 KB default, configurable).
 * @type {number}
 */
const DEFAULT_MAX_METADATA_SIZE = 8192;

// -- Metadata Class ----------------------------------------

/**
 * gRPC metadata container — type-safe key-value pairs for headers and trailers.
 *
 * @class
 *
 * @param {object} [opts] - Configuration options.
 * @param {number} [opts.maxSize=8192] - Maximum total serialized metadata size in bytes.
 *
 * @example
 *   const md = new Metadata();
 *   md.set('authorization', 'Bearer tok123');
 *   md.set('x-trace-id', crypto.randomUUID());
 */
class Metadata
{
    constructor(opts = {})
    {
        /** @private */
        this._map = new Map();
        /** @private */
        this._maxSize = opts.maxSize || DEFAULT_MAX_METADATA_SIZE;
    }

    // -- Core Operations -----------------------------------

    /**
     * Set a metadata key to a single value, replacing any existing values.
     * Binary keys (ending in `-bin`) accept Buffer values; all others accept strings.
     *
     * @param {string} key - Metadata key (lowercase, no whitespace).
     * @param {string|Buffer} value - The value to store.
     * @returns {Metadata} `this` for chaining.
     *
     * @example
     *   md.set('x-request-id', 'abc-123');
     */
    set(key, value)
    {
        key = this._validateKey(key);
        this._validateValue(key, value);
        this._map.set(key, [value]);
        return this;
    }

    /**
     * Add a value to a metadata key without replacing existing values.
     * Allows multi-valued metadata (e.g. multiple tags or roles).
     *
     * @param {string} key - Metadata key.
     * @param {string|Buffer} value - Value to append.
     * @returns {Metadata} `this` for chaining.
     *
     * @example
     *   md.add('x-roles', 'admin');
     *   md.add('x-roles', 'editor');
     *   md.getAll('x-roles');  // ['admin', 'editor']
     */
    add(key, value)
    {
        key = this._validateKey(key);
        this._validateValue(key, value);
        const existing = this._map.get(key);
        if (existing) existing.push(value);
        else this._map.set(key, [value]);
        return this;
    }

    /**
     * Get the first value for a metadata key.
     *
     * @param {string} key - Metadata key.
     * @returns {string|Buffer|undefined} First value, or undefined if not set.
     *
     * @example
     *   md.get('x-request-id');  // 'abc-123'
     */
    get(key)
    {
        key = normalizeKey(key);
        const arr = this._map.get(key);
        return arr ? arr[0] : undefined;
    }

    /**
     * Get all values for a metadata key.
     *
     * @param {string} key - Metadata key.
     * @returns {Array<string|Buffer>} Array of values (empty if key not set).
     *
     * @example
     *   md.getAll('x-roles');  // ['admin', 'editor']
     */
    getAll(key)
    {
        key = normalizeKey(key);
        return this._map.get(key) || [];
    }

    /**
     * Check whether a metadata key has been set.
     *
     * @param {string} key - Metadata key.
     * @returns {boolean}
     */
    has(key)
    {
        return this._map.has(normalizeKey(key));
    }

    /**
     * Remove a metadata key and all its values.
     *
     * @param {string} key - Metadata key.
     * @returns {boolean} `true` if the key existed and was removed.
     */
    remove(key)
    {
        return this._map.delete(normalizeKey(key));
    }

    /**
     * Remove all metadata entries.
     *
     * @returns {Metadata} `this` for chaining.
     */
    clear()
    {
        this._map.clear();
        return this;
    }

    /**
     * Return the number of distinct metadata keys.
     *
     * @returns {number}
     */
    get size()
    {
        return this._map.size;
    }

    // -- Serialization -------------------------------------

    /**
     * Convert metadata to a plain object suitable for HTTP/2 headers/trailers.
     * Multi-valued keys are joined with `, `. Binary values are base64-encoded.
     *
     * @returns {Object<string, string>} Header-compatible object.
     *
     * @example
     *   md.toHeaders();
     *   // { 'x-request-id': 'abc-123', 'x-roles': 'admin, editor' }
     */
    toHeaders()
    {
        const headers = {};
        for (const [key, values] of this._map)
        {
            if (isBinaryKey(key))
            {
                // Binary keys: base64 encode each value, comma-join
                headers[key] = values.map((v) =>
                    Buffer.isBuffer(v) ? v.toString('base64') : Buffer.from(String(v)).toString('base64')
                ).join(', ');
            }
            else
            {
                headers[key] = values.join(', ');
            }
        }
        return headers;
    }

    /**
     * Merge entries from another Metadata instance or plain object.
     *
     * @param {Metadata|Object<string, string|string[]>} other - Source to merge from.
     * @returns {Metadata} `this` for chaining.
     */
    merge(other)
    {
        if (other instanceof Metadata)
        {
            for (const [key, values] of other._map)
            {
                for (const v of values) this.add(key, v);
            }
        }
        else if (other && typeof other === 'object')
        {
            for (const [key, val] of Object.entries(other))
            {
                if (Array.isArray(val))
                {
                    for (const v of val) this.add(key, v);
                }
                else
                {
                    this.add(key, val);
                }
            }
        }
        return this;
    }

    /**
     * Create a shallow clone of this Metadata.
     *
     * @returns {Metadata} New Metadata instance with the same entries.
     */
    clone()
    {
        const md = new Metadata({ maxSize: this._maxSize });
        for (const [key, values] of this._map)
        {
            md._map.set(key, values.slice());
        }
        return md;
    }

    /**
     * Iterate over all entries as `[key, value]` pairs (one entry per value).
     *
     * @yields {[string, string|Buffer]}
     */
    *[Symbol.iterator]()
    {
        for (const [key, values] of this._map)
        {
            for (const v of values) yield [key, v];
        }
    }

    /**
     * Return all entries as an array of `[key, value]` pairs.
     *
     * @returns {Array<[string, string|Buffer]>}
     */
    entries()
    {
        const result = [];
        for (const pair of this) result.push(pair);
        return result;
    }

    /**
     * Return all distinct keys.
     *
     * @returns {string[]}
     */
    keys()
    {
        return Array.from(this._map.keys());
    }

    // -- Validation ----------------------------------------

    /**
     * Validate and normalize a metadata key.
     * @private
     * @param {string} key
     * @returns {string} Normalized key.
     */
    _validateKey(key)
    {
        if (typeof key !== 'string')
            throw new TypeError('Metadata key must be a string');

        key = key.toLowerCase().trim();

        if (key.length === 0)
            throw new Error('Metadata key must not be empty');

        if (key.length > MAX_KEY_LENGTH)
            throw new Error(`Metadata key exceeds max length (${MAX_KEY_LENGTH})`);

        if (RESERVED.has(key))
            throw new Error(`Cannot set reserved pseudo-header: ${key}`);

        if (GRPC_INTERNAL.has(key))
            throw new Error(`Cannot set gRPC internal header: ${key}`);

        // Keys must be lowercase ASCII alphanumeric + hyphen + underscore + period
        if (!/^[a-z0-9_.\-]+$/.test(key))
            throw new Error(`Invalid metadata key: "${key}" (must be lowercase ASCII alphanumeric/hyphen/underscore/period)`);

        return key;
    }

    /**
     * Validate a metadata value.
     * @private
     * @param {string} key
     * @param {string|Buffer} value
     */
    _validateValue(key, value)
    {
        if (isBinaryKey(key))
        {
            if (!Buffer.isBuffer(value) && typeof value !== 'string')
                throw new TypeError(`Binary metadata key "${key}" requires a Buffer or string value`);
        }
        else
        {
            if (typeof value !== 'string')
                throw new TypeError(`Metadata key "${key}" requires a string value`);

            // ASCII printable check (0x20-0x7E)
            for (let i = 0; i < value.length; i++)
            {
                const c = value.charCodeAt(i);
                if (c < 0x20 || c > 0x7E)
                    throw new Error(`Non-ASCII character in metadata value for key "${key}" at position ${i}`);
            }
        }
    }
}

// -- Static Helpers ----------------------------------------

/**
 * Create a Metadata instance from HTTP/2 headers, extracting only user metadata
 * (skipping pseudo-headers, gRPC internal headers, and standard HTTP headers).
 *
 * @param {Object<string, string|string[]>} headers - HTTP/2 headers object.
 * @param {object} [opts] - Options.
 * @param {number} [opts.maxSize=8192] - Maximum metadata size.
 * @returns {Metadata} Populated metadata instance.
 *
 * @example
 *   const md = Metadata.fromHeaders(stream.headers);
 */
Metadata.fromHeaders = function fromHeaders(headers, opts)
{
    const md = new Metadata(opts);
    if (!headers || typeof headers !== 'object') return md;

    for (const [key, rawValue] of Object.entries(headers))
    {
        const k = key.toLowerCase();
        if (RESERVED.has(k) || GRPC_INTERNAL.has(k)) continue;
        // Skip standard HTTP headers that aren't metadata
        if (k === 'accept' || k === 'accept-encoding' || k === 'content-length') continue;

        try
        {
            if (isBinaryKey(k))
            {
                // Base64-decode binary values
                const values = String(rawValue).split(',').map((s) => s.trim());
                for (const v of values)
                {
                    md._map.set(k, md._map.get(k) || []);
                    md._map.get(k).push(Buffer.from(v, 'base64'));
                }
            }
            else
            {
                const values = String(rawValue).split(',').map((s) => s.trim());
                for (const v of values)
                {
                    md._map.set(k, md._map.get(k) || []);
                    md._map.get(k).push(v);
                }
            }
        }
        catch (e)
        {
            log.warn('skipping invalid metadata key=%s: %s', k, e.message);
        }
    }

    return md;
};

// -- Utility Functions -------------------------------------

/**
 * Check if a metadata key is a binary key (ends with `-bin`).
 *
 * @param {string} key - Metadata key.
 * @returns {boolean}
 */
function isBinaryKey(key)
{
    return key.endsWith('-bin');
}

/**
 * Normalize a metadata key to lowercase.
 *
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key)
{
    return typeof key === 'string' ? key.toLowerCase().trim() : '';
}

module.exports = {
    Metadata,
    isBinaryKey,
    normalizeKey,
    RESERVED,
    GRPC_INTERNAL,
    MAX_KEY_LENGTH,
    DEFAULT_MAX_METADATA_SIZE,
};
