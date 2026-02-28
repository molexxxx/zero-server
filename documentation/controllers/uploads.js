const fs = require('fs');
const path = require('path');

/**
 * Ensure uploads and trash directories exist
 */
exports.ensureUploadsDir = (uploadsDir) =>
{
    try
    {
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const trash = path.join(uploadsDir, '.trash');
        if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
    } catch (e) { }
};

/**
 * Handle multipart upload (generate thumbnails for images)
 */
exports.upload = (uploadsDir) => (req, res) =>
{
    if (req._multipartErrorHandled) return;
    const files = req.body.files || {};
    const outFiles = {};
    for (const key of Object.keys(files))
    {
        const f = files[key];
        outFiles[key] = { originalFilename: f.originalFilename, storedName: f.storedName, size: f.size, url: '/uploads/' + encodeURIComponent(f.storedName) };
    }
    try
    {
        const thumbsDir = path.join(uploadsDir, '.thumbs');
        if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
        const imgExt = /\.(png|jpe?g|gif|webp|svg|jfif)$/i;
        for (const key of Object.keys(files))
        {
            const f = files[key];
            if (imgExt.test(f.originalFilename || ''))
            {
                const thumbName = f.storedName + '-thumb.svg';
                const thumbPath = path.join(thumbsDir, thumbName);
                const safeName = (f.originalFilename || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
                const sizeText = typeof f.size === 'number' ? Math.round(f.size / 1024) + ' KB' : '';
                const svg = `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">\n  <rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/>\n  <text x="50%" y="50%" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111827" dominant-baseline="middle" text-anchor="middle">${safeName}</text>\n  <text x="50%" y="72%" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#6b7280" dominant-baseline="middle" text-anchor="middle">${sizeText}</text>\n</svg>`;
                try { fs.writeFileSync(thumbPath, svg, 'utf8'); outFiles[key].thumbUrl = '/uploads/.thumbs/' + encodeURIComponent(thumbName); } catch (e) { }
            }
        }
    } catch (e) { }
    return res.json({ fields: req.body.fields || {}, files: outFiles });
};

/**
 * Move a single upload to trash
 */
exports.deleteUpload = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    try
    {
        const p = path.join(uploadsDir, name);
        const trash = path.join(uploadsDir, '.trash');
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
        const dest = path.join(trash, name);
        fs.renameSync(p, dest);
        // move thumbnail if exists
        try
        {
            const thumbs = path.join(uploadsDir, '.thumbs');
            const thumbName = name + '-thumb.svg';
            const tsrc = path.join(thumbs, thumbName);
            const tdestDir = path.join(trash, '.thumbs');
            if (fs.existsSync(tsrc))
            {
                try { if (!fs.existsSync(tdestDir)) fs.mkdirSync(tdestDir, { recursive: true }); } catch (e) { }
                fs.renameSync(tsrc, path.join(tdestDir, thumbName));
            }
        } catch (e) { }
        return res.json({ trashed: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/**
 * Delete all uploads (optionally keep first)
 */
exports.deleteAllUploads = (uploadsDir) => (req, res) =>
{
    const keep = Number(req.query.keep) || 0;
    try
    {
        if (!fs.existsSync(uploadsDir)) return res.json({ removed: [] });
        const files = fs.readdirSync(uploadsDir).filter(n => n !== '.trash' && n !== '.thumbs').sort();
        const removed = [];
        for (let i = 0; i < files.length; i++)
        {
            if (keep && i === 0) continue;
            const p = path.join(uploadsDir, files[i]);
            try { fs.unlinkSync(p); removed.push(files[i]); } catch (e) { }
        }
        // also remove any thumbnails for removed files
        try
        {
            const thumbsDir = path.join(uploadsDir, '.thumbs');
            for (const n of removed)
            {
                const tn = path.join(thumbsDir, n + '-thumb.svg');
                try { if (fs.existsSync(tn)) fs.unlinkSync(tn); } catch (e) { }
            }
        } catch (e) { }
        return res.json({ removed });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/**
 * Restore a trashed file back to uploads
 */
exports.restoreUpload = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        const p = path.join(trash, name);
        const dest = path.join(uploadsDir, name);
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found in trash' });
        fs.renameSync(p, dest);
        // move thumbnail back if present in trash
        try
        {
            const trashThumbs = path.join(trash, '.thumbs');
            const thumbsDir = path.join(uploadsDir, '.thumbs');
            const thumbName = name + '-thumb.svg';
            const tsrc = path.join(trashThumbs, thumbName);
            if (fs.existsSync(tsrc))
            {
                if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
                fs.renameSync(tsrc, path.join(thumbsDir, thumbName));
            }
        } catch (e) { }
        return res.json({ restored: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/**
 * List files currently in trash
 */
exports.listTrash = (uploadsDir) => (req, res) =>
{
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        let list = [];
        if (fs.existsSync(trash))
        {
            list = fs.readdirSync(trash)
                .filter(fn => fn !== '.thumbs') // hide internal thumbs folder
                .map(fn => ({ name: fn, url: '/uploads/.trash/' + encodeURIComponent(fn) }));
        }
        res.json({ files: list });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};

/**
 * Permanently delete a trash item
 */
exports.deleteTrashItem = (uploadsDir) => (req, res) =>
{
    const name = req.params.name;
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        const p = path.join(trash, name);
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
        fs.unlinkSync(p);
        // remove thumbnail in trash if present
        try
        {
            const tthumb = path.join(trash, '.thumbs', name + '-thumb.svg');
            if (fs.existsSync(tthumb)) fs.unlinkSync(tthumb);
        } catch (e) { }
        return res.json({ deleted: name });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/**
 * Empty the trash folder
 */
exports.emptyTrash = (uploadsDir) => (req, res) =>
{
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        const removed = [];
        if (fs.existsSync(trash))
        {
            for (const f of fs.readdirSync(trash))
            {
                try { fs.unlinkSync(path.join(trash, f)); removed.push(f); } catch (e) { }
            }
            // also remove thumbnails in trash
            try
            {
                const tthumbs = path.join(trash, '.thumbs');
                if (fs.existsSync(tthumbs))
                {
                    for (const tf of fs.readdirSync(tthumbs))
                    {
                        try { fs.unlinkSync(path.join(tthumbs, tf)); } catch (e) { }
                    }
                }
            } catch (e) { }
        }
        return res.json({ removed });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
};

/**
 * List uploaded files with pagination and sorting
 */
exports.listUploads = (uploadsDir) => (req, res) =>
{
    try
    {
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize) || 20));
        const sort = req.query.sort || 'mtime';
        const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        const list = [];
        if (fs.existsSync(uploadsDir))
        {
            for (const fn of fs.readdirSync(uploadsDir))
            {
                if (fn === '.trash' || fn === '.thumbs') continue;
                try
                {
                    const p = path.join(uploadsDir, fn);
                    const st = fs.statSync(p);
                    const isImage = [/\.png$/i, /\.jpe?g$/i, /\.jfif$/i, /\.gif$/i, /\.webp$/i, /\.svg$/i].some(re => re.test(fn));
                    const thumbPath = path.join(uploadsDir, '.thumbs', fn + '-thumb.svg');
                    const thumbExists = fs.existsSync(thumbPath);
                    list.push({ name: fn, url: '/uploads/' + encodeURIComponent(fn), size: st.size, mtime: st.mtimeMs, isImage, thumb: thumbExists ? ('/uploads/.thumbs/' + encodeURIComponent(fn + '-thumb.svg')) : null });
                } catch (e) { }
            }
        }
        list.sort((a, b) =>
        {
            let v = 0;
            if (sort === 'name') v = a.name.localeCompare(b.name);
            else if (sort === 'size') v = (a.size || 0) - (b.size || 0);
            else v = (a.mtime || 0) - (b.mtime || 0);
            return order === 'asc' ? v : -v;
        });
        const total = list.length;
        const start = (page - 1) * pageSize;
        const paged = list.slice(start, start + pageSize);
        res.json({ files: paged, total, page, pageSize });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};

/**
 * List all uploads and trash together (no pagination) for convenience in the demo UI
 */
exports.listAll = (uploadsDir) => (req, res) =>
{
    try
    {
        const uploads = [];
        if (fs.existsSync(uploadsDir))
        {
            for (const fn of fs.readdirSync(uploadsDir))
            {
                if (fn === '.trash' || fn === '.thumbs') continue;
                try
                {
                    const p = path.join(uploadsDir, fn);
                    const st = fs.statSync(p);
                    const isImage = [/\.png$/i, /\.jpe?g$/i, /\.jfif$/i, /\.gif$/i, /\.webp$/i, /\.svg$/i].some(re => re.test(fn));
                    const thumbPath = path.join(uploadsDir, '.thumbs', fn + '-thumb.svg');
                    const thumbExists = fs.existsSync(thumbPath);
                    uploads.push({ name: fn, url: '/uploads/' + encodeURIComponent(fn), size: st.size, mtime: st.mtimeMs, isImage, thumb: thumbExists ? ('/uploads/.thumbs/' + encodeURIComponent(fn + '-thumb.svg')) : null });
                } catch (e) { }
            }
        }

        const trash = [];
        const trashDir = path.join(uploadsDir, '.trash');
        if (fs.existsSync(trashDir))
        {
            for (const fn of fs.readdirSync(trashDir))
            {
                if (fn === '.thumbs') continue;
                try
                {
                    const p = path.join(trashDir, fn);
                    const st = fs.statSync(p);
                    trash.push({ name: fn, url: '/uploads/.trash/' + encodeURIComponent(fn), size: st.size, mtime: st.mtimeMs });
                } catch (e) { }
            }
        }

        res.json({ uploads, trash });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};
