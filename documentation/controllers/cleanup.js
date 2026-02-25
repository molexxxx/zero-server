/**
 * Controller for cleaning up uploaded temp files older than a threshold (seconds).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.cleanup = (tmpDirPath) => (req, res) => {
    const olderThan = (Number(req.query.seconds) || 60) * 1000;
    const now = Date.now();
    const removed = [];
    try {
        if (fs.existsSync(tmpDirPath)) {
            for (const f of fs.readdirSync(tmpDirPath)) {
                try {
                    const p = path.join(tmpDirPath, f);
                    const st = fs.statSync(p);
                    if (now - st.mtimeMs > olderThan) { fs.unlinkSync(p); removed.push(f); }
                } catch (e) { }
            }
        }
    } catch (e) { return res.status(500).json({ error: String(e) }); }
    res.json({ removed });
};
