/**
 * @module static
 * @description Static file-serving middleware with MIME detection, directory
 *              index files, extension fallbacks, dotfile policies, caching,
 *              custom header hooks, and HTTP/2 server push for linked assets.
 */
const fs = require('fs');
const path = require('path');
const log = require('../debug')('zero:static');

/**
 * Extension → MIME-type lookup table.
 * @type {Object<string, string>}
 */
const MIME = {
    // Text
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.json': 'application/json',
    '.jsonld': 'application/ld+json',

    // JavaScript / WASM
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.wasm': 'application/wasm',

    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',

    // Fonts
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',

    // Audio
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',

    // Video
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',

    // Documents / Archives
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.7z': 'application/x-7z-compressed',

    // Other
    '.map': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.md': 'text/markdown',
    '.sh': 'application/x-sh',
};

/**
 * Generate a weak ETag from file stats (mtime + size).
 * @private
 * @param {import('fs').Stats} stat - File system stat object.
 * @returns {string} Weak ETag string (e.g. `W/"1a2b-3c4d"`).
 */
function generateETag(stat)
{
    return 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
}

/**
 * Stream a file to the raw Node response, setting Content-Type,
 * Content-Length, ETag, and Last-Modified headers.
 *
 * @private
 * @param {import('./response')} res      - Wrapped response object.
 * @param {string}               filePath - Absolute path to the file.
 * @param {import('fs').Stats}   [stat]   - Pre-fetched `fs.Stats` (for Content-Length).
 * @param {import('./request')}  [req]    - Wrapped request (for conditional checks).
 */
function sendFile(res, filePath, stat, req)
{
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    const raw = res.raw;
    try
    {
        raw.setHeader('Content-Type', ct);
        if (stat)
        {
            if (stat.size) raw.setHeader('Content-Length', stat.size);
            // ETag and Last-Modified for caching
            const etag = generateETag(stat);
            raw.setHeader('ETag', etag);
            raw.setHeader('Last-Modified', stat.mtime.toUTCString());
            raw.setHeader('Accept-Ranges', 'bytes');

            // Conditional request handling (304 Not Modified)
            if (req)
            {
                const ifNoneMatch = req.headers['if-none-match'];
                const ifModifiedSince = req.headers['if-modified-since'];
                if (ifNoneMatch && ifNoneMatch === etag)
                {
                    raw.statusCode = 304;
                    raw.end();
                    return;
                }
                if (ifModifiedSince && !ifNoneMatch)
                {
                    const since = Date.parse(ifModifiedSince);
                    if (!isNaN(since) && stat.mtimeMs <= since)
                    {
                        raw.statusCode = 304;
                        raw.end();
                        return;
                    }
                }

                // Range request support (HTTP 206)
                const rangeHeader = req.headers['range'];
                if (rangeHeader && stat.size > 0)
                {
                    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
                    if (match)
                    {
                        let start = match[1] ? parseInt(match[1], 10) : 0;
                        let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
                        if (!match[1] && match[2])
                        {
                            // suffix range: bytes=-500 means last 500 bytes
                            start = Math.max(0, stat.size - parseInt(match[2], 10));
                            end = stat.size - 1;
                        }
                        if (start > end || start >= stat.size || end >= stat.size)
                        {
                            raw.statusCode = 416;
                            raw.setHeader('Content-Range', 'bytes */' + stat.size);
                            raw.setHeader('Content-Length', 0);
                            raw.end();
                            return;
                        }
                        raw.statusCode = 206;
                        raw.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
                        raw.setHeader('Content-Length', end - start + 1);
                        const stream = fs.createReadStream(filePath, { start, end });
                        stream.on('error', (err) => { log.warn('file read error %s: %s', filePath, err.message); try { raw.statusCode = 404; raw.end(); } catch (e) { } });
                        log.debug('serving %s (range %d-%d)', filePath, start, end);
                        stream.pipe(raw);
                        return;
                    }
                }
            }
        }
    }
    catch (e) { /* best-effort */ }
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => { log.warn('file read error %s: %s', filePath, err.message); try { raw.statusCode = 404; raw.end(); } catch (e) { } });
    log.debug('serving %s', filePath);
    stream.pipe(raw);
}

/**
 * Create a static-file-serving middleware.
 *
 * @param {string} root              - Root directory to serve files from.
 * @param {object} [options] - Configuration options.
 * @param {string|false}  [options.index='index.html'] - Default file for directory requests, or `false` to disable.
 * @param {number}        [options.maxAge=0]           - `Cache-Control` max-age in **milliseconds**.
 * @param {string}        [options.dotfiles='ignore']  - Dotfile policy: `'allow'` | `'deny'` | `'ignore'`.
 * @param {string[]}      [options.extensions]         - Array of fallback extensions (e.g. `['html', 'htm']`).
 * @param {Function}      [options.setHeaders]         - `(res, filePath) => void` hook to set custom headers.
 * @param {string[]|Function} [options.pushAssets]      - HTTP/2 server push. Array of paths
 *        (relative to root) to push when serving HTML files, or a function `(filePath) => string[]`.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(serveStatic('public'));                            // serve ./public
 *   app.use(serveStatic('dist', { maxAge: 86400000 }));       // 1-day cache
 *   app.use(serveStatic('assets', { extensions: ['html'] })); // .html fallback
 *
 * @example
 *   // HTTP/2 server push — push critical CSS/JS when serving HTML
 *   app.use(serveStatic('public', {
 *       pushAssets: ['/styles/main.css', '/modules/app.js'],
 *   }));
 */
function serveStatic(root, options = {})
{
    root = path.resolve(root);
    const index = options.hasOwnProperty('index') ? options.index : 'index.html';
    const maxAge = options.hasOwnProperty('maxAge') ? options.maxAge : 0;
    const dotfiles = options.hasOwnProperty('dotfiles') ? options.dotfiles : 'ignore'; // allow|deny|ignore
    const extensions = Array.isArray(options.extensions) ? options.extensions : null;
    const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;
    const pushAssets = options.pushAssets || null;

    function isDotfile(p)
    {
        return path.basename(p).startsWith('.');
    }

    function applyHeaders(res, filePath)
    {
        if (maxAge) try { res.raw.setHeader('Cache-Control', 'max-age=' + Math.floor(Number(maxAge) / 1000)); } catch (e) { }
        if (setHeaders) try { setHeaders(res, filePath); } catch (e) { }
    }

    /**
     * Push linked assets via HTTP/2 server push when serving HTML files.
     * @private
     */
    function pushLinkedAssets(res, filePath)
    {
        if (!pushAssets) return;
        // Only push for HTML files
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.html' && ext !== '.htm') return;
        // Only push on HTTP/2 connections
        if (!res.supportsPush) return;

        const assets = typeof pushAssets === 'function'
            ? pushAssets(filePath)
            : pushAssets;

        if (!Array.isArray(assets)) return;

        for (const assetPath of assets)
        {
            const absPath = path.resolve(root, '.' + path.sep + assetPath);
            // Security: verify asset is within root
            if (!absPath.startsWith(root + path.sep) && absPath !== root) continue;
            res.push(assetPath, { filePath: absPath });
        }
    }

    return (req, res, next) =>
    {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let urlPath;
        try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { return res.status(400).json({ error: 'Bad Request' }); }

        // Block null bytes (poison byte attack)
        if (urlPath.indexOf('\0') !== -1) return res.status(400).json({ error: 'Bad Request' });

        let file = path.resolve(root, '.' + path.sep + urlPath);
        // Normalize and verify the resolved path is within root (prevents path traversal)
        if (!file.startsWith(root + path.sep) && file !== root) return res.status(403).json({ error: 'Forbidden' });

        if (isDotfile(file) && dotfiles === 'deny') return res.status(403).json({ error: 'Forbidden' });

        fs.stat(file, (err, st) =>
        {
            if (err)
            {
                // try extensions fallback
                if (extensions && !urlPath.endsWith('/'))
                {
                    (function tryExt(i)
                    {
                        if (i >= extensions.length) return next();
                        const ext = extensions[i].startsWith('.') ? extensions[i] : '.' + extensions[i];
                        const f = file + ext;
                        fs.stat(f, (e2, st2) =>
                        {
                            if (!e2 && st2 && st2.isFile())
                            {
                                if (isDotfile(f) && dotfiles === 'deny') return res.status(403).json({ error: 'Forbidden' });
                                applyHeaders(res, f);
                                pushLinkedAssets(res, f);
                                return sendFile(res, f, st2, req);
                            }
                            tryExt(i + 1);
                        });
                    })(0);
                    return;
                }
                return next();
            }

            if (st.isDirectory())
            {
                if (!index) return next();
                const idxFile = path.join(file, index);
                fs.stat(idxFile, (err2, st2) =>
                {
                    if (err2) return next();
                    if (isDotfile(idxFile) && dotfiles === 'deny') return res.status(403).json({ error: 'Forbidden' });
                    applyHeaders(res, idxFile);
                    pushLinkedAssets(res, idxFile);
                    sendFile(res, idxFile, st2, req);
                });
            }
            else
            {
                if (isDotfile(file) && dotfiles === 'ignore') return next();
                if (isDotfile(file) && dotfiles === 'deny') return res.status(403).json({ error: 'Forbidden' });
                applyHeaders(res, file);
                pushLinkedAssets(res, file);
                sendFile(res, file, st, req);
            }
        });
    };
}

module.exports = serveStatic;
