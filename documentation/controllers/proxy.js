/**
 * Controller for proxy endpoint using built-in fetch.
 * Proxies an external URL provided via ?url= query parameter.
 * Example: /proxy?url=https://jsonplaceholder.typicode.com/todos/1
 */
exports.proxy = (fetch) => async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        return res.status(400).json({ error: 'Missing or invalid url query parameter (must start with http/https)' });
    }
    try {
        const r = await fetch(url);
        const contentType = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';
        let body;
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            body = await r.json();
        } else {
            body = await r.text();
        }
        // If the proxied response is JSON, return it wrapped in JSON for the demo UI.
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            return res.status(r.status).json({ proxied: body, status: r.status, headers: r.headers });
        }

        // For non-JSON (binary/text) responses, stream the raw body back to the client
        try {
            const ab = await r.arrayBuffer();
            const buf = Buffer.from(ab);
            // copy relevant headers (content-type, content-length) to the raw response
            try { res.raw.statusCode = r.status; } catch (e) { }
            try { if (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) res.raw.setHeader('Content-Type', r.headers['content-type'] || r.headers['Content-Type']); } catch (e) { }
            try { if (r.headers && (r.headers['content-length'] || r.headers['Content-Length'])) res.raw.setHeader('Content-Length', r.headers['content-length'] || r.headers['Content-Length']); } catch (e) { }
            // send the raw buffer
            try { return res.raw.end(buf); } catch (e) { /* fallback */ }
        } catch (e) {
            return res.status(500).json({ error: 'Failed to stream proxied response' });
        }
    } catch (e) {
        return res.status(500).json({ error: String(e) });
    }
};
