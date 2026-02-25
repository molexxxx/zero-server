const rawBuffer = require('./rawBuffer');
const querystring = require('querystring');

function isTypeMatch(contentType, typeOpt)
{
    if (!typeOpt) return true;
    if (typeof typeOpt === 'function') return !!typeOpt(contentType);
    if (!contentType) return false;
    if (typeOpt === '*/*') return true;
    if (typeOpt.endsWith('/*')) return contentType.startsWith(typeOpt.replace('/*', '/'));
    return contentType.indexOf(typeOpt) !== -1;
}

function appendValue(prev, val)
{
    if (prev === undefined) return val;
    if (Array.isArray(prev)) { prev.push(val); return prev; }
    // convert existing scalar or object into array to hold multiple values
    return [prev, val];
}

function urlencoded(options = {})
{
    const opts = options || {};
    const limit = opts.limit || null;
    const typeOpt = opts.type || 'application/x-www-form-urlencoded';
    const extended = !!opts.extended;

    return async (req, res, next) =>
    {
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            const buf = await rawBuffer(req, { limit });
            const txt = buf.toString('utf8');
            if (!extended)
            {
                req.body = querystring.parse(txt);
            }
            else
            {
                // extended parsing: support nested bracket syntax like a[b][c]=1 and arrays a[]=1
                const out = {};
                if (txt.trim() === '') { req.body = out; return next(); }
                const pairs = txt.split('&');
                for (const p of pairs)
                {
                    if (!p) continue;
                    const eq = p.indexOf('=');
                    let k, v;
                    if (eq === -1) { k = decodeURIComponent(p.replace(/\+/g, ' ')); v = ''; }
                    else { k = decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')); v = decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' ')); }
                    // parse key into parts
                    const parts = [];
                    const re = /([^\[\]]+)|\[(.*?)\]/g;
                    let m;
                    while ((m = re.exec(k)) !== null)
                    {
                        parts.push(m[1] || m[2]);
                    }

                    // set value into out following parts
                    let cur = out;
                    for (let i = 0; i < parts.length; i++)
                    {
                        const part = parts[i];
                        const isLast = (i === parts.length - 1);

                        if (part === '')
                        {
                            // array push
                            if (isLast)
                            {
                                if (!Array.isArray(cur))
                                {
                                    // convert existing value to array if needed
                                    if (Object.prototype.hasOwnProperty.call(cur, '0'))
                                    {
                                        // unlikely
                                    }
                                }
                                cur.push(v);
                                break;
                            }
                            // ensure cur is array and proceed to next index object
                            if (!Array.isArray(cur))
                            {
                                // convert existing object to array if empty
                                const keys = Object.keys(cur);
                                if (keys.length === 0) cur = [];
                                else { /* leave as object */ }
                            }
                            // push an object if next part is non-empty
                            if (cur.length === 0 || typeof cur[cur.length - 1] !== 'object') cur.push({});
                            cur = cur[cur.length - 1];
                            continue;
                        }

                        // normal key
                        if (isLast)
                        {
                            if (Array.isArray(cur))
                            {
                                // numeric key may indicate index
                                const idx = Number(part);
                                if (!Number.isNaN(idx)) cur[idx] = appendValue(cur[idx], v);
                                else cur[part] = appendValue(cur[part], v);
                            }
                            else
                            {
                                cur[part] = appendValue(cur[part], v);
                            }
                        }
                        else
                        {
                            if (Array.isArray(cur))
                            {
                                const idx = Number(part);
                                if (!Number.isNaN(idx))
                                {
                                    if (!cur[idx]) cur[idx] = {};
                                    cur = cur[idx];
                                } else
                                {
                                    // treat non-numeric into last pushed object
                                    if (cur.length === 0) cur.push({});
                                    if (typeof cur[cur.length - 1] !== 'object') cur.push({});
                                    cur = cur[cur.length - 1];
                                    if (!cur[part]) cur[part] = {};
                                    cur = cur[part];
                                }
                            }
                            else
                            {
                                if (!cur[part]) cur[part] = {};
                                cur = cur[part];
                            }
                        }
                    }
                }
                req.body = out;
            }
        } catch (err)
        {
            if (err && err.status === 413)
            {
                res.statusCode = 413;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'payload too large' }));
                return;
            }
            req.body = {};
        }
        next();
    };
}

module.exports = urlencoded;
