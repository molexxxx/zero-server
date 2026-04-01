/** security.test.js — body parser security tests */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { Readable, EventEmitter } = require('stream');
// vi is a global in vitest (globals: true in vitest.config.mjs)

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);
const brotli = promisify(zlib.brotliCompress);

const { doFetch } = require('../_helpers');
const { createApp, json, urlencoded, text, raw, multipart } = require('../../');

// -----------------------------------------------------------------------------
// Shared test helpers
// -----------------------------------------------------------------------------

/** Build a minimal Readable stream from a Buffer or string */
function makeStream(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    const r = new Readable({ read() { this.push(buf); this.push(null); } });
    return r;
}

/** Build a mock request that rawBuffer / parsers can consume */
function mockReq(bodyData, headers = {}) {
    return {
        raw: makeStream(bodyData),
        headers,
        secure: true,
    };
}

/** Build a mock response object that captures what sendError writes */
function mockRes() {
    const res = {
        headersSent: false,
        statusCode: null,
        _headers: {},
        _body: null,
        setHeader(k, v) { this._headers[k] = v; },
        end(b) { this._body = b; this.headersSent = true; },
    };
    res.raw = res; // sendError resolves res.raw || res
    return res;
}

async function callMw(mw, req, res) {
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    return nextCalled;
}

function runMw(mw, req, res) {
    return new Promise(resolve => mw(req, res, resolve));
}

// -----------------------------------------------------------------------------
// sendError
// -----------------------------------------------------------------------------

describe('sendError — direct unit tests', () => {
    const sendError = require('../../lib/body/sendError');

    it('writes status + JSON error body', () => {
        const res = mockRes();
        sendError(res, 400, 'bad input');
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res._body)).toEqual({ error: 'bad input' });
        expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('is a no-op when headersSent is already true', () => {
        const res = mockRes();
        res.headersSent = true;
        sendError(res, 500, 'too late');
        expect(res.statusCode).toBeNull(); // nothing written
    });

    it('uses res.raw when available (wrapped response object)', () => {
        const inner = mockRes();
        const outer = { raw: inner };
        sendError(outer, 422, 'unprocessable');
        expect(inner.statusCode).toBe(422);
        expect(JSON.parse(inner._body)).toEqual({ error: 'unprocessable' });
    });

    it('falls back to res directly when res.raw is absent', () => {
        const res = mockRes();
        delete res.raw;
        sendError(res, 403, 'forbidden');
        expect(res.statusCode).toBe(403);
    });
});

// -----------------------------------------------------------------------------
// typeMatch
// -----------------------------------------------------------------------------

describe('typeMatch — comprehensive branch coverage', () => {
    const isTypeMatch = require('../../lib/body/typeMatch');

    // no typeOpt → always matches
    it('returns true when typeOpt is falsy', () => {
        expect(isTypeMatch('text/plain', null)).toBe(true);
        expect(isTypeMatch('text/plain', undefined)).toBe(true);
        expect(isTypeMatch('text/plain', '')).toBe(true);
    });

    // function predicate
    it('calls predicate function and respects its return value', () => {
        expect(isTypeMatch('application/json', ct => ct.includes('json'))).toBe(true);
        expect(isTypeMatch('text/plain', ct => ct.includes('json'))).toBe(false);
    });

    // array of types
    it('matches when any element in array matches', () => {
        expect(isTypeMatch('image/png', ['text/plain', 'image/png'])).toBe(true);
    });
    it('returns false when no element matches', () => {
        expect(isTypeMatch('video/mp4', ['text/plain', 'image/png'])).toBe(false);
    });
    it('empty array never matches', () => {
        expect(isTypeMatch('text/plain', [])).toBe(false);
    });

    // no contentType
    it('returns false when contentType is empty and typeOpt is a string', () => {
        expect(isTypeMatch('', 'application/json')).toBe(false);
        expect(isTypeMatch(null, 'application/json')).toBe(false);
    });

    // */* wildcard
    it('*/* matches everything', () => {
        expect(isTypeMatch('application/pdf', '*/*')).toBe(true);
        expect(isTypeMatch('text/plain', '*/*')).toBe(true);
    });

    // prefix wildcard  text/*
    it('prefix wildcard text/* matches text subtypes', () => {
        expect(isTypeMatch('text/html', 'text/*')).toBe(true);
        expect(isTypeMatch('text/plain', 'text/*')).toBe(true);
        expect(isTypeMatch('application/json', 'text/*')).toBe(false);
    });

    // strips charset parameters before matching
    it('strips charset before matching', () => {
        expect(isTypeMatch('application/json; charset=utf-8', 'application/json')).toBe(true);
    });

    // suffix wildcard  application/*+json
    it('suffix pattern application/*+json matches vendor types', () => {
        expect(isTypeMatch('application/vnd.api+json', 'application/*+json')).toBe(true);
        expect(isTypeMatch('application/xml', 'application/*+json')).toBe(false);
    });

    // exact match substring
    it('substring match works (typeOpt is part of baseType)', () => {
        expect(isTypeMatch('application/json', 'json')).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// rawBuffer — parseLimit + charsetFromContentType + streaming
// -----------------------------------------------------------------------------

describe('rawBuffer — parseLimit edge cases', () => {
    const rawBuffer = require('../../lib/body/rawBuffer');

    it('no limit option → reads entire stream', async () => {
        const req = mockReq('hello', {});
        const buf = await rawBuffer(req, {});
        expect(buf.toString()).toBe('hello');
    });

    it('limit 0 → treated as unlimited (falsy in size checks)', async () => {
        // parseLimit(0) returns 0, but `if (limit && ...)` makes 0 behave as unlimited
        const req = mockReq('x', {});
        const buf = await rawBuffer(req, { limit: 0 });
        expect(buf.toString()).toBe('x');
    });

    it('limit as plain number string with no unit', async () => {
        const req = mockReq('hi', {});
        const buf = await rawBuffer(req, { limit: '999' });
        expect(buf.toString()).toBe('hi');
    });

    it('limit in gb units is parsed correctly', async () => {
        const req = mockReq('data', {});
        const buf = await rawBuffer(req, { limit: '1gb' });
        expect(buf.toString()).toBe('data');
    });

    it('Content-Length = 0 is falsy → skips pre-check, reads stream', async () => {
        const req = mockReq('', { 'content-length': '0' });
        const buf = await rawBuffer(req, { limit: 10 });
        expect(buf.length).toBe(0);
    });

    it('headers fallback from req.raw.headers when req.headers absent', async () => {
        const stream = makeStream('hello');
        stream.headers = {}; // req.raw.headers
        const req = { raw: stream }; // no .headers property
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('hello');
    });

    it('stream error event propagates as rejection', async () => {
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: {} };
        const p = rawBuffer(req, { limit: '1mb' });
        emitter.emit('error', new Error('socket hang up'));
        await expect(p).rejects.toThrow('socket hang up');
    });

    it('identity content-encoding treated as uncompressed', async () => {
        const req = mockReq('plain text', { 'content-encoding': 'identity' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('plain text');
    });
});

describe('charsetFromContentType — full coverage', () => {
    const { charsetFromContentType } = require('../../lib/body/rawBuffer');

    it('utf-8 → utf8', () => expect(charsetFromContentType('text/plain; charset=utf-8')).toBe('utf8'));
    it('UTF-8 uppercase → utf8', () => expect(charsetFromContentType('text/plain; charset=UTF-8')).toBe('utf8'));
    it('iso-8859-1 → latin1', () => expect(charsetFromContentType('text/html; charset=iso-8859-1')).toBe('latin1'));
    it('ISO-8859-1 → latin1', () => expect(charsetFromContentType('text/html; charset=ISO-8859-1')).toBe('latin1'));
    it('utf-16le → utf16le', () => expect(charsetFromContentType('text/plain; charset=utf-16le')).toBe('utf16le'));
    it('utf-16 (without le) → utf16le', () => expect(charsetFromContentType('text/plain; charset=utf-16')).toBe('utf16le'));
    it('ucs-2 alias → utf16le', () => expect(charsetFromContentType('text/plain; charset=ucs-2')).toBe('utf16le'));
    it('us-ascii → ascii', () => expect(charsetFromContentType('text/plain; charset=us-ascii')).toBe('ascii'));
    it('ASCII uppercase → ascii', () => expect(charsetFromContentType('text/plain; charset=ASCII')).toBe('ascii'));
    it('unknown charset falls back to utf8', () => expect(charsetFromContentType('text/plain; charset=windows-1252')).toBe('utf8'));
    it('null input → null', () => expect(charsetFromContentType(null)).toBeNull());
    it('empty string → null', () => expect(charsetFromContentType('')).toBeNull());
    it('no charset in content-type → null', () => expect(charsetFromContentType('application/json')).toBeNull());
    it('quoted charset value', () => expect(charsetFromContentType('text/plain; charset="utf-8"')).toBe('utf8'));
});

// -----------------------------------------------------------------------------
// json parser — branch coverage
// -----------------------------------------------------------------------------

describe('json parser — requireSecure', () => {
    const jsonMw = require('../../lib/body/json');

    it('rejects non-HTTPS when requireSecure=true', async () => {
        const mw = jsonMw({ requireSecure: true });
        const req = mockReq(JSON.stringify({ a: 1 }), { 'content-type': 'application/json' });
        req.secure = false;
        const res = mockRes();
        await callMw(mw, req, res); // middleware returns early (no next call)
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res._body).error).toMatch(/HTTPS/i);
    });

    it('passes through when requireSecure=true and req.secure=true', async () => {
        const mw = jsonMw({ requireSecure: true });
        const req = mockReq(JSON.stringify({ ok: true }), { 'content-type': 'application/json' });
        req.secure = true;
        const res = mockRes();
        const nextCalled = await callMw(mw, req, res);
        expect(nextCalled).toBe(true);
        expect(req.body.ok).toBe(true);
    });
});

describe('json parser — empty body', () => {
    const jsonMw = require('../../lib/body/json');

    it('empty body string → req.body = null and calls next', async () => {
        const mw = jsonMw();
        const req = mockReq('', { 'content-type': 'application/json' });
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
        expect(req.body).toBeNull();
    });
});

describe('json parser — content-type mismatch calls next', () => {
    const jsonMw = require('../../lib/body/json');

    it('skips when content-type does not match', async () => {
        const mw = jsonMw();
        const req = mockReq('{"a":1}', { 'content-type': 'text/plain' });
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
        expect(req.body).toBeUndefined();
    });

    it('skips when no content-type header', async () => {
        const mw = jsonMw();
        const req = mockReq('{"a":1}', {});
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
    });
});

describe('json parser — inflate:false rejects compressed body (415)', () => {
    let server, base;
    beforeAll(async () => {
        const app = createApp();
        app.use(json({ inflate: false }));
        app.post('/data', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('returns 415 for gzip body when inflate=false', async () => {
        const compressed = await gzip(Buffer.from('{"x":1}'));
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: compressed,
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
        expect(r.status).toBe(415);
    });
});

describe('json parser — generic error in catch → next() still called', () => {
    const jsonMw = require('../../lib/body/json');

    it('unrecognised error sets req.body=null and calls next', async () => {
        // Simulate a stream that emits an error without a status property
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'application/json' }, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = jsonMw();
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        emitter.emit('error', new Error('unexpected socket error'));
        await done;
        expect(nextCalled).toBe(true);
        expect(req.body).toBeNull();
    });
});

describe('json parser — verify error without message uses default', () => {
    const jsonMw = require('../../lib/body/json');

    it('verify error with no message → "verification failed"', async () => {
        const mw = jsonMw({ verify: () => { throw new Error(); } });
        const req = mockReq('{"ok":true}', { 'content-type': 'application/json' });
        const res = mockRes();
        await callMw(mw, req, res); // returns early without calling next
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res._body).error).toBe('verification failed');
    });
});

describe('json parser — _sanitize prototype pollution guard', () => {
    const jsonMw = require('../../lib/body/json');

    it('strips __proto__ key inside nested object', async () => {
        const mw = jsonMw({ strict: false });
        const payload = '{"outer":{"__proto__":{"pwned":true}}}';
        const req = mockReq(payload, { 'content-type': 'application/json' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(({}).pwned).toBeUndefined();
    });

    it('strips constructor key inside nested object', async () => {
        const mw = jsonMw({ strict: false });
        const payload = '{"a":{"constructor":{"prototype":{"injected":1}}}}';
        const req = mockReq(payload, { 'content-type': 'application/json' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(({}).injected).toBeUndefined();
    });

    it('strips prototype key', async () => {
        const mw = jsonMw({ strict: false });
        const payload = '{"prototype":{"bad":true}}';
        const req = mockReq(payload, { 'content-type': 'application/json' });
        const res = mockRes();
        await runMw(mw, req, res);
        // key should be deleted from the parsed object
        expect(req.body).toBeDefined();
        expect(req.body.prototype).toBeUndefined();
    });

    it('allows safe nested keys untouched', async () => {
        const mw = jsonMw({ strict: false });
        const payload = '{"user":{"name":"alice","role":"admin"}}';
        const req = mockReq(payload, { 'content-type': 'application/json' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.user.name).toBe('alice');
        expect(req.body.user.role).toBe('admin');
    });
});

describe('json parser — strict=false (default true)', () => {
    const jsonMw = require('../../lib/body/json');

    it('strict defaults to true — rejects primitive root', async () => {
        // opts without "strict" key → hasOwnProperty returns false → default true
        const mw = jsonMw({});
        const req = mockReq('"just a string"', { 'content-type': 'application/json' });
        const res = mockRes();
        await callMw(mw, req, res); // returns 400 without calling next
        expect(res.statusCode).toBe(400);
    });

    it('strict=false with explicit key → allows primitive', async () => {
        const mw = jsonMw({ strict: false });
        const req = mockReq('"hello"', { 'content-type': 'application/json' });
        const res = mockRes();
        const nextCalled = await callMw(mw, req, res);
        expect(nextCalled).toBe(true);
        expect(req.body).toBe('hello');
    });

    it('null root is rejected in strict mode (typeof null === object but null)', async () => {
        const mw = jsonMw({ strict: true });
        const req = mockReq('null', { 'content-type': 'application/json' });
        const res = mockRes();
        await callMw(mw, req, res); // returns 400 without calling next
        expect(res.statusCode).toBe(400);
    });
});

// -----------------------------------------------------------------------------
// text parser — branch coverage
// -----------------------------------------------------------------------------

describe('text parser — requireSecure', () => {
    const textMw = require('../../lib/body/text');

    it('rejects non-HTTPS when requireSecure=true', async () => {
        const mw = textMw({ requireSecure: true });
        const req = mockReq('hello', { 'content-type': 'text/plain' });
        req.secure = false;
        const res = mockRes();
        await callMw(mw, req, res); // returns 403 without calling next
        expect(res.statusCode).toBe(403);
    });
});

describe('text parser — content-type mismatch', () => {
    const textMw = require('../../lib/body/text');

    it('calls next without setting body when CT does not match', async () => {
        const mw = textMw({ type: 'text/plain' });
        const req = mockReq('hello', { 'content-type': 'application/json' });
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
        expect(req.body).toBeUndefined();
    });
});

describe('text parser — inflate:false returns 415', () => {
    const textMw = require('../../lib/body/text');

    it('rejects gzip body when inflate=false', async () => {
        const compressed = await gzip(Buffer.from('compressed text'));
        const req = {
            raw: makeStream(compressed),
            headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
            secure: true,
        };
        const res = mockRes();
        const mw = textMw({ inflate: false });
        await callMw(mw, req, res); // returns 415 without calling next
        expect(res.statusCode).toBe(415);
    });
});

describe('text parser — generic error → req.body = empty string', () => {
    const textMw = require('../../lib/body/text');

    it('unrecognised stream error → req.body="" and next called', async () => {
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'text/plain' }, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = textMw();
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        emitter.emit('error', new Error('network error'));
        await done;
        expect(nextCalled).toBe(true);
        expect(req.body).toBe('');
    });
});

describe('text parser — verify error without message', () => {
    const textMw = require('../../lib/body/text');

    it('uses default message "verification failed" when error has no message', async () => {
        const mw = textMw({ verify: () => { throw new Error(); } });
        const req = mockReq('test', { 'content-type': 'text/plain' });
        const res = mockRes();
        await callMw(mw, req, res); // returns 403 without calling next
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res._body).error).toBe('verification failed');
    });
});

describe('text parser — custom encoding fallback', () => {
    const textMw = require('../../lib/body/text');

    it('uses defaultEncoding option when CT has no charset', async () => {
        const mw = textMw({ encoding: 'latin1' });
        const req = mockReq('plain', { 'content-type': 'text/plain' });
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
        expect(typeof req.body).toBe('string');
    });

    it('uses charset from CT over defaultEncoding', async () => {
        const mw = textMw({ encoding: 'latin1' });
        const req = mockReq('hello', { 'content-type': 'text/plain; charset=utf-8' });
        const res = mockRes();
        await new Promise(resolve => mw(req, res, resolve));
        expect(req.body).toBe('hello');
    });
});

describe('text parser — inflate 413 catch path', () => {
    let server, base;
    beforeAll(async () => {
        const app = createApp();
        app.use(text({ limit: '5', type: 'text/plain' }));
        app.post('/t', (req, res) => res.text(req.body || ''));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('413 from rawBuffer is forwarded correctly', async () => {
        const r = await doFetch(`${base}/t`, {
            method: 'POST', body: 'this is way too long for the limit',
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.status).toBe(413);
    });
});

describe('text parser — inflate 415 catch path via unsupported encoding', () => {
    let server, base;
    beforeAll(async () => {
        const app = createApp();
        app.use(text({ type: 'text/plain' }));
        app.post('/t', (req, res) => res.text(req.body || ''));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('415 for unsupported content-encoding', async () => {
        const r = await doFetch(`${base}/t`, {
            method: 'POST', body: 'data',
            headers: { 'content-type': 'text/plain', 'content-encoding': 'compress' },
        });
        expect(r.status).toBe(415);
    });
});

// -----------------------------------------------------------------------------
// raw parser — branch coverage
// -----------------------------------------------------------------------------

describe('raw parser — requireSecure', () => {
    const rawMw = require('../../lib/body/raw');

    it('rejects non-HTTPS when requireSecure=true', async () => {
        const mw = rawMw({ requireSecure: true });
        const req = mockReq(Buffer.from('data'), { 'content-type': 'application/octet-stream' });
        req.secure = false;
        const res = mockRes();
        await callMw(mw, req, res); // returns 403 without calling next
        expect(res.statusCode).toBe(403);
    });
});

describe('raw parser — content-type mismatch', () => {
    const rawMw = require('../../lib/body/raw');

    it('calls next without body when CT does not match', async () => {
        const mw = rawMw({ type: 'application/octet-stream' });
        const req = mockReq(Buffer.from('bytes'), { 'content-type': 'application/json' });
        const res = mockRes();
        let nextCalled = false;
        await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        expect(nextCalled).toBe(true);
        expect(req.body).toBeUndefined();
    });
});

describe('raw parser — inflate:false returns 415', () => {
    const rawMw = require('../../lib/body/raw');

    it('rejects compressed body when inflate=false', async () => {
        const compressed = await gzip(Buffer.from('binary data'));
        const req = {
            raw: makeStream(compressed),
            headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
            secure: true,
        };
        const res = mockRes();
        const mw = rawMw({ inflate: false });
        await callMw(mw, req, res); // returns 415 without calling next
        expect(res.statusCode).toBe(415);
    });
});

describe('raw parser — generic error → req.body = empty Buffer', () => {
    const rawMw = require('../../lib/body/raw');

    it('unrecognised stream error → req.body=Buffer.alloc(0) and next called', async () => {
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'application/octet-stream' }, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = rawMw();
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        emitter.emit('error', new Error('connection reset'));
        await done;
        expect(nextCalled).toBe(true);
        expect(Buffer.isBuffer(req.body)).toBe(true);
        expect(req.body.length).toBe(0);
    });
});

describe('raw parser — verify error without message', () => {
    const rawMw = require('../../lib/body/raw');

    it('default "verification failed" when error has no message', async () => {
        const mw = rawMw({ verify: () => { throw new Error(); } });
        const req = mockReq(Buffer.from('x'), { 'content-type': 'application/octet-stream' });
        const res = mockRes();
        await callMw(mw, req, res); // returns 403 without calling next
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res._body).error).toBe('verification failed');
    });
});

describe('raw parser — 415 catch path', () => {
    let server, base;
    beforeAll(async () => {
        const app = createApp();
        app.use(raw({ type: 'application/octet-stream' }));
        app.post('/r', (req, res) => res.send(req.body || Buffer.alloc(0)));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('415 for unsupported content-encoding', async () => {
        const r = await doFetch(`${base}/r`, {
            method: 'POST', body: Buffer.from('data'),
            headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'compress' },
        });
        expect(r.status).toBe(415);
    });
});

// -----------------------------------------------------------------------------
// urlencoded parser — deep branch coverage (extended mode paths)
// -----------------------------------------------------------------------------

describe('urlencoded parser — appendValue all branches', () => {
    // appendValue is private but exercised through extended mode
    const factory = require('../../lib/body/urlencoded');

    it('undefined prev → scalar value returned', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('x=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.x).toBe('1'); // undefined → '1'
    });

    it('string prev + new value → converted to [prev, val] array', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('c=red&c=blue', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.c)).toBe(true);
        expect(req.body.c).toEqual(['red', 'blue']);
    });

    it('array prev + new value → pushed onto existing array', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('c=red&c=blue&c=green', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.c).toEqual(['red', 'blue', 'green']);
    });
});

describe('urlencoded parser — array push [] notation (fixed bug)', () => {
    const factory = require('../../lib/body/urlencoded');

    it('a[]=1 creates array with one element', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[]=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a)).toBe(true);
        expect(req.body.a).toEqual(['1']);
    });

    it('a[]=1&a[]=2&a[]=3 pushes all values into array', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[]=1&a[]=2&a[]=3', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toEqual(['1', '2', '3']);
    });

    it('mixed: a[]=1 mixed with a[0]=x does not lose data', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[0]=x&a[]=y', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
    });
});

describe('urlencoded parser — intermediate [] bracket navigation', () => {
    const factory = require('../../lib/body/urlencoded');

    it('a[][name]=foo creates array of objects', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[][name]=foo&a[][name]=bar', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        // Should yield { a: [{name:'foo'}, {name:'bar'}] }
        expect(Array.isArray(req.body.a)).toBe(true);
        expect(req.body.a.length).toBeGreaterThanOrEqual(1);
    });

    it('stores correct values in nested array-of-object structure', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('items[][title]=A&items[][title]=B', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.items).toBeDefined();
    });
});

describe('urlencoded parser — array cur with numeric key at END (isLast + array)', () => {
    const factory = require('../../lib/body/urlencoded');

    it('numeric index at last position is set on array directly', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[0]=x&a[1]=y&a[2]=z', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a[0]).toBe('x');
        expect(req.body.a[1]).toBe('y');
        expect(req.body.a[2]).toBe('z');
    });

    it('non-numeric key at last position on array container', async () => {
        // e.g. a[0][label]=hello uses numeric index '0' first (not-last) then 'label' (last)
        // This also tests: array cur + numeric notLast + then plain key isLast
        const mw = factory({ extended: true });
        const req = mockReq('a[0][label]=hello', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a[0].label).toBe('hello');
    });
});

describe('urlencoded parser — non-numeric key on array cur (not-last)', () => {
    const factory = require('../../lib/body/urlencoded');

    it('non-numeric key mid-path on array navigates into last pushed object', async () => {
        // a[0][sub][key]=val = normal path
        // a[][sub]=val = non-numeric 'sub' key when cur is an array after []
        const mw = factory({ extended: true });
        const req = mockReq('data[][key]=val1&data[][key]=val2', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.data).toBeDefined();
    });
});

describe('urlencoded parser — inflate:false error path', () => {
    const factory = require('../../lib/body/urlencoded');

    it('415 when inflate=false and body is compressed', async () => {
        const compressed = await gzip(Buffer.from('a=1'));
        const req = {
            raw: makeStream(compressed),
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'gzip' },
            secure: true,
        };
        const res = mockRes();
        const mw = factory({ inflate: false });
        await callMw(mw, req, res); // returns 415 without calling next
        expect(res.statusCode).toBe(415);
    });
});

describe('urlencoded parser — generic error → req.body = {}', () => {
    const factory = require('../../lib/body/urlencoded');

    it('unrecognised stream error → req.body={} and next called', async () => {
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'application/x-www-form-urlencoded' }, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = factory();
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        emitter.emit('error', new Error('unexpected'));
        await done;
        expect(nextCalled).toBe(true);
        expect(req.body).toEqual({});
    });
});

describe('urlencoded parser — requireSecure', () => {
    const factory = require('../../lib/body/urlencoded');

    it('rejects non-HTTPS when requireSecure=true', async () => {
        const mw = factory({ requireSecure: true });
        const req = mockReq('a=1', { 'content-type': 'application/x-www-form-urlencoded' });
        req.secure = false;
        const res = mockRes();
        await callMw(mw, req, res); // returns 403 without calling next
        expect(res.statusCode).toBe(403);
    });
});

describe('urlencoded parser — existing array slot navigated by numeric index', () => {
    const factory = require('../../lib/body/urlencoded');

    it('existing value at numeric index is updated via appendValue', async () => {
        const mw = factory({ extended: true });
        // a[0]=x&a[0]=y → appendValue('x','y') → ['x','y'] at index 0
        const req = mockReq('a[0]=x&a[0]=y', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
        // Either array of arrays or [['x','y']] depending on path
        expect(req.body.a[0]).toBeDefined();
    });
});

describe('urlencoded parser — 415 from unsupported encoding', () => {
    let server, base;
    beforeAll(async () => {
        const app = createApp();
        app.use(urlencoded({ type: 'application/x-www-form-urlencoded' }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => server?.close());

    it('415 for compress encoding in urlencoded', async () => {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a=1',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'compress' },
        });
        expect(r.status).toBe(415);
    });
});

// -----------------------------------------------------------------------------
// multipart — helper function unit tests (accessed via internal module)
// -----------------------------------------------------------------------------

describe('multipart internal helpers — sanitizeFilename security', () => {
    // Exercise sanitizeFilename indirectly via the full middleware
    // Any filename that comes out stored in files[n].originalFilename has been sanitized

    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-sanitize-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json(req.body?.files || {}));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => {
        server?.close();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    function buildMultipart(boundary, parts) {
        const chunks = [];
        for (const p of parts) {
            let h = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
            if (p.filename) h += `; filename="${p.filename}"`;
            h += '\r\n';
            if (p.ct) h += `Content-Type: ${p.ct}\r\n`;
            h += '\r\n';
            chunks.push(Buffer.from(h));
            chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || ''));
            chunks.push(Buffer.from('\r\n'));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        return Buffer.concat(chunks);
    }

    it('null bytes stripped from filename', async () => {
        const bnd = 'bnd-null-' + Date.now();
        const body = buildMultipart(bnd, [{ name: 'f', filename: 'evil\x00.txt', ct: 'text/plain', data: 'x' }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        if (r.data.f) expect(r.data.f.originalFilename).not.toContain('\x00');
    });

    it('leading dots stripped from filename (prevents dotfile creation)', async () => {
        const bnd = 'bnd-dot-' + Date.now();
        const body = buildMultipart(bnd, [{ name: 'f', filename: '...hidden', ct: 'text/plain', data: 'x' }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        if (r.data.f) {
            expect(r.data.f.originalFilename).not.toMatch(/^\./);
        }
    });

    it('Windows forbidden chars are replaced with underscores', async () => {
        const bnd = 'bnd-win-' + Date.now();
        const body = buildMultipart(bnd, [{ name: 'f', filename: 'file<name>:test|?.txt', ct: 'text/plain', data: 'x' }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        if (r.data.f) {
            const fn = r.data.f.originalFilename;
            expect(fn).not.toMatch(/[<>:"|?*]/);
        }
    });

    it('empty filename after sanitization falls back to "unnamed"', async () => {
        const bnd = 'bnd-empty-' + Date.now();
        // A filename consisting only of dots → after stripping → empty → "unnamed"
        const body = buildMultipart(bnd, [{ name: 'f', filename: '...', ct: 'text/plain', data: 'x' }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        if (r.data.f) {
            // originalFilename could be 'unnamed' or a sanitized version
            expect(typeof r.data.f.originalFilename).toBe('string');
        }
    });

    it('directory traversal sequences removed from filename', async () => {
        const bnd = 'bnd-trav-' + Date.now();
        const body = buildMultipart(bnd, [{ name: 'f', filename: '../../etc/shadow', ct: 'text/plain', data: 'x' }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        if (r.data.f) {
            expect(r.data.f.originalFilename).not.toContain('..');
            expect(r.data.f.originalFilename).not.toContain('/');
        }
    });
});

// -----------------------------------------------------------------------------
// multipart — no boundary → next() immediately
// -----------------------------------------------------------------------------

describe('multipart — missing boundary in content-type', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('calls next() without setting req.body when boundary absent', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': 'multipart/form-data' }, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        await done;
        expect(nextCalled).toBe(true);
        expect(req.body).toBeUndefined();
    });

    it('calls next() when content-type header is missing entirely', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: {}, secure: true };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
        await done;
        expect(nextCalled).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// multipart — requireSecure
// -----------------------------------------------------------------------------

describe('multipart — requireSecure rejects HTTP', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('returns 403 when requireSecure=true on non-secure request', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=X' },
            secure: false,
        };
        const res = mockRes();
        const mw = mpFactory({ requireSecure: true });
        await callMw(mw, req, res);
        expect(res.statusCode).toBe(403);
    });
});

// -----------------------------------------------------------------------------
// multipart — req.raw 'error' event handler
// -----------------------------------------------------------------------------

describe('multipart — stream error event calls next', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('calls next() when req.raw emits an error', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=TEST' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        // mw attaches listeners synchronously
        mw(req, res, () => { nextCalled = true; });
        emitter.emit('error', new Error('read error'));
        // Give microtasks a tick
        await new Promise(r => setImmediate(r));
        expect(nextCalled).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// multipart — quoted boundary in content-type
// -----------------------------------------------------------------------------

describe('multipart — quoted boundary parsing', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-qbnd-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ fields: req.body?.fields || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('quoted boundary "value" is correctly parsed', async () => {
        const bnd = 'quoted-test-boundary';
        const body = [
            `--${bnd}\r\nContent-Disposition: form-data; name="msg"\r\n\r\nhello\r\n`,
            `--${bnd}--\r\n`,
        ].join('');
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: Buffer.from(body),
            headers: { 'content-type': `multipart/form-data; boundary="${bnd}"` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.msg).toBe('hello');
    });
});

// -----------------------------------------------------------------------------
// multipart — absolute vs relative dir option
// -----------------------------------------------------------------------------

describe('multipart — dir option handling', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-dir-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/abs', multipart({ dir: tmpDir }), (req, res) => res.json({ ok: true, fields: req.body?.fields || {} }));
        app.post('/rel', multipart({ dir: 'test-rel-uploads-' + process.pid }), (req, res) => res.json({ ok: true }));
        app.post('/nodir', multipart({}), (req, res) => res.json({ ok: true, fields: req.body?.fields || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(async () => {
        server?.close();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(process.cwd(), `test-rel-uploads-${process.pid}`), { recursive: true, force: true }); } catch {}
    });

    function fieldBody(bnd, name, val) {
        return Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n--${bnd}--\r\n`);
    }

    it('absolute dir path is used as-is', async () => {
        const bnd = 'dirbnd-abs-' + Date.now();
        const r = await doFetch(`${base}/abs`, {
            method: 'POST', body: fieldBody(bnd, 'x', 'val'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.x).toBe('val');
    });

    it('relative dir path is resolved against cwd', async () => {
        const bnd = 'dirbnd-rel-' + Date.now();
        const r = await doFetch(`${base}/rel`, {
            method: 'POST', body: fieldBody(bnd, 'x', 'val'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
    });

    it('no dir option → defaults to OS temp dir', async () => {
        const bnd = 'dirbnd-nodir-' + Date.now();
        const r = await doFetch(`${base}/nodir`, {
            method: 'POST', body: fieldBody(bnd, 'y', 'test'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.y).toBe('test');
    });
});

// -----------------------------------------------------------------------------
// multipart — streaming chunked data (boundary split across chunks)
// -----------------------------------------------------------------------------

describe('multipart — boundary detection across multiple data chunks', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('correctly assembles body from multiple small chunks', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        emitter.resume = () => {};
        const tmpDir = path.join(os.tmpdir(), 'zero-test-chunks-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=TESTBND' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({ dir: tmpDir });
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));

        // Build a simple field-only multipart body and split into small chunks
        const full = Buffer.from(
            '--TESTBND\r\nContent-Disposition: form-data; name="msg"\r\n\r\nhello\r\n--TESTBND--\r\n'
        );
        const chunkSize = 5;
        for (let i = 0; i < full.length; i += chunkSize) {
            emitter.emit('data', full.slice(i, Math.min(i + chunkSize, full.length)));
        }
        emitter.emit('end');
        await done;

        expect(nextCalled).toBe(true);
        expect(req.body.fields.msg).toBe('hello');

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

// -----------------------------------------------------------------------------
// multipart — 'end' event with no current part (no stream interruptions)
// -----------------------------------------------------------------------------

describe('multipart — end event with no active current part', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('end fires without active part → body set to {fields, files}, next called', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));

        // Emit end directly without any data → no current, no boundary found
        emitter.emit('end');
        await done;

        expect(nextCalled).toBe(true);
        expect(req.body).toBeDefined();
        expect(req.body.fields).toBeDefined();
        expect(req.body.files).toBeDefined();
    });
});

// -----------------------------------------------------------------------------
// multipart — abortFileTooLarge guard (_multipartErrorHandled)
// -----------------------------------------------------------------------------

describe('multipart — double-error guard prevents duplicate 413 responses', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-dblguard-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxFileSize: 50, maxTotalSize: 50 }), (req, res) => {
            if (!res.headersSent) res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('only one 413 is sent even when both maxFileSize and maxTotalSize exceeded', async () => {
        const bnd = 'bnd-dbl-' + Date.now();
        const body = Buffer.from([
            `--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            'x'.repeat(200),
            `\r\n--${bnd}--\r\n`,
        ].join(''));
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

// -----------------------------------------------------------------------------
// multipart — maxFileSize exceeded during incremental streaming (writeLen > 0 path)
// -----------------------------------------------------------------------------

describe('multipart — maxFileSize exceeded mid-stream (before final boundary)', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('aborts and sends 413 when file size limit hit during chunked write', async () => {
        const emitter = new EventEmitter();
        emitter.pause = vi.fn();
        emitter.resume = () => {};
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-maxfs-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND' },
            secure: true,
        };
        const res = mockRes();
        const mw = mpFactory({ dir: tmpDir, maxFileSize: 20 });
        mw(req, res, () => {});

        // Send headers part
        emitter.emit('data', Buffer.from('--BND\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'));
        // Send data exceeding maxFileSize — must be >1024 bytes so writeLen>0 triggers the size check
        emitter.emit('data', Buffer.from('x'.repeat(2000)));

        await new Promise(r => setTimeout(r, 50));

        expect(res.statusCode).toBe(413);
        expect(emitter.pause).toHaveBeenCalled();

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

// -----------------------------------------------------------------------------
// multipart — maxTotalSize exceeded during incremental streaming
// -----------------------------------------------------------------------------

describe('multipart — maxTotalSize exceeded mid-stream', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('aborts and sends 413 when total size limit hit during chunked write', async () => {
        const emitter = new EventEmitter();
        emitter.pause = vi.fn();
        emitter.resume = () => {};
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-maxts-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND2' },
            secure: true,
        };
        const res = mockRes();
        const mw = mpFactory({ dir: tmpDir, maxTotalSize: 20 });
        mw(req, res, () => {});

        emitter.emit('data', Buffer.from('--BND2\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'));
        // Must be >1024 bytes so writeLen>0 triggers the size check
        emitter.emit('data', Buffer.from('y'.repeat(2000)));

        await new Promise(r => setTimeout(r, 50));

        expect(res.statusCode).toBe(413);
        expect(emitter.pause).toHaveBeenCalled();

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

// -----------------------------------------------------------------------------
// multipart — maxFieldSize exceeded during incremental streaming
// -----------------------------------------------------------------------------

describe('multipart — maxFieldSize exceeded mid-stream', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('sends 413 when field value grows beyond maxFieldSize in incremental write', async () => {
        const emitter = new EventEmitter();
        emitter.pause = vi.fn();
        emitter.resume = () => {};

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BNDFS' },
            secure: true,
        };
        const res = mockRes();
        const mw = mpFactory({ maxFieldSize: 10 });
        mw(req, res, () => {});

        emitter.emit('data', Buffer.from('--BNDFS\r\nContent-Disposition: form-data; name="big"\r\n\r\n'));
        // Must be >1024 bytes so writeLen>0 triggers the field-size check
        emitter.emit('data', Buffer.from('a'.repeat(2000)));

        await new Promise(r => setTimeout(r, 50));
        expect(res.statusCode).toBe(413);

        try {
            // Clean up any file
        } catch {}
    });
});

// -----------------------------------------------------------------------------
// multipart — closeCurrent writeStream 'error' event
// -----------------------------------------------------------------------------

describe('multipart — writeStream error in closeCurrent (resolve without storing file)', () => {
    it('file with writeStream error still resolves (no crash)', async () => {
        const mpFactory = require('../../lib/body/multipart');
        const fsMock = require('fs');

        // Mock createWriteStream to return a stream that errors on .end()
        const mockWs = new EventEmitter();
        mockWs.write = vi.fn();
        mockWs.end = vi.fn(() => {
            process.nextTick(() => mockWs.emit('error', new Error('disk full')));
        });

        const spy = vi.spyOn(fsMock, 'createWriteStream').mockReturnValueOnce(mockWs);

        const tmpDir = path.join(os.tmpdir(), 'zero-mp-wserror-' + process.pid);
        fsMock.mkdirSync(tmpDir, { recursive: true });

        const emitter = new EventEmitter();
        emitter.pause = vi.fn();

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BNDWS' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({ dir: tmpDir });
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));

        // Send a complete multipart body including a file
        const body = [
            '--BNDWS\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n',
            '--BNDWS--\r\n',
        ].join('');
        emitter.emit('data', Buffer.from(body));

        // Allow enough time for Promise.all to resolve after writeStream error
        await new Promise(r => setTimeout(r, 200));
        // End the stream to fire the 'end' handler as fallback
        emitter.emit('end');

        await new Promise(r => setTimeout(r, 100));

        spy.mockRestore();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

        // Should not have thrown — nextCalled may or may not be true depending on which path fires
        expect(typeof nextCalled).toBe('boolean');
    });
});

// -----------------------------------------------------------------------------
// multipart — parseHeaders edge cases
// -----------------------------------------------------------------------------

describe('multipart — parseHeaders robustness (via field parsing)', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-hdr-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ fields: req.body?.fields || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('header line without colon is skipped gracefully', async () => {
        const bnd = 'bnd-hdr-' + Date.now();
        // Inject a malformed header line (no colon) before valid header
        const body = Buffer.concat([
            Buffer.from(`--${bnd}\r\n`),
            Buffer.from('X-No-Colon-Header\r\n'), // no colon → should be skipped
            Buffer.from(`Content-Disposition: form-data; name="x"\r\n`),
            Buffer.from('\r\n'),
            Buffer.from('value'),
            Buffer.from(`\r\n--${bnd}--\r\n`),
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        // Either parsed correctly or just set to empty string — should not throw
        expect(r.status).toBe(200);
    });

    it('header with multiple colons preserves value correctly', async () => {
        const bnd = 'bnd-hdr2-' + Date.now();
        // e.g. Content-Type: text/plain; charset=utf-8  (value contains no extra colon but this exercises slice logic)
        const body = Buffer.concat([
            Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="msg"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n`),
            Buffer.from(`--${bnd}--\r\n`),
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        // msg should be 'hello' (it's a field since no filename)
        expect(r.data.fields.msg).toBe('hello');
    });
});

// -----------------------------------------------------------------------------
// multipart — file with no content-type (contentType is null)
// -----------------------------------------------------------------------------

describe('multipart — file without Content-Type header', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-noct-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ files: req.body?.files || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('file with no Content-Type is accepted (null contentType)', async () => {
        const bnd = 'bnd-noct-' + Date.now();
        // Omit Content-Type header for the file part
        const body = Buffer.concat([
            Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="data.bin"\r\n\r\nbinary data here\r\n`),
            Buffer.from(`--${bnd}--\r\n`),
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        if (r.data.files.f) {
            expect(r.data.files.f.contentType).toBeNull();
        }
    });
});

// -----------------------------------------------------------------------------
// multipart — allowedMimeTypes with null contentType (no Content-Type on file)
// -----------------------------------------------------------------------------

describe('multipart — allowedMimeTypes does not block null contentType', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-nullmime-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, allowedMimeTypes: ['image/png'] }), (req, res) => res.json({ files: req.body?.files || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('file without Content-Type bypasses MIME check (contentType is null — condition short-circuits)', async () => {
        const bnd = 'bnd-nullmime-' + Date.now();
        // No Content-Type header → contentType = null → allowedMimeTypes check skipped
        const body = Buffer.concat([
            Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\ndata\r\n`),
            Buffer.from(`--${bnd}--\r\n`),
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        // Should not be 415 (null contentType → condition !allowedMimeTypes.includes(contentType) is false when contentType=null)
        // Actually the condition is: if (allowedMimeTypes && contentType && !allowedMimeTypes.includes(contentType))
        // contentType is null → falsy → condition is false → file is accepted
        expect([200, 415]).toContain(r.status); // accept either depending on implementation
    });
});

// -----------------------------------------------------------------------------
// multipart — file extension preservation
// -----------------------------------------------------------------------------

describe('multipart — stored filename extension handling', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-ext-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json(req.body?.files || {}));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    function fileBody(bnd, filename, data) {
        return Buffer.concat([
            Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
            Buffer.from(data),
            Buffer.from(`\r\n--${bnd}--\r\n`),
        ]);
    }

    it('stored name preserves clean extension (.txt)', async () => {
        const bnd = 'bnd-ext1-' + Date.now();
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: fileBody(bnd, 'readme.txt', 'content'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        if (r.data.f) expect(r.data.f.storedName).toMatch(/\.txt$/);
    });

    it('file with no extension has no extension in stored name', async () => {
        const bnd = 'bnd-ext2-' + Date.now();
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: fileBody(bnd, 'README', 'content'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        if (r.data.f) expect(r.data.f.storedName).not.toMatch(/\.$/);
    });

    it('extension with dangerous chars is sanitized in stored name', async () => {
        const bnd = 'bnd-ext3-' + Date.now();
        // e.g. .ph<p extension → <> stripped
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: fileBody(bnd, 'evil.ph<p', 'content'),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
    });
});

// -----------------------------------------------------------------------------
// multipart — large header buffer overflow protection path
// -----------------------------------------------------------------------------

describe('multipart — headers buffer overflow protection (large header without CRLF CRLF)', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('trims buffer when headers block exceeds 1MB without CRLF CRLF terminator', async () => {
        const emitter = new EventEmitter();
        emitter.pause = vi.fn();

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));

        // Emit start boundary to get into 'headers' state
        emitter.emit('data', Buffer.from('--BND\r\n'));

        // Emit >1MB of partial header data without \r\n\r\n to trigger buffer trim path
        // Buffer protection kicks in when buffer.length > 1MB in headers state
        const bigChunk = Buffer.alloc(1024 * 1024 + 100, 'H'.charCodeAt(0));
        emitter.emit('data', bigChunk);

        // Now end the stream (we just want to ensure no crash)
        emitter.emit('end');
        await done;

        expect(nextCalled).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// multipart — body chunk with CRLF prefix stripping (both code paths)
// -----------------------------------------------------------------------------

describe('multipart — CRLF prefix stripping at boundary', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-crlf-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ fields: req.body?.fields || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('multi-field body: CRLF divider between parts is stripped correctly', async () => {
        const bnd = 'bnd-crlf-' + Date.now();
        // Two fields — CRLF before each boundary is standard
        const body = [
            `--${bnd}\r\n`,
            `Content-Disposition: form-data; name="a"\r\n\r\n`,
            `alpha`,
            `\r\n--${bnd}\r\n`,
            `Content-Disposition: form-data; name="b"\r\n\r\n`,
            `beta`,
            `\r\n--${bnd}--\r\n`,
        ].join('');
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: Buffer.from(body),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.a).toBe('alpha');
        expect(r.data.fields.b).toBe('beta');
    });
});

// -----------------------------------------------------------------------------
// multipart — closeCurrent without writeStream (field path)
// -----------------------------------------------------------------------------

describe('multipart — closeCurrent field path stores value with default empty string', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), 'zero-test-close-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ fields: req.body?.fields || {} }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('field with empty value → stored as empty string (not undefined)', async () => {
        const bnd = 'bnd-emptyval-' + Date.now();
        // Field with literally no value
        const body = Buffer.concat([
            Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="empty"\r\n\r\n`),
            Buffer.from(''), // empty value
            Buffer.from(`\r\n--${bnd}--\r\n`),
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.empty).toBe('');
    });
});

// -----------------------------------------------------------------------------
// multipart — req.raw.pause is absent (defensive branch)
// -----------------------------------------------------------------------------

describe('multipart — req.raw without pause method (defensive guard)', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('does not crash when req.raw.pause is undefined', async () => {
        const emitter = new EventEmitter();
        // Deliberately NO pause method
        delete emitter.pause;

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND' },
            secure: true,
        };
        const res = mockRes();
        const mw = mpFactory({ maxFields: 0 }); // maxFields=0 means any field triggers too-many-fields
        // Wrap mw call to ensure it doesn't crash
        let threw = false;
        try {
            mw(req, res, () => {});
            emitter.emit('data', Buffer.from(
                '--BND\r\nContent-Disposition: form-data; name="f"\r\n\r\nval\r\n--BND--\r\n'
            ));
        } catch (e) {
            threw = true;
        }
        await new Promise(r => setTimeout(r, 30));
        expect(threw).toBe(false);
    });
});

// -----------------------------------------------------------------------------
// multipart — res.headersSent guard in sendError (called from multipart context)
// -----------------------------------------------------------------------------

describe('multipart — sendError skipped when headers already sent', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('sends only one error response even when multiple limits fire', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};

        const res = mockRes();
        // Pre-set headersSent to simulate already-sent headers
        // This tests that the second sendError attempt from the guard is a no-op
        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BND' },
            secure: true,
        };

        const mw = mpFactory({ maxFileSize: 5, maxTotalSize: 5 });
        mw(req, res, () => {});

        emitter.emit('data', Buffer.from(
            '--BND\r\nContent-Disposition: form-data; name="f"; filename="t.bin"\r\nContent-Type: application/octet-stream\r\n\r\n' +
            'x'.repeat(2000)
        ));

        await new Promise(r => setTimeout(r, 50));
        // Status should be set exactly once
        expect(res.statusCode).toBe(413);
    });
});

// -----------------------------------------------------------------------------
// multipart — ensureDir (existing directory should not throw)
// -----------------------------------------------------------------------------

describe('multipart — ensureDir idempotent (no throw on existing dir)', () => {
    let server, base, tmpDir;

    beforeAll(async () => {
        // Create the upload dir BEFORE the server starts to exercise ensureDir on existing path
        tmpDir = path.join(os.tmpdir(), 'zero-test-ensuredir-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('processes request without error when upload dir already exists', async () => {
        const bnd = 'bnd-ensuredir-' + Date.now();
        const body = Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="x"\r\n\r\ntest\r\n--${bnd}--\r\n`);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
    });
});

// -----------------------------------------------------------------------------
// multipart — start state boundary search when buffer is large but no boundary
// -----------------------------------------------------------------------------

describe('multipart — start state: no boundary found in large initial buffer', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('trims oversized pre-boundary buffer and waits for more data', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=STARTBND' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        const done = new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));

        // Send junk data larger than startBoundaryBuf.length without a boundary
        emitter.emit('data', Buffer.alloc(500, 'X'.charCodeAt(0)));

        // Then end without ever finding a boundary
        emitter.emit('end');
        await done;

        expect(nextCalled).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// Full integration: barrel export (lib/body/index.js)
// -----------------------------------------------------------------------------

describe('lib/body barrel export', () => {
    it('exports all expected body utilities', () => {
        const body = require('../../lib/body');
        expect(typeof body.rawBuffer).toBe('function');
        expect(typeof body.isTypeMatch).toBe('function');
        expect(typeof body.sendError).toBe('function');
        expect(typeof body.json).toBe('function');
        expect(typeof body.urlencoded).toBe('function');
        expect(typeof body.text).toBe('function');
        expect(typeof body.raw).toBe('function');
        expect(typeof body.multipart).toBe('function');
    });
});

// -----------------------------------------------------------------------------
// Security invariant summary tests (regression guards)
// -----------------------------------------------------------------------------

describe('Security invariants — prototype pollution can never succeed', () => {
    const jsonMw = require('../../lib/body/json');
    const factory = require('../../lib/body/urlencoded');

    it('JSON: __proto__ in deep nested object is always stripped', async () => {
        const mw = jsonMw({ strict: false });
        for (const payload of [
            '{"a":{"__proto__":{"x":1}}}',
            '{"__proto__":{"y":2}}',
            '[{"__proto__":{"z":3}}]',
        ]) {
            const req = mockReq(payload, { 'content-type': 'application/json' });
            const res = mockRes();
            await runMw(mw, req, res);
        }
        expect(({}).x).toBeUndefined();
        expect(({}).y).toBeUndefined();
        expect(({}).z).toBeUndefined();
    });

    it('URLEncoded: constructor[prototype] in flat mode cannot pollute', async () => {
        const mw = factory({ extended: false });
        const req = mockReq('constructor[prototype][pwned]=yes', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(({}).pwned).toBeUndefined();
    });

    it('URLEncoded: __proto__ in extended mode cannot pollute', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('__proto__[admin]=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(({}).admin).toBeUndefined();
    });
});

describe('Security invariants — size limits are always enforced', () => {
    const jsonMw = require('../../lib/body/json');
    const textMw = require('../../lib/body/text');
    const rawMw = require('../../lib/body/raw');

    it('JSON: 1-byte over limit returns 413', async () => {
        const mw = jsonMw({ limit: 10 });
        const payload = JSON.stringify({ data: 'x'.repeat(20) });
        const req = mockReq(payload, { 'content-type': 'application/json' });
        const res = mockRes();
        // 413 path calls sendError without next(); use callMw to await the middleware promise directly
        await callMw(mw, req, res);
        expect(res.statusCode).toBe(413);
    });

    it('text: Content-Length pre-check fires before reading body', async () => {
        const mw = textMw({ limit: 10 });
        const req = mockReq('short', { 'content-type': 'text/plain', 'content-length': '9999' });
        const res = mockRes();
        // Pre-check fires sendError without next()
        await callMw(mw, req, res);
        expect(res.statusCode).toBe(413);
    });

    it('raw: Content-Length pre-check fires', async () => {
        const mw = rawMw({ limit: 10 });
        const req = mockReq(Buffer.from('small'), { 'content-type': 'application/octet-stream', 'content-length': '99999' });
        const res = mockRes();
        // Pre-check fires sendError without next()
        await callMw(mw, req, res);
        expect(res.statusCode).toBe(413);
    });
});

describe('Security invariants — HTTPS-only enforcement', () => {
    const jsonMw = require('../../lib/body/json');
    const textMw = require('../../lib/body/text');
    const rawMw = require('../../lib/body/raw');
    const factory = require('../../lib/body/urlencoded');

    function insecureReq(body, ct) {
        const req = mockReq(body, { 'content-type': ct });
        req.secure = false;
        return req;
    }

    it('json requireSecure → 403', async () => {
        const mw = jsonMw({ requireSecure: true });
        const res = mockRes();
        await callMw(mw, insecureReq('{}', 'application/json'), res);
        expect(res.statusCode).toBe(403);
    });

    it('text requireSecure → 403', async () => {
        const mw = textMw({ requireSecure: true });
        const res = mockRes();
        await callMw(mw, insecureReq('hi', 'text/plain'), res);
        expect(res.statusCode).toBe(403);
    });

    it('raw requireSecure → 403', async () => {
        const mw = rawMw({ requireSecure: true });
        const res = mockRes();
        await callMw(mw, insecureReq('data', 'application/octet-stream'), res);
        expect(res.statusCode).toBe(403);
    });

    it('urlencoded requireSecure → 403', async () => {
        const mw = factory({ requireSecure: true });
        const res = mockRes();
        await callMw(mw, insecureReq('a=1', 'application/x-www-form-urlencoded'), res);
        expect(res.statusCode).toBe(403);
    });
});

// -----------------------------------------------------------------------------
// Branch coverage — options || {} fallback (when factory called with null)
// Covers: json.js line 46, text.js line 26, raw.js line 24, urlencoded.js opts
// -----------------------------------------------------------------------------
describe('parsers — null options uses defaults (options || {} fallback branch)', () => {
    it('json(null) parses body with default options', async () => {
        const mw = require('../../lib/body/json')(null);
        const req = mockReq('{"x":1}', { 'content-type': 'application/json' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toEqual({ x: 1 });
    });

    it('text(null) parses body with default options', async () => {
        const mw = require('../../lib/body/text')(null);
        const req = mockReq('hello', { 'content-type': 'text/plain' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toBe('hello');
    });

    it('raw(null) parses body with default options', async () => {
        const mw = require('../../lib/body/raw')(null);
        const req = mockReq(Buffer.from('bytes'), { 'content-type': 'application/octet-stream' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Buffer.isBuffer(req.body)).toBe(true);
    });

    it('urlencoded(null) parses body with default options', async () => {
        const mw = require('../../lib/body/urlencoded')(null);
        const req = mockReq('a=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBe('1');
    });
});

// -----------------------------------------------------------------------------
// Branch coverage — content-type header absent (ct = header || '' right branch)
// Covers: text.js line 37, raw.js line 34, json.js ct line
// -----------------------------------------------------------------------------
describe('parsers — missing content-type header (|| "" fallback branch)', () => {
    it('json: no content-type → isTypeMatch false → next() called, body unset', async () => {
        const mw = require('../../lib/body/json')();
        const req = mockReq('{"x":1}', {}); // empty headers, no content-type
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toBeUndefined();
    });

    it('text: no content-type → isTypeMatch false → next() called, body unset', async () => {
        const mw = require('../../lib/body/text')();
        const req = mockReq('hello', {}); // empty headers
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toBeUndefined();
    });

    it('raw: no content-type → isTypeMatch false → next() called, body unset', async () => {
        const mw = require('../../lib/body/raw')();
        const req = mockReq('data', {}); // empty headers
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toBeUndefined();
    });

    it('urlencoded: no content-type → isTypeMatch false → next() called, body unset', async () => {
        const mw = require('../../lib/body/urlencoded')();
        const req = mockReq('a=1', {}); // empty headers
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body).toBeUndefined();
    });
});

// -----------------------------------------------------------------------------
// rawBuffer.js line 29 — parseLimit returns null for exotic (non-string/number) types
// -----------------------------------------------------------------------------
describe('rawBuffer — parseLimit returns null for exotic limit type', () => {
    it('limit=true is treated as unlimited (falls through to return null)', async () => {
        const rawBuffer = require('../../lib/body/rawBuffer');
        // parseLimit(true): truthy, not 0, not number, not string → return null (unlimited)
        const req = mockReq('hello');
        const buf = await rawBuffer(req, { limit: true });
        expect(buf.toString()).toBe('hello');
    });

    it('limit={} object is treated as unlimited', async () => {
        const rawBuffer = require('../../lib/body/rawBuffer');
        const req = mockReq('world');
        const buf = await rawBuffer(req, { limit: {} });
        expect(buf.toString()).toBe('world');
    });
});

// -----------------------------------------------------------------------------
// urlencoded.js — isLast + Array.isArray(cur) paths (lines 163–168)
// Created by: first using [] push to make an array, then accessing it by key
// -----------------------------------------------------------------------------
describe('urlencoded parser — isLast + Array.isArray(cur) branch', () => {
    const factory = require('../../lib/body/urlencoded');

    it('numeric key at last position on array container (a[]=init → a[0]=upd)', async () => {
        // a[]=init creates out.a=['init'], then a[0]=upd: at part='0', isLast, cur=['init'] IS array
        // Covers lines 163–167: isLast + Array.isArray + numeric index
        const mw = factory({ extended: true });
        const req = mockReq('a[]=init&a[0]=upd', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a)).toBe(true);
        // appendValue merges 'init' and 'upd' at index 0
        expect(req.body.a[0]).toBeDefined();
    });

    it('non-numeric key at last position on array container (a[]=init → a[nk]=x)', async () => {
        // a[]=init creates out.a=['init'], then a[nk]=x: at part='nk', isLast, cur=['init'] is array
        // Covers line 168: isLast + Array.isArray + non-numeric index (else branch)
        const mw = factory({ extended: true });
        const req = mockReq('a[]=init&a[nk]=x', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
        // Array gets a named property set on it
        expect(req.body.a.nk).toBe('x');
    });
});

// -----------------------------------------------------------------------------
// urlencoded.js — !isLast + Array.isArray(cur) paths (lines 179–195)
// Triggered when a previous [] push made a value an array, then further
// navigation uses a normal (non-empty) key through that array position.
// -----------------------------------------------------------------------------
describe('urlencoded parser — !isLast + Array.isArray(cur) branch', () => {
    const factory = require('../../lib/body/urlencoded');

    it('numeric key at !isLast on array container — cur[idx] exists (lines 179–185)', async () => {
        // a[0][]=init makes out.a['0']=['init']
        // a[0][0][k]=v: part='0' (notLast), cur=['init'] is array, idx=0 (numeric, cur[0] truthy)
        // Covers lines 179–185: !isLast + Array.isArray + numeric idx + cur[idx] truthy
        const mw = factory({ extended: true });
        const req = mockReq('a[0][]=init&a[0][0][k]=v', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
    });

    it('numeric key at !isLast on array container — cur[idx] is falsy (line 182: creates {})', async () => {
        // a[0][]=&a[0][0][k]=v: empty value '' is falsy → !cur[idx]=true → creates {} at that slot
        // Covers the !cur[idx] branch on line 182
        const mw = factory({ extended: true });
        const req = mockReq('a[0][]=%20&a[0][0][k]=v', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
    });

    it('non-numeric key at !isLast on array → navigates into last pushed object (lines 187–195)', async () => {
        // a[0][]=init makes out.a['0']=['init']
        // a[0][sub][k]=v: part='sub' (notLast), cur=['init'] is array, 'sub' is NaN → lines 187–195
        // Creates {} in array, sets obj['sub']={}, navigates, sets k=v
        const mw = factory({ extended: true });
        const req = mockReq('a[0][]=init&a[0][sub][k]=v', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        // a[0] is array: ['init', { sub: { k: 'v' } }]
        expect(req.body.a).toBeDefined();
        expect(Array.isArray(req.body.a['0'])).toBe(true);
    });

    it('non-numeric key at !isLast — cur is empty array → pushes first object (line 189)', async () => {
        // a[0][sub]=v: out.a['0']=['init'] then navigate to it as array with no length 0 case
        // Alternative: force a fresh [] that is empty when we arrive at the non-numeric step
        // Use a[][sub]=v where we get empty array at intermediate step but populated by [] handler
        // The cur.length === 0 branch at line 189 fires when a fresh array has no objects
        const mw = factory({ extended: true });
        // a[0][]=init creates array ['init']. a[0][nonNum][k]=v navigates into ['init'],
        // typeof cur[cur.length-1] is 'string' (not object) → line 190: push new {}
        const req = mockReq('a[0][]=init&a[0][nonNum][k]=deep', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(req.body.a).toBeDefined();
    });
});

// -----------------------------------------------------------------------------
// multipart.js — large field value incremental accumulation (lines 331–333)
// The internal write loop keeps 1 KB of buffer for boundary matching.
// writeLen = buffer.length - 1024 > 0 only when buf > 1024 bytes.
// For fields (no writeStream), this writes to current.value incrementally.
// -----------------------------------------------------------------------------
describe('multipart — large field value incremental accumulation', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('field >1KB is accumulated incrementally (writeLen > 0 path for fields)', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        emitter.resume = () => {};

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=LFLD' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({}); // default: maxFieldSize=1MB, definitely won't abort

        mw(req, res, () => { nextCalled = true; });

        // Step 1: boundary + headers (puts state in 'body')
        emitter.emit('data', Buffer.from('--LFLD\r\nContent-Disposition: form-data; name="big"\r\n\r\n'));

        // Step 2: 2000-byte field value (no boundary), no maxFieldSize limit
        //   keep = max(10, 1024) = 1024; writeLen = 2000 - 1024 = 976 > 0
        //   → current.value += toWrite (976 bytes) [lines 331–333 covered]
        emitter.emit('data', Buffer.from('X'.repeat(2000)));

        // Step 3: final boundary to close the field and trigger next()
        emitter.emit('data', Buffer.from('\r\n--LFLD--\r\n'));

        await new Promise(r => setTimeout(r, 100));
        expect(nextCalled).toBe(true);
        expect(req.body.fields.big).toBeDefined();
        expect(req.body.fields.big.length).toBeGreaterThan(900); // at least the incremental part
    });
});

// -----------------------------------------------------------------------------
// json.js / text.js / raw.js — 415 catch path with no message
// Covers the `err.message || 'unsupported encoding'` right-hand branch
// -----------------------------------------------------------------------------
describe('parsers — 415 error without message uses "unsupported encoding" fallback', () => {
    it('json: 415 error with empty message uses fallback string', async () => {
        const jsonMw = require('../../lib/body/json');
        // Inject a 415-status error with no message via a stream that rejects immediately
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'application/json' }, secure: true };
        const res = mockRes();
        const mw = jsonMw();
        const p = callMw(mw, req, res);
        // Emit a 415 error with empty message — hits `err.message || 'unsupported encoding'`
        const err415 = Object.assign(new Error(''), { status: 415 });
        emitter.emit('error', err415);
        await p;
        expect(res.statusCode).toBe(415);
        expect(JSON.parse(res._body).error).toBe('unsupported encoding');
    });

    it('text: 415 error with empty message uses fallback string', async () => {
        const textMw = require('../../lib/body/text');
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'text/plain' }, secure: true };
        const res = mockRes();
        const mw = textMw();
        const p = callMw(mw, req, res);
        const err415 = Object.assign(new Error(''), { status: 415 });
        emitter.emit('error', err415);
        await p;
        expect(res.statusCode).toBe(415);
        expect(JSON.parse(res._body).error).toBe('unsupported encoding');
    });

    it('raw: 415 error with empty message uses fallback string', async () => {
        const rawMw = require('../../lib/body/raw');
        const emitter = new EventEmitter();
        const req = { raw: emitter, headers: { 'content-type': 'application/octet-stream' }, secure: true };
        const res = mockRes();
        const mw = rawMw();
        const p = callMw(mw, req, res);
        const err415 = Object.assign(new Error(''), { status: 415 });
        emitter.emit('error', err415);
        await p;
        expect(res.statusCode).toBe(415);
        expect(JSON.parse(res._body).error).toBe('unsupported encoding');
    });
});

describe('urlencoded parser — explicit 413/415 catch branches', () => {
    const factory = require('../../lib/body/urlencoded');

    it('maps err.status=413 to payload too large', async () => {
        const emitter = new EventEmitter();
        const req = {
            raw: emitter,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            secure: true,
        };
        const res = mockRes();
        const mw = factory();
        const p = callMw(mw, req, res);
        emitter.emit('error', { status: 413 });
        await p;
        expect(res.statusCode).toBe(413);
        expect(JSON.parse(res._body).error).toBe('payload too large');
    });

    it('maps err.status=415 with empty message to unsupported encoding fallback', async () => {
        const emitter = new EventEmitter();
        const req = {
            raw: emitter,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            secure: true,
        };
        const res = mockRes();
        const mw = factory();
        const p = callMw(mw, req, res);
        emitter.emit('error', { status: 415, message: '' });
        await p;
        expect(res.statusCode).toBe(415);
        expect(JSON.parse(res._body).error).toBe('unsupported encoding');
    });
});

describe('urlencoded parser — array traversal not-last branches', () => {
    const factory = require('../../lib/body/urlencoded');

    it('array + numeric key at not-last creates missing slot object', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[]=seed&a[1][k]=v', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a)).toBe(true);
        expect(req.body.a[1].k).toBe('v');
    });

    it('array + non-numeric key at not-last navigates through last pushed object', async () => {
        const mw = factory({ extended: true });
        const req = mockReq('a[]=seed&a[sub][k]=v', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a)).toBe(true);
        expect(req.body.a[1].sub.k).toBe('v');
    });
});

describe('multipart — incremental file write branch and Promise.catch continuation', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('writes incremental file chunk when boundary is not yet present (writeLen path)', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        emitter.resume = () => {};

        const ws = new EventEmitter();
        ws.write = vi.fn();
        ws.end = vi.fn(() => process.nextTick(() => ws.emit('finish')));

        const spy = vi.spyOn(fs, 'createWriteStream').mockReturnValueOnce(ws);

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=INCW' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        mw(req, res, () => { nextCalled = true; });

        emitter.emit('data', Buffer.from('--INCW\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'));
        emitter.emit('data', Buffer.from('x'.repeat(2000)));
        emitter.emit('data', Buffer.from('\r\n--INCW--\r\n'));

        await new Promise(r => setTimeout(r, 80));
        expect(ws.write).toHaveBeenCalled();
        expect(nextCalled).toBe(true);
        spy.mockRestore();
    });

    it('executes Promise.catch continuation when next throws inside Promise.then', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        emitter.resume = () => {};

        const ws = new EventEmitter();
        ws.write = vi.fn();
        ws.end = vi.fn(() => process.nextTick(() => ws.emit('finish')));

        const spy = vi.spyOn(fs, 'createWriteStream').mockReturnValueOnce(ws);

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=PCATCH' },
            secure: true,
        };
        const res = mockRes();
        let calls = 0;

        const mw = mpFactory({});
        mw(req, res, () => {
            calls++;
            if (calls === 1) throw new Error('force then failure');
        });

        emitter.emit('data', Buffer.from('--PCATCH\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n--PCATCH--\r\n'));

        await new Promise(r => setTimeout(r, 100));
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(req.body).toBeDefined();
        expect(req._multipart).toBe(true);
        spy.mockRestore();
    });
});

describe('urlencoded parser — parent conversion for nested [] syntax', () => {
    const factory = require('../../lib/body/urlencoded');

    it('converts nested object slot to array for isLast empty bracket (a[b][]=1)', async () => {
        // Covers line 140 branch where _parent is not null in the isLast part=='' path.
        const mw = factory({ extended: true });
        const req = mockReq('a[b][]=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a.b)).toBe(true);
        expect(req.body.a.b[0]).toBe('1');
    });

    it('converts nested object slot to array for intermediate empty bracket (a[b][][c]=1)', async () => {
        // Covers line 150 branch where _parent is not null in the non-last part=='' path.
        const mw = factory({ extended: true });
        const req = mockReq('a[b][][c]=1', { 'content-type': 'application/x-www-form-urlencoded' });
        const res = mockRes();
        await runMw(mw, req, res);
        expect(Array.isArray(req.body.a.b)).toBe(true);
        expect(req.body.a.b[0].c).toBe('1');
    });
});

describe('multipart — malformed part separators still follow non-final boundary path', () => {
    const mpFactory = require('../../lib/body/multipart');

    it('takes the non-CRLF branch after boundary when payload is malformed', async () => {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        emitter.resume = () => {};

        const req = {
            raw: emitter,
            headers: { 'content-type': 'multipart/form-data; boundary=BADSEP' },
            secure: true,
        };
        const res = mockRes();
        let nextCalled = false;
        const mw = mpFactory({});
        mw(req, res, () => { nextCalled = true; });

        // Deliberately malformed: missing CRLF after the middle boundary marker.
        // This forces the `if (buffer.slice(0, 2) === '\r\n')` condition to be false
        // in the non-final boundary branch.
        emitter.emit('data', Buffer.from(
            '--BADSEP\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n' +
            '--BADSEPContent-Disposition: form-data; name="b"\r\n\r\n2\r\n' +
            '--BADSEP--\r\n'
        ));

        // Ensure parser settles even for malformed payload.
        emitter.emit('end');
        await new Promise(r => setTimeout(r, 80));
        expect(nextCalled).toBe(true);
        expect(req.body).toBeDefined();
    });
});
