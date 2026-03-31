/**
 * Comprehensive tests for error handling, error classes, error handler middleware,
 * debug logger, and router error protection.
 */
const http = require('http');

// --- Error Classes -----------------------------------------------

describe('Error Classes', () =>
{
    const {
        HttpError, BadRequestError, UnauthorizedError, ForbiddenError,
        NotFoundError, MethodNotAllowedError, ConflictError, GoneError,
        PayloadTooLargeError, UnprocessableEntityError, ValidationError,
        TooManyRequestsError, InternalError, NotImplementedError,
        BadGatewayError, ServiceUnavailableError,
        DatabaseError, ConfigurationError, MiddlewareError, RoutingError, TimeoutError,
        createError, isHttpError,
    } = require('../../lib/errors');

    describe('HttpError base class', () =>
    {
        it('sets statusCode, message, and auto-generates code', () =>
        {
            const err = new HttpError(404, 'User not found');
            expect(err.statusCode).toBe(404);
            expect(err.message).toBe('User not found');
            expect(err.code).toBe('NOT_FOUND');
            expect(err.name).toBe('HttpError');
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(HttpError);
        });

        it('uses status text as default message', () =>
        {
            const err = new HttpError(500);
            expect(err.message).toBe('Internal Server Error');
        });

        it('accepts custom code and details', () =>
        {
            const err = new HttpError(422, 'Nope', { code: 'CUSTOM_CODE', details: { field: 'email' } });
            expect(err.code).toBe('CUSTOM_CODE');
            expect(err.details).toEqual({ field: 'email' });
        });

        it('toJSON serializes correctly', () =>
        {
            const err = new HttpError(400, 'Bad input', { details: ['a', 'b'] });
            const json = err.toJSON();
            expect(json.error).toBe('Bad input');
            expect(json.code).toBe('BAD_REQUEST');
            expect(json.statusCode).toBe(400);
            expect(json.details).toEqual(['a', 'b']);
        });

        it('toJSON omits details when not set', () =>
        {
            const err = new HttpError(500);
            const json = err.toJSON();
            expect(json.details).toBeUndefined();
        });

        it('has a stack trace', () =>
        {
            const err = new HttpError(500, 'boom');
            expect(err.stack).toBeDefined();
            expect(err.stack).toContain('boom');
        });
    });

    describe('Specific error classes', () =>
    {
        const cases = [
            [BadRequestError, 400, 'BAD_REQUEST'],
            [UnauthorizedError, 401, 'UNAUTHORIZED'],
            [ForbiddenError, 403, 'FORBIDDEN'],
            [NotFoundError, 404, 'NOT_FOUND'],
            [MethodNotAllowedError, 405, 'METHOD_NOT_ALLOWED'],
            [ConflictError, 409, 'CONFLICT'],
            [GoneError, 410, 'GONE'],
            [PayloadTooLargeError, 413, 'PAYLOAD_TOO_LARGE'],
            [UnprocessableEntityError, 422, 'UNPROCESSABLE_ENTITY'],
            [TooManyRequestsError, 429, 'TOO_MANY_REQUESTS'],
            [InternalError, 500, 'INTERNAL_SERVER_ERROR'],
            [NotImplementedError, 501, 'NOT_IMPLEMENTED'],
            [BadGatewayError, 502, 'BAD_GATEWAY'],
            [ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE'],
        ];

        it.each(cases)('%s has statusCode %d and code %s', (Cls, status, code) =>
        {
            const err = new Cls();
            expect(err.statusCode).toBe(status);
            expect(err.code).toBe(code);
            expect(err).toBeInstanceOf(HttpError);
            expect(err).toBeInstanceOf(Error);
        });

        it('each accepts custom message', () =>
        {
            const err = new NotFoundError('User 42 not found');
            expect(err.message).toBe('User 42 not found');
            expect(err.statusCode).toBe(404);
        });

        it('each accepts opts with details', () =>
        {
            const err = new BadRequestError('Missing field', { details: { name: 'required' } });
            expect(err.details).toEqual({ name: 'required' });
        });
    });

    describe('ValidationError', () =>
    {
        it('has status 422 and VALIDATION_FAILED code', () =>
        {
            const err = new ValidationError();
            expect(err.statusCode).toBe(422);
            expect(err.code).toBe('VALIDATION_FAILED');
            expect(err.message).toBe('Validation Failed');
        });

        it('stores field errors in .errors and .details', () =>
        {
            const fieldErrors = { email: 'required', age: 'must be >= 18' };
            const err = new ValidationError('Invalid input', fieldErrors);
            expect(err.errors).toEqual(fieldErrors);
            expect(err.details).toEqual(fieldErrors);
        });

        it('serializes field errors through toJSON', () =>
        {
            const err = new ValidationError('Bad data', { name: 'too short' });
            const json = err.toJSON();
            expect(json.details).toEqual({ name: 'too short' });
            expect(json.code).toBe('VALIDATION_FAILED');
        });

        it('accepts array of errors', () =>
        {
            const errs = ['name is required', 'email is invalid'];
            const err = new ValidationError('check fields', errs);
            expect(err.errors).toEqual(errs);
            expect(err.details).toEqual(errs);
        });
    });

    describe('createError factory', () =>
    {
        it('creates typed errors for known status codes', () =>
        {
            const err = createError(404, 'Gone fishing');
            expect(err).toBeInstanceOf(NotFoundError);
            expect(err.message).toBe('Gone fishing');
        });

        it('creates generic HttpError for unknown codes', () =>
        {
            const err = createError(418, "I'm a Teapot");
            expect(err).toBeInstanceOf(HttpError);
            expect(err.statusCode).toBe(418);
        });

        it('passes opts through', () =>
        {
            const err = createError(400, 'Nope', { code: 'MY_CODE', details: { x: 1 } });
            expect(err.code).toBe('MY_CODE');
            expect(err.details).toEqual({ x: 1 });
        });
    });

    describe('isHttpError', () =>
    {
        it('returns true for HttpError instances', () =>
        {
            expect(isHttpError(new HttpError(500))).toBe(true);
            expect(isHttpError(new NotFoundError())).toBe(true);
            expect(isHttpError(new ValidationError())).toBe(true);
        });

        it('returns true for duck-typed errors with statusCode', () =>
        {
            const err = new Error('custom');
            err.statusCode = 400;
            expect(isHttpError(err)).toBe(true);
        });

        it('returns false for non-errors', () =>
        {
            expect(isHttpError(null)).toBe(false);
            expect(isHttpError(undefined)).toBe(false);
            expect(isHttpError({ statusCode: 400 })).toBe(false);  // not Error instance
            expect(isHttpError(new Error('plain'))).toBe(false);     // no statusCode
        });
    });

    // --- Framework Error Classes ---------------------------------

    describe('DatabaseError', () =>
    {
        it('has status 500 and DATABASE_ERROR code', () =>
        {
            const err = new DatabaseError();
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('DATABASE_ERROR');
            expect(err.message).toBe('Database Error');
            expect(err).toBeInstanceOf(HttpError);
        });

        it('stores query and adapter properties', () =>
        {
            const err = new DatabaseError('Insert failed', { query: 'INSERT INTO users ...', adapter: 'sqlite' });
            expect(err.message).toBe('Insert failed');
            expect(err.query).toBe('INSERT INTO users ...');
            expect(err.adapter).toBe('sqlite');
        });

        it('accepts details in options', () =>
        {
            const err = new DatabaseError('Constraint violation', { details: { field: 'email', constraint: 'unique' } });
            expect(err.details).toEqual({ field: 'email', constraint: 'unique' });
        });

        it('serializes via toJSON', () =>
        {
            const err = new DatabaseError('Connection lost');
            const json = err.toJSON();
            expect(json.error).toBe('Connection lost');
            expect(json.code).toBe('DATABASE_ERROR');
            expect(json.statusCode).toBe(500);
        });
    });

    describe('ConfigurationError', () =>
    {
        it('has status 500 and CONFIGURATION_ERROR code', () =>
        {
            const err = new ConfigurationError();
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('CONFIGURATION_ERROR');
            expect(err.message).toBe('Configuration Error');
            expect(err).toBeInstanceOf(HttpError);
        });

        it('stores setting property', () =>
        {
            const err = new ConfigurationError('Invalid port', { setting: 'port' });
            expect(err.setting).toBe('port');
        });

        it('accepts custom message', () =>
        {
            const err = new ConfigurationError('TLS cert not found');
            expect(err.message).toBe('TLS cert not found');
        });
    });

    describe('MiddlewareError', () =>
    {
        it('has status 500 and MIDDLEWARE_ERROR code', () =>
        {
            const err = new MiddlewareError();
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('MIDDLEWARE_ERROR');
            expect(err.message).toBe('Middleware Error');
            expect(err).toBeInstanceOf(HttpError);
        });

        it('stores middleware name', () =>
        {
            const err = new MiddlewareError('Compression failed', { middleware: 'compress' });
            expect(err.middleware).toBe('compress');
        });
    });

    describe('RoutingError', () =>
    {
        it('has status 500 and ROUTING_ERROR code', () =>
        {
            const err = new RoutingError();
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('ROUTING_ERROR');
            expect(err.message).toBe('Routing Error');
            expect(err).toBeInstanceOf(HttpError);
        });

        it('stores path and method', () =>
        {
            const err = new RoutingError('Duplicate route', { path: '/users', method: 'GET' });
            expect(err.path).toBe('/users');
            expect(err.method).toBe('GET');
        });
    });

    describe('TimeoutError', () =>
    {
        it('has status 408 and TIMEOUT code', () =>
        {
            const err = new TimeoutError();
            expect(err.statusCode).toBe(408);
            expect(err.code).toBe('TIMEOUT');
            expect(err.message).toBe('Request Timeout');
            expect(err).toBeInstanceOf(HttpError);
        });

        it('stores timeout value', () =>
        {
            const err = new TimeoutError('Operation timed out', { timeout: 5000 });
            expect(err.timeout).toBe(5000);
        });
    });

    describe('Framework errors work with createError and isHttpError', () =>
    {
        it('createError(408) returns TimeoutError', () =>
        {
            const err = createError(408, 'Timed out');
            expect(err).toBeInstanceOf(TimeoutError);
            expect(err.statusCode).toBe(408);
        });

        it('isHttpError recognizes framework error classes', () =>
        {
            expect(isHttpError(new DatabaseError())).toBe(true);
            expect(isHttpError(new ConfigurationError())).toBe(true);
            expect(isHttpError(new MiddlewareError())).toBe(true);
            expect(isHttpError(new RoutingError())).toBe(true);
            expect(isHttpError(new TimeoutError())).toBe(true);
        });
    });
});

// --- Error Handler Middleware ------------------------------------

describe('ErrorHandler Middleware', () =>
{
    const errorHandler = require('../../lib/middleware/errorHandler');
    const { HttpError, NotFoundError, ValidationError, createError } = require('../../lib/errors');

    function mockReqRes()
    {
        const req = { method: 'GET', url: '/test', originalUrl: '/test' };
        const sentData = {};
        const res = {
            headersSent: false,
            raw: { headersSent: false },
            _statusCode: null,
            _body: null,
            status(code) { this._statusCode = code; return this; },
            json(body) { this._body = body; },
        };
        return { req, res };
    }

    it('sends HttpError as structured JSON', () =>
    {
        const handler = errorHandler({ log: false });
        const { req, res } = mockReqRes();
        const err = new NotFoundError('User not found');
        handler(err, req, res, () => {});

        expect(res._statusCode).toBe(404);
        expect(res._body.error).toBe('User not found');
        expect(res._body.code).toBe('NOT_FOUND');
        expect(res._body.statusCode).toBe(404);
    });

    it('includes stack in dev mode', () =>
    {
        const handler = errorHandler({ log: false, stack: true });
        const { req, res } = mockReqRes();
        handler(new NotFoundError('nope'), req, res, () => {});

        expect(res._body.stack).toBeDefined();
        expect(Array.isArray(res._body.stack)).toBe(true);
    });

    it('hides stack in production mode', () =>
    {
        const handler = errorHandler({ log: false, stack: false });
        const { req, res } = mockReqRes();
        handler(new NotFoundError('nope'), req, res, () => {});

        expect(res._body.stack).toBeUndefined();
    });

    it('hides 5xx details in production mode', () =>
    {
        const handler = errorHandler({ log: false, stack: false });
        const { req, res } = mockReqRes();
        handler(new Error('database crash'), req, res, () => {});

        expect(res._statusCode).toBe(500);
        expect(res._body.error).toBe('Internal Server Error');  // Sanitized
    });

    it('shows 5xx details in dev mode', () =>
    {
        const handler = errorHandler({ log: false, stack: true });
        const { req, res } = mockReqRes();
        handler(new Error('database crash'), req, res, () => {});

        expect(res._body.error).toBe('database crash');
    });

    it('handles ValidationError with field errors', () =>
    {
        const handler = errorHandler({ log: false });
        const { req, res } = mockReqRes();
        const err = new ValidationError('Bad input', { email: 'required' });
        handler(err, req, res, () => {});

        expect(res._statusCode).toBe(422);
        expect(res._body.details).toEqual({ email: 'required' });
    });

    it('uses custom formatter', () =>
    {
        const handler = errorHandler({
            log: false,
            formatter: (err) => ({ custom: true, msg: err.message }),
        });
        const { req, res } = mockReqRes();
        handler(new NotFoundError('x'), req, res, () => {});

        expect(res._body).toEqual({ custom: true, msg: 'x' });
    });

    it('calls onError callback', () =>
    {
        let captured = null;
        const handler = errorHandler({
            log: false,
            onError: (err) => { captured = err; },
        });
        const { req, res } = mockReqRes();
        const err = new Error('boom');
        handler(err, req, res, () => {});

        expect(captured).toBe(err);
    });

    it('logs 5xx errors with stack traces', () =>
    {
        const logs = [];
        const handler = errorHandler({ logger: (...args) => logs.push(args.join(' ')) });
        const { req, res } = mockReqRes();
        handler(new Error('db down'), req, res, () => {});

        expect(logs.length).toBeGreaterThanOrEqual(2);
        expect(logs[0]).toContain('500');
        expect(logs[1]).toContain('db down');
    });

    it('logs 4xx errors without stack', () =>
    {
        const logs = [];
        const handler = errorHandler({ logger: (...args) => logs.push(args.join(' ')) });
        const { req, res } = mockReqRes();
        handler(new NotFoundError('nope'), req, res, () => {});

        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('404');
    });

    it('skips response when headers already sent', () =>
    {
        const handler = errorHandler({ log: false });
        const { req, res } = mockReqRes();
        res.headersSent = true;
        handler(new Error('late'), req, res, () => {});

        expect(res._statusCode).toBeNull();
        expect(res._body).toBeNull();
    });

    it('handles non-standard status codes gracefully', () =>
    {
        const handler = errorHandler({ log: false });
        const { req, res } = mockReqRes();
        const err = new Error('weird');
        err.statusCode = 'not-a-number';
        handler(err, req, res, () => {});

        expect(res._statusCode).toBe(500);
    });

    it('handles errors with .status property (Express compat)', () =>
    {
        const handler = errorHandler({ log: false });
        const { req, res } = mockReqRes();
        const err = new Error('forbidden');
        err.status = 403;
        handler(err, req, res, () => {});

        expect(res._statusCode).toBe(403);
    });

    it('preserves error.code on generic errors', () =>
    {
        const handler = errorHandler({ log: false, stack: true });
        const { req, res } = mockReqRes();
        const err = new Error('timeout');
        err.code = 'ECONNRESET';
        err.statusCode = 502;
        handler(err, req, res, () => {});

        expect(res._body.code).toBe('ECONNRESET');
    });
});

// --- Debug Logger ------------------------------------------------

describe('Debug Logger', () =>
{
    const debug = require('../../lib/debug');

    let output;
    beforeEach(() =>
    {
        output = [];
        debug.reset();
        debug.output({ write: (s) => output.push(s) });
        debug.colors(false);
        debug.timestamps(false);
        // Enable all namespaces
        delete process.env.DEBUG;
        debug.enable('*');
    });

    afterEach(() =>
    {
        debug.reset();
        delete process.env.DEBUG;
        delete process.env.DEBUG_LEVEL;
    });

    it('creates a logger with namespace', () =>
    {
        const log = debug('test:basic');
        expect(log.namespace).toBe('test:basic');
        expect(typeof log).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
    });

    it('default call logs at debug level', () =>
    {
        debug.level('debug');
        const log = debug('app');
        log('hello %s', 'world');
        expect(output.length).toBe(1);
        expect(output[0]).toContain('DEBUG');
        expect(output[0]).toContain('app');
        expect(output[0]).toContain('hello world');
    });

    it('log.info logs at info level', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.info('server started on port %d', 3000);
        expect(output[0]).toContain('INFO');
        expect(output[0]).toContain('server started on port 3000');
    });

    it('log.warn logs at warn level', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.warn('deprecation notice');
        expect(output[0]).toContain('WARN');
    });

    it('log.error logs at error level', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.error('something broke');
        expect(output[0]).toContain('ERROR');
    });

    it('log.fatal logs at fatal level', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.fatal('unrecoverable');
        expect(output[0]).toContain('FATAL');
    });

    it('log.trace logs at trace level', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.trace('entering function');
        expect(output[0]).toContain('TRACE');
    });

    it('respects minimum level — filters lower levels', () =>
    {
        debug.level('warn');
        const log = debug('app');
        log('debug message');
        log.info('info message');
        log.warn('warn message');
        expect(output.length).toBe(1);
        expect(output[0]).toContain('WARN');
    });

    it('debug.level("silent") suppresses all output', () =>
    {
        debug.level('silent');
        const log = debug('app');
        log('nope');
        log.info('nope');
        log.warn('nope');
        log.error('nope');
        log.fatal('nope');
        expect(output.length).toBe(0);
    });

    it('enables namespaces via patterns', () =>
    {
        debug.enable('app:*');
        const appLog = debug('app:routes');
        const dbLog = debug('db:queries');

        appLog.info('hit /users');
        dbLog.info('SELECT * FROM users');

        expect(output.length).toBe(1);
        expect(output[0]).toContain('app:routes');
    });

    it('supports negative patterns', () =>
    {
        debug.enable('*,-db:*');
        const appLog = debug('app');
        const dbLog = debug('db:queries');

        appLog.info('ok');
        dbLog.info('this should not appear');

        expect(output.length).toBe(1);
        expect(output[0]).toContain('app');
    });

    it('debug.disable() suppresses all namespaces', () =>
    {
        debug.disable();
        const log = debug('app');
        log.info('nope');
        expect(output.length).toBe(0);
    });

    it('.enabled reflects namespace activation', () =>
    {
        debug.enable('app:*');
        const active = debug('app:routes');
        const inactive = debug('db:queries');
        expect(active.enabled).toBe(true);
        expect(inactive.enabled).toBe(false);
    });

    it('formats Error objects with stack', () =>
    {
        debug.level('trace');
        const log = debug('app');
        const err = new Error('test error');
        log.error(err);
        expect(output[0]).toContain('test error');
        expect(output[0]).toContain('Error');
    });

    it('formats objects as JSON', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.info('data: %j', { key: 'value' });
        expect(output[0]).toContain('{"key":"value"}');
    });

    it('JSON mode outputs structured JSON', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log = debug('app');
        log.info('structured message');

        const parsed = JSON.parse(output[0]);
        expect(parsed.level).toBe('INFO');
        expect(parsed.namespace).toBe('app');
        expect(parsed.message).toBe('structured message');
        expect(parsed.timestamp).toBeDefined();
    });

    it('JSON mode includes error details', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log = debug('app');
        const err = new Error('crash');
        err.code = 'ENOENT';
        log.error('file not found', err);

        const parsed = JSON.parse(output[0]);
        expect(parsed.error.message).toBe('crash');
        expect(parsed.error.code).toBe('ENOENT');
        expect(parsed.error.stack).toBeDefined();
    });

    it('timestamps can be toggled', () =>
    {
        debug.timestamps(true);
        debug.level('trace');
        const log = debug('app');
        log.info('with ts');

        // Should contain time pattern HH:MM:SS.mmm
        expect(output[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    it('handles multiple arguments', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.info('a', 'b', 'c');
        expect(output[0]).toContain('a b c');
    });

    it('handles %s, %d, %j format specifiers', () =>
    {
        debug.level('trace');
        const log = debug('app');
        log.info('name=%s age=%d data=%j', 'Alice', 30, { x: 1 });
        expect(output[0]).toContain('name=Alice age=30 data={"x":1}');
    });

    it('level constants are exposed', () =>
    {
        expect(debug.LEVELS.trace).toBe(0);
        expect(debug.LEVELS.debug).toBe(1);
        expect(debug.LEVELS.info).toBe(2);
        expect(debug.LEVELS.warn).toBe(3);
        expect(debug.LEVELS.error).toBe(4);
        expect(debug.LEVELS.fatal).toBe(5);
        expect(debug.LEVELS.silent).toBe(6);
    });
});

// --- Router Error Protection -------------------------------------

describe('Router Error Protection', () =>
{
    const { createApp, HttpError, NotFoundError, ValidationError, createError, errorHandler } = require('../../');

    function startApp(app)
    {
        return new Promise((resolve) =>
        {
            const server = app.listen(0, () =>
            {
                const port = server.address().port;
                resolve({ server, port, base: `http://127.0.0.1:${port}` });
            });
        });
    }

    async function doFetch(url, opts = {})
    {
        const res = await fetch(url, opts);
        let data;
        try { data = await res.json(); } catch { data = null; }
        return { status: res.status, data, headers: res.headers };
    }

    it('catches sync throws in route handlers', async () =>
    {
        const app = createApp();
        app.get('/boom', () => { throw new Error('sync boom'); });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/boom`);
            expect(status).toBe(500);
            expect(data.error).toContain('sync boom');
        }
        finally { server.close(); }
    });

    it('catches async rejections in route handlers', async () =>
    {
        const app = createApp();
        app.get('/async-boom', async () => { throw new Error('async boom'); });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/async-boom`);
            expect(status).toBe(500);
            expect(data.error).toContain('async boom');
        }
        finally { server.close(); }
    });

    it('routes HttpError status codes correctly', async () =>
    {
        const app = createApp();
        app.get('/not-found', () => { throw new NotFoundError('User 42'); });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/not-found`);
            expect(status).toBe(404);
            expect(data.error).toBe('User 42');
            expect(data.code).toBe('NOT_FOUND');
        }
        finally { server.close(); }
    });

    it('routes ValidationError with details', async () =>
    {
        const app = createApp();
        app.post('/validate', () =>
        {
            throw new ValidationError('Bad input', { email: 'required', age: 'min 18' });
        });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/validate`, { method: 'POST' });
            expect(status).toBe(422);
            expect(data.details).toEqual({ email: 'required', age: 'min 18' });
        }
        finally { server.close(); }
    });

    it('routes createError() thrown errors', async () =>
    {
        const app = createApp();
        app.get('/factory', () =>
        {
            throw createError(409, 'Duplicate entry', { details: { id: 42 } });
        });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/factory`);
            expect(status).toBe(409);
            expect(data.error).toBe('Duplicate entry');
            expect(data.code).toBe('CONFLICT');
        }
        finally { server.close(); }
    });

    it('delegates to app.onError() when set', async () =>
    {
        const app = createApp();
        let captured = null;
        app.onError((err, req, res) =>
        {
            captured = err;
            res.status(err.statusCode || 500).json({ custom: true, msg: err.message });
        });
        app.get('/on-error', () => { throw new NotFoundError('custom handler'); });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/on-error`);
            expect(status).toBe(404);
            expect(data.custom).toBe(true);
            expect(data.msg).toBe('custom handler');
            expect(captured).toBeInstanceOf(NotFoundError);
        }
        finally { server.close(); }
    });

    it('works with errorHandler middleware as onError', async () =>
    {
        const app = createApp();
        app.onError(errorHandler({ log: false, stack: false }));
        app.get('/handled', () => { throw new NotFoundError('handled error'); });
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/handled`);
            expect(status).toBe(404);
            expect(data.error).toBe('handled error');
            expect(data.code).toBe('NOT_FOUND');
            expect(data.stack).toBeUndefined();
        }
        finally { server.close(); }
    });

    it('handles errors in chained handlers', async () =>
    {
        const app = createApp();
        app.get('/chain',
            (req, res, next) => { req.locals.step1 = true; next(); },
            () => { throw new Error('chain error'); }
        );
        const { server, base } = await startApp(app);

        try
        {
            const { status, data } = await doFetch(`${base}/chain`);
            expect(status).toBe(500);
            expect(data.error).toContain('chain error');
        }
        finally { server.close(); }
    });
});

// --- Exports Verification -----------------------------------------

describe('Error Exports', () =>
{
    const z = require('../../');

    it('exports all error classes', () =>
    {
        expect(z.HttpError).toBeDefined();
        expect(z.BadRequestError).toBeDefined();
        expect(z.UnauthorizedError).toBeDefined();
        expect(z.ForbiddenError).toBeDefined();
        expect(z.NotFoundError).toBeDefined();
        expect(z.MethodNotAllowedError).toBeDefined();
        expect(z.ConflictError).toBeDefined();
        expect(z.GoneError).toBeDefined();
        expect(z.PayloadTooLargeError).toBeDefined();
        expect(z.UnprocessableEntityError).toBeDefined();
        expect(z.ValidationError).toBeDefined();
        expect(z.TooManyRequestsError).toBeDefined();
        expect(z.InternalError).toBeDefined();
        expect(z.NotImplementedError).toBeDefined();
        expect(z.BadGatewayError).toBeDefined();
        expect(z.ServiceUnavailableError).toBeDefined();
    });

    it('exports framework-specific error classes', () =>
    {
        expect(z.DatabaseError).toBeDefined();
        expect(z.ConfigurationError).toBeDefined();
        expect(z.MiddlewareError).toBeDefined();
        expect(z.RoutingError).toBeDefined();
        expect(z.TimeoutError).toBeDefined();
    });

    it('exports factory and utility functions', () =>
    {
        expect(typeof z.createError).toBe('function');
        expect(typeof z.isHttpError).toBe('function');
    });

    it('exports errorHandler middleware', () =>
    {
        expect(typeof z.errorHandler).toBe('function');
    });

    it('exports debug logger', () =>
    {
        expect(typeof z.debug).toBe('function');
        expect(typeof z.debug.level).toBe('function');
        expect(typeof z.debug.enable).toBe('function');
        expect(typeof z.debug.disable).toBe('function');
        expect(typeof z.debug.json).toBe('function');
        expect(z.debug.LEVELS).toBeDefined();
    });

    it('createError returns correct instances through public API', () =>
    {
        const err = z.createError(404, 'test');
        expect(err).toBeInstanceOf(z.NotFoundError);
        expect(err).toBeInstanceOf(z.HttpError);
    });
});
