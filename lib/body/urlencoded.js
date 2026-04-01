/**
 * @module body/urlencoded
 * @description URL-encoded body-parsing middleware.
 *              Supports both flat (`URLSearchParams`) and extended
 *              (nested bracket syntax) parsing modes.
 *              Stores the raw buffer on `req.rawBody` for signature verification.
 */
const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Append a value to an existing key, converting to an array when needed.
 *
 * @param {*}      prev - Previous value for the key (or `undefined`).
 * @param {string} val  - New value to append.
 * @returns {string|string[]} Merged value.
 */
function appendValue(prev, val)
{
    if (prev === undefined) return val;
    if (Array.isArray(prev)) { prev.push(val); return prev; }
    // convert existing scalar or object into array to hold multiple values
    return [prev, val];
}

/**
 * Create a URL-encoded body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]     - Max body size (e.g. `'10kb'`). Default `'1mb'`.
 * @param {string|string[]|Function} [options.type='application/x-www-form-urlencoded'] - Content-Type(s) to match.
 * @param {boolean}         [options.extended=false] - Use nested bracket parsing (e.g. `a[b][c]=1`).
 * @param {boolean}         [options.requireSecure=false] - When true, reject non-HTTPS requests with 403.
 * @param {number}          [options.parameterLimit=1000] - Max number of parameters. Prevents DoS via huge payloads.
 * @param {number}          [options.depth=32]  - Max nesting depth for bracket syntax. Prevents deep-nesting DoS.
 * @param {Function}        [options.verify]    - `verify(req, res, buf, encoding)` — called before parsing. Throw to reject with 403.
 * @param {boolean}         [options.inflate=true] - Decompress gzip/deflate/br bodies.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function urlencoded(options = {})
{
    const opts = options || {};
    const limit = opts.limit !== undefined ? opts.limit : '1mb';
    const typeOpt = opts.type || 'application/x-www-form-urlencoded';
    const extended = !!opts.extended;
    const requireSecure = !!opts.requireSecure;
    const parameterLimit = opts.parameterLimit !== undefined ? opts.parameterLimit : 1000;
    const maxDepth = opts.depth !== undefined ? opts.depth : 32;
    const verify = opts.verify;
    const inflate = opts.inflate !== undefined ? opts.inflate : true;

    return async (req, res, next) =>
    {
        if (requireSecure && !req.secure) return sendError(res, 403, 'HTTPS required');
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            const buf = await rawBuffer(req, { limit, inflate });

            // Store raw body for signature verification
            req.rawBody = buf;

            // Optional verification callback
            if (verify)
            {
                try { verify(req, res, buf, 'utf8'); }
                catch (e) { return sendError(res, 403, e.message || 'verification failed'); }
            }

            const txt = buf.toString('utf8');
            if (!extended)
            {
                const params = new URLSearchParams(txt);
                // Enforce parameter limit
                if (parameterLimit)
                {
                    let count = 0;
                    for (const _ of params) { if (++count > parameterLimit) return sendError(res, 413, 'too many parameters'); }
                }
                req.body = Object.fromEntries(params);
            }
            else
            {
                // extended parsing: support nested bracket syntax like a[b][c]=1 and arrays a[]=1
                const out = {};
                if (txt.trim() === '') { req.body = out; return next(); }
                const pairs = txt.split('&');
                // Enforce parameter limit
                if (parameterLimit && pairs.length > parameterLimit)
                {
                    return sendError(res, 413, 'too many parameters');
                }
                for (const p of pairs)
                {
                    if (!p) continue;
                    const eq = p.indexOf('=');
                    let k, v;
                    if (eq === -1) { k = decodeURIComponent(p.replace(/\+/g, ' ')); v = ''; }
                    else { k = decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')); v = decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' ')); }
                    // parse key into parts
                    const parts = [];
                    const re = /([^\[\]]+)|\[(.*?)\]/g;
                    let m;
                    while ((m = re.exec(k)) !== null)
                    {
                        const part = m[1] || m[2];
                        // Prevent prototype pollution
                        if (part === '__proto__' || part === 'constructor' || part === 'prototype') continue;
                        parts.push(part);
                    }

                    // Enforce depth limit
                    if (maxDepth && parts.length > maxDepth)
                    {
                        return sendError(res, 400, 'nesting depth exceeded');
                    }

                    // set value into out following parts
                    // _parent/_parentKey track the container holding `cur` so we can
                    // convert it from object → array when the `[]` push syntax is used.
                    let cur = out;
                    let _parent = null;
                    let _parentKey = null;
                    for (let i = 0; i < parts.length; i++)
                    {
                        const part = parts[i];
                        const isLast = (i === parts.length - 1);

                        if (part === '')
                        {
                            // Empty-bracket array-push syntax: a[]=val  /  a[][key]=val
                            if (isLast)
                            {
                                // Ensure cur is an array before pushing, converting parent ref if needed
                                if (!Array.isArray(cur))
                                {
                                    const arr = [];
                                    if (_parent !== null) _parent[_parentKey] = arr;
                                    cur = arr;
                                }
                                cur.push(v);
                                break;
                            }
                            // Intermediate empty bracket — navigate into next element of the array
                            if (!Array.isArray(cur))
                            {
                                const arr = [];
                                if (_parent !== null) _parent[_parentKey] = arr;
                                cur = arr;
                            }
                            if (cur.length === 0 || typeof cur[cur.length - 1] !== 'object') cur.push({});
                            _parent = cur;
                            _parentKey = cur.length - 1;
                            cur = cur[cur.length - 1];
                            continue;
                        }

                        // normal key
                        if (isLast)
                        {
                            if (Array.isArray(cur))
                            {
                                // numeric key may indicate index
                                const idx = Number(part);
                                if (!Number.isNaN(idx)) cur[idx] = appendValue(cur[idx], v);
                                else cur[part] = appendValue(cur[part], v);
                            }
                            else
                            {
                                cur[part] = appendValue(cur[part], v);
                            }
                        }
                        else
                        {
                            if (Array.isArray(cur))
                            {
                                const idx = Number(part);
                                if (!Number.isNaN(idx))
                                {
                                    if (!cur[idx]) cur[idx] = {};
                                    _parent = cur;
                                    _parentKey = idx;
                                    cur = cur[idx];
                                } else
                                {
                                    // Non-numeric key on array — navigate into last pushed object
                                    if (cur.length === 0) cur.push({});
                                    if (typeof cur[cur.length - 1] !== 'object') cur.push({});
                                    const obj = cur[cur.length - 1];
                                    if (!obj[part]) obj[part] = {};
                                    _parent = obj;
                                    _parentKey = part;
                                    cur = obj[part];
                                }
                            }
                            else
                            {
                                if (!cur[part]) cur[part] = {};
                                _parent = cur;
                                _parentKey = part;
                                cur = cur[part];
                            }
                        }
                    }
                }
                req.body = out;
            }
        } catch (err)
        {
            if (err && err.status === 413) return sendError(res, 413, 'payload too large');
            if (err && err.status === 415) return sendError(res, 415, err.message || 'unsupported encoding');
            req.body = {};
        }
        next();
    };
}

module.exports = urlencoded;
