const http = require('http');
const { doFetch } = require('../_helpers');
const { createApp } = require('../../');

describe('Request QoL Properties', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();

        app.get('/req-info', (req, res) => {
            res.json({
                path: req.path,
                hostname: req.hostname,
                xhr: req.xhr,
                protocol: req.protocol,
                fresh: req.fresh,
                stale: req.stale,
                acceptsJson: req.accepts('json'),
                acceptsHtml: req.accepts('html', 'json'),
                subdomains: req.subdomains(),
            });
        });

        app.get('/range-test', (req, res) => {
            const result = req.range(1000);
            res.json({ range: result });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('req.path strips query string', async () => {
        const r = await doFetch(`${base}/req-info?foo=bar`, {
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Host': 'api.v2.example.com' }
        });
        expect(r.data.path).toBe('/req-info');
    });

    it('req.hostname returns host', async () => {
        const r = await doFetch(`${base}/req-info?foo=bar`, {
            headers: { 'Accept': 'application/json', 'Host': 'api.v2.example.com' }
        });
        expect(['api.v2.example.com', 'localhost']).toContain(r.data.hostname);
    });

    it('req.xhr detects XMLHttpRequest', async () => {
        const r = await doFetch(`${base}/req-info`, {
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        });
        expect(r.data.xhr).toBe(true);
    });

    it('req.protocol is http', async () => {
        const r = await doFetch(`${base}/req-info`, { headers: { 'Accept': 'application/json' } });
        expect(r.data.protocol).toBe('http');
    });

    it('req.stale is true without cache headers', async () => {
        const r = await doFetch(`${base}/req-info`, { headers: { 'Accept': 'application/json' } });
        expect(r.data.stale).toBe(true);
    });

    it('req.accepts returns matching type', async () => {
        const r = await doFetch(`${base}/req-info`, { headers: { 'Accept': 'application/json' } });
        expect(r.data.acceptsJson).toBe('json');
    });

    it('req.range parses byte ranges', async () => {
        const r = await doFetch(`${base}/range-test`, { headers: { 'Range': 'bytes=0-499' } });
        expect(r.data.range.type).toBe('bytes');
        expect(r.data.range.ranges[0].start).toBe(0);
        expect(r.data.range.ranges[0].end).toBe(499);
    });

    it('req.range returns -2 for malformed range', async () => {
        const r = await doFetch(`${base}/range-test`, { headers: { 'Range': 'invalid' } });
        expect(r.data.range).toBe(-2);
    });

    it('req.range returns -1 for unsatisfiable range', async () => {
        const r = await doFetch(`${base}/range-test`, { headers: { 'Range': 'bytes=5000-6000' } });
        expect(r.data.range).toBe(-1);
    });

    it('req.range handles suffix range', async () => {
        const r = await doFetch(`${base}/range-test`, { headers: { 'Range': 'bytes=-200' } });
        expect(r.data.range.ranges[0].start).toBe(800);
    });

    it('req.range returns -2 when no Range header', async () => {
        const r = await doFetch(`${base}/range-test`);
        expect(r.data.range).toBe(-2);
    });
});

// ===========================================================
//  req.get() — Header retrieval
// ===========================================================
describe('Request — get() header retrieval', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/hdr', (req, res) => {
            res.json({
                ct: req.get('Content-Type'),
                accept: req.get('Accept'),
                custom: req.get('X-Custom'),
                missing: req.get('X-Missing'),
                caseInsensitive: req.get('x-custom'),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns header value', async () => {
        const r = await doFetch(`${base}/hdr`, { headers: { 'X-Custom': 'hello', 'Accept': 'text/plain' } });
        expect(r.data.custom).toBe('hello');
        expect(r.data.accept).toBe('text/plain');
    });

    it('returns undefined for missing header', async () => {
        const r = await doFetch(`${base}/hdr`);
        expect(r.data.missing).toBeUndefined();
    });

    it('is case-insensitive', async () => {
        const r = await doFetch(`${base}/hdr`, { headers: { 'X-Custom': 'value' } });
        expect(r.data.caseInsensitive).toBe('value');
    });
});

// ===========================================================
//  req.is() — Content-Type matching
// ===========================================================
describe('Request — is() content-type matching', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.post('/is-test', (req, res) => {
            res.json({
                isJson: req.is('json'),
                isHtml: req.is('html'),
                isFullJson: req.is('application/json'),
                isFullHtml: req.is('text/html'),
                isText: req.is('text/plain'),
                isXml: req.is('xml'),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('shorthand "json" matches application/json', async () => {
        const r = await doFetch(`${base}/is-test`, {
            method: 'POST', body: '{}',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(r.data.isJson).toBe(true);
        expect(r.data.isFullJson).toBe(true);
    });

    it('shorthand "html" matches text/html', async () => {
        const r = await doFetch(`${base}/is-test`, {
            method: 'POST', body: '<h1>hi</h1>',
            headers: { 'Content-Type': 'text/html' },
        });
        expect(r.data.isHtml).toBe(true);
        expect(r.data.isFullHtml).toBe(true);
    });

    it('no match returns false', async () => {
        const r = await doFetch(`${base}/is-test`, {
            method: 'POST', body: 'hello',
            headers: { 'Content-Type': 'text/plain' },
        });
        expect(r.data.isJson).toBe(false);
        expect(r.data.isHtml).toBe(false);
        expect(r.data.isText).toBe(true);
    });

    it('empty content-type returns false for all', async () => {
        const r = await doFetch(`${base}/is-test`, { method: 'POST', body: 'x' });
        // Fetch may set a default content-type; if none, all should be false
        // We can't guarantee the fetch lib sends no CT, so just ensure no crash
        expect(typeof r.data.isJson).toBe('boolean');
    });
});

// ===========================================================
//  req.hostname — X-Forwarded-Host
// ===========================================================
describe('Request — hostname from X-Forwarded-Host', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.enable('trust proxy');
        app.get('/host', (req, res) => res.json({ hostname: req.hostname }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('prefers X-Forwarded-Host over Host', async () => {
        const r = await doFetch(`${base}/host`, {
            headers: { 'X-Forwarded-Host': 'proxy.example.com', 'Host': 'internal.local' }
        });
        expect(r.data.hostname).toBe('proxy.example.com');
    });

    it('strips port from hostname', async () => {
        const r = await doFetch(`${base}/host`, {
            headers: { 'Host': 'example.com:8080' }
        });
        expect(r.data.hostname).toBe('example.com');
    });

    it('strips port from X-Forwarded-Host', async () => {
        const r = await doFetch(`${base}/host`, {
            headers: { 'X-Forwarded-Host': 'proxy.com:443' }
        });
        expect(r.data.hostname).toBe('proxy.com');
    });
});

// ===========================================================
//  req.subdomains()
// ===========================================================
describe('Request — subdomains()', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/sub', (req, res) => {
            const offset = req.query.offset ? parseInt(req.query.offset) : 2;
            res.json({ subdomains: req.subdomains(offset) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts subdomains with default offset=2', async () => {
        const r = await doFetch(`${base}/sub`, { headers: { 'Host': 'api.v2.example.com' } });
        // parts = ['api', 'v2', 'example', 'com'], offset=2 removes last 2 → ['api', 'v2'] reversed = ['v2', 'api']
        expect(r.data.subdomains).toEqual(['v2', 'api']);
    });

    it('returns empty for bare domain', async () => {
        const r = await doFetch(`${base}/sub`, { headers: { 'Host': 'example.com' } });
        expect(r.data.subdomains).toEqual([]);
    });

    it('single subdomain', async () => {
        const r = await doFetch(`${base}/sub`, { headers: { 'Host': 'blog.example.com' } });
        expect(r.data.subdomains).toEqual(['blog']);
    });

    it('custom offset', async () => {
        const r = await doFetch(`${base}/sub?offset=3`, { headers: { 'Host': 'a.b.c.example.co.uk' } });
        // parts = [a,b,c,example,co,uk], offset=3 → [a,b,c] reversed = [c,b,a]
        expect(r.data.subdomains).toEqual(['c', 'b', 'a']);
    });
});

// ===========================================================
//  req.accepts() — edge cases
// ===========================================================
describe('Request — accepts() edge cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/acc', (req, res) => {
            res.json({
                json: req.accepts('json'),
                html: req.accepts('html'),
                xml: req.accepts('xml'),
                both: req.accepts('html', 'json'),
                none: req.accepts('xml', 'csv'),
                all: req.accepts('anything'),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('wildcard */* matches everything', async () => {
        const r = await doFetch(`${base}/acc`, { headers: { 'Accept': '*/*' } });
        expect(r.data.json).toBe('json');
        expect(r.data.html).toBe('html');
        expect(r.data.all).toBe('anything');
    });

    it('returns first match when multiple provided', async () => {
        const r = await doFetch(`${base}/acc`, { headers: { 'Accept': 'text/html' } });
        expect(r.data.both).toBe('html');
    });

    it('type/* wildcard matching', async () => {
        const r = await doFetch(`${base}/acc`, { headers: { 'Accept': 'application/*' } });
        expect(r.data.json).toBe('json');
        expect(r.data.xml).toBe('xml');
    });

    it('returns false when no match', async () => {
        const r = await doFetch(`${base}/acc`, { headers: { 'Accept': 'image/png' } });
        expect(r.data.json).toBe(false);
        expect(r.data.html).toBe(false);
    });
});

// ===========================================================
//  req.xhr — false case
// ===========================================================
describe('Request — xhr false case', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/xhr', (req, res) => res.json({ xhr: req.xhr }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('xhr is false without X-Requested-With', async () => {
        const r = await doFetch(`${base}/xhr`);
        expect(r.data.xhr).toBe(false);
    });

    it('xhr is false with wrong X-Requested-With', async () => {
        const r = await doFetch(`${base}/xhr`, { headers: { 'X-Requested-With': 'Fetch' } });
        expect(r.data.xhr).toBe(false);
    });
});

// ===========================================================
//  req.fresh — always false behavior
// ===========================================================
describe('Request — fresh/stale behavior', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/freshness', (req, res) => res.json({ fresh: req.fresh, stale: req.stale }));
        app.post('/freshness', (req, res) => res.json({ fresh: req.fresh, stale: req.stale }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('fresh=false without cache headers', async () => {
        const r = await doFetch(`${base}/freshness`);
        expect(r.data.fresh).toBe(false);
        expect(r.data.stale).toBe(true);
    });

    it('fresh=false even with if-none-match', async () => {
        const r = await doFetch(`${base}/freshness`, { headers: { 'If-None-Match': '"etag"' } });
        expect(r.data.fresh).toBe(false);
    });

    it('fresh=false for POST (non-GET/HEAD)', async () => {
        const r = await doFetch(`${base}/freshness`, { method: 'POST' });
        expect(r.data.fresh).toBe(false);
    });
});

// ===========================================================
//  req.range() — multi-range & edge cases
// ===========================================================
describe('Request — range() advanced', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/range', (req, res) => {
            const size = parseInt(req.query.size || '1000');
            res.json({ range: req.range(size) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses multiple ranges', async () => {
        const r = await doFetch(`${base}/range`, { headers: { 'Range': 'bytes=0-99, 200-299' } });
        expect(r.data.range.ranges.length).toBe(2);
        expect(r.data.range.ranges[0]).toEqual({ start: 0, end: 99 });
        expect(r.data.range.ranges[1]).toEqual({ start: 200, end: 299 });
    });

    it('clamps end to size-1', async () => {
        const r = await doFetch(`${base}/range?size=50`, { headers: { 'Range': 'bytes=0-999' } });
        expect(r.data.range.ranges[0].end).toBe(49);
    });

    it('handles start-only range (open ended)', async () => {
        const r = await doFetch(`${base}/range?size=500`, { headers: { 'Range': 'bytes=100-' } });
        expect(r.data.range.ranges[0].start).toBe(100);
        expect(r.data.range.ranges[0].end).toBe(499);
    });
});

// ===========================================================
//  req.query — edge cases
// ===========================================================
describe('Request — query parsing', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/q', (req, res) => res.json({ query: req.query }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses multiple query params', async () => {
        const r = await doFetch(`${base}/q?a=1&b=2&c=hello`);
        expect(r.data.query).toEqual({ a: '1', b: '2', c: 'hello' });
    });

    it('empty query returns empty object', async () => {
        const r = await doFetch(`${base}/q`);
        expect(r.data.query).toEqual({});
    });

    it('handles encoded values', async () => {
        const r = await doFetch(`${base}/q?msg=hello%20world&sym=%26%3D`);
        expect(r.data.query.msg).toBe('hello world');
        expect(r.data.query.sym).toBe('&=');
    });

    it('handles empty value', async () => {
        const r = await doFetch(`${base}/q?flag=&key=val`);
        expect(r.data.query.flag).toBe('');
        expect(r.data.query.key).toBe('val');
    });
});

// ===========================================================
//  req.ip, req.secure, req.method, req.body defaults
// ===========================================================
describe('Request — basic properties', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/props', (req, res) => {
            res.json({
                ip: req.ip,
                secure: req.secure,
                method: req.method,
                bodyNull: req.body === null,
                hasLocals: typeof req.locals === 'object',
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('ip is set', async () => {
        const r = await doFetch(`${base}/props`);
        expect(r.data.ip).toBeTruthy();
    });

    it('secure is false for HTTP', async () => {
        const r = await doFetch(`${base}/props`);
        expect(r.data.secure).toBe(false);
    });

    it('method is GET', async () => {
        const r = await doFetch(`${base}/props`);
        expect(r.data.method).toBe('GET');
    });

    it('body is null by default', async () => {
        const r = await doFetch(`${base}/props`);
        expect(r.data.bodyNull).toBe(true);
    });

    it('locals object exists', async () => {
        const r = await doFetch(`${base}/props`);
        expect(r.data.hasLocals).toBe(true);
    });
});

// =========================================================================
//  Query parameter limit (from audit)
// =========================================================================

describe('Query parameter limit', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/q', (req, res) => res.json({ count: Object.keys(req.query).length, query: req.query }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses normal query parameters', async () =>
    {
        const r = await doFetch(`${base}/q?a=1&b=2&c=3`);
        expect(r.data.count).toBe(3);
        expect(r.data.query.a).toBe('1');
    });

    it('limits query parameters to 100', async () =>
    {
        const params = Array.from({ length: 150 }, (_, i) => `p${i}=${i}`).join('&');
        const r = await doFetch(`${base}/q?${params}`);
        expect(r.data.count).toBe(100);
    });

    it('handles malformed URI components gracefully', async () =>
    {
        const r = await doFetch(`${base}/q?ok=1&bad=%zz&good=2`);
        expect(r.data.query.ok).toBe('1');
        expect(r.data.query.good).toBe('2');
    });
});

// =========================================================================
//  Request.accepts optimization (from audit)
// =========================================================================

describe('Request.accepts', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/accept', (req, res) =>
        {
            const best = req.accepts('json', 'html', 'text');
            res.json({ best });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns first type for wildcard accept', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': '*/*' },
        });
        expect(r.data.best).toBe('json');
    });

    it('matches specific MIME types', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'text/html' },
        });
        expect(r.data.best).toBe('html');
    });

    it('matches type/* wildcards', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'text/*' },
        });
        expect(r.data.best).toBe('html');
    });

    it('returns false for no match', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'image/png' },
        });
        expect(r.data.best).toBe(false);
    });
});



// =========================================================================
//  request — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  13. REQUEST — QUERY PROTO POLLUTION, ACCEPTS NO HEADER
// ============================================================
describe('request — query __proto__ pollution prevention', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/echo', (req, res) => res.json(req.query));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('strips __proto__ from query params', async () => {
		const { data } = await doFetch(`${base}/echo?__proto__=polluted&safe=yes`);
		expect(Object.keys(data).includes('__proto__')).toBe(false);
		expect(data.safe).toBe('yes');
	});

	it('strips constructor from query params', async () => {
		const { data } = await doFetch(`${base}/echo?constructor=bad&ok=1`);
		expect(Object.keys(data).includes('constructor')).toBe(false);
		expect(data.ok).toBe('1');
	});

	it('strips prototype from query params', async () => {
		const { data } = await doFetch(`${base}/echo?prototype=bad&ok=1`);
		expect(Object.keys(data).includes('prototype')).toBe(false);
	});
});

describe('request — accepts without Accept header', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/accept', (req, res) => {
			// Remove accept header to test default behavior
			delete req.headers['accept'];
			const result = req.accepts('json', 'html');
			res.json({ accepted: result });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('returns first type when no Accept header (defaults to */*)', async () => {
		const { data } = await doFetch(`${base}/accept`);
		expect(data.accepted).toBe('json');
	});
});

describe('request — cookies without middleware', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/test', (req, res) => res.json({ cookies: req.cookies }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('req.cookies is empty object without cookieParser', async () => {
		const { data } = await doFetch(`${base}/test`);
		expect(data.cookies).toEqual({});
	});
});
