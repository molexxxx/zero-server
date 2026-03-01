/**
 * @module body/json
 * @description JSON body-parsing middleware.
 *              Reads the request body, parses it as JSON, and sets `req.body`.
 */
const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Create a JSON body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]    - Max body size (e.g. `'10kb'`).
 * @param {Function}        [options.reviver]  - `JSON.parse` reviver function.
 * @param {boolean}         [options.strict=true] - When true, reject non-object/array roots.
 * @param {string|Function} [options.type='application/json'] - Content-Type to match.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function json(options = {})
{
  const opts = options || {};
  const limit = opts.limit || null;
  const reviver = opts.reviver;
  const strict = (opts.hasOwnProperty('strict')) ? !!opts.strict : true;
  const typeOpt = opts.type || 'application/json';

  return async (req, res, next) =>
  {
    const ct = (req.headers['content-type'] || '');
    if (!isTypeMatch(ct, typeOpt)) return next();
    try
    {
      const buf = await rawBuffer(req, { limit });
      const txt = buf.toString('utf8');
      if (!txt) { req.body = null; return next(); }
      let parsed;
      try { parsed = JSON.parse(txt, reviver); } catch (e) { req.body = null; return next(); }
      if (strict && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) === false && Object.keys(parsed).length === 0 && !Array.isArray(parsed)))
      {
        // If strict, prefer objects/arrays; allow arrays but reject primitives
        if (typeof parsed !== 'object') { req.body = null; return next(); }
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
