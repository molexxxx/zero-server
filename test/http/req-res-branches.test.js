'use strict';
/** req-res-branches.test.js — request/response branch coverage */

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { EventEmitter } = require('events');
const { PassThrough }  = require('stream');

const Request  = require('../../lib/http/request');
const Response = require('../../lib/http/response');

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function mockRaw(overrides = {})
{
    return {
        method:  'GET',
        url:     '/',
        headers: {},
        socket:  { remoteAddress: '127.0.0.1', encrypted: false },
        ...overrides,
    };
}

function mockRawRes(overrides = {})
{
    const obj = {
        headersSent:   false,
        statusCode:    200,
        _headers:      {},
        _chunks:       [],
        _ended:        false,
        setHeader(k, v) { this._headers[k] = v; },
        getHeader(k)    { return this._headers[k]; },
        removeHeader(k) { delete this._headers[k]; },
        write(c)        { this._chunks.push(c); return true; },
        end(chunk)
        {
            if (chunk !== undefined) this._chunks.push(chunk);
            this._ended = true;
            this.emit && this.emit('finish');
        },
        pipe(dest)      { dest._piped = true; },
        on(event, cb)   { /* no-op for simple tests */ },
        removeListener(){ /* no-op */ },
        ...overrides,
    };
    // Allow EventEmitter-style `.on()` for the logger / timeout tests
    const ee = new EventEmitter();
    obj.on  = (ev, cb) => ee.on(ev, cb);
    obj.removeListener = (ev, cb) => ee.removeListener(ev, cb);
    obj.emit = (ev, ...args) => ee.emit(ev, ...args);
    return obj;
}

function makeReq(overrides = {})  { return new Request(mockRaw(overrides)); }
function makeRes(rawOver = {})    { return new Response(mockRawRes(rawOver)); }

// ===========================================================================
// REQUEST — construction
// ===========================================================================
describe('Request — construction and base properties', () =>
{
    it('sets method, url, headers from raw', () =>
    {
        const req = makeReq({ method: 'POST', url: '/foo', headers: { 'content-type': 'application/json' } });
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/foo');
        expect(req.headers['content-type']).toBe('application/json');
    });

    it('extracts ip from socket.remoteAddress', () =>
    {
        const req = makeReq({ socket: { remoteAddress: '10.0.0.1', encrypted: false } });
        expect(req.ip).toBe('10.0.0.1');
    });

    it('ip is null when socket is absent', () =>
    {
        const req = new Request({ method: 'GET', url: '/', headers: {}, socket: null });
        expect(req.ip).toBeNull();
    });

    it('secure=true when socket is encrypted', () =>
    {
        const req = makeReq({ socket: { remoteAddress: '1.2.3.4', encrypted: true } });
        expect(req.secure).toBe(true);
        expect(req.protocol).toBe('https');
    });

    it('secure=false on plain socket', () =>
    {
        const req = makeReq();
        expect(req.secure).toBe(false);
        expect(req.protocol).toBe('http');
    });

    it('initialises params, body, cookies, locals as expected', () =>
    {
        const req = makeReq();
        expect(req.params).toEqual({});
        expect(req.body).toBeNull();
        expect(req.cookies).toEqual({});
        expect(req.locals).toEqual({});
    });

    it('baseUrl defaults to empty string', () =>
    {
        expect(makeReq().baseUrl).toBe('');
    });

    it('originalUrl matches url at construction', () =>
    {
        const req = makeReq({ url: '/a/b?c=1' });
        expect(req.originalUrl).toBe('/a/b?c=1');
    });
});

// ===========================================================================
// REQUEST — _parseQuery
// ===========================================================================
describe('Request — _parseQuery', () =>
{
    it('returns empty object when no query string', () =>
    {
        expect(makeReq({ url: '/path' }).query).toEqual({});
    });

    it('parses simple key=value pairs', () =>
    {
        const q = makeReq({ url: '/?a=1&b=2' }).query;
        expect(q.a).toBe('1');
        expect(q.b).toBe('2');
    });

    it('handles key-only params (no =)', () =>
    {
        const q = makeReq({ url: '/?flag' }).query;
        expect(q.flag).toBe('');
    });

    it('URL-decodes keys and values', () =>
    {
        const q = makeReq({ url: '/?hello%20world=foo%20bar' }).query;
        expect(q['hello world']).toBe('foo bar');
    });

    it('silently drops prototype pollution keys (__proto__)', () =>
    {
        const q = makeReq({ url: '/?__proto__=injected' }).query;
        expect(q.__proto__).toBeUndefined();       // not on the object  
        expect(Object.prototype.foo).toBeUndefined(); // not on the prototype
    });

    it('silently drops prototype pollution keys (constructor)', () =>
    {
        const q = makeReq({ url: '/?constructor=bad' }).query;
        expect(Object.keys(q)).not.toContain('constructor');
    });

    it('silently drops prototype pollution key-only form (__proto__ no =)', () =>
    {
        const q = makeReq({ url: '/?__proto__' }).query;
        expect(Object.keys(q)).not.toContain('__proto__');
    });

    it('caps at 100 query params — 101st is silently dropped', () =>
    {
        const many = Array.from({ length: 101 }, (_, i) => `k${i}=v`).join('&');
        const q = makeReq({ url: `/?${many}` }).query;
        expect(Object.keys(q).length).toBe(100);
    });

    it('ignores malformed percent-encoding in keys gracefully', () =>
    {
        // %ZZ is invalid — the catch block should silently skip it
        const q = makeReq({ url: '/?%ZZ=value&good=1' }).query;
        expect(q.good).toBe('1');
    });

    it('ignores malformed percent-encoding in values gracefully', () =>
    {
        const q = makeReq({ url: '/?k=%ZZ' }).query;
        // key-only pair should be skipped; the object should not contain 'k' with broken value
        // The try/catch in the eqIdx !== -1 branch also catches this
        // Either absent or kept raw is acceptable — what matters is no throw
        expect(() => makeReq({ url: '/?k=%ZZ' })).not.toThrow();
    });

    it('uses Object.create(null) — no inherited keys', () =>
    {
        const q = makeReq({ url: '/?a=1' }).query;
        expect(Object.getPrototypeOf(q)).toBeNull();
    });
});

// ===========================================================================
// REQUEST — get(), is()
// ===========================================================================
describe('Request — get() and is()', () =>
{
    it('get() is case-insensitive', () =>
    {
        // Node normalises incoming headers to lowercase; mirrors real behaviour
        const req = makeReq({ headers: { 'content-type': 'application/json' } });
        expect(req.get('content-type')).toBe('application/json');
        expect(req.get('CONTENT-TYPE')).toBe('application/json');
    });

    it('get() returns undefined for missing header', () =>
    {
        expect(makeReq().get('x-missing')).toBeUndefined();
    });

    it('is() returns true for shorthand match', () =>
    {
        const req = makeReq({ headers: { 'content-type': 'application/json' } });
        expect(req.is('json')).toBe(true);
    });

    it('is() returns true for full MIME type', () =>
    {
        const req = makeReq({ headers: { 'content-type': 'text/html; charset=utf-8' } });
        expect(req.is('text/html')).toBe(true);
    });

    it('is() returns false when content-type absent', () =>
    {
        expect(makeReq().is('json')).toBe(false);
    });
});

// ===========================================================================
// REQUEST — hostname and subdomains
// ===========================================================================
describe('Request — hostname and subdomains', () =>
{
    it('hostname strips port number', () =>
    {
        const req = makeReq({ headers: { host: 'example.com:3000' } });
        expect(req.hostname).toBe('example.com');
    });

    it('hostname returns full host when no port', () =>
    {
        const req = makeReq({ headers: { host: 'example.com' } });
        expect(req.hostname).toBe('example.com');
    });

    it('hostname prefers X-Forwarded-Host for trusted proxies', () =>
    {
        const req = makeReq({ headers: { host: 'localhost', 'x-forwarded-host': 'api.example.com:8080' } });
        expect(req.hostname).toBe('api.example.com');
    });

    it('hostname returns empty string when no host header', () =>
    {
        expect(makeReq().hostname).toBe('');
    });

    it('subdomains() splits on dots and reverses (offset=2)', () =>
    {
        const req = makeReq({ headers: { host: 'a.b.example.com' } });
        expect(req.subdomains()).toEqual(['b', 'a']);
    });

    it('subdomains() returns empty array for plain domain', () =>
    {
        const req = makeReq({ headers: { host: 'example.com' } });
        expect(req.subdomains()).toEqual([]);
    });

    it('subdomains() respects custom offset', () =>
    {
        const req = makeReq({ headers: { host: 'a.b.c.example.co.uk' } });
        expect(req.subdomains(3)).toEqual(['c', 'b', 'a']);
    });

    it('subdomains() clamps at 0 — never negative slice', () =>
    {
        // offset > parts.length → Math.max(0, negative) → empty
        const req = makeReq({ headers: { host: 'localhost' } });
        expect(req.subdomains(5)).toEqual([]);
    });
});

// ===========================================================================
// REQUEST — accepts()
// ===========================================================================
describe('Request — accepts()', () =>
{
    it('wildcard */* accepts first type', () =>
    {
        const req = makeReq({ headers: { accept: '*/*' } });
        expect(req.accepts('json', 'html')).toBe('json');
    });

    it('accepts matching MIME type', () =>
    {
        const req = makeReq({ headers: { accept: 'text/html' } });
        expect(req.accepts('html')).toBe('html');
    });

    it('accepts full MIME string', () =>
    {
        const req = makeReq({ headers: { accept: 'application/json' } });
        expect(req.accepts('application/json')).toBe('application/json');
    });

    it('returns false when no types match', () =>
    {
        const req = makeReq({ headers: { accept: 'text/html' } });
        expect(req.accepts('application/json')).toBe(false);
    });

    it('matches main-type wildcard (text/*)', () =>
    {
        const req = makeReq({ headers: { accept: 'text/*' } });
        expect(req.accepts('text/plain')).toBe('text/plain');
    });

    it('returns false when called with no args', () =>
    {
        const req = makeReq({ headers: { accept: '*/*' } });
        expect(req.accepts()).toBe(false);
    });

    it('no Accept header uses */* — returns first type', () =>
    {
        const req = makeReq();
        expect(req.accepts('json', 'html')).toBe('json');
    });
});

// ===========================================================================
// REQUEST — xhr, path
// ===========================================================================
describe('Request — xhr and path', () =>
{
    it('xhr=true for XMLHttpRequest header (case-insensitive check)', () =>
    {
        const req = makeReq({ headers: { 'x-requested-with': 'XMLHttpRequest' } });
        expect(req.xhr).toBe(true);
    });

    it('xhr=false for other values', () =>
    {
        const req = makeReq({ headers: { 'x-requested-with': 'fetch' } });
        expect(req.xhr).toBe(false);
    });

    it('xhr=false when header absent', () =>
    {
        expect(makeReq().xhr).toBe(false);
    });

    it('path strips query string', () =>
    {
        expect(makeReq({ url: '/hello?x=1' }).path).toBe('/hello');
    });

    it('path without query string is unchanged', () =>
    {
        expect(makeReq({ url: '/no-qs' }).path).toBe('/no-qs');
    });
});

// ===========================================================================
// REQUEST — fresh / stale
// ===========================================================================
describe('Request — fresh / stale', () =>
{
    it('stale=true when no cache headers present', () =>
    {
        const req = makeReq({ method: 'GET' });
        expect(req.fresh).toBe(false);
        expect(req.stale).toBe(true);
    });

    it('fresh=false for non-GET/HEAD methods even with If-None-Match', () =>
    {
        const req = makeReq({ method: 'POST', headers: { 'if-none-match': '"abc"' } });
        expect(req.fresh).toBe(false);
    });

    it('fresh=false when only if-none-match header but no _res set', () =>
    {
        const req = makeReq({ method: 'GET', headers: { 'if-none-match': '"abc"' } });
        expect(req.fresh).toBe(false); // _res is not set
    });

    it('fresh=true when ETag matches _res ETag', () =>
    {
        const req = makeReq({ method: 'GET', headers: { 'if-none-match': '"v1"' } });
        req._res = { get: (h) => h === 'ETag' ? '"v1"' : undefined };
        expect(req.fresh).toBe(true);
    });

    it('fresh=false when ETag does not match', () =>
    {
        const req = makeReq({ method: 'GET', headers: { 'if-none-match': '"v1"' } });
        req._res = { get: (h) => h === 'ETag' ? '"v2"' : undefined };
        expect(req.fresh).toBe(false);
    });

    it('fresh=true when Last-Modified is within window', () =>
    {
        const past = new Date(Date.now() - 60_000).toUTCString();
        const req = makeReq({ method: 'GET', headers: { 'if-modified-since': new Date().toUTCString() } });
        req._res = { get: (h) => h === 'Last-Modified' ? past : undefined };
        expect(req.fresh).toBe(true);
    });

    it('fresh=false when Last-Modified is after Since', () =>
    {
        const future = new Date(Date.now() + 60_000).toUTCString();
        const req = makeReq({ method: 'GET', headers: { 'if-modified-since': new Date().toUTCString() } });
        req._res = { get: (h) => h === 'Last-Modified' ? future : undefined };
        expect(req.fresh).toBe(false);
    });

    it('fresh=false when Last-Modified header is not parseable', () =>
    {
        const req = makeReq({ method: 'GET', headers: { 'if-modified-since': 'garbage' } });
        req._res = { get: () => 'also-garbage' };
        expect(req.fresh).toBe(false);
    });

    it('fresh=false when if-modified-since present but _res returns null', () =>
    {
        const req = makeReq({ method: 'GET', headers: { 'if-modified-since': new Date().toUTCString() } });
        req._res = { get: () => null };
        expect(req.fresh).toBe(false);
    });
});

// ===========================================================================
// REQUEST — range()
// ===========================================================================
describe('Request — range()', () =>
{
    it('returns -2 when no Range header', () =>
    {
        expect(makeReq().range(1000)).toBe(-2);
    });

    it('returns -2 for malformed Range header (no type=)', () =>
    {
        const req = makeReq({ headers: { range: 'notvalid' } });
        expect(req.range(1000)).toBe(-2);
    });

    it('parses a simple byte range', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=0-499' } });
        const result = req.range(1000);
        expect(result.type).toBe('bytes');
        expect(result.ranges).toHaveLength(1);
        expect(result.ranges[0]).toEqual({ start: 0, end: 499 });
    });

    it('parses multiple ranges', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=0-99,200-299' } });
        const result = req.range(1000);
        expect(result.ranges).toHaveLength(2);
        expect(result.ranges[1]).toEqual({ start: 200, end: 299 });
    });

    it('open-ended range end defaults to size-1', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=100-' } });
        const result = req.range(500);
        expect(result.ranges[0]).toEqual({ start: 100, end: 499 });
    });

    it('suffix range: bytes=-200 gives last 200 bytes', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=-200' } });
        const result = req.range(1000);
        expect(result.ranges[0]).toEqual({ start: 800, end: 999 });
    });

    it('returns -1 when start > end', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=500-100' } });
        expect(req.range(1000)).toBe(-1);
    });

    it('returns -1 when start >= size', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=1000-1010' } });
        expect(req.range(1000)).toBe(-1);
    });

    it('clamps end to size-1', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=0-9999' } });
        const result = req.range(500);
        expect(result.ranges[0].end).toBe(499);
    });

    it('returns -2 for range without dash separator', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=100' } });
        expect(req.range(1000)).toBe(-2);
    });

    it('returns -2 for NaN start', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=abc-100' } });
        expect(req.range(1000)).toBe(-2);
    });

    it('suffix range with suffix > size clamps to 0', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=-9999' } });
        const result = req.range(100);
        expect(result.ranges[0].start).toBe(0);
        expect(result.ranges[0].end).toBe(99);
    });
});

// ===========================================================================
// RESPONSE — construction and status()
// ===========================================================================
describe('Response — status and basic send', () =>
{
    it('default _status is 200', () =>
    {
        const res = makeRes();
        expect(res._status).toBe(200);
    });

    it('status() chains and sets _status', () =>
    {
        const res = makeRes();
        const ret = res.status(404);
        expect(ret).toBe(res);
        expect(res._status).toBe(404);
    });

    it('send() is a no-op after first call (_sent guard)', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send('first');
        const chunksBefore = rawRes._chunks.length;
        res.send('second');
        expect(rawRes._chunks.length).toBe(chunksBefore); // second call ignored
    });

    it('send(null) ends without body', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send(null);
        expect(rawRes._ended).toBe(true);
        expect(rawRes._chunks).toHaveLength(0);
    });

    it('send(undefined) ends without body', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send(undefined);
        expect(rawRes._ended).toBe(true);
    });

    it('send(Buffer) uses octet-stream content-type when not set', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send(Buffer.from([1, 2, 3]));
        expect(rawRes._headers['Content-Type']).toBe('application/octet-stream');
    });

    it('send(Buffer) respects already-set content-type', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.set('Content-Type', 'image/png').send(Buffer.from([0x89]));
        expect(rawRes._headers['Content-Type']).toBe('image/png');
    });

    it('send(string starting with <) detects HTML', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send('<h1>Hello</h1>');
        expect(rawRes._headers['Content-Type']).toBe('text/html');
    });

    it('send(string with leading whitespace then <) detects HTML', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send('  \n  <html></html>');
        expect(rawRes._headers['Content-Type']).toBe('text/html');
    });

    it('send(plain string) uses text/plain', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send('hello world');
        expect(rawRes._headers['Content-Type']).toBe('text/plain');
    });

    it('send(object) serialises as JSON', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send({ x: 1 });
        expect(rawRes._headers['Content-Type']).toBe('application/json');
        const body = rawRes._chunks[0];
        expect(JSON.parse(body)).toEqual({ x: 1 });
    });

    it('send(circular object) returns 500 JSON error', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        const circ = {};
        circ.self = circ;
        res.send(circ);
        expect(rawRes.statusCode).toBe(500);
        const body = JSON.parse(rawRes._chunks[rawRes._chunks.length - 1]);
        expect(body.error).toMatch(/serialize/i);
    });

    it('send(BigInt value) returns 500 JSON error', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.send({ n: BigInt(1) });
        expect(rawRes.statusCode).toBe(500);
    });
});

// ===========================================================================
// RESPONSE — type(), json(), text(), html(), sendStatus()
// ===========================================================================
describe('Response — type aliases and convenience senders', () =>
{
    it('type("json") sets application/json', () =>
    {
        const res = makeRes();
        res.type('json');
        expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('type("html") sets text/html', () =>
    {
        expect(makeRes().type('html')._headers['Content-Type']).toBe('text/html');
    });

    it('type("text") sets text/plain', () =>
    {
        expect(makeRes().type('text')._headers['Content-Type']).toBe('text/plain');
    });

    it('type("xml") sets application/xml', () =>
    {
        expect(makeRes().type('xml')._headers['Content-Type']).toBe('application/xml');
    });

    it('type("form") sets application/x-www-form-urlencoded', () =>
    {
        expect(makeRes().type('form')._headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('type("bin") sets application/octet-stream', () =>
    {
        expect(makeRes().type('bin')._headers['Content-Type']).toBe('application/octet-stream');
    });

    it('type(unknown) passes through as-is', () =>
    {
        expect(makeRes().type('custom/thing')._headers['Content-Type']).toBe('custom/thing');
    });

    it('json() sets Content-Type and serialises', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.json({ a: 1 });
        expect(rawRes._headers['Content-Type']).toBe('application/json');
    });

    it('text() coerces to string', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.text(42);
        const body = rawRes._chunks[0];
        expect(body).toBe('42');
    });

    it('html() sets text/html and sends', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.html('<b>hi</b>');
        expect(rawRes._headers['Content-Type']).toBe('text/html');
    });

    it('sendStatus(404) sends reason phrase as text body', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.sendStatus(404);
        expect(rawRes.statusCode).toBe(404);
        expect(rawRes._chunks[0]).toContain('Not Found');
    });

    it('sendStatus with unknown code uses numeric string', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.sendStatus(418);
        // 418 is not in STATUS_CODES, so should fallback to '418'
        expect(rawRes.statusCode).toBe(418);
    });
});

// ===========================================================================
// RESPONSE — set(), get(), append(), vary()
// ===========================================================================
describe('Response — header manipulation', () =>
{
    it('set() stores header', () =>
    {
        const res = makeRes();
        res.set('X-Custom', 'hello');
        expect(res._headers['X-Custom']).toBe('hello');
    });

    it('set() returns this for chaining', () =>
    {
        const res = makeRes();
        expect(res.set('X-A', '1')).toBe(res);
    });

    it('set() throws on CRLF injection in name', () =>
    {
        expect(() => makeRes().set('X-Bad\r\nHeader', 'val')).toThrow(/CR or LF/);
    });

    it('set() throws on CRLF injection in value', () =>
    {
        expect(() => makeRes().set('X-Good', 'val\r\nX-Injected: bad')).toThrow(/CR or LF/);
    });

    it('get() is case-insensitive lookup', () =>
    {
        const res = makeRes();
        res.set('Content-Type', 'text/plain');
        expect(res.get('content-type')).toBe('text/plain');
        expect(res.get('CONTENT-TYPE')).toBe('text/plain');
    });

    it('get() returns undefined for missing header', () =>
    {
        expect(makeRes().get('X-Missing')).toBeUndefined();
    });

    it('append() creates header when absent', () =>
    {
        const res = makeRes();
        res.append('X-Tag', 'v1');
        expect(res._headers['X-Tag']).toBe('v1');
    });

    it('append() comma-joins when header exists', () =>
    {
        const res = makeRes();
        res.set('X-Tag', 'v1').append('X-Tag', 'v2');
        expect(res._headers['X-Tag']).toBe('v1, v2');
    });

    it('append() throws on CRLF in value', () =>
    {
        expect(() => makeRes().append('X-Bad', 'val\r\n')).toThrow(/CR or LF/);
    });

    it('vary() adds field to Vary header', () =>
    {
        const res = makeRes();
        res.vary('Accept');
        expect(res._headers['Vary']).toBe('Accept');
    });

    it('vary() de-duplicates fields case-insensitively', () =>
    {
        const res = makeRes();
        res.vary('Accept').vary('accept');
        expect(res._headers['Vary']).toBe('Accept');
    });

    it('vary("*") wins and cannot be extended', () =>
    {
        const res = makeRes();
        res.vary('*').vary('Accept');
        expect(res._headers['Vary']).toBe('*');
    });

    it('vary() existing "*" returns early', () =>
    {
        const res = makeRes();
        res.set('Vary', '*').vary('Accept');
        expect(res._headers['Vary']).toBe('*');
    });
});

// ===========================================================================
// RESPONSE — redirect()
// ===========================================================================
describe('Response — redirect()', () =>
{
    it('redirect defaults to 302', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.redirect('/new');
        expect(rawRes.statusCode).toBe(302);
        expect(res._headers['Location']).toBe('/new');
    });

    it('redirect with explicit status', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res.redirect(301, '/permanent');
        expect(rawRes.statusCode).toBe(301);
        expect(res._headers['Location']).toBe('/permanent');
    });

    it('redirect is no-op if already sent', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._sent = true;
        res.redirect('/x');
        expect(rawRes._ended).toBe(false);
    });
});

// ===========================================================================
// RESPONSE — links(), location()
// ===========================================================================
describe('Response — links() and location()', () =>
{
    it('links() builds Link header', () =>
    {
        const res = makeRes();
        res.links({ next: '/page/2', last: '/page/5' });
        const link = res._headers['Link'];
        expect(link).toContain('rel="next"');
        expect(link).toContain('rel="last"');
    });

    it('links() appends to existing Link header', () =>
    {
        const res = makeRes();
        res.links({ prev: '/page/1' }).links({ next: '/page/3' });
        expect(res._headers['Link']).toContain('prev');
        expect(res._headers['Link']).toContain('next');
    });

    it('location() sets Location header', () =>
    {
        const res = makeRes();
        res.location('/somewhere');
        expect(res._headers['Location']).toBe('/somewhere');
    });
});

// ===========================================================================
// RESPONSE — cookie() and clearCookie()
// ===========================================================================
describe('Response — cookie() and clearCookie()', () =>
{
    it('cookie() sets basic Set-Cookie header', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('session', 'abc');
        const sc = rawRes._headers['Set-Cookie'];
        expect(sc).toContain('session=');
        expect(sc).toContain('abc');
        expect(sc).toContain('HttpOnly');
        expect(sc).toContain('SameSite=Lax');
    });

    it('cookie() includes Domain when provided', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { domain: 'example.com' });
        expect(rawRes._headers['Set-Cookie']).toContain('Domain=example.com');
    });

    it('cookie() sets Max-Age', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { maxAge: 3600 });
        expect(rawRes._headers['Set-Cookie']).toContain('Max-Age=3600');
    });

    it('cookie() sets Expires from Date object', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        const exp = new Date('2030-01-01');
        res.cookie('x', '1', { expires: exp });
        expect(rawRes._headers['Set-Cookie']).toContain('Expires=');
    });

    it('cookie() sets Expires from millisecond timestamp', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { expires: new Date('2030-06-01').getTime() });
        expect(rawRes._headers['Set-Cookie']).toContain('Expires=');
    });

    it('cookie() sets Secure flag', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { secure: true });
        expect(rawRes._headers['Set-Cookie']).toContain('; Secure');
    });

    it('cookie() respects httpOnly: false', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { httpOnly: false });
        expect(rawRes._headers['Set-Cookie']).not.toContain('HttpOnly');
    });

    it('cookie() SameSite=Strict', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { sameSite: 'Strict' });
        expect(rawRes._headers['Set-Cookie']).toContain('SameSite=Strict');
    });

    it('cookie() serialises object values as j: JSON', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('prefs', { theme: 'dark' });
        const sc = rawRes._headers['Set-Cookie'];
        expect(sc).toContain('j%3A'); // URL-encoded j:
    });

    it('cookie() signed option requires secret or throws', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        expect(() => res.cookie('x', 'val', { signed: true })).toThrow(/secret/i);
    });

    it('cookie() signed with secret produces s: prefix', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('tok', 'myval', { signed: true, secret: 'testsecret' });
        const sc = rawRes._headers['Set-Cookie'];
        // URL-encoded 's:' → 's%3A'
        expect(sc).toContain('s%3A');
    });

    it('cookie() Priority and Partitioned attributes', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('x', '1', { priority: 'High', partitioned: true });
        const sc = rawRes._headers['Set-Cookie'];
        expect(sc).toContain('Priority=High');
        expect(sc).toContain('Partitioned');
    });

    it('cookie() throws on illegal name characters', () =>
    {
        const res = makeRes();
        expect(() => res.cookie('bad name', 'v')).toThrow(/Cookie name/);
        expect(() => res.cookie('bad=name', 'v')).toThrow(/Cookie name/);
        expect(() => res.cookie('bad;name', 'v')).toThrow(/Cookie name/);
    });

    it('cookie() appends to existing Set-Cookie array', () =>
    {
        const rawRes = mockRawRes();
        const existing = ['a=1'];
        rawRes.getHeader = () => existing;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('b', '2');
        const sc = rawRes._headers['Set-Cookie'];
        expect(Array.isArray(sc)).toBe(true);
        expect(sc.length).toBe(2);
    });

    it('cookie() appends to existing single Set-Cookie string', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => 'a=1';
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.cookie('b', '2');
        const sc = rawRes._headers['Set-Cookie'];
        expect(Array.isArray(sc)).toBe(true);
        expect(sc).toContain('a=1');
    });

    it('clearCookie() sets MaxAge=0 and past Expires', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = (k, v) => { rawRes._headers[k] = v; };
        const res = new Response(rawRes);
        res.clearCookie('session');
        const sc = rawRes._headers['Set-Cookie'];
        expect(sc).toContain('Max-Age=0');
    });
});

// ===========================================================================
// RESPONSE — format()
// ===========================================================================
describe('Response — format()', () =>
{
    it('calls handler matching Accept: application/json', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._req = { headers: { accept: 'application/json' } };
        let called = null;
        res.format({
            'application/json': () => { called = 'json'; },
            'text/html': () => { called = 'html'; },
        });
        expect(called).toBe('json');
    });

    it('format() falls through to default when no match', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._req = { headers: { accept: 'image/gif' } };
        let called = null;
        res.format({
            'text/html': () => { called = 'html'; },
            default: () => { called = 'default'; },
        });
        expect(called).toBe('default');
    });

    it('format() sends 406 when no match and no default', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._req = { headers: { accept: 'image/gif' } };
        res.format({ 'text/html': () => {} });
        expect(rawRes.statusCode).toBe(406);
    });

    it('format() with */* accept calls first handler', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._req = { headers: { accept: '*/*' } };
        let called = null;
        res.format({
            'application/json': () => { called = 'json'; },
        });
        expect(called).toBe('json');
    });

    it('format() checks main-type wildcard text/*', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._req = { headers: { accept: 'text/*' } };
        let called = null;
        res.format({
            'text/html': () => { called = 'html'; },
        });
        expect(called).toBe('html');
    });

    it('format() works with no _req (falls back to */*)', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        // no _req set
        let called = null;
        res.format({ 'application/json': () => { called = 'json'; } });
        expect(called).toBe('json');
    });
});

// ===========================================================================
// RESPONSE — sse()
// ===========================================================================
describe('Response — sse()', () =>
{
    it('returns null when already sent', () =>
    {
        const rawRes = mockRawRes({ writeHead: () => {} });
        const res = new Response(rawRes);
        res._sent = true;
        expect(res.sse()).toBeNull();
    });

    it('returns SSEStream on first call and marks _sent', () =>
    {
        const rawRes = mockRawRes();
        rawRes.writeHead = () => {};
        rawRes.write = () => {};
        const res = new Response(rawRes);
        const stream = res.sse();
        expect(stream).not.toBeNull();
        expect(res._sent).toBe(true);
    });
});

// ===========================================================================
// RESPONSE — sendFile() via real tmp file
// ===========================================================================
describe('Response — sendFile()', () =>
{
    let tmpFile;

    beforeAll(() =>
    {
        tmpFile = path.join(os.tmpdir(), 'zero-http-res-test-' + process.pid + '.txt');
        fs.writeFileSync(tmpFile, 'hello world');
    });

    afterAll(() =>
    {
        try { fs.unlinkSync(tmpFile); } catch {}
    });

    /** A PassThrough stream with the header API that Response expects. */
    function makeStreamableRaw()
    {
        const raw = new PassThrough();
        raw._headers    = {};
        raw.statusCode  = 200;
        raw.headersSent = false;
        raw.setHeader   = (k, v) => { raw._headers[k] = v; };
        raw.getHeader   = (k)    => raw._headers[k];
        raw.removeHeader= (k)    => { delete raw._headers[k]; };
        return raw;
    }

    it('pipes file content with correct MIME type', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            const chunks = [];
            raw.on('data', c => chunks.push(c));
            raw.on('end', () =>
            {
                expect(raw._headers['Content-Type']).toBe('text/plain');
                expect(Buffer.concat(chunks).toString()).toBe('hello world');
                resolve();
            });
            raw.on('error', reject);
            res.sendFile(tmpFile);
        });
    });

    it('returns 404 when file does not exist', () =>
    {
        return new Promise((resolve) =>
        {
            const rawRes = mockRawRes();
            const res = new Response(rawRes);
            res.status = function(code) { rawRes.statusCode = code; return this; };
            res.json   = function(body) { rawRes._body = body; resolve(); };
            res.sendFile('/absolutely/nonexistent/file.txt');
        });
    });

    it('callback receives error on missing file', () =>
    {
        return new Promise((resolve) =>
        {
            const rawRes = mockRawRes();
            const res = new Response(rawRes);
            res.sendFile('/no/such/file.xyz', {}, (err) =>
            {
                expect(err).toBeTruthy();
                expect(err.status).toBe(404);
                resolve();
            });
        });
    });

    it('path traversal is blocked when root is set', () =>
    {
        return new Promise((resolve) =>
        {
            const rawRes = mockRawRes();
            const res = new Response(rawRes);
            res.status = function(code) { rawRes.statusCode = code; return this; };
            res.json   = function(body) { rawRes._body = body; resolve(); };
            res.sendFile('../../etc/passwd', { root: os.tmpdir() });
        });
    });

    it('null byte in path is rejected', () =>
    {
        return new Promise((resolve) =>
        {
            const rawRes = mockRawRes();
            const res = new Response(rawRes);
            res.status = function(code) { rawRes.statusCode = code; return this; };
            res.json   = function(body) { rawRes._body = body; resolve(); };
            res.sendFile('file\0.txt');
        });
    });

    it('sendFile is a no-op when already sent', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._sent = true;
        res.sendFile(tmpFile); // should return immediately — no throw
    });

    it('opts can be omitted (signature overload)', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume(); // drain
            res.sendFile(tmpFile, (err) =>
            {
                if (err) reject(err);
                else resolve();
            });
        });
    });
});

// ===========================================================================
// RESPONSE — download()
// ===========================================================================
describe('Response — download()', () =>
{
    let tmpFile;
    beforeAll(() =>
    {
        tmpFile = path.join(os.tmpdir(), 'zero-http-dl-' + process.pid + '.bin');
        fs.writeFileSync(tmpFile, Buffer.from([0xDE, 0xAD]));
    });
    afterAll(() => { try { fs.unlinkSync(tmpFile); } catch {} });

    /** A PassThrough stream with the header API that Response expects. */
    function makeStreamableRaw()
    {
        const raw = new PassThrough();
        raw._headers    = {};
        raw.statusCode  = 200;
        raw.headersSent = false;
        raw.setHeader   = (k, v) => { raw._headers[k] = v; };
        raw.getHeader   = (k)    => raw._headers[k];
        raw.removeHeader= (k)    => { delete raw._headers[k]; };
        return raw;
    }

    it('sets Content-Disposition: attachment with provided filename', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume(); // drain so 'end' fires
            raw.on('end', () =>
            {
                expect(res._headers['Content-Disposition']).toContain('attachment');
                expect(res._headers['Content-Disposition']).toContain('download.bin');
                resolve();
            });
            raw.on('error', reject);
            res.download(tmpFile, 'download.bin');
        });
    });

    it('uses basename when no filename provided', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume();
            raw.on('end', () => resolve());
            raw.on('error', reject);
            res.download(tmpFile);
        });
    });

    it('callback receives null on success', () =>
    {
        return new Promise((resolve) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume();
            res.download(tmpFile, 'test.bin', (err) =>
            {
                expect(err).toBeNull();
                resolve();
            });
        });
    });
});

// ===========================================================================
// REQUEST — subdomains no-host branch (line 157)
// ===========================================================================
describe('Request — subdomains no-host edge case', () =>
{
    it('returns empty array when no host header is present', () =>
    {
        // hostname is '' (falsy) → triggers the `|| ''` branch in subdomains()
        const req = makeReq({ headers: {} });
        expect(req.subdomains()).toEqual([]);
    });
});

// ===========================================================================
// REQUEST — range() NaN-suffix branch (line 285)
// ===========================================================================
describe('Request — range() NaN suffix branch', () =>
{
    it('returns -2 for bytes=-abc (NaN suffix)', () =>
    {
        const req = makeReq({ headers: { range: 'bytes=-abc' } });
        expect(req.range(1000)).toBe(-2);
    });
});

// ===========================================================================
// RESPONSE — sendFile() opts.headers and stream-error branches (lines 340-351)
// ===========================================================================
describe('Response — sendFile() opts.headers and stream error', () =>
{
    let tmpFile;

    beforeAll(() =>
    {
        tmpFile = path.join(os.tmpdir(), 'zero-http-opts-headers-' + process.pid + '.txt');
        fs.writeFileSync(tmpFile, 'opts-headers-test');
    });

    afterAll(() => { try { fs.unlinkSync(tmpFile); } catch {} });

    function makeStreamableRaw()
    {
        const raw = new PassThrough();
        raw._headers    = {};
        raw.statusCode  = 200;
        raw.headersSent = false;
        raw.setHeader   = (k, v) => { raw._headers[k] = v; };
        raw.getHeader   = (k)    => raw._headers[k];
        raw.removeHeader= (k)    => { delete raw._headers[k]; };
        return raw;
    }

    it('opts.headers are forwarded to the raw response', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume();
            raw.on('end', () =>
            {
                // opts.headers block (lines 340-341) executed
                expect(raw._headers['X-Test-Header']).toBe('present');
                resolve();
            });
            raw.on('error', reject);
            res.sendFile(tmpFile, { headers: { 'X-Test-Header': 'present' } });
        });
    });

    it('stream error without callback sets statusCode 500 (lines 350-351)', () =>
    {
        return new Promise((resolve) =>
        {
            // Intercept createReadStream to inject a stream that errors
            const origCreateReadStream = fs.createReadStream;
            const { Readable } = require('stream');
            const fakeStream = new Readable({ read() {} });
            fs.createReadStream = (...args) => {
                fs.createReadStream = origCreateReadStream; // restore immediately
                return fakeStream;
            };

            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume(); // drain so pipe doesn't back-pressure
            res.sendFile(tmpFile);

            // Trigger error on the fake stream after stat passes
            setTimeout(() =>
            {
                fakeStream.emit('error', new Error('injected read error'));
                setTimeout(() =>
                {
                    // The error handler (no cb) sets 500 and calls raw.end()
                    expect(raw.statusCode).toBe(500);
                    resolve();
                }, 10);
            }, 20);
        });
    });

    it('stream error WITH callback calls cb(err) (lines 350)', () =>
    {
        return new Promise((resolve) =>
        {
            const origCreateReadStream = fs.createReadStream;
            const { Readable } = require('stream');
            const fakeStream2 = new Readable({ read() {} });
            fs.createReadStream = (...args) => {
                fs.createReadStream = origCreateReadStream;
                return fakeStream2;
            };

            const raw = makeStreamableRaw();
            const res = new Response(raw);
            raw.resume();
            res.sendFile(tmpFile, {}, (err) =>
            {
                expect(err).toBeInstanceOf(Error);
                expect(err.message).toContain('injected cb error');
                resolve();
            });

            setTimeout(() =>
            {
                fakeStream2.emit('error', new Error('injected cb error'));
            }, 20);
        });
    });
});

// ===========================================================================
// RESPONSE — sse() pad and retry options (lines 614-621)
// ===========================================================================
describe('Response — sse() pad and retry options', () =>
{
    it('sse({ pad }) writes padding comment', () =>
    {
        const rawRes = mockRawRes();
        const chunks = [];
        rawRes.write = (c) => { chunks.push(String(c)); return true; };
        rawRes.writeHead = () => {};
        const res = new Response(rawRes);
        res.sse({ pad: 5 });
        const joined = chunks.join('');
        expect(joined).toContain(': ');
    });

    it('sse({ retry }) writes retry directive', () =>
    {
        const rawRes = mockRawRes();
        const chunks = [];
        rawRes.write = (c) => { chunks.push(String(c)); return true; };
        rawRes.writeHead = () => {};
        const res = new Response(rawRes);
        res.sse({ retry: 3000 });
        const joined = chunks.join('');
        expect(joined).toContain('retry:');
        expect(joined).toContain('3000');
    });
});

// ===========================================================================
// RESPONSE — headersSent proxy
// ===========================================================================
describe('Response — headersSent', () =>
{
    it('reflects raw.headersSent=false', () =>
    {
        const rawRes = mockRawRes({ headersSent: false });
        expect(new Response(rawRes).headersSent).toBe(false);
    });

    it('reflects raw.headersSent=true', () =>
    {
        const rawRes = mockRawRes({ headersSent: true });
        expect(new Response(rawRes).headersSent).toBe(true);
    });
});

// ===========================================================================
// RESPONSE — sendFile() error callback paths (L309, L318, L326, L328)
// ===========================================================================
describe('Response — sendFile() error paths with callbacks', () =>
{
    function makeStreamableRaw3()
    {
        const raw = new PassThrough();
        raw._headers     = {};
        raw.statusCode   = 200;
        raw.headersSent  = false;
        raw.setHeader    = (k, v) => { raw._headers[k] = v; };
        raw.getHeader    = (k)    => raw._headers[k];
        raw.removeHeader = (k)    => { delete raw._headers[k]; };
        return raw;
    }

    it('path traversal with cb — cb(err) called with 403 (L309)', () =>
    {
        return new Promise((resolve) =>
        {
            const raw = mockRawRes();
            const res = new Response(raw);
            res.sendFile('../../etc/passwd', { root: os.tmpdir() }, (err) =>
            {
                expect(err).toBeTruthy();
                expect(err.status).toBe(403);
                resolve();
            });
        });
    });

    it('null byte in path with cb — cb(err) called with 400 (L318)', () =>
    {
        return new Promise((resolve) =>
        {
            const raw = mockRawRes();
            const res = new Response(raw);
            res.sendFile('fi\x00le.txt', {}, (err) =>
            {
                expect(err).toBeTruthy();
                expect(err.status).toBe(400);
                resolve();
            });
        });
    });

    it('directory path without cb — L326 right-side new Error branch', () =>
    {
        return new Promise((resolve) =>
        {
            const rawRes = mockRawRes();
            const res = new Response(rawRes);
            res.status = (code) => { rawRes.statusCode = code; return res; };
            res.json   = () => { resolve(); };
            res.sendFile(os.tmpdir()); // exists but is a directory
        });
    });

    it('directory path with cb — cb(err) called with 404 (L328)', () =>
    {
        return new Promise((resolve) =>
        {
            const raw = makeStreamableRaw3();
            const res = new Response(raw);
            raw.resume();
            res.sendFile(os.tmpdir(), {}, (err) =>
            {
                expect(err).toBeTruthy();
                expect(err.status).toBe(404);
                resolve();
            });
        });
    });

    it('stream error no-cb path — sets statusCode 500 (L350 FALSE branch)', () =>
    {
        return new Promise((resolve) =>
        {
            const { Readable } = require('stream');
            const fakeStream = new Readable({ read() {} });

            const origCreate = fs.createReadStream;
            fs.createReadStream = (...args) =>
            {
                fs.createReadStream = origCreate;
                return fakeStream;
            };

            const tmpF = path.join(os.tmpdir(), 'zero-err-nocb-' + process.pid + '.txt');
            fs.writeFileSync(tmpF, 'content');

            const raw = makeStreamableRaw3();
            const res = new Response(raw);
            raw.resume();
            res.sendFile(tmpF);

            setTimeout(() =>
            {
                fakeStream.emit('error', new Error('injected no-cb error'));
                setTimeout(() =>
                {
                    expect(raw.statusCode).toBe(500);
                    try { fs.unlinkSync(tmpF); } catch {}
                    resolve();
                }, 10);
            }, 20);
        });
    });
});

// ===========================================================================
// RESPONSE — download() with callback as 2nd argument (L370)
// ===========================================================================
describe('Response — download() with callback as 2nd arg', () =>
{
    let dlFile;

    beforeAll(() =>
    {
        dlFile = path.join(os.tmpdir(), 'zero-dl-cb-' + process.pid + '.txt');
        fs.writeFileSync(dlFile, 'download content');
    });

    afterAll(() => { try { fs.unlinkSync(dlFile); } catch {} });

    it('typeof filename === "function" sets cb and uses basename (L370)', () =>
    {
        return new Promise((resolve, reject) =>
        {
            const raw = new PassThrough();
            raw._headers    = {};
            raw.statusCode  = 200;
            raw.headersSent = false;
            raw.setHeader   = (k, v) => { raw._headers[k] = v; };
            raw.getHeader   = (k)    => raw._headers[k];
            raw.removeHeader= (k)    => { delete raw._headers[k]; };
            raw.resume();

            const res = new Response(raw);
            res.download(dlFile, (err) =>   // callback as 2nd arg — covers L370
            {
                if (err) reject(err);
                else resolve();
            });
        });
    });
});

// ===========================================================================
// RESPONSE — cookie() signed, domain, priority (L422, L434, L450)
// ===========================================================================
describe('Response — cookie() signed / domain / priority', () =>
{
    it('signed cookie without secret throws (L422)', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        const res = new Response(rawRes);
        expect(() => res.cookie('auth', 'user', { signed: true })).toThrow(/cookieParser/);
    });

    it('signed cookie uses opts.secret when _req.secret absent', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = vi.fn();
        const res = new Response(rawRes);
        res.cookie('auth', 'user123', { signed: true, secret: 'my-app-secret' });
        const call = rawRes.setHeader.mock.calls.find(c => c[0] === 'Set-Cookie');
        expect(call).toBeTruthy();
    });

    it('domain option appends Domain attribute (L434)', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = vi.fn();
        const res = new Response(rawRes);
        res.cookie('name', 'val', { domain: '.example.com' });
        const cookie = rawRes.setHeader.mock.calls[0][1];
        expect(cookie).toContain('Domain=.example.com');
    });

    it('priority option appends Priority attribute (L450)', () =>
    {
        const rawRes = mockRawRes();
        rawRes.getHeader = () => undefined;
        rawRes.setHeader = vi.fn();
        const res = new Response(rawRes);
        res.cookie('name', 'val', { priority: 'High' });
        const cookie = rawRes.setHeader.mock.calls[0][1];
        expect(cookie).toContain('Priority=High');
    });
});

// ===========================================================================
// RESPONSE — redirect() when _sent already true (L560)
// ===========================================================================
describe('Response — redirect() is no-op when _sent=true', () =>
{
    it('returns immediately without modifying status or body (L560)', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        res._sent = true;
        res.redirect('/elsewhere');
        expect(rawRes.statusCode).toBe(200);  // unchanged
        expect(rawRes._ended).toBe(false);
    });
});
