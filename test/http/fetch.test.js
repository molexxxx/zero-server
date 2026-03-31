const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp } = require('../../');

describe('Fetch Replacement', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/fetch-test', (req, res) => res.json({ hello: 'world' }));
        app.post('/fetch-post', (req, res) => res.json({ method: 'POST' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('ok property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.ok).toBe(true);
    });

    it('status property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.status).toBe(200);
    });

    it('url property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(typeof r.url).toBe('string');
    });

    it('secure property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.secure).toBe(false);
    });

    it('json() parsing', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const body = await r.json();
        expect(body.hello).toBe('world');
    });

    it('POST method', async () => {
        const r = await fetch(`${base}/fetch-post`, {
            method: 'POST',
            body: JSON.stringify({ test: 1 }),
            headers: { 'content-type': 'application/json' }
        });
        const body = await r.json();
        expect(body.method).toBe('POST');
    });

    it('text() returns string', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const t = await r.text();
        expect(typeof t).toBe('string');
    });

    it('arrayBuffer() returns Buffer', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const buf = await r.arrayBuffer();
        expect(Buffer.isBuffer(buf)).toBe(true);
    });
});



// =========================================================================
//  fetch — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  4. FETCH — TIMEOUT, ABORT, PROGRESS, STATUS
// ============================================================
describe('fetch — timeout', () => {
	let server, base;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			// Intentionally slow — never responds within timeout
			setTimeout(() => {
				res.writeHead(200);
				res.end('ok');
			}, 5000);
		});
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('rejects with timeout error', async () => {
		const { fetch } = require('../../');
		await expect(fetch(`${base}/slow`, { timeout: 100 }))
			.rejects.toThrow();
	});
});

describe('fetch — AbortSignal', () => {
	let server, base;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			setTimeout(() => {
				res.writeHead(200);
				res.end('ok');
			}, 5000);
		});
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('aborts a request via AbortController', async () => {
		const { fetch } = require('../../');
		const controller = new AbortController();
		const p = fetch(`${base}/`, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(p).rejects.toThrow();
	});

	it('rejects immediately if signal is already aborted', async () => {
		const { fetch } = require('../../');
		const controller = new AbortController();
		controller.abort();
		await expect(fetch(`${base}/`, { signal: controller.signal }))
			.rejects.toThrow();
	});
});

describe('fetch — ok, statusText, error responses', () => {
	let server, base;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/ok') { res.writeHead(200); res.end('ok'); }
			else if (req.url === '/not-found') { res.writeHead(404); res.end('nope'); }
			else if (req.url === '/error') { res.writeHead(500); res.end('error'); }
			else { res.writeHead(200); res.end(); }
		});
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('ok is true for 200', async () => {
		const { fetch } = require('../../');
		const r = await fetch(`${base}/ok`);
		expect(r.ok).toBe(true);
		expect(r.statusText).toBe('OK');
	});

	it('ok is false for 404', async () => {
		const { fetch } = require('../../');
		const r = await fetch(`${base}/not-found`);
		expect(r.ok).toBe(false);
		expect(r.status).toBe(404);
		expect(r.statusText).toBe('Not Found');
	});

	it('ok is false for 500', async () => {
		const { fetch } = require('../../');
		const r = await fetch(`${base}/error`);
		expect(r.ok).toBe(false);
		expect(r.status).toBe(500);
	});

	it('arrayBuffer returns Buffer', async () => {
		const { fetch } = require('../../');
		const r = await fetch(`${base}/ok`);
		const buf = await r.arrayBuffer();
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(buf.toString()).toBe('ok');
	});
});

describe('fetch — URLSearchParams body', () => {
	let server, base, received;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			let body = '';
			req.on('data', c => body += c);
			req.on('end', () => {
				received = { ct: req.headers['content-type'], body };
				res.writeHead(200);
				res.end('ok');
			});
		});
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('auto-serializes URLSearchParams to form-encoded', async () => {
		const { fetch } = require('../../');
		const params = new URLSearchParams({ foo: 'bar', baz: '123' });
		await fetch(`${base}/`, { method: 'POST', body: params });
		expect(received.ct).toContain('application/x-www-form-urlencoded');
		expect(received.body).toContain('foo=bar');
		expect(received.body).toContain('baz=123');
	});
});

describe('fetch — download progress', () => {
	let server, base;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const data = Buffer.alloc(1024, 'x');
			res.writeHead(200, { 'Content-Length': String(data.length) });
			res.end(data);
		});
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('calls onDownloadProgress with loaded and total', async () => {
		const { fetch } = require('../../');
		const progress = [];
		await fetch(`${base}/`, {
			onDownloadProgress: (p) => progress.push(p),
		});
		expect(progress.length).toBeGreaterThanOrEqual(1);
		const last = progress[progress.length - 1];
		expect(last.loaded).toBe(1024);
		expect(last.total).toBe(1024);
	});
});