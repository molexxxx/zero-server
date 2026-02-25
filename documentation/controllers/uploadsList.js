/**
 * Controller for listing uploaded files with pagination and sorting.
 */
const fs = require('fs');
const path = require('path');

exports.listUploads = (uploadsDir) => (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize) || 20));
        const sort = req.query.sort || 'mtime';
        const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        const list = [];
        if (fs.existsSync(uploadsDir)) {
                for (const fn of fs.readdirSync(uploadsDir)) {
                    if (fn === '.trash' || fn === '.thumbs') continue;
                    try {
                        const p = path.join(uploadsDir, fn);
                        const st = fs.statSync(p);
                        const isImage = [/\.png$/i, /\.jpe?g$/i, /\.jfif$/i, /\.gif$/i, /\.webp$/i, /\.svg$/i].some(re => re.test(fn));
                        const thumbPath = path.join(uploadsDir, '.thumbs', fn + '-thumb.svg');
                        const thumbExists = fs.existsSync(thumbPath);
                        list.push({ name: fn, url: '/uploads/' + encodeURIComponent(fn), size: st.size, mtime: st.mtimeMs, isImage, thumb: thumbExists ? ('/uploads/.thumbs/' + encodeURIComponent(fn + '-thumb.svg')) : null });
                    } catch (e) { }
                }
            }
        list.sort((a, b) => {
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
