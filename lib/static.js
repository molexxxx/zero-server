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
  const index = (options.hasOwnProperty('index')) ? options.index : 'index.html';
  const maxAge = options.hasOwnProperty('maxAge') ? options.maxAge : 0; // ms or string handled by user
  const dotfiles = options.hasOwnProperty('dotfiles') ? options.dotfiles : 'ignore'; // allow|deny|ignore
  const extensions = Array.isArray(options.extensions) ? options.extensions : null;
  const setHeaders = (typeof options.setHeaders === 'function') ? options.setHeaders : null;

  function isDotfile(p)
  {
    return path.basename(p).startsWith('.');
  }

  return (req, res, next) =>
  {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) return res.status(403).send({ error: 'Forbidden' });

    // handle dotfiles policy
    if (isDotfile(file) && dotfiles === 'deny') return res.status(403).send({ error: 'Forbidden' });

    fs.stat(file, (err, st) =>
    {
      if (err)
      {
        // try extensions fallback if provided and this was not a directory
        if (extensions && !urlPath.endsWith('/'))
        {
          (function tryExt(i)
          {
            if (i >= extensions.length) return next();
            const f = file + (extensions[i].startsWith('.') ? extensions[i] : '.' + extensions[i]);
            fs.stat(f, (e2, st2) =>
            {
              if (!e2 && st2 && st2.isFile())
              {
                // dotfile check
                if (isDotfile(f) && dotfiles === 'deny') return res.status(403).send({ error: 'Forbidden' });
                // set caching header
                if (maxAge) try { res.raw.setHeader('Cache-Control', 'max-age=' + Math.floor(Number(maxAge) / 1000)); } catch (e) {}
                if (setHeaders) try { setHeaders(res, f); } catch (e) {}
                return sendFile(res, f);
              }
              tryExt(i + 1);
            });
          })(0);
          return;
        }
        return next();
      }

      if (st.isDirectory())
      {
        const idxFile = path.join(file, index);
        fs.stat(idxFile, (err2, st2) => { if (err2) return next();
          if (isDotfile(idxFile) && dotfiles === 'deny') return res.status(403).send({ error: 'Forbidden' });
          if (maxAge) try { res.raw.setHeader('Cache-Control', 'max-age=' + Math.floor(Number(maxAge) / 1000)); } catch (e) {}
          if (setHeaders) try { setHeaders(res, idxFile); } catch (e) {}
          sendFile(res, idxFile);
        });
      } else
      {
        if (isDotfile(file) && dotfiles === 'ignore') return next();
        if (isDotfile(file) && dotfiles === 'deny') return res.status(403).send({ error: 'Forbidden' });
        if (maxAge) try { res.raw.setHeader('Cache-Control', 'max-age=' + Math.floor(Number(maxAge) / 1000)); } catch (e) {}
        if (setHeaders) try { setHeaders(res, file); } catch (e) {}
        sendFile(res, file);
      }
    });
  };
}

module.exports = static;
