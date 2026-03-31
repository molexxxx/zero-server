/**
 * @module body/text
 * @description Plain-text body-parsing middleware.
 *              Reads the request body as a string and sets `req.body`.
 *              Stores the raw buffer on `req.rawBody` for signature verification.
 */
const rawBuffer = require('./rawBuffer');
const { charsetFromContentType } = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Create a plain-text body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]              - Max body size. Default `'1mb'`.
 * @param {string}          [options.encoding='utf8']    - Fallback character encoding when Content-Type has no charset.
 * @param {string|string[]|Function} [options.type='text/*'] - Content-Type(s) to match.
 * @param {boolean}         [options.requireSecure=false] - When true, reject non-HTTPS requests with 403.
 * @param {Function}        [options.verify]   - `verify(req, res, buf, encoding)` — called before decoding. Throw to reject with 403.
 * @param {boolean}         [options.inflate=true] - Decompress gzip/deflate/br bodies. When false, compressed bodies return 415.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function text(options = {})
{
  const opts = options || {};
  const limit = opts.limit !== undefined ? opts.limit : '1mb';
  const defaultEncoding = opts.encoding || 'utf8';
  const typeOpt = opts.type || 'text/*';
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
      const encoding = charsetFromContentType(ct) || defaultEncoding;

      // Store raw body for signature verification
      req.rawBody = buf;

      // Optional verification callback
      if (verify)
      {
        try { verify(req, res, buf, encoding); }
        catch (e) { return sendError(res, 403, e.message || 'verification failed'); }
      }

      req.body = buf.toString(encoding);
    } catch (err)
    {
      if (err && err.status === 413) return sendError(res, 413, 'payload too large');
      if (err && err.status === 415) return sendError(res, 415, err.message || 'unsupported encoding');
      req.body = '';
    }
    next();
  };
}

module.exports = text;
