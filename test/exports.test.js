const {
    createApp, Router, json, urlencoded, text, raw, multipart,
    static: staticMid, cors, fetch, rateLimit, logger, compress,
    helmet, timeout, requestId, cookieParser, WebSocketPool,
    csrf, validate, env, Database, Model, TYPES, Query, version
} = require('../');

describe('Module Exports', () => {
    it('createApp', () => expect(typeof createApp).toBe('function'));
    it('Router', () => expect(typeof Router).toBe('function'));
    it('cors', () => expect(typeof cors).toBe('function'));
    it('fetch', () => expect(typeof fetch).toBe('function'));
    it('json', () => expect(typeof json).toBe('function'));
    it('urlencoded', () => expect(typeof urlencoded).toBe('function'));
    it('text', () => expect(typeof text).toBe('function'));
    it('raw', () => expect(typeof raw).toBe('function'));
    it('multipart', () => expect(typeof multipart).toBe('function'));
    it('static', () => expect(typeof staticMid).toBe('function'));
    it('rateLimit', () => expect(typeof rateLimit).toBe('function'));
    it('logger', () => expect(typeof logger).toBe('function'));
    it('compress', () => expect(typeof compress).toBe('function'));
    it('helmet', () => expect(typeof helmet).toBe('function'));
    it('timeout', () => expect(typeof timeout).toBe('function'));
    it('requestId', () => expect(typeof requestId).toBe('function'));
    it('cookieParser', () => expect(typeof cookieParser).toBe('function'));
    it('WebSocketPool', () => expect(typeof WebSocketPool).toBe('function'));
    it('csrf', () => expect(typeof csrf).toBe('function'));
    it('validate', () => expect(typeof validate).toBe('function'));
    it('env', () => expect(typeof env).toBe('function'));
    it('Database', () => expect(typeof Database).toBe('function'));
    it('Model', () => expect(typeof Model).toBe('function'));
    it('TYPES', () => expect(typeof TYPES).toBe('object'));
    it('Query', () => expect(typeof Query).toBe('function'));
    it('version', () =>
    {
        expect(typeof version).toBe('string');
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
});
