/**
 * @module body/json
 * @description JSON body-parsing middleware.
 *              Reads the request body, parses it as JSON, and sets `req.body`.
 *              Stores the raw buffer on `req.rawBody` for signature verification.
 */
const rawBuffer = require('./rawBuffer');
const { charsetFromContentType } = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/** Recursively remove __proto__, constructor, and prototype keys to prevent prototype pollution. */
function _sanitize(obj)
{
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++)
    {
        const k = keys[i];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype')
        {
            delete obj[k];
        }
        else if (typeof obj[k] === 'object' && obj[k] !== null)
        {
            _sanitize(obj[k]);
        }
    }
}

/**
 * Create a JSON body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]    - Max body size (e.g. `'10kb'`). Default `'1mb'`.
 * @param {Function}        [options.reviver]  - `JSON.parse` reviver function.
 * @param {boolean}         [options.strict=true] - When true, reject non-object/array roots.
 * @param {string|string[]|Function} [options.type='application/json'] - Content-Type(s) to match.
 * @param {boolean}         [options.requireSecure=false] - When true, reject non-HTTPS requests with 403.
 * @param {Function}        [options.verify]   - `verify(req, res, buf, encoding)` — called before parsing. Throw to reject with 403.
 * @param {boolean}         [options.inflate=true] - Decompress gzip/deflate/br bodies. When false, compressed bodies return 415.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function json(options = {})
{
  const opts = options || {};
  const limit = opts.limit !== undefined ? opts.limit : '1mb';
  const reviver = opts.reviver;
  const strict = (opts.hasOwnProperty('strict')) ? !!opts.strict : true;
  const typeOpt = opts.type || 'application/json';
  const requireSecure = !!opts.requireSecure;
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
      const encoding = charsetFromContentType(ct) || 'utf8';

      // Store raw body for webhook signature verification (Stripe, GitHub, etc.)
      req.rawBody = buf;

      // Optional verification callback (e.g. HMAC signature check)
      if (verify)
      {
        try { verify(req, res, buf, encoding); }
        catch (e) { return sendError(res, 403, e.message || 'verification failed'); }
      }

      const txt = buf.toString(encoding);
      if (!txt) { req.body = null; return next(); }
      let parsed;
      try { parsed = JSON.parse(txt, reviver); } catch (e) { return sendError(res, 400, 'invalid JSON'); }
      if (strict && (typeof parsed !== 'object' || parsed === null))
      {
        return sendError(res, 400, 'invalid JSON: root must be object or array');
      }
      // Prevent prototype pollution
      if (parsed && typeof parsed === 'object')
      {
        _sanitize(parsed);
      }
      req.body = parsed;
    } catch (err)
    {
      if (err && err.status === 413) return sendError(res, 413, 'payload too large');
      if (err && err.status === 415) return sendError(res, 415, err.message || 'unsupported encoding');
      req.body = null;
    }
    next();
  };
}

module.exports = json;
