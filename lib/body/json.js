/**
 * @module body/json
 * @description JSON body-parsing middleware.
 *              Reads the request body, parses it as JSON, and sets `req.body`.
 */
const rawBuffer = require('./rawBuffer');
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
 * @param {string|number}   [options.limit]    - Max body size (e.g. `'10kb'`).
 * @param {Function}        [options.reviver]  - `JSON.parse` reviver function.
 * @param {boolean}         [options.strict=true] - When true, reject non-object/array roots.
 * @param {string|Function} [options.type='application/json'] - Content-Type to match.
 * @param {boolean}         [options.requireSecure=false] - When true, reject non-HTTPS requests with 403.
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

  return async (req, res, next) =>
  {
    if (requireSecure && !req.secure) return sendError(res, 403, 'HTTPS required');
    const ct = (req.headers['content-type'] || '');
    if (!isTypeMatch(ct, typeOpt)) return next();
    try
    {
      const buf = await rawBuffer(req, { limit });
      const txt = buf.toString('utf8');
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
      req.body = null;
    }
    next();
  };
}

module.exports = json;
