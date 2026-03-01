/**
 * In-memory rate-limiting middleware.
 * Limits requests per IP address within a sliding window.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.windowMs=60000]   - Time window in milliseconds.
 * @param {number}  [opts.max=100]          - Maximum requests per window per IP.
 * @param {string}  [opts.message]          - Custom error message.
 * @param {number}  [opts.statusCode=429]   - HTTP status for rate-limited responses.
 * @param {function} [opts.keyGenerator]    - (req) => string; custom key extraction (default: req.ip).
 * @returns {function} Middleware function.
 */
function rateLimit(opts = {})
{
    const windowMs = opts.windowMs || 60_000;
    const max = opts.max || 100;
    const statusCode = opts.statusCode || 429;
    const message = opts.message || 'Too many requests, please try again later.';
    const keyGenerator = typeof opts.keyGenerator === 'function' ? opts.keyGenerator : (req) => req.ip || 'unknown';

    const hits = new Map(); // key → { count, resetTime }

    // Periodic cleanup to prevent memory leaks
    const cleanupInterval = setInterval(() =>
    {
        const now = Date.now();
        for (const [key, entry] of hits)
        {
            if (now >= entry.resetTime) hits.delete(key);
        }
    }, windowMs);
    if (cleanupInterval.unref) cleanupInterval.unref();

    return (req, res, next) =>
    {
        const key = keyGenerator(req);
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || now >= entry.resetTime)
        {
            entry = { count: 0, resetTime: now + windowMs };
            hits.set(key, entry);
        }

        entry.count++;

        // Set rate-limit headers
        const remaining = Math.max(0, max - entry.count);
        res.set('X-RateLimit-Limit', String(max));
        res.set('X-RateLimit-Remaining', String(remaining));
        res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

        if (entry.count > max)
        {
            res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
            return res.status(statusCode).json({ error: message });
        }

        next();
    };
}

module.exports = rateLimit;
