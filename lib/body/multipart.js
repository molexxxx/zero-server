/**
 * @module body/multipart
 * @description Streaming multipart/form-data parser.
 *              Writes uploaded files to a temp directory and collects
 *              form fields.  Sets `req.body = { fields, files }`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sendError = require('./sendError');

/**
 * Generate a unique filename with an optional prefix.
 *
 * @private
 * @param {string} [prefix='miniex'] - Filename prefix.
 * @returns {string} Formatted string.
 */
function uniqueName(prefix = 'miniex')
{
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Recursively create a directory if it doesn't exist.
 *
 * @private
 * @param {string} dir - Directory path.
 */
function ensureDir(dir)
{
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
}

/**
 * Parse raw MIME header text (CRLF-separated) into a plain object.
 *
 * @private
 * @param {string} headerText - Raw header block.
 * @returns {Object<string, string>} Lower-cased header key/value map.
 */
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

/**
 * Sanitize a filename by stripping path traversal characters and
 * null bytes. Keeps only the basename.
 *
 * @private
 * @param {string} filename - Raw filename from the upload.
 * @returns {string} Sanitized filename.
 */
function sanitizeFilename(filename)
{
    if (!filename) return '';
    // Strip null bytes
    let safe = filename.replace(/\0/g, '');
    // Take only the basename (strip directory traversal)
    safe = safe.replace(/^.*[/\\]/, '');
    // Remove leading dots (prevent dotfile creation)
    safe = safe.replace(/^\.+/, '');
    // Replace potentially dangerous characters
    safe = safe.replace(/[<>:"|?*]/g, '_');
    return safe || 'unnamed';
}

/**
 * Extract `name` and `filename` fields from a `Content-Disposition` header.
 *
 * @private
 * @param {string} cd - Content-Disposition value.
 * @returns {Object<string, string>} Parsed disposition parameters.
 */
function parseContentDisposition(cd)
{
    const m = /form-data;(.*)/i.exec(cd);
    if (!m) return {};
    const parts = m[1].split(';').map(s => s.trim());
    const out = {};
    for (const p of parts)
    {
        const mm = /([^=]+)="?([^"]+)"?/.exec(p);
        if (mm)
        {
            const key = mm[1].trim();
            let val = mm[2];
            // Sanitize filename values
            if (key === 'filename') val = sanitizeFilename(val);
            out[key] = val;
        }
    }
    return out;
}

/**
 * Create a streaming multipart/form-data parsing middleware.
 *
 * @param {object}   [opts] - Configuration options.
 * @param {string}   [opts.dir]              - Upload directory (default: OS temp dir).
 * @param {number}   [opts.maxFileSize]      - Maximum size per file in bytes.
 * @param {boolean}  [opts.requireSecure=false] - When true, reject non-HTTPS requests with 403.
 * @param {number}   [opts.maxFields=1000]   - Maximum number of non-file fields. Prevents DoS via field flooding.
 * @param {number}   [opts.maxFiles=10]      - Maximum number of uploaded files.
 * @param {number}   [opts.maxFieldSize]     - Maximum size of a single field value in bytes. Default 1 MB.
 * @param {string[]} [opts.allowedMimeTypes] - Whitelist of MIME types for uploaded files (e.g. `['image/png', 'image/jpeg']`).
 * @param {number}   [opts.maxTotalSize]     - Maximum combined size of all uploaded files in bytes.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 *
 * @example
 *   const { multipart } = require('zero-http');
 *
 *   app.use(multipart({
 *       dir: './uploads',
 *       maxFileSize: 10 * 1024 * 1024, // 10 MB
 *       maxFiles: 5,
 *       allowedMimeTypes: ['image/png', 'image/jpeg'],
 *   }));
 *
 *   app.post('/upload', (req, res) => {
 *       const { fields, files } = req.body;
 *       res.json({ fields, uploaded: Object.keys(files) });
 *   });
 */
function multipart(opts = {})
{
    return async (req, res, next) =>
    {
        if (opts.requireSecure && !req.secure) return sendError(res, 403, 'HTTPS required');
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
            tmpDir = path.join(os.tmpdir(), 'zero-http-uploads');
        }
        const maxFileSize = opts.maxFileSize || null; // bytes
        const maxFields = opts.maxFields !== undefined ? opts.maxFields : 1000;
        const maxFiles = opts.maxFiles !== undefined ? opts.maxFiles : 10;
        const maxFieldSize = opts.maxFieldSize !== undefined ? opts.maxFieldSize : (1024 * 1024); // 1 MB
        const allowedMimeTypes = opts.allowedMimeTypes || null;
        const maxTotalSize = opts.maxTotalSize || null;
        ensureDir(tmpDir);

        const fields = {};
        const files = {};
        let fieldCount = 0;
        let fileCount = 0;
        let totalFileSize = 0;

        let buffer = Buffer.alloc(0);
        let state = 'start'; // start, headers, body
        let current = null; // { headers, name, filename, contentType, writeStream, collectedSize }

        const pendingWrites = [];

        function abortFileTooLarge()
        {
            if (current.writeStream) { current.writeStream.on('error', () => {}); try { current.writeStream.destroy(); } catch (e) { } }
            try { fs.unlinkSync(current.filePath); } catch (e) { }
            if (!req._multipartErrorHandled)
            {
                req._multipartErrorHandled = true;
                sendError(res, 413, 'file too large');
                req.raw.pause && req.raw.pause();
            }
        }

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
                        // Enforce file count limit
                        fileCount++;
                        if (maxFiles && fileCount > maxFiles)
                        {
                            if (!req._multipartErrorHandled)
                            {
                                req._multipartErrorHandled = true;
                                sendError(res, 413, 'too many files');
                                req.raw.pause && req.raw.pause();
                            }
                            return;
                        }
                        // Enforce MIME type whitelist
                        if (allowedMimeTypes && contentType && !allowedMimeTypes.includes(contentType))
                        {
                            if (!req._multipartErrorHandled)
                            {
                                req._multipartErrorHandled = true;
                                sendError(res, 415, 'file type not allowed: ' + contentType);
                                req.raw.pause && req.raw.pause();
                            }
                            return;
                        }
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
                        // Enforce field count limit
                        fieldCount++;
                        if (maxFields && fieldCount > maxFields)
                        {
                            if (!req._multipartErrorHandled)
                            {
                                req._multipartErrorHandled = true;
                                sendError(res, 413, 'too many fields');
                                req.raw.pause && req.raw.pause();
                            }
                            return;
                        }
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
                                current.collectedSize += toWrite.length;
                                totalFileSize += toWrite.length;
                                if (maxFileSize && current.collectedSize > maxFileSize)
                                {
                                    abortFileTooLarge();
                                    return;
                                }
                                if (maxTotalSize && totalFileSize > maxTotalSize)
                                {
                                    abortFileTooLarge();
                                    return;
                                }
                                current.writeStream.write(toWrite);
                            } else
                            {
                                if (maxFieldSize && current.value.length + toWrite.length > maxFieldSize)
                                {
                                    if (!req._multipartErrorHandled)
                                    {
                                        req._multipartErrorHandled = true;
                                        sendError(res, 413, 'field value too large');
                                        req.raw.pause && req.raw.pause();
                                    }
                                    return;
                                }
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
                            current.collectedSize += toWrite.length;
                            totalFileSize += toWrite.length;
                            if (maxFileSize && current.collectedSize > maxFileSize)
                            {
                                abortFileTooLarge();
                                return;
                            }
                            if (maxTotalSize && totalFileSize > maxTotalSize)
                            {
                                abortFileTooLarge();
                                return;
                            }
                            current.writeStream.write(toWrite);
                        } else
                        {
                            if (maxFieldSize && current.value.length + toWrite.length > maxFieldSize)
                            {
                                if (!req._multipartErrorHandled)
                                {
                                    req._multipartErrorHandled = true;
                                    sendError(res, 413, 'field value too large');
                                    req.raw.pause && req.raw.pause();
                                }
                                return;
                            }
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
