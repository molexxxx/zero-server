const rawBuffer = require('./rawBuffer');

function isTypeMatch(contentType, typeOpt)
{
  if (!typeOpt) return true;
  if (typeof typeOpt === 'function') return !!typeOpt(contentType);
  if (!contentType) return false;
  if (typeOpt === '*/*') return true;
  if (typeOpt.endsWith('/*')) return contentType.startsWith(typeOpt.replace('/*', '/'));
  return contentType.indexOf(typeOpt) !== -1;
}

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
      if (err && err.status === 413)
      {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      req.body = '';
    }
    next();
  };
}

module.exports = text;
