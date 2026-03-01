const fs = require('fs');
const path = require('path');

// --- Shared Constants & Helpers ---

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|jfif)$/i;
const HIDDEN_DIRS = new Set(['.trash', '.thumbs']);

/** Build the thumbnail filename for a given stored name */
const thumbName = (storedName) => storedName + '-thumb.svg';

/** Ensure a directory exists (no-op if it already does) */
const ensureDir = (dir) => { try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { } };

/** Resolve common paths relative to uploadsDir */
const dirs = (uploadsDir) => ({
    thumbs:      path.join(uploadsDir, '.thumbs'),
    trash:       path.join(uploadsDir, '.trash'),
    trashThumbs: path.join(uploadsDir, '.trash', '.thumbs'),
});

/**
 * Read file entries from a directory, returning metadata objects.
 * Skips hidden dirs (.trash, .thumbs).
 */
function readFileEntries(dir, uploadsDir)
{
    if (!fs.existsSync(dir)) return [];
    const { thumbs } = dirs(uploadsDir || dir);
    const entries = [];
    for (const fn of fs.readdirSync(dir))
    {
        if (HIDDEN_DIRS.has(fn)) continue;
        try
        {
            const st = fs.statSync(path.join(dir, fn));
            const isImage = IMAGE_RE.test(fn);
            const tn = thumbName(fn);
            const thumbExists = fs.existsSync(path.join(thumbs, tn));
            entries.push({
                name: fn,
                url: '/uploads/' + encodeURIComponent(fn),
                size: st.size,
                mtime: st.mtimeMs,
                isImage,
                thumb: thumbExists ? '/uploads/.thumbs/' + encodeURIComponent(tn) : null,
            });
        } catch (e) { }
    }
    return entries;
}

/** Move a thumbnail between two directories (if it exists) */
function moveThumb(srcDir, destDir, storedName)
{
    try
    {
        const tn = thumbName(storedName);
        const src = path.join(srcDir, tn);
        if (!fs.existsSync(src)) return;
        ensureDir(destDir);
        fs.renameSync(src, path.join(destDir, tn));
    } catch (e) { }
}

/** Delete a thumbnail from a directory (if it exists) */
function deleteThumb(dir, storedName)
{
    try
    {
        const p = path.join(dir, thumbName(storedName));
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { }
}

// --- Exports ---

exports.ensureUploadsDir = (uploadsDir) =>
{
    const { trash } = dirs(uploadsDir);
    ensureDir(uploadsDir);
    ensureDir(trash);
};

/** Handle multipart upload (generate SVG thumbnails for images) */
exports.upload = (uploadsDir) => (req, res) =>
{
    if (req._multipartErrorHandled) return;
    const { thumbs } = dirs(uploadsDir);
    const files = req.body.files || {};
    const outFiles = {};

    for (const key of Object.keys(files))
    {
        const f = files[key];
        outFiles[key] = {
            originalFilename: f.originalFilename,
            storedName:       f.storedName,
            size:             f.size,
            url:              '/uploads/' + encodeURIComponent(f.storedName),
        };

        if (!IMAGE_RE.test(f.originalFilename || '')) continue;

        // Generate a simple SVG placeholder thumbnail
        try
        {
            ensureDir(thumbs);
            const tn = thumbName(f.storedName);
            const safeName = (f.originalFilename || '').replace(/[&<>"']/g, c =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
            const sizeText = typeof f.size === 'number' ? Math.round(f.size / 1024) + ' KB' : '';
            const svg = [
                '<?xml version="1.0" encoding="utf-8"?>',
                '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">',
                '  <rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/>',
                `  <text x="50%" y="50%" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111827" dominant-baseline="middle" text-anchor="middle">${safeName}</text>`,
                `  <text x="50%" y="72%" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#6b7280" dominant-baseline="middle" text-anchor="middle">${sizeText}</text>`,
                '</svg>',
            ].join('\n');
            fs.writeFileSync(path.join(thumbs, tn), svg, 'utf8');
            outFiles[key].thumbUrl = '/uploads/.thumbs/' + encodeURIComponent(tn);
        } catch (e) { }
    }

    return res.json({ fields: req.body.fields || {}, files: outFiles });
};

/** Move a single upload to trash */
exports.deleteUpload = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    const { thumbs, trash, trashThumbs } = dirs(uploadsDir);
    const src = path.join(uploadsDir, name);

    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Not found' });
    try
    {
        fs.renameSync(src, path.join(trash, name));
        moveThumb(thumbs, trashThumbs, name);
        return res.json({ trashed: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/** Delete all uploads (optionally keep first via ?keep=1) */
exports.deleteAllUploads = (uploadsDir) => (req, res) =>
{
    const keep = Number(req.query.keep) || 0;
    const { thumbs } = dirs(uploadsDir);

    if (!fs.existsSync(uploadsDir)) return res.json({ removed: [] });
    try
    {
        const files = fs.readdirSync(uploadsDir).filter(n => !HIDDEN_DIRS.has(n)).sort();
        const removed = [];
        for (let i = 0; i < files.length; i++)
        {
            if (keep && i === 0) continue;
            try { fs.unlinkSync(path.join(uploadsDir, files[i])); removed.push(files[i]); } catch (e) { }
        }
        for (const n of removed) deleteThumb(thumbs, n);
        return res.json({ removed });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/** Restore a trashed file back to uploads */
exports.restoreUpload = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    const { thumbs, trash, trashThumbs } = dirs(uploadsDir);
    const src = path.join(trash, name);

    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Not found in trash' });
    try
    {
        fs.renameSync(src, path.join(uploadsDir, name));
        moveThumb(trashThumbs, thumbs, name);
        return res.json({ restored: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/** List files currently in trash */
exports.listTrash = (uploadsDir) => (req, res) =>
{
    const { trash } = dirs(uploadsDir);
    try
    {
        const files = !fs.existsSync(trash) ? [] :
            fs.readdirSync(trash)
                .filter(fn => fn !== '.thumbs')
                .map(fn => ({ name: fn, url: '/uploads/.trash/' + encodeURIComponent(fn) }));
        res.json({ files });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};

/** Permanently delete a single trash item */
exports.deleteTrashItem = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    const { trash, trashThumbs } = dirs(uploadsDir);
    const p = path.join(trash, name);

    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
    try
    {
        fs.unlinkSync(p);
        deleteThumb(trashThumbs, name);
        return res.json({ deleted: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/** Empty the entire trash folder */
exports.emptyTrash = (uploadsDir) => (req, res) =>
{
    const { trash, trashThumbs } = dirs(uploadsDir);
    try
    {
        const removed = [];
        if (fs.existsSync(trash))
        {
            for (const f of fs.readdirSync(trash))
            {
                if (f === '.thumbs') continue;
                try { fs.unlinkSync(path.join(trash, f)); removed.push(f); } catch (e) { }
            }
            // clear all trash thumbnails
            if (fs.existsSync(trashThumbs))
            {
                for (const tf of fs.readdirSync(trashThumbs))
                {
                    try { fs.unlinkSync(path.join(trashThumbs, tf)); } catch (e) { }
                }
            }
        }
        return res.json({ removed });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/** List uploaded files with pagination and sorting */
exports.listUploads = (uploadsDir) => (req, res) =>
{
    try
    {
        const page     = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize) || 20));
        const sort     = req.query.sort || 'mtime';
        const order    = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

        const list = readFileEntries(uploadsDir, uploadsDir);
        list.sort((a, b) =>
        {
            let v = 0;
            if (sort === 'name')      v = a.name.localeCompare(b.name);
            else if (sort === 'size') v = (a.size || 0) - (b.size || 0);
            else                      v = (a.mtime || 0) - (b.mtime || 0);
            return order === 'asc' ? v : -v;
        });

        const total = list.length;
        const start = (page - 1) * pageSize;
        res.json({ files: list.slice(start, start + pageSize), total, page, pageSize });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};

/** List all uploads and trash together (no pagination) for the demo UI */
exports.listAll = (uploadsDir) => (req, res) =>
{
    const { trash } = dirs(uploadsDir);
    try
    {
        const uploads = readFileEntries(uploadsDir, uploadsDir);

        const trashItems = [];
        if (fs.existsSync(trash))
        {
            for (const fn of fs.readdirSync(trash))
            {
                if (fn === '.thumbs') continue;
                try
                {
                    const st = fs.statSync(path.join(trash, fn));
                    trashItems.push({ name: fn, url: '/uploads/.trash/' + encodeURIComponent(fn), size: st.size, mtime: st.mtimeMs });
                } catch (e) { }
            }
        }

        res.json({ uploads, trash: trashItems });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};
