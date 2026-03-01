/**
 * @module body/rawBuffer
 * @description Low-level helper that collects the raw request body into a
 *              single Buffer, enforcing an optional byte-size limit.
 */

/**
 * Parse a human-readable size string (e.g. `'10kb'`, `'2mb'`) into bytes.
 *
 * @param {string|number|null} limit - Size limit value.
 * @returns {number|null} Byte limit, or `null` for unlimited.
 */
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

/**
 * Collect the raw request body into a Buffer.
 * Rejects with a `{ status: 413 }` error when `opts.limit` is exceeded.
 *
 * @param {import('../request')} req        - Wrapped request (must have `.raw` stream).
 * @param {object}               [opts]
 * @param {string|number|null}   [opts.limit] - Maximum body size.
 * @returns {Promise<Buffer>} Resolved with the full body buffer.
 */
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
