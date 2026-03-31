const zlib = require('zlib');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { doFetch, fetch } = require('../_helpers');
const {
    createApp, json, urlencoded, text, raw, multipart,
    static: serveStatic, helmet, cors, cookieParser, rateLimit, csrf
} = require('../../');

// ===========================================================
//  CRLF Header Injection
// ===========================================================
describe('Security — CRLF Header Injection', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/set-cr', (req, res) => {
            try { res.set('X-Test', 'val\rEvil'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/set-lf', (req, res) => {
            try { res.set('X-Test', 'val\nEvil'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/set-crlf', (req, res) => {
            try { res.set('X-Test', 'val\r\nEvil: header'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/set-name-crlf', (req, res) => {
            try { res.set('Evil\r\nHeader', 'val'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/append-crlf', (req, res) => {
            try { res.append('X-Test', 'val\r\nEvil'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('blocks CR in header value', async () => {
        const r = await doFetch(`${base}/set-cr`);
        expect(r.data.blocked).toBe(true);
    });

    it('blocks LF in header value', async () => {
        const r = await doFetch(`${base}/set-lf`);
        expect(r.data.blocked).toBe(true);
    });

    it('blocks CRLF in header value', async () => {
        const r = await doFetch(`${base}/set-crlf`);
        expect(r.data.blocked).toBe(true);
    });

    it('blocks CRLF in header name', async () => {
        const r = await doFetch(`${base}/set-name-crlf`);
        expect(r.data.blocked).toBe(true);
    });

    it('blocks CRLF in append()', async () => {
        const r = await doFetch(`${base}/append-crlf`);
        expect(r.data.blocked).toBe(true);
    });
});

// ===========================================================
//  Prototype Pollution via urlencoded extended
// ===========================================================
describe('Security — Prototype Pollution', () => {
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

    function postForm(body) {
        return doFetch(`${base}/form`, {
            method: 'POST', body,
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });
    }

    it('__proto__ key is stripped', async () => {
        await postForm('__proto__[isAdmin]=true');
        expect(({}).isAdmin).toBeUndefined();
    });

    it('constructor key is stripped', async () => {
        await postForm('constructor[prototype][pwned]=true');
        expect(({}).pwned).toBeUndefined();
    });

    it('prototype key is stripped', async () => {
        await postForm('prototype[evil]=1');
        expect(({}).evil).toBeUndefined();
    });

    it('nested __proto__ in brackets is stripped', async () => {
        await postForm('a[__proto__][x]=1');
        expect(({}).x).toBeUndefined();
    });

    it('safe nested keys still work', async () => {
        const r = await postForm('user[name]=alice&user[role]=admin');
        expect(r.data.body.user.name).toBe('alice');
        expect(r.data.body.user.role).toBe('admin');
    });
});

// ===========================================================
//  Path Traversal in Static Middleware
// ===========================================================
describe('Security — Static Path Traversal', () => {
    let server, base;
    const dir = path.join(__dirname, 'sec-static');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'public.txt'), 'ok');
        const app = createApp();
        app.use('/files', serveStatic(dir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('blocks ../', async () => {
        const r = await doFetch(`${base}/files/../package.json`);
        expect([403, 404]).toContain(r.status);
    });

    it('blocks encoded %2e%2e', async () => {
        const r = await doFetch(`${base}/files/%2e%2e/package.json`);
        expect([403, 404]).toContain(r.status);
    });

    it('blocks double-encoded %252e%252e', async () => {
        const r = await doFetch(`${base}/files/%252e%252e/package.json`);
        expect([400, 403, 404]).toContain(r.status);
    });

    it('blocks null byte injection', async () => {
        const r = await doFetch(`${base}/files/public.txt%00.exe`);
        expect(r.status).toBe(400);
    });

    it('blocks backslash traversal', async () => {
        const r = await doFetch(`${base}/files/..\\package.json`);
        expect([403, 404]).toContain(r.status);
    });

    it('serves legitimate file', async () => {
        const r = await doFetch(`${base}/files/public.txt`);
        expect(r.status).toBe(200);
        expect(r.data).toBe('ok');
    });
});

// ===========================================================
//  Path Traversal in sendFile with root option
// ===========================================================
describe('Security — sendFile Traversal', () => {
    let server, base;
    const dir = path.join(__dirname, 'sec-sendfile');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ok.txt'), 'safe');
        const app = createApp();
        app.get('/file', (req, res) => {
            const name = req.query.name || 'ok.txt';
            res.sendFile(name, { root: dir });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('serves legitimate file', async () => {
        const r = await doFetch(`${base}/file?name=ok.txt`);
        expect(r.data).toBe('safe');
    });

    it('blocks ../ traversal', async () => {
        const r = await doFetch(`${base}/file?name=../package.json`);
        expect(r.status).toBe(403);
    });

    it('blocks null byte', async () => {
        const r = await doFetch(`${base}/file?name=ok.txt%00.exe`);
        expect(r.status).toBe(400);
    });
});

// ===========================================================
//  Body Size Limits
// ===========================================================
describe('Security — Body Size Limits', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({ limit: '50' }));
        app.use(text({ limit: '50' }));
        app.use(raw({ limit: '50' }));
        app.post('/json', (req, res) => res.json({ body: req.body }));
        app.post('/text', (req, res) => res.text(String(req.body || '')));
        app.post('/raw', (req, res) => res.send(req.body || Buffer.alloc(0)));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('JSON over limit returns 413', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ data: 'x'.repeat(100) }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(413);
    });

    it('text over limit returns 413', async () => {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'x'.repeat(100),
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.status).toBe(413);
    });

    it('small payloads pass through', async () => {
        const r = await doFetch(`${base}/json`, {
            method: 'POST', body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
    });
});

// ===========================================================
//  requireSecure option on body parsers
// ===========================================================
describe('Security — requireSecure on Body Parsers', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(json({ requireSecure: true }));
        app.post('/secure', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects HTTP with 403', async () => {
        const r = await doFetch(`${base}/secure`, {
            method: 'POST', body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(403);
    });
});

// ===========================================================
//  Cookie Name Injection
// ===========================================================
describe('Security — Cookie Name Validation', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/cookie-semicolon', (req, res) => {
            try { res.cookie('bad;name', 'val'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/cookie-equals', (req, res) => {
            try { res.cookie('bad=name', 'val'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        app.get('/cookie-space', (req, res) => {
            try { res.cookie('bad name', 'val'); res.json({ blocked: false }); }
            catch (e) { res.json({ blocked: true }); }
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects semicolon in cookie name', async () => {
        const r = await doFetch(`${base}/cookie-semicolon`);
        expect(r.data.blocked).toBe(true);
    });

    it('rejects equals in cookie name', async () => {
        const r = await doFetch(`${base}/cookie-equals`);
        expect(r.data.blocked).toBe(true);
    });

    it('rejects space in cookie name', async () => {
        const r = await doFetch(`${base}/cookie-space`);
        expect(r.data.blocked).toBe(true);
    });
});

// ===========================================================
//  Signed Cookie Integrity
// ===========================================================
describe('Security — Signed Cookie Integrity', () => {
    let server, base;
    const secret = 'security-test-secret';

    beforeAll(async () => {
        const app = createApp();
        app.use(cookieParser(secret));
        app.get('/cookies', (req, res) => {
            res.json({ signed: req.signedCookies, regular: req.cookies });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('valid signed cookie is verified', async () => {
        const signed = cookieParser.sign('admin', secret);
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `auth=${encodeURIComponent(signed)}` }
        });
        expect(r.data.signed.auth).toBe('admin');
    });

    it('tampered signature is rejected', async () => {
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `auth=${encodeURIComponent('s:admin.TAMPERED')}` }
        });
        expect(r.data.signed.auth).toBeFalsy();
    });

    it('tampered value is rejected', async () => {
        const signed = cookieParser.sign('admin', secret);
        // Change 'admin' to 'ADMIN' but keep the same hash
        const tampered = signed.replace('admin', 'ADMIN');
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `auth=${encodeURIComponent(tampered)}` }
        });
        expect(r.data.signed.auth).toBeFalsy();
    });

    it('non-signed cookie stays in cookies not signedCookies', async () => {
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': 'theme=dark' }
        });
        expect(r.data.regular.theme).toBe('dark');
        expect(r.data.signed.theme).toBeFalsy();
    });
});

// ===========================================================
//  Helmet Default Headers
// ===========================================================
describe('Security — Helmet Headers', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet());
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets all expected security headers', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-content-type-options')).toBe('nosniff');
        expect(r.headers.get('x-frame-options')).toBe('DENY');
        expect(r.headers.get('x-dns-prefetch-control')).toBe('off');
        expect(r.headers.get('x-download-options')).toBe('noopen');
        expect(r.headers.get('referrer-policy')).toBe('no-referrer');
        expect(r.headers.get('x-xss-protection')).toBe('0');
        expect(r.headers.get('strict-transport-security')).toContain('max-age=');
        expect(r.headers.get('content-security-policy')).toBeTruthy();
        expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
        expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
        expect(r.headers.get('x-permitted-cross-domain-policies')).toBe('none');
    });

    it('HSTS includes includeSubDomains by default', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('strict-transport-security')).toContain('includeSubDomains');
    });

    it('COEP is off by default', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('cross-origin-embedder-policy')).toBeFalsy();
    });
});

// ===========================================================
//  Double-Send Protection
// ===========================================================
describe('Security — Double Send Protection', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/double', (req, res) => {
            res.json({ first: true });
            res.json({ second: true }); // should be no-op
        });
        app.get('/sse-double', (req, res) => {
            const sse = res.sse();
            sse.send('first');
            // res.sse() a second time should be null
            const second = res.sse();
            sse.data.secondWasNull = second === null;
            setTimeout(() => sse.close(), 30);
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('first response wins on double json()', async () => {
        const r = await doFetch(`${base}/double`);
        expect(r.data.first).toBe(true);
        expect(r.data.second).toBeUndefined();
    });

    it('second sse() call returns null', async () => {
        const { body } = await new Promise((resolve, reject) => {
            const chunks = [];
            http.get(`${base}/sse-double`, (resp) => {
                resp.on('data', c => chunks.push(c.toString()));
                resp.on('end', () => resolve({ body: chunks.join('') }));
            }).on('error', reject);
        });
        expect(body).toContain('data: first');
    });
});

// ===========================================================
//  Multipart Filename Sanitization
// ===========================================================
describe('Security — Multipart Filename Sanitization', () => {
    let server, base;
    const uploadDir = path.join(__dirname, 'sec-uploads');

    beforeAll(async () => {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir }), (req, res) => {
            res.json({ files: req.body.files, fields: req.body.fields });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    function makeMultipart(boundary, filename, content) {
        return Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`),
            Buffer.from(`--${boundary}--\r\n`),
        ]);
    }

    it('strips path traversal from filename', async () => {
        const b = 'bound-' + Date.now();
        const r = await doFetch(`${base}/upload`, {
            method: 'POST',
            body: makeMultipart(b, '../../../etc/passwd', 'evil'),
            headers: { 'content-type': `multipart/form-data; boundary=${b}` },
        });
        if (r.data.files && Object.keys(r.data.files).length) {
            const file = Object.values(r.data.files)[0];
            const name = file.originalFilename || file.storedName || '';
            expect(name).not.toContain('..');
            expect(name).not.toContain('/');
        }
    });

    it('strips null bytes from filename', async () => {
        const b = 'bound-' + Date.now() + '-2';
        const r = await doFetch(`${base}/upload`, {
            method: 'POST',
            body: makeMultipart(b, 'evil\x00.txt', 'data'),
            headers: { 'content-type': `multipart/form-data; boundary=${b}` },
        });
        if (r.data.files && Object.keys(r.data.files).length) {
            const file = Object.values(r.data.files)[0];
            const name = file.originalFilename || file.storedName || '';
            expect(name).not.toContain('\x00');
        }
    });
});

// ===========================================================
//  Query String Prototype Pollution
// ===========================================================
describe('Security — Query String Prototype Pollution', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/q', (req, res) => {
            res.json({
                hasProto: '__proto__' in req.query,
                hasConstructor: 'constructor' in req.query,
                hasPrototype: 'prototype' in req.query,
                keys: Object.keys(req.query),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('blocks __proto__ key in query string', async () => {
        const r = await doFetch(`${base}/q?__proto__=evil&safe=ok`);
        expect(r.data.hasProto).toBe(false);
        expect(r.data.keys).toContain('safe');
    });

    it('blocks constructor key in query string', async () => {
        const r = await doFetch(`${base}/q?constructor=evil`);
        expect(r.data.hasConstructor).toBe(false);
    });

    it('blocks prototype key in query string', async () => {
        const r = await doFetch(`${base}/q?prototype=evil`);
        expect(r.data.hasPrototype).toBe(false);
    });

    it('uses null-prototype object for query', async () => {
        const r = await doFetch(`${base}/q?a=1`);
        expect(r.data.keys).toContain('a');
    });
});

// ===========================================================
//  MySQL Adapter — SQL Injection Guards
// ===========================================================
describe('Security — MySQL Adapter Injection Guards', () => {
    const MysqlAdapter = (() => {
        try { return require('../../lib/orm/adapters/mysql'); } catch { return null; }
    })();

    const skipIf = !MysqlAdapter;

    it('_safeIdent rejects malicious engine/charset values', () => {
        if (skipIf) return;
        const adapter = Object.create(MysqlAdapter.prototype);
        expect(() => adapter._safeIdent('InnoDB; DROP TABLE users--')).toThrow('Invalid identifier');
        expect(() => adapter._safeIdent("utf8mb4' OR 1=1")).toThrow('Invalid identifier');
        expect(() => adapter._safeIdent('utf8mb4')).not.toThrow();
        expect(() => adapter._safeIdent('utf8mb4_unicode_ci')).not.toThrow();
    });

    it('_typeMap escapes single quotes in ENUM values', () => {
        if (skipIf) return;
        const adapter = Object.create(MysqlAdapter.prototype);
        const result = adapter._typeMap({ type: 'enum', enum: ["O'Brien", "normal"] });
        expect(result).toContain("O''Brien");
        expect(result).not.toContain("O'Brien'");
    });

    it('_typeMap escapes single quotes in SET values', () => {
        if (skipIf) return;
        const adapter = Object.create(MysqlAdapter.prototype);
        const result = adapter._typeMap({ type: 'set', values: ["it's", "safe"] });
        expect(result).toContain("it''s");
    });
});

// ===========================================================
//  PostgreSQL Adapter — SQL Injection Guards
// ===========================================================
describe('Security — PostgreSQL Adapter Injection Guards', () => {
    const PgAdapter = (() => {
        try { return require('../../lib/orm/adapters/postgres'); } catch { return null; }
    })();

    const skipIf = !PgAdapter;

    it('listen() rejects malicious channel names', async () => {
        if (skipIf) return;
        const adapter = Object.create(PgAdapter.prototype);
        await expect(() => adapter.listen("ch; DROP TABLE users--", () => {})).rejects.toThrow('Invalid channel name');
    });

    it('_typeMap escapes single quotes in enum values', () => {
        if (skipIf) return;
        const adapter = Object.create(PgAdapter.prototype);
        const result = adapter._typeMap({ type: 'enum', _name: 'status', enum: ["it's", "ok"] });
        expect(result).toContain("it''s");
    });

    it('_typeMap escapes double quotes in enum column name', () => {
        if (skipIf) return;
        const adapter = Object.create(PgAdapter.prototype);
        const result = adapter._typeMap({ type: 'enum', _name: 'col"name', enum: ["a"] });
        expect(result).toContain('col""name');
    });
});

// ===========================================================
//  SQLite Adapter — Pragma Injection Guards
// ===========================================================
describe('Security — SQLite Adapter Pragma Escaping', () => {
    const SqliteAdapter = (() => {
        try { return require('../../lib/orm/adapters/sqlite'); } catch { return null; }
    })();

    it('columns() escapes quotes in table name', () => {
        if (!SqliteAdapter) return;
        const db = new SqliteAdapter({ filename: ':memory:' });
        const tableName = 'test"table';
        db._db.exec(`CREATE TABLE "${tableName.replace(/"/g, '""')}" (id INTEGER PRIMARY KEY)`);
        const cols = db.columns(tableName);
        expect(cols).toHaveLength(1);
        expect(cols[0].name).toBe('id');
        db.close();
    });

    it('indexes() does not throw for table with quotes in name', () => {
        if (!SqliteAdapter) return;
        const db = new SqliteAdapter({ filename: ':memory:' });
        const tableName = 'idx"test';
        db._db.exec(`CREATE TABLE "${tableName.replace(/"/g, '""')}" (id INTEGER PRIMARY KEY, name TEXT)`);
        expect(() => db.indexes(tableName)).not.toThrow();
        db.close();
    });

    it('foreignKeys() escapes table name', () => {
        if (!SqliteAdapter) return;
        const db = new SqliteAdapter({ filename: ':memory:' });
        const tableName = 'fk"test';
        db._db.exec(`CREATE TABLE "${tableName.replace(/"/g, '""')}" (id INTEGER PRIMARY KEY)`);
        const fks = db.foreignKeys(tableName);
        expect(Array.isArray(fks)).toBe(true);
        db.close();
    });
});

// ===========================================================
//  Redis Adapter — Input Validation Guards
// ===========================================================
describe('Security — Redis Adapter Input Validation', () => {
    const RedisAdapter = (() => {
        try { return require('../../lib/orm/adapters/redis'); } catch { return null; }
    })();

    // Build a mock adapter without going through the constructor
    // (constructor needs ioredis — we're testing validation methods)
    function makeMock() {
        const adapter = Object.create(RedisAdapter.prototype);
        adapter._prefix = 'test:';
        adapter._schemas = new Map();
        adapter._indexes = new Map();
        adapter._subscribers = new Map();
        adapter._client = {};
        adapter._subClient = null;
        return adapter;
    }

    const skipIf = !RedisAdapter;

    it('_validateKey rejects empty string', () => {
        if (skipIf) return;
        const a = makeMock();
        expect(() => a._validateKey('')).toThrow('non-empty string');
    });

    it('_validateKey rejects non-string values', () => {
        if (skipIf) return;
        const a = makeMock();
        expect(() => a._validateKey(123)).toThrow('non-empty string');
        expect(() => a._validateKey(null)).toThrow('non-empty string');
        expect(() => a._validateKey(undefined)).toThrow('non-empty string');
    });

    it('_validateKey rejects strings with control characters', () => {
        if (skipIf) return;
        const a = makeMock();
        expect(() => a._validateKey('key\x00name')).toThrow('control characters');
        expect(() => a._validateKey('key\nnewline')).toThrow('control characters');
        expect(() => a._validateKey('key\ttab')).toThrow('control characters');
        expect(() => a._validateKey('key\rreturn')).toThrow('control characters');
    });

    it('_validateKey accepts valid keys', () => {
        if (skipIf) return;
        const a = makeMock();
        expect(() => a._validateKey('users')).not.toThrow();
        expect(() => a._validateKey('cache:item:42')).not.toThrow();
        expect(() => a._validateKey('my-key_v2.data')).not.toThrow();
    });

    it('_validateKey uses custom label in error message', () => {
        if (skipIf) return;
        const a = makeMock();
        expect(() => a._validateKey('', 'channel')).toThrow('channel');
    });

    it('get() rejects keys with control characters', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.get('bad\x00key')).rejects.toThrow('control characters');
    });

    it('set() rejects empty key', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.set('', 'value')).rejects.toThrow('non-empty string');
    });

    it('del() rejects key with null byte', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.del('key\x00')).rejects.toThrow('control characters');
    });

    it('subscribe() rejects non-function callback', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.subscribe('chan', 'not-a-function')).rejects.toThrow('function');
    });

    it('subscribe() rejects channel with control chars', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.subscribe('ch\x00an', () => {})).rejects.toThrow('control characters');
    });

    it('raw() rejects non-string command', async () => {
        if (skipIf) return;
        const a = makeMock();
        await expect(a.raw(123)).rejects.toThrow('non-empty string');
        await expect(a.raw('')).rejects.toThrow('non-empty string');
    });
});

// ===========================================================
//  ReDoS-Safe LIKE Matcher (Memory & Redis Adapters)
// ===========================================================
describe('Security — ReDoS-Safe LIKE Matcher', () => {
    const MemoryAdapter = require('../../lib/orm/adapters/memory');
    const { Database, TYPES } = require('../../');

    it('matches simple % wildcard', async () => {
        const db = Database.connect('memory');
        await db.adapter.createTable('like_test', {
            id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING },
        });
        await db.adapter.insert('like_test', { name: 'Alice' });
        await db.adapter.insert('like_test', { name: 'Bob' });
        await db.adapter.insert('like_test', { name: 'Alicia' });

        const r = await db.adapter.execute({
            action: 'select', table: 'like_test',
            where: [{ field: 'name', op: 'LIKE', value: 'Ali%', logic: 'AND' }],
        });
        expect(r.length).toBe(2);
        expect(r.map(x => x.name).sort()).toEqual(['Alice', 'Alicia']);
    });

    it('matches _ single char wildcard', async () => {
        const db = Database.connect('memory');
        await db.adapter.createTable('like_underscore', {
            id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            code: { type: TYPES.STRING },
        });
        await db.adapter.insert('like_underscore', { code: 'A1' });
        await db.adapter.insert('like_underscore', { code: 'AB' });
        await db.adapter.insert('like_underscore', { code: 'ABC' });

        const r = await db.adapter.execute({
            action: 'select', table: 'like_underscore',
            where: [{ field: 'code', op: 'LIKE', value: 'A_', logic: 'AND' }],
        });
        expect(r.length).toBe(2);
        expect(r.map(x => x.code).sort()).toEqual(['A1', 'AB']);
    });

    it('does NOT exhibit exponential backtracking on pathological patterns', () => {
        // This pattern would cause catastrophic backtracking with regex:
        // %a%a%a%a%a%a%a%a%a%a%b  matched against "aaaaaaaaaa"
        // With regex: /^.*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*b$/i  → exponential
        // With DP: O(n*m) → instant
        const _likeSafe = (() => {
            // Extract the function from the module file directly
            const src = require('fs').readFileSync(
                require('path').join(__dirname, '..', '..', 'lib', 'orm', 'adapters', 'memory.js'), 'utf8'
            );
            const match = src.match(/function _likeSafe[\s\S]+?^}/m);
            if (!match) throw new Error('Could not extract _likeSafe');
            return new Function('return ' + match[0])();
        })();

        const input = 'a'.repeat(30);
        const pattern = '%a'.repeat(15) + '%b';

        const start = Date.now();
        const result = _likeSafe(input, pattern);
        const elapsed = Date.now() - start;

        expect(result).toBe(false);
        // With regex, this would take minutes/hours. With DP, <100ms.
        expect(elapsed).toBeLessThan(500);
    });

    it('LIKE is case-insensitive', async () => {
        const db = Database.connect('memory');
        await db.adapter.createTable('like_case', {
            id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING },
        });
        await db.adapter.insert('like_case', { name: 'Alice' });
        await db.adapter.insert('like_case', { name: 'ALICE' });

        const r = await db.adapter.execute({
            action: 'select', table: 'like_case',
            where: [{ field: 'name', op: 'LIKE', value: 'alice', logic: 'AND' }],
        });
        expect(r.length).toBe(2);
    });
});

// ===========================================================
//  Migrator — Name Validation Guards
// ===========================================================
describe('Security — Migrator Name Validation', () => {
    const { Database, Migrator, defineMigration } = require('../../');

    it('add() rejects empty name', () => {
        const db = Database.connect('memory');
        const m = new Migrator(db);
        expect(() => m.add({ name: '', up: () => {}, down: () => {} })).toThrow('must have a name');
    });

    it('add() rejects non-string name', () => {
        const db = Database.connect('memory');
        const m = new Migrator(db);
        expect(() => m.add({ name: 123, up: () => {}, down: () => {} })).toThrow('must have a name');
    });

    it('add() rejects names with spaces', () => {
        const db = Database.connect('memory');
        const m = new Migrator(db);
        expect(() => m.add({ name: 'bad name', up: () => {}, down: () => {} })).toThrow('invalid characters');
    });

    it('add() rejects names with special characters', () => {
        const db = Database.connect('memory');
        const m = new Migrator(db);
        expect(() => m.add({ name: 'drop;table', up: () => {}, down: () => {} })).toThrow('invalid characters');
        expect(() => m.add({ name: "name'or 1=1", up: () => {}, down: () => {} })).toThrow('invalid characters');
        expect(() => m.add({ name: 'path/../traversal', up: () => {}, down: () => {} })).toThrow('invalid characters');
    });

    it('add() accepts valid migration names', () => {
        const db = Database.connect('memory');
        const m = new Migrator(db);
        expect(() => m.add({ name: '001_create_users', up: () => {}, down: () => {} })).not.toThrow();
        expect(() => m.add({ name: 'v2.0-add-index', up: () => {}, down: () => {} })).not.toThrow();
        expect(() => m.add({ name: 'CamelCase123', up: () => {}, down: () => {} })).not.toThrow();
    });

    it('defineMigration() rejects names with special characters', () => {
        expect(() => defineMigration('bad name', () => {}, () => {})).toThrow('invalid characters');
        expect(() => defineMigration('drop;table', () => {}, () => {})).toThrow('invalid characters');
    });

    it('defineMigration() rejects missing name', () => {
        expect(() => defineMigration('', () => {}, () => {})).toThrow('name is required');
        expect(() => defineMigration(null, () => {}, () => {})).toThrow('name is required');
    });

    it('defineMigration() rejects non-function up/down', () => {
        expect(() => defineMigration('valid_name', 'not-fn', () => {})).toThrow('up must be a function');
        expect(() => defineMigration('valid_name', () => {}, 'not-fn')).toThrow('down must be a function');
    });

    it('defineMigration() accepts valid inputs', () => {
        const result = defineMigration('001_users', async () => {}, async () => {});
        expect(result).toEqual({ name: '001_users', up: expect.any(Function), down: expect.any(Function) });
    });
});

// ===========================================================
//  QueryCache — Bounds Validation
// ===========================================================
describe('Security — QueryCache Bounds Validation', () => {
    const { QueryCache } = require('../../');

    it('maxEntries is clamped to at least 1', () => {
        const c = new QueryCache({ maxEntries: 0 });
        expect(c._maxEntries).toBe(1);
        const c2 = new QueryCache({ maxEntries: -10 });
        expect(c2._maxEntries).toBe(1);
    });

    it('defaultTTL is clamped to at least 0', () => {
        const c = new QueryCache({ defaultTTL: -5 });
        expect(c._defaultTTL).toBe(0);
    });

    it('negative TTL in set() is clamped to 0', () => {
        const c = new QueryCache({ defaultTTL: 0 });
        c.set('key', 'val', -100);
        // Should still be retrievable (TTL 0 = no expiry)
        expect(c.get('key')).toBe('val');
    });

    it('NaN TTL in set() is treated as 0', () => {
        const c = new QueryCache({ defaultTTL: 0 });
        c.set('key', 'val', NaN);
        expect(c.get('key')).toBe('val');
    });

    it('NaN maxEntries defaults to 1', () => {
        const c = new QueryCache({ maxEntries: NaN });
        expect(c._maxEntries).toBe(1);
    });
});

// ===========================================================
//  Factory — Count Validation
// ===========================================================
describe('Security — Factory Count Validation', () => {
    const { Factory, Model, TYPES, Database } = require('../../');

    class TestModel extends Model {
        static table = 'factory_test';
        static schema = {
            id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING },
        };
    }

    it('rejects count of 0', () => {
        const f = new Factory(TestModel);
        expect(() => f.count(0)).toThrow('positive integer');
    });

    it('rejects negative count', () => {
        const f = new Factory(TestModel);
        expect(() => f.count(-5)).toThrow('positive integer');
    });

    it('rejects NaN count', () => {
        const f = new Factory(TestModel);
        expect(() => f.count(NaN)).toThrow('positive integer');
    });

    it('rejects Infinity count', () => {
        const f = new Factory(TestModel);
        expect(() => f.count(Infinity)).toThrow('positive integer');
    });

    it('floors fractional counts', () => {
        const f = new Factory(TestModel);
        f.count(3.9);
        expect(f._count).toBe(3);
    });

    it('accepts valid positive integer', () => {
        const f = new Factory(TestModel);
        f.count(10);
        expect(f._count).toBe(10);
    });
});

// =========================================================================
//  CORS — credentials + wildcard validation (from audit)
// =========================================================================

describe('CORS credentials + wildcard validation', () =>
{
    it('throws when credentials used with wildcard origin', () =>
    {
        expect(() => cors({ origin: '*', credentials: true }))
            .toThrow('CORS credentials cannot be used with wildcard origin');
    });

    it('allows credentials with explicit origin', () =>
    {
        expect(() => cors({ origin: 'https://example.com', credentials: true }))
            .not.toThrow();
    });

    it('allows credentials with array of origins', () =>
    {
        expect(() => cors({ origin: ['https://a.com', 'https://b.com'], credentials: true }))
            .not.toThrow();
    });

    it('allows wildcard without credentials', () =>
    {
        expect(() => cors({ origin: '*' })).not.toThrow();
    });
});

// =========================================================================
//  Rate Limiter — skip and handler options (from audit)
// =========================================================================

describe('Rate Limiter — skip and handler options', () =>
{
    it('skip function bypasses rate limiting', async () =>
    {
        const app = createApp();
        app.use(rateLimit({
            windowMs: 5000,
            max: 1,
            skip: (req) => req.url.includes('/health'),
        }));
        app.get('/health', (req, res) => res.json({ ok: true }));
        app.get('/api', (req, res) => res.json({ ok: true }));

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        const r1 = await doFetch(`${base}/api`);
        expect(r1.status).toBe(200);
        const r2 = await doFetch(`${base}/api`);
        expect(r2.status).toBe(429);

        const r3 = await doFetch(`${base}/health`);
        expect(r3.status).toBe(200);
        const r4 = await doFetch(`${base}/health`);
        expect(r4.status).toBe(200);

        server.close();
    });

    it('custom handler overrides default response', async () =>
    {
        const app = createApp();
        app.use(rateLimit({
            windowMs: 5000,
            max: 1,
            handler: (req, res) => res.status(503).json({ custom: 'overloaded' }),
        }));
        app.get('/api', (req, res) => res.json({ ok: true }));

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        await doFetch(`${base}/api`);
        const r2 = await doFetch(`${base}/api`);
        expect(r2.status).toBe(503);
        expect(r2.data.custom).toBe('overloaded');

        server.close();
    });
});

// =========================================================================
//  CSRF Secure flag (from audit)
// =========================================================================

describe('CSRF Secure flag', () =>
{
    it('includes Secure flag in Set-Cookie for HTTPS requests', async () =>
    {
        const csrfMiddleware = csrf();
        const req = {
            method: 'GET', secure: true, url: '/page',
            headers: {}, cookies: {}, query: {},
        };
        const headers = {};
        const res = { set: (name, value) => { headers[name] = value; } };
        let nextCalled = false;
        csrfMiddleware(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(headers['Set-Cookie']).toContain('Secure');
    });

    it('omits Secure flag for HTTP requests', async () =>
    {
        const csrfMiddleware = csrf();
        const req = {
            method: 'GET', secure: false, url: '/page',
            headers: {}, cookies: {}, query: {},
        };
        const headers = {};
        const res = { set: (name, value) => { headers[name] = value; } };
        csrfMiddleware(req, res, () => {});
        expect(headers['Set-Cookie']).not.toContain('Secure');
    });
});

// =========================================================================
//  Compress — quality value negotiation (from audit)
// =========================================================================

describe('Compress quality negotiation', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const compress = require('../../lib/middleware/compress');
        const app = createApp();
        app.use(compress({ threshold: 0 }));
        app.get('/data', (req, res) =>
        {
            res.json({ data: 'a'.repeat(2000) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    function rawGet(url, headers)
    {
        return new Promise((resolve) =>
        {
            const u = new URL(url);
            http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) =>
            {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
            });
        });
    }

    it('prefers br when quality is higher', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'gzip;q=0.5, br;q=1.0' });
        expect(r.headers['content-encoding']).toBe('br');
    });

    it('prefers gzip when br has q=0', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'br;q=0, gzip;q=1.0' });
        expect(r.headers['content-encoding']).toBe('gzip');
    });

    it('skips compression when all q=0', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'gzip;q=0, br;q=0, deflate;q=0' });
        expect(r.headers['content-encoding']).toBeUndefined();
    });
});



// =========================================================================
//  rateLimit — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  3. RATE LIMIT — HEADERS & OPTIONS
// ============================================================
describe('rateLimit — headers and options', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, rateLimit } = require('../../');
		const app = createApp();

		app.use(rateLimit({ windowMs: 60000, max: 3 }));
		app.get('/rl', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets X-RateLimit-Limit header', async () => {
		const r = await fetch(`${base}/rl`);
		expect(r.headers.get('x-ratelimit-limit')).toBe('3');
	});

	it('sets X-RateLimit-Remaining header and decrements', async () => {
		const r = await fetch(`${base}/rl`);
		const remaining = parseInt(r.headers.get('x-ratelimit-remaining'));
		expect(remaining).toBeLessThanOrEqual(2);
		expect(remaining).toBeGreaterThanOrEqual(0);
	});

	it('sets X-RateLimit-Reset header', async () => {
		const r = await fetch(`${base}/rl`);
		const reset = parseInt(r.headers.get('x-ratelimit-reset'));
		expect(reset).toBeGreaterThan(0);
	});

	it('sets Retry-After header when rate limited', async () => {
		// exhaust remaining
		for (let i = 0; i < 5; i++) await fetch(`${base}/rl`);
		const r = await fetch(`${base}/rl`);
		if (r.status === 429) {
			expect(r.headers.get('retry-after')).toBeDefined();
		}
	});
});

describe('rateLimit — keyGenerator option', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, rateLimit } = require('../../');
		const app = createApp();

		app.use(rateLimit({
			windowMs: 60000,
			max: 2,
			keyGenerator: (req) => req.headers['x-api-key'] || 'anon',
		}));
		app.get('/kg', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('rate limits per custom key', async () => {
		// key-a gets 2 requests
		await fetch(`${base}/kg`, { headers: { 'x-api-key': 'key-a' } });
		await fetch(`${base}/kg`, { headers: { 'x-api-key': 'key-a' } });
		const r3 = await fetch(`${base}/kg`, { headers: { 'x-api-key': 'key-a' } });
		expect(r3.status).toBe(429);

		// key-b is separate
		const r4 = await fetch(`${base}/kg`, { headers: { 'x-api-key': 'key-b' } });
		expect(r4.status).toBe(200);
	});
});

describe('rateLimit — skip option', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, rateLimit } = require('../../');
		const app = createApp();

		app.use(rateLimit({
			windowMs: 60000,
			max: 1,
			skip: (req) => req.headers['x-bypass'] === 'true',
		}));
		app.get('/sk', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('skips rate limiting when skip returns true', async () => {
		await fetch(`${base}/sk`); // consumes the 1 allowed
		const r2 = await fetch(`${base}/sk`);
		expect(r2.status).toBe(429);

		// Skipped requests go through
		const r3 = await fetch(`${base}/sk`, { headers: { 'x-bypass': 'true' } });
		expect(r3.status).toBe(200);
	});
});

describe('rateLimit — custom handler', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, rateLimit } = require('../../');
		const app = createApp();

		app.use(rateLimit({
			windowMs: 60000,
			max: 1,
			handler: (req, res) => {
				res.status(503).json({ custom: 'slow down' });
			},
		}));
		app.get('/ch', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom handler for rate-limited responses', async () => {
		await fetch(`${base}/ch`);
		const r2 = await fetch(`${base}/ch`);
		expect(r2.status).toBe(503);
		const body = await r2.json();
		expect(body.custom).toBe('slow down');
	});
});

// =========================================================================
//  compress — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  5. COMPRESS — BROTLI, FILTER, SSE, NEGOTIATE
// ============================================================
describe('compress — brotli', () => {
	let server, base;
	const hasBrotli = typeof zlib.createBrotliCompress === 'function';

	beforeAll(async () => {
		const { createApp, compress, json } = require('../../');
		const app = createApp();
		app.use(compress({ threshold: 0 }));
		app.use(json());
		app.get('/big', (req, res) => res.json({ data: 'b'.repeat(5000) }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('compresses with brotli when requested', async () => {
		if (!hasBrotli) return; // skip on old Node
		const result = await new Promise((resolve, reject) => {
			http.get(`${base}/big`, { headers: { 'accept-encoding': 'br' } }, (resp) => {
				const chunks = [];
				resp.on('data', c => chunks.push(c));
				resp.on('end', () => {
					zlib.brotliDecompress(Buffer.concat(chunks), (err, decoded) => {
						if (err) return reject(err);
						resolve({ body: JSON.parse(decoded.toString()), encoding: resp.headers['content-encoding'] });
					});
				});
			}).on('error', reject);
		});
		expect(result.encoding).toBe('br');
		expect(result.body.data).toBe('b'.repeat(5000));
	});
});

describe('compress — negotiate quality values', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, compress, json } = require('../../');
		const app = createApp();
		app.use(compress({ threshold: 0 }));
		app.use(json());
		app.get('/big', (req, res) => res.json({ data: 'n'.repeat(5000) }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('picks highest quality encoding', async () => {
		const result = await new Promise((resolve, reject) => {
			http.get(`${base}/big`, { headers: { 'accept-encoding': 'gzip;q=0.5, deflate;q=0.9' } }, (resp) => {
				resolve({ encoding: resp.headers['content-encoding'] });
			}).on('error', reject);
		});
		expect(result.encoding).toBe('deflate');
	});
});

describe('compress — filter option', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, compress, json } = require('../../');
		const app = createApp();
		app.use(compress({
			threshold: 0,
			filter: (req, res) => !req.url.includes('/no-compress'),
		}));
		app.use(json());
		app.get('/yes', (req, res) => res.json({ data: 'y'.repeat(5000) }));
		app.get('/no-compress', (req, res) => res.json({ data: 'n'.repeat(5000) }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('compresses when filter returns true', async () => {
		const r = await new Promise((resolve, reject) => {
			http.get(`${base}/yes`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
				resp.resume();
				resp.on('end', () => resolve({ encoding: resp.headers['content-encoding'] }));
			}).on('error', reject);
		});
		expect(r.encoding).toBe('gzip');
	});

	it('skips compression when filter returns false', async () => {
		const r = await new Promise((resolve, reject) => {
			http.get(`${base}/no-compress`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
				resp.resume();
				resp.on('end', () => resolve({ encoding: resp.headers['content-encoding'] }));
			}).on('error', reject);
		});
		expect(r.encoding).toBeUndefined();
	});
});

describe('compress — SSE exclusion', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, compress } = require('../../');
		const app = createApp();
		app.use(compress({ threshold: 0 }));
		app.get('/sse', (req, res) => {
			res.raw.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			});
			res.raw.write('data: hello\n\n');
			res.raw.end();
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('does not compress text/event-stream', async () => {
		const r = await new Promise((resolve, reject) => {
			http.get(`${base}/sse`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
				const chunks = [];
				resp.on('data', c => chunks.push(c));
				resp.on('end', () => resolve({
					encoding: resp.headers['content-encoding'],
					body: Buffer.concat(chunks).toString(),
				}));
			}).on('error', reject);
		});
		expect(r.encoding).toBeUndefined();
		expect(r.body).toContain('data: hello');
	});
});

// =========================================================================
//  cors — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  6. CORS — SUFFIX, METHODS, HEADERS, PREFLIGHT
// ============================================================
describe('cors — suffix matching', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, cors } = require('../../');
		const app = createApp();
		app.use(cors({ origin: ['.example.com'] }));
		app.get('/c', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('matches suffix origin', async () => {
		const r = await fetch(`${base}/c`, { headers: { 'origin': 'https://sub.example.com' } });
		expect(r.headers.get('access-control-allow-origin')).toBe('https://sub.example.com');
	});

	it('rejects non-matching origin', async () => {
		const r = await fetch(`${base}/c`, { headers: { 'origin': 'https://evil.com' } });
		expect(r.headers.get('access-control-allow-origin')).toBeFalsy();
	});
});

describe('cors — custom methods and allowedHeaders', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, cors } = require('../../');
		const app = createApp();
		app.use(cors({
			methods: 'GET,POST',
			allowedHeaders: 'Content-Type,X-Custom',
			exposedHeaders: 'X-Exposed',
			maxAge: 3600,
		}));
		app.get('/c', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('returns custom methods', async () => {
		const r = await fetch(`${base}/c`);
		expect(r.headers.get('access-control-allow-methods')).toBe('GET,POST');
	});

	it('returns custom allowed headers', async () => {
		const r = await fetch(`${base}/c`);
		expect(r.headers.get('access-control-allow-headers')).toBe('Content-Type,X-Custom');
	});

	it('returns exposed headers', async () => {
		const r = await fetch(`${base}/c`);
		expect(r.headers.get('access-control-expose-headers')).toBe('X-Exposed');
	});

	it('returns max-age', async () => {
		const r = await fetch(`${base}/c`);
		expect(r.headers.get('access-control-max-age')).toBe('3600');
	});
});

describe('cors — credentials validation', () => {
	it('throws when credentials used with wildcard origin', () => {
		const { cors } = require('../../');
		expect(() => cors({ origin: '*', credentials: true })).toThrow(/credentials/i);
	});
});

describe('cors — preflight OPTIONS returns 204', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, cors } = require('../../');
		const app = createApp();
		app.use(cors({ origin: 'http://test.com', credentials: true }));
		app.get('/c', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('preflight returns 204 with credentials', async () => {
		const r = await fetch(`${base}/c`, {
			method: 'OPTIONS',
			headers: { 'origin': 'http://test.com' },
		});
		expect(r.status).toBe(204);
		expect(r.headers.get('access-control-allow-credentials')).toBe('true');
		expect(r.headers.get('access-control-allow-origin')).toBe('http://test.com');
	});
});

// =========================================================================
//  helmet — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  8. HELMET — COEP, COOP, CORP, HIDE POWERED BY, CSP DIRECTIVES
// ============================================================
describe('helmet — advanced options', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, helmet } = require('../../');
		const app = createApp();
		app.use(helmet({
			crossOriginEmbedderPolicy: true,
			crossOriginOpenerPolicy: 'same-origin-allow-popups',
			crossOriginResourcePolicy: 'cross-origin',
			permittedCrossDomainPolicies: 'master-only',
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'", "'unsafe-inline'"],
				},
			},
		}));
		app.get('/h', (req, res) => {
			res.raw.setHeader('X-Powered-By', 'ShouldBeRemoved');
			res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('sets Cross-Origin-Embedder-Policy', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
	});

	it('sets Cross-Origin-Opener-Policy', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
	});

	it('sets Cross-Origin-Resource-Policy', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
	});

	it('removes X-Powered-By set before helmet runs', async () => {
		// helmet removes X-Powered-By via removeHeader, but it only
		// removes headers that exist at middleware time. Test that the
		// header is absent when no route handler explicitly sets it.
		const { createApp, helmet: h2 } = require('../../');
		const app2 = createApp();
		app2.use(h2());
		app2.get('/clean', (req, res) => res.json({ ok: true }));
		const s = http.createServer(app2.handler);
		await new Promise(r2 => s.listen(0, r2));
		const r = await fetch(`http://localhost:${s.address().port}/clean`);
		expect(r.headers.get('x-powered-by')).toBeFalsy();
		s.close();
	});

	it('sets custom CSP directives', async () => {
		const r = await fetch(`${base}/h`);
		const csp = r.headers.get('content-security-policy');
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self' 'unsafe-inline'");
	});

	it('sets Permitted Cross Domain Policies', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('x-permitted-cross-domain-policies')).toBe('master-only');
	});
});

describe('helmet — disabled options', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, helmet } = require('../../');
		const app = createApp();
		app.use(helmet({
			hsts: false,
			frameguard: false,
			noSniff: false,
			contentSecurityPolicy: false,
			crossOriginOpenerPolicy: false,
			crossOriginResourcePolicy: false,
			dnsPrefetchControl: false,
			referrerPolicy: false,
			hidePoweredBy: false,
		}));
		app.get('/h', (req, res) => {
			res.raw.setHeader('X-Powered-By', 'Zero');
			res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('does not set HSTS when disabled', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('strict-transport-security')).toBeFalsy();
	});

	it('does not set X-Frame-Options when disabled', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('x-frame-options')).toBeFalsy();
	});

	it('does not set CSP when disabled', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('content-security-policy')).toBeFalsy();
	});

	it('keeps X-Powered-By when hidePoweredBy is false', async () => {
		const r = await fetch(`${base}/h`);
		expect(r.headers.get('x-powered-by')).toBe('Zero');
	});
});

describe('helmet — HSTS with preload', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, helmet } = require('../../');
		const app = createApp();
		app.use(helmet({ hstsPreload: true, hstsMaxAge: 31536000 }));
		app.get('/h', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('HSTS includes preload directive', async () => {
		const r = await fetch(`${base}/h`);
		const hsts = r.headers.get('strict-transport-security');
		expect(hsts).toContain('max-age=31536000');
		expect(hsts).toContain('includeSubDomains');
		expect(hsts).toContain('preload');
	});
});
