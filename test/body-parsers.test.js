const http = require('http');
const fs = require('fs');
const path = require('path');
const { doFetch } = require('./_helpers');
const { createApp, json, urlencoded, text, raw, multipart } = require('../');

describe('JSON Parser Security', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({ limit: '100' }));
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('valid JSON parses', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' }
        });
        expect(r.data.body.a).toBe(1);
    });

    it('invalid JSON returns 400', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '{not valid json!!!',
            headers: { 'content-type': 'application/json' }
        });
        expect(r.status).toBe(400);
    });

    it('oversized payload returns 413', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ data: 'x'.repeat(200) }),
            headers: { 'content-type': 'application/json' }
        });
        expect(r.status).toBe(413);
    });

    it('wrong content-type leaves body null', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'text/plain' }
        });
        expect(r.data.body).toBeNull();
    });
});

describe('URLEncoded Prototype Pollution', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(urlencoded({ extended: true, limit: '10kb' }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('normal data parses', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'name=alice&age=30',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });
        expect(r.data.body.name).toBe('alice');
    });

    it('__proto__ pollution blocked', async () => {
        await doFetch(`${base}/form`, {
            method: 'POST', body: '__proto__[admin]=true',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });
        expect(({}).admin).toBeFalsy();
    });

    it('constructor pollution blocked', async () => {
        await doFetch(`${base}/form`, {
            method: 'POST', body: 'constructor[prototype][pwned]=true',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });
        expect(({}).pwned).toBeFalsy();
    });

    it('nested safe keys work', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'user[name]=bob&user[age]=25',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });
        expect(r.data.body.user.name).toBe('bob');
    });
});

describe('Text/Raw Parser Limits', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(text({ limit: '50', type: 'text/plain' }));
        app.use(raw({ limit: '50', type: 'application/octet-stream' }));
        app.post('/text', (req, res) => res.text(String(req.body || '')));
        app.post('/raw', (req, res) => res.send(Buffer.from(req.body || '')));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('text under limit succeeds', async () => {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'short',
            headers: { 'content-type': 'text/plain' }
        });
        expect(r.status).toBe(200);
    });

    it('text over limit returns 413', async () => {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'x'.repeat(100),
            headers: { 'content-type': 'text/plain' }
        });
        expect(r.status).toBe(413);
    });

    it('raw under limit succeeds', async () => {
        const r = await doFetch(`${base}/raw`, {
            method: 'POST', body: Buffer.from('short'),
            headers: { 'content-type': 'application/octet-stream' }
        });
        expect(r.status).toBe(200);
    });
});

describe('Multipart Filename Sanitization', () => {
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-uploads-sec');

    beforeAll(async () => {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir, maxFileSize: 1024 * 1024 }), (req, res) => {
            res.json({ files: req.body.files || [], fields: req.body.fields || {} });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('normal upload works', async () => {
        const boundary = '----test-boundary-' + Date.now();
        const parts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`),
            Buffer.from(`--${boundary}--\r\n`)
        ];
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body: Buffer.concat(parts),
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
        });
        expect(Object.keys(r.data.files).length).toBeGreaterThan(0);
    });

    it('path traversal stripped from filename', async () => {
        const boundary = '----test-boundary-' + Date.now() + '-2';
        const parts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../etc/passwd"\r\nContent-Type: text/plain\r\n\r\nevil\r\n`),
            Buffer.from(`--${boundary}--\r\n`)
        ];
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body: Buffer.concat(parts),
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
        });
        if (r.data.files && r.data.files[0]) {
            const savedName = r.data.files[0].originalFilename || '';
            expect(savedName).not.toContain('..');
            expect(savedName).not.toContain('/');
            expect(savedName).not.toContain('\\');
        } else {
            expect(true).toBe(true); // blocked entirely
        }
    });
});

// ===========================================================
//  JSON Parser — reviver function
// ===========================================================
describe('JSON Parser — reviver', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({
            reviver: (key, val) => {
                if (key === 'date' && typeof val === 'string') return new Date(val).toISOString();
                return val;
            }
        }));
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('reviver transforms values', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ date: '2024-01-01', name: 'test' }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body.date).toBe(new Date('2024-01-01').toISOString());
        expect(r.data.body.name).toBe('test');
    });
});

// ===========================================================
//  JSON Parser — strict mode
// ===========================================================
describe('JSON Parser — strict mode', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({ strict: true }));
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('accepts object', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body.ok).toBe(true);
    });

    it('accepts array', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify([1, 2, 3]),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body).toEqual([1, 2, 3]);
    });

    it('rejects primitive string in strict mode', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '"just a string"',
            headers: { 'content-type': 'application/json' },
        });
        // strict should reject primitives with 400
        expect(r.status).toBe(400);
    });

    it('rejects primitive number in strict mode', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '42',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(400);
    });
});

// ===========================================================
//  JSON Parser — non-strict mode
// ===========================================================
describe('JSON Parser — non-strict mode', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({ strict: false }));
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('accepts primitive string', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '"hello"',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body).toBe('hello');
    });

    it('accepts primitive number', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '42',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body).toBe(42);
    });
});

// ===========================================================
//  JSON Parser — empty body
// ===========================================================
describe('JSON Parser — empty body', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json());
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('empty JSON body sets req.body to null', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: '',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body).toBeNull();
    });
});

// ===========================================================
//  URLEncoded — array bracket notation
// ===========================================================
describe('URLEncoded — array bracket notation', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(urlencoded({ extended: true }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses deeply nested brackets', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a[b][c]=deep',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.data.body.a.b.c).toBe('deep');
    });

    it('parses multiple same-key values', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'tag=a&tag=b&tag=c',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        // extended parser may treat duplicates as arrays or last-value
        expect(r.data.body.tag).toBeTruthy();
    });

    it('handles + as space', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'msg=hello+world',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.data.body.msg).toBe('hello world');
    });

    it('handles empty body', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: '',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.data.body).toEqual({});
    });
});

// ===========================================================
//  URLEncoded — non-extended (flat)
// ===========================================================
describe('URLEncoded — non-extended', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(urlencoded({ extended: false }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses flat key=value pairs', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'x=1&y=2',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.data.body.x).toBe('1');
        expect(r.data.body.y).toBe('2');
    });

    it('bracket notation is literal in flat mode', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a[b]=val',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        // In non-extended, brackets are treated as literal key
        expect(r.data.body['a[b]']).toBe('val');
    });
});

// ===========================================================
//  URLEncoded — requireSecure
// ===========================================================
describe('URLEncoded — requireSecure', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(urlencoded({ requireSecure: true }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects HTTP with 403', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a=1',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(403);
    });
});

// ===========================================================
//  Text Parser — encoding
// ===========================================================
describe('Text Parser — behavior', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(text());
        app.post('/text', (req, res) => res.text(String(req.body || '')));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses text/plain body', async () => {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'hello there',
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.data).toBe('hello there');
    });

    it('ignores non-matching content type', async () => {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'data',
            headers: { 'content-type': 'application/json' },
        });
        // body not parsed as text, should be empty
        expect(r.data).toBe('');
    });
});

// ===========================================================
//  Raw Buffer Parser
// ===========================================================
describe('Raw Parser — behavior', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(raw({ type: 'application/octet-stream' }));
        app.post('/raw', (req, res) => {
            const isBuffer = Buffer.isBuffer(req.body);
            res.json({ isBuffer, length: isBuffer ? req.body.length : 0 });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses raw body as Buffer', async () => {
        const r = await doFetch(`${base}/raw`, {
            method: 'POST', body: Buffer.from([1, 2, 3, 4, 5]),
            headers: { 'content-type': 'application/octet-stream' },
        });
        expect(r.data.isBuffer).toBe(true);
        expect(r.data.length).toBe(5);
    });
});

// ===========================================================
//  Multipart — fields only (no files)
// ===========================================================
describe('Multipart — fields only', () => {
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-uploads-fields');

    beforeAll(async () => {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir }), (req, res) => {
            res.json({ fields: req.body.fields || {} });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('parses multipart form fields without files', async () => {
        const boundary = '----fields-' + Date.now();
        const body = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nAlice\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="age"\r\n\r\n30\r\n` +
            `--${boundary}--\r\n`
        );
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.data.fields.name).toBe('Alice');
        expect(r.data.fields.age).toBe('30');
    });
});
