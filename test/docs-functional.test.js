/**
 * Functional integration tests that verify every testable documentation example
 * actually works end-to-end against a live server.
 *
 * Sections covered:
 *   Getting Started, Core (createApp, Router, Request, Response),
 *   Body Parsers (json, urlencoded, text, raw, multipart),
 *   Middleware (cors, compress, helmet, static, rateLimit, timeout, requestId, logger),
 *   Cookies & Security (cookieParser, csrf, validate),
 *   Environment (env, Schema Types),
 *   ORM (Database memory adapter, Model, Query, TYPES),
 *   Real-Time (WebSocket, WebSocketPool, SSE),
 *   Networking (fetch),
 *   Error Handling (Error Classes, Framework Errors, errorHandler, debug)
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { doFetch, fetch } = require('./_helpers');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function collectSSE(url) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		http.get(url, resp => {
			resp.on('data', c => chunks.push(c.toString()));
			resp.on('end', () => resolve({ body: chunks.join(''), headers: resp.headers, status: resp.statusCode }));
		}).on('error', reject);
	});
}

function wsConnect(portNum, wsPath, extraHeaders) {
	return new Promise((resolve, reject) => {
		const key = crypto.randomBytes(16).toString('base64');
		const socket = net.connect(portNum, '127.0.0.1', () => {
			let h = `GET ${wsPath} HTTP/1.1\r\nHost: localhost:${portNum}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
			if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h += `${k}: ${v}\r\n`;
			h += '\r\n';
			socket.write(h);
		});
		let upgraded = false, headerBuf = '';
		const messages = [];
		socket.on('data', chunk => {
			if (!upgraded) {
				headerBuf += chunk.toString();
				if (headerBuf.includes('\r\n\r\n')) {
					upgraded = true;
					const remaining = chunk.slice(chunk.indexOf(Buffer.from('\r\n\r\n')) + 4);
					if (remaining.length > 0) parseFrames(remaining);
				}
				return;
			}
			parseFrames(chunk);
		});
		function parseFrames(buf) {
			while (buf.length >= 2) {
				const opcode = buf[0] & 0x0F;
				let payloadLen = buf[1] & 0x7F, offset = 2;
				if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
				else if (payloadLen === 127) { payloadLen = buf.readUInt32BE(6); offset = 10; }
				if (buf.length < offset + payloadLen) break;
				const payload = buf.slice(offset, offset + payloadLen);
				if (opcode === 0x01) messages.push(payload.toString('utf8'));
				else if (opcode === 0x08) { socket.end(); return; }
				buf = buf.slice(offset + payloadLen);
			}
		}
		function sendWSFrame(text) {
			const payload = Buffer.from(text, 'utf8');
			const mask = crypto.randomBytes(4);
			const masked = Buffer.alloc(payload.length);
			for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
			let header;
			if (payload.length < 126) {
				header = Buffer.alloc(2);
				header[0] = 0x81; header[1] = 0x80 | payload.length;
			} else {
				header = Buffer.alloc(4);
				header[0] = 0x81; header[1] = 0x80 | 126;
				header.writeUInt16BE(payload.length, 2);
			}
			socket.write(Buffer.concat([header, mask, masked]));
		}
		socket.on('error', reject);
		setTimeout(() => resolve({ socket, messages, sendWSFrame }), 150);
	});
}

function sendCloseFrame(socket) {
	const header = Buffer.alloc(6);
	header[0] = 0x88; // FIN + close
	header[1] = 0x80; // masked, 0-length
	const mask = crypto.randomBytes(4);
	mask.copy(header, 2);
	socket.write(header);
	setTimeout(() => socket.destroy(), 50);
}

// ============================================================
//  1. CORE — createApp (settings, locals, chaining, groups,
//            param handlers, route introspection)
// ============================================================

describe('Docs — Core: createApp', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, json, Router } = require('../');
		const app = createApp();

		// --- Doc example: App settings ---
		app.set('env', 'production');
		app.enable('trust proxy');

		// --- Doc example: Shared locals ---
		app.locals.appName = 'My API';

		// --- Doc example: Route chaining ---
		app.get('/', (req, res) => res.json({ app: req.locals.appName }))
			.get('/health', (req, res) => res.sendStatus(200));

		// --- Doc example: Route groups with shared middleware ---
		app.group('/api/v1', json(), (router) => {
			router.get('/users', (req, res) => res.json([]));
			router.post('/users', (req, res) => res.status(201).json(req.body));
		});

		// --- Doc example: Param handlers ---
		app.param('id', (req, res, next, value) => {
			if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'Invalid ID' });
			next();
		});
		app.get('/items/:id', (req, res) => res.json({ id: req.params.id }));

		// --- Route introspection ---
		app.get('/debug/routes', (req, res) => res.json(app.routes()));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('app.set / app.get / app.enable / app.enabled work', () => {
		const { createApp } = require('../');
		const a = createApp();
		a.set('env', 'production');
		a.enable('trust proxy');
		expect(a.get('env')).toBe('production');
		expect(a.enabled('trust proxy')).toBe(true);
		a.disable('trust proxy');
		expect(a.disabled('trust proxy')).toBe(true);
	});

	it('locals are merged into req.locals', async () => {
		const r = await doFetch(`${base}/`);
		expect(r.data.app).toBe('My API');
	});

	it('route chaining works', async () => {
		const r = await doFetch(`${base}/health`);
		expect(r.status).toBe(200);
	});

	it('route groups work', async () => {
		const r = await doFetch(`${base}/api/v1/users`);
		expect(r.status).toBe(200);
		expect(r.data).toEqual([]);
	});

	it('group POST works', async () => {
		const r = await doFetch(`${base}/api/v1/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice' }),
		});
		expect(r.status).toBe(201);
		expect(r.data.name).toBe('Alice');
	});

	it('param handler rejects non-numeric ids', async () => {
		const r = await doFetch(`${base}/items/abc`);
		expect(r.status).toBe(400);
		expect(r.data.error).toBe('Invalid ID');
	});

	it('param handler accepts numeric ids', async () => {
		const r = await doFetch(`${base}/items/42`);
		expect(r.status).toBe(200);
		expect(r.data.id).toBe('42');
	});

	it('routes() returns the route table', async () => {
		const r = await doFetch(`${base}/debug/routes`);
		expect(r.status).toBe(200);
		expect(Array.isArray(r.data)).toBe(true);
		expect(r.data.length).toBeGreaterThan(0);
	});
});

// ============================================================
//  2. CORE — Router (sub-apps, route chaining, inspect)
// ============================================================

describe('Docs — Core: Router', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, Router, json } = require('../');
		const app = createApp();
		app.use(json());

		// --- Doc example from Router section ---
		const users = Router();
		users.get('/', (req, res) => res.json([]));
		users.get('/:id', (req, res) => res.json({ id: req.params.id }));
		users.post('/', (req, res) => res.status(201).json(req.body));

		const posts = Router();
		posts.route('/')
			.get((req, res) => res.json([]))
			.post((req, res) => res.status(201).json(req.body));
		posts.get('/:id', (req, res) => res.json({ id: req.params.id }));

		app.use('/api/users', users);
		app.use('/api/posts', posts);
		app.get('/debug/routes', (req, res) => res.json(app.routes()));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('GET /api/users returns []', async () => {
		const r = await doFetch(`${base}/api/users`);
		expect(r.data).toEqual([]);
	});

	it('GET /api/users/:id returns param', async () => {
		const r = await doFetch(`${base}/api/users/7`);
		expect(r.data.id).toBe('7');
	});

	it('POST /api/users creates', async () => {
		const r = await doFetch(`${base}/api/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Bob' }),
		});
		expect(r.status).toBe(201);
		expect(r.data.name).toBe('Bob');
	});

	it('Router.route() chaining works for GET', async () => {
		const r = await doFetch(`${base}/api/posts`);
		expect(r.data).toEqual([]);
	});

	it('Router.route() chaining works for POST', async () => {
		const r = await doFetch(`${base}/api/posts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Hello' }),
		});
		expect(r.status).toBe(201);
		expect(r.data.title).toBe('Hello');
	});

	it('Router.inspect() returns routes', () => {
		const { Router } = require('../');
		const r = Router();
		r.get('/a', () => {});
		r.post('/b', () => {});
		const table = r.inspect();
		expect(Array.isArray(table)).toBe(true);
		expect(table.length).toBeGreaterThanOrEqual(2);
	});

	it('app.routes() includes mounted router routes', async () => {
		const r = await doFetch(`${base}/debug/routes`);
		const paths = r.data.map(rt => rt.path);
		expect(paths.some(p => p.includes('users'))).toBe(true);
		expect(paths.some(p => p.includes('posts'))).toBe(true);
	});
});

// ============================================================
//  3. CORE — Request & Response
// ============================================================

describe('Docs — Core: Request & Response', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, json, requestId } = require('../');
		const app = createApp();
		app.use(requestId());
		app.use(json());

		// --- Doc: Request properties ---
		app.get('/req-info', (req, res) => {
			res.json({
				method: req.method,
				path: req.path,
				query: req.query,
				ip: req.ip,
				protocol: req.protocol,
				hostname: req.hostname,
				originalUrl: req.originalUrl,
				id: req.id,
				xhr: req.xhr,
				fresh: req.fresh,
				stale: req.stale,
			});
		});

		// --- Doc: req.get() ---
		app.get('/req-get-header', (req, res) => {
			res.json({ ua: req.get('user-agent') });
		});

		// --- Doc: req.is() ---
		app.post('/req-is', (req, res) => {
			res.json({ isJson: req.is('json'), isText: req.is('text') });
		});

		// --- Doc: Response content negotiation ---
		app.get('/data', (req, res) => {
			res.format({
				'text/html': () => res.html('<h1>Data</h1>'),
				'application/json': () => res.json({ data: true }),
				'text/plain': () => res.text('data'),
				default: () => res.status(406).json({ error: 'Not Acceptable' }),
			});
		});

		// --- Doc: Response chaining ---
		app.get('/chain', (req, res) => {
			res.status(201).set('X-Custom', 'value').json({ ok: true });
		});

		// --- Doc: sendStatus ---
		app.get('/send-status', (req, res) => res.sendStatus(204));

		// --- Doc: res.html ---
		app.get('/html', (req, res) => res.html('<h1>Hello</h1>'));

		// --- Doc: res.text ---
		app.get('/text', (req, res) => res.text('plain text'));

		// --- Doc: res.redirect ---
		app.get('/redir', (req, res) => res.redirect('/target'));

		// --- Doc: res.links ---
		app.get('/links', (req, res) => {
			res.links({ next: '/page/2', prev: '/page/0' });
			res.json({ ok: true });
		});

		// --- Doc: res.location ---
		app.get('/loc', (req, res) => {
			res.location('/new-place').json({ ok: true });
		});

		// --- Doc: res.vary ---
		app.get('/vary', (req, res) => {
			res.vary('Accept-Encoding').json({ ok: true });
		});

		// --- Doc: res.type ---
		app.get('/type', (req, res) => {
			res.type('text/xml').send('<root/>');
		});

		// --- Doc: res.append ---
		app.get('/append', (req, res) => {
			res.append('X-Multi', 'a').append('X-Multi', 'b').json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('req.method, req.path, req.query work', async () => {
		const r = await doFetch(`${base}/req-info?foo=bar`);
		expect(r.data.method).toBe('GET');
		expect(r.data.path).toBe('/req-info');
		expect(r.data.query.foo).toBe('bar');
	});

	it('req.ip is defined', async () => {
		const r = await doFetch(`${base}/req-info`);
		expect(r.data.ip).toBeDefined();
	});

	it('req.id is a UUID from requestId middleware', async () => {
		const r = await doFetch(`${base}/req-info`);
		expect(r.data.id).toBeDefined();
		expect(r.data.id.length).toBeGreaterThan(10);
	});

	it('req.get() returns header', async () => {
		const r = await doFetch(`${base}/req-get-header`, {
			headers: { 'user-agent': 'zero-test' },
		});
		expect(r.data.ua).toBeDefined();
	});

	it('req.is("json") matches JSON content-type', async () => {
		const r = await doFetch(`${base}/req-is`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(r.data.isJson).toBeTruthy();
	});

	it('res.format() negotiates JSON', async () => {
		const r = await fetch(`${base}/data`, {
			headers: { 'accept': 'application/json' },
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toBe(true);
	});

	it('res.format() negotiates text/plain', async () => {
		const r = await fetch(`${base}/data`, {
			headers: { 'accept': 'text/plain' },
		});
		expect(r.status).toBe(200);
		const body = await r.text();
		expect(body).toBe('data');
	});

	it('res.status().set().json() chaining', async () => {
		const r = await fetch(`${base}/chain`);
		expect(r.status).toBe(201);
		expect(r.headers.get('x-custom')).toBe('value');
		const body = await r.json();
		expect(body.ok).toBe(true);
	});

	it('res.sendStatus(204)', async () => {
		const r = await fetch(`${base}/send-status`);
		expect(r.status).toBe(204);
	});

	it('res.html() sets content-type html', async () => {
		const r = await fetch(`${base}/html`);
		expect(r.headers.get('content-type')).toContain('text/html');
		expect(await r.text()).toContain('<h1>Hello</h1>');
	});

	it('res.text() sets content-type text', async () => {
		const r = await fetch(`${base}/text`);
		expect(r.headers.get('content-type')).toContain('text/plain');
		expect(await r.text()).toBe('plain text');
	});

	it('res.redirect() sends 302', async () => {
		const r = await fetch(`${base}/redir`);
		// fetch follows redirects by default, but our fetch might not
		// Check for 302 or the location header
		expect(r.status === 302 || r.headers.get('location') === '/target').toBe(true);
	});

	it('res.links() sets Link header', async () => {
		const r = await fetch(`${base}/links`);
		const link = r.headers.get('link');
		expect(link).toContain('/page/2');
		expect(link).toContain('next');
	});

	it('res.location() sets Location header', async () => {
		const r = await fetch(`${base}/loc`);
		expect(r.headers.get('location')).toBe('/new-place');
	});

	it('res.vary() sets Vary header', async () => {
		const r = await fetch(`${base}/vary`);
		expect(r.headers.get('vary')).toContain('Accept-Encoding');
	});

	it('res.type() sets content type', async () => {
		const r = await fetch(`${base}/type`);
		expect(r.headers.get('content-type')).toContain('text/xml');
	});

	it('res.append() appends header values', async () => {
		const r = await fetch(`${base}/append`);
		const multi = r.headers.get('x-multi');
		expect(multi).toBeDefined();
	});
});

// ============================================================
//  4. BODY PARSERS — json, urlencoded, text, raw, multipart
// ============================================================

describe('Docs — Body Parsers', () => {
	let server, base, uploadsDir;

	beforeAll(async () => {
		const { createApp, json, urlencoded, text, raw, multipart } = require('../');
		const app = createApp();

		// --- Doc: json parser ---
		app.use(json({ limit: '10kb', strict: true }));
		app.post('/json', (req, res) => res.json({ received: req.body }));

		// --- Doc: urlencoded parser ---
		app.post('/form', urlencoded({ extended: true }), (req, res) => res.json(req.body));

		// --- Doc: text parser ---
		app.post('/log', text(), (req, res) => {
			res.text('Received: ' + req.body);
		});

		// --- Doc: raw parser ---
		app.post('/webhook', raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
			res.json({ isBuffer: Buffer.isBuffer(req.body) });
		});

		// --- Doc: multipart ---
		uploadsDir = path.join(__dirname, 'tmp-doc-uploads');
		app.post('/upload', multipart({
			dir: uploadsDir,
			maxFileSize: 10 * 1024 * 1024,
		}), (req, res) => {
			res.json({
				files: req.body.files,
				fields: req.body.fields,
			});
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => {
		server?.close();
		try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch {}
	});

	it('json: parses JSON body', async () => {
		const r = await doFetch(`${base}/json`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ a: 1, b: 'two' }),
		});
		expect(r.status).toBe(200);
		expect(r.data.received.a).toBe(1);
		expect(r.data.received.b).toBe('two');
	});

	it('json: strict mode rejects primitives', async () => {
		const r = await doFetch(`${base}/json`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '"hello"',
		});
		expect(r.status).toBe(400);
	});

	it('urlencoded: parses form data', async () => {
		const r = await doFetch(`${base}/form`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'name=Alice&age=30',
		});
		expect(r.data.name).toBe('Alice');
		expect(r.data.age).toBe('30');
	});

	it('urlencoded: extended nested parsing', async () => {
		const r = await doFetch(`${base}/form`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'user[name]=Alice&user[age]=30',
		});
		expect(r.data.user).toBeDefined();
		expect(r.data.user.name).toBe('Alice');
	});

	it('text: parses text body', async () => {
		const r = await doFetch(`${base}/log`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'hello text',
		});
		expect(r.data).toContain('Received: hello text');
	});

	it('raw: parses binary body as Buffer', async () => {
		const r = await doFetch(`${base}/webhook`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: Buffer.from([0x01, 0x02, 0x03]),
		});
		expect(r.data.isBuffer).toBe(true);
	});

	it('multipart: handles file upload', async () => {
		const boundary = '----TestBoundary' + Date.now();
		const filename = 'test.txt';
		const fileContent = 'hello file content';
		const body = [
			`--${boundary}`,
			`Content-Disposition: form-data; name="description"`,
			'',
			'My photo',
			`--${boundary}`,
			`Content-Disposition: form-data; name="file"; filename="${filename}"`,
			'Content-Type: text/plain',
			'',
			fileContent,
			`--${boundary}--`,
		].join('\r\n');

		const r = await doFetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
		expect(r.data.fields.description).toBe('My photo');
		const filesArray = Object.values(r.data.files);
		expect(filesArray.length).toBeGreaterThanOrEqual(1);
		expect(filesArray[0].originalFilename).toBe(filename);
	});
});

// ============================================================
//  5. MIDDLEWARE — cors
// ============================================================

describe('Docs — Middleware: cors', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, cors, json } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.use(cors({
			origin: [
				'https://mysite.com',
				'.mysite.com',
			],
			credentials: true,
			methods: 'GET,POST,PUT,DELETE',
		}));
		app.use(json());
		app.get('/data', (req, res) => res.json({ secure: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('exact origin match returns CORS headers', async () => {
		const r = await fetch(`${base}/data`, {
			headers: { 'origin': 'https://mysite.com' },
		});
		expect(r.headers.get('access-control-allow-origin')).toBe('https://mysite.com');
		expect(r.headers.get('access-control-allow-credentials')).toBe('true');
	});

	it('subdomain wildcard match works', async () => {
		const r = await fetch(`${base}/data`, {
			headers: { 'origin': 'https://api.mysite.com' },
		});
		expect(r.headers.get('access-control-allow-origin')).toBe('https://api.mysite.com');
	});

	it('non-matching origin is rejected', async () => {
		const r = await fetch(`${base}/data`, {
			headers: { 'origin': 'https://evil.com' },
		});
		expect(r.headers.get('access-control-allow-origin')).toBeFalsy();
	});

	it('preflight OPTIONS returns methods', async () => {
		const r = await fetch(`${base}/data`, {
			method: 'OPTIONS',
			headers: {
				'origin': 'https://mysite.com',
				'access-control-request-method': 'POST',
			},
		});
		expect(r.status).toBe(204);
		expect(r.headers.get('access-control-allow-methods')).toContain('POST');
	});
});

// ============================================================
//  6. MIDDLEWARE — compress
// ============================================================

describe('Docs — Middleware: compress', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, compress, json } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.use(compress({ threshold: 512, level: 6 }));
		app.use(json());
		app.get('/big', (req, res) => {
			res.json({ data: 'x'.repeat(10000) }); // compressed
		});
		app.get('/small', (req, res) => {
			res.json({ ok: true }); // below threshold — sent raw
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('large response is gzip-compressed and decompresses correctly', async () => {
		const result = await new Promise((resolve, reject) => {
			http.get(`${base}/big`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
				const chunks = [];
				resp.on('data', c => chunks.push(c));
				resp.on('end', () => {
					zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
						if (err) return reject(err);
						resolve({ body: JSON.parse(decoded.toString()), encoding: resp.headers['content-encoding'] });
					});
				});
			}).on('error', reject);
		});
		expect(result.encoding).toBe('gzip');
		expect(result.body.data).toBe('x'.repeat(10000));
	});

	it('large response supports deflate and decompresses correctly', async () => {
		const result = await new Promise((resolve, reject) => {
			http.get(`${base}/big`, { headers: { 'accept-encoding': 'deflate' } }, (resp) => {
				const chunks = [];
				resp.on('data', c => chunks.push(c));
				resp.on('end', () => {
					zlib.inflate(Buffer.concat(chunks), (err, decoded) => {
						if (err) return reject(err);
						resolve({ body: JSON.parse(decoded.toString()), encoding: resp.headers['content-encoding'] });
					});
				});
			}).on('error', reject);
		});
		expect(result.encoding).toBe('deflate');
		expect(result.body.data).toBe('x'.repeat(10000));
	});

	it('small response is not compressed', async () => {
		const r = await fetch(`${base}/small`, {
			headers: { 'accept-encoding': 'gzip' },
		});
		expect(r.headers.get('content-encoding')).toBeFalsy();
		const body = await r.json();
		expect(body).toEqual({ ok: true });
	});
});

// ============================================================
//  7. MIDDLEWARE — helmet
// ============================================================

describe('Docs — Middleware: helmet', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, helmet } = require('../');
		const app = createApp();

		// --- Doc example: sensible defaults ---
		app.use(helmet());
		app.get('/test', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets X-Content-Type-Options: nosniff', async () => {
		const r = await fetch(`${base}/test`);
		expect(r.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('sets X-Frame-Options', async () => {
		const r = await fetch(`${base}/test`);
		expect(r.headers.get('x-frame-options')).toBe('DENY');
	});

	it('sets Referrer-Policy', async () => {
		const r = await fetch(`${base}/test`);
		expect(r.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('sets HSTS', async () => {
		const r = await fetch(`${base}/test`);
		expect(r.headers.get('strict-transport-security')).not.toBeNull();
	});

	it('sets CSP', async () => {
		const r = await fetch(`${base}/test`);
		expect(r.headers.get('content-security-policy')).not.toBeNull();
	});

	it('custom CSP + disabled HSTS', async () => {
		const { createApp, helmet } = require('../');
		const app2 = createApp();
		app2.use(helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'", 'cdn.example.com'],
				},
			},
			hsts: false,
			frameguard: 'sameorigin',
		}));
		app2.get('/t', (req, res) => res.json({ ok: 1 }));
		const s2 = http.createServer(app2.handler);
		await new Promise(r => s2.listen(0, r));
		const b2 = `http://localhost:${s2.address().port}`;
		const r = await fetch(`${b2}/t`);
		expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		const csp = r.headers.get('content-security-policy');
		expect(csp).toContain("'self'");
		expect(csp).toContain('cdn.example.com');
		s2.close();
	});
});

// ============================================================
//  8. MIDDLEWARE — static
// ============================================================

describe('Docs — Middleware: static', () => {
	let server, base, staticDir;

	beforeAll(async () => {
		const { createApp, static: serveStatic } = require('../');
		staticDir = path.join(__dirname, 'tmp-doc-static');
		fs.mkdirSync(staticDir, { recursive: true });
		fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>Hello</html>');
		fs.writeFileSync(path.join(staticDir, 'about.html'), '<html>About</html>');
		fs.writeFileSync(path.join(staticDir, 'data.txt'), 'sample data');

		const app = createApp();

		// --- Doc example ---
		app.use(serveStatic(staticDir, {
			index: 'index.html',
			maxAge: 3600000,
			dotfiles: 'ignore',
			extensions: ['html', 'htm'],
			setHeaders: (res, filePath) => {
				res.raw.setHeader('X-Served-By', 'zero-http');
			},
		}));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => {
		server?.close();
		try { fs.rmSync(staticDir, { recursive: true, force: true }); } catch {}
	});

	it('serves index.html at root', async () => {
		const r = await fetch(`${base}/`);
		expect(r.status).toBe(200);
		const body = await r.text();
		expect(body).toContain('Hello');
	});

	it('serves files with extensions fallback', async () => {
		const r = await fetch(`${base}/about`);
		expect(r.status).toBe(200);
		const body = await r.text();
		expect(body).toContain('About');
	});

	it('serves txt files', async () => {
		const r = await fetch(`${base}/data.txt`);
		expect(r.status).toBe(200);
		const body = await r.text();
		expect(body).toBe('sample data');
	});

	it('sets custom headers via setHeaders', async () => {
		const r = await fetch(`${base}/data.txt`);
		expect(r.headers.get('x-served-by')).toBe('zero-http');
	});

	it('sets Cache-Control max-age', async () => {
		const r = await fetch(`${base}/data.txt`);
		const cc = r.headers.get('cache-control');
		expect(cc).toContain('max-age=3600');
	});
});

// ============================================================
//  9. MIDDLEWARE — rateLimit
// ============================================================

describe('Docs — Middleware: rateLimit', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, json, rateLimit } = require('../');
		const app = createApp();
		app.use(json());

		// --- Doc example: strict login limiter ---
		app.post('/login', rateLimit({
			windowMs: 60000,
			max: 3,
			message: 'Too many login attempts',
		}), (req, res) => {
			res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('allows requests within the limit', async () => {
		const r = await doFetch(`${base}/login`, { method: 'POST' });
		expect(r.status).toBe(200);
		expect(r.headers.get('x-ratelimit-limit')).toBe('3');
	});

	it('returns 429 after exceeding limit', async () => {
		// We already used 1 in the test above, do 2 more to hit the limit
		await doFetch(`${base}/login`, { method: 'POST' });
		await doFetch(`${base}/login`, { method: 'POST' });
		const r = await doFetch(`${base}/login`, { method: 'POST' });
		expect(r.status).toBe(429);
	});
});

// ============================================================
//  10. MIDDLEWARE — timeout
// ============================================================

describe('Docs — Middleware: timeout', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, timeout } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.use(timeout(500)); // 500ms for test speed

		app.get('/slow', async (req, res) => {
			await new Promise(r => setTimeout(r, 1500));
			if (req.timedOut) return;
			res.json({ data: 'done' });
		});

		app.get('/fast', (req, res) => res.json({ data: 'quick' }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('fast handler responds normally', async () => {
		const r = await doFetch(`${base}/fast`);
		expect(r.status).toBe(200);
		expect(r.data.data).toBe('quick');
	});

	it('slow handler gets 408 timeout', async () => {
		const r = await doFetch(`${base}/slow`);
		expect(r.status).toBe(408);
	});
});

// ============================================================
//  11. MIDDLEWARE — requestId
// ============================================================

describe('Docs — Middleware: requestId', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, requestId } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.use(requestId());
		app.get('/info', (req, res) => {
			res.json({ requestId: req.id });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets req.id with UUID', async () => {
		const r = await doFetch(`${base}/info`);
		expect(r.data.requestId).toBeDefined();
		expect(r.data.requestId.length).toBe(36); // UUID format
	});

	it('sets X-Request-Id response header', async () => {
		const r = await fetch(`${base}/info`);
		const id = r.headers.get('x-request-id');
		expect(id).toBeDefined();
		expect(id.length).toBe(36);
	});
});

// ============================================================
//  12. MIDDLEWARE — logger (no crash)
// ============================================================

describe('Docs — Middleware: logger', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, logger } = require('../');
		const app = createApp();

		// --- Doc example: capture logs to array ---
		const logs = [];
		app.use(logger({
			format: 'short',
			colors: false,
			logger: (msg) => logs.push(msg),
		}));
		app.get('/test', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('logger middleware does not crash', async () => {
		const r = await doFetch(`${base}/test`);
		expect(r.status).toBe(200);
		expect(r.data.ok).toBe(true);
	});
});

// ============================================================
//  13. COOKIES & SECURITY — cookieParser
// ============================================================

describe('Docs — Cookies: cookieParser', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, cookieParser, json } = require('../');
		const app = createApp();

		// --- Doc example: Basic setup with signing secret ---
		app.use(cookieParser('super-secret-key'));
		app.use(json());

		// --- Doc: Reading cookies ---
		app.get('/read', (req, res) => {
			res.json({
				cookies: req.cookies,
				signed: req.signedCookies,
				secret: req.secret,
			});
		});

		// --- Doc: Setting cookies ---
		app.get('/set', (req, res) => {
			res.cookie('session', 'abc123', { signed: true, httpOnly: true });
			res.cookie('prefs', { lang: 'en', theme: 'dark' }, { maxAge: 86400 });
			res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets signed and JSON cookies', async () => {
		const r = await fetch(`${base}/set`);
		expect(r.status).toBe(200);
		const setCookies = r.headers.get('set-cookie');
		expect(setCookies).toBeDefined();
		expect(setCookies).toContain('session');
		expect(setCookies).toContain('prefs');
	});

	it('reads cookies from Cookie header', async () => {
		const r = await doFetch(`${base}/read`, {
			headers: { 'cookie': 'theme=dark; color=blue' },
		});
		expect(r.data.cookies.theme).toBe('dark');
		expect(r.data.cookies.color).toBe('blue');
	});

	it('reads signed cookies', async () => {
		// First set the cookies
		const setR = await fetch(`${base}/set`);
		const cookies = setR.headers.get('set-cookie');
		// Then read them back
		const r = await doFetch(`${base}/read`, {
			headers: { 'cookie': cookies },
		});
		expect(r.data.signed).toBeDefined();
	});

	it('req.secret is available', async () => {
		const r = await doFetch(`${base}/read`);
		expect(r.data.secret).toBe('super-secret-key');
	});

	it('cookieParser.sign and unsign round-trip', () => {
		const { cookieParser } = require('../');
		const signed = cookieParser.sign('data', 'secret');
		expect(signed).toContain('s:');
		const value = cookieParser.unsign(signed, ['secret']);
		expect(value).toBe('data');
	});

	it('cookieParser.jsonCookie and parseJSON round-trip', () => {
		const { cookieParser } = require('../');
		const json = cookieParser.jsonCookie({ a: 1 });
		expect(json).toContain('j:');
		const parsed = cookieParser.parseJSON(json);
		expect(parsed.a).toBe(1);
	});

	it('secret rotation: unsign works with old key', () => {
		const { cookieParser } = require('../');
		const signed = cookieParser.sign('data', 'old-secret');
		const value = cookieParser.unsign(signed, ['new-secret', 'old-secret']);
		expect(value).toBe('data');
	});
});

// ============================================================
//  14. COOKIES & SECURITY — csrf
// ============================================================

describe('Docs — Cookies: csrf', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, csrf, json, cookieParser } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.use(cookieParser());
		app.use(json());
		app.use(csrf());

		app.get('/api/csrf-token', (req, res) => {
			res.json({ token: req.csrfToken });
		});

		app.post('/api/transfer', (req, res) => {
			res.json({ success: true, amount: req.body.amount });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('GET returns csrf token', async () => {
		const r = await fetch(`${base}/api/csrf-token`);
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.token).toBeDefined();
		expect(typeof body.token).toBe('string');
	});

	it('POST without token returns 403', async () => {
		const r = await fetch(`${base}/api/transfer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ amount: 100 }),
		});
		expect(r.status).toBe(403);
	});

	it('POST with valid token succeeds', async () => {
		// Step 1: Get token
		const getRes = await fetch(`${base}/api/csrf-token`);
		const { token } = await getRes.json();
		const cookies = getRes.headers.get('set-cookie');

		// Step 2: POST with token in header and cookie
		const r = await fetch(`${base}/api/transfer`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': token,
				'cookie': cookies,
			},
			body: JSON.stringify({ amount: 100 }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.success).toBe(true);
		expect(body.amount).toBe(100);
	});

	it('POST with wrong token returns 403', async () => {
		const getRes = await fetch(`${base}/api/csrf-token`);
		const cookies = getRes.headers.get('set-cookie');
		const r = await fetch(`${base}/api/transfer`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': 'bad.token',
				'cookie': cookies,
			},
			body: JSON.stringify({}),
		});
		expect(r.status).toBe(403);
	});
});

// ============================================================
//  15. COOKIES & SECURITY — validate
// ============================================================

describe('Docs — Cookies: validate', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, json, validate } = require('../');
		const app = createApp();
		app.use(json());

		// --- Doc example: Validate body ---
		app.post('/users', validate({
			body: {
				name:  { type: 'string', required: true, minLength: 2, maxLength: 50 },
				email: { type: 'email', required: true },
				age:   { type: 'integer', min: 13, max: 120 },
				role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
				tags:  { type: 'array', minItems: 1, maxItems: 5 },
			},
		}), (req, res) => {
			res.status(201).json(req.body);
		});

		// --- Doc example: Validate query + params ---
		app.get('/search/:category', validate({
			params: { category: { type: 'string', enum: ['books', 'music', 'films'] } },
			query: {
				q:     { type: 'string', required: true },
				page:  { type: 'integer', min: 1, default: 1 },
				limit: { type: 'integer', min: 1, max: 100, default: 20 },
			},
		}), (req, res) => {
			res.json({ params: req.params, query: req.query });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('valid body passes through with defaults', async () => {
		const r = await doFetch(`${base}/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', email: 'alice@x.com', age: 25, tags: ['dev'] }),
		});
		expect(r.status).toBe(201);
		expect(r.data.name).toBe('Alice');
		expect(r.data.role).toBe('user'); // default applied
	});

	it('missing required field returns 422', async () => {
		const r = await doFetch(`${base}/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'alice@x.com' }),
		});
		expect(r.status).toBe(422);
		expect(r.data.errors).toBeDefined();
	});

	it('invalid email returns 422', async () => {
		const r = await doFetch(`${base}/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', email: 'bad' }),
		});
		expect(r.status).toBe(422);
	});

	it('integer out of range returns 422', async () => {
		const r = await doFetch(`${base}/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', email: 'a@b.com', age: 5 }),
		});
		expect(r.status).toBe(422); // min: 13
	});

	it('query + params validation with defaults', async () => {
		const r = await doFetch(`${base}/search/books?q=javascript`);
		expect(r.status).toBe(200);
		expect(r.data.params.category).toBe('books');
		expect(r.data.query.q).toBe('javascript');
		expect(r.data.query.page).toBe(1);
		expect(r.data.query.limit).toBe(20);
	});

	it('invalid enum param returns 422', async () => {
		const r = await doFetch(`${base}/search/games?q=test`);
		expect(r.status).toBe(422);
	});

	it('query coerces string to integer', async () => {
		const r = await doFetch(`${base}/search/music?q=test&page=3&limit=50`);
		expect(r.data.query.page).toBe(3);
		expect(r.data.query.limit).toBe(50);
	});

	it('validate.field() works standalone', () => {
		const { validate } = require('../');
		const { value, error } = validate.field('hello', { type: 'string', minLength: 1 }, 'name');
		expect(value).toBe('hello');
		expect(error).toBeNull();
	});

	it('validate.field() returns error on failure', () => {
		const { validate } = require('../');
		const { error } = validate.field(undefined, { type: 'string', required: true }, 'name');
		expect(error).toContain('required');
	});

	it('validate.object() validates and strips unknown', () => {
		const { validate } = require('../');
		const schema = {
			name: { type: 'string', required: true },
			age:  { type: 'integer', min: 0 },
		};
		const { sanitized, errors } = validate.object({ name: 'Test', age: '25', extra: 'x' }, schema);
		expect(errors).toHaveLength(0);
		expect(sanitized.name).toBe('Test');
		expect(sanitized.age).toBe(25);
		expect(sanitized.extra).toBeUndefined();
	});
});

// ============================================================
//  16. ENVIRONMENT — env
// ============================================================

describe('Docs — Environment: env', () => {
	it('env.load with typed schema', () => {
		const { env } = require('../');
		env.reset();

		// Set process.env for testing
		process.env.TEST_PORT = '3000';
		process.env.TEST_DEBUG = 'false';
		process.env.TEST_NODE_ENV = 'development';
		process.env.TEST_MAX_UPLOAD = '10';

		env.load({
			TEST_PORT:       { type: 'port', default: 3000 },
			TEST_DEBUG:      { type: 'boolean', default: false },
			TEST_NODE_ENV:   { type: 'enum', values: ['development', 'production', 'test'], default: 'development' },
			TEST_MAX_UPLOAD: { type: 'integer', min: 1, max: 100, default: 10 },
		});

		// --- Doc: proxy access ---
		expect(env.TEST_PORT).toBe(3000);
		expect(env.TEST_DEBUG).toBe(false);
		expect(env.TEST_NODE_ENV).toBe('development');
		expect(env.TEST_MAX_UPLOAD).toBe(10);

		// Cleanup
		delete process.env.TEST_PORT;
		delete process.env.TEST_DEBUG;
		delete process.env.TEST_NODE_ENV;
		delete process.env.TEST_MAX_UPLOAD;
		env.reset();
	});

	it('env.get() retrieves values', () => {
		const { env } = require('../');
		env.reset();
		process.env.TEST_VAL = 'hello';
		env.load({ TEST_VAL: { type: 'string' } });
		expect(env.get('TEST_VAL')).toBe('hello');
		delete process.env.TEST_VAL;
		env.reset();
	});

	it('env.require() throws if missing', () => {
		const { env } = require('../');
		env.reset();
		expect(() => env.require('NONEXISTENT_KEY_XYZ')).toThrow();
		env.reset();
	});

	it('env.has() checks existence', () => {
		const { env } = require('../');
		env.reset();
		process.env.TEST_HAS = '1';
		env.load({ TEST_HAS: { type: 'string' } });
		expect(env.has('TEST_HAS')).toBe(true);
		expect(env.has('NOPE_XYZ')).toBe(false);
		delete process.env.TEST_HAS;
		env.reset();
	});

	it('env.all() returns all values', () => {
		const { env } = require('../');
		env.reset();
		process.env.TEST_A = 'a';
		process.env.TEST_B = 'b';
		env.load({ TEST_A: { type: 'string' }, TEST_B: { type: 'string' } });
		const all = env.all();
		expect(all.TEST_A).toBe('a');
		expect(all.TEST_B).toBe('b');
		delete process.env.TEST_A;
		delete process.env.TEST_B;
		env.reset();
	});

	it('env.parse() parses .env file strings', () => {
		const { env } = require('../');
		const result = env.parse('FOO=bar\nBAZ=qux\n# comment\nexport KEY=val');
		expect(result.FOO).toBe('bar');
		expect(result.BAZ).toBe('qux');
		expect(result.KEY).toBe('val');
	});

	it('schema type coercion works', () => {
		const { env } = require('../');
		env.reset();
		process.env.TEST_BOOL = 'yes';
		process.env.TEST_PORT2 = '8080';
		process.env.TEST_INT = '42';
		env.load({
			TEST_BOOL:  { type: 'boolean' },
			TEST_PORT2: { type: 'port' },
			TEST_INT:   { type: 'integer', min: 1, max: 100 },
		});
		expect(env.TEST_BOOL).toBe(true);
		expect(env.TEST_PORT2).toBe(8080);
		expect(env.TEST_INT).toBe(42);
		delete process.env.TEST_BOOL;
		delete process.env.TEST_PORT2;
		delete process.env.TEST_INT;
		env.reset();
	});
});

// ============================================================
//  17. ORM — Database (memory), Model, Query, TYPES
// ============================================================

describe('Docs — ORM', () => {
	let db, User;

	beforeAll(async () => {
		const { Database, Model, TYPES } = require('../');

		// --- Doc example: Memory adapter ---
		db = Database.connect('memory');

		class UserModel extends Model {
			static table = 'users';
			static timestamps = true;
			static softDelete = true;
			static hidden = ['password'];
			static scopes = {
				active: (q) => q.where('active', true),
				role: (q, role) => q.where('role', role),
			};
			static schema = {
				id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name:     { type: TYPES.STRING, required: true, minLength: 2 },
				email:    { type: TYPES.STRING, required: true, unique: true },
				password: { type: TYPES.STRING },
				role:     { type: TYPES.STRING, enum: ['user', 'admin'], default: 'user' },
				logins:   { type: TYPES.INTEGER, default: 0 },
				active:   { type: TYPES.BOOLEAN, default: true },
			};
			static hooks = {
				beforeCreate: (data) => { if (data.email) data.email = data.email.toLowerCase(); },
			};
		}
		User = UserModel;

		db.register(User);
		await db.sync();
	});

	afterAll(async () => {
		await db.close();
	});

	beforeEach(() => {
		db.adapter.clear();
	});

	it('Model.create() inserts a record', async () => {
		const user = await User.create({ name: 'Alice', email: 'alice@example.com', password: 'secret' });
		expect(user.id).toBeDefined();
		expect(user.name).toBe('Alice');
		expect(user.email).toBe('alice@example.com'); // hook lowercased
	});

	it('Model.createMany() inserts multiple records', async () => {
		const users = await User.createMany([
			{ name: 'Alice', email: 'a@x.com' },
			{ name: 'Bob', email: 'b@x.com' },
			{ name: 'Charlie', email: 'c@x.com' },
		]);
		expect(users.length).toBe(3);
	});

	it('Model.find() queries records', async () => {
		await User.createMany([
			{ name: 'Alice', email: 'a2@x.com', role: 'admin' },
			{ name: 'Bob', email: 'b2@x.com', role: 'user' },
		]);
		const admins = await User.find({ role: 'admin' });
		expect(admins.length).toBe(1);
		expect(admins[0].name).toBe('Alice');
	});

	it('Model.findById() finds by primary key', async () => {
		const created = await User.create({ name: 'Alice', email: 'find@x.com' });
		const found = await User.findById(created.id);
		expect(found).not.toBeNull();
		expect(found.name).toBe('Alice');
	});

	it('Model.findOne() finds single record', async () => {
		await User.create({ name: 'Alice', email: 'one@x.com' });
		const found = await User.findOne({ name: 'Alice' });
		expect(found).not.toBeNull();
		expect(found.email).toBe('one@x.com');
	});

	it('Model.count() counts records', async () => {
		await User.createMany([
			{ name: 'Al', email: 'c1@x.com' },
			{ name: 'Bo', email: 'c2@x.com' },
		]);
		const count = await User.count();
		expect(count).toBe(2);
	});

	it('Model.exists() checks existence', async () => {
		await User.create({ name: 'Alice', email: 'exists@x.com' });
		expect(await User.exists({ name: 'Alice' })).toBe(true);
		expect(await User.exists({ name: 'Nobody' })).toBe(false);
	});

	it('instance.update() updates fields', async () => {
		const user = await User.create({ name: 'Alice', email: 'up@x.com' });
		await user.update({ name: 'Alicia' });
		const reloaded = await User.findById(user.id);
		expect(reloaded.name).toBe('Alicia');
	});

	it('instance.delete() soft-deletes', async () => {
		const user = await User.create({ name: 'Alice', email: 'del@x.com' });
		await user.delete();
		const found = await User.findById(user.id);
		expect(found).toBeNull(); // soft-deleted, not visible
	});

	it('instance.restore() restores soft-deleted', async () => {
		const user = await User.create({ name: 'Alice', email: 'restore@x.com' });
		await user.delete();
		await user.restore();
		const found = await User.findById(user.id);
		expect(found).not.toBeNull();
	});

	it('toJSON() hides hidden fields', async () => {
		const user = await User.create({ name: 'Alice', email: 'json@x.com', password: 'secret' });
		const json = user.toJSON();
		expect(json.name).toBe('Alice');
		expect(json.password).toBeUndefined();
	});

	it('timestamps are set', async () => {
		const user = await User.create({ name: 'Alice', email: 'ts@x.com' });
		expect(user.createdAt).toBeDefined();
		expect(user.updatedAt).toBeDefined();
	});

	it('hooks run on create (email lowered)', async () => {
		const user = await User.create({ name: 'Alice', email: 'UPPER@X.COM' });
		expect(user.email).toBe('upper@x.com');
	});

	it('increment and decrement', async () => {
		const user = await User.create({ name: 'Alice', email: 'inc@x.com', logins: 0 });
		await user.increment('logins');
		let reloaded = await User.findById(user.id);
		expect(reloaded.logins).toBe(1);
		await reloaded.decrement('logins', 1);
		reloaded = await User.findById(user.id);
		expect(reloaded.logins).toBe(0);
	});

	it('scoped queries work', async () => {
		await User.createMany([
			{ name: 'Active', email: 'sa@x.com', active: true, role: 'admin' },
			{ name: 'Inactive', email: 'si@x.com', active: false, role: 'user' },
		]);
		const actives = await User.scope('active');
		expect(actives.length).toBeGreaterThanOrEqual(1);
		expect(actives.every(u => u.active === true || u.active === 1)).toBe(true);
	});

	it('Model.first() and Model.last()', async () => {
		await User.createMany([
			{ name: 'First', email: 'fl1@x.com' },
			{ name: 'Last', email: 'fl2@x.com' },
		]);
		const first = await User.first();
		const last = await User.last();
		expect(first).not.toBeNull();
		expect(last).not.toBeNull();
	});

	it('Model.pluck() extracts column values', async () => {
		await User.createMany([
			{ name: 'Alice', email: 'pl1@x.com' },
			{ name: 'Bob', email: 'pl2@x.com' },
		]);
		const names = await User.pluck('name');
		expect(names).toContain('Alice');
		expect(names).toContain('Bob');
	});

	it('Model.paginate() returns metadata', async () => {
		await User.createMany([
			{ name: 'Al', email: 'pg1@x.com' },
			{ name: 'Bo', email: 'pg2@x.com' },
			{ name: 'Ca', email: 'pg3@x.com' },
		]);
		const page = await User.paginate(1, 2);
		expect(page.data).toBeDefined();
		expect(page.total).toBe(3);
		expect(page.page).toBe(1);
		expect(page.perPage).toBe(2);
		expect(page.pages).toBe(2);
		expect(page.hasNext).toBe(true);
		expect(page.hasPrev).toBe(false);
	});

	it('Model.upsert() creates or updates', async () => {
		const { instance, created } = await User.upsert(
			{ email: 'upsert@x.com' },
			{ name: 'UpsertUser', role: 'admin' },
		);
		expect(created).toBe(true);
		expect(instance.name).toBe('UpsertUser');

		const { instance: i2, created: c2 } = await User.upsert(
			{ email: 'upsert@x.com' },
			{ name: 'Updated' },
		);
		expect(c2).toBe(false);
		expect(i2.name).toBe('Updated');
	});

	it('Model.findOrCreate()', async () => {
		const { instance, created } = await User.findOrCreate(
			{ email: 'foc@x.com' },
			{ name: 'FindOrCreate' },
		);
		expect(created).toBe(true);
		expect(instance.name).toBe('FindOrCreate');

		const { created: c2 } = await User.findOrCreate(
			{ email: 'foc@x.com' },
		);
		expect(c2).toBe(false);
	});

	it('Query builder: where, orderBy, limit', async () => {
		await User.createMany([
			{ name: 'Zara', email: 'qb1@x.com' },
			{ name: 'Amy', email: 'qb2@x.com' },
			{ name: 'Max', email: 'qb3@x.com' },
		]);
		const results = await User.query()
			.orderBy('name')
			.limit(2)
			.exec();
		expect(results.length).toBe(2);
		expect(results[0].name).toBe('Amy');
	});

	it('Query: aggregates', async () => {
		await User.createMany([
			{ name: 'Al', email: 'agg1@x.com', logins: 10 },
			{ name: 'Bo', email: 'agg2@x.com', logins: 20 },
			{ name: 'Ca', email: 'agg3@x.com', logins: 30 },
		]);
		const total = await User.query().sum('logins');
		expect(total).toBe(60);
		const avg = await User.query().avg('logins');
		expect(avg).toBe(20);
		const max = await User.query().max('logins');
		expect(max).toBe(30);
		const min = await User.query().min('logins');
		expect(min).toBe(10);
	});

	it('Query: paginate with metadata', async () => {
		await User.createMany([
			{ name: 'Al', email: 'qp1@x.com' },
			{ name: 'Bo', email: 'qp2@x.com' },
			{ name: 'Ca', email: 'qp3@x.com' },
			{ name: 'De', email: 'qp4@x.com' },
			{ name: 'Ed', email: 'qp5@x.com' },
		]);
		const result = await User.query()
			.where('active', true)
			.paginate(2, 2);
		expect(result.page).toBe(2);
		expect(result.perPage).toBe(2);
		expect(result.total).toBe(5);
		expect(result.pages).toBe(3);
	});

	it('Query: LINQ-style take/skip', async () => {
		await User.createMany([
			{ name: 'Al', email: 'lq1@x.com' },
			{ name: 'Bo', email: 'lq2@x.com' },
			{ name: 'Ca', email: 'lq3@x.com' },
		]);
		const top2 = await User.query().orderBy('name').take(2);
		expect(top2.length).toBe(2);
	});

	it('Query: map/filter/reduce', async () => {
		await User.createMany([
			{ name: 'Alice', email: 'mfr1@x.com', logins: 5 },
			{ name: 'Bob', email: 'mfr2@x.com', logins: 10 },
		]);
		const names = await User.query().map(u => u.name);
		expect(names).toContain('Alice');
		expect(names).toContain('Bob');

		const totalLogins = await User.query().reduce((sum, u) => sum + u.logins, 0);
		expect(totalLogins).toBe(15);
	});

	it('Query: when/unless conditional', async () => {
		await User.createMany([
			{ name: 'Alice', email: 'wu1@x.com', role: 'admin' },
			{ name: 'Bob', email: 'wu2@x.com', role: 'user' },
		]);
		const filterRole = 'admin';
		const results = await User.query()
			.when(filterRole, q => q.where('role', filterRole))
			.exec();
		expect(results.length).toBe(1);
		expect(results[0].name).toBe('Alice');
	});

	it('Query: withDeleted includes soft-deleted', async () => {
		const user = await User.create({ name: 'Ghost', email: 'wd@x.com' });
		await user.delete();
		const without = await User.find();
		const withDel = await User.query().withDeleted().exec();
		expect(withDel.length).toBeGreaterThan(without.length);
	});

	it('Memory adapter: tables, totalRows, stats', async () => {
		await User.create({ name: 'Test', email: 'mem@x.com' });
		expect(db.adapter.tables()).toContain('users');
		expect(db.adapter.totalRows()).toBeGreaterThanOrEqual(1);
		const stats = db.adapter.stats();
		expect(stats.tables).toBeGreaterThanOrEqual(1);
		expect(stats.totalRows).toBeGreaterThanOrEqual(1);
	});

	it('Memory adapter: toJSON/fromJSON round-trip', async () => {
		await User.create({ name: 'Snap', email: 'snap@x.com' });
		const snapshot = db.adapter.toJSON();
		expect(snapshot.users).toBeDefined();
		expect(snapshot.users.length).toBeGreaterThanOrEqual(1);

		await db.adapter.clear();
		expect(db.adapter.totalRows()).toBe(0);

		db.adapter.fromJSON(snapshot);
		expect(db.adapter.totalRows()).toBeGreaterThanOrEqual(1);
	});

	it('TYPES constants exist', () => {
		const { TYPES } = require('../');
		expect(TYPES.STRING).toBe('string');
		expect(TYPES.INTEGER).toBe('integer');
		expect(TYPES.FLOAT).toBe('float');
		expect(TYPES.BOOLEAN).toBe('boolean');
		expect(TYPES.DATE).toBe('date');
		expect(TYPES.DATETIME).toBe('datetime');
		expect(TYPES.JSON).toBe('json');
		expect(TYPES.TEXT).toBe('text');
		expect(TYPES.BLOB).toBe('blob');
		expect(TYPES.UUID).toBe('uuid');
	});
});

// ============================================================
//  17b. ORM — Schema DDL (references, check, index, composites, guarded)
// ============================================================

describe('Docs — ORM: Schema DDL', () => {
	let db, Post, Enrollment, UserRole;
	const { Database, Model, TYPES } = require('../');

	beforeAll(async () => {
		db = Database.connect('sqlite');

		class UserModel extends Model {
			static table = 'users';
			static schema = {
				id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name: { type: TYPES.STRING, required: true },
			};
		}

		// Foreign Keys — CASCADE delete
		class PostModel extends Model {
			static table = 'posts';
			static schema = {
				id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				title:    { type: TYPES.STRING, required: true, index: true },
				authorId: {
					type: TYPES.INTEGER, required: true,
					references: { table: 'users', column: 'id', onDelete: 'CASCADE' }
				},
				status: { type: TYPES.STRING, check: '"status" IN (\'draft\', \'published\', \'archived\')' },
			};
		}

		// Composite Primary Key — junction table
		class EnrollmentModel extends Model {
			static table = 'enrollments';
			static schema = {
				studentId: { type: TYPES.INTEGER, primaryKey: true, compositeKey: true },
				courseId:  { type: TYPES.INTEGER, primaryKey: true, compositeKey: true },
				grade:     { type: TYPES.STRING },
			};
		}

		// Composite Unique + Composite Index
		class UserRoleModel extends Model {
			static table = 'user_roles';
			static schema = {
				id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				userId: { type: TYPES.INTEGER, compositeUnique: 'user_role', compositeIndex: 'user_lookup' },
				role:   { type: TYPES.STRING, compositeUnique: 'user_role' },
				orgId:  { type: TYPES.INTEGER, compositeIndex: 'user_lookup' },
			};
		}

		Post = PostModel;
		Enrollment = EnrollmentModel;
		UserRole = UserRoleModel;

		db.register(UserModel);
		db.register(Post);
		db.register(Enrollment);
		db.register(UserRole);
		await db.sync(); // topological sort: users before posts
	});

	afterAll(() => db.close());

	it('sync creates tables with FK references (topological order)', () => {
		expect(db.adapter.hasTable('users')).toBe(true);
		expect(db.adapter.hasTable('posts')).toBe(true);
	});

	it('FK CASCADE deletes children when parent is deleted', async () => {
		await db.adapter.insert('users', { name: 'Alice' });
		const users = db.adapter._db.prepare('SELECT * FROM "users"').all();
		const user = users[0];
		await db.adapter.insert('posts', { title: 'Hello', authorId: user.id, status: 'draft' });
		expect(db.adapter._db.prepare('SELECT * FROM "posts"').all().length).toBe(1);

		// Delete parent — CASCADE should remove posts
		db.adapter._db.prepare('DELETE FROM "users" WHERE id = ?').run(user.id);
		expect(db.adapter._db.prepare('SELECT * FROM "posts"').all().length).toBe(0);
	});

	it('CHECK constraint rejects invalid values', async () => {
		await db.adapter.insert('users', { name: 'Bob' });
		const users = db.adapter._db.prepare('SELECT * FROM "users"').all();
		const user = users[0];
		expect(() => {
			db.adapter._db.prepare('INSERT INTO "posts" ("title", "authorId", "status") VALUES (?, ?, ?)').run('Bad', user.id, 'invalid');
		}).toThrow();
	});

	it('single-column index is created via index: true', () => {
		const indexes = db.adapter.indexes('posts');
		expect(indexes.some(i => i.columns && i.columns.includes('title'))).toBe(true);
	});

	it('composite primary key works', async () => {
		await db.adapter.insert('enrollments', { studentId: 1, courseId: 1, grade: 'A' });
		await db.adapter.insert('enrollments', { studentId: 1, courseId: 2, grade: 'B' });

		// Duplicate composite key should fail
		expect(() => {
			db.adapter._db.prepare('INSERT INTO "enrollments" ("studentId", "courseId", "grade") VALUES (?, ?, ?)').run(1, 1, 'C');
		}).toThrow();
	});

	it('composite unique constraint works', async () => {
		await db.adapter.insert('user_roles', { userId: 1, role: 'admin', orgId: 10 });
		await db.adapter.insert('user_roles', { userId: 1, role: 'user', orgId: 10 }); // different role OK

		expect(() => {
			db.adapter._db.prepare('INSERT INTO "user_roles" ("userId", "role", "orgId") VALUES (?, ?, ?)').run(1, 'admin', 20);
		}).toThrow();
	});

	it('composite index is created', () => {
		const indexes = db.adapter.indexes('user_roles');
		// Should have a composite index covering userId + orgId
		expect(indexes.some(i => i.columns && i.columns.includes('userId') && i.columns.includes('orgId'))).toBe(true);
	});
});

// ============================================================
//  17c. ORM — Migration Methods
// ============================================================

describe('Docs — ORM: Migrations', () => {
	let db;
	const { Database, Model, TYPES } = require('../');

	beforeAll(async () => {
		db = Database.connect('sqlite');

		class User extends Model {
			static table = 'users';
			static schema = {
				id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name:  { type: TYPES.STRING, required: true },
				email: { type: TYPES.STRING, required: true },
			};
		}
		db.register(User);
		await db.sync();
	});

	afterAll(() => db.close());

	it('db.addColumn adds a column to an existing table', () => {
		db.adapter.addColumn('users', 'bio', { type: TYPES.TEXT, default: '' });
		expect(db.adapter.hasColumn('users', 'bio')).toBe(true);
	});

	it('db.createIndex creates an index', () => {
		db.adapter.createIndex('users', ['email'], { name: 'idx_email', unique: true });
		const indexes = db.adapter.indexes('users');
		expect(indexes.some(i => i.name === 'idx_email')).toBe(true);
	});

	it('db.renameColumn renames a column', () => {
		db.adapter.renameColumn('users', 'bio', 'biography');
		expect(db.adapter.hasColumn('users', 'biography')).toBe(true);
		expect(db.adapter.hasColumn('users', 'bio')).toBe(false);
	});

	it('db.hasTable and db.hasColumn check existence', async () => {
		expect(await db.hasTable('users')).toBe(true);
		expect(await db.hasTable('nope')).toBe(false);
		expect(await db.hasColumn('users', 'name')).toBe(true);
		expect(await db.hasColumn('users', 'nope')).toBe(false);
	});

	it('db.describeTable returns column info', async () => {
		const info = await db.describeTable('users');
		expect(Array.isArray(info.columns)).toBe(true);
		expect(info.columns.some(c => c.name === 'name')).toBe(true);
	});

	it('db.renameTable renames a table', async () => {
		db.adapter.createTable('temp_table', { id: { type: TYPES.INTEGER, primaryKey: true } });
		await db.renameTable('temp_table', 'renamed_table');
		expect(await db.hasTable('renamed_table')).toBe(true);
		expect(await db.hasTable('temp_table')).toBe(false);
		// Clean up
		db.adapter._db.exec('DROP TABLE IF EXISTS "renamed_table"');
	});

	it('db.dropIndex drops an index', () => {
		db.adapter.createIndex('users', ['name'], { name: 'idx_name_temp' });
		expect(db.adapter.indexes('users').some(i => i.name === 'idx_name_temp')).toBe(true);
		db.adapter.dropIndex('users', 'idx_name_temp');
		expect(db.adapter.indexes('users').some(i => i.name === 'idx_name_temp')).toBe(false);
	});

	it('db.dropColumn drops a column', () => {
		db.adapter.addColumn('users', 'temp_col', { type: TYPES.STRING });
		expect(db.adapter.hasColumn('users', 'temp_col')).toBe(true);
		db.adapter.dropColumn('users', 'temp_col');
		expect(db.adapter.hasColumn('users', 'temp_col')).toBe(false);
	});

	it('conditional migration pattern works', async () => {
		// Doc example: check if table/column exists before migrating
		if (await db.hasTable('users') && !await db.hasColumn('users', 'avatar')) {
			await db.addColumn('users', 'avatar', { type: TYPES.STRING });
		}
		expect(await db.hasColumn('users', 'avatar')).toBe(true);

		// Running again should be idempotent — column already exists
		if (await db.hasTable('users') && !await db.hasColumn('users', 'avatar')) {
			await db.addColumn('users', 'avatar', { type: TYPES.STRING });
		}
		expect(await db.hasColumn('users', 'avatar')).toBe(true);
	});
});

// ============================================================
//  17d. ORM — Memory Adapter Schema DDL & Migrations
// ============================================================

describe('Docs — ORM: Memory Adapter DDL', () => {
	let db;
	const { Database, Model, TYPES } = require('../');

	beforeAll(async () => {
		db = Database.connect('memory');

		class Item extends Model {
			static table = 'items';
			static schema = {
				id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name:  { type: TYPES.STRING, required: true, unique: true },
				price: { type: TYPES.FLOAT },
			};
		}
		db.register(Item);
		await db.sync();
	});

	afterAll(() => db.close());

	it('unique constraint enforced in memory adapter', async () => {
		await db.adapter.insert('items', { name: 'Widget', price: 9.99 });
		await expect(async () => {
			await db.adapter.insert('items', { name: 'Widget', price: 19.99 });
		}).rejects.toThrow(/unique/i);
	});

	it('createIndex and dropIndex track metadata', async () => {
		await db.adapter.createIndex('items', ['name'], { name: 'idx_name' });
		let indexes = await db.adapter.indexes('items');
		expect(indexes.some(i => i.name === 'idx_name')).toBe(true);

		await db.adapter.dropIndex('items', 'idx_name');
		indexes = await db.adapter.indexes('items');
		expect(indexes.some(i => i.name === 'idx_name')).toBe(false);
	});

	it('addColumn and dropColumn work', async () => {
		await db.adapter.addColumn('items', 'category', { type: TYPES.STRING, default: 'general' });
		expect(await db.adapter.hasColumn('items', 'category')).toBe(true);

		await db.adapter.dropColumn('items', 'category');
		expect(await db.adapter.hasColumn('items', 'category')).toBe(false);
	});

	it('renameColumn works', async () => {
		await db.adapter.addColumn('items', 'desc', { type: TYPES.TEXT });
		await db.adapter.renameColumn('items', 'desc', 'description');
		expect(await db.adapter.hasColumn('items', 'description')).toBe(true);
		expect(await db.adapter.hasColumn('items', 'desc')).toBe(false);
	});

	it('renameTable works', async () => {
		await db.adapter.renameTable('items', 'products');
		expect(await db.adapter.hasTable('products')).toBe(true);
		expect(await db.adapter.hasTable('items')).toBe(false);
		// Rename back for other tests
		await db.adapter.renameTable('products', 'items');
	});

	it('describeTable returns schema info', async () => {
		const info = await db.adapter.describeTable('items');
		expect(Array.isArray(info)).toBe(true);
		expect(info.some(c => c.name === 'name')).toBe(true);
	});

	it('hasTable and hasColumn work', async () => {
		expect(await db.hasTable('items')).toBe(true);
		expect(await db.hasTable('nope')).toBe(false);
		expect(await db.hasColumn('items', 'name')).toBe(true);
		expect(await db.hasColumn('items', 'nope')).toBe(false);
	});

	it('Database.createIndex delegates to adapter', async () => {
		await db.createIndex('items', ['price'], { name: 'idx_price' });
		const indexes = await db.adapter.indexes('items');
		expect(indexes.some(i => i.name === 'idx_price')).toBe(true);
	});

	it('Database.dropIndex delegates to adapter', async () => {
		await db.dropIndex('items', 'idx_price');
		const indexes = await db.adapter.indexes('items');
		expect(indexes.some(i => i.name === 'idx_price')).toBe(false);
	});

	it('snapshot and restore preserves schemas', async () => {
		const snapshot = db.adapter.toJSON();
		const clone = db.adapter.clone();
		expect(await clone.hasTable('items')).toBe(true);
		expect(await clone.hasColumn('items', 'name')).toBe(true);
	});
});

// ============================================================
//  18. REAL-TIME — WebSocket
// ============================================================

describe('Docs — Real-Time: WebSocket', () => {
	let wsServer, wsPort;

	beforeAll(async () => {
		const { createApp } = require('../');
		const app = createApp();

		const clients = new Set();

		// --- Doc example ---
		app.ws('/chat', {
			maxPayload: 64 * 1024,
			pingInterval: 0,
		}, (ws, req) => {
			ws.data.name = ws.query.name || 'anon';
			clients.add(ws);
			ws.send('Welcome, ' + ws.data.name + '!');

			ws.on('message', msg => {
				for (const c of clients) {
					if (c !== ws && c.readyState === 1)
						c.send(ws.data.name + ': ' + msg);
				}
			});

			ws.on('close', () => clients.delete(ws));
		});

		wsServer = app.listen(0);
		await new Promise(r => wsServer.on('listening', r));
		wsPort = wsServer.address().port;
	});

	afterAll(() => wsServer?.close());

	it('connects and receives welcome message', async () => {
		const ws = await wsConnect(wsPort, '/chat?name=TestUser');
		await new Promise(r => setTimeout(r, 100));
		expect(ws.messages.some(m => m.includes('Welcome, TestUser!'))).toBe(true);
		sendCloseFrame(ws.socket);
	});

	it('sends and broadcasts messages', async () => {
		const ws1 = await wsConnect(wsPort, '/chat?name=Alice');
		const ws2 = await wsConnect(wsPort, '/chat?name=Bob');
		await new Promise(r => setTimeout(r, 100));

		ws1.sendWSFrame('hello everyone');
		await new Promise(r => setTimeout(r, 200));

		// Bob should receive Alice's message
		expect(ws2.messages.some(m => m.includes('Alice: hello everyone'))).toBe(true);
		sendCloseFrame(ws1.socket);
		sendCloseFrame(ws2.socket);
	});
});

// ============================================================
//  19. REAL-TIME — WebSocketPool
// ============================================================

describe('Docs — Real-Time: WebSocketPool', () => {
	let wsServer, wsPort, pool;

	beforeAll(async () => {
		const { createApp, WebSocketPool } = require('../');
		const app = createApp();
		pool = new WebSocketPool();

		// --- Doc example ---
		app.ws('/chat', { pingInterval: 0 }, (ws, req) => {
			const room = ws.query.room || 'general';
			pool.add(ws);
			pool.join(ws, room);

			ws.data.name = ws.query.name || 'anon';
			pool.toRoomJSON(room, { type: 'join', user: ws.data.name }, ws);

			ws.on('message', msg => {
				pool.toRoom(room, ws.data.name + ': ' + msg, ws);
			});

			ws.on('close', () => {
				pool.toRoomJSON(room, { type: 'leave', user: ws.data.name });
			});
		});

		// Pool status endpoint
		app.get('/pool/status', (req, res) => res.json({
			connections: pool.size,
			rooms: pool.rooms,
		}));

		wsServer = app.listen(0);
		await new Promise(r => wsServer.on('listening', r));
		wsPort = wsServer.address().port;
	});

	afterAll(() => wsServer?.close());

	it('pool tracks connections and rooms', async () => {
		const ws1 = await wsConnect(wsPort, '/chat?name=Alice&room=dev');
		const ws2 = await wsConnect(wsPort, '/chat?name=Bob&room=dev');
		await new Promise(r => setTimeout(r, 150));

		expect(pool.size).toBeGreaterThanOrEqual(2);
		expect(pool.rooms).toContain('dev');
		expect(pool.roomSize('dev')).toBeGreaterThanOrEqual(2);

		sendCloseFrame(ws1.socket);
		sendCloseFrame(ws2.socket);
	});

	it('room broadcast works', async () => {
		const ws1 = await wsConnect(wsPort, '/chat?name=Alice&room=test-room');
		const ws2 = await wsConnect(wsPort, '/chat?name=Bob&room=test-room');
		await new Promise(r => setTimeout(r, 150));

		ws1.sendWSFrame('hi room');
		await new Promise(r => setTimeout(r, 200));

		expect(ws2.messages.some(m => m.includes('Alice: hi room'))).toBe(true);
		sendCloseFrame(ws1.socket);
		sendCloseFrame(ws2.socket);
	});

	it('pool status endpoint works', async () => {
		const r = await doFetch(`http://localhost:${wsPort}/pool/status`);
		expect(r.data.connections).toBeDefined();
		expect(Array.isArray(r.data.rooms)).toBe(true);
	});
});

// ============================================================
//  20. REAL-TIME — SSE
// ============================================================

describe('Docs — Real-Time: SSE', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../');
		const app = createApp();

		// --- Doc example ---
		app.get('/events', (req, res) => {
			const sse = res.sse({
				retry: 5000,
				autoId: true,
				keepAlive: 0,
			});

			sse.send('connected');
			sse.event('tick', { time: Date.now() });
			setTimeout(() => sse.close(), 50);
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('SSE stream sends events', async () => {
		const result = await collectSSE(`${base}/events`);
		expect(result.status).toBe(200);
		expect(result.headers['content-type']).toContain('text/event-stream');
		expect(result.body).toContain('data: connected');
		expect(result.body).toContain('event: tick');
		expect(result.body).toContain('retry: 5000');
	});

	it('SSE autoId generates incrementing ids', async () => {
		const result = await collectSSE(`${base}/events`);
		expect(result.body).toContain('id: 1');
		expect(result.body).toContain('id: 2');
	});
});

// ============================================================
//  21. NETWORKING — fetch
// ============================================================

describe('Docs — Networking: fetch', () => {
	let server, base;

	beforeAll(async () => {
		// Create a local server to fetch from
		const { createApp, json } = require('../');
		const app = createApp();
		app.use(json());
		app.get('/data', (req, res) => res.json({ hello: 'world' }));
		app.post('/echo', (req, res) => res.json({ received: req.body }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('GET request with json()', async () => {
		const { fetch } = require('../');
		const res = await fetch(`${base}/data`);
		expect(res.ok).toBe(true);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.hello).toBe('world');
	});

	it('POST request with JSON body auto-serialized', async () => {
		const { fetch } = require('../');
		const res = await fetch(`${base}/echo`, {
			method: 'POST',
			body: { test: true },
		});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.received.test).toBe(true);
	});

	it('response headers work', async () => {
		const { fetch } = require('../');
		const res = await fetch(`${base}/data`);
		const ct = res.headers.get('content-type');
		expect(ct).toContain('application/json');
	});

	it('text() reads body as text', async () => {
		const { fetch } = require('../');
		const res = await fetch(`${base}/data`);
		const text = await res.text();
		expect(text).toContain('hello');
	});

	it('fetch with timeout', async () => {
		const { fetch } = require('../');
		const res = await fetch(`${base}/data`, { timeout: 5000 });
		expect(res.ok).toBe(true);
	});
});

// ============================================================
//  22. ERROR HANDLING — Error Classes
// ============================================================

describe('Docs — Error Handling: Error Classes', () => {
	let server, base;

	beforeAll(async () => {
		const {
			createApp, json, NotFoundError, ValidationError,
			createError, isHttpError, HttpError,
		} = require('../');
		const app = createApp();
		app.use(json());

		// --- Doc example: throw in route handlers ---
		app.get('/users/:id', async (req, res) => {
			if (req.params.id === '999') throw new NotFoundError('User not found');
			res.json({ id: req.params.id, name: 'Test' });
		});

		// --- Doc example: validation with field errors ---
		app.post('/users', async (req, res) => {
			const errors = {};
			if (!req.body.email) errors.email = 'required';
			if (!req.body.name) errors.name = 'required';
			if (Object.keys(errors).length > 0) {
				throw new ValidationError('Invalid input', errors);
			}
			res.json({ ok: true });
		});

		// --- Doc example: createError factory ---
		app.get('/conflict', (req, res) => {
			throw createError(409, 'Duplicate entry', { details: { id: 42 } });
		});

		// --- Doc example: custom error code ---
		app.get('/db-down', (req, res) => {
			throw new HttpError(503, 'Database offline', { code: 'DB_DOWN' });
		});

		// --- Doc example: isHttpError in error handler ---
		app.onError((err, req, res) => {
			if (isHttpError(err)) {
				res.status(err.statusCode).json(err.toJSON());
			} else {
				res.status(500).json({ error: 'Unexpected error' });
			}
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('NotFoundError returns 404 with message', async () => {
		const r = await doFetch(`${base}/users/999`);
		expect(r.status).toBe(404);
		expect(r.data.error).toBe('User not found');
	});

	it('valid request returns 200', async () => {
		const r = await doFetch(`${base}/users/1`);
		expect(r.status).toBe(200);
		expect(r.data.name).toBe('Test');
	});

	it('ValidationError returns 422 with field errors', async () => {
		const r = await doFetch(`${base}/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(r.status).toBe(422);
		expect(r.data.error).toBe('Invalid input');
		expect(r.data.details).toBeDefined();
	});

	it('createError(409) returns ConflictError', async () => {
		const r = await doFetch(`${base}/conflict`);
		expect(r.status).toBe(409);
		expect(r.data.error).toBe('Duplicate entry');
	});

	it('custom error code works', async () => {
		const r = await doFetch(`${base}/db-down`);
		expect(r.status).toBe(503);
		expect(r.data.code).toBe('DB_DOWN');
	});

	it('error classes have correct statusCode', () => {
		const {
			BadRequestError, UnauthorizedError, ForbiddenError,
			NotFoundError, ConflictError, PayloadTooLargeError,
			TooManyRequestsError, InternalError,
		} = require('../');
		expect(new BadRequestError().statusCode).toBe(400);
		expect(new UnauthorizedError().statusCode).toBe(401);
		expect(new ForbiddenError().statusCode).toBe(403);
		expect(new NotFoundError().statusCode).toBe(404);
		expect(new ConflictError().statusCode).toBe(409);
		expect(new PayloadTooLargeError().statusCode).toBe(413);
		expect(new TooManyRequestsError().statusCode).toBe(429);
		expect(new InternalError().statusCode).toBe(500);
	});

	it('isHttpError() identifies http errors', () => {
		const { isHttpError, NotFoundError } = require('../');
		expect(isHttpError(new NotFoundError())).toBe(true);
		expect(isHttpError(new Error('plain'))).toBe(false);
	});

	it('toJSON() serializes error', () => {
		const { NotFoundError } = require('../');
		const err = new NotFoundError('gone');
		const json = err.toJSON();
		expect(json.error).toBe('gone');
		expect(json.statusCode).toBe(404);
		expect(json.code).toBeDefined();
	});
});

// ============================================================
//  23. ERROR HANDLING — Framework Errors
// ============================================================

describe('Docs — Error Handling: Framework Errors', () => {
	it('DatabaseError has query and adapter', () => {
		const { DatabaseError } = require('../');
		const err = new DatabaseError('Failed to fetch', {
			query: 'SELECT * FROM users',
			adapter: 'sqlite',
			details: { originalError: 'SQLITE_ERROR' },
		});
		expect(err.statusCode).toBe(500);
		expect(err.query).toBe('SELECT * FROM users');
		expect(err.adapter).toBe('sqlite');
	});

	it('ConfigurationError has setting', () => {
		const { ConfigurationError } = require('../');
		const err = new ConfigurationError('DATABASE_URL is required', {
			setting: 'DATABASE_URL',
		});
		expect(err.statusCode).toBe(500);
		expect(err.setting).toBe('DATABASE_URL');
	});

	it('MiddlewareError has middleware name', () => {
		const { MiddlewareError } = require('../');
		const err = new MiddlewareError('Auth failed', { middleware: 'auth' });
		expect(err.statusCode).toBe(500);
		expect(err.middleware).toBe('auth');
	});

	it('RoutingError has path and method', () => {
		const { RoutingError } = require('../');
		const err = new RoutingError('Route conflict', { path: '/api', method: 'GET' });
		expect(err.statusCode).toBe(500);
		expect(err.path).toBe('/api');
		expect(err.method).toBe('GET');
	});

	it('TimeoutError has timeout value', () => {
		const { TimeoutError } = require('../');
		const err = new TimeoutError('Timed out', { timeout: 5000 });
		expect(err.statusCode).toBe(408);
		expect(err.timeout).toBe(5000);
	});

	it('all framework errors extend HttpError', () => {
		const { DatabaseError, ConfigurationError, MiddlewareError,
			RoutingError, TimeoutError, isHttpError } = require('../');
		expect(isHttpError(new DatabaseError())).toBe(true);
		expect(isHttpError(new ConfigurationError())).toBe(true);
		expect(isHttpError(new MiddlewareError())).toBe(true);
		expect(isHttpError(new RoutingError())).toBe(true);
		expect(isHttpError(new TimeoutError())).toBe(true);
	});
});

// ============================================================
//  24. ERROR HANDLING — errorHandler middleware
// ============================================================

describe('Docs — Error Handling: errorHandler', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, errorHandler, NotFoundError } = require('../');
		const app = createApp();

		app.get('/fail', () => { throw new NotFoundError('Not here'); });
		app.get('/crash', () => { throw new Error('Unexpected'); });

		// --- Doc example: custom formatter ---
		app.onError(errorHandler({
			stack: false,
			log: false,
			formatter: (err, req, isDev) => ({
				success: false,
				message: err.message,
			}),
		}));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('formats HttpError through custom formatter', async () => {
		const r = await doFetch(`${base}/fail`);
		expect(r.status).toBe(404);
		expect(r.data.success).toBe(false);
		expect(r.data.message).toBe('Not here');
	});

	it('formats plain Error through custom formatter', async () => {
		const r = await doFetch(`${base}/crash`);
		expect(r.status).toBe(500);
		expect(r.data.success).toBe(false);
	});
});

// ============================================================
//  25. ERROR HANDLING — debug
// ============================================================

describe('Docs — Error Handling: debug', () => {
	it('creates namespaced loggers', () => {
		const { debug } = require('../');
		const log = debug('test:docs');
		expect(typeof log).toBe('function');
		expect(typeof log.info).toBe('function');
		expect(typeof log.warn).toBe('function');
		expect(typeof log.error).toBe('function');
		expect(typeof log.trace).toBe('function');
		expect(typeof log.fatal).toBe('function');
	});

	it('debug.enable/disable/level work', () => {
		const { debug } = require('../');
		debug.enable('test:*');
		const log = debug('test:example');
		expect(log.enabled).toBe(true);

		debug.level('warn');
		debug.disable();
		debug.reset();
	});

	it('debug.json() and debug.colors() do not crash', () => {
		const { debug } = require('../');
		expect(() => {
			debug.json(true);
			debug.json(false);
			debug.colors(false);
			debug.colors(true);
			debug.timestamps(false);
			debug.timestamps(true);
			debug.reset();
		}).not.toThrow();
	});
});

// ============================================================
//  23. ORM — Migrator Framework
// ============================================================

describe('Docs — ORM: Migrator Framework', () => {
	const { Database, Model, TYPES, Migrator, defineMigration } = require('../');

	let db;

	beforeEach(async () => {
		db = Database.connect('memory');
	});
	afterEach(() => db.close());

	it('Migrator runs up migrations and tracks batches', async () => {
		const migrator = new Migrator(db);
		migrator.add({
			name: '001_create_posts',
			async up(db) {
				await db.adapter.createTable('posts', {
					id:    { type: 'integer', primaryKey: true, autoIncrement: true },
					title: { type: 'string', required: true },
				});
			},
			async down(db) {
				await db.adapter.dropTable('posts');
			},
		});

		const { migrated, batch } = await migrator.migrate();
		expect(migrated).toEqual(['001_create_posts']);
		expect(batch).toBe(1);
		expect(await db.adapter.hasTable('posts')).toBe(true);
	});

	it('Migrator.rollback undoes the last batch', async () => {
		const migrator = new Migrator(db);
		migrator.add({
			name: '001_create_items',
			async up(db) {
				await db.adapter.createTable('items', { id: { type: 'integer', primaryKey: true } });
			},
			async down(db) {
				await db.adapter.dropTable('items');
			},
		});
		await migrator.migrate();
		expect(await db.adapter.hasTable('items')).toBe(true);

		const { rolledBack } = await migrator.rollback();
		expect(rolledBack).toEqual(['001_create_items']);
		expect(await db.adapter.hasTable('items')).toBe(false);
	});

	it('Migrator.status reports executed and pending', async () => {
		const migrator = new Migrator(db);
		migrator.add({ name: '001', async up() {}, async down() {} });
		migrator.add({ name: '002', async up() {}, async down() {} });
		await migrator.migrate();
		migrator.add({ name: '003', async up() {}, async down() {} });

		const { executed, pending, lastBatch } = await migrator.status();
		expect(executed).toHaveLength(2);
		expect(pending).toEqual(['003']);
		expect(lastBatch).toBe(1);
	});

	it('Migrator.hasPending checks for unrun migrations', async () => {
		const migrator = new Migrator(db);
		migrator.add({ name: 'test', async up() {}, async down() {} });
		expect(await migrator.hasPending()).toBe(true);
		await migrator.migrate();
		expect(await migrator.hasPending()).toBe(false);
	});

	it('Migrator.reset rollbacks all then re-runs', async () => {
		const migrator = new Migrator(db);
		migrator.add({ name: '001', async up() {}, async down() {} });
		await migrator.migrate();

		const { rolledBack, migrated } = await migrator.reset();
		expect(rolledBack).toContain('001');
		expect(migrated).toContain('001');
	});

	it('Migrator.fresh drops everything and re-migrates', async () => {
		const migrator = new Migrator(db);
		migrator.add({
			name: '001_create_fresh',
			async up(db) {
				await db.adapter.createTable('fresh_tbl', { id: { type: 'integer', primaryKey: true } });
			},
			async down(db) {
				await db.adapter.dropTable('fresh_tbl');
			},
		});
		await migrator.migrate();
		const { migrated, batch } = await migrator.fresh();
		expect(migrated).toContain('001_create_fresh');
		expect(batch).toBe(1);
	});

	it('defineMigration creates a valid migration object', () => {
		const m = defineMigration('test_migration', async () => {}, async () => {});
		expect(m.name).toBe('test_migration');
		expect(typeof m.up).toBe('function');
		expect(typeof m.down).toBe('function');
	});

	it('Migrator batches multiple migrations together', async () => {
		const migrator = new Migrator(db);
		migrator.addAll([
			{ name: '001', async up() {}, async down() {} },
			{ name: '002', async up() {}, async down() {} },
		]);

		const { migrated, batch } = await migrator.migrate();
		expect(migrated).toHaveLength(2);
		expect(batch).toBe(1);

		// Add more and run again — should create batch 2
		migrator.add({ name: '003', async up() {}, async down() {} });
		const r2 = await migrator.migrate();
		expect(r2.batch).toBe(2);
	});
});

// ============================================================
//  24. ORM — QueryCache
// ============================================================

describe('Docs — ORM: QueryCache', () => {
	const { QueryCache } = require('../');

	it('set/get/delete/has lifecycle', () => {
		const cache = new QueryCache({ maxEntries: 100, defaultTTL: 60 });
		cache.set('config', { theme: 'dark', lang: 'en' }, 300);
		expect(cache.get('config')).toEqual({ theme: 'dark', lang: 'en' });
		expect(cache.has('config')).toBe(true);
		cache.delete('config');
		expect(cache.has('config')).toBe(false);
		expect(cache.get('config')).toBeUndefined();
	});

	it('remember pattern computes on miss, caches on hit', async () => {
		const cache = new QueryCache({ defaultTTL: 60 });
		let calls = 0;
		const compute = async () => { calls++; return [1, 2, 3]; };

		const v1 = await cache.remember('users', compute, 60);
		expect(v1).toEqual([1, 2, 3]);
		expect(calls).toBe(1);

		const v2 = await cache.remember('users', compute, 60);
		expect(v2).toEqual([1, 2, 3]);
		expect(calls).toBe(1);
	});

	it('invalidate removes entries by table name', () => {
		const cache = new QueryCache({ maxEntries: 100, defaultTTL: 60 });
		cache.set('users|all', [1]);
		cache.set('users|active', [2]);
		cache.set('posts|all', [3]);
		const removed = cache.invalidate('users');
		expect(removed).toBe(2);
		expect(cache.has('posts|all')).toBe(true);
	});

	it('stats tracks hits and misses', () => {
		const cache = new QueryCache({ maxEntries: 100, defaultTTL: 60 });
		cache.set('x', 1);
		cache.get('x');    // hit
		cache.get('y');    // miss
		cache.get('z');    // miss
		const s = cache.stats();
		expect(s.hits).toBe(1);
		expect(s.misses).toBe(2);
		expect(s.hitRate).toBeCloseTo(1 / 3);
		expect(s.size).toBe(1);
	});

	it('flush clears everything and resets stats', () => {
		const cache = new QueryCache();
		cache.set('a', 1);
		cache.set('b', 2);
		cache.get('a');
		const count = cache.flush();
		expect(count).toBe(2);
		expect(cache.stats().size).toBe(0);
		expect(cache.stats().hits).toBe(0);
	});

	it('LRU eviction when maxEntries exceeded', () => {
		const cache = new QueryCache({ maxEntries: 2, defaultTTL: 60 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3); // evicts 'a'
		expect(cache.has('a')).toBe(false);
		expect(cache.get('b')).toBe(2);
		expect(cache.get('c')).toBe(3);
	});

	it('prune removes expired entries', async () => {
		const cache = new QueryCache({ defaultTTL: 0.05 });
		cache.set('x', 1);
		cache.set('y', 2);
		cache.set('keep', 3, 600);
		await new Promise(r => setTimeout(r, 80));
		const pruned = cache.prune();
		expect(pruned).toBe(2);
		expect(cache.has('keep')).toBe(true);
	});

	it('wrap caches query results by descriptor', async () => {
		const cache = new QueryCache({ defaultTTL: 60 });
		const desc = { table: 'users', action: 'select', where: [] };
		let exec = 0;
		const r1 = await cache.wrap(desc, async () => { exec++; return [{ id: 1 }]; }, 30);
		const r2 = await cache.wrap(desc, async () => { exec++; return []; }, 30);
		expect(r1).toEqual([{ id: 1 }]);
		expect(r2).toEqual([{ id: 1 }]);
		expect(exec).toBe(1);
	});
});

// ============================================================
//  25. ORM — Seeder, Factory & Fake
// ============================================================

describe('Docs — ORM: Seeder, Factory & Fake', () => {
	const { Database, Model, TYPES, Seeder, SeederRunner, Factory, Fake } = require('../');

	let db;

	class SeedUser extends Model {
		static table  = 'seed_users';
		static schema = {
			id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			name:  { type: TYPES.STRING, required: true },
			email: { type: TYPES.STRING, required: true },
			role:  { type: TYPES.STRING, default: 'user' },
		};
	}

	beforeEach(async () => {
		db = Database.connect('memory');
		db.register(SeedUser);
		await db.sync();
	});
	afterEach(() => db.close());

	it('Factory.define + make builds data without persisting', () => {
		const factory = new Factory(SeedUser);
		factory.define({
			name:  () => Fake.fullName(),
			email: () => Fake.email(),
			role:  'user',
		});
		const users = factory.count(5).make();
		expect(users).toHaveLength(5);
		expect(users[0].name).toBeDefined();
		expect(users[0].email).toContain('@');
	});

	it('Factory.create persists records to database', async () => {
		const factory = new Factory(SeedUser);
		factory.define({ name: () => Fake.fullName(), email: () => Fake.email() });
		const user = await factory.create();
		expect(user.id).toBeDefined();
		const found = await SeedUser.findById(user.id);
		expect(found.name).toBe(user.name);
	});

	it('Factory.state + withState applies variations', async () => {
		const factory = new Factory(SeedUser);
		factory.define({ name: () => Fake.fullName(), email: () => Fake.email(), role: 'user' });
		factory.state('admin', { role: 'admin' });
		const admin = await factory.withState('admin').create();
		expect(admin.role).toBe('admin');
	});

	it('Seeder + SeederRunner workflow', async () => {
		class UserSeeder extends Seeder {
			async run(db) {
				const factory = new Factory(SeedUser);
				factory.define({ name: () => Fake.fullName(), email: () => Fake.email() });
				await factory.count(10).create();
			}
		}

		const runner = new SeederRunner(db);
		const names = await runner.run(UserSeeder);
		expect(names).toEqual(['UserSeeder']);
		const all = await SeedUser.find();
		expect(all.length).toBe(10);
	});

	it('SeederRunner.fresh clears data before seeding', async () => {
		await SeedUser.create({ name: 'Existing', email: 'existing@t.com' });
		class FreshSeeder extends Seeder {
			async run() { await SeedUser.create({ name: 'NewOnly', email: 'new@t.com' }); }
		}
		const runner = new SeederRunner(db);
		await runner.fresh(FreshSeeder);
		const all = await SeedUser.find();
		expect(all.every(u => u.name === 'NewOnly')).toBe(true);
	});

	it('Fake generators produce valid data', () => {
		expect(Fake.fullName()).toContain(' ');
		expect(Fake.email()).toContain('@');
		expect(Fake.uuid()).toMatch(/^[0-9a-f-]{36}$/i);
		expect(Fake.integer(1, 10)).toBeGreaterThanOrEqual(1);
		expect(Fake.integer(1, 10)).toBeLessThanOrEqual(10);
		expect(typeof Fake.boolean()).toBe('boolean');
		expect(Fake.phone()).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
		expect(Fake.color()).toMatch(/^#[0-9a-f]{6}$/);
		expect(Fake.ip()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		expect(Fake.url()).toMatch(/^https:\/\//);
		expect(Fake.sentence().endsWith('.')).toBe(true);
	});
});

// ============================================================
//  26. Error Handling — ORM Error Classes
// ============================================================

describe('Docs — Error Handling: ORM Error Classes', () => {
	const {
		ConnectionError, MigrationError, TransactionError,
		QueryError, AdapterError, CacheError,
		DatabaseError, HttpError, isHttpError,
	} = require('../');

	it('ConnectionError carries retry context', () => {
		const err = new ConnectionError('Redis refused', {
			adapter: 'redis', attempt: 3, maxRetries: 5, host: '127.0.0.1', port: 6379,
		});
		expect(err).toBeInstanceOf(DatabaseError);
		expect(err).toBeInstanceOf(HttpError);
		expect(err.statusCode).toBe(500);
		expect(err.code).toBe('CONNECTION_ERROR');
		expect(err.attempt).toBe(3);
		expect(err.maxRetries).toBe(5);
		expect(err.host).toBe('127.0.0.1');
		expect(err.port).toBe(6379);
	});

	it('MigrationError carries migration context', () => {
		const err = new MigrationError('Column exists', {
			migration: '003_avatar', direction: 'up', batch: 2,
		});
		expect(err.code).toBe('MIGRATION_ERROR');
		expect(err.migration).toBe('003_avatar');
		expect(err.direction).toBe('up');
		expect(err.batch).toBe(2);
	});

	it('TransactionError carries phase', () => {
		const err = new TransactionError('Deadlock', { phase: 'commit' });
		expect(err.code).toBe('TRANSACTION_ERROR');
		expect(err.phase).toBe('commit');
	});

	it('QueryError carries SQL context', () => {
		const err = new QueryError('Syntax error', { sql: 'BAD SQL', params: [1], table: 'users' });
		expect(err.code).toBe('QUERY_ERROR');
		expect(err.sql).toBe('BAD SQL');
		expect(err.params).toEqual([1]);
		expect(err.table).toBe('users');
	});

	it('AdapterError carries adapter/operation', () => {
		const err = new AdapterError('Not installed', { adapter: 'redis', operation: 'connect' });
		expect(err.code).toBe('ADAPTER_ERROR');
		expect(err.operation).toBe('connect');
	});

	it('CacheError carries operation/key', () => {
		const err = new CacheError('Serialization failed', { operation: 'set', key: 'users' });
		expect(err.code).toBe('CACHE_ERROR');
		expect(err.operation).toBe('set');
		expect(err.key).toBe('users');
	});

	it('all ORM errors work with isHttpError and toJSON', () => {
		const errors = [
			new ConnectionError(), new MigrationError(),
			new TransactionError(), new QueryError(),
			new AdapterError(), new CacheError(),
		];
		for (const err of errors) {
			expect(isHttpError(err)).toBe(true);
			const json = err.toJSON();
			expect(json.statusCode).toBe(500);
			expect(json.code).toBeDefined();
			expect(json.error).toBeDefined();
		}
	});
});
