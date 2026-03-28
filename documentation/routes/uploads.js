const path = require('path');
const fs   = require('fs');
const { multipart, static: serveStatic } = require('../..');
const uploadsController = require('../controllers/uploads');

/**
 * Mount upload, trash, and file-listing routes.
 * Also starts the automatic trash retention cleanup.
 */
function mountUploadRoutes(app)
{
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    uploadsController.ensureUploadsDir(uploadsDir);

    // Serve uploaded files
    app.use('/uploads', serveStatic(uploadsDir));

    // Upload & CRUD
    app.post('/upload', multipart({ maxFileSize: 5 * 1024 * 1024, dir: uploadsDir }), uploadsController.upload(uploadsDir));
    app.delete('/uploads/:name', uploadsController.deleteUpload(uploadsDir));
    app.delete('/uploads',       uploadsController.deleteAllUploads(uploadsDir));
    app.post('/uploads/:name/restore', uploadsController.restoreUpload(uploadsDir));

    // Trash
    app.get('/uploads-trash-list',      uploadsController.listTrash(uploadsDir));
    app.delete('/uploads-trash/:name',  uploadsController.deleteTrashItem(uploadsDir));
    app.delete('/uploads-trash',        uploadsController.emptyTrash(uploadsDir));

    // Listings
    app.get('/uploads-list', uploadsController.listUploads(uploadsDir));
    app.get('/uploads-all',  uploadsController.listAll(uploadsDir));

    // Trash retention
    const RETENTION_MS = Number(process.env.TRASH_RETENTION_DAYS || 7) * 86400000;

    function autoEmptyTrash()
    {
        try
        {
            const trash = path.join(uploadsDir, '.trash');
            if (!fs.existsSync(trash)) return;
            const now = Date.now();
            const removed = [];
            for (const f of fs.readdirSync(trash))
            {
                try
                {
                    const p  = path.join(trash, f);
                    const st = fs.statSync(p);
                    if (now - st.mtimeMs > RETENTION_MS)
                    {
                        fs.unlinkSync(p);
                        removed.push(f);
                        try { fs.unlinkSync(path.join(trash, '.thumbs', f + '-thumb.svg')); } catch (_) { }
                    }
                } catch (_) { }
            }
            if (removed.length) console.log(`autoEmptyTrash: removed ${removed.length} file(s)`);
        } catch (e) { console.error('autoEmptyTrash error:', e); }
    }

    autoEmptyTrash();
    setInterval(autoEmptyTrash, 86400000).unref();

    // Temp cleanup
    const os = require('os');
    const cleanupController = require('../controllers/cleanup');
    app.post('/cleanup', cleanupController.cleanup(path.join(os.tmpdir(), 'zero-http-uploads')));
}

module.exports = mountUploadRoutes;
