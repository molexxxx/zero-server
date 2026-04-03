'use strict';
/** trust-proxy.test.js — Trust Proxy system: branch, statement, function coverage */

const http = require('http');
const { doFetch } = require('../_helpers');
const { createApp } = require('../../');
const Request  = require('../../lib/http/request');
const { compileTrust } = require('../../lib/http/request');

// ---------------------------------------------------------------------------
// Minimal mock factory (unit-level, no server)
// ---------------------------------------------------------------------------
function mockRaw(overrides = {})
{
    return {
        method:  'GET',
        url:     '/',
        headers: {},
        httpVersion: '1.1',
        httpVersionMajor: 1,
        socket:  { remoteAddress: '127.0.0.1', encrypted: false },
        ...overrides,
    };
}

function makeReq(overrides = {}, trustProxy = false)
{
    const req = new Request(mockRaw(overrides));
    req.app = { set: (k) => k === 'trust proxy' ? trustProxy : undefined };
    return req;
}

// ===========================================================================
// compileTrust() — all input types
// ===========================================================================
describe('compileTrust()', () =>
{
    it('returns the same function when given a function', () =>
    {
        const fn = (addr) => addr === '10.0.0.1';
        expect(compileTrust(fn)).toBe(fn);
    });

    it('true trusts loopback (127.0.0.1)', () =>
    {
        const fn = compileTrust(true);
        expect(fn('127.0.0.1')).toBe(true);
    });

    it('true trusts loopback (::1)', () =>
    {
        const fn = compileTrust(true);
        expect(fn('::1')).toBe(true);
    });

    it('true trusts IPv4-mapped IPv6 loopback', () =>
    {
        const fn = compileTrust(true);
        expect(fn('::ffff:127.0.0.1')).toBe(true);
    });

    it('true trusts full 127.x range', () =>
    {
        const fn = compileTrust(true);
        expect(fn('127.0.0.2')).toBe(true);
        expect(fn('127.255.255.255')).toBe(true);
    });

    it('true rejects non-loopback', () =>
    {
        const fn = compileTrust(true);
        expect(fn('10.0.0.1')).toBe(false);
        expect(fn('192.168.1.1')).toBe(false);
    });

    it('"loopback" string behaves like true', () =>
    {
        const fn = compileTrust('loopback');
        expect(fn('127.0.0.1')).toBe(true);
        expect(fn('::1')).toBe(true);
        expect(fn('10.0.0.1')).toBe(false);
    });

    it('false trusts nothing', () =>
    {
        const fn = compileTrust(false);
        expect(fn('127.0.0.1')).toBe(false);
        expect(fn('::1')).toBe(false);
    });

    it('undefined trusts nothing', () =>
    {
        const fn = compileTrust(undefined);
        expect(fn('127.0.0.1')).toBe(false);
    });

    it('null trusts nothing', () =>
    {
        const fn = compileTrust(null);
        expect(fn('10.0.0.1')).toBe(false);
    });

    it('0 trusts nothing', () =>
    {
        const fn = compileTrust(0);
        expect(fn('127.0.0.1')).toBe(false);
    });

    it('positive number trusts everything (hop-count mode)', () =>
    {
        const fn = compileTrust(2);
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('192.168.1.1')).toBe(true);
    });

    it('string with single IP trusts exact match', () =>
    {
        const fn = compileTrust('10.0.0.1');
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.0.0.2')).toBe(false);
    });

    it('string with comma-separated IPs', () =>
    {
        const fn = compileTrust('10.0.0.1, 10.0.0.2');
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.0.0.2')).toBe(true);
        expect(fn('10.0.0.3')).toBe(false);
    });

    it('array of IPs', () =>
    {
        const fn = compileTrust(['10.0.0.1', '10.0.0.2']);
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.0.0.2')).toBe(true);
        expect(fn('10.0.0.3')).toBe(false);
    });

    it('IPv4 CIDR range', () =>
    {
        const fn = compileTrust('10.0.0.0/8');
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.255.255.255')).toBe(true);
        expect(fn('11.0.0.1')).toBe(false);
    });

    it('IPv4 /16 CIDR', () =>
    {
        const fn = compileTrust('192.168.0.0/16');
        expect(fn('192.168.0.1')).toBe(true);
        expect(fn('192.168.255.255')).toBe(true);
        expect(fn('192.169.0.1')).toBe(false);
    });

    it('IPv4 /32 CIDR (exact match)', () =>
    {
        const fn = compileTrust('10.0.0.1/32');
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.0.0.2')).toBe(false);
    });

    it('IPv6 CIDR range', () =>
    {
        const fn = compileTrust('fe80::/10');
        expect(fn('fe80::1')).toBe(true);
        expect(fn('fe80::abcd:1234')).toBe(true);
        expect(fn('2001:db8::1')).toBe(false);
    });

    it('IPv6 /128 CIDR (exact match)', () =>
    {
        const fn = compileTrust('::1/128');
        expect(fn('::1')).toBe(true);
        expect(fn('::2')).toBe(false);
    });

    it('mixed CIDRs and exact IPs', () =>
    {
        const fn = compileTrust(['10.0.0.0/8', '172.16.0.1']);
        expect(fn('10.5.5.5')).toBe(true);
        expect(fn('172.16.0.1')).toBe(true);
        expect(fn('172.16.0.2')).toBe(false);
    });

    it('named preset "linklocal"', () =>
    {
        const fn = compileTrust('linklocal');
        expect(fn('169.254.0.1')).toBe(true);
        expect(fn('169.254.255.255')).toBe(true);
        expect(fn('169.255.0.1')).toBe(false);
        expect(fn('fe80::1')).toBe(true);
    });

    it('named preset "uniquelocal"', () =>
    {
        const fn = compileTrust('uniquelocal');
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('172.16.0.1')).toBe(true);
        expect(fn('172.31.255.255')).toBe(true);
        expect(fn('172.32.0.1')).toBe(false);
        expect(fn('192.168.0.1')).toBe(true);
        expect(fn('fc00::1')).toBe(true);
    });

    it('named preset "loopback" inside array', () =>
    {
        const fn = compileTrust(['loopback', '10.0.0.1']);
        expect(fn('127.0.0.1')).toBe(true);
        expect(fn('::1')).toBe(true);
        expect(fn('::ffff:127.0.0.1')).toBe(true);
        expect(fn('10.0.0.1')).toBe(true);
        expect(fn('10.0.0.2')).toBe(false);
    });

    it('handles IPv4-mapped IPv6 address matching IPv4 CIDR', () =>
    {
        const fn = compileTrust('192.168.0.0/16');
        expect(fn('::ffff:192.168.1.1')).toBe(true);
        expect(fn('::ffff:10.0.0.1')).toBe(false);
    });

    it('handles IPv4 address matching IPv6 CIDR via mapping', () =>
    {
        const fn = compileTrust('::ffff:192.168.0.0/112');
        expect(fn('192.168.0.1')).toBe(true);
    });

    it('ignores invalid CIDR (no slash)', () =>
    {
        const fn = compileTrust('not-an-ip');
        expect(fn('not-an-ip')).toBe(true); // treated as exact-match string
    });

    it('ignores invalid CIDR (bad prefix)', () =>
    {
        const fn = compileTrust('10.0.0.0/999');
        expect(fn('10.0.0.1')).toBe(false); // invalid CIDR is silently skipped
    });

    it('ignores invalid CIDR (non-IP part)', () =>
    {
        const fn = compileTrust('notip/24');
        expect(fn('notip')).toBe(false);
    });

    it('/0 CIDR trusts everything in address family', () =>
    {
        const fn = compileTrust('0.0.0.0/0');
        expect(fn('1.2.3.4')).toBe(true);
        expect(fn('255.255.255.255')).toBe(true);
    });

    it('non-string non-function non-number/boolean returns always-false', () =>
    {
        const fn = compileTrust({ bad: true });
        expect(fn('127.0.0.1')).toBe(false);
    });
});

// ===========================================================================
// req.ip — trust proxy resolution
// ===========================================================================
describe('req.ip — trust proxy', () =>
{
    it('returns socket IP when no app', () =>
    {
        const req = new Request(mockRaw({ socket: { remoteAddress: '192.168.1.1' } }));
        expect(req.ip).toBe('192.168.1.1');
    });

    it('returns socket IP when trust proxy is false', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '10.0.0.1' }, socket: { remoteAddress: '192.168.1.1' } },
            false,
        );
        expect(req.ip).toBe('192.168.1.1');
    });

    it('returns socket IP when trust proxy is undefined', () =>
    {
        const req = new Request(mockRaw({ socket: { remoteAddress: '192.168.1.1' } }));
        req.app = { set: () => undefined };
        expect(req.ip).toBe('192.168.1.1');
    });

    it('resolves X-Forwarded-For when trust proxy is true', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '203.0.113.50' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.ip).toBe('203.0.113.50');
    });

    it('resolves X-Forwarded-For single hop (loopback)', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '::1' } },
            true,
        );
        expect(req.ip).toBe('1.2.3.4');
    });

    it('multi-hop with all trusted proxies returns leftmost', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 127.0.0.2, 127.0.0.3' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        // All 127.x are trusted, so client is 8.8.8.8
        expect(req.ip).toBe('8.8.8.8');
    });

    it('multi-hop stops at first untrusted address', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1, 127.0.0.2' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        // 10.0.0.1 is not loopback → not trusted → it's the first untrusted
        expect(req.ip).toBe('10.0.0.1');
    });

    it('hop-count mode (number) returns correct client IP', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1, 172.16.0.1' }, socket: { remoteAddress: '192.168.1.1' } },
            1,
        );
        // 1 hop → skip 1 proxy → client is 172.16.0.1
        expect(req.ip).toBe('172.16.0.1');
    });

    it('hop-count mode with 2 hops', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1, 172.16.0.1' }, socket: { remoteAddress: '192.168.1.1' } },
            2,
        );
        // 2 hops → skip 2 proxies → client is 10.0.0.1
        expect(req.ip).toBe('10.0.0.1');
    });

    it('hop-count exceeds chain length returns leftmost', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '192.168.1.1' } },
            50,
        );
        expect(req.ip).toBe('8.8.8.8');
    });

    it('no X-Forwarded-For returns socket IP even when trusted', () =>
    {
        const req = makeReq(
            { socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.ip).toBe('127.0.0.1');
    });

    it('CIDR-based trust resolves correctly', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.5' }, socket: { remoteAddress: '10.0.0.1' } },
            '10.0.0.0/8',
        );
        // 10.0.0.1 (socket) is trusted, 10.0.0.5 is trusted → client is 8.8.8.8
        expect(req.ip).toBe('8.8.8.8');
    });

    it('custom function trust', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.5' }, socket: { remoteAddress: '10.0.0.1' } },
            (addr) => addr.startsWith('10.'),
        );
        expect(req.ip).toBe('8.8.8.8');
    });

    it('caches proxy resolution (same result on second call)', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        const first = req.ip;
        const second = req.ip;
        expect(first).toBe('8.8.8.8');
        expect(second).toBe('8.8.8.8');
    });

    it('empty X-Forwarded-For returns socket IP', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '192.168.1.1' } },
            true,
        );
        expect(req.ip).toBe('192.168.1.1');
    });
});

// ===========================================================================
// req.ips — proxy chain
// ===========================================================================
describe('req.ips — proxy chain', () =>
{
    it('returns empty array when no app', () =>
    {
        const req = new Request(mockRaw());
        expect(req.ips).toEqual([]);
    });

    it('returns empty array when trust proxy is false', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8' } },
            false,
        );
        expect(req.ips).toEqual([]);
    });

    it('returns full chain when trusted', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        // chain = [XFF entries..., socket]
        expect(req.ips).toEqual(['8.8.8.8', '10.0.0.1', '127.0.0.1']);
    });

    it('returns empty when socket IP is not trusted in address-based mode', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '192.168.1.1' } },
            true, // loopback only, 192.168 is not loopback
        );
        // Socket is not trusted → stops immediately → empty ips
        expect(req.ips).toEqual([]);
    });
});

// ===========================================================================
// req.protocol — X-Forwarded-Proto
// ===========================================================================
describe('req.protocol — trust proxy', () =>
{
    it('returns http for plain connection without trust proxy', () =>
    {
        const req = makeReq({}, false);
        expect(req.protocol).toBe('http');
    });

    it('returns https for encrypted socket regardless of trust proxy', () =>
    {
        const req = makeReq({ socket: { remoteAddress: '127.0.0.1', encrypted: true } }, false);
        expect(req.protocol).toBe('https');
    });

    it('returns http when no app', () =>
    {
        const req = new Request(mockRaw());
        expect(req.protocol).toBe('http');
    });

    it('reads X-Forwarded-Proto when trusted', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.protocol).toBe('https');
    });

    it('reads first value from comma-separated X-Forwarded-Proto', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'https, http' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.protocol).toBe('https');
    });

    it('ignores X-Forwarded-Proto when socket IP not trusted', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '192.168.1.1' } },
            true, // loopback only
        );
        expect(req.protocol).toBe('http');
    });

    it('hop-count trust reads X-Forwarded-Proto', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '192.168.1.1' } },
            1,
        );
        expect(req.protocol).toBe('https');
    });

    it('ignores invalid X-Forwarded-Proto values', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'ftp' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.protocol).toBe('http');
    });

    it('returns http when X-Forwarded-Proto missing but trusted', () =>
    {
        const req = makeReq(
            { socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.protocol).toBe('http');
    });
});

// ===========================================================================
// req.secure — derived from protocol
// ===========================================================================
describe('req.secure', () =>
{
    it('true when protocol is https (encrypted socket)', () =>
    {
        const req = makeReq({ socket: { remoteAddress: '127.0.0.1', encrypted: true } }, false);
        expect(req.secure).toBe(true);
    });

    it('true when X-Forwarded-Proto is https + trusted', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.secure).toBe(true);
    });

    it('false for plain HTTP', () =>
    {
        const req = makeReq({}, false);
        expect(req.secure).toBe(false);
    });
});

// ===========================================================================
// req.hostname — trust proxy / X-Forwarded-Host
// ===========================================================================
describe('req.hostname — trust proxy', () =>
{
    it('returns Host header without trust proxy', () =>
    {
        const req = makeReq({ headers: { host: 'example.com', 'x-forwarded-host': 'proxy.com' } }, false);
        expect(req.hostname).toBe('example.com');
    });

    it('reads X-Forwarded-Host when trusted', () =>
    {
        const req = makeReq(
            { headers: { host: 'example.com', 'x-forwarded-host': 'proxy.com' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.hostname).toBe('proxy.com');
    });

    it('strips port from X-Forwarded-Host', () =>
    {
        const req = makeReq(
            { headers: { host: 'example.com', 'x-forwarded-host': 'proxy.com:8080' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.hostname).toBe('proxy.com');
    });

    it('falls back to Host when X-Forwarded-Host missing even if trusted', () =>
    {
        const req = makeReq(
            { headers: { host: 'example.com:3000' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        expect(req.hostname).toBe('example.com');
    });

    it('ignores X-Forwarded-Host when socket not trusted', () =>
    {
        const req = makeReq(
            { headers: { host: 'example.com', 'x-forwarded-host': 'evil.com' }, socket: { remoteAddress: '192.168.1.1' } },
            true, // loopback only — 192.168 is not trusted
        );
        expect(req.hostname).toBe('example.com');
    });

    it('reads :authority pseudo-header for HTTP/2', () =>
    {
        const req = makeReq(
            { headers: { ':authority': 'h2-host.com:443' }, httpVersion: '2.0', httpVersionMajor: 2 },
            false,
        );
        expect(req.hostname).toBe('h2-host.com');
    });

    it('returns empty string when no host header at all', () =>
    {
        const req = makeReq({}, false);
        expect(req.hostname).toBe('');
    });

    it('handles IPv6 host with brackets', () =>
    {
        const req = makeReq({ headers: { host: '[::1]:3000' } }, false);
        expect(req.hostname).toBe('[::1]');
    });

    it('handles IPv6 host without port', () =>
    {
        const req = makeReq({ headers: { host: '[::1]' } }, false);
        expect(req.hostname).toBe('[::1]');
    });

    it('hop-count trust reads X-Forwarded-Host', () =>
    {
        const req = makeReq(
            { headers: { host: 'internal', 'x-forwarded-host': 'public.com' }, socket: { remoteAddress: '10.0.0.1' } },
            1,
        );
        expect(req.hostname).toBe('public.com');
    });
});

// ===========================================================================
// Integration — full-stack trust proxy via HTTP
// ===========================================================================
describe('Trust Proxy — integration (HTTP server)', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.enable('trust proxy');

        app.get('/proxy-info', (req, res) =>
        {
            res.json({
                ip:       req.ip,
                ips:      req.ips,
                protocol: req.protocol,
                secure:   req.secure,
                hostname: req.hostname,
            });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns forwarded IP from X-Forwarded-For', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-For': '203.0.113.50' },
        });
        expect(r.data.ip).toBe('203.0.113.50');
    });

    it('returns full proxy chain in ips', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-For': '203.0.113.50, 10.0.0.1' },
        });
        expect(r.data.ips.length).toBeGreaterThanOrEqual(2);
        expect(r.data.ips[0]).toBe('203.0.113.50');
    });

    it('reads X-Forwarded-Proto', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-Proto': 'https' },
        });
        expect(r.data.protocol).toBe('https');
        expect(r.data.secure).toBe(true);
    });

    it('reads X-Forwarded-Host', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-Host': 'public.example.com:443', 'Host': 'internal' },
        });
        expect(r.data.hostname).toBe('public.example.com');
    });

    it('no forwarded headers falls back to socket values', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`);
        expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(r.data.ip);
        expect(r.data.protocol).toBe('http');
        expect(r.data.secure).toBe(false);
    });
});

// ===========================================================================
// Integration — trust proxy disabled (security)
// ===========================================================================
describe('Trust Proxy — disabled (security)', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        // trust proxy is NOT enabled (default)

        app.get('/proxy-info', (req, res) =>
        {
            res.json({
                ip:       req.ip,
                protocol: req.protocol,
                hostname: req.hostname,
            });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('ignores X-Forwarded-For when trust proxy disabled', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-For': '203.0.113.50' },
        });
        // Should be the actual socket IP, not the forwarded one
        expect(r.data.ip).not.toBe('203.0.113.50');
    });

    it('ignores X-Forwarded-Proto when trust proxy disabled', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-Proto': 'https' },
        });
        expect(r.data.protocol).toBe('http');
    });

    it('ignores X-Forwarded-Host when trust proxy disabled', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-Host': 'evil.com' },
        });
        expect(r.data.hostname).not.toBe('evil.com');
    });
});

// ===========================================================================
// Integration — hop-count mode
// ===========================================================================
describe('Trust Proxy — hop-count mode', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.set('trust proxy', 1);

        app.get('/proxy-info', (req, res) =>
        {
            res.json({ ip: req.ip, ips: req.ips });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('trusts exactly 1 hop', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-For': '8.8.8.8, 10.0.0.1' },
        });
        // 1 hop → skip 1 proxy from the right (10.0.0.1) → client is last XFF, which is 10.0.0.1
        expect(r.data.ip).toBe('10.0.0.1');
    });
});

// ===========================================================================
// Integration — CIDR mode
// ===========================================================================
describe('Trust Proxy — CIDR mode', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.set('trust proxy', 'loopback, 10.0.0.0/8');

        app.get('/proxy-info', (req, res) =>
        {
            res.json({ ip: req.ip });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('resolves through trusted CIDR proxies', async () =>
    {
        const r = await doFetch(`${base}/proxy-info`, {
            headers: { 'X-Forwarded-For': '203.0.113.50, 10.0.0.5' },
        });
        // Socket is localhost (trusted), 10.0.0.5 is in 10.0.0.0/8 (trusted)
        // → 203.0.113.50 is the client
        expect(r.data.ip).toBe('203.0.113.50');
    });
});

// ===========================================================================
// HTTP/2 pseudo-headers on Request
// ===========================================================================
describe('Request — HTTP/2 pseudo-headers', () =>
{
    it('uses :method over req.method', () =>
    {
        const req = new Request(mockRaw({
            method: 'GET',
            headers: { ':method': 'POST', ':path': '/api' },
        }));
        expect(req.method).toBe('POST');
    });

    it('uses :path over req.url', () =>
    {
        const req = new Request(mockRaw({
            url: '/original',
            headers: { ':path': '/override' },
        }));
        expect(req.url).toBe('/override');
        expect(req.path).toBe('/override');
    });

    it('sets isHTTP2 when httpVersionMajor is 2', () =>
    {
        const req = new Request(mockRaw({ httpVersion: '2.0', httpVersionMajor: 2 }));
        expect(req.isHTTP2).toBe(true);
    });

    it('sets isHTTP2 false for HTTP/1.1', () =>
    {
        const req = new Request(mockRaw({ httpVersion: '1.1', httpVersionMajor: 1 }));
        expect(req.isHTTP2).toBe(false);
    });

    it('reads alpnProtocol from socket', () =>
    {
        const req = new Request(mockRaw({ socket: { remoteAddress: '127.0.0.1', alpnProtocol: 'h2' } }));
        expect(req.alpnProtocol).toBe('h2');
    });

    it('alpnProtocol is null when not negotiated', () =>
    {
        const req = new Request(mockRaw());
        expect(req.alpnProtocol).toBe(null);
    });
});

// ===========================================================================
// Edge cases — _getTrustFn caching
// ===========================================================================
describe('Trust Proxy — internal caching', () =>
{
    it('_getTrustFn returns same function on subsequent calls', () =>
    {
        const req = makeReq({}, true);
        const fn1 = req._getTrustFn();
        const fn2 = req._getTrustFn();
        expect(fn1).toBe(fn2);
    });

    it('_getTrustFn returns always-false when no app', () =>
    {
        const req = new Request(mockRaw());
        const fn = req._getTrustFn();
        expect(fn('127.0.0.1')).toBe(false);
    });

    it('_resolveProxy caches result', () =>
    {
        const req = makeReq(
            { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } },
            true,
        );
        const r1 = req._resolveProxy();
        const r2 = req._resolveProxy();
        expect(r1).toBe(r2); // same object reference
    });
});
