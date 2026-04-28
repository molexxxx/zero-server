/** Clean up temp files older than ?seconds (default 60) */
const fs = require('fs');
const path = require('path');

exports.cleanup = (tmpDirPath) => (req, res) =>
{
    const olderThan = (Number(req.query.seconds) || 60) * 1000;
    const now = Date.now();
    const removed = [];
    try
    {
        if (fs.existsSync(tmpDirPath))
        {
            for (const f of fs.readdirSync(tmpDirPath))
            {
                try
                {
                    const st = fs.statSync(path.join(tmpDirPath, f));
                    if (now - st.mtimeMs > olderThan) { fs.unlinkSync(path.join(tmpDirPath, f)); removed.push(f); }
                } catch (e) { }
            }
        }
    } catch (e) { return res.status(500).json({ error: String(e) }); }
    res.json({ removed });
};
