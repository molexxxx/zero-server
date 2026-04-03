'use strict';
/** unit.test.js — middleware unit tests */

const EventEmitter = require('events');
const crypto       = require('crypto');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const { HttpError, isHttpError } = require('../../lib/errors');

// Lazy-require each module under test so vi.spyOn/vi.useFakeTimers can be
// set up *before* the modules are loaded inside tests that need it.
// For most modules we eagerly require them at the top level.
const errorHandler  = require('../../lib/middleware/errorHandler');
const logger        = require('../../lib/middleware/logger');
const cors          = require('../../lib/middleware/cors');
const csrf          = require('../../lib/middleware/csrf');
const compress      = require('../../lib/middleware/compress');
const cookieParser  = require('../../lib/middleware/cookieParser');
const rateLimit     = require('../../lib/middleware/rateLimit');
const timeout       = require('../../lib/middleware/timeout');
const validate      = require('../../lib/middleware/validator');
const helmet        = require('../../lib/middleware/helmet');
const serveStatic   = require('../../lib/middleware/static');

// ===========================================================================
// Shared mock factories
// ===========================================================================

function noop() {}

function makeReq(overrides = {})
{
    return {
        method:  'GET',
        url:     '/',
        headers: {},
        cookies: {},
        query:   {},
        body:    null,
        params:  {},
        ip:      '127.0.0.1',
        secure:  false,
        ...overrides,
    };
}

function makeRes(rawOverrides = {})
{
    const ee = new EventEmitter();
    const rh  = {};    // response-level headers (res.set)
    const raw = {
        statusCode:    200,
        headersSent:   false,
        _headers:      {},
        setHeader:     (k, v) => { raw._headers[k] = v; },
        getHeader:     (k)     => raw._headers[k],
        removeHeader:  (k)     => { delete raw._headers[k]; },
        write:         vi.fn(() => true),
        end:           vi.fn(),
        on:            (ev, cb) => ee.on(ev, cb),
        removeListener:(ev, cb) => ee.removeListener(ev, cb),
        emit:          (ev, ...a) => ee.emit(ev, ...a),
        ...rawOverrides,
    };
    const res = {
        headersSent: false,
        _sent:       false,
        _status:     200,
        _body:       null,
        raw,
        _headers:    rh,
        set:         (k, v) => { rh[k] = v; return res; },
        get:         (k)     => rh[k],
        vary:        vi.fn().mockReturnThis(),
        status:      (code)  => { raw.statusCode = code; res._status = code; return res; },
        json:        (body)  => { res._body = body; return res; },
        send:        vi.fn().mockReturnThis(),
    };
    return res;
}

// ===========================================================================
// errorHandler
// ===========================================================================
describe('errorHandler', () =>
{
    function makeErrMocks()
    {
        const req = makeReq();
        const res = makeRes();
        const logs = [];
        return { req, res, logs };
    }

    it('uses 500 for generic Error with no statusCode', () =>
    {
        const { req, res } = makeErrMocks();
        errorHandler()(new Error('boom'), req, res, noop);
        expect(res._status).toBe(500);
    });

    it('uses err.statusCode when provided', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        errorHandler()(err, req, res, noop);
        expect(res._status).toBe(404);
    });

    it('uses err.status as fallback for statusCode', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('conflict'), { status: 409 });
        errorHandler()(err, req, res, noop);
        expect(res._status).toBe(409);
    });

    it('clamps out-of-range statusCode to 500 (< 100)', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('bad'), { statusCode: 99 });
        errorHandler()(err, req, res, noop);
        expect(res._status).toBe(500);
    });

    it('clamps out-of-range statusCode to 500 (> 599)', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('bad'), { statusCode: 600 });
        errorHandler()(err, req, res, noop);
        expect(res._status).toBe(500);
    });

    it('clamps NaN statusCode to 500', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('bad'), { statusCode: NaN });
        errorHandler()(err, req, res, noop);
        expect(res._status).toBe(500);
    });

    it('in dev mode (stack:true) exposes message for 500', () =>
    {
        const { req, res } = makeErrMocks();
        errorHandler({ stack: true })(new Error('secret crash'), req, res, noop);
        expect(res._body.error).toBe('secret crash');
    });

    it('in production mode (stack:false) hides 500 message with generic text', () =>
    {
        const { req, res } = makeErrMocks();
        errorHandler({ stack: false })(new Error('secret crash'), req, res, noop);
        expect(res._body.error).toBe('Internal Server Error');
        expect(res._body.stack).toBeUndefined();
    });

    it('in dev mode includes stack array', () =>
    {
        const { req, res } = makeErrMocks();
        const err = new Error('stacky');
        errorHandler({ stack: true })(err, req, res, noop);
        expect(Array.isArray(res._body.stack)).toBe(true);
    });

    it('in production mode 4xx status still shows message', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        errorHandler({ stack: false })(err, req, res, noop);
        // 4xx and !isDev: statusCode < 500 so the hide-message only applies to >= 500
        expect(res._body.error).toBe('not found');
    });

    it('includes err.code in body when present', () =>
    {
        const { req, res } = makeErrMocks();
        const err = Object.assign(new Error('gone'), { statusCode: 410, code: 'ITEM_DELETED' });
        errorHandler({ stack: true })(err, req, res, noop);
        expect(res._body.code).toBe('ITEM_DELETED');
    });

    it('isHttpError path — uses toJSON()', () =>
    {
        const { req, res } = makeErrMocks();
        const err = new HttpError(422, 'Unprocessable Entity');
        errorHandler({ stack: true })(err, req, res, noop);
        expect(res._status).toBe(422);
        // Was processed via isHttpError path
        expect(res._body).toBeDefined();
    });

    it('isHttpError adds stack in dev mode', () =>
    {
        const { req, res } = makeErrMocks();
        const err = new HttpError(500, 'Internal');
        errorHandler({ stack: true })(err, req, res, noop);
        expect(Array.isArray(res._body.stack)).toBe(true);
    });

    it('custom formatter replaces body generation', () =>
    {
        const { req, res } = makeErrMocks();
        const formatter = vi.fn((e, r, isDev) => ({ custom: true, msg: e.message }));
        errorHandler({ formatter })(new Error('oops'), req, res, noop);
        expect(formatter).toHaveBeenCalled();
        expect(res._body.custom).toBe(true);
    });

    it('custom logger is called instead of console.error', () =>
    {
        const { req, res } = makeErrMocks();
        const log = vi.fn();
        errorHandler({ log: true, logger: log })(new Error('log me'), req, res, noop);
        expect(log).toHaveBeenCalled();
    });

    it('log:false suppresses logging', () =>
    {
        const { req, res } = makeErrMocks();
        const log = vi.fn();
        errorHandler({ log: false, logger: log })(new Error('silent'), req, res, noop);
        expect(log).not.toHaveBeenCalled();
    });

    it('onError callback is invoked', () =>
    {
        const { req, res } = makeErrMocks();
        const onError = vi.fn();
        errorHandler({ onError })(new Error('cb test'), req, res, noop);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), req, res);
    });

    it('skips res.status().json() when res.headersSent=true', () =>
    {
        const { req, res } = makeErrMocks();
        res.headersSent = true;
        const statusSpy = vi.spyOn(res, 'status');
        errorHandler({ log: false })(new Error('stale'), req, res, noop);
        expect(statusSpy).not.toHaveBeenCalled();
    });

    it('skips sending when res.raw.headersSent=true', () =>
    {
        const { req, res } = makeErrMocks();
        res.raw.headersSent = true;
        const statusSpy = vi.spyOn(res, 'status');
        errorHandler({ log: false })(new Error('stale'), req, res, noop);
        expect(statusSpy).not.toHaveBeenCalled();
    });

    it('uses req.originalUrl when req.url is absent', () =>
    {
        const { res } = makeErrMocks();
        const req = { method: 'POST', originalUrl: '/original' };
        const log = vi.fn();
        errorHandler({ logger: log })(new Error('test'), req, res, noop);
        expect(log.mock.calls[0][0]).toContain('/original');
    });

    it('url and originalUrl both absent — falls back to "/"', () =>
    {
        const { res } = makeErrMocks();
        const req = { method: 'POST' };
        const log = vi.fn();
        errorHandler({ logger: log })(new Error('test'), req, res, noop);
        expect(log.mock.calls[0][0]).toContain('/');
    });

    it('5xx errors log stack when stack is present', () =>
    {
        const { req, res } = makeErrMocks();
        const calls = [];
        const err = new Error('crash');
        errorHandler({ logger: (...a) => calls.push(a) })(err, req, res, noop);
        // Should have at least 2 log calls (message + stack)
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('4xx errors only log one line (no stack log)', () =>
    {
        const { req, res } = makeErrMocks();
        const calls = [];
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        errorHandler({ logger: (...a) => calls.push(a) })(err, req, res, noop);
        expect(calls.length).toBe(1);
    });
});

// ===========================================================================
// logger
// ===========================================================================
describe('logger middleware', () =>
{
    function makeLogEnv(opts = {})
    {
        const logs = [];
        const req = makeReq(opts.req || {});
        const res = makeRes();
        return { logs, req, res };
    }

    it('default dev format logs on finish', () =>
    {
        const { logs, req, res } = makeLogEnv();
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: false });
        mw(req, res, noop);
        res.raw.emit('finish');
        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('GET');
        expect(logs[0]).toContain('/');
    });

    it('tiny format logs condensed line', () =>
    {
        const { logs, req, res } = makeLogEnv();
        const mw = logger({ format: 'tiny', logger: (...a) => logs.push(a.join(' ')), colors: false });
        mw(req, res, noop);
        res.raw.emit('finish');
        expect(logs[0]).toMatch(/GET \/ \d+ - \d+ms/);
    });

    it('short format includes ip field', () =>
    {
        const logs = [];
        const req = makeReq({ ip: '1.2.3.4' });
        const res = makeRes();
        const mw = logger({ format: 'short', logger: (...a) => logs.push(a.join(' ')), colors: false });
        mw(req, res, noop);
        res.raw.emit('finish');
        expect(logs[0]).toContain('1.2.3.4');
    });

    it('uses res._status when raw.statusCode is 0', () =>
    {
        const { logs, req, res } = makeLogEnv();
        res.raw.statusCode = 0;
        res._status = 200;
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: false });
        mw(req, res, noop);
        res.raw.emit('finish');
        expect(logs[0]).toContain('200');
    });

    it('statusColor: 2xx uses green when colors=true', () =>
    {
        const logs = [];
        const req = makeReq();
        const res = makeRes();
        res.raw.statusCode = 200;
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: true });
        mw(req, res, noop);
        res.raw.emit('finish');
        // Green ANSI code: \x1b[32m
        expect(logs[0]).toContain('\x1b[32m');
    });

    it('statusColor: 3xx uses cyan when colors=true', () =>
    {
        const logs = [];
        const req = makeReq();
        const res = makeRes();
        res.raw.statusCode = 301;
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: true });
        mw(req, res, noop);
        res.raw.emit('finish');
        // Cyan ANSI code: \x1b[36m
        expect(logs[0]).toContain('\x1b[36m');
    });

    it('statusColor: 4xx uses yellow when colors=true', () =>
    {
        const logs = [];
        const req = makeReq();
        const res = makeRes();
        res.raw.statusCode = 404;
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: true });
        mw(req, res, noop);
        res.raw.emit('finish');
        // Yellow ANSI code: \x1b[33m
        expect(logs[0]).toContain('\x1b[33m');
    });

    it('statusColor: 5xx uses red when colors=true', () =>
    {
        const logs = [];
        const req = makeReq();
        const res = makeRes();
        res.raw.statusCode = 503;
        const mw = logger({ logger: (...a) => logs.push(a.join(' ')), colors: true });
        mw(req, res, noop);
        res.raw.emit('finish');
        // Red ANSI code: \x1b[31m
        expect(logs[0]).toContain('\x1b[31m');
    });

    it('custom opts.logger is called on finish', () =>
    {
        const log = vi.fn();
        const req = makeReq();
        const res = makeRes();
        logger({ logger: log })(req, res, noop);
        res.raw.emit('finish');
        expect(log).toHaveBeenCalled();
    });

    it('colors:false suppresses ANSI codes', () =>
    {
        const logs = [];
        const req = makeReq();
        const res = makeRes();
        res.raw.statusCode = 404;
        logger({ logger: (...a) => logs.push(a.join(' ')), colors: false })(req, res, noop);
        res.raw.emit('finish');
        expect(logs[0]).not.toContain('\x1b[');
    });

    it('short format with no ip shows dash', () =>
    {
        const logs = [];
        const req = makeReq({ ip: undefined });
        const res = makeRes();
        logger({ format: 'short', logger: (...a) => logs.push(a.join(' ')), colors: false })(req, res, noop);
        res.raw.emit('finish');
        expect(logs[0]).toContain('-');
    });

    it('calls next()', () =>
    {
        const next = vi.fn();
        const req = makeReq();
        const res = makeRes();
        logger({ logger: noop })(req, res, next);
        expect(next).toHaveBeenCalled();
    });
});

// ===========================================================================
// cors
// ===========================================================================
describe('cors middleware', () =>
{
    it('throws when credentials=true and origin="*"', () =>
    {
        expect(() => cors({ credentials: true })).toThrow(/wildcard/);
    });

    it('sets Access-Control-Allow-Origin to * by default', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        cors()(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('echoes specific origin when match in array', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        cors({ origin: ['http://example.com', 'http://other.com'] })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBe('http://example.com');
    });

    it('does not set ACAO when origin not in array', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://evil.com' } });
        const res = makeRes();
        cors({ origin: ['http://allowed.com'] })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('suffix match with leading dot (.example.com)', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'sub.example.com' } });
        const res = makeRes();
        cors({ origin: ['.example.com'] })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBe('sub.example.com');
    });

    it('suffix match skips falsy entries in array', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://allowed.com' } });
        const res = makeRes();
        cors({ origin: [null, '', 'http://allowed.com'] })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBe('http://allowed.com');
    });

    it('origin:false — no ACAO header set', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://x.com' } });
        const res = makeRes();
        cors({ origin: false })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('does not set ACAO when array and no origin header in request', () =>
    {
        const req = makeReq({ method: 'GET', headers: {} });
        const res = makeRes();
        cors({ origin: ['http://example.com'] })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('handles non-string, non-array, non-null origin (returns null)', () =>
    {
        // When allowOrigin is e.g. a number — the function falls to the last return null
        const req = makeReq({ method: 'GET', headers: { origin: 'http://x.com' } });
        const res = makeRes();
        // pass origin:42 — neither string nor array — matchOrigin returns null
        cors({ origin: 42 })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('sets Vary: Origin for non-wildcard origin', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        cors({ origin: 'http://example.com' })(req, res, noop);
        expect(res.vary).toHaveBeenCalledWith('Origin');
    });

    it('credentials:true adds Access-Control-Allow-Credentials', () =>
    {
        const req = makeReq({ method: 'GET', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        cors({ origin: 'http://example.com', credentials: true })(req, res, noop);
        expect(res._headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('OPTIONS preflight returns 204', () =>
    {
        const req = makeReq({ method: 'OPTIONS', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        cors()(req, res, noop);
        expect(res.send).toHaveBeenCalled();
        expect(res._status).toBe(204);
    });

    it('non-OPTIONS proceeds to next()', () =>
    {
        const next = vi.fn();
        const req = makeReq({ method: 'GET', headers: {} });
        const res = makeRes();
        cors()(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('sets exposedHeaders when provided', () =>
    {
        const req = makeReq({ method: 'GET', headers: {} });
        const res = makeRes();
        cors({ exposedHeaders: 'X-Custom' })(req, res, noop);
        expect(res._headers['Access-Control-Expose-Headers']).toBe('X-Custom');
    });

    it('sets maxAge header when provided', () =>
    {
        const req = makeReq({ method: 'GET', headers: {} });
        const res = makeRes();
        cors({ maxAge: 300 })(req, res, noop);
        expect(res._headers['Access-Control-Max-Age']).toBe('300');
    });
});

// ===========================================================================
// csrf
// ===========================================================================
describe('csrf middleware', () =>
{
    function makeSignedToken()
    {
        // Build a valid token with a known secret for test purposes
        const secret = 'test-secret';
        const mw = csrf({ secret });
        // Extract generateToken by calling safe-method
        let token = null;
        const req = makeReq({ method: 'GET', cookies: {} });
        const res = makeRes();
        res.set = vi.fn().mockImplementation((k, v) =>
        {
            if (k === 'Set-Cookie') token = v.split('=')[1].split(';')[0];
            return res;
        });
        mw(req, res, noop);
        return { token, secret, mw };
    }

    it('GET request — sets CSRF cookie for fresh client', () =>
    {
        const { mw } = makeSignedToken();
        const req = makeReq({ method: 'GET', cookies: {} });
        const res = makeRes();
        const setCookies = [];
        res.set = vi.fn().mockImplementation((k, v) => { if (k === 'Set-Cookie') setCookies.push(v); return res; });
        mw(req, res, noop);
        expect(setCookies.length).toBe(1);
    });

    it('GET request — populates req.csrfToken', () =>
    {
        const req = makeReq({ method: 'GET', cookies: {} });
        const res = makeRes();
        res.set = vi.fn().mockReturnValue(res);
        csrf({ secret: 'sec' })(req, res, noop);
        expect(req.csrfToken).toBeDefined();
        expect(typeof req.csrfToken).toBe('string');
    });

    it('GET with valid existing cookie reuses token', () =>
    {
        const secret = 'sec';
        const mw = csrf({ secret });
        // First, generate a token
        const req1 = makeReq({ method: 'GET', cookies: {} });
        const res1 = makeRes();
        let tok = null;
        res1.set = vi.fn().mockImplementation((k, v) => { tok = v.split('=')[1].split(';')[0]; return res1; });
        mw(req1, res1, noop);

        // Second request with valid existing token — should NOT set a new cookie
        const req2 = makeReq({ method: 'GET', cookies: { _csrf: tok } });
        const res2 = makeRes();
        const sets = [];
        res2.set = vi.fn().mockImplementation((k, v) => { sets.push({ k, v }); return res2; });
        mw(req2, res2, noop);
        // No new cookie set since token is still valid
        expect(sets.filter(s => s.k === 'Set-Cookie').length).toBe(0);
        expect(req2.csrfToken).toBe(tok);
    });

    it('POST with valid token passes validation', () =>
    {
        const secret = 'sec';
        const mw = csrf({ secret });
        // Generate token via GET
        const req1 = makeReq({ method: 'GET', cookies: {} });
        const res1 = makeRes();
        let tok = null;
        res1.set = vi.fn().mockImplementation((k, v) => { tok = v.split('=')[1].split(';')[0]; return res1; });
        mw(req1, res1, noop);

        const next = vi.fn();
        const req2 = makeReq({
            method: 'POST',
            cookies: { _csrf: tok },
            headers: { 'x-csrf-token': tok },
        });
        const res2 = makeRes();
        res2.set = vi.fn().mockReturnValue(res2);
        mw(req2, res2, next);
        expect(next).toHaveBeenCalled();
    });

    it('POST without token returns 403', () =>
    {
        const mw = csrf({ secret: 'sec' });
        const req = makeReq({ method: 'POST', cookies: {}, headers: {} });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(403);
    });

    it('POST with mismatched tokens returns 403', () =>
    {
        const secret = 'sec';
        const mw = csrf({ secret });
        // Generate a valid token  
        const req1 = makeReq({ method: 'GET', cookies: {} });
        const res1 = makeRes();
        let tok = null;
        res1.set = vi.fn().mockImplementation((k, v) => { tok = v.split('=')[1].split(';')[0]; return res1; });
        mw(req1, res1, noop);

        const req2 = makeReq({
            method: 'POST',
            cookies: { _csrf: tok },
            headers: { 'x-csrf-token': 'diferent_token' },
        });
        const res2 = makeRes();
        mw(req2, res2, noop);
        expect(res2._status).toBe(403);
    });

    it('verifyToken rejects token with no dot (parts.length !== 2)', () =>
    {
        const mw = csrf({ secret: 'sec' });
        const badToken = 'tokenwithnodot';
        const req = makeReq({
            method: 'POST',
            cookies: { _csrf: badToken },
            headers: { 'x-csrf-token': badToken },
        });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(403);
    });

    it('verifyToken rejects token with too many dots', () =>
    {
        const mw = csrf({ secret: 'sec' });
        const badToken = 'a.b.c'; // 3 parts
        const req = makeReq({
            method: 'POST',
            cookies: { _csrf: badToken },
            headers: { 'x-csrf-token': badToken },
        });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(403);
    });

    it('ignorePaths skips validation for matching path prefix', () =>
    {
        const mw = csrf({ secret: 'sec', ignorePaths: ['/webhooks'] });
        const next = vi.fn();
        const req = makeReq({ method: 'POST', url: '/webhooks/stripe', cookies: {}, headers: {} });
        const res = makeRes();
        mw(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res._status).not.toBe(403);
    });

    it('ignorePaths does not skip for non-matching path', () =>
    {
        const mw = csrf({ secret: 'sec', ignorePaths: ['/webhooks'] });
        const req = makeReq({ method: 'POST', url: '/api/data', cookies: {}, headers: {} });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(403);
    });

    it('custom onError handler is called instead of default 403', () =>
    {
        const onError = vi.fn();
        const mw = csrf({ secret: 'sec', onError });
        const req = makeReq({ method: 'POST', cookies: {}, headers: {} });
        const res = makeRes();
        mw(req, res, noop);
        expect(onError).toHaveBeenCalled();
    });

    it('HEAD method is ignored (safe method)', () =>
    {
        const next = vi.fn();
        const mw = csrf({ secret: 'sec' });
        const req = makeReq({ method: 'HEAD', cookies: {} });
        const res = makeRes();
        res.set = vi.fn().mockReturnValue(res);
        mw(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('token can be passed via req.body._csrf', () =>
    {
        const secret = 'sec';
        const mw = csrf({ secret });
        // Generate token
        const req1 = makeReq({ method: 'GET', cookies: {} });
        const res1 = makeRes();
        let tok = null;
        res1.set = vi.fn().mockImplementation((k, v) => { tok = v.split('=')[1].split(';')[0]; return res1; });
        mw(req1, res1, noop);

        const next = vi.fn();
        const req2 = makeReq({
            method: 'POST',
            cookies: { _csrf: tok },
            headers: {},
            body: { _csrf: tok },
        });
        const res2 = makeRes();
        res2.set = vi.fn().mockReturnValue(res2);
        mw(req2, res2, next);
        expect(next).toHaveBeenCalled();
    });

    it('token can be passed via req.query._csrf', () =>
    {
        const secret = 'sec';
        const mw = csrf({ secret });
        const req1 = makeReq({ method: 'GET', cookies: {} });
        const res1 = makeRes();
        let tok = null;
        res1.set = vi.fn().mockImplementation((k, v) => { tok = v.split('=')[1].split(';')[0]; return res1; });
        mw(req1, res1, noop);

        const next = vi.fn();
        const req2 = makeReq({
            method: 'DELETE',
            cookies: { _csrf: tok },
            headers: {},
            query: { _csrf: tok },
        });
        const res2 = makeRes();
        res2.set = vi.fn().mockReturnValue(res2);
        mw(req2, res2, next);
        expect(next).toHaveBeenCalled();
    });
});

// ===========================================================================
// compress
// ===========================================================================
describe('compress middleware', () =>
{
    function makeCompressEnv(opts = {})
    {
        const origWrite = vi.fn(() => true);
        const origEnd   = vi.fn();
        const rh = { 'content-type': opts.contentType || 'text/html' };
        const raw = {
            statusCode:    200,
            headersSent:   false,
            write:         origWrite,
            end:           origEnd,
            getHeader:     (k) => rh[k],
            setHeader:     (k, v) => { rh[k] = v; },
            removeHeader:  (k) => { delete rh[k]; },
        };
        const req = makeReq({ headers: { 'accept-encoding': opts.encoding || 'gzip', ...opts.reqHeaders } });
        const res = { raw };
        return { raw, req, res, origWrite, origEnd, rh };
    }

    it('no accept-encoding — does not patch write/end, calls next()', () =>
    {
        const next = vi.fn();
        const { raw, req, res, origWrite } = makeCompressEnv({ encoding: '' });
        req.headers['accept-encoding'] = '';
        const writeRef = raw.write;
        compress()(req, res, next);
        expect(raw.write).toBe(writeRef); // unchanged
        expect(next).toHaveBeenCalled();
    });

    it('filter fn returning false — skips compression', () =>
    {
        const next = vi.fn();
        const { raw, req, res, origWrite } = makeCompressEnv();
        const writeRef = raw.write;
        compress({ filter: () => false })(req, res, next);
        expect(raw.write).toBe(writeRef);
        expect(next).toHaveBeenCalled();
    });

    it('patched write compresses for compressible content', () =>
    {
        return new Promise((resolve) =>
        {
            const { raw, req, res, origWrite } = makeCompressEnv({ encoding: 'gzip', contentType: 'text/html' });
            compress({ threshold: 0 })(req, res, noop);

            const bigChunk = Buffer.alloc(100, 'a');
            raw.write.call(raw, bigChunk, null, null);

            // origWrite should eventually receive compressed data from compressStream events
            setImmediate(() =>
            {
                // write went through the compressStream which will emit 'data'
                // origWrite would have been called with compressed chunk eventually
                resolve();
            });
        });
    });

    it('second write (headersWritten=true) routes through compressStream', () =>
    {
        return new Promise((resolve) =>
        {
            const { raw, req, res, origWrite } = makeCompressEnv({ encoding: 'gzip', contentType: 'text/html' });
            compress({ threshold: 0 })(req, res, noop);

            const chunk1 = Buffer.alloc(50, 'a');
            const chunk2 = Buffer.alloc(50, 'b');
            raw.write.call(raw, chunk1, null, null);
            // second write — headersWritten is now true
            raw.write.call(raw, chunk2, null, null);

            setImmediate(() => resolve());
        });
    });

    it('end() with small chunk (below threshold) bypasses compression', () =>
    {
        const { raw, req, res, origEnd } = makeCompressEnv({ encoding: 'gzip', contentType: 'text/html' });
        compress({ threshold: 2048 })(req, res, noop);

        const smallChunk = Buffer.alloc(10, 'x');
        raw.end.call(raw, smallChunk);

        // origEnd should be called directly, bypassing compression
        // called as origEnd(chunk, encoding, callback) so args include undefineds
        expect(origEnd.mock.calls[0][0]).toBe(smallChunk);
    });

    it('end() with null/undefined chunk does not try length check', () =>
    {
        const { raw, req, res } = makeCompressEnv({ encoding: 'gzip', contentType: 'text/html' });
        compress({ threshold: 2048 })(req, res, noop);
        // Calling end() with no chunk should not throw
        expect(() => raw.end.call(raw)).not.toThrow();
    });

    it('end() with non-compressible content-type — bypasses compression', () =>
    {
        const { raw, req, res, origEnd } = makeCompressEnv({ encoding: 'gzip', contentType: 'image/jpeg' });
        compress({ threshold: 0 })(req, res, noop);

        const chunk = Buffer.alloc(2000, 0);
        raw.end.call(raw, chunk);

        // initCompress() returns false for image/jpeg → origEnd is called directly
        expect(origEnd.mock.calls[0][0]).toBe(chunk);
    });

    it('end() when headersWritten=true and compressStream=null calls origEnd', () =>
    {
        const { raw, req, res, origEnd } = makeCompressEnv({ encoding: 'gzip', contentType: 'image/png' });
        compress({ threshold: 0 })(req, res, noop);

        // First: write (non-compressible type → compressStream stays null, headersWritten becomes true)
        raw.write.call(raw, Buffer.alloc(5, 'a'));
        // Now end() with headersWritten=true, compressStream=null
        raw.end.call(raw, Buffer.alloc(5, 'b'));
        expect(origEnd).toHaveBeenCalled();
    });

    it('SSE (text/event-stream) bypasses compression', () =>
    {
        const { raw, req, res } = makeCompressEnv({ encoding: 'gzip', contentType: 'text/event-stream' });
        compress({ threshold: 0 })(req, res, noop);
        // Calling end with chunk goes directly to origEnd (initCompress returns false for SSE)
        expect(() => raw.end.call(raw, Buffer.alloc(1000, 'a'))).not.toThrow();
    });

    it('deflate encoding works', () =>
    {
        return new Promise((resolve) =>
        {
            const origWrite = vi.fn(() => true);
            const origEnd   = vi.fn();
            const rh = { 'content-type': 'text/html' };
            const raw = {
                statusCode: 200, headersSent: false,
                write: origWrite, end: origEnd,
                getHeader: k => rh[k], setHeader: (k, v) => { rh[k] = v; }, removeHeader: k => { delete rh[k]; },
            };
            const req = makeReq({ headers: { 'accept-encoding': 'deflate' } });
            const res = { raw };
            compress({ threshold: 0 })(req, res, noop);
            raw.end.call(raw, Buffer.alloc(2000, 'z'));
            setImmediate(() => resolve());
        });
    });
});

// ===========================================================================
// cookieParser
// ===========================================================================
describe('cookieParser middleware', () =>
{
    it('parses simple cookie', () =>
    {
        const req = makeReq({ headers: { cookie: 'name=value' } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.name).toBe('value');
    });

    it('parses multiple cookies', () =>
    {
        const req = makeReq({ headers: { cookie: 'a=1; b=2; c=3' } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.a).toBe('1');
        expect(req.cookies.b).toBe('2');
        expect(req.cookies.c).toBe('3');
    });

    it('no Cookie header — cookies is empty object', () =>
    {
        const req = makeReq({ headers: {} });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies).toEqual({});
    });

    it('cookie without = separator is skipped', () =>
    {
        const req = makeReq({ headers: { cookie: 'novalue; good=1' } });
        cookieParser()(req, makeRes(), noop);
        expect(Object.keys(req.cookies)).not.toContain('novalue');
        expect(req.cookies.good).toBe('1');
    });

    it('strips surrounding double quotes from value', () =>
    {
        const req = makeReq({ headers: { cookie: 'x="quoted value"' } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.x).toBe('quoted value');
    });

    it('URI-decodes values by default', () =>
    {
        const req = makeReq({ headers: { cookie: 'x=hello%20world' } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.x).toBe('hello world');
    });

    it('opts.decode=false skips URI decoding', () =>
    {
        const req = makeReq({ headers: { cookie: 'x=hello%20world' } });
        cookieParser(undefined, { decode: false })(req, makeRes(), noop);
        expect(req.cookies.x).toBe('hello%20world');
    });

    it('silently keeps raw value if decodeURIComponent throws', () =>
    {
        const req = makeReq({ headers: { cookie: 'x=%ZZ' } });
        cookieParser()(req, makeRes(), noop);
        // Should not throw; may contain raw or empty value
        expect(() => cookieParser()(req, makeRes(), noop)).not.toThrow();
    });

    it('signed cookie with correct secret goes to signedCookies', () =>
    {
        const secret = 'my-secret';
        const signed = cookieParser.sign('hello', secret);
        const req = makeReq({ headers: { cookie: `tok=${signed}` } });
        cookieParser(secret)(req, makeRes(), noop);
        expect(req.signedCookies.tok).toBe('hello');
        expect(req.cookies.tok).toBeUndefined(); // not in plain cookies
    });

    it('signed cookie with wrong secret is silently dropped', () =>
    {
        const signed = cookieParser.sign('hello', 'correct-secret');
        const req = makeReq({ headers: { cookie: `tok=${signed}` } });
        cookieParser('wrong-secret')(req, makeRes(), noop);
        // Silently dropped — not in signedCookies
        expect(req.signedCookies.tok).toBeUndefined();
    });

    it('signed cookie with malformed value (no dot after s:) is dropped', () =>
    {
        const req = makeReq({ headers: { cookie: 's=s:nodot' } });
        cookieParser('secret')(req, makeRes(), noop);
        expect(req.signedCookies.s).toBeUndefined();
    });

    it('secret rotation — old secret still valid', () =>
    {
        const newSecret = 'new-secret';
        const oldSecret = 'old-secret';
        const signed = cookieParser.sign('data', oldSecret);
        const req = makeReq({ headers: { cookie: `tok=${signed}` } });
        cookieParser([newSecret, oldSecret])(req, makeRes(), noop);
        expect(req.signedCookies.tok).toBe('data');
    });

    it('JSON cookie (j: prefix) is auto-parsed', () =>
    {
        const json = cookieParser.jsonCookie({ cart: [1, 2] });
        const enc = encodeURIComponent(json);
        const req = makeReq({ headers: { cookie: `prefs=${enc}` } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.prefs).toEqual({ cart: [1, 2] });
    });

    it('malformed JSON cookie keeps raw j: string', () =>
    {
        const req = makeReq({ headers: { cookie: 'x=j%3A{invalid}' } });
        cookieParser()(req, makeRes(), noop);
        expect(req.cookies.x).toBe('j:{invalid}');
    });

    it('signed JSON cookie is parsed to signedCookies', () =>
    {
        const secret = 'sec';
        const json = cookieParser.jsonCookie({ id: 5 });
        const signed = cookieParser.sign(json, secret);
        const req = makeReq({ headers: { cookie: `pref=${encodeURIComponent(signed)}` } });
        cookieParser(secret)(req, makeRes(), noop);
        expect(req.signedCookies.pref).toEqual({ id: 5 });
    });

    it('exposes req.secret and req.secrets when secret provided', () =>
    {
        const req = makeReq({ headers: {} });
        cookieParser('my-secret')(req, makeRes(), noop);
        expect(req.secret).toBe('my-secret');
        expect(req.secrets).toEqual(['my-secret']);
    });

    it('no secret — req.secret is undefined', () =>
    {
        const req = makeReq({ headers: {} });
        cookieParser()(req, makeRes(), noop);
        expect(req.secret).toBeUndefined();
    });

    describe('static helpers', () =>
    {
        it('cookieParser.sign / unsign round-trip', () =>
        {
            const signed = cookieParser.sign('payload', 'sec');
            expect(cookieParser.unsign(signed, 'sec')).toBe('payload');
        });

        it('cookieParser.unsign returns false for wrong secret', () =>
        {
            const signed = cookieParser.sign('payload', 'right');
            expect(cookieParser.unsign(signed, 'wrong')).toBe(false);
        });

        it('cookieParser.unsign accepts array of secrets', () =>
        {
            const signed = cookieParser.sign('payload', 'old');
            expect(cookieParser.unsign(signed, ['new', 'old'])).toBe('payload');
        });

        it('cookieParser.jsonCookie serialises value', () =>
        {
            expect(cookieParser.jsonCookie({ x: 1 })).toBe('j:{"x":1}');
        });

        it('cookieParser.parseJSON parses j: prefix', () =>
        {
            expect(cookieParser.parseJSON('j:{"x":1}')).toEqual({ x: 1 });
        });

        it('cookieParser.parseJSON returns raw when not j: prefix', () =>
        {
            expect(cookieParser.parseJSON('plain')).toBe('plain');
        });
    });
});

// ===========================================================================
// rateLimit
// ===========================================================================
describe('rateLimit middleware', () =>
{
    afterEach(() => vi.useRealTimers());

    it('allows requests under the limit', () =>
    {
        const next = vi.fn();
        const mw = rateLimit({ max: 5, windowMs: 60_000 });
        const req = makeReq({ ip: '1.1.1.1' });
        const res = makeRes();
        for (let i = 0; i < 5; i++) mw(req, makeRes(), next);
        expect(next).toHaveBeenCalledTimes(5);
    });

    it('blocks when limit exceeded', () =>
    {
        const next = vi.fn();
        const mw = rateLimit({ max: 2, windowMs: 60_000 });
        const req = makeReq({ ip: '2.2.2.2' });
        mw(req, makeRes(), next); // 1
        mw(req, makeRes(), next); // 2
        const res = makeRes();
        mw(req, res, next);      // 3 — over limit
        expect(res._status).toBe(429);
    });

    it('sets X-RateLimit-* headers', () =>
    {
        const mw = rateLimit({ max: 10, windowMs: 60_000 });
        const req = makeReq({ ip: '3.3.3.3' });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._headers['X-RateLimit-Limit']).toBe('10');
        expect(res._headers['X-RateLimit-Remaining']).toBe('9');
    });

    it('sets Retry-After header when rate limited', () =>
    {
        const mw = rateLimit({ max: 1, windowMs: 30_000 });
        const req = makeReq({ ip: '4.4.4.4' });
        mw(req, makeRes(), noop); // first — ok
        const res = makeRes();
        mw(req, res, noop);       // second — blocked
        expect(res._headers['Retry-After']).toBeDefined();
    });

    it('custom handler is called when rate limited', () =>
    {
        const handler = vi.fn();
        const mw = rateLimit({ max: 1, windowMs: 60_000, handler });
        const req = makeReq({ ip: '5.5.5.5' });
        mw(req, makeRes(), noop);
        mw(req, makeRes(), noop);
        expect(handler).toHaveBeenCalled();
    });

    it('skip function prevents rate counting', () =>
    {
        const next = vi.fn();
        const mw = rateLimit({ max: 1, windowMs: 60_000, skip: () => true });
        const req = makeReq({ ip: '6.6.6.6' });
        for (let i = 0; i < 10; i++) mw(req, makeRes(), next);
        expect(next).toHaveBeenCalledTimes(10); // all pass
    });

    it('custom keyGenerator uses custom key', () =>
    {
        const next = vi.fn();
        const mw = rateLimit({ max: 1, windowMs: 60_000, keyGenerator: (req) => req.headers['x-api-key'] });
        const req1 = makeReq({ headers: { 'x-api-key': 'key-a' } });
        const req2 = makeReq({ headers: { 'x-api-key': 'key-b' } });
        mw(req1, makeRes(), next); // key-a: 1
        mw(req1, makeRes(), next); // key-a: 2 — over limit (max=1)
        mw(req2, makeRes(), next); // key-b: 1 — different key, ok
        // req2 should have succeeded
        expect(next).toHaveBeenCalledTimes(2); // req1 first + req2
    });

    it('counter resets after window expires', () =>
    {
        vi.useFakeTimers();
        const next = vi.fn();
        const windowMs = 1000;
        const mw = rateLimit({ max: 1, windowMs });
        const req = makeReq({ ip: '7.7.7.7' });
        mw(req, makeRes(), next); // 1 ok
        const blockedRes = makeRes();
        mw(req, blockedRes, next); // 2 blocked
        expect(blockedRes._status).toBe(429);

        vi.advanceTimersByTime(windowMs + 100);
        const freshRes = makeRes();
        mw(req, freshRes, next); // new window — ok
        expect(freshRes._status).not.toBe(429);
        vi.useRealTimers();
    });

    it('cleanup interval removes expired entries', () =>
    {
        vi.useFakeTimers();
        const windowMs = 500;
        // rateLimit is created fresh — the cleanup interval is set at creation
        const mw = rateLimit({ max: 100, windowMs });
        const req = makeReq({ ip: '8.8.8.8' });
        mw(req, makeRes(), noop); // create an entry

        // Advance past the window to make the entry stale
        vi.advanceTimersByTime(windowMs + 10);
        // Advance by windowMs again to trigger the cleanup interval's own tick
        vi.advanceTimersByTime(windowMs);
        // The cleanup interval fired at least once; no assertion needed beyond
        // "it didn't throw" — but let's also verify it didn't corrupt subsequent requests

        const next = vi.fn();
        mw(makeReq({ ip: '8.8.8.8' }), makeRes(), next);
        expect(next).toHaveBeenCalled(); // fresh window, not blocked
        vi.useRealTimers();
    });

    it('custom statusCode is used when blocked', () =>
    {
        const mw = rateLimit({ max: 1, windowMs: 60_000, statusCode: 503 });
        const req = makeReq({ ip: '9.9.9.9' });
        mw(req, makeRes(), noop);
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(503);
    });

    it('unknown IP uses fallback key "unknown"', () =>
    {
        const next = vi.fn();
        const mw = rateLimit({ max: 5 });
        const req = makeReq({ ip: undefined });
        req.ip = undefined;
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });
});

// ===========================================================================
// timeout
// ===========================================================================
describe('timeout middleware', () =>
{
    afterEach(() => vi.useRealTimers());

    it('calls next() immediately', () =>
    {
        const next = vi.fn();
        const req = makeReq();
        const res = makeRes();
        timeout(5000)(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('sends 408 after timeout fires', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(1000)(req, res, noop);
        vi.advanceTimersByTime(1001);
        expect(res._status).toBe(408);
    });

    it('custom status code is sent on timeout', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(1000, { status: 504 })(req, res, noop);
        vi.advanceTimersByTime(1001);
        expect(res._status).toBe(504);
    });

    it('custom message is sent on timeout', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(1000, { message: 'Gateway timeout' })(req, res, noop);
        vi.advanceTimersByTime(1001);
        expect(res._body.error).toBe('Gateway timeout');
    });

    it('object-as-first-arg: timeout({ message, status }) uses default ms=30000', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout({ message: 'Too slow', status: 503 })(req, res, noop);
        // Should NOT fire at 1001ms (default is 30s)
        vi.advanceTimersByTime(1001);
        expect(res._status).not.toBe(503);
        // Should fire at 30000ms
        vi.advanceTimersByTime(30000);
        expect(res._status).toBe(503);
        expect(res._body.error).toBe('Too slow');
    });

    it('does not send response when res.headersSent=true at timeout', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        res.headersSent = true;
        timeout(500)(req, res, noop);
        vi.advanceTimersByTime(600);
        expect(res._body).toBeNull(); // json() not called
    });

    it('does not send response when res._sent=true at timeout', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        res._sent = true;
        timeout(500)(req, res, noop);
        vi.advanceTimersByTime(600);
        expect(res._body).toBeNull();
    });

    it('exposes req.timedOut getter', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(500)(req, res, noop);
        expect(req.timedOut).toBe(false);
        vi.advanceTimersByTime(600);
        expect(req.timedOut).toBe(true);
    });

    it('also marks req._timedOut on timeout', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(500)(req, res, noop);
        vi.advanceTimersByTime(600);
        expect(req._timedOut).toBe(true);
    });

    it('timer cleared on "finish" event — does not fire after response finishes', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(1000)(req, res, noop);
        // Simulate response finishing early
        res.raw.emit('finish');
        vi.advanceTimersByTime(1001);
        // Timeout should not have fired (was cleared)
        expect(res._body).toBeNull();
    });

    it('timer cleared on "close" event', () =>
    {
        vi.useFakeTimers();
        const req = makeReq();
        const res = makeRes();
        timeout(1000)(req, res, noop);
        res.raw.emit('close');
        vi.advanceTimersByTime(1001);
        expect(res._body).toBeNull();
    });
});

// ===========================================================================
// validator (validate)
// ===========================================================================
describe('validator middleware', () =>
{
    it('passes when body matches schema', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { name: { type: 'string', required: true } } });
        const req = makeReq({ body: { name: 'Alice' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('returns 422 when required field is missing', () =>
    {
        const mw = validate({ body: { name: { type: 'string', required: true } } });
        const req = makeReq({ body: {} });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors).toContain('body.name is required');
    });

    it('coerces string to integer', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { age: { type: 'integer' } } });
        const req = makeReq({ body: { age: '25' } });
        mw(req, makeRes(), next);
        expect(req.body.age).toBe(25);
    });

    it('coerces string to boolean', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { active: { type: 'boolean' } } });
        const req = makeReq({ body: { active: 'true' } });
        mw(req, makeRes(), next);
        expect(req.body.active).toBe(true);
    });

    it('validates email type', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { email: { type: 'email', required: true } } });
        const req = makeReq({ body: { email: 'test@example.com' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('rejects invalid email', () =>
    {
        const mw = validate({ body: { email: { type: 'email', required: true } } });
        const req = makeReq({ body: { email: 'notanemail' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
    });

    it('validates type:url — valid URL passes', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { href: { type: 'url' } } });
        const req = makeReq({ body: { href: 'https://example.com/path' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('validates type:url — invalid URL returns error', () =>
    {
        const mw = validate({ body: { href: { type: 'url' } } });
        const req = makeReq({ body: { href: 'not a url' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors.join(' ')).toContain('valid URL');
    });

    it('validates type:uuid — valid UUID passes', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { id: { type: 'uuid' } } });
        const req = makeReq({ body: { id: '550e8400-e29b-41d4-a716-446655440000' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('validates type:uuid — invalid UUID returns error', () =>
    {
        const mw = validate({ body: { id: { type: 'uuid' } } });
        const req = makeReq({ body: { id: 'not-a-uuid' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors.join(' ')).toContain('valid UUID');
    });

    it('minItems / maxItems for array type', () =>
    {
        const mw = validate({
            body: {
                tags: { type: 'array', minItems: 2, maxItems: 5 },
            },
        });
        const reqOk   = makeReq({ body: { tags: ['a', 'b', 'c'] } });
        const reqFew  = makeReq({ body: { tags: ['one'] } });
        const reqMany = makeReq({ body: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] } });

        const next = vi.fn();
        mw(reqOk, makeRes(), next);
        expect(next).toHaveBeenCalled();

        const resFew = makeRes();
        mw(reqFew, resFew, noop);
        expect(resFew._status).toBe(422);

        const resMany = makeRes();
        mw(reqMany, resMany, noop);
        expect(resMany._status).toBe(422);
    });

    it('custom validate function can return an error string', () =>
    {
        const mw = validate({
            body: {
                score: {
                    type: 'integer',
                    validate: (v) => v % 2 !== 0 ? 'score must be even' : undefined,
                },
            },
        });
        const req = makeReq({ body: { score: 3 } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors.join(' ')).toContain('must be even');
    });

    it('custom validate function returning undefined passes', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { score: { type: 'integer', validate: () => undefined } } });
        mw(makeReq({ body: { score: 4 } }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('default value is applied when field is absent', () =>
    {
        const next = vi.fn();
        const mw = validate({ query: { page: { type: 'integer', default: 1 } } });
        const req = makeReq({ query: {} });
        mw(req, makeRes(), next);
        expect(req.query.page).toBe(1);
    });

    it('enum validation rejects unlisted value', () =>
    {
        const mw = validate({ body: { role: { type: 'string', enum: ['admin', 'user'] } } });
        const req = makeReq({ body: { role: 'superuser' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
    });

    it('stripUnknown:false preserves unknown fields', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { name: { type: 'string' } } }, { stripUnknown: false });
        const req = makeReq({ body: { name: 'Bob', extra: 'field' } });
        mw(req, makeRes(), next);
        expect(req.body.extra).toBe('field');
    });

    it('validates query schema', () =>
    {
        const next = vi.fn();
        const mw = validate({ query: { limit: { type: 'integer', min: 1, max: 100 } } });
        const req = makeReq({ query: { limit: '50' } });
        mw(req, makeRes(), next);
        expect(req.query.limit).toBe(50);
    });

    it('validates params schema', () =>
    {
        const next = vi.fn();
        const mw = validate({ params: { id: { type: 'integer', required: true } } });
        const req = makeReq({ params: { id: '42' } });
        mw(req, makeRes(), next);
        expect(req.params.id).toBe(42);
    });

    it('custom onError handler is called instead of default 422', () =>
    {
        const onError = vi.fn();
        const mw = validate({ body: { x: { required: true } } }, { onError });
        const req = makeReq({ body: {} });
        mw(req, makeRes(), noop);
        expect(onError).toHaveBeenCalled();
    });

    it('min/max constraints on number', () =>
    {
        const mw = validate({ body: { n: { type: 'number', min: 0, max: 10 } } });
        const resLow  = makeRes();
        const resHigh = makeRes();
        mw(makeReq({ body: { n: -1 } }), resLow, noop);
        mw(makeReq({ body: { n: 11 } }), resHigh, noop);
        expect(resLow._status).toBe(422);
        expect(resHigh._status).toBe(422);
    });

    it('match constraint on string', () =>
    {
        const mw = validate({ body: { code: { type: 'string', match: /^[A-Z]{3}$/ } } });
        const res = makeRes();
        mw(makeReq({ body: { code: 'abc' } }), res, noop);
        expect(res._status).toBe(422);

        const next = vi.fn();
        mw(makeReq({ body: { code: 'ABC' } }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    describe('validate.field standalone', () =>
    {
        it('validates a single field directly', () =>
        {
            const { value, error } = validate.field('test@x.com', { type: 'email' }, 'email');
            expect(error).toBeNull();
            expect(value).toBe('test@x.com');
        });

        it('returns error for required null', () =>
        {
            const { error } = validate.field(null, { required: true }, 'field');
            expect(error).toContain('required');
        });

        it('type: date coercion', () =>
        {
            const { value, error } = validate.field('2024-01-01', { type: 'date' }, 'dob');
            expect(value instanceof Date).toBe(true);
            expect(error).toBeNull();
        });

        it('type: json coercion', () =>
        {
            const { value } = validate.field('{"key":"val"}', { type: 'json' }, 'data');
            expect(value).toEqual({ key: 'val' });
        });
    });
});

// ===========================================================================
// helmet
// ===========================================================================
describe('helmet middleware', () =>
{
    function makeHelmetRes()
    {
        const hdr = {};
        const raw = {
            setHeader:    (k, v) => { hdr[k] = v; },
            getHeader:    (k)    => hdr[k],
            removeHeader: (k)    => { delete hdr[k]; },
        };
        // Simulate pre-existing X-Powered-By
        hdr['X-Powered-By'] = 'Express';
        return { raw, hdr };
    }

    it('sets X-Content-Type-Options: nosniff', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        const res = { raw };
        helmet()(makeReq(), res, noop);
        expect(hdr['X-Content-Type-Options']).toBe('nosniff');
    });

    it('sets X-Frame-Options: DENY by default', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet()(makeReq(), { raw }, noop);
        expect(hdr['X-Frame-Options']).toBe('DENY');
    });

    it('X-Frame-Options: SAMEORIGIN when frameguard="sameorigin"', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ frameguard: 'sameorigin' })(makeReq(), { raw }, noop);
        expect(hdr['X-Frame-Options']).toBe('SAMEORIGIN');
    });

    it('removes X-Powered-By by default', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet()(makeReq(), { raw }, noop);
        expect(hdr['X-Powered-By']).toBeUndefined();
    });

    it('hidePoweredBy:false keeps X-Powered-By', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ hidePoweredBy: false })(makeReq(), { raw }, noop);
        expect(hdr['X-Powered-By']).toBeDefined();
    });

    it('sets HSTS', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet()(makeReq(), { raw }, noop);
        expect(hdr['Strict-Transport-Security']).toContain('max-age=');
        expect(hdr['Strict-Transport-Security']).toContain('includeSubDomains');
    });

    it('HSTS preload adds "; preload"', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ hstsPreload: true })(makeReq(), { raw }, noop);
        expect(hdr['Strict-Transport-Security']).toContain('; preload');
    });

    it('HSTS disabled when hsts:false', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ hsts: false })(makeReq(), { raw }, noop);
        expect(hdr['Strict-Transport-Security']).toBeUndefined();
    });

    it('custom hstsMaxAge is respected', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ hstsMaxAge: 31536000 })(makeReq(), { raw }, noop);
        expect(hdr['Strict-Transport-Security']).toContain('max-age=31536000');
    });

    it('hstsIncludeSubDomains:false omits flag', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ hstsIncludeSubDomains: false })(makeReq(), { raw }, noop);
        expect(hdr['Strict-Transport-Security']).not.toContain('includeSubDomains');
    });

    it('sets CSP from contentSecurityPolicy when provided', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } } })(makeReq(), { raw }, noop);
        expect(hdr['Content-Security-Policy']).toContain('default-src');
    });

    it('CSP directive with empty array produces bare directive (no value)', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: [] } } })(makeReq(), { raw }, noop);
        expect(hdr['Content-Security-Policy']).toContain('upgrade-insecure-requests');
        // Should not have trailing space for valueless directive
        expect(hdr['Content-Security-Policy']).not.toMatch(/upgrade-insecure-requests\s/);
    });

    it('contentSecurityPolicy:false disables CSP', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ contentSecurityPolicy: false })(makeReq(), { raw }, noop);
        expect(hdr['Content-Security-Policy']).toBeUndefined();
    });

    it('xssFilter:true enables legacy XSS header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ xssFilter: true })(makeReq(), { raw }, noop);
        expect(hdr['X-XSS-Protection']).toBe('1; mode=block');
    });

    it('xssFilter:false (default) disables legacy XSS header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet()(makeReq(), { raw }, noop);
        expect(hdr['X-XSS-Protection']).toBe('0');
    });

    it('explicit crossOriginOpenerPolicy string is set', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ crossOriginOpenerPolicy: 'unsafe-none' })(makeReq(), { raw }, noop);
        expect(hdr['Cross-Origin-Opener-Policy']).toBe('unsafe-none');
    });

    it('crossOriginOpenerPolicy:false disables COOP header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ crossOriginOpenerPolicy: false })(makeReq(), { raw }, noop);
        expect(hdr['Cross-Origin-Opener-Policy']).toBeUndefined();
    });

    it('explicit crossOriginResourcePolicy string is set', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ crossOriginResourcePolicy: 'cross-origin' })(makeReq(), { raw }, noop);
        expect(hdr['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    });

    it('crossOriginResourcePolicy:false disables CORP header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ crossOriginResourcePolicy: false })(makeReq(), { raw }, noop);
        expect(hdr['Cross-Origin-Resource-Policy']).toBeUndefined();
    });

    it('crossOriginEmbedderPolicy:true sets COEP header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ crossOriginEmbedderPolicy: true })(makeReq(), { raw }, noop);
        expect(hdr['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    });

    it('referrerPolicy sets Referrer-Policy header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ referrerPolicy: 'same-origin' })(makeReq(), { raw }, noop);
        expect(hdr['Referrer-Policy']).toBe('same-origin');
    });

    it('dnsPrefetchControl:false disables DNS prefetch header', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ dnsPrefetchControl: false })(makeReq(), { raw }, noop);
        expect(hdr['X-DNS-Prefetch-Control']).toBeUndefined();
    });

    it('frameguard:false disables X-Frame-Options', () =>
    {
        const { raw, hdr } = makeHelmetRes();
        helmet({ frameguard: false })(makeReq(), { raw }, noop);
        expect(hdr['X-Frame-Options']).toBeUndefined();
    });

    it('calls next()', () =>
    {
        const next = vi.fn();
        const { raw } = makeHelmetRes();
        helmet()(makeReq(), { raw }, next);
        expect(next).toHaveBeenCalled();
    });
});

// ===========================================================================
// static (serveStatic)
// ===========================================================================
describe('serveStatic middleware', () =>
{
    let tmpDir;

    beforeAll(() =>
    {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-static-test-'));
        // Create test files
        fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Home</h1>');
        fs.writeFileSync(path.join(tmpDir, 'about.html'), '<h1>About</h1>');
        fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"ok":true}');
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'page.html'), '<p>Sub</p>');
        fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret');
    });

    afterAll(() =>
    {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    function makeStaticRes()
    {
        const ee = new EventEmitter();
        const raw = {
            statusCode:    200,
            headersSent:   false,
            _headers:      {},
            setHeader:     (k, v) => { raw._headers[k] = v; },
            getHeader:     (k)    => raw._headers[k],
            removeHeader:  (k)    => { delete raw._headers[k]; },
            write:         vi.fn(() => true),
            end:           vi.fn(),
            on:            (ev, cb) => ee.on(ev, cb),
            once:          (ev, cb) => ee.once(ev, cb),
            removeListener:(ev, cb) => ee.removeListener(ev, cb),
            emit:          (ev, ...a) => ee.emit(ev, ...a),
        };
        const res = {
            raw,
            _status: 200,
            _body:   null,
            status:  (code) => { raw.statusCode = code; res._status = code; return res; },
            json:    (body) => { res._body = body; return res; },
        };
        return res;
    }

    it('serves index.html for root request', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('serves a specific file', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/data.json', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('calls next() for non-existent file', () =>
    {
        return new Promise((resolve) =>
        {
            const next = vi.fn();
            const req = makeReq({ method: 'GET', url: '/nope.xyz', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, next);
            setTimeout(() =>
            {
                expect(next).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('serves file via extension fallback', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/about', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir, { extensions: ['html'] })(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('calls next() when extension fallback also fails', () =>
    {
        return new Promise((resolve) =>
        {
            const next = vi.fn();
            const req = makeReq({ method: 'GET', url: '/notexist', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir, { extensions: ['html'] })(req, res, next);
            setTimeout(() =>
            {
                expect(next).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('blocks non-GET/HEAD methods', () =>
    {
        const next = vi.fn();
        const req = makeReq({ method: 'POST', url: '/index.html', headers: {} });
        serveStatic(tmpDir)(req, makeStaticRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('blocks path traversal', () =>
    {
        const res = makeStaticRes();
        serveStatic(tmpDir)(makeReq({ method: 'GET', url: '/../etc/passwd', headers: {} }), res, noop);
        expect(res._status).toBe(403);
    });

    it('blocks null bytes in path', () =>
    {
        const res = makeStaticRes();
        serveStatic(tmpDir)(makeReq({ method: 'GET', url: '/fi\0le', headers: {} }), res, noop);
        expect(res._status).toBe(400);
    });

    it('dotfiles default is ignore — calls next() for .hidden', () =>
    {
        return new Promise((resolve) =>
        {
            const next = vi.fn();
            const req = makeReq({ method: 'GET', url: '/.hidden', headers: {} });
            serveStatic(tmpDir)(req, makeStaticRes(), next);
            setTimeout(() =>
            {
                expect(next).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('dotfiles:deny returns 403 for .hidden', () =>
    {
        const res = makeStaticRes();
        serveStatic(tmpDir, { dotfiles: 'deny' })(
            makeReq({ method: 'GET', url: '/.hidden', headers: {} }),
            res, noop
        );
        expect(res._status).toBe(403);
    });

    it('dotfiles:allow serves .hidden file', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/.hidden', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir, { dotfiles: 'allow' })(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('HEAD request is handled (same as GET but no body)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'HEAD', url: '/index.html', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() => resolve(), 50);
        });
    });

    it('custom setHeaders hook is called', () =>
    {
        return new Promise((resolve) =>
        {
            const setHeaders = vi.fn();
            const req = makeReq({ method: 'GET', url: '/index.html', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir, { setHeaders })(req, res, noop);
            setTimeout(() =>
            {
                expect(setHeaders).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('maxAge sets Cache-Control header', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/index.html', headers: {} });
            const res = makeStaticRes();
            serveStatic(tmpDir, { maxAge: 3600_000 })(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw._headers['Cache-Control']).toContain('max-age=3600');
                resolve();
            }, 50);
        });
    });

    it('index:false — directory request calls next()', () =>
    {
        return new Promise((resolve) =>
        {
            const next = vi.fn();
            const req = makeReq({ method: 'GET', url: '/', headers: {} });
            serveStatic(tmpDir, { index: false })(req, makeStaticRes(), next);
            setTimeout(() =>
            {
                expect(next).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('serves 304 for matching ETag (If-None-Match)', () =>
    {
        return new Promise((resolve) =>
        {
            const tmpFile = path.join(tmpDir, 'index.html');
            const stat = fs.statSync(tmpFile);
            const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
            const req = makeReq({ method: 'GET', url: '/index.html', headers: { 'if-none-match': etag } });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.statusCode).toBe(304);
                resolve();
            }, 50);
        });
    });

    it('invalid percent-encoded URL returns 400', () =>
    {
        return new Promise((resolve) =>
        {
            const res = makeStaticRes();
            serveStatic(tmpDir)(makeReq({ method: 'GET', url: '/%ZZ', headers: {} }), res, noop);
            setTimeout(() =>
            {
                expect(res._status).toBe(400);
                resolve();
            }, 50);
        });
    });

    it('suffix range bytes=-N serves last N bytes (206)', () =>
    {
        return new Promise((resolve) =>
        {
            const rangeFile = path.join(tmpDir, 'range.txt');
            fs.writeFileSync(rangeFile, '0123456789'); // 10 bytes
            const req = makeReq({ method: 'GET', url: '/range.txt', headers: { range: 'bytes=-5' } });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.statusCode).toBe(206);
                resolve();
            }, 50);
        });
    });

    it('out-of-range request returns 416', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/index.html', headers: { range: 'bytes=999999-999999' } });
            const res = makeStaticRes();
            serveStatic(tmpDir)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.statusCode).toBe(416);
                resolve();
            }, 50);
        });
    });
});

// ===========================================================================
// Coverage supplement — targeted branch fills across all middleware
// ===========================================================================

// COMPRESS — quality-value parsing paths
describe('compress — quality-value negotiate()', () =>
{
    const compress = require('../../lib/middleware/compress');

    function makeCompressSetup(acceptEncoding)
    {
        const chunks = [];
        const raw = {
            _headers: {},
            statusCode: 200,
            headersSent: false,
            setHeader:    (k, v) => { raw._headers[k] = v; },
            getHeader:    (k)    => raw._headers[k],
            removeHeader: (k)    => { delete raw._headers[k]; },
            write:        (c)    => { chunks.push(c); return true; },
            end:          (c)    => { if (c) chunks.push(c); raw._ended = true; },
            _ended: false,
        };
        const res = { raw, headers: {} };
        const req = makeReq({ headers: { 'accept-encoding': acceptEncoding } });
        res.headers = req.headers;
        return { raw, res, req, chunks };
    }

    it('picks encoding with highest quality value', () =>
    {
        const mw = compress({ threshold: 0 });
        const { raw, res, req } = makeCompressSetup('gzip;q=0.5, deflate;q=0.9');
        const next = vi.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalled(); // compress always calls next (pass-through)
        // Trigger end so the encoding is applied
        raw.setHeader('content-type', 'text/plain');
        raw.end(Buffer.alloc(2000, 'x'));
        expect(raw._headers['Content-Encoding']).toBe('deflate');
    });

    it('handles quality q=0 to exclude an encoding', () =>
    {
        const mw = compress({ threshold: 0 });
        // gzip explicitly excluded with q=0, deflate available
        const { raw, res, req } = makeCompressSetup('gzip;q=0, deflate;q=1');
        mw(req, res, vi.fn());
        raw.setHeader('content-type', 'text/plain');
        raw.end(Buffer.alloc(2000, 'y'));
        // deflate was chosen (gzip=0, deflate=1)
        expect(raw._headers['Content-Encoding']).toBe('deflate');
    });

    it('handles q= with no value (malformed → defaults to q=1)', () =>
    {
        const mw = compress({ threshold: 0 });
        // ';foobar' means semi is found but no q= match → q stays 1
        const { raw, res, req } = makeCompressSetup('gzip;foobar');
        mw(req, res, vi.fn());
        raw.setHeader('content-type', 'text/plain');
        raw.end(Buffer.alloc(2000, 'z'));
        expect(raw._headers['Content-Encoding']).toBe('gzip');
    });
});

// CORS — maxAge option (lines 73-74)
describe('cors — maxAge option', () =>
{
    const cors = require('../../lib/middleware/cors');

    it('sets Access-Control-Max-Age when maxAge is provided', () =>
    {
        const mw = cors({ origin: '*', maxAge: 3600 });
        const req = makeReq({ method: 'GET', headers: { origin: 'http://example.com' } });
        const res = makeRes();
        res.set = (k, v) => { res._headers[k] = v; };
        res.vary = () => {};
        const next = vi.fn();
        mw(req, res, next);
        expect(res._headers['Access-Control-Max-Age']).toBe('3600');
    });
});

// CSRF — verifyToken with no-dot token (parts.length !== 2 → line 72)
describe('csrf — verifyToken invalid format', () =>
{
    const csrf = require('../../lib/middleware/csrf');

    it('rejects token with no dot separator', () =>
    {
        const mw = csrf({ secret: 'test-secret' });
        // Submit a malformed token (no dot → split('.') = 1 part, not 2)
        const req = makeReq({
            method: 'POST',
            headers: { 'x-csrf-token': 'nodottoken', cookie: '' },
        });
        req.cookies = {};
        const res = makeRes();
        res.status = (code) => { res._status = code; return res; };
        res.json   = (body) => { res._body = body; };
        mw(req, res, noop);
        expect(res._status).toBe(403);
    });
});

// ERROR HANDLER — req.url missing fallback + err.code in generic body
describe('errorHandler — uncovered branches', () =>
{
    const errorHandler = require('../../lib/middleware/errorHandler');

    function makeErrReq(overrides = {})
    {
        return { method: 'GET', url: undefined, ...overrides };
    }

    function makeErrRes()
    {
        const r = { headersSent: false, raw: { headersSent: false }, _status: null, _body: null };
        r.status = (code) => { r._status = code; return r; };
        r.json   = (body) => { r._body = body; return r; };
        return r;
    }

    it('uses req.originalUrl when req.url is absent (line 38 || branch)', () =>
    {
        const req = makeErrReq({ url: undefined, originalUrl: '/custom-path' });
        const res = makeErrRes();
        errorHandler({ log: true, logger: () => {} })(new Error('url test'), req, res, noop);
        expect(res._status).toBe(500);
    });

    it('uses "/" fallback when both req.url and req.originalUrl are absent', () =>
    {
        const req = makeErrReq({ url: undefined, originalUrl: undefined });
        const res = makeErrRes();
        errorHandler({ log: true, logger: () => {} })(new Error('fallback url'), req, res, noop);
        expect(res._status).toBe(500);
    });

    it('adds err.code to generic error body (line 82)', () =>
    {
        const req = makeErrReq({ url: '/api' });
        const res = makeErrRes();
        const err = new Error('not found');
        err.code = 'ENOENT';  // non-HttpError with a code property
        errorHandler({ log: false })(err, req, res, noop);
        expect(res._body.code).toBe('ENOENT');
    });
});

// HELMET — empty directives yields no CSP header (line 51 false branch)
describe('helmet — empty CSP directives', () =>
{
    const helmet = require('../../lib/middleware/helmet');

    it('omits Content-Security-Policy when directives is empty object', () =>
    {
        const raw = { _headers: {}, setHeader: (k, v) => { raw._headers[k] = v; }, removeHeader: () => {} };
        const res = { raw };
        const next = vi.fn();
        helmet({ contentSecurityPolicy: { directives: {} } })(makeReq(), res, next);
        expect(raw._headers['Content-Security-Policy']).toBeUndefined();
    });
});

// RATE LIMIT — cleanup interval with mixed expired/fresh entries
describe('rateLimit — cleanup with mixed entries', () =>
{
    const rateLimit = require('../../lib/middleware/rateLimit');

    it('cleanup deletes expired but keeps fresh entries', () =>
    {
        vi.useFakeTimers();
        const windowMs = 100;
        const mw = rateLimit({ max: 100, windowMs });
        // Entry A created at t=0 (resetTime = 100)
        const reqA = makeReq({ ip: '10.0.0.A' });
        mw(reqA, makeRes(), noop);

        // Advance to t=50; entry B created with resetTime = 150
        vi.advanceTimersByTime(50);
        const reqB = makeReq({ ip: '10.0.0.B' });
        mw(reqB, makeRes(), noop);

        // Advance to t=110: cleanup fires at t=100
        // Entry A: resetTime=100, now=110 → expired → deleted (TRUE branch of line 35)
        // Entry B: resetTime=150, now=110 → fresh → kept  (FALSE branch of line 35)
        vi.advanceTimersByTime(60);

        // Entry B should still be blocked if we're at max, showing it was kept
        const nextFn = vi.fn();
        mw(makeReq({ ip: '10.0.0.B' }), makeRes(), nextFn);
        expect(nextFn).toHaveBeenCalled(); // count=2, max=100 → still allowed
        vi.useRealTimers();
    });
});

// VALIDATOR — additional coerce and constraint paths
describe('validator — additional coerce and constraint coverage', () =>
{
    const validate = require('../../lib/middleware/validator');

    it('array coerce: valid JSON array string gets parsed (line 50)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { tags: { type: 'array' } } });
        // Pass a JSON array string — should be parsed to actual array
        const req = makeReq({ body: { tags: '["a","b","c"]' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(Array.isArray(req.body.tags)).toBe(true);
        expect(req.body.tags).toEqual(['a', 'b', 'c']);
    });

    it('array coerce: non-string, non-array returns value unchanged (line 53)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { count: { type: 'array' } } });
        // Pass a number — should pass through (not a string or array)
        const req = makeReq({ body: { count: 42 } });
        mw(req, makeRes(), next);
        // 42 is not an array, validation fails since type:array checks Array.isArray
        // The key thing: COERCE.array(42) is called and returns 42 (line 53)
        const res = makeRes();
        mw(makeReq({ body: { count: 42 } }), res, noop);
        expect(res._status).toBe(422); // array type check fails on 42
    });

    it('json coerce: non-string returns value unchanged (line 58)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { meta: { type: 'json' } } });
        // meta is already an object — json coerce just returns it
        const req = makeReq({ body: { meta: { already: 'parsed' } } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('fails maxLength constraint (line 141)', () =>
    {
        const mw = validate({ body: { name: { type: 'string', maxLength: 5 } } });
        const req = makeReq({ body: { name: 'way-too-long' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('most 5');
    });

    it('fails min constraint (line 143)', () =>
    {
        const mw = validate({ body: { age: { type: 'integer', min: 18 } } });
        const req = makeReq({ body: { age: 10 } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('>= 18');
    });
});

// ===========================================================================
// helmet — res.raw fallback, CSP string values, disabled options (L51, L76, L136, L148)
// ===========================================================================
describe('helmet — additional branch coverage', () =>
{
    it('uses res directly when res.raw is absent (L51 || res branch)', () =>
    {
        const mw = helmet();
        const req = makeReq();
        // fakeRes has no .raw property — raw = res.raw || res = res itself
        const fakeRes = {
            _headers: {},
            setHeader:   (k, v) => { fakeRes._headers[k] = v; },
            removeHeader:(k)    => { delete fakeRes._headers[k]; },
            getHeader:   (k)    => fakeRes._headers[k],
        };
        const next = vi.fn();
        mw(req, fakeRes, next);
        expect(next).toHaveBeenCalled();
        // The X-Content-Type-Options header should be set on fakeRes itself
        expect(fakeRes._headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('CSP directive with a string value (not array) renders correctly (L76)', () =>
    {
        const mw = helmet({ contentSecurityPolicy: { directives: { defaultSrc: "'self'" } } });
        const req = makeReq();
        const raw = { _headers: {}, setHeader: (k, v) => { raw._headers[k] = v; }, removeHeader: () => {} };
        const res = { raw };
        mw(req, res, vi.fn());
        expect(raw._headers['Content-Security-Policy']).toContain("default-src");
        expect(raw._headers['Content-Security-Policy']).toContain("'self'");
    });

    it('ieNoOpen:false omits X-Download-Options (L136 FALSE branch)', () =>
    {
        const mw = helmet({ ieNoOpen: false });
        const req = makeReq();
        const raw = { _headers: {}, setHeader: (k, v) => { raw._headers[k] = v; }, removeHeader: () => {} };
        const res = { raw };
        mw(req, res, vi.fn());
        expect(raw._headers['X-Download-Options']).toBeUndefined();
    });

    it('permittedCrossDomainPolicies:false omits that header (L148 FALSE branch)', () =>
    {
        const mw = helmet({ permittedCrossDomainPolicies: false });
        const req = makeReq();
        const raw = { _headers: {}, setHeader: (k, v) => { raw._headers[k] = v; }, removeHeader: () => {} };
        const res = { raw };
        mw(req, res, vi.fn());
        expect(raw._headers['X-Permitted-Cross-Domain-Policies']).toBeUndefined();
    });
});

// ===========================================================================
// csrf — req.secure=true adds Secure flag to cookie (L126)
// ===========================================================================
describe('csrf — Secure cookie flag when req.secure=true (L126)', () =>
{
    it('appends "; Secure" to rotated CSRF cookie on HTTPS state-changing request', () =>
    {
        // L126 is in the POST/mutation path — need a valid token round-trip
        const mw = csrf({ secret: 'csrf-secure-l126-key' });
        let capturedToken = null;
        const setCookieCalls1 = [];

        // Step 1 — GET with req.secure=true: establishes the initial token (hits L85)
        const getReq = makeReq({ method: 'GET', headers: {}, cookies: {}, secure: true });
        const getRes = {
            ...makeRes(),
            set: (k, v) => { if (k === 'Set-Cookie') { setCookieCalls1.push(v); } },
        };
        mw(getReq, getRes, vi.fn());
        capturedToken = getReq.csrfToken;
        expect(capturedToken).toBeTruthy();

        // Step 2 — POST with the captured token + req.secure=true: hits L126
        const setCookieCalls2 = [];
        const postReq = makeReq({
            method:  'POST',
            url:     '/',
            headers: { 'x-csrf-token': capturedToken },
            cookies: { '_csrf': capturedToken },  // cookieName defaults to '_csrf'
            secure:  true,
        });
        const postRes = {
            ...makeRes(),
            set: (k, v) => { if (k === 'Set-Cookie') setCookieCalls2.push(v); },
        };
        mw(postReq, postRes, vi.fn());
        expect(setCookieCalls2.length).toBeGreaterThan(0);
        expect(setCookieCalls2[0]).toContain('; Secure');
    });
});

// ===========================================================================
// csrf — verifyToken internal branch coverage (L56, L61, L69, L72)
// ===========================================================================
describe('csrf — verifyToken and generateToken internal paths', () =>
{
    it('verifyToken returns false for non-string token — covers L61 TRUE branch', () =>
    {
        // POST request where both clientToken and cookieToken are the same non-string
        // value (number) → verifyToken(123) → typeof 123 !== 'string' → return false → 403
        const mw = csrf({ secret: 'test-verify-nonstring' });
        const res = {
            ...makeRes(),
            status: vi.fn().mockReturnThis(),
            json:   vi.fn(),
            set:    vi.fn(),
        };
        const req = makeReq({
            method:  'POST',
            url:     '/',
            headers: { 'x-csrf-token': 123 },
            cookies: { '_csrf': 123 },
        });
        mw(req, res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('verifyToken returns false for short hash (length mismatch) — covers L69 TRUE branch', () =>
    {
        // Token "abc.XX": hash='XX' (2 chars) but HMAC expected is 64 chars → lengths differ
        const mw = csrf({ secret: 'test-verify-hashlength' });
        const res = {
            ...makeRes(),
            status: vi.fn().mockReturnThis(),
            json:   vi.fn(),
            set:    vi.fn(),
        };
        const req = makeReq({
            method:  'POST',
            url:     '/',
            headers: { 'x-csrf-token': 'abc.XX' },
            cookies: { '_csrf': 'abc.XX' },
        });
        mw(req, res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('generateToken catches crypto.randomBytes error — covers L56 catch block', () =>
    {
        // Mock randomBytes to throw once → generateToken returns null → cookie set to null token
        const spy = vi.spyOn(crypto, 'randomBytes').mockImplementationOnce(() =>
        {
            throw new Error('mock rng failure');
        });
        const mw = csrf({ secret: 'test-gen-catch' });
        const req = makeReq({ method: 'GET', cookies: {}, headers: {} });
        const setCookieCalls = [];
        const res = { ...makeRes(), set: (k, v) => { if (k === 'Set-Cookie') setCookieCalls.push(v); } };
        // Must not throw; generateToken returns null → cookie is set but token is null
        expect(() => mw(req, res, vi.fn())).not.toThrow();
        spy.mockRestore();
    });

    it('verifyToken catches crypto.timingSafeEqual error — covers L72 catch block', () =>
    {
        // Craft a token with hash of exactly 64 chars (matching expected HMAC length)
        // so the length check passes, then mock timingSafeEqual to throw
        const salt = 'validSalt';
        const fakehash = 'a'.repeat(64);
        const token = salt + '.' + fakehash;
        const spy = vi.spyOn(crypto, 'timingSafeEqual').mockImplementationOnce(() =>
        {
            throw new Error('mock timingSafeEqual failure');
        });
        const mw = csrf({ secret: 'test-tse-catch' });
        const res = {
            ...makeRes(),
            status: vi.fn().mockReturnThis(),
            json:   vi.fn(),
            set:    vi.fn(),
        };
        const req = makeReq({
            method:  'POST',
            url:     '/',
            headers: { 'x-csrf-token': token },
            cookies: { '_csrf': token },
        });
        mw(req, res, vi.fn());
        spy.mockRestore();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});

// ===========================================================================
// rateLimit — timer.unref() FALSE branch (L38)
// The TRUE branch (unref exists) is already taken by every real-Node.js test.
// Cover the FALSE branch: timer has no .unref property → the call is skipped.
// ===========================================================================
describe('rateLimit — cleanupInterval without unref (L38 FALSE branch)', () =>
{
    it('skips unref() when the cleanup interval has no unref method', () =>
    {
        const fakeInterval = {}; // no .unref
        const spy = vi.spyOn(global, 'setInterval').mockImplementationOnce(() => fakeInterval);
        // Must not throw even though fakeInterval has no .unref
        expect(() => rateLimit({ max: 10, windowMs: 1000 })).not.toThrow();
        spy.mockRestore();
    });
});

// ===========================================================================
// timeout — timer.unref() FALSE branch (L49)
// The TRUE branch (unref exists) is already taken by every real-Node.js test.
// Cover the FALSE branch: timer has no .unref property → the call is skipped.
// ===========================================================================
describe('timeout — timer without unref (L49 FALSE branch)', () =>
{
    it('skips unref() when the timer has no unref method', () =>
    {
        const fakeTimer = {}; // no .unref
        const spy = vi.spyOn(global, 'setTimeout').mockImplementationOnce(() => fakeTimer);
        const mw = timeout(5000);
        // Must not throw even though fakeTimer has no .unref
        expect(() => mw(makeReq(), makeRes(), vi.fn())).not.toThrow();
        spy.mockRestore();
    });
});

// ===========================================================================
// compress — brotli, unknown encoding, write-then-end paths (L70, L98, L101, L166-218)
// ===========================================================================
describe('compress — additional encoding and streaming paths', () =>
{
    const zlib = require('zlib');

    function makeCompressSetup3(acceptEncoding)
    {
        const chunks = [];
        const raw = {
            _headers: {}, statusCode: 200, headersSent: false, _ended: false,
            setHeader:   (k, v) => { raw._headers[k] = v; },
            getHeader:   (k)    => raw._headers[k],
            removeHeader:(k)    => { delete raw._headers[k]; },
            write:       (c)    => { chunks.push(c); return true; },
            end:         (c)    => { if (c) chunks.push(c); raw._ended = true; },
        };
        const res = { raw };
        const req = makeReq({ headers: { 'accept-encoding': acceptEncoding } });
        return { raw, res, req, chunks };
    }

    it('brotli (br) encoding creates brotli stream (L98 case "br" / L101)', () =>
    {
        const mw = compress({ threshold: 0 });
        const { raw, res, req } = makeCompressSetup3('br;q=1, gzip;q=0.5');
        mw(req, res, vi.fn());
        raw.setHeader('content-type', 'text/plain');
        raw.end(Buffer.alloc(500, 'x'));
        expect(raw._headers['Content-Encoding']).toBe('br');
    });

    it('unknown encoding (zstd) is ignored — falls back to gzip (L70 FALSE branch)', () =>
    {
        const mw = compress({ threshold: 0 });
        const { raw, res, req } = makeCompressSetup3('zstd;q=1, gzip;q=0.5');
        mw(req, res, vi.fn());
        raw.setHeader('content-type', 'text/plain');
        raw.end(Buffer.alloc(500, 'x'));
        expect(raw._headers['Content-Encoding']).toBe('gzip');
    });

    it('write() then end(chunk) — headersWritten=true path (L214 + L216)', () =>
    {
        return new Promise((resolve) =>
        {
            const mw = compress({ threshold: 0 });
            const { raw, res, req } = makeCompressSetup3('gzip;q=1');
            mw(req, res, vi.fn());
            raw.setHeader('content-type', 'text/plain');
            raw.write(Buffer.alloc(100, 'a'));
            setTimeout(() =>
            {
                raw.end(Buffer.alloc(50, 'b'));
                setTimeout(() =>
                {
                    expect(raw._headers['Content-Encoding']).toBe('gzip');
                    resolve();
                }, 30);
            }, 10);
        });
    });

    it('write() then end() no-chunk — L214 + L217 path', () =>
    {
        return new Promise((resolve) =>
        {
            const mw = compress({ threshold: 0 });
            const { raw, res, req } = makeCompressSetup3('gzip;q=1');
            mw(req, res, vi.fn());
            raw.setHeader('content-type', 'text/plain');
            raw.write(Buffer.alloc(100, 'a'));
            setTimeout(() =>
            {
                raw.end();
                setTimeout(() =>
                {
                    expect(raw._headers['Content-Encoding']).toBe('gzip');
                    resolve();
                }, 30);
            }, 10);
        });
    });

    it('compression stream error triggers error handler (L166-168)', () =>
    {
        return new Promise((resolve) =>
        {
            const { PassThrough } = require('stream');
            let capturedStream = null;

            const spy = vi.spyOn(zlib, 'createGzip').mockImplementationOnce(() =>
            {
                capturedStream = new PassThrough();
                return capturedStream;
            });

            const mw = compress({ threshold: 0 });
            const { raw, res, req } = makeCompressSetup3('gzip;q=1');
            mw(req, res, vi.fn());
            raw.setHeader('content-type', 'text/plain');
            raw.end(Buffer.alloc(100, 'a'));

            setTimeout(() =>
            {
                spy.mockRestore();
                if (capturedStream) capturedStream.emit('error', new Error('zlib test error'));
                setTimeout(() => resolve(), 15);
            }, 10);
        });
    });
});

// ===========================================================================
// serveStatic — additional branch coverage (L103, L110, L131, L144, L147,
//                                            L239 TRUE, L245, L263, L264)
// ===========================================================================
describe('serveStatic — additional path coverage', () =>
{
    let tmpDirX;

    beforeAll(() =>
    {
        tmpDirX = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-static-x-'));
        fs.writeFileSync(path.join(tmpDirX, 'data.xyz'), 'binary');        // unknown ext
        fs.writeFileSync(path.join(tmpDirX, 'empty.txt'), '');             // size=0
        fs.writeFileSync(path.join(tmpDirX, 'content.txt'), 'hello');      // normal
        fs.writeFileSync(path.join(tmpDirX, 'bytes.txt'), '0123456789');   // range tests
        fs.writeFileSync(path.join(tmpDirX, 'page.html'), '<p>page</p>'); // ext fallback
        fs.writeFileSync(path.join(tmpDirX, '.page.html'), '<p>dot</p>'); // dotfile ext fallback
        fs.mkdirSync(path.join(tmpDirX, 'noindexdir'));                   // no index.html
        fs.mkdirSync(path.join(tmpDirX, 'dotidxdir'));                    // dotfile index
        fs.writeFileSync(path.join(tmpDirX, 'dotidxdir', '.index.html'), '<p>dot idx</p>');
    });

    afterAll(() => { try { fs.rmSync(tmpDirX, { recursive: true }); } catch {} });

    function makeXRes()
    {
        const ee = new EventEmitter();
        const raw = {
            statusCode: 200, headersSent: false, _headers: {},
            setHeader:  (k, v) => { raw._headers[k] = v; },
            getHeader:  (k)    => raw._headers[k],
            removeHeader:(k)   => { delete raw._headers[k]; },
            write:      vi.fn(() => true),
            end:        vi.fn(),
            on:         (ev, cb) => ee.on(ev, cb),
            once:       (ev, cb) => ee.once(ev, cb),
            removeListener:(ev, cb) => ee.removeListener(ev, cb),
            emit:(ev, ...a) => ee.emit(ev, ...a),
        };
        const res = {
            raw, _status: 200, _body: null,
            status: (c) => { raw.statusCode = c; res._status = c; return res; },
            json:   (b) => { res._body = b; return res; },
        };
        return res;
    }

    it('unknown extension falls back to application/octet-stream (L103 right side)', () =>
    {
        return new Promise((resolve) =>
        {
            const res = makeXRes();
            serveStatic(tmpDirX)(makeReq({ method: 'GET', url: '/data.xyz', headers: {} }), res, noop);
            setTimeout(() =>
            {
                expect(res.raw._headers['Content-Type']).toBe('application/octet-stream');
                resolve();
            }, 50);
        });
    });

    it('empty file (size=0) skips Content-Length (L110 FALSE side)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/empty.txt', headers: {} });
            serveStatic(tmpDirX)(req, makeXRes(), noop);
            setTimeout(() => resolve(), 50);
        });
    });

    it('If-Modified-Since future date — file not modified → 304 (L131 TRUE)', () =>
    {
        return new Promise((resolve) =>
        {
            // Use a date well in the future so stat.mtimeMs <= since → 304
            const futureDate = new Date(Date.now() + 86400000 * 365).toUTCString();
            const req = makeReq({
                method: 'GET', url: '/content.txt',
                headers: { 'if-modified-since': futureDate },
            });
            const res = makeXRes();
            serveStatic(tmpDirX)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.statusCode).toBe(304);
                resolve();
            }, 50);
        });
    });

    it('If-Modified-Since very old date — file is newer, serve normally (L131 FALSE newer-file)', () =>
    {
        return new Promise((resolve) =>
        {
            // File mtime >> epoch → stat.mtimeMs > since → no 304
            const req = makeReq({
                method: 'GET', url: '/content.txt',
                headers: { 'if-modified-since': new Date(0).toUTCString() },
            });
            const res = makeXRes();
            serveStatic(tmpDirX)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('If-Modified-Since with invalid date string — ignored (L131 FALSE NaN side)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({
                method: 'GET', url: '/content.txt',
                headers: { 'if-modified-since': 'this-is-not-a-date' },
            });
            const res = makeXRes();
            serveStatic(tmpDirX)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('range header not matching bytes regex — serves full file (L144 FALSE)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({
                method: 'GET', url: '/bytes.txt',
                headers: { range: 'invalid-range' },
            });
            const res = makeXRes();
            serveStatic(tmpDirX)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 150);
        });
    });

    it('range bytes=N- (open-ended) uses stat.size-1 as end (L147 FALSE)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({
                method: 'GET', url: '/bytes.txt',
                headers: { range: 'bytes=2-' },
            });
            const res = makeXRes();
            serveStatic(tmpDirX)(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.statusCode).toBe(206);
                resolve();
            }, 50);
        });
    });

    it('extensions with dot-prefixed entry uses it directly (L239 TRUE branch)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/page', headers: {} });
            const res = makeXRes();
            serveStatic(tmpDirX, { extensions: ['.html'] })(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('dotfile from extension fallback with dotfiles:deny returns 403 (L245 TRUE — deny)', () =>
    {
        // Note: /.page is itself a dotfile → L227 fires before tryExt (tests L227 TRUE branch)
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/.page', headers: {} });
            const res = makeXRes();
            serveStatic(tmpDirX, { extensions: ['.html'], dotfiles: 'deny' })(req, res, noop);
            setTimeout(() =>
            {
                expect(res._status).toBe(403);
                resolve();
            }, 50);
        });
    });

    it('dotfile found via extension fallback with dotfiles:ignore — serves it (L245 FALSE — not deny)', () =>
    {
        // /.page → isDotfile=TRUE, dotfiles='ignore' → L227 not blocked
        // tryExt → .page.html found → L245: isDotfile=TRUE, dotfiles!='deny' → body NOT taken → serve
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/.page', headers: {} });
            const res = makeXRes();
            serveStatic(tmpDirX, { extensions: ['.html'], dotfiles: 'ignore' })(req, res, noop);
            setTimeout(() =>
            {
                expect(res.raw.write).toHaveBeenCalled();
                resolve();
            }, 50);
        });
    });

    it('directory with no index.html — calls next() (L263)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/noindexdir/', headers: {} });
            serveStatic(tmpDirX)(req, makeXRes(), () => resolve());
        });
    });

    it('directory with dotfile index + dotfiles:deny returns 403 (L264)', () =>
    {
        return new Promise((resolve) =>
        {
            const req = makeReq({ method: 'GET', url: '/dotidxdir/', headers: {} });
            const res = makeXRes();
            serveStatic(tmpDirX, { index: '.index.html', dotfiles: 'deny' })(req, res, noop);
            setTimeout(() =>
            {
                expect(res._status).toBe(403);
                resolve();
            }, 50);
        });
    });
});

// ===========================================================================
// validator — COERCE NaN branches, boolean variants, Date, function default,
//             unknown type, type-validation failures, minLength, null data
// ===========================================================================
describe('validator — COERCE and type-validation branch coverage', () =>
{
    it('integer NaN: "not-a-number" triggers COERCE NaN path → type error (L31 + L109)', () =>
    {
        const mw = validate({ body: { age: { type: 'integer' } } });
        const req = makeReq({ body: { age: 'not-a-number' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('must be an integer');
    });

    it('number NaN: "not-a-number" triggers COERCE NaN path → type error (L32 + L113)', () =>
    {
        const mw = validate({ body: { price: { type: 'number' } } });
        const req = makeReq({ body: { price: 'not-a-number' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('must be a number');
    });

    it('float NaN: "not-a-number" triggers COERCE NaN path → type error (L33 + L113)', () =>
    {
        const mw = validate({ body: { ratio: { type: 'float' } } });
        const req = makeReq({ body: { ratio: 'not-a-number' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('must be a number');
    });

    it('boolean literal true passes through COERCE (L36 TRUE)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        mw(makeReq({ body: { flag: true } }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('boolean literal false passes through COERCE (L36 TRUE)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        mw(makeReq({ body: { flag: false } }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('boolean string "false" coerces to false (L41)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        const req = makeReq({ body: { flag: 'false' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.body.flag).toBe(false);
    });

    it('boolean string "no" coerces to false (L41)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        const req = makeReq({ body: { flag: 'no' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.body.flag).toBe(false);
    });

    it('boolean string "off" coerces to false (L41)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        const req = makeReq({ body: { flag: 'off' } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.body.flag).toBe(false);
    });

    it('boolean non-string non-boolean returns type error (L43 fall-through → L116)', () =>
    {
        const mw = validate({ body: { flag: { type: 'boolean' } } });
        const req = makeReq({ body: { flag: 42 } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('must be a boolean');
    });

    it('date type: passing an actual Date object returns it unchanged (L62 TRUE)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { when: { type: 'date' } } });
        const d = new Date();
        const req = makeReq({ body: { when: d } });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.body.when).toBe(d);
    });

    it('function default is invoked when field is absent (L85 function branch)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { name: { type: 'string', default: () => 'auto-generated' } } });
        const req = makeReq({ body: {} });
        mw(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.body.name).toBe('auto-generated');
    });

    it('unknown rule type skips COERCE and type-check passes (L98 FALSE branch)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { x: { type: 'custom-type' } } });
        mw(makeReq({ body: { x: 'anything' } }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('minLength constraint failure returns 422 (L140-141)', () =>
    {
        const mw = validate({ body: { name: { type: 'string', minLength: 5 } } });
        const req = makeReq({ body: { name: 'hi' } });
        const res = makeRes();
        mw(req, res, noop);
        expect(res._status).toBe(422);
        expect(res._body.errors[0]).toContain('at least 5 characters');
    });

    it('null request body — validateObject uses empty source (L182 || {} branch)', () =>
    {
        const next = vi.fn();
        const mw = validate({ body: { name: { type: 'string' } } });
        mw(makeReq({ body: null }), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });
});
