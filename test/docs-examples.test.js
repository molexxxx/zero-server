const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zeroHttp = require('../');

const docsPath = path.join(__dirname, '..', 'documentation', 'public', 'data', 'docs.json');
const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8'));

/* ------------------------------------------------------------------ */
/*  Collect every item that has an example                             */
/* ------------------------------------------------------------------ */
const examples = [];
for (const section of docs) {
    for (const item of section.items) {
        if (item.example) {
            examples.push({
                section: section.section,
                name: item.name,
                example: item.example,
                lang: item.exampleLang || 'javascript',
            });
        }
    }
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract all destructured names from `require('zero-http')` statements.
 *   const { a, b: c, static: d } = require('zero-http')
 *   → ['a', 'b', 'static']       (the *source-side* binding names)
 */
function extractImports(code) {
    const imports = [];
    // Match:  { ... } = require('zero-http')  OR  require('zero-http')
    const re = /\{([^}]+)\}\s*=\s*require\(\s*['"]zero-http['"]\s*\)/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const inner = m[1];
        // Split on commas, then extract the source name from possible renames
        for (let part of inner.split(',')) {
            part = part.trim();
            if (!part) continue;
            // "static: serveStatic"  → source is "static"
            // "json"                 → source is "json"
            const colonIdx = part.indexOf(':');
            const source = colonIdx >= 0 ? part.slice(0, colonIdx).trim() : part.trim();
            imports.push(source);
        }
    }
    return imports;
}

/**
 * Try to parse the code as valid JavaScript.
 * Returns null on success, or the SyntaxError on failure.
 */
function checkSyntax(code) {
    try {
        let wrapped = code;
        // If the snippet contains class-body syntax (static keyword at top level)
        // but also top-level statements like require(), split them apart
        if (/^static\s+/m.test(code) && !/\bclass\b/.test(code)) {
            const lines = code.split('\n');
            const before = [];
            const classBody = [];
            let inStatic = false;
            for (const line of lines) {
                if (/^\s*static\s+/.test(line)) inStatic = true;
                if (inStatic) {
                    classBody.push(line);
                } else {
                    before.push(line);
                }
            }
            wrapped = before.join('\n') + '\nclass _DocExample {\n' + classBody.join('\n') + '\n}';
        }
        // Wrap in async IIFE so top-level `await` is legal
        new vm.Script(`(async () => {\n${wrapped}\n})();`, { filename: 'docs-example.js' });
        return null;
    } catch (err) {
        return err;
    }
}

/**
 * Extract method calls on a known object to check they exist.
 * e.g.  `app.get(...)`, `res.json(...)`, `env.load(...)`
 */
function extractMethodCalls(code, objName) {
    const methods = new Set();
    const re = new RegExp(`\\b${objName}\\.(\\w+)\\s*[\\(.]`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
        methods.add(m[1]);
    }
    return [...methods];
}

/* ------------------------------------------------------------------ */
/*  Known export names (from the actual module)                        */
/* ------------------------------------------------------------------ */
const moduleExports = Object.keys(zeroHttp);

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */
describe('Documentation Examples', () => {

    it('docs.json loads and has sections', () => {
        expect(Array.isArray(docs)).toBe(true);
        expect(docs.length).toBeGreaterThan(0);
    });

    it('every section has required fields', () => {
        for (const section of docs) {
            expect(section).toHaveProperty('section');
            expect(section).toHaveProperty('items');
            expect(Array.isArray(section.items)).toBe(true);
            for (const item of section.items) {
                expect(item).toHaveProperty('name');
                expect(item).toHaveProperty('description');
                expect(typeof item.name).toBe('string');
                expect(typeof item.description).toBe('string');
                expect(item.name.length).toBeGreaterThan(0);
                expect(item.description.length).toBeGreaterThan(0);
            }
        }
    });

    it('every item with an example has a non-empty example string', () => {
        for (const ex of examples) {
            expect(typeof ex.example).toBe('string');
            expect(ex.example.trim().length).toBeGreaterThan(0);
        }
    });

    /* --- Syntax checks ------------------------------------------- */
    describe('Syntax Validity', () => {
        for (const ex of examples) {
            if (ex.lang !== 'javascript') continue;

            it(`[${ex.section}] ${ex.name} — parses as valid JS`, () => {
                const err = checkSyntax(ex.example);
                if (err) {
                    // Include a snippet around the error to help debugging
                    const lines = ex.example.split('\n');
                    const lineNum = err.lineNumber ? err.lineNumber - 1 : 0; // offset for wrapper
                    const snippet = lines.slice(Math.max(0, lineNum - 3), lineNum + 3).join('\n');
                    throw new Error(
                        `Syntax error in "${ex.name}" (${ex.section}):\n` +
                        `  ${err.message}\n\n` +
                        `Near line ${lineNum}:\n${snippet}`
                    );
                }
            });
        }
    });

    /* --- Import checks -------------------------------------------- */
    describe('Imports from zero-http', () => {
        for (const ex of examples) {
            if (ex.lang !== 'javascript') continue;

            const imports = extractImports(ex.example);
            if (imports.length === 0) continue;

            it(`[${ex.section}] ${ex.name} — all imports exist`, () => {
                const missing = imports.filter(name => !moduleExports.includes(name));
                if (missing.length > 0) {
                    throw new Error(
                        `"${ex.name}" (${ex.section}) imports non-existent exports: ${missing.join(', ')}\n` +
                        `Available: ${moduleExports.join(', ')}`
                    );
                }
            });
        }
    });

    /* --- Documented methods vs actual API surface --------------- */
    describe('Documented methods exist on exports', () => {
        for (const section of docs) {
            for (const item of section.items) {
                if (!item.methods || !Array.isArray(item.methods)) continue;

                // Map doc items to actual module exports
                const mapping = {
                    'createApp': () => zeroHttp.createApp(),
                    'Router': () => zeroHttp.Router(),
                    'cookieParser': () => zeroHttp.cookieParser,
                    'validate': () => zeroHttp.validate,
                    'env': () => zeroHttp.env,
                    'WebSocketPool': () => new zeroHttp.WebSocketPool(),
                    // debug is tested in its own dedicated section
                };

                const getInstance = mapping[item.name];
                if (!getInstance) continue;

                it(`[${section.section}] ${item.name} — documented methods exist`, () => {
                    const instance = getInstance();
                    const missingMethods = [];

                    for (const methodDef of item.methods) {
                        let name = methodDef.method;
                        // Strip parentheses from descriptive names like "log()"
                        name = name.replace(/\(.*\)$/, '');
                        // Handle dotted names like "validate.field" → look for "field"
                        // or "debug.level" → look for "level"
                        if (name.includes('.')) {
                            const parts = name.split('.');
                            // Navigate to the sub-object
                            let target = instance;
                            const propName = parts[parts.length - 1];
                            for (let i = 0; i < parts.length - 1; i++) {
                                // For names like "log.trace", "log" is a created logger
                                // We can only check direct properties on the export
                                if (parts[i] === item.name.toLowerCase() || parts[i] === item.name) {
                                    continue; // skip the root object name
                                }
                                if (target[parts[i]] !== undefined) {
                                    target = target[parts[i]];
                                } else {
                                    target = null;
                                    break;
                                }
                            }
                            if (target === null) continue; // skip sub-object chains we can't resolve
                            const has = typeof target[propName] === 'function' ||
                                        target[propName] !== undefined;
                            if (!has) missingMethods.push(name);
                            continue;
                        }
                        // Check both instance and prototype
                        const hasMethod = typeof instance[name] === 'function' ||
                                          instance[name] !== undefined ||
                                          (instance.constructor && instance.constructor.prototype && name in instance.constructor.prototype);
                        if (!hasMethod) {
                            missingMethods.push(name);
                        }
                    }

                    if (missingMethods.length > 0) {
                        throw new Error(
                            `"${item.name}" is missing documented methods: ${missingMethods.join(', ')}`
                        );
                    }
                });
            }
        }
    });

    /* --- App method checks ---------------------------------------- */
    describe('App methods used in examples', () => {
        const app = zeroHttp.createApp();
        const appMethods = new Set([
            ...Object.keys(app),
            ...Object.getOwnPropertyNames(Object.getPrototypeOf(app)),
        ]);

        for (const ex of examples) {
            if (ex.lang !== 'javascript') continue;

            const calls = extractMethodCalls(ex.example, 'app');
            if (calls.length === 0) continue;

            it(`[${ex.section}] ${ex.name} — app methods exist`, () => {
                const missing = calls.filter(m => !appMethods.has(m));
                if (missing.length > 0) {
                    throw new Error(
                        `"${ex.name}" calls non-existent app methods: ${missing.join(', ')}\n` +
                        `Available: ${[...appMethods].sort().join(', ')}`
                    );
                }
            });
        }
    });

    /* --- Error class checks --------------------------------------- */
    describe('Error Classes', () => {
        const errorSection = docs.find(s => s.section === 'Error Handling');
        if (!errorSection) return;

        const errorClassItem = errorSection.items.find(i => i.name === 'Error Classes');
        if (!errorClassItem) return;

        it('all documented error classes are exported', () => {
            // Instance methods like toJSON are not top-level exports
            const instanceMethods = ['toJSON'];
            const missing = [];
            for (const methodDef of errorClassItem.methods) {
                const name = methodDef.method;
                if (instanceMethods.includes(name)) continue;
                if (!(name in zeroHttp)) {
                    missing.push(name);
                }
            }
            if (missing.length > 0) {
                throw new Error(
                    `Missing error exports: ${missing.join(', ')}\n` +
                    `Available: ${moduleExports.filter(e => /error|Error/.test(e) || e === 'createError' || e === 'isHttpError').join(', ')}`
                );
            }
        });

        it('error instances have toJSON method', () => {
            const err = new zeroHttp.HttpError(500, 'test');
            expect(typeof err.toJSON).toBe('function');
            const json = err.toJSON();
            expect(json).toHaveProperty('statusCode', 500);
        });

        it('error classes instantiate with correct status codes', () => {
            const statusMap = {
                BadRequestError: 400,
                UnauthorizedError: 401,
                ForbiddenError: 403,
                NotFoundError: 404,
                MethodNotAllowedError: 405,
                ConflictError: 409,
                GoneError: 410,
                PayloadTooLargeError: 413,
                UnprocessableEntityError: 422,
                TooManyRequestsError: 429,
                InternalError: 500,
                NotImplementedError: 501,
                BadGatewayError: 502,
                ServiceUnavailableError: 503,
            };

            for (const [name, expectedStatus] of Object.entries(statusMap)) {
                const ErrorClass = zeroHttp[name];
                if (!ErrorClass) continue;
                const err = new ErrorClass('test');
                expect(err.statusCode).toBe(expectedStatus);
                expect(err.message).toBe('test');
                expect(typeof err.toJSON).toBe('function');
                const json = err.toJSON();
                expect(json).toHaveProperty('statusCode', expectedStatus);
            }
        });

        it('createError returns correct error type', () => {
            const err = zeroHttp.createError(404, 'not found');
            expect(err.statusCode).toBe(404);
            expect(err.message).toBe('not found');
            expect(zeroHttp.isHttpError(err)).toBe(true);
        });

        it('ValidationError supports field-level errors', () => {
            const err = new zeroHttp.ValidationError('Invalid', { email: 'required' });
            expect(err.statusCode).toBe(422);
            expect(err.errors).toEqual({ email: 'required' });
        });
    });

    /* --- Framework error checks ----------------------------------- */
    describe('Framework Errors', () => {
        const frameworkErrors = {
            DatabaseError: { status: 500, opts: { query: 'SELECT 1', adapter: 'test' } },
            ConfigurationError: { status: 500, opts: { setting: 'PORT' } },
            MiddlewareError: { status: 500, opts: { middleware: 'test' } },
            RoutingError: { status: 500, opts: { path: '/', method: 'GET' } },
            TimeoutError: { status: 408, opts: { timeout: 5000 } },
        };

        for (const [name, { status, opts }] of Object.entries(frameworkErrors)) {
            it(`${name} instantiates correctly`, () => {
                const ErrorClass = zeroHttp[name];
                expect(ErrorClass).toBeDefined();
                const err = new ErrorClass('test', opts);
                expect(err.statusCode).toBe(status);
                expect(err.message).toBe('test');
                expect(zeroHttp.isHttpError(err)).toBe(true);
            });
        }
    });

    /* --- TYPES constant checks ------------------------------------ */
    describe('TYPES constants', () => {
        const typesSection = docs.find(s => s.section === 'ORM');
        if (!typesSection) return;

        const typesItem = typesSection.items.find(i => i.name === 'TYPES');
        if (!typesItem || !typesItem.options) return;

        it('all documented TYPES constants exist', () => {
            const missing = [];
            for (const opt of typesItem.options) {
                if (!(opt.option in zeroHttp.TYPES)) {
                    missing.push(opt.option);
                }
            }
            if (missing.length > 0) {
                throw new Error(
                    `Missing TYPES: ${missing.join(', ')}\n` +
                    `Available: ${Object.keys(zeroHttp.TYPES).join(', ')}`
                );
            }
        });

        it('TYPES values are strings', () => {
            for (const opt of typesItem.options) {
                if (opt.option in zeroHttp.TYPES) {
                    expect(typeof zeroHttp.TYPES[opt.option]).toBe('string');
                }
            }
        });
    });

    /* --- Middleware factory checks --------------------------------- */
    describe('Middleware factories return functions', () => {
        const middlewareNames = ['cors', 'compress', 'helmet', 'rateLimit', 'timeout',
            'requestId', 'logger', 'cookieParser', 'csrf', 'errorHandler'];

        for (const name of middlewareNames) {
            it(`${name}() returns a middleware function`, () => {
                const factory = zeroHttp[name];
                expect(typeof factory).toBe('function');
                const mw = factory();
                expect(typeof mw).toBe('function');
            });
        }
    });

    /* --- Body parser factory checks ------------------------------- */
    describe('Body parsers return middleware functions', () => {
        const parsers = ['json', 'urlencoded', 'text', 'raw'];

        for (const name of parsers) {
            it(`${name}() returns a middleware function`, () => {
                const factory = zeroHttp[name];
                expect(typeof factory).toBe('function');
                const mw = factory();
                expect(typeof mw).toBe('function');
            });
        }

        it('multipart() returns a middleware function', () => {
            const mw = zeroHttp.multipart({ dir: path.join(__dirname, 'tmp-test-uploads') });
            expect(typeof mw).toBe('function');
        });
    });

    /* --- env module API checks ------------------------------------ */
    describe('env module API', () => {
        const envSection = docs.find(s => s.section === 'Environment');
        if (!envSection) return;

        const envItem = envSection.items.find(i => i.name === 'env');
        if (!envItem || !envItem.methods) return;

        it('all documented env methods exist', () => {
            const missing = [];
            for (const methodDef of envItem.methods) {
                const name = methodDef.method;
                if (typeof zeroHttp.env[name] !== 'function') {
                    missing.push(name);
                }
            }
            if (missing.length > 0) {
                throw new Error(`Missing env methods: ${missing.join(', ')}`);
            }
        });
    });

    /* --- Router API checks ---------------------------------------- */
    describe('Router API', () => {
        const coreSection = docs.find(s => s.section === 'Core');
        if (!coreSection) return;

        const routerItem = coreSection.items.find(i => i.name === 'Router');
        if (!routerItem || !routerItem.methods) return;

        it('all documented Router methods exist', () => {
            const router = zeroHttp.Router();
            const missing = [];
            for (const methodDef of routerItem.methods) {
                const name = methodDef.method;
                if (typeof router[name] !== 'function') {
                    missing.push(name);
                }
            }
            if (missing.length > 0) {
                throw new Error(`Missing Router methods: ${missing.join(', ')}`);
            }
        });
    });

    /* --- WebSocketPool API checks ---------------------------------- */
    describe('WebSocketPool API', () => {
        const rtSection = docs.find(s => s.section === 'Real-Time');
        if (!rtSection) return;

        const poolItem = rtSection.items.find(i => i.name === 'WebSocketPool');
        if (!poolItem || !poolItem.methods) return;

        it('all documented WebSocketPool methods exist', () => {
            const pool = new zeroHttp.WebSocketPool();
            const missing = [];
            for (const methodDef of poolItem.methods) {
                const name = methodDef.method;
                const has = typeof pool[name] === 'function' ||
                            pool[name] !== undefined;
                if (!has) {
                    missing.push(name);
                }
            }
            if (missing.length > 0) {
                throw new Error(`Missing WebSocketPool methods/props: ${missing.join(', ')}`);
            }
        });
    });

    /* --- Database.connect smoke test ------------------------------- */
    describe('Database.connect (memory)', () => {
        it('connects with memory adapter as documented', async () => {
            const db = zeroHttp.Database.connect('memory');
            expect(db).toBeDefined();

            class TestModel extends zeroHttp.Model {
                static table = 'test_docs';
                static schema = {
                    id: { type: zeroHttp.TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                    name: { type: zeroHttp.TYPES.STRING, required: true },
                };
            }

            db.register(TestModel);
            await db.sync();

            const row = await TestModel.create({ name: 'DocTest' });
            expect(row.name).toBe('DocTest');
            expect(row.id).toBeDefined();

            const found = await TestModel.findById(row.id);
            expect(found).not.toBeNull();
            expect(found.name).toBe('DocTest');

            await db.close();
        });
    });

    /* --- cookieParser static methods ------------------------------- */
    describe('cookieParser static helpers', () => {
        it('sign / unsign round-trips', () => {
            const signed = zeroHttp.cookieParser.sign('hello', 'secret');
            expect(signed.startsWith('s:')).toBe(true);
            const val = zeroHttp.cookieParser.unsign(signed, ['secret']);
            expect(val).toBe('hello');
        });

        it('jsonCookie / parseJSON round-trips', () => {
            const json = zeroHttp.cookieParser.jsonCookie({ a: 1 });
            expect(json.startsWith('j:')).toBe(true);
            const parsed = zeroHttp.cookieParser.parseJSON(json);
            expect(parsed).toEqual({ a: 1 });
        });
    });

    /* --- validate static helpers ----------------------------------- */
    describe('validate static helpers', () => {
        it('validate.field exists and returns result', () => {
            expect(typeof zeroHttp.validate.field).toBe('function');
            const result = zeroHttp.validate.field('hello', { type: 'string', minLength: 2 }, 'testField');
            expect(result).toHaveProperty('value');
            expect(result.error).toBeNull();
        });

        it('validate.field catches errors', () => {
            const result = zeroHttp.validate.field('', { type: 'string', required: true }, 'name');
            expect(result.error).toBeTruthy();
        });

        it('validate.object exists and returns result', () => {
            expect(typeof zeroHttp.validate.object).toBe('function');
            const result = zeroHttp.validate.object(
                { name: 'Alice' },
                { name: { type: 'string', required: true } }
            );
            expect(result).toHaveProperty('sanitized');
            expect(result).toHaveProperty('errors');
            expect(result.errors).toHaveLength(0);
            expect(result.sanitized.name).toBe('Alice');
        });

        it('validate.object reports validation errors', () => {
            const result = zeroHttp.validate.object(
                {},
                { name: { type: 'string', required: true } }
            );
            expect(result.errors.length).toBeGreaterThan(0);
        });
    });

    /* --- debug module API ------------------------------------------ */
    describe('debug module', () => {
        it('creates namespaced logger with level methods', () => {
            const log = zeroHttp.debug('test:docs');
            expect(typeof log).toBe('function');
            expect(typeof log.info).toBe('function');
            expect(typeof log.warn).toBe('function');
            expect(typeof log.error).toBe('function');
            expect(typeof log.trace).toBe('function');
            expect(typeof log.fatal).toBe('function');
        });

        it('has module-level control methods', () => {
            expect(typeof zeroHttp.debug.enable).toBe('function');
            expect(typeof zeroHttp.debug.disable).toBe('function');
            expect(typeof zeroHttp.debug.level).toBe('function');
            expect(typeof zeroHttp.debug.json).toBe('function');
            expect(typeof zeroHttp.debug.timestamps).toBe('function');
            expect(typeof zeroHttp.debug.colors).toBe('function');
            expect(typeof zeroHttp.debug.reset).toBe('function');
        });
    });

    /* --- Database migration methods exist -------------------------- */
    describe('Database migration API', () => {
        let db;
        beforeAll(() => { db = zeroHttp.Database.connect('memory'); });
        afterAll(() => db.close());

        const migrationMethods = [
            'addColumn', 'dropColumn', 'renameColumn', 'renameTable',
            'createIndex', 'dropIndex', 'hasTable', 'hasColumn',
            'describeTable', 'addForeignKey', 'dropForeignKey',
        ];

        for (const method of migrationMethods) {
            it(`db.${method}() exists`, () => {
                expect(typeof db[method]).toBe('function');
            });
        }
    });

    /* --- Memory adapter migration methods exist -------------------- */
    describe('Memory adapter migration API', () => {
        let adapter;
        beforeAll(() => {
            const db = zeroHttp.Database.connect('memory');
            adapter = db.adapter;
        });

        const adapterMethods = [
            'addColumn', 'dropColumn', 'renameColumn', 'renameTable',
            'createIndex', 'dropIndex', 'hasTable', 'hasColumn',
            'describeTable', 'indexes',
        ];

        for (const method of adapterMethods) {
            it(`adapter.${method}() exists`, () => {
                expect(typeof adapter[method]).toBe('function');
            });
        }
    });

    /* --- Schema DDL options documented correctly ------------------- */
    describe('Schema DDL options', () => {
        const ormSection = docs.find(s => s.section === 'ORM');
        const schemaDDL = ormSection?.items.find(i => i.name === 'Schema DDL');

        it('Schema DDL item exists in docs', () => {
            expect(schemaDDL).toBeDefined();
        });

        it('has all expected DDL options', () => {
            const optionNames = schemaDDL.options.map(o => o.option);
            const expected = ['references', 'check', 'index', 'compositeKey', 'compositeUnique', 'compositeIndex', 'guarded'];
            for (const opt of expected) {
                expect(optionNames).toContain(opt);
            }
        });

        it('has an example that imports Database', () => {
            expect(schemaDDL.example).toContain('Database');
            expect(schemaDDL.example).toContain("require('zero-http')");
        });

        it('example includes FK, composite PK, and migration patterns', () => {
            expect(schemaDDL.example).toContain('references');
            expect(schemaDDL.example).toContain('compositeKey');
            expect(schemaDDL.example).toContain('compositeUnique');
            expect(schemaDDL.example).toContain('compositeIndex');
            expect(schemaDDL.example).toContain('addColumn');
            expect(schemaDDL.example).toContain('createIndex');
            expect(schemaDDL.example).toContain('hasTable');
            expect(schemaDDL.example).toContain('describeTable');
        });
    });

    /* --- Database docs list all migration methods ------------------ */
    describe('Database docs completeness', () => {
        const ormSection = docs.find(s => s.section === 'ORM');
        const dbItem = ormSection?.items.find(i => i.name === 'Database');

        it('Database item exists in docs', () => {
            expect(dbItem).toBeDefined();
        });

        it('has all migration methods documented', () => {
            const documented = dbItem.methods.map(m => m.method);
            const expected = [
                'addColumn', 'dropColumn', 'renameColumn', 'renameTable',
                'createIndex', 'dropIndex', 'hasTable', 'hasColumn',
                'describeTable', 'addForeignKey', 'dropForeignKey',
            ];
            for (const m of expected) {
                expect(documented).toContain(m);
            }
        });

        it('dropIndex signature uses (table, name)', () => {
            const di = dbItem.methods.find(m => m.method === 'dropIndex');
            expect(di.signature).toContain('table');
            expect(di.signature).toContain('name');
        });
    });
});
