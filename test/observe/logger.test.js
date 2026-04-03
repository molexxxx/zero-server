const { Logger, structuredLogger, LEVELS, LEVEL_NAMES } = require('../../lib/observe/logger');

// ── Logger Core ─────────────────────────────────────────────────

describe('Logger', () =>
{
    describe('constructor', () =>
    {
        it('creates with default options', () =>
        {
            const log = new Logger();
            expect(log).toBeInstanceOf(Logger);
        });

        it('accepts level as string', () =>
        {
            const log = new Logger({ level: 'warn' });
            const entries = [];
            const log2 = new Logger({ level: 'warn', transport: (e) => entries.push(e) });
            log2.info('should be silenced');
            log2.warn('should appear');
            expect(entries).toHaveLength(1);
            expect(entries[0].message).toBe('should appear');
        });

        it('accepts level as number', () =>
        {
            const entries = [];
            const log = new Logger({ level: 4, transport: (e) => entries.push(e) });
            log.warn('silenced');
            log.error('visible');
            expect(entries).toHaveLength(1);
            expect(entries[0].level).toBe('error');
        });

        it('uses silent level in test environment', () =>
        {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'test';
            const entries = [];
            const log = new Logger({ transport: (e) => entries.push(e) });
            log.info('should be silenced');
            expect(entries).toHaveLength(0);
            process.env.NODE_ENV = originalEnv;
        });

        it('uses info level in production', () =>
        {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            const entries = [];
            const log = new Logger({ transport: (e) => entries.push(e) });
            log.debug('silenced');
            log.info('visible');
            expect(entries).toHaveLength(1);
            process.env.NODE_ENV = originalEnv;
        });
    });

    describe('log levels', () =>
    {
        it('logs at trace level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'trace', transport: (e) => entries.push(e) });
            log.trace('trace msg');
            expect(entries).toHaveLength(1);
            expect(entries[0].level).toBe('trace');
            expect(entries[0].message).toBe('trace msg');
        });

        it('logs at debug level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'debug', transport: (e) => entries.push(e) });
            log.debug('debug msg');
            expect(entries[0].level).toBe('debug');
        });

        it('logs at info level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e) });
            log.info('info msg');
            expect(entries[0].level).toBe('info');
        });

        it('logs at warn level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'warn', transport: (e) => entries.push(e) });
            log.warn('warn msg');
            expect(entries[0].level).toBe('warn');
        });

        it('logs at error level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'error', transport: (e) => entries.push(e) });
            log.error('error msg');
            expect(entries[0].level).toBe('error');
        });

        it('logs at fatal level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'fatal', transport: (e) => entries.push(e) });
            log.fatal('fatal msg');
            expect(entries[0].level).toBe('fatal');
        });

        it('silences levels below minimum', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'error', transport: (e) => entries.push(e) });
            log.trace('no');
            log.debug('no');
            log.info('no');
            log.warn('no');
            log.error('yes');
            log.fatal('yes');
            expect(entries).toHaveLength(2);
        });
    });

    describe('setLevel', () =>
    {
        it('changes level at runtime', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'error', transport: (e) => entries.push(e) });
            log.info('no');
            log.setLevel('info');
            log.info('yes');
            expect(entries).toHaveLength(1);
        });

        it('accepts numeric level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'silent', transport: (e) => entries.push(e) });
            log.setLevel(0);
            log.trace('yes');
            expect(entries).toHaveLength(1);
        });
    });

    describe('child loggers', () =>
    {
        it('creates child with merged context', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e) });
            const child = log.child({ userId: 42 });
            child.info('test');
            expect(entries[0].userId).toBe(42);
            expect(entries[0].message).toBe('test');
        });

        it('child inherits parent level', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'warn', transport: (e) => entries.push(e) });
            const child = log.child({ scope: 'auth' });
            child.info('should not appear');
            child.warn('should appear');
            expect(entries).toHaveLength(1);
        });

        it('child preserves parent context', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e), context: { service: 'api' } });
            const child = log.child({ handler: 'users' });
            child.info('test');
            expect(entries[0].service).toBe('api');
            expect(entries[0].handler).toBe('users');
        });

        it('nested children merge all contexts', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e), context: { a: 1 } });
            const child1 = log.child({ b: 2 });
            const child2 = child1.child({ c: 3 });
            child2.info('deep');
            expect(entries[0]).toMatchObject({ a: 1, b: 2, c: 3, message: 'deep' });
        });

        it('child context does not affect parent', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e) });
            const child = log.child({ extra: true });
            log.info('parent');
            expect(entries[0].extra).toBeUndefined();
        });
    });

    describe('fields parameter', () =>
    {
        it('merges object fields into entry', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e) });
            log.info('msg', { extra: 'data', count: 5 });
            expect(entries[0]).toMatchObject({ message: 'msg', extra: 'data', count: 5 });
        });

        it('handles Error as fields', () =>
        {
            const entries = [];
            const log = new Logger({ level: 'info', transport: (e) => entries.push(e) });
            const err = new Error('boom');
            err.code = 'ERR_BOOM';
            log.error('failed', err);
            expect(entries[0].error.message).toBe('boom');
            expect(entries[0].error.code).toBe('ERR_BOOM');
            expect(entries[0].error.stack).toBeDefined();
        });
    });

    describe('output formatting', () =>
    {
        it('writes JSON when json=true', () =>
        {
            const chunks = [];
            const stream = { write: (d) => chunks.push(d) };
            const log = new Logger({ level: 'info', json: true, stream });
            log.info('hello');
            const parsed = JSON.parse(chunks[0].trim());
            expect(parsed.message).toBe('hello');
            expect(parsed.level).toBe('info');
            expect(parsed.timestamp).toBeDefined();
        });

        it('writes pretty text when json=false', () =>
        {
            const chunks = [];
            const stream = { write: (d) => chunks.push(d) };
            const log = new Logger({ level: 'info', json: false, colors: false, stream });
            log.info('hello');
            expect(chunks[0]).toContain('hello');
            expect(chunks[0]).toContain('INFO');
        });

        it('includes timestamps by default', () =>
        {
            const chunks = [];
            const stream = { write: (d) => chunks.push(d) };
            const log = new Logger({ level: 'info', json: true, stream });
            log.info('test');
            const parsed = JSON.parse(chunks[0].trim());
            expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('respects timestamps=false', () =>
        {
            const chunks = [];
            const stream = { write: (d) => chunks.push(d) };
            const log = new Logger({ level: 'info', json: false, colors: false, timestamps: false, stream });
            log.info('test');
            // Should not start with a timestamp
            expect(chunks[0]).toMatch(/^INFO/);
        });

        it('includes extra context fields in pretty output', () =>
        {
            const chunks = [];
            const stream = { write: (d) => chunks.push(d) };
            const log = new Logger({ level: 'info', json: false, colors: false, stream, context: { reqId: 'abc' } });
            log.info('hello');
            expect(chunks[0]).toContain('reqId');
        });
    });
});

// ── Structured Logger Middleware ─────────────────────────────────

describe('structuredLogger middleware', () =>
{
    it('creates a middleware function', () =>
    {
        const mw = structuredLogger();
        expect(typeof mw).toBe('function');
        expect(mw.length).toBe(3);
    });

    it('attaches req.log child logger', () =>
    {
        const mw = structuredLogger({ level: 'silent' });
        const req = { id: 'req-123', method: 'GET', url: '/test', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), {
            statusCode: 200,
            getHeader: () => null,
        });
        const res = { raw };
        let nextCalled = false;
        mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(req.log).toBeDefined();
        expect(typeof req.log.info).toBe('function');
        expect(typeof req.log.child).toBe('function');
    });

    it('logs request on response finish', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
        });
        const req = { id: 'req-456', method: 'POST', url: '/api/users', originalUrl: '/api/users', headers: { 'user-agent': 'test/1.0' }, ip: '127.0.0.1' };
        const raw = Object.assign(new (require('events').EventEmitter)(), {
            statusCode: 201,
            getHeader: (h) => h === 'content-length' ? '42' : null,
        });
        const res = { raw };

        mw(req, res, () => {});
        raw.emit('finish');

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            method: 'POST',
            url: '/api/users',
            status: 201,
            ip: '127.0.0.1',
            requestId: 'req-456',
        });
        expect(entries[0].duration).toBeGreaterThanOrEqual(0);
        expect(entries[0].userAgent).toBe('test/1.0');
    });

    it('uses error level for 5xx status', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
        });
        const req = { method: 'GET', url: '/fail', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), {
            statusCode: 500,
            getHeader: () => null,
        });
        const res = { raw };

        mw(req, res, () => {});
        raw.emit('finish');

        expect(entries[0].level).toBe('error');
    });

    it('uses warn level for 4xx status', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
        });
        const req = { method: 'GET', url: '/missing', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), {
            statusCode: 404,
            getHeader: () => null,
        });
        const res = { raw };

        mw(req, res, () => {});
        raw.emit('finish');

        expect(entries[0].level).toBe('warn');
    });

    it('respects skip option', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
            skip: (req) => req.url === '/healthz',
        });

        const req1 = { method: 'GET', url: '/healthz', headers: {} };
        const raw1 = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req1, { raw: raw1 }, () => {});
        raw1.emit('finish');

        const req2 = { method: 'GET', url: '/api', headers: {} };
        const raw2 = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req2, { raw: raw2 }, () => {});
        raw2.emit('finish');

        expect(entries).toHaveLength(1);
        expect(entries[0].url).toBe('/api');
    });

    it('includes customFields', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
            customFields: (req) => ({ tenant: 'acme' }),
        });
        const req = { method: 'GET', url: '/', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req, { raw }, () => {});
        raw.emit('finish');

        expect(entries[0].tenant).toBe('acme');
    });

    it('handles customFields error gracefully', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
            customFields: () => { throw new Error('boom'); },
        });
        const req = { method: 'GET', url: '/', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req, { raw }, () => {});
        raw.emit('finish');

        expect(entries).toHaveLength(1); // should still log
    });

    it('works without req.id', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
        });
        const req = { method: 'GET', url: '/', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req, { raw }, () => {});
        raw.emit('finish');

        expect(entries).toHaveLength(1);
        expect(entries[0].requestId).toBeUndefined();
    });

    it('supports custom message template', () =>
    {
        const entries = [];
        const mw = structuredLogger({
            level: 'info',
            format: 'json',
            transport: (e) => entries.push(e),
            msg: ':method :url responded :status in :duration ms',
        });
        const req = { method: 'GET', url: '/test', headers: {} };
        const raw = Object.assign(new (require('events').EventEmitter)(), { statusCode: 200, getHeader: () => null });
        mw(req, { raw }, () => {});
        raw.emit('finish');

        expect(entries[0].message).toContain('GET');
        expect(entries[0].message).toContain('/test');
        expect(entries[0].message).toContain('200');
    });
});

// ── Constants ────────────────────────────────────────────────────

describe('Logger constants', () =>
{
    it('exports LEVELS', () =>
    {
        expect(LEVELS.trace).toBe(0);
        expect(LEVELS.debug).toBe(1);
        expect(LEVELS.info).toBe(2);
        expect(LEVELS.warn).toBe(3);
        expect(LEVELS.error).toBe(4);
        expect(LEVELS.fatal).toBe(5);
        expect(LEVELS.silent).toBe(6);
    });

    it('exports LEVEL_NAMES', () =>
    {
        expect(LEVEL_NAMES).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    });
});
