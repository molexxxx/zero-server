const http = require('http');
const fs = require('fs');
const path = require('path');
const { doFetch, fetch } = require('../_helpers');
const { createApp } = require('../../');

describe('CRLF Injection Prevention', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/header-inject', (req, res) => {
            try {
                res.set('X-Custom', 'value\r\nInjected-Header: evil');
                res.json({ ok: false });
            } catch (e) {
                res.json({ blocked: true, error: e.message });
            }
        });
        app.get('/append-inject', (req, res) => {
            try {
                res.append('X-Custom', 'value\nEvil: injected');
                res.json({ ok: false });
            } catch (e) {
                res.json({ blocked: true });
            }
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('set() blocks CR/LF in header value', async () => {
        const r = await doFetch(`${base}/header-inject`);
        expect(r.data.blocked).toBe(true);
    });

    it('append() blocks CR/LF in header value', async () => {
        const r = await doFetch(`${base}/append-inject`);
        expect(r.data.blocked).toBe(true);
    });
});

describe('Response QoL Methods', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/send-status', (req, res) => res.sendStatus(204));
        app.get('/send-status-404', (req, res) => res.sendStatus(404));
        app.get('/append-header', (req, res) => {
            res.append('X-Custom', 'val1');
            res.append('X-Custom', 'val2');
            res.json({ ok: true });
        });
        app.get('/vary-test', (req, res) => {
            res.vary('Accept');
            res.vary('Accept-Encoding');
            res.vary('Accept');
            res.json({ ok: true });
        });
        app.get('/headers-sent', (req, res) => {
            const before = res.headersSent;
            res.json({ before, after: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sendStatus returns 204', async () => {
        const r = await fetch(`${base}/send-status`);
        expect(r.status).toBe(204);
    });

    it('sendStatus returns 404 with reason phrase', async () => {
        const r = await doFetch(`${base}/send-status-404`);
        expect(r.status).toBe(404);
        expect(r.data).toBe('Not Found');
    });

    it('append combines header values', async () => {
        const r = await doFetch(`${base}/append-header`);
        expect(r.headers.get('x-custom')).toBe('val1, val2');
    });

    it('vary adds fields without duplicates', async () => {
        const r = await doFetch(`${base}/vary-test`);
        const vary = r.headers.get('vary') || '';
        expect(vary).toContain('Accept');
        expect(vary).toContain('Accept-Encoding');
        const parts = vary.split(',').map(s => s.trim().toLowerCase());
        expect(parts.filter(v => v === 'accept').length).toBe(1);
    });

    it('headersSent is false before send', async () => {
        const r = await doFetch(`${base}/headers-sent`);
        expect(r.data.before).toBe(false);
    });
});

describe('Response Cookies', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/set-cookie', (req, res) => {
            res.cookie('session', 'abc123', { maxAge: 3600, httpOnly: true, secure: true });
            res.cookie('theme', 'dark', { sameSite: 'Strict' });
            res.json({ ok: true });
        });
        app.get('/clear-cookie', (req, res) => {
            res.clearCookie('session');
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets cookie with correct flags', async () => {
        const r = await fetch(`${base}/set-cookie`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('session');
        expect(sc).toContain('HttpOnly');
        expect(sc).toContain('Secure');
        expect(sc).toContain('Max-Age=3600');
    });

    it('clearCookie sets Max-Age=0', async () => {
        const r = await fetch(`${base}/clear-cookie`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('Max-Age=0');
    });
});

describe('Response sendFile/download', () => {
    let server, base;
    const staticDir = path.join(__dirname, 'static-res');

    beforeAll(async () => {
        fs.mkdirSync(staticDir, { recursive: true });
        fs.writeFileSync(path.join(staticDir, 'hello.txt'), 'hello world');

        const app = createApp();
        app.get('/file', (req, res) => res.sendFile(path.join(staticDir, 'hello.txt')));
        app.get('/file-root', (req, res) => res.sendFile('hello.txt', { root: staticDir }));
        app.get('/file-missing', (req, res) => res.sendFile(path.join(staticDir, 'nope.txt')));
        app.get('/download', (req, res) => res.download(path.join(staticDir, 'hello.txt'), 'custom-name.txt'));
        app.get('/file-traversal', (req, res) => res.sendFile('../package.json', { root: staticDir }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(staticDir, { recursive: true, force: true }); } catch {}
    });

    it('serves file content', async () => {
        const r = await doFetch(`${base}/file`);
        expect(r.data).toBe('hello world');
    });

    it('correct MIME type', async () => {
        const r = await doFetch(`${base}/file`);
        expect(r.headers.get('content-type')).toContain('text/plain');
    });

    it('root option works', async () => {
        const r = await doFetch(`${base}/file-root`);
        expect(r.data).toBe('hello world');
    });

    it('404 for missing file', async () => {
        const r = await doFetch(`${base}/file-missing`);
        expect(r.status).toBe(404);
    });

    it('download sets Content-Disposition', async () => {
        const r = await fetch(`${base}/download`);
        const cd = r.headers.get('content-disposition') || '';
        expect(cd).toContain('attachment');
        expect(cd).toContain('custom-name.txt');
    });

    it('path traversal with root is blocked', async () => {
        const r = await doFetch(`${base}/file-traversal`);
        expect(r.status).toBe(403);
    });
});

describe('Redirect Edge Cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/redir-default', (req, res) => res.redirect('/target'));
        app.get('/redir-301', (req, res) => res.redirect(301, '/target'));
        app.get('/redir-307', (req, res) => res.redirect(307, '/other'));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('default redirect is 302', async () => {
        const r = await fetch(`${base}/redir-default`);
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/target');
    });

    it('custom 301 status', async () => {
        const r = await fetch(`${base}/redir-301`);
        expect(r.status).toBe(301);
    });

    it('307 preserves method', async () => {
        const r = await fetch(`${base}/redir-307`);
        expect(r.status).toBe(307);
        expect(r.headers.get('location')).toBe('/other');
    });
});

describe('Double Send Protection', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/double', (req, res) => {
            res.json({ first: true });
            res.json({ second: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('first response wins', async () => {
        const r = await doFetch(`${base}/double`);
        expect(r.data.first).toBe(true);
        expect(r.data.second).toBeUndefined();
    });
});

// ===========================================================
//  type() shorthands
// ===========================================================
describe('Response — type() shorthands', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/type-json', (req, res) => { res.type('json'); res.send({ a: 1 }); });
        app.get('/type-html', (req, res) => { res.type('html'); res.send('<p>hi</p>'); });
        app.get('/type-text', (req, res) => { res.type('text'); res.send('hello'); });
        app.get('/type-xml', (req, res) => { res.type('xml'); res.send('<x/>'); });
        app.get('/type-form', (req, res) => { res.type('form'); res.send('a=1'); });
        app.get('/type-bin', (req, res) => { res.type('bin'); res.send(Buffer.from([1, 2, 3])); });
        app.get('/type-custom', (req, res) => { res.type('image/png'); res.send(Buffer.from([])); });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('json shorthand', async () => {
        const r = await fetch(`${base}/type-json`);
        expect(r.headers.get('content-type')).toBe('application/json');
    });

    it('html shorthand', async () => {
        const r = await fetch(`${base}/type-html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('text shorthand', async () => {
        const r = await fetch(`${base}/type-text`);
        expect(r.headers.get('content-type')).toBe('text/plain');
    });

    it('xml shorthand', async () => {
        const r = await fetch(`${base}/type-xml`);
        expect(r.headers.get('content-type')).toBe('application/xml');
    });

    it('form shorthand', async () => {
        const r = await fetch(`${base}/type-form`);
        expect(r.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    });

    it('bin shorthand', async () => {
        const r = await fetch(`${base}/type-bin`);
        expect(r.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('full MIME passthrough', async () => {
        const r = await fetch(`${base}/type-custom`);
        expect(r.headers.get('content-type')).toBe('image/png');
    });
});

// ===========================================================
//  send() auto-detection
// ===========================================================
describe('Response — send() auto-detection', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/send-buffer', (req, res) => res.send(Buffer.from('binary')));
        app.get('/send-string', (req, res) => res.send('just text'));
        app.get('/send-html', (req, res) => res.send('<h1>HTML</h1>'));
        app.get('/send-object', (req, res) => res.send({ key: 'val' }));
        app.get('/send-null', (req, res) => res.send(null));
        app.get('/send-array', (req, res) => res.send([1, 2, 3]));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('Buffer → application/octet-stream', async () => {
        const r = await fetch(`${base}/send-buffer`);
        expect(r.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('plain string → text/plain', async () => {
        const r = await fetch(`${base}/send-string`);
        expect(r.headers.get('content-type')).toBe('text/plain');
    });

    it('HTML string → text/html', async () => {
        const r = await fetch(`${base}/send-html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('object → application/json', async () => {
        const r = await doFetch(`${base}/send-object`);
        expect(r.data).toEqual({ key: 'val' });
    });

    it('null → empty body', async () => {
        const r = await fetch(`${base}/send-null`);
        expect(r.status).toBe(200);
        const text = await r.text();
        expect(text).toBe('');
    });

    it('array → JSON', async () => {
        const r = await doFetch(`${base}/send-array`);
        expect(r.data).toEqual([1, 2, 3]);
    });
});

// ===========================================================
//  vary('*') behavior
// ===========================================================
describe('Response — vary() edge cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/vary-star', (req, res) => {
            res.vary('*');
            res.vary('Accept'); // should be ignored after *
            res.json({ ok: true });
        });
        app.get('/vary-before-star', (req, res) => {
            res.vary('Accept');
            res.vary('*'); // should replace to *
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('vary(*) sets wildcard', async () => {
        const r = await fetch(`${base}/vary-star`);
        expect(r.headers.get('vary')).toBe('*');
    });

    it('vary(*) after field replaces with *', async () => {
        const r = await fetch(`${base}/vary-before-star`);
        expect(r.headers.get('vary')).toBe('*');
    });
});

// ===========================================================
//  Cookie — all option combinations
// ===========================================================
describe('Response — cookie option combinations', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/cookie-domain', (req, res) => {
            res.cookie('a', '1', { domain: '.example.com', path: '/api' });
            res.json({});
        });
        app.get('/cookie-expires', (req, res) => {
            res.cookie('b', '2', { expires: new Date('2030-01-01T00:00:00Z') });
            res.json({});
        });
        app.get('/cookie-no-httponly', (req, res) => {
            res.cookie('c', '3', { httpOnly: false });
            res.json({});
        });
        app.get('/cookie-samesite', (req, res) => {
            res.cookie('d', '4', { sameSite: 'None', secure: true });
            res.json({});
        });
        app.get('/multi-cookies', (req, res) => {
            res.cookie('x', '1');
            res.cookie('y', '2');
            res.json({});
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('domain and path options', async () => {
        const r = await fetch(`${base}/cookie-domain`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('Domain=.example.com');
        expect(sc).toContain('Path=/api');
    });

    it('expires option', async () => {
        const r = await fetch(`${base}/cookie-expires`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('Expires=');
        expect(sc).toContain('2030');
    });

    it('httpOnly: false omits HttpOnly flag', async () => {
        const r = await fetch(`${base}/cookie-no-httponly`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).not.toContain('HttpOnly');
    });

    it('sameSite=None with secure', async () => {
        const r = await fetch(`${base}/cookie-samesite`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('SameSite=None');
        expect(sc).toContain('Secure');
    });

    it('multiple cookies set', async () => {
        const r = await fetch(`${base}/multi-cookies`);
        const sc = r.headers.get('set-cookie') || '';
        expect(sc).toContain('x=');
        expect(sc).toContain('y=');
    });
});

// ===========================================================
//  res.get() — response header retrieval
// ===========================================================
describe('Response — get() header retrieval', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/get-hdr', (req, res) => {
            res.set('X-Custom', 'value');
            res.json({
                exact: res.get('X-Custom'),
                caseInsensitive: res.get('x-custom'),
                missing: res.get('X-Nothing'),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('retrieves set header', async () => {
        const r = await doFetch(`${base}/get-hdr`);
        expect(r.data.exact).toBe('value');
    });

    it('case-insensitive', async () => {
        const r = await doFetch(`${base}/get-hdr`);
        expect(r.data.caseInsensitive).toBe('value');
    });

    it('returns undefined for missing', async () => {
        const r = await doFetch(`${base}/get-hdr`);
        expect(r.data.missing).toBeUndefined();
    });
});

// ===========================================================
//  sendFile — callback usage
// ===========================================================
describe('Response — sendFile callback', () => {
    let server, base;
    const dir = path.join(__dirname, 'res-sendfile-cb');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ok.txt'), 'content');

        const app = createApp();
        app.get('/cb-ok', (req, res) => {
            res.sendFile('ok.txt', { root: dir }, (err) => {
                // no err expected
            });
        });
        app.get('/cb-err', (req, res) => {
            res.sendFile('nope.txt', { root: dir }, (err) => {
                if (err) res.status(err.status || 500).json({ error: err.message, fromCallback: true });
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('callback receives null on success', async () => {
        const r = await doFetch(`${base}/cb-ok`);
        expect(r.status).toBe(200);
        expect(r.data).toBe('content');
    });

    it('callback receives error on missing file', async () => {
        const r = await doFetch(`${base}/cb-err`);
        expect(r.status).toBe(404);
        expect(r.data.fromCallback).toBe(true);
    });
});

// ===========================================================
//  Response — text() and html() helpers
// ===========================================================
describe('Response — text() and html()', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/text-resp', (req, res) => res.text('hello world'));
        app.get('/html-resp', (req, res) => res.html('<h1>Hi</h1>'));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('text() sets text/plain', async () => {
        const r = await fetch(`${base}/text-resp`);
        expect(r.headers.get('content-type')).toBe('text/plain');
        expect(await r.text()).toBe('hello world');
    });

    it('html() sets text/html', async () => {
        const r = await fetch(`${base}/html-resp`);
        expect(r.headers.get('content-type')).toBe('text/html');
        expect(await r.text()).toBe('<h1>Hi</h1>');
    });
});

// ===========================================================
//  status() chainability
// ===========================================================
describe('Response — status() chain', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/chain', (req, res) => res.status(201).json({ created: true }));
        app.get('/chain-set', (req, res) => res.status(200).set('X-A', '1').set('X-B', '2').json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('status chains into json', async () => {
        const r = await doFetch(`${base}/chain`);
        expect(r.status).toBe(201);
        expect(r.data.created).toBe(true);
    });

    it('status + set + set chains', async () => {
        const r = await doFetch(`${base}/chain-set`);
        expect(r.headers.get('x-a')).toBe('1');
        expect(r.headers.get('x-b')).toBe('2');
    });
});

// =========================================================================
//  Response send optimizations (from audit)
// =========================================================================

describe('Response send optimizations', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/html', (req, res) => res.send('<h1>Hello</h1>'));
        app.get('/text', (req, res) => res.send('plain text'));
        app.get('/whitespace-html', (req, res) => res.send('  \n  <div>indented</div>'));
        app.get('/json', (req, res) => res.send({ key: 'value' }));
        app.get('/buffer', (req, res) => res.send(Buffer.from('binary')));
        app.get('/null', (req, res) => res.send(null));
        app.get('/download', (req, res) => res.download(__filename));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('auto-detects HTML content type', async () =>
    {
        const r = await doFetch(`${base}/html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('auto-detects plain text content type', async () =>
    {
        const r = await doFetch(`${base}/text`);
        expect(r.headers.get('content-type')).toBe('text/plain');
    });

    it('detects HTML even with leading whitespace', async () =>
    {
        const r = await doFetch(`${base}/whitespace-html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('sends JSON with correct Content-Type', async () =>
    {
        const r = await doFetch(`${base}/json`);
        expect(r.headers.get('content-type')).toBe('application/json');
        expect(r.data.key).toBe('value');
    });

    it('sends Buffer with octet-stream', async () =>
    {
        const r = await doFetch(`${base}/buffer`);
        expect(r.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('sends null/empty response', async () =>
    {
        const r = await doFetch(`${base}/null`);
        expect(r.status).toBe(200);
    });

    it('download sets Content-Disposition', async () =>
    {
        const r = await doFetch(`${base}/download`);
        expect(r.headers.get('content-disposition')).toContain('attachment');
    });
});



// =========================================================================
//  response — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  14. RESPONSE — SET OBJECT, FORMAT WILDCARD
// ============================================================
describe('response — res.set with chaining', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/headers', (req, res) => {
			res.set('X-Custom-A', 'alpha').set('X-Custom-B', 'beta');
			res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets multiple headers via chaining', async () => {
		const r = await fetch(`${base}/headers`);
		expect(r.headers.get('x-custom-a')).toBe('alpha');
		expect(r.headers.get('x-custom-b')).toBe('beta');
	});
});

describe('response — res.format with wildcard Accept', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/format', (req, res) => {
			res.format({
				'application/json': () => res.json({ type: 'json' }),
				'text/plain': () => res.text('plain'),
			});
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('selects first format for */* Accept', async () => {
		const r = await fetch(`${base}/format`, {
			headers: { 'accept': '*/*' },
		});
		expect(r.status).toBe(200);
	});
});