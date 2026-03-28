/**
 * @module env
 * @description Zero-dependency typed environment variable system.
 *              Loads `.env` files, validates against a typed schema, and
 *              exposes a fast accessor with built-in type coercion.
 *
 *              Supports: string, number, boolean, integer, array, json, url, port, enum.
 *              Multi-environment: `.env`, `.env.local`, `.env.{NODE_ENV}`, `.env.{NODE_ENV}.local`.
 *
 * @example
 *   const { env } = require('zero-http');
 *
 *   env.load({
 *       PORT:            { type: 'port',    default: 3000 },
 *       DATABASE_URL:    { type: 'string',  required: true },
 *       DEBUG:           { type: 'boolean', default: false },
 *       ALLOWED_ORIGINS: { type: 'array',   separator: ',' },
 *       LOG_LEVEL:       { type: 'enum',    values: ['debug','info','warn','error'], default: 'info' },
 *   });
 *
 *   env.PORT          // => 3000 (number)
 *   env('PORT')       // => 3000
 *   env.DEBUG         // => false (boolean)
 *   env.require('DATABASE_URL')  // throws if missing
 */
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
//  .env file parser
// ═══════════════════════════════════════════════════════════

/**
 * Parse a `.env` file string into key-value pairs.
 * Supports `#` comments, single/double/backtick quotes, multiline values,
 * inline comments, interpolation `${VAR}`, and `export` prefix.
 *
 * @param {string} src - Raw file contents.
 * @returns {Object<string, string>} Parsed key-value pairs.
 */
function parse(src)
{
    const result = {};
    const lines = src.replace(/\r\n?/g, '\n').split('\n');

    let i = 0;
    while (i < lines.length)
    {
        let line = lines[i].trim();
        i++;

        // Skip comments and blank lines
        if (!line || line.startsWith('#')) continue;

        // Strip optional `export ` prefix
        if (line.startsWith('export ')) line = line.slice(7).trim();

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();

        // Validate key name — only word chars + dots
        if (!/^[\w.]+$/.test(key)) continue;

        // Quoted values
        const q = value[0];
        if ((q === '"' || q === "'" || q === '`') && value.endsWith(q) && value.length >= 2)
        {
            value = value.slice(1, -1);
        }
        else if (q === '"' || q === "'" || q === '`')
        {
            // Multiline — read until closing quote
            let multiline = value.slice(1);
            while (i < lines.length)
            {
                const nextLine = lines[i];
                i++;
                if (nextLine.trimEnd().endsWith(q))
                {
                    multiline += '\n' + nextLine.trimEnd().slice(0, -1);
                    break;
                }
                multiline += '\n' + nextLine;
            }
            value = multiline;
        }
        else
        {
            // Unquoted — strip inline comment
            const hashIdx = value.indexOf(' #');
            if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
        }

        // Variable interpolation: ${VAR} → process.env.VAR or already-parsed value
        value = value.replace(/\$\{([^}]+)\}/g, (_, name) =>
        {
            return result[name] || process.env[name] || '';
        });

        result[key] = value;
    }

    return result;
}

// ═══════════════════════════════════════════════════════════
//  Type coercion
// ═══════════════════════════════════════════════════════════

/**
 * Coerce a string value to the specified type.
 *
 * @param {string}  raw        - Raw string value.
 * @param {object}  fieldDef   - Schema field definition.
 * @param {string}  key        - Variable name (for error messages).
 * @returns {*} Coerced value.
 * @throws {Error} When the value cannot be coerced or fails validation.
 */
function coerce(raw, fieldDef, key)
{
    const type = fieldDef.type || 'string';

    switch (type)
    {
        case 'string':
        {
            const val = String(raw);
            if (fieldDef.min !== undefined && val.length < fieldDef.min)
                throw new Error(`env "${key}" must be at least ${fieldDef.min} characters`);
            if (fieldDef.max !== undefined && val.length > fieldDef.max)
                throw new Error(`env "${key}" must be at most ${fieldDef.max} characters`);
            if (fieldDef.match && !fieldDef.match.test(val))
                throw new Error(`env "${key}" does not match pattern ${fieldDef.match}`);
            return val;
        }
        case 'number':
        {
            const val = Number(raw);
            if (isNaN(val)) throw new Error(`env "${key}" must be a number, got "${raw}"`);
            if (fieldDef.min !== undefined && val < fieldDef.min)
                throw new Error(`env "${key}" must be >= ${fieldDef.min}`);
            if (fieldDef.max !== undefined && val > fieldDef.max)
                throw new Error(`env "${key}" must be <= ${fieldDef.max}`);
            return val;
        }
        case 'integer':
        {
            const val = parseInt(raw, 10);
            if (isNaN(val)) throw new Error(`env "${key}" must be an integer, got "${raw}"`);
            if (fieldDef.min !== undefined && val < fieldDef.min)
                throw new Error(`env "${key}" must be >= ${fieldDef.min}`);
            if (fieldDef.max !== undefined && val > fieldDef.max)
                throw new Error(`env "${key}" must be <= ${fieldDef.max}`);
            return val;
        }
        case 'port':
        {
            const val = parseInt(raw, 10);
            if (isNaN(val) || val < 0 || val > 65535)
                throw new Error(`env "${key}" must be a valid port (0-65535), got "${raw}"`);
            return val;
        }
        case 'boolean':
        {
            const lower = String(raw).toLowerCase().trim();
            if (['true', '1', 'yes', 'on'].includes(lower)) return true;
            if (['false', '0', 'no', 'off', ''].includes(lower)) return false;
            throw new Error(`env "${key}" must be a boolean, got "${raw}"`);
        }
        case 'array':
        {
            const sep = fieldDef.separator || ',';
            return String(raw).split(sep).map(s => s.trim()).filter(Boolean);
        }
        case 'json':
        {
            try { return JSON.parse(raw); }
            catch (e) { throw new Error(`env "${key}" must be valid JSON: ${e.message}`); }
        }
        case 'url':
        {
            try { new URL(raw); return raw; }
            catch (e) { throw new Error(`env "${key}" must be a valid URL, got "${raw}"`); }
        }
        case 'enum':
        {
            const values = fieldDef.values || [];
            if (!values.includes(raw))
                throw new Error(`env "${key}" must be one of [${values.join(', ')}], got "${raw}"`);
            return raw;
        }
        default:
            return raw;
    }
}

// ═══════════════════════════════════════════════════════════
//  Env store
// ═══════════════════════════════════════════════════════════

/** @type {Object<string, *>} Typed/validated values store */
const _store = {};

/** @type {Object<string, object>} Schema definitions */
let _schema = null;

/** @type {boolean} */
let _loaded = false;

/**
 * Load environment variables from `.env` files and validate against a typed schema.
 *
 * Files are loaded in precedence order (later overrides earlier):
 * 1. `.env` — shared defaults
 * 2. `.env.local` — local overrides (gitignored)
 * 3. `.env.{NODE_ENV}` — environment-specific  (e.g. `.env.production`)
 * 4. `.env.{NODE_ENV}.local` — env-specific local overrides
 *
 * Process environment variables (`process.env`) always take precedence.
 *
 * @param {Object<string, object>} [schema] - Typed schema definition.
 * @param {object} [options]
 * @param {string} [options.path]  - Custom directory to load from (default: `process.cwd()`).
 * @param {boolean} [options.override=false] - When true, overwrite existing `process.env` values with file values.
 *                                            When false (default), file values are written to `process.env` only for keys not already set.
 *                                            Set to `false` explicitly to disable all `process.env` syncing.
 * @returns {Object<string, *>} The validated env store.
 *
 * @throws {Error} On validation failures (missing required vars, bad types, etc.).
 */
function load(schema, options = {})
{
    const dir = options.path || process.cwd();
    const nodeEnv = process.env.NODE_ENV || 'development';

    // Load files in precedence order
    const files = [
        '.env',
        '.env.local',
        `.env.${nodeEnv}`,
        `.env.${nodeEnv}.local`,
    ];

    const raw = {};

    for (const file of files)
    {
        const filePath = path.resolve(dir, file);
        try
        {
            if (fs.existsSync(filePath))
            {
                const content = fs.readFileSync(filePath, 'utf8');
                Object.assign(raw, parse(content));
            }
        }
        catch (e) { /* silently skip unreadable files */ }
    }

    // Process.env always wins
    const merged = {};
    if (schema)
    {
        _schema = schema;
        for (const key of Object.keys(schema))
        {
            if (process.env[key] !== undefined) merged[key] = process.env[key];
            else if (raw[key] !== undefined) merged[key] = raw[key];
        }
    }
    else
    {
        // No schema — load everything
        Object.assign(merged, raw);
        for (const key of Object.keys(raw))
        {
            if (process.env[key] !== undefined) merged[key] = process.env[key];
        }
    }

    // Write file values into process.env unless explicitly disabled
    if (options.override !== false)
    {
        for (const [k, v] of Object.entries(raw))
        {
            if (options.override || process.env[k] === undefined) process.env[k] = v;
        }
    }

    // Validate and coerce
    const errors = [];

    if (schema)
    {
        for (const [key, def] of Object.entries(schema))
        {
            const rawVal = merged[key];

            if (rawVal === undefined || rawVal === '')
            {
                if (def.required)
                {
                    errors.push(`env "${key}" is required but not set`);
                    continue;
                }
                if (def.default !== undefined)
                {
                    _store[key] = typeof def.default === 'function' ? def.default() : def.default;
                }
                else
                {
                    _store[key] = undefined;
                }
                continue;
            }

            try
            {
                _store[key] = coerce(rawVal, def, key);
            }
            catch (e)
            {
                errors.push(e.message);
            }
        }
    }
    else
    {
        // No schema — store raw strings
        Object.assign(_store, merged);
    }

    if (errors.length > 0)
    {
        throw new Error('Environment validation failed:\n  • ' + errors.join('\n  • '));
    }

    // Sync coerced values back to process.env so other modules see them
    if (options.override !== false)
    {
        for (const [k, v] of Object.entries(_store))
        {
            if (v !== undefined)
            {
                process.env[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
        }
    }

    _loaded = true;
    return _store;
}

/**
 * Get a typed environment variable.
 * Can also be called as `env(key)`.
 *
 * @param {string} key - Variable name.
 * @returns {*} The typed value.
 */
function get(key)
{
    if (_store.hasOwnProperty(key)) return _store[key];
    return process.env[key];
}

/**
 * Get a required environment variable. Throws if missing.
 *
 * @param {string} key - Variable name.
 * @returns {*} The typed value.
 * @throws {Error} If the variable is not set.
 */
function require_(key)
{
    const val = get(key);
    if (val === undefined || val === null || val === '')
    {
        throw new Error(`Required environment variable "${key}" is not set`);
    }
    return val;
}

/**
 * Check if a variable is set (not undefined).
 *
 * @param {string} key - Variable name.
 * @returns {boolean}
 */
function has(key)
{
    return _store.hasOwnProperty(key) || process.env.hasOwnProperty(key);
}

/**
 * Get all loaded values as a plain object.
 *
 * @returns {Object<string, *>}
 */
function all()
{
    return { ..._store };
}

/**
 * Reset the env store (useful for testing).
 */
function reset()
{
    for (const k of Object.keys(_store)) delete _store[k];
    _schema = null;
    _loaded = false;
}

// ═══════════════════════════════════════════════════════════
//  Proxy-based accessor — env.PORT, env('PORT'), env.get('PORT')
// ═══════════════════════════════════════════════════════════

/**
 * The env function — callable as `env(key)` or `env.key`.
 *
 * @param {string} key
 * @returns {*}
 */
function envFn(key)
{
    return get(key);
}

// Attach methods
envFn.load = load;
envFn.get = get;
envFn.require = require_;
envFn.has = has;
envFn.all = all;
envFn.reset = reset;
envFn.parse = parse;

// Proxy for dotenv.PORT style access
const envProxy = new Proxy(envFn, {
    get(target, prop)
    {
        // Return own methods first
        if (prop in target) return target[prop];
        // Then check the store
        if (typeof prop === 'string') return get(prop);
        return undefined;
    },
});

module.exports = envProxy;
