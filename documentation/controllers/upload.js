const fs = require('fs');
const path = require('path');

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
                const safeName = (f.originalFilename || '').replace(/[&<>"]'/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
                const sizeText = typeof f.size === 'number' ? Math.round(f.size / 1024) + ' KB' : '';
                const svg = `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">\n  <rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/>\n  <text x="50%" y="50%" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111827" dominant-baseline="middle" text-anchor="middle">${safeName}</text>\n  <text x="50%" y="72%" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#6b7280" dominant-baseline="middle" text-anchor="middle">${sizeText}</text>\n</svg>`;
                try { fs.writeFileSync(thumbPath, svg, 'utf8'); outFiles[key].thumbUrl = '/uploads/.thumbs/' + encodeURIComponent(thumbName); } catch (e) { }
            }
        }
    } catch (e) { }
    return res.json({ fields: req.body.fields || {}, files: outFiles });
};