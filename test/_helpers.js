const { fetch } = require('../');

async function doFetch(url, opts = {}) {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return { data: await r.json(), status: r.status, headers: r.headers };
    return { data: await r.text(), status: r.status, headers: r.headers };
}

module.exports = { doFetch, fetch };
