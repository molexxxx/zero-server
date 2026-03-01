const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

function raw(options = {})
{
    const opts = options || {};
    const limit = opts.limit || null;
    const typeOpt = opts.type || 'application/octet-stream';

    return async (req, res, next) =>
    {
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            req.body = await rawBuffer(req, { limit });
        } catch (err)
        {
            if (err && err.status === 413) return sendError(res, 413, 'payload too large');
            req.body = Buffer.alloc(0);
        }
        next();
    };
}

module.exports = raw;
