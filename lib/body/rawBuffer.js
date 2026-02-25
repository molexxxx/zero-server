const { StringDecoder } = require('string_decoder');

function parseLimit(limit)
{
    if (!limit && limit !== 0) return null;
    if (typeof limit === 'number') return limit;
    if (typeof limit === 'string')
    {
        const v = limit.trim().toLowerCase();
        const num = Number(v.replace(/[^0-9.]/g, ''));
        if (v.endsWith('kb')) return Math.floor(num * 1024);
        if (v.endsWith('mb')) return Math.floor(num * 1024 * 1024);
        if (v.endsWith('gb')) return Math.floor(num * 1024 * 1024 * 1024);
        return Math.floor(num);
    }
    return null;
}

function rawBuffer(req, opts = {})
{
    const limit = parseLimit(opts.limit);
    return new Promise((resolve, reject) =>
    {
        const chunks = [];
        let total = 0;
        function onData(c)
        {
            total += c.length;
            if (limit && total > limit)
            {
                // stop reading and reject with a status property
                req.raw.removeListener('data', onData);
                req.raw.removeListener('end', onEnd);
                req.raw.removeListener('error', onError);
                const err = new Error('payload too large');
                err.status = 413;
                return reject(err);
            }
            chunks.push(c);
        }
        function onEnd()
        {
            resolve(Buffer.concat(chunks));
        }
        function onError(e)
        {
            reject(e);
        }
        req.raw.on('data', onData);
        req.raw.on('end', onEnd);
        req.raw.on('error', onError);
    });
}

module.exports = rawBuffer;
