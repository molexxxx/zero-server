/**
 * @module body/text
 * @description Plain-text body-parsing middleware.
 *              Reads the request body as a string and sets `req.body`.
 */
const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Create a plain-text body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]              - Max body size.
 * @param {string}          [options.encoding='utf8']    - Character encoding.
 * @param {string|Function} [options.type='text/*']      - Content-Type to match.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function text(options = {})
{
  const opts = options || {};
  const limit = opts.limit || null;
  const encoding = opts.encoding || 'utf8';
  const typeOpt = opts.type || 'text/*';

  return async (req, res, next) =>
  {
    const ct = (req.headers['content-type'] || '');
    if (!isTypeMatch(ct, typeOpt)) return next();
    try
    {
      const buf = await rawBuffer(req, { limit });
      req.body = buf.toString(encoding);
    } catch (err)
    {
      if (err && err.status === 413) return sendError(res, 413, 'payload too large');
      req.body = '';
    }
    next();
  };
}

module.exports = text;
