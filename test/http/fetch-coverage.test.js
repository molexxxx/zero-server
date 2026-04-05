/**
 * Coverage tests for lib/fetch/index.js
 * Targets uncovered branches: body normalisation (ArrayBuffer, Uint8Array,
 * object, string, stream, fallback), agent option, headers.get edge cases,
 * EventEmitter-style AbortSignal, upload progress, stream error, json() failure,
 * invalid URL, and HTTPS/TLS pass-through.
 */

const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fetch = require('../../lib/fetch');

// --- helpers ------------------------------------------------------------------
/** Create a simple HTTP echo server that captures request details */
function createEchoServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'x-received-ct': req.headers['content-type'] || '',
                    'x-received-cl': req.headers['content-length'] || '',
                    'x-method': req.method,
                });
                res.end(JSON.stringify({ length: body.length, body: body.toString() }));
            });
        });
        server.listen(0, () => resolve(server));
    });
}

// --- body normalisation ------------------------------------------------------
describe('fetch — body normalisation', () => {
    let server, base;
    beforeAll(async () => { server = await createEchoServer(); base = `http://localhost:${server.address().port}`; });
    afterAll(() => server?.close());

    it('auto-serialises plain object to JSON with Content-Type', async () => {
        const r = await fetch(`${base}/`, { method: 'POST', body: { foo: 'bar' } });
        expect(r.ok).toBe(true);
        const ct = r.headers.get('x-received-ct');
        expect(ct).toContain('application/json');
        const data = await r.json();
        expect(JSON.parse(data.body)).toEqual({ foo: 'bar' });
    });

    it('skips auto Content-Type for object when Content-Type is pre-set', async () => {
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: { a: 1 },
            headers: { 'Content-Type': 'text/plain' },
        });
        expect(r.headers.get('x-received-ct')).toBe('text/plain');
    });

    it('skips auto Content-Type for URLSearchParams when content-type pre-set', async () => {
        const params = new URLSearchParams({ x: '1' });
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: params,
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.headers.get('x-received-ct')).toBe('text/plain');
    });

    it('handles ArrayBuffer body', async () => {
        const ab = new ArrayBuffer(4);
        new Uint8Array(ab).set([1, 2, 3, 4]);
        const r = await fetch(`${base}/`, { method: 'POST', body: ab });
        const data = await r.json();
        expect(data.length).toBe(4);
    });

    it('handles Uint8Array body', async () => {
        const u8 = new Uint8Array([10, 20, 30]);
        const r = await fetch(`${base}/`, { method: 'POST', body: u8 });
        const data = await r.json();
        expect(data.length).toBe(3);
    });

    it('sends string body with correct Content-Length', async () => {
        const str = 'hello fetch';
        const r = await fetch(`${base}/`, { method: 'POST', body: str });
        expect(r.headers.get('x-received-cl')).toBe(String(Buffer.byteLength(str)));
    });

    it('handles non-buffer non-stream non-string truthy body (number)', async () => {
        const r = await fetch(`${base}/`, { method: 'POST', body: 42 });
        const data = await r.json();
        expect(data.body).toBe('42');
    });

    it('sends null body (req.end immediately)', async () => {
        const r = await fetch(`${base}/`, { method: 'POST', body: null });
        const data = await r.json();
        expect(data.length).toBe(0);
    });
});

// --- stream body -------------------------------------------------------------
describe('fetch — stream body', () => {
    let server, base;
    beforeAll(async () => { server = await createEchoServer(); base = `http://localhost:${server.address().port}`; });
    afterAll(() => server?.close());

    it('pipes a readable stream as body', async () => {
        const stream = new Readable({ read() { this.push('streamed'); this.push(null); } });
        const r = await fetch(`${base}/`, { method: 'POST', body: stream });
        const data = await r.json();
        expect(data.body).toBe('streamed');
    });

    it('calls onUploadProgress during stream upload', async () => {
        const progress = [];
        const stream = new Readable({
            read() {
                this.push(Buffer.alloc(64, 'x'));
                this.push(null);
            }
        });
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: stream,
            onUploadProgress: p => progress.push(p),
        });
        expect(r.ok).toBe(true);
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(progress[0].loaded).toBeGreaterThan(0);
    });

    it('destroys request on stream error', async () => {
        const stream = new Readable({
            read() {
                process.nextTick(() => this.destroy(new Error('stream boom')));
            }
        });
        await expect(fetch(`${base}/`, { method: 'POST', body: stream }))
            .rejects.toThrow('stream boom');
    });
});

// --- upload progress with buffer body ----------------------------------------
describe('fetch — upload progress (buffer)', () => {
    let server, base;
    beforeAll(async () => { server = await createEchoServer(); base = `http://localhost:${server.address().port}`; });
    afterAll(() => server?.close());

    it('calls onUploadProgress for buffer body', async () => {
        const progress = [];
        const buf = Buffer.alloc(128, 'y');
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: buf,
            onUploadProgress: p => progress.push(p),
        });
        expect(r.ok).toBe(true);
        expect(progress.length).toBeGreaterThanOrEqual(1);
        const last = progress[progress.length - 1];
        expect(last.loaded).toBe(128);
        expect(last.total).toBe(128);
    });
});

// --- agent option ------------------------------------------------------------
describe('fetch — agent option', () => {
    let server, base;
    beforeAll(async () => { server = await createEchoServer(); base = `http://localhost:${server.address().port}`; });
    afterAll(() => server?.close());

    it('passes agent to request options', async () => {
        const agent = new http.Agent({ keepAlive: false });
        const r = await fetch(`${base}/`, { agent });
        expect(r.ok).toBe(true);
        agent.destroy();
    });
});

// --- response headers edge cases ---------------------------------------------
describe('fetch — response headers', () => {
    let server, base;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            // Write duplicate header to produce array value
            res.writeHead(200, [
                ['x-multi', 'a'],
                ['x-multi', 'b'],
                ['content-type', 'text/plain'],
            ]);
            res.end('ok');
        });
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('headers.get(null) returns undefined', async () => {
        const r = await fetch(`${base}/`);
        expect(r.headers.get(null)).toBeUndefined();
    });

    it('headers.get() returns undefined for missing name', async () => {
        const r = await fetch(`${base}/`);
        expect(r.headers.get()).toBeUndefined();
    });

    it('joins array header values with comma', async () => {
        const r = await fetch(`${base}/`);
        const v = r.headers.get('x-multi');
        expect(v).toBe('a, b');
    });
});

// --- json() error path ------------------------------------------------------
describe('fetch — json() parse failure', () => {
    let server, base;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('not-json!!!');
        });
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('json() rejects on invalid JSON', async () => {
        const r = await fetch(`${base}/`);
        await expect(r.json()).rejects.toThrow();
    });
});

// --- invalid URL -------------------------------------------------------------
describe('fetch — invalid URL', () => {
    it('rejects with error for malformed URL', async () => {
        await expect(fetch('not-a-valid-url')).rejects.toThrow();
    });
});

// --- EventEmitter-style AbortSignal ------------------------------------------
describe('fetch — EventEmitter signal', () => {
    let server, base;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            setTimeout(() => { res.writeHead(200); res.end('ok'); }, 5000);
        });
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('supports signal with .on/.off (EventEmitter style)', async () => {
        const signal = new EventEmitter();
        signal.aborted = false;
        const p = fetch(`${base}/`, { signal });
        setTimeout(() => {
            signal.aborted = true;
            signal.emit('abort');
        }, 50);
        await expect(p).rejects.toThrow();
    });

    it('supports pre-aborted EventEmitter signal', async () => {
        const signal = new EventEmitter();
        signal.aborted = true;
        await expect(fetch(`${base}/`, { signal })).rejects.toThrow();
    });
});

// --- HTTPS / TLS pass-through ------------------------------------------------
describe('fetch — HTTPS with TLS options', () => {
    let server, base, key, cert;

    beforeAll(async () => {
        // Generate self-signed certificate
        const keys = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        key = keys.privateKey;

        // Create self-signed cert using the generated key
        const csr = crypto.createSign('SHA256');
        // Use execSync approach to generate a self-signed cert
        // Since Node.js doesn't have built-in cert generation,
        // we'll use a TLS server with the keypair as a workaround
        // by generating a self-signed certificate via child_process
        try {
            const fs = require('fs');
            const path = require('path');
            const { execSync } = require('child_process');
            const tmpDir = path.join(__dirname, '..', '..', 'coverage');
            const keyPath = path.join(tmpDir, '_test.key');
            const certPath = path.join(tmpDir, '_test.crt');

            fs.writeFileSync(keyPath, key);
            execSync(`openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=localhost" -batch`, { stdio: 'pipe' });
            cert = fs.readFileSync(certPath, 'utf8');
            fs.unlinkSync(keyPath);
            fs.unlinkSync(certPath);
        } catch (e) {
            // openssl not available — skip HTTPS tests
            return;
        }

        server = https.createServer({ key, cert }, (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('secure');
        });
        await new Promise(r => server.listen(0, r));
        base = `https://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('fetches from HTTPS server with rejectUnauthorized=false', async () => {
        if (!server) return; // skip if no openssl
        const r = await fetch(`${base}/`, { rejectUnauthorized: false });
        expect(r.ok).toBe(true);
        expect(r.secure).toBe(true);
        const body = await r.text();
        expect(body).toBe('secure');
    });

    it('passes TLS options (ca, servername) to https.request', async () => {
        if (!server) return;
        const r = await fetch(`${base}/`, {
            rejectUnauthorized: false,
            ca: cert,
            servername: 'localhost',
        });
        expect(r.ok).toBe(true);
    });
});

// --- download progress with no content-length --------------------------------
describe('fetch — download progress without content-length', () => {
    let server, base;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            // Omit Content-Length so total = null
            res.writeHead(200);
            res.end('data');
        });
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('reports total as null when content-length is absent', async () => {
        const progress = [];
        await fetch(`${base}/`, { onDownloadProgress: p => progress.push(p) });
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(progress[0].total).toBeNull();
    });
});

// --- onDownloadProgress / onUploadProgress error swallowing ------------------
describe('fetch — progress callback errors are swallowed', () => {
    let server, base;
    beforeAll(async () => { server = await createEchoServer(); base = `http://localhost:${server.address().port}`; });
    afterAll(() => server?.close());

    it('swallows onDownloadProgress throw', async () => {
        const r = await fetch(`${base}/`, {
            onDownloadProgress: () => { throw new Error('boom'); },
        });
        expect(r.ok).toBe(true);
    });

    it('swallows onUploadProgress throw for buffer body', async () => {
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: Buffer.from('abc'),
            onUploadProgress: () => { throw new Error('boom'); },
        });
        expect(r.ok).toBe(true);
    });

    it('swallows onUploadProgress throw for stream body', async () => {
        const s = new Readable({ read() { this.push('x'); this.push(null); } });
        const r = await fetch(`${base}/`, {
            method: 'POST',
            body: s,
            onUploadProgress: () => { throw new Error('boom'); },
        });
        expect(r.ok).toBe(true);
    });
});
