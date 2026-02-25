/**
 * Controller for proxy endpoint using built-in fetch.
 * Proxies an external URL provided via ?url= query parameter.
 */
exports.proxy = (fetch) => async (req, res) =>
{
    const url = req.query.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url))
    {
        return res.status(400).json({ error: 'Missing or invalid url query parameter (must start with http/https)' });
    }

    // helper: normalize headers object from various fetch implementations
    const normalizeResponseHeaders = (headers) =>
    {
        const out = {};
        if (!headers) return out;
        if (typeof headers.raw === 'function')
        {
            try { Object.assign(out, headers.raw() || {}); } catch (e) { }
            return out;
        }
        if (headers.raw && typeof headers.raw === 'object')
        {
            Object.assign(out, headers.raw);
            return out;
        }
        if (typeof headers.entries === 'function')
        {
            for (const [k, v] of headers.entries()) { out[k] = out[k] ? out[k] + ', ' + v : v; }
            return out;
        }
        if (typeof headers === 'object')
        {
            Object.assign(out, headers);
        }
        return out;
    };

    try
    {
        // forward client headers useful for media requests
        const forwardHeaders = {};
        try
        {
            const inHeaders = (req.raw && req.raw.headers) ? req.raw.headers : (req.headers || {});
            ['range', 'if-range', 'accept', 'accept-encoding', 'user-agent'].forEach(h =>
            {
                const v = inHeaders[h] || inHeaders[h.toLowerCase()];
                if (v) forwardHeaders[h] = v;
            });
        } catch (e) { }

        const r = await fetch(url, { headers: forwardHeaders });

        // if upstream returned an error status, try to show body (json or text)
        if (r.status >= 400)
        {
            try
            {
                const j = await r.json();
                return res.status(r.status).json(j);
            } catch (e)
            {
                try { const txt = await r.text(); return res.status(r.status).send(txt); } catch (e2) { return res.status(r.status).send('Upstream error'); }
            }
        }

        // If JSON response, parse and return JSON
        const headersObj = normalizeResponseHeaders(r.headers);
        const contentType = (headersObj['content-type'] || headersObj['Content-Type'] || '').toString();
        if (contentType.includes('application/json'))
        {
            const body = await r.json();
            return res.status(r.status).json(body);
        }

        // Forward headers to raw response before streaming
        try { res.raw.statusCode = r.status; } catch (e) { }
        try
        {
            Object.entries(headersObj).forEach(([k, v]) =>
            {
                try { res.raw.setHeader(k, Array.isArray(v) ? v.join(', ') : v); } catch (e) { }
            });
        } catch (e) { }

        // If upstream exposes a readable stream, pipe it directly to client
        if (r.body && typeof r.body.pipe === 'function')
        {
            try
            {
                r.body.on && r.body.on('error', () => { try { res.raw.end(); } catch (e) { } });
                return r.body.pipe(res.raw);
            } catch (e) { /* fallthrough to buffering */ }
        }

        // Fallback: buffer then send (some fetch implementations)
        try
        {
            const ab = await r.arrayBuffer();
            const buf = Buffer.from(ab);
            return res.raw.end(buf);
        } catch (e)
        {
            return res.status(500).json({ error: 'Failed to stream proxied response' });
        }
    } catch (e)
    {
        return res.status(500).json({ error: String(e) });
    }
};
try { rawHeaders = r.headers.raw(); } catch (e) { rawHeaders = {}; }
