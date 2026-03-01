const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

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
