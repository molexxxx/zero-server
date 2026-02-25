const fs = require('fs');
const path = require('path');

exports.ensureUploadsDir = (uploadsDir) =>
{
    try
    {
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const trash = path.join(uploadsDir, '.trash');
        if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
    } catch (e) { }
};

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

exports.listTrash = (uploadsDir) => (req, res) =>
{
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        let list = [];
        if (fs.existsSync(trash)) {
            list = fs.readdirSync(trash)
                .filter(fn => fn !== '.thumbs') // hide internal thumbs folder
                .map(fn => ({ name: fn, url: '/uploads/.trash/' + encodeURIComponent(fn) }));
        }
        res.json({ files: list });
    } catch (e) { res.status(500).json({ error: String(e) }); }
};

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
