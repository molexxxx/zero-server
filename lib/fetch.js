const http = require('http');
const https = require('https');
const { URL } = require('url');

function miniFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const method = (opts.method || 'GET').toUpperCase();
            const headers = Object.assign({}, opts.headers || {});

            // Normalize body
            let body = opts.body;
            if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && !(body.pipe)) {
                // treat as JSON
                if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
                body = Buffer.from(JSON.stringify(body), 'utf8');
            } else if (body instanceof ArrayBuffer) {
                body = Buffer.from(body);
            } else if (body && body instanceof Uint8Array && !Buffer.isBuffer(body)) {
                body = Buffer.from(body);
            }

            // If body is Buffer or string and content-length not set, set it
            if ((Buffer.isBuffer(body) || typeof body === 'string') && !headers['Content-Length'] && !headers['content-length']) {
                const len = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
                headers['Content-Length'] = String(len);
            }

            const options = {
                method,
                headers,
            };

            const req = lib.request(u, options, (res) => {
                const chunks = [];
                let downloaded = 0;
                const total = parseInt(res.headers['content-length'] || res.headers['Content-Length'] || 0) || null;
                res.on('data', (c) => {
                    chunks.push(c);
                    downloaded += c.length;
                    if (typeof opts.onDownloadProgress === 'function') {
                        try { opts.onDownloadProgress({ loaded: downloaded, total }); } catch (e) {}
                    }
                });
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        arrayBuffer: () => Promise.resolve(buf),
                        text: () => Promise.resolve(buf.toString('utf8')),
                        json: () => {
                            try { return Promise.resolve(JSON.parse(buf.toString('utf8'))); }
                            catch (e) { return Promise.reject(e); }
                        }
                    });
                });
            });

            req.on('error', reject);

            // Handle upload progress
            if (body && body.pipe && typeof body.pipe === 'function') {
                // stream
                let uploaded = 0;
                body.on('data', (chunk) => {
                    uploaded += chunk.length;
                    if (typeof opts.onUploadProgress === 'function') {
                        try { opts.onUploadProgress({ loaded: uploaded, total: headers['Content-Length'] ? Number(headers['Content-Length']) : null }); } catch (e) {}
                    }
                });
                body.on('error', (err) => req.destroy(err));
                body.pipe(req);
            } else if (Buffer.isBuffer(body) || typeof body === 'string') {
                const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
                const total = buf.length;
                const chunkSize = 64 * 1024;
                let sent = 0;
                // write in chunks to allow progress notifications
                function writeNext() {
                    if (sent >= total) { req.end(); return; }
                    const toSend = buf.slice(sent, Math.min(sent + chunkSize, total));
                    const ok = req.write(toSend, () => {
                        sent += toSend.length;
                        if (typeof opts.onUploadProgress === 'function') {
                            try { opts.onUploadProgress({ loaded: sent, total }); } catch (e) {}
                        }
                        writeNext();
                    });
                    if (!ok) {
                        req.once('drain', () => writeNext());
                    }
                }
                writeNext();
            } else if (body == null) {
                req.end();
            } else {
                // unknown body, try to send as string
                const s = String(body);
                req.write(s);
                req.end();
            }
        } catch (e) { reject(e); }
    });
}

module.exports = miniFetch;
