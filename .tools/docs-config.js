/**
 * docs-config.js — Section layout for the docs build.
 *
 * Only defines WHICH source files go in which section and static content.
 * All API content (descriptions, params, options, returns, examples,
 * method groups, error classes) is auto-discovered from JSDoc at build time.
 */

module.exports = [
	/* ------------------------ Getting Started ------------------------ */
	{
		file: 'docs-getting-started.json',
		section: 'Getting Started',
		icon: 'rocket',
		items: [
			{
				name: 'Installation',
				static: true,
				description: 'Install the @zero-server/sdk meta-package from npm — it ships every module. Or install only the scoped packages you need (e.g. @zero-server/core, @zero-server/orm). No external dependencies are required — everything is built in.',
				example: 'npm install @zero-server/sdk',
				exampleLang: 'bash',
				tips: [
					'@zero-server/sdk has zero runtime dependencies — npm install is all you need.',
					'Requires Node.js 18+ (uses crypto.randomUUID, structuredClone, etc.).',
					'TypeScript definitions are included in the package under types/.',
				],
			},
			{
				name: 'Quickstart',
				static: true,
				description: 'Create a minimal server with JSON parsing and static file serving in under 10 lines.',
				example: [
					"const { createApp, json, static: serveStatic } = require('@zero-server/sdk')",
					"const path = require('path')",
					'const app = createApp()',
					'',
					"app.use(json({ limit: '10kb' }))",
					"app.use(serveStatic(path.join(__dirname, 'public'), { index: 'index.html' }))",
					'',
					"app.get('/ping', (req, res) => res.json({ pong: true }))",
					'',
					'app.listen(3000, () => {',
					"\tconsole.log('Server listening on http://localhost:3000')",
					'})',
				].join('\n'),
				tips: [
					'Middleware runs in registration order — add parsers before route handlers.',
					'All route methods (get, post, put, etc.) return the app, so you can chain them.',
					'Use app.onError() to register a global error handler for uncaught errors.',
				],
			},
		],
	},

	/* ------------------------ Scoped Packages ------------------------ */
	{
		file: 'docs-scoped-packages.json',
		section: 'Scoped Packages',
		icon: 'box',
		items: [
			{
				name: 'Overview',
				static: true,
				description: 'The full SDK ships as `@zero-server/sdk` — install that and you have everything. Each section of the framework is also published as a narrow standalone scoped package with its own runtime bundle. Mix and match freely.',
				example: [
					'# Everything (one install)',
					'npm install @zero-server/sdk',
					'',
					'# Or only what you need',
					'npm install @zero-server/core @zero-server/body @zero-server/middleware',
					'npm install @zero-server/orm @zero-server/auth @zero-server/observe',
				].join('\n'),
				exampleLang: 'bash',
				tips: [
					'Scoped packages are standalone at runtime and can be installed independently.',
					'Each scoped package keeps an optional `@zero-server/sdk` peer for TypeScript users who want central type resolution.',
				],
			},
			{
				name: 'Package Map',
				static: true,
				description: 'Every published `@zero-server/*` package and the surface it narrows to. The full list of exports per package is generated from `.tools/scope-manifest.js` and published to `docs/scopes/<name>.md`.',
				options: [
					{ option: '@zero-server/sdk',        type: 'meta',       default: 'all',    notes: 'Single full-SDK install with the complete public surface.' },
					{ option: '@zero-server/core',       type: 'core',       default: '—',     notes: 'createApp, Router, Request, Response.' },
					{ option: '@zero-server/body',       type: 'parsers',    default: '—',     notes: 'json, urlencoded, text, raw, multipart.' },
					{ option: '@zero-server/middleware', type: 'middleware', default: '—',     notes: 'cors, helmet, compress, rateLimit, logger, timeout, requestId, cookieParser, csrf, validate, errorHandler, static.' },
					{ option: '@zero-server/auth',       type: 'auth',       default: '—',     notes: 'jwt, session, oauth, authorize, twoFactor, webauthn, trustedDevice, enrollment.' },
					{ option: '@zero-server/orm',       type: 'orm',         default: '—',    notes: 'Database, Model, Query, TYPES, Migrator, Seeder, replicas, search, geo, tenancy, audit, plugins.' },
					{ option: '@zero-server/realtime',   type: 'realtime',   default: '—',     notes: 'WebSocketConnection, WebSocketPool, SSEStream.' },
					{ option: '@zero-server/grpc',       type: 'grpc',       default: '—',     notes: 'GrpcServiceRegistry, GrpcClient, codec, status, metadata, framing, health, reflection, balancer, credentials.' },
					{ option: '@zero-server/observe',    type: 'observability', default: '—',  notes: 'MetricsRegistry, Tracer, structured Logger, healthCheck.' },
					{ option: '@zero-server/lifecycle',  type: 'lifecycle',  default: '—',     notes: 'LifecycleManager, ClusterManager, clusterize.' },
					{ option: '@zero-server/env',        type: 'env',        default: '—',     notes: 'Typed `.env` loader and accessor.' },
					{ option: '@zero-server/fetch',      type: 'http-client', default: '—',    notes: 'Server-side fetch with mTLS, timeouts, AbortSignal.' },
					{ option: '@zero-server/errors',     type: 'errors',     default: '—',     notes: 'HttpError plus 25+ typed framework / ORM error classes, createError, isHttpError.' },
				],
				example: [
					"// Identical at runtime — pick whichever import surface you prefer",
					"const fromSdk  = require('@zero-server/sdk').createApp;",
					"const fromCore = require('@zero-server/core').createApp;",
				].join('\n'),
				tips: [
					'Use the meta-package in apps that touch most of the surface; use scoped packages in libraries or microservices that only need a slice.',
					'Per-package READMEs and full export tables live under `docs/scopes/` in the repo and are linked from each npm page.',
				],
			},
		],
	},

	/* ------------------------ Core ------------------------ */
	{
		file: 'docs-core.json',
		section: 'Core',
		icon: 'box',
		items: [
			{ name: 'createApp', source: 'lib/app.js' },
			{ name: 'Router',    source: 'lib/router/index.js' },
			{ name: 'Request',   source: 'lib/http/request.js' },
			{ name: 'Response',  source: 'lib/http/response.js' },
		],
	},

	/* ------------------------ Body Parsers ------------------------ */
	{
		file: 'docs-body-parsers.json',
		section: 'Body Parsers',
		icon: 'parse',
		items: [
			{ name: 'json',       source: 'lib/body/json.js' },
			{ name: 'urlencoded', source: 'lib/body/urlencoded.js' },
			{ name: 'text',       source: 'lib/body/text.js' },
			{ name: 'raw',        source: 'lib/body/raw.js' },
			{ name: 'multipart',  source: 'lib/body/multipart.js' },
		],
	},

	/* ------------------------ Middleware ------------------------ */
	{
		file: 'docs-middleware.json',
		section: 'Middleware',
		icon: 'layers',
		items: [
			{ name: 'cors',         source: 'lib/middleware/cors.js' },
			{ name: 'compress',     source: 'lib/middleware/compress.js' },
			{ name: 'helmet',       source: 'lib/middleware/helmet.js' },
			{ name: 'static',       source: 'lib/middleware/static.js' },
			{ name: 'rateLimit',    source: 'lib/middleware/rateLimit.js' },
			{ name: 'timeout',      source: 'lib/middleware/timeout.js' },
			{ name: 'requestId',    source: 'lib/middleware/requestId.js' },
			{ name: 'logger',       source: 'lib/middleware/logger.js' },
			{ name: 'errorHandler', source: 'lib/middleware/errorHandler.js' },
		],
	},

	/* ------------------------ Cookies & Security ------------------------ */
	{
		file: 'docs-cookies-security.json',
		section: 'Cookies & Security',
		icon: 'shield',
		items: [
			{ name: 'cookieParser', source: 'lib/middleware/cookieParser.js' },
			{ name: 'csrf',         source: 'lib/middleware/csrf.js' },
			{ name: 'validate',     source: 'lib/middleware/validator.js' },
		],
	},

	/* -------------------- Authentication -------------------- */
	{
		file: 'docs-auth.json',
		section: 'Authentication',
		icon: 'lock',
		items: [
			{ name: 'jwt',     source: 'lib/auth/jwt.js' },
			{ name: 'session', source: 'lib/auth/session.js' },
			{ name: 'oauth',   source: 'lib/auth/oauth.js' },
		],
	},

	/* -------------------- Authorization -------------------- */
	{
		file: 'docs-authorization.json',
		section: 'Authorization',
		icon: 'user-check',
		items: [
			{ name: 'authorize', source: 'lib/auth/authorize.js' },
		],
	},

	/* -------------------- Multi-Factor Auth -------------------- */
	{
		file: 'docs-mfa.json',
		section: 'Multi-Factor Auth',
		icon: 'key',
		items: [
			{ name: 'twoFactor',     source: 'lib/auth/twoFactor.js' },
			{ name: 'webauthn',      source: 'lib/auth/webauthn.js' },
			{ name: 'trustedDevice', source: 'lib/auth/trustedDevice.js' },
			{ name: 'enrollment',    source: 'lib/auth/enrollment.js' },
		],
	},

	/* ------------------------ Environment ------------------------ */
	{
		file: 'docs-environment.json',
		section: 'Environment',
		icon: 'settings',
		items: [
			{ name: 'env', source: 'lib/env/index.js' },
			{
				name: '.env File Format',
				static: true,
				exampleLang: 'env',
				description: 'The .env file format supports comments, quoted values (single, double, backtick), multiline strings, variable interpolation, and export prefix.',
				example: [
					'# Database',
					'DATABASE_URL=postgres://localhost/mydb',
					'',
					'# Quoted values',
					'APP_NAME="My App"',
					"SECRET_KEY='s3cr3t'",
					'',
					'# Multiline (backtick)',
					'RSA_KEY=`-----BEGIN RSA KEY-----',
					'MIIBog...',
					'-----END RSA KEY-----`',
					'',
					'# Interpolation',
					'BASE_URL=https://example.com',
					'API_URL=${BASE_URL}/api/v1',
					'',
					'# Export prefix (optional, ignored)',
					'export NODE_ENV=production',
				].join('\n'),
				tips: [
					'Lines starting with # are comments.',
					'Variable interpolation uses ${VAR} syntax and resolves from already-parsed values or process.env.',
					'Files load in order: .env → .env.local → .env.{NODE_ENV} → .env.{NODE_ENV}.local (later files override earlier).',
				],
			},
			{
				name: 'Schema Types',
				static: true,
				description: 'Supported schema types for env.load() validation. Each type automatically coerces and validates the raw string from the environment.',
				options: [
					{ option: 'string',  type: 'string',  default: '—', notes: 'Pass-through. Supports min/max length and match regex constraints.' },
					{ option: 'number',  type: 'number',  default: '—', notes: 'Parsed via Number(). Supports min/max range.' },
					{ option: 'integer', type: 'integer', default: '—', notes: 'Parsed via parseInt(). Supports min/max range.' },
					{ option: 'port',    type: 'port',    default: '—', notes: 'Integer 0–65535. Rejects out-of-range values.' },
					{ option: 'boolean', type: 'boolean', default: '—', notes: "Truthy: 'true', '1', 'yes', 'on'. Falsy: 'false', '0', 'no', 'off'." },
					{ option: 'array',   type: 'array',   default: '—', notes: "Split by separator (default ',')." },
					{ option: 'json',    type: 'json',    default: '—', notes: 'Parsed via JSON.parse().' },
					{ option: 'url',     type: 'url',     default: '—', notes: 'Validated via new URL().' },
					{ option: 'enum',    type: 'enum',    default: '—', notes: "Must be one of the 'values' array." },
				],
				example: [
					"env.load({",
					"\tPORT:       { type: 'port',    default: 3000 },",
					"\tDB_URL:     { type: 'string',  required: true },",
					"\tDEBUG:      { type: 'boolean', default: false },",
					"\tORIGINS:    { type: 'array',   separator: ',' },",
					"\tLOG_LEVEL:  { type: 'enum',    values: ['debug','info','warn','error'], default: 'info' },",
					'})',
				].join('\n'),
			},
		],
	},

	/* ------------------------ Real-Time ------------------------ */
	{
		file: 'docs-real-time.json',
		section: 'Real-Time',
		icon: 'zap',
		items: [
			{ name: 'WebSocket',               source: 'lib/ws/connection.js' },
			{ name: 'WebSocketPool',            source: 'lib/ws/room.js' },
			{ name: 'SSE (Server-Sent Events)', source: 'lib/sse/stream.js' },
		],
	},

	/* ------------------------ gRPC ------------------------ */
	{
		file: 'docs-grpc.json',
		section: 'gRPC',
		icon: 'radio',
		items: [
			{ name: 'Server',        source: 'lib/grpc/server.js' },
			{ name: 'Client',        source: 'lib/grpc/client.js' },
			{ name: 'Call Objects',   source: 'lib/grpc/call.js' },
			{ name: 'Proto3 Parser',  source: 'lib/grpc/proto.js' },
			{ name: 'Protobuf Codec', source: 'lib/grpc/codec.js' },
			{ name: 'Status Codes',   source: 'lib/grpc/status.js' },
			{ name: 'Metadata',       source: 'lib/grpc/metadata.js' },
			{ name: 'Framing',        source: 'lib/grpc/frame.js' },
			{ name: 'Health Service',  source: 'lib/grpc/health.js' },
			{ name: 'Reflection',      source: 'lib/grpc/reflection.js' },
			{ name: 'Load Balancing',  source: 'lib/grpc/balancer.js' },
			{ name: 'Credentials',     source: 'lib/grpc/credentials.js' },
			{ name: 'Proto Watcher',   source: 'lib/grpc/watch.js' },
		],
	},

	/* ------------------------ Networking ------------------------ */
	{
		file: 'docs-networking.json',
		section: 'Networking',
		icon: 'globe',
		items: [
			{ name: 'fetch', source: 'lib/fetch/index.js' },
		],
	},

	/* ------------------------ ORM ------------------------ */
	{
		file: 'docs-orm.json',
		section: 'ORM',
		icon: 'database',
		items: [
			{ name: 'Database',           source: 'lib/orm/index.js' },
			{ name: 'Model',              source: 'lib/orm/model.js' },
			{ name: 'Schema DDL',         source: 'lib/orm/schema.js' },
			{ name: 'TYPES',              source: 'lib/orm/schema.js', symbol: 'TYPES' },
			{ name: 'Query',              source: 'lib/orm/query.js' },
			{ name: 'SQLite Adapter',     source: 'lib/orm/adapters/sqlite.js' },
			{ name: 'MySQL Adapter',      source: 'lib/orm/adapters/mysql.js' },
			{ name: 'PostgreSQL Adapter', source: 'lib/orm/adapters/postgres.js' },
			{ name: 'MongoDB Adapter',    source: 'lib/orm/adapters/mongo.js' },
			{ name: 'Redis Adapter',      source: 'lib/orm/adapters/redis.js' },
			{ name: 'Memory Adapter',     source: 'lib/orm/adapters/memory.js' },
			{ name: 'JSON Adapter',       source: 'lib/orm/adapters/json.js' },
			{ name: 'Migrator',           source: 'lib/orm/migrate.js' },
			{ name: 'QueryCache',         source: 'lib/orm/cache.js' },
			{ name: 'Seeder & Factory',   source: 'lib/orm/seed/seeder.js', extras: ['lib/orm/seed/factory.js', 'lib/orm/seed/fake.js'] },
			{ name: 'QueryProfiler',      source: 'lib/orm/profiler.js' },
			{ name: 'ReplicaManager',     source: 'lib/orm/replicas.js' },
			{ name: 'DatabaseView',       source: 'lib/orm/views.js' },
			{ name: 'FullTextSearch',     source: 'lib/orm/search.js' },
			{ name: 'GeoQuery',           source: 'lib/orm/geo.js' },
			{ name: 'TenantManager',      source: 'lib/orm/tenancy.js' },
			{ name: 'AuditLog',           source: 'lib/orm/audit.js' },
			{ name: 'PluginManager',      source: 'lib/orm/plugin.js' },
			{ name: 'StoredProcedure',    source: 'lib/orm/procedures.js' },
			{ name: 'CLI',                source: 'lib/cli.js', cliTool: true },
		],
	},

	/* ---------------------- Observability ---------------------- */
	{
		file: 'docs-observability.json',
		section: 'Observability',
		icon: 'activity',
		items: [
			{ name: 'structuredLogger', source: 'lib/observe/logger.js' },
			{ name: 'MetricsRegistry',  source: 'lib/observe/metrics.js' },
			{ name: 'Tracer',           source: 'lib/observe/tracing.js' },
			{ name: 'healthCheck',      source: 'lib/observe/health.js' },
		],
	},

	/* ------------------- Lifecycle & Clustering ------------------- */
	{
		file: 'docs-lifecycle.json',
		section: 'Lifecycle & Clustering',
		icon: 'refresh-cw',
		items: [
			{ name: 'LifecycleManager', source: 'lib/lifecycle.js' },
			{ name: 'ClusterManager',   source: 'lib/cluster.js' },
		],
	},

	/* ------------------------ Error Handling ------------------------ */
	{
		file: 'docs-error-handling.json',
		section: 'Error Handling',
		icon: 'alert-triangle',
		items: [
			{ name: 'Error Classes',    source: 'lib/errors.js' },
			{ name: 'Framework Errors', source: 'lib/errors.js', groups: ['Framework Error Classes', 'ORM-Specific Error Classes'] },
			{ name: 'errorHandler',     source: 'lib/middleware/errorHandler.js' },
			{ name: 'debug',            source: 'lib/debug.js' },
		],
	},
];
