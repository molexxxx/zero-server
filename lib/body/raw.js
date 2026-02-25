const rawBuffer = require('./rawBuffer');

function raw(options = {})
{
    const opts = options || {};
    const limit = opts.limit || null;
    const typeOpt = opts.type || null; // accept any by default

    function isTypeMatch(contentType, type)
    {
        if (!type) return true;
        if (typeof type === 'function') return !!type(contentType);
        if (!contentType) return false;
        if (type === '*/*') return true;
        if (type.endsWith('/*')) return contentType.startsWith(type.replace('/*', '/'));
        return contentType.indexOf(type) !== -1;
    }

    return async (req, res, next) =>
    {
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            req.body = await rawBuffer(req, { limit });
        } catch (err)
        {
            if (err && err.status === 413)
            {
                res.statusCode = 413;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'payload too large' }));
                return;
            }
            req.body = Buffer.alloc(0);
        }
        next();
    };
}

module.exports = raw;
