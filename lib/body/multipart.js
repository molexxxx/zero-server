const fs = require('fs');
const os = require('os');
const path = require('path');

function uniqueName(prefix = 'miniex')
{
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function ensureDir(dir)
{
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
}

function parseHeaders(headerText)
{
    const lines = headerText.split('\r\n');
    const obj = {};
    for (const l of lines)
    {
        const idx = l.indexOf(':');
        if (idx === -1) continue;
        const k = l.slice(0, idx).trim().toLowerCase();
        const v = l.slice(idx + 1).trim();
        obj[k] = v;
    }
    return obj;
}

function parseContentDisposition(cd)
{
    const m = /form-data;(.*)/i.exec(cd);
    if (!m) return {};
    const parts = m[1].split(';').map(s => s.trim());
    const out = {};
    for (const p of parts)
    {
        const mm = /([^=]+)="?([^"]+)"?/.exec(p);
        if (mm) out[mm[1]] = mm[2];
    }
    return out;
}

// streaming multipart parser that writes files to temp dir and collects fields
function multipart(opts = {})
{
    return async (req, res, next) =>
    {
        const ct = req.headers['content-type'] || '';
        const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
        if (!m) return next();
        const boundary = (m[1] || m[2] || '').replace(/^"|"$/g, '');
        const dashBoundary = `--${boundary}`;
        const dashBoundaryBuf = Buffer.from('\r\n' + dashBoundary);
        const startBoundaryBuf = Buffer.from(dashBoundary);

        let tmpDir;
        if (opts.dir)
        {
            tmpDir = path.isAbsolute(opts.dir) ? opts.dir : path.join(process.cwd(), opts.dir);
        } else
        {
            tmpDir = path.join(os.tmpdir(), 'molex-http-uploads');
        }
        const maxFileSize = opts.maxFileSize || null; // bytes
        ensureDir(tmpDir);

        const fields = {};
        const files = {};

        let buffer = Buffer.alloc(0);
        let state = 'start'; // start, headers, body
        let current = null; // { headers, name, filename, contentType, writeStream, collectedSize }

        const pendingWrites = [];

        function closeCurrent()
        {
            if (!current) return;
            if (current.writeStream)
            {
                // end the stream and record file after it's flushed to disk
                // capture values so we don't rely on `current` later
                const info = { name: current.name, filename: current.filename, filePath: current.filePath, contentType: current.contentType, size: current.collectedSize };
                const p = new Promise((resolve) =>
                {
                    current.writeStream.on('finish', () =>
                    {
                        files[info.name] = { originalFilename: info.filename, storedName: path.basename(info.filePath), path: info.filePath, contentType: info.contentType, size: info.size };
                        resolve();
                    });
                    current.writeStream.on('error', () =>
                    {
                        resolve();
                    });
                });
                pendingWrites.push(p);
                current.writeStream.end();
            } else
            {
                fields[current.name] = current.value || '';
            }
            current = null;
        }

        req.raw.on('data', (chunk) =>
        {
            buffer = Buffer.concat([buffer, chunk]);

            while (true)
            {
                if (state === 'start')
                {
                    // look for starting boundary
                    const idx = buffer.indexOf(startBoundaryBuf);
                    if (idx === -1)
                    {
                        // boundary not yet found
                        if (buffer.length > startBoundaryBuf.length) buffer = buffer.slice(buffer.length - startBoundaryBuf.length);
                        break;
                    }
                    // consume up to after boundary and CRLF
                    const after = idx + startBoundaryBuf.length;
                    if (buffer.length < after + 2) break; // wait for CRLF
                    buffer = buffer.slice(after);
                    if (buffer.slice(0, 2).toString() === '\r\n') buffer = buffer.slice(2);
                    state = 'headers';
                } else if (state === 'headers')
                {
                    const idx = buffer.indexOf('\r\n\r\n');
                    if (idx === -1)
                    {
                        // wait for more
                        if (buffer.length > 1024 * 1024)
                        {
                            // keep buffer bounded
                            buffer = buffer.slice(buffer.length - 1024 * 16);
                        }
                        break;
                    }
                    const headerText = buffer.slice(0, idx).toString('utf8');
                    buffer = buffer.slice(idx + 4);
                    const hdrs = parseHeaders(headerText);
                    const disp = hdrs['content-disposition'] || '';
                    const cd = parseContentDisposition(disp);
                    const name = cd.name;
                    const filename = cd.filename;
                    const contentType = hdrs['content-type'] || null;
                    current = { headers: hdrs, name, filename, contentType, collectedSize: 0 };
                    if (filename)
                    {
                        // create temp file; preserve the original extension when possible
                        const ext = path.extname(filename) || '';
                        const safeExt = ext.replace(/[^a-z0-9.]/gi, '');
                        let fname = uniqueName('upload');
                        if (safeExt) fname = fname + (safeExt.startsWith('.') ? safeExt : ('.' + safeExt));
                        const filePath = path.join(tmpDir, fname);
                        current.filePath = filePath;
                        current.writeStream = fs.createWriteStream(filePath);
                    } else
                    {
                        current.value = '';
                    }
                    state = 'body';
                } else if (state === 'body')
                {
                    // look for boundary preceded by CRLF
                    const idx = buffer.indexOf(dashBoundaryBuf);
                    if (idx === -1)
                    {
                        // keep tail in buffer to match partial boundary
                        const keep = Math.max(dashBoundaryBuf.length, 1024);
                        const writeLen = buffer.length - keep;
                        if (writeLen > 0)
                        {
                            const toWrite = buffer.slice(0, writeLen);
                            if (current.writeStream)
                            {
                                current.writeStream.write(toWrite);
                                current.collectedSize += toWrite.length;
                                if (maxFileSize && current.collectedSize > maxFileSize)
                                {
                                    // file too large, abort
                                    try { current.writeStream.end(); } catch (e) { }
                                    try { fs.unlinkSync(current.filePath); } catch (e) { }
                                    if (!req._multipartErrorHandled)
                                    {
                                        req._multipartErrorHandled = true;
                                        res.statusCode = 413;
                                        res.setHeader('Content-Type', 'application/json');
                                        res.end(JSON.stringify({ error: 'file too large' }));
                                        req.raw.pause && req.raw.pause();
                                    }
                                    return;
                                }
                            } else
                            {
                                current.value += toWrite.toString('utf8');
                            }
                            buffer = buffer.slice(writeLen);
                        }
                        break;
                    }
                    // boundary found at idx; data before idx is body chunk (without the leading CRLF)
                    const bodyChunk = buffer.slice(0, idx);
                    // if bodyChunk starts with CRLF, strip it
                    const toWrite = (bodyChunk.slice(0, 2).toString() === '\r\n') ? bodyChunk.slice(2) : bodyChunk;
                    if (toWrite.length)
                    {
                        if (current.writeStream)
                        {
                            current.writeStream.write(toWrite);
                            current.collectedSize += toWrite.length;
                            if (maxFileSize && current.collectedSize > maxFileSize)
                            {
                                try { current.writeStream.end(); } catch (e) { }
                                try { fs.unlinkSync(current.filePath); } catch (e) { }
                                if (!req._multipartErrorHandled)
                                {
                                    req._multipartErrorHandled = true;
                                    res.statusCode = 413;
                                    res.setHeader('Content-Type', 'application/json');
                                    res.end(JSON.stringify({ error: 'file too large' }));
                                    req.raw.pause && req.raw.pause();
                                }
                                return;
                            }
                        } else
                        {
                            current.value += toWrite.toString('utf8');
                        }
                    }
                    // consume boundary marker
                    buffer = buffer.slice(idx + dashBoundaryBuf.length);
                    // check for final boundary '--'
                    if (buffer.slice(0, 2).toString() === '--')
                    {
                        // final
                        closeCurrent();
                        // wait for any pending file flushes then continue
                        req.raw.pause && req.raw.pause();
                        Promise.all(pendingWrites).then(() =>
                        {
                            req.body = { fields, files };
                            req._multipart = true;
                            return next();
                        }).catch(() =>
                        {
                            req.body = { fields, files };
                            req._multipart = true;
                            return next();
                        });
                        return;
                    }
                    // trim leading CRLF if present
                    if (buffer.slice(0, 2).toString() === '\r\n') buffer = buffer.slice(2);
                    // close current and continue to next headers
                    closeCurrent();
                    state = 'headers';
                }
            }
        });

        req.raw.on('end', () =>
        {
            // finish any current
            if (current) closeCurrent();
            req.body = { fields, files };
            req._multipart = true;
            next();
        });

        req.raw.on('error', (err) =>
        {
            next();
        });
    };
}

module.exports = multipart;
