const fs = require('fs');
const path = require('path');

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

function sendFile(res, filePath, stat)
{
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    const raw = res.raw;
    try
    {
        raw.setHeader('Content-Type', ct);
        if (stat && stat.size) raw.setHeader('Content-Length', stat.size);
    }
    catch (e) { /* best-effort */ }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { raw.statusCode = 404; raw.end(); } catch (e) { } });
    stream.pipe(raw);
}

function serveStatic(root, options = {})
{
    root = path.resolve(root);
    const index = options.hasOwnProperty('index') ? options.index : 'index.html';
    const maxAge = options.hasOwnProperty('maxAge') ? options.maxAge : 0;
    const dotfiles = options.hasOwnProperty('dotfiles') ? options.dotfiles : 'ignore'; // allow|deny|ignore
    const extensions = Array.isArray(options.extensions) ? options.extensions : null;
    const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;

    function isDotfile(p)
    {
        return path.basename(p).startsWith('.');
    }

    function applyHeaders(res, filePath)
    {
        if (maxAge) try { res.raw.setHeader('Cache-Control', 'max-age=' + Math.floor(Number(maxAge) / 1000)); } catch (e) { }
        if (setHeaders) try { setHeaders(res, filePath); } catch (e) { }
    }

    return (req, res, next) =>
    {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        let file = path.join(root, urlPath);
        if (!file.startsWith(root)) return res.status(403).json({ error: 'Forbidden' });

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
                                return sendFile(res, f, st2);
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
                    sendFile(res, idxFile, st2);
                });
            }
            else
            {
                if (isDotfile(file) && dotfiles === 'ignore') return next();
                if (isDotfile(file) && dotfiles === 'deny') return res.status(403).json({ error: 'Forbidden' });
                applyHeaders(res, file);
                sendFile(res, file, st);
            }
        });
    };
}

module.exports = serveStatic;
