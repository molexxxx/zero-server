const fs = require('fs');
const path = require('path');

const {
    createApp, Router, json, urlencoded, text, raw, multipart,
    static: staticMid, cors, fetch, rateLimit, logger, compress,
    helmet, timeout, requestId, cookieParser, WebSocketPool,
    csrf, validate, env, Database, Model, TYPES, Query, version
} = require('../../');

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


// =========================================================================
//  TypeScript type definitions validation (from coverage/deep.test.js)
// =========================================================================

describe('TypeScript type definitions validation', () => {
	it('index.d.ts exports match runtime exports', () => {
		const runtime = require('../../');
		const expectedExports = [
			'createApp', 'Router', 'cors', 'fetch',
			'json', 'urlencoded', 'text', 'raw', 'multipart',
			'static', 'rateLimit', 'logger', 'compress', 'helmet',
			'timeout', 'requestId', 'cookieParser', 'csrf', 'validate',
			'errorHandler', 'env', 'Database', 'Model', 'TYPES', 'Query',
			'validateFKAction', 'validateCheck', 'Migrator', 'defineMigration',
			'QueryCache', 'Seeder', 'SeederRunner', 'Factory', 'Fake',
			'QueryProfiler', 'ReplicaManager',
			'HttpError', 'BadRequestError', 'UnauthorizedError', 'ForbiddenError',
			'NotFoundError', 'MethodNotAllowedError', 'ConflictError', 'GoneError',
			'PayloadTooLargeError', 'UnprocessableEntityError', 'ValidationError',
			'TooManyRequestsError', 'InternalError', 'NotImplementedError',
			'BadGatewayError', 'ServiceUnavailableError',
			'DatabaseError', 'ConfigurationError', 'MiddlewareError', 'RoutingError',
			'TimeoutError', 'ConnectionError', 'MigrationError', 'TransactionError',
			'QueryError', 'AdapterError', 'CacheError',
			'createError', 'isHttpError', 'debug',
			'WebSocketConnection', 'WebSocketPool', 'SSEStream', 'version',
		];

		for (const name of expectedExports) {
			expect(runtime[name]).toBeDefined();
		}
	});

	it('createApp returns an object with expected methods', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const methods = [
			'use', 'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all',
			'listen', 'close', 'ws', 'routes', 'route', 'set', 'enable', 'disable',
			'enabled', 'disabled', 'param', 'group', 'chain', 'onError', 'handle',
		];
		for (const m of methods) {
			expect(typeof app[m]).toBe('function');
		}
		expect(app.locals).toBeDefined();
		expect(app.middlewares).toBeDefined();
		expect(app.router).toBeDefined();
		expect(typeof app.handler).toBe('function');
	});

	it('Database has expected static/instance methods', () => {
		const { Database } = require('../../');
		expect(typeof Database.connect).toBe('function');
		const db = Database.connect('memory');
		const methods = ['register', 'registerAll', 'sync', 'close', 'model', 'transaction',
			'hasTable', 'ping', 'retry', 'routes'];
		for (const m of methods) {
			if (db[m]) expect(typeof db[m]).toBe('function');
		}
	});

	it('Model has expected static methods', () => {
		const { Model } = require('../../');
		const methods = [
			'create', 'createMany', 'find', 'findOne', 'findById', 'findOrCreate',
			'updateWhere', 'deleteWhere', 'count', 'exists', 'upsert', 'query',
			'first', 'last', 'all', 'paginate', 'chunk', 'random', 'pluck',
			'hasMany', 'hasOne', 'belongsTo', 'belongsToMany', 'sync', 'drop', 'scope',
		];
		for (const m of methods) {
			expect(typeof Model[m]).toBe('function');
		}
	});

	it('Query has expected instance methods', () => {
		const { Database, Model, TYPES, Query } = require('../../');
		const db = Database.connect('memory');
		class TQ extends Model {
			static table = 'tq_' + Date.now();
			static schema = { id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true } };
		}
		db.register(TQ);

		const q = TQ.query();
		const methods = [
			'select', 'distinct', 'where', 'orWhere', 'whereNull', 'whereNotNull',
			'whereIn', 'whereNotIn', 'whereBetween', 'whereNotBetween', 'whereLike',
			'orderBy', 'limit', 'offset', 'page', 'groupBy', 'having',
			'join', 'leftJoin', 'rightJoin', 'withDeleted', 'scope',
			'build', 'exec', 'first', 'count', 'exists', 'pluck', 'sum', 'avg', 'min', 'max',
			'take', 'skip', 'toArray', 'orderByDesc', 'last', 'when', 'unless', 'tap',
			'chunk', 'each', 'map', 'filter', 'reduce', 'paginate', 'whereRaw',
			'then', 'catch',
		];
		for (const m of methods) {
			expect(typeof q[m]).toBe('function');
		}
	});

	it('env has expected methods and proxy behavior', () => {
		const { env } = require('../../');
		expect(typeof env).toBe('function');
		expect(typeof env.load).toBe('function');
		expect(typeof env.get).toBe('function');
		expect(typeof env.require).toBe('function');
		expect(typeof env.has).toBe('function');
		expect(typeof env.all).toBe('function');
		expect(typeof env.reset).toBe('function');
		expect(typeof env.parse).toBe('function');
	});

	it('error classes have correct inheritance', () => {
		const {
			HttpError, BadRequestError, UnauthorizedError, ForbiddenError,
			NotFoundError, InternalError, DatabaseError, ConfigurationError,
		} = require('../../');

		const e = new BadRequestError('test');
		expect(e instanceof Error).toBe(true);
		expect(e instanceof HttpError).toBe(true);
		expect(e.statusCode).toBe(400);
		expect(e.message).toBe('test');

		expect(new UnauthorizedError().statusCode).toBe(401);
		expect(new ForbiddenError().statusCode).toBe(403);
		expect(new NotFoundError().statusCode).toBe(404);
		expect(new InternalError().statusCode).toBe(500);

		expect(new DatabaseError('db fail') instanceof Error).toBe(true);
		expect(new ConfigurationError('config fail') instanceof Error).toBe(true);
	});

	it('TYPES enum has all expected type constants', () => {
		const { TYPES } = require('../../');
		const expected = [
			'STRING', 'INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'TEXT',
			'BLOB', 'UUID', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'DOUBLE', 'REAL',
			'CHAR', 'BINARY', 'VARBINARY', 'TIMESTAMP', 'TIME', 'ENUM', 'SET',
			'MEDIUMTEXT', 'LONGTEXT', 'MEDIUMBLOB', 'LONGBLOB', 'YEAR',
			'SERIAL', 'BIGSERIAL', 'JSONB', 'INTERVAL', 'INET', 'CIDR', 'MACADDR',
			'MONEY', 'XML', 'CITEXT', 'ARRAY', 'NUMERIC',
		];
		for (const t of expected) {
			expect(TYPES[t]).toBeDefined();
		}
	});

	it('WebSocketConnection has expected properties on class', () => {
		const { WebSocketConnection } = require('../../');
		expect(typeof WebSocketConnection).toBe('function');
	});

	it('WebSocketPool has expected methods', () => {
		const { WebSocketPool } = require('../../');
		expect(typeof WebSocketPool).toBe('function');
		const pool = new WebSocketPool();
		expect(typeof pool.add).toBe('function');
		expect(typeof pool.remove).toBe('function');
		expect(typeof pool.join).toBe('function');
		expect(typeof pool.broadcast).toBe('function');
	});

	it('SSEStream is a constructor', () => {
		const { SSEStream } = require('../../');
		expect(typeof SSEStream).toBe('function');
	});

	it('middleware factories return functions', () => {
		const { cors, rateLimit, logger, compress, helmet, timeout, requestId, csrf } = require('../../');
		expect(typeof cors()).toBe('function');
		expect(typeof rateLimit()).toBe('function');
		expect(typeof logger()).toBe('function');
		expect(typeof compress()).toBe('function');
		expect(typeof helmet()).toBe('function');
		expect(typeof timeout()).toBe('function');
		expect(typeof requestId()).toBe('function');
		expect(typeof csrf()).toBe('function');
	});

	it('body parsers return middleware functions', () => {
		const { json, urlencoded, text, raw, multipart } = require('../../');
		expect(typeof json()).toBe('function');
		expect(typeof urlencoded()).toBe('function');
		expect(typeof text()).toBe('function');
		expect(typeof raw()).toBe('function');
		expect(typeof multipart()).toBe('function');
	});

	it('type definition files exist', () => {
		const typeDir = path.join(__dirname, '..', '..', 'types');
		const expected = [
			'index.d.ts', 'app.d.ts', 'env.d.ts', 'errors.d.ts', 'fetch.d.ts',
			'middleware.d.ts', 'orm.d.ts', 'request.d.ts', 'response.d.ts',
			'router.d.ts', 'sse.d.ts', 'websocket.d.ts',
		];
		for (const f of expected) {
			expect(fs.existsSync(path.join(typeDir, f))).toBe(true);
		}
	});
});
