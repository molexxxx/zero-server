const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.ico': 'image/x-icon'
};

function sendFile(res, filePath)
{
  const ext = path.extname(filePath).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  // set content-type directly on the raw response so streaming works
  try { res.raw.setHeader('Content-Type', ct); } catch (e) { /* best-effort */ }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.raw.statusCode = 404; res.raw.end(); } catch (e) { } });
  stream.pipe(res.raw);
}

function static(root, options = {})
{
  root = path.resolve(root);
  const index = options.index || 'index.html';
  return (req, res, next) =>
  {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) return res.status(403).send({ error: 'Forbidden' });
    fs.stat(file, (err, st) =>
    {
      if (err) return next();
      if (st.isDirectory())
      {
        file = path.join(file, index);
        fs.stat(file, (err2) => { if (err2) return next(); sendFile(res, file); });
      } else
      {
        sendFile(res, file);
      }
    });
  };
}

module.exports = static;
