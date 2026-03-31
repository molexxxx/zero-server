/**
 * Tests for the typed environment variable system.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// We need a fresh env instance each test — import the factory
let env;

beforeEach(() =>
{
    // Clear require cache to get a fresh env module
    delete require.cache[require.resolve('../../lib/env')];
    env = require('../../lib/env');
    env.reset();
});

describe('Env — parse()', () =>
{
    it('parses simple key=value pairs', () =>
    {
        const result = env.parse('FOO=bar\nBAZ=qux');
        expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('strips double quotes', () =>
    {
        const result = env.parse('FOO="hello world"');
        expect(result).toEqual({ FOO: 'hello world' });
    });

    it('strips single quotes', () =>
    {
        const result = env.parse("FOO='hello world'");
        expect(result).toEqual({ FOO: 'hello world' });
    });

    it('handles empty values', () =>
    {
        const result = env.parse('EMPTY=');
        expect(result).toEqual({ EMPTY: '' });
    });

    it('skips comments', () =>
    {
        const result = env.parse('# comment\nFOO=bar\n# another');
        expect(result).toEqual({ FOO: 'bar' });
    });

    it('strips export prefix', () =>
    {
        const result = env.parse('export FOO=bar');
        expect(result).toEqual({ FOO: 'bar' });
    });

    it('handles inline comments (unquoted)', () =>
    {
        const result = env.parse('FOO=bar # this is a comment');
        expect(result.FOO).toBe('bar');
    });

    it('skips blank lines', () =>
    {
        const result = env.parse('\n\nFOO=bar\n\n');
        expect(result).toEqual({ FOO: 'bar' });
    });
});

describe('Env — load() with schema', () =>
{
    const originalEnv = { ...process.env };

    afterEach(() =>
    {
        // Restore process.env
        for (const k of Object.keys(process.env))
        {
            if (!(k in originalEnv)) delete process.env[k];
        }
        Object.assign(process.env, originalEnv);
    });

    it('coerces port type', () =>
    {
        process.env.PORT = '3000';
        env.load({ PORT: { type: 'port', default: 8080 } });
        expect(env.PORT).toBe(3000);
        expect(typeof env.PORT).toBe('number');
    });

    it('applies default values', () =>
    {
        env.load({ MY_VAR: { type: 'string', default: 'hello' } });
        expect(env.MY_VAR).toBe('hello');
    });

    it('coerces boolean type', () =>
    {
        process.env.DEBUG = 'true';
        env.load({ DEBUG: { type: 'boolean', default: false } });
        expect(env.DEBUG).toBe(true);
    });

    it('coerces integer type', () =>
    {
        process.env.COUNT = '42';
        env.load({ COUNT: { type: 'integer' } });
        expect(env.COUNT).toBe(42);
    });

    it('coerces number type', () =>
    {
        process.env.RATE = '3.14';
        env.load({ RATE: { type: 'number' } });
        expect(env.RATE).toBe(3.14);
    });

    it('coerces array type', () =>
    {
        process.env.HOSTS = 'a,b,c';
        env.load({ HOSTS: { type: 'array', separator: ',' } });
        expect(env.HOSTS).toEqual(['a', 'b', 'c']);
    });

    it('coerces json type', () =>
    {
        process.env.CONFIG = '{"a":1}';
        env.load({ CONFIG: { type: 'json' } });
        expect(env.CONFIG).toEqual({ a: 1 });
    });

    it('validates enum values', () =>
    {
        process.env.LEVEL = 'info';
        env.load({ LEVEL: { type: 'enum', values: ['debug', 'info', 'warn', 'error'] } });
        expect(env.LEVEL).toBe('info');
    });

    it('throws on invalid enum', () =>
    {
        process.env.LEVEL = 'trace';
        expect(() =>
        {
            env.load({ LEVEL: { type: 'enum', values: ['debug', 'info', 'warn', 'error'] } });
        }).toThrow();
    });

    it('throws on required missing env', () =>
    {
        delete process.env.MISSING_VAR;
        expect(() =>
        {
            env.load({ MISSING_VAR: { type: 'string', required: true } });
        }).toThrow();
    });

    it('validates port range', () =>
    {
        process.env.BAD_PORT = '99999';
        expect(() =>
        {
            env.load({ BAD_PORT: { type: 'port' } });
        }).toThrow();
    });
});

describe('Env — accessor patterns', () =>
{
    const originalEnv = { ...process.env };

    afterEach(() =>
    {
        for (const k of Object.keys(process.env))
        {
            if (!(k in originalEnv)) delete process.env[k];
        }
        Object.assign(process.env, originalEnv);
    });

    it('env.KEY proxy access', () =>
    {
        process.env.PROXY_TEST = 'works';
        env.load({ PROXY_TEST: { type: 'string' } });
        expect(env.PROXY_TEST).toBe('works');
    });

    it('env("KEY") function access', () =>
    {
        process.env.FN_TEST = 'fn';
        env.load({ FN_TEST: { type: 'string' } });
        expect(env('FN_TEST')).toBe('fn');
    });

    it('env.get("KEY")', () =>
    {
        process.env.GET_TEST = '123';
        env.load({ GET_TEST: { type: 'integer' } });
        expect(env.get('GET_TEST')).toBe(123);
    });

    it('env.has() returns boolean', () =>
    {
        process.env.EXISTS = 'yes';
        env.load({ EXISTS: { type: 'string' } });
        expect(env.has('EXISTS')).toBe(true);
        expect(env.has('NOPE')).toBe(false);
    });

    it('env.require() throws on missing', () =>
    {
        expect(() => env.require('NONEXIST')).toThrow();
    });

    it('env.all() returns all loaded values', () =>
    {
        process.env.A = '1';
        process.env.B = '2';
        env.load({ A: { type: 'integer' }, B: { type: 'integer' } });
        const all = env.all();
        expect(all.A).toBe(1);
        expect(all.B).toBe(2);
    });

    it('env.reset() clears store', () =>
    {
        process.env.R = 'val';
        env.load({ R: { type: 'string' } });
        expect(env.has('R')).toBe(true);
        env.reset();
        delete process.env.R;
        expect(env.has('R')).toBe(false);
    });

    it('process.env takes precedence over defaults', () =>
    {
        process.env.OVERRIDE = 'from_env';
        env.load({ OVERRIDE: { type: 'string', default: 'default_val' } });
        expect(env.OVERRIDE).toBe('from_env');
    });
});

describe('Env — process.env sync', () =>
{
    const originalEnv = { ...process.env };

    afterEach(() =>
    {
        for (const k of Object.keys(process.env))
        {
            if (!(k in originalEnv)) delete process.env[k];
        }
        Object.assign(process.env, originalEnv);
    });

    it('syncs coerced values to process.env by default', () =>
    {
        process.env.SYNC_PORT = '3000';
        env.load({ SYNC_PORT: { type: 'port' } });
        // process.env stores strings, but the value should be there
        expect(process.env.SYNC_PORT).toBe('3000');
    });

    it('syncs default values to process.env', () =>
    {
        delete process.env.SYNC_DEF;
        env.load({ SYNC_DEF: { type: 'string', default: 'hello' } });
        expect(process.env.SYNC_DEF).toBe('hello');
    });

    it('syncs boolean defaults to process.env as strings', () =>
    {
        delete process.env.SYNC_BOOL;
        env.load({ SYNC_BOOL: { type: 'boolean', default: false } });
        expect(process.env.SYNC_BOOL).toBe('false');
    });

    it('syncs array values to process.env as JSON', () =>
    {
        process.env.SYNC_ARR = 'a,b,c';
        env.load({ SYNC_ARR: { type: 'array', separator: ',' } });
        expect(process.env.SYNC_ARR).toBe('["a","b","c"]');
    });

    it('does not sync when override is explicitly false', () =>
    {
        delete process.env.NO_SYNC;
        env.load(
            { NO_SYNC: { type: 'string', default: 'should_not_sync' } },
            { override: false }
        );
        expect(process.env.NO_SYNC).toBeUndefined();
    });
});



// =========================================================================
//  env — deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('env — deep branch coverage', () => {
	let env;
	const tmpDir = path.join(os.tmpdir(), 'zero-test-env-deep-' + Date.now());

	beforeAll(() => {
		env = require('../../lib/env');
		fs.mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		env.reset();
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	});

	beforeEach(() => {
		env.reset();
	});

	it('parse() handles export prefix', () => {
		const result = env.parse('export FOO=bar\nexport BAZ=qux');
		expect(result.FOO).toBe('bar');
		expect(result.BAZ).toBe('qux');
	});

	it('parse() handles inline comments', () => {
		const result = env.parse('KEY=value # this is a comment');
		expect(result.KEY).toBe('value');
	});

	it('parse() handles quoted values', () => {
		const result = env.parse('SINGLE=\'hello\'\nDOUBLE="world"\nBACK=`tick`');
		expect(result.SINGLE).toBe('hello');
		expect(result.DOUBLE).toBe('world');
		expect(result.BACK).toBe('tick');
	});

	it('parse() handles multiline quoted values', () => {
		const result = env.parse('KEY="line1\nline2\nline3"');
		// The multiline parsing should handle the line break within quotes
		expect(result.KEY).toBeDefined();
	});

	it('parse() handles variable interpolation', () => {
		const result = env.parse('HOST=localhost\nURL=http://${HOST}:3000');
		expect(result.URL).toBe('http://localhost:3000');
	});

	it('parse() skips lines without = sign', () => {
		const result = env.parse('NO_EQUALS_HERE\nGOOD=yes');
		expect(result.NO_EQUALS_HERE).toBeUndefined();
		expect(result.GOOD).toBe('yes');
	});

	it('parse() skips blank lines and comments', () => {
		const result = env.parse('\n# comment\n\nKEY=val\n');
		expect(result.KEY).toBe('val');
		expect(Object.keys(result).length).toBe(1);
	});

	it('parse() skips invalid key names', () => {
		const result = env.parse('bad-key=val\nGOOD_KEY=ok\n123invalid=no');
		expect(result['bad-key']).toBeUndefined();
		expect(result.GOOD_KEY).toBe('ok');
	});

	it('load() with schema validates required fields', () => {
		expect(() => {
			env.load({
				MISSING_REQUIRED: { type: 'string', required: true },
			}, { path: tmpDir });
		}).toThrow(/required/i);
	});

	it('load() with schema applies default values', () => {
		env.load({
			WITH_DEFAULT: { type: 'string', default: 'fallback' },
		}, { path: tmpDir });
		expect(env.get('WITH_DEFAULT')).toBe('fallback');
	});

	it('load() with schema applies default function', () => {
		env.load({
			DYNAMIC_DEFAULT: { type: 'string', default: () => 'generated' },
		}, { path: tmpDir });
		expect(env.get('DYNAMIC_DEFAULT')).toBe('generated');
	});

	it('coerce — string with min/max length constraints', () => {
		delete process.env.SHORT_STR;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'SHORT_STR=ab\n');
		expect(() => {
			env.load({
				SHORT_STR: { type: 'string', min: 5 },
			}, { path: tmpDir });
		}).toThrow(/at least 5/);
	});

	it('coerce — string with max length constraint', () => {
		env.reset();
		delete process.env.LONG_STR;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'LONG_STR=abcdefgh\n');
		expect(() => {
			env.load({
				LONG_STR: { type: 'string', max: 3 },
			}, { path: tmpDir });
		}).toThrow(/at most 3/);
	});

	it('coerce — string with match pattern', () => {
		env.reset();
		delete process.env.EMAIL_STR;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'EMAIL_STR=notanemail\n');
		expect(() => {
			env.load({
				EMAIL_STR: { type: 'string', match: /^[^@]+@[^@]+$/ },
			}, { path: tmpDir });
		}).toThrow(/does not match/);
	});

	it('coerce — number with NaN', () => {
		env.reset();
		delete process.env.NUM_NAN;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'NUM_NAN=abc\n');
		expect(() => {
			env.load({
				NUM_NAN: { type: 'number' },
			}, { path: tmpDir });
		}).toThrow(/must be a number/);
	});

	it('coerce — number with min/max constraints', () => {
		env.reset();
		delete process.env.NUM_MIN;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'NUM_MIN=5\n');
		expect(() => {
			env.load({
				NUM_MIN: { type: 'number', min: 10 },
			}, { path: tmpDir });
		}).toThrow(/must be >= 10/);
	});

	it('coerce — number max constraint', () => {
		env.reset();
		delete process.env.NUM_MAX;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'NUM_MAX=100\n');
		expect(() => {
			env.load({
				NUM_MAX: { type: 'number', max: 50 },
			}, { path: tmpDir });
		}).toThrow(/must be <= 50/);
	});

	it('coerce — integer', () => {
		env.reset();
		delete process.env.INT_OK;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'INT_OK=42\n');
		env.load({ INT_OK: { type: 'integer' } }, { path: tmpDir });
		expect(env.get('INT_OK')).toBe(42);
	});

	it('coerce — integer NaN', () => {
		env.reset();
		delete process.env.INT_NAN;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'INT_NAN=abc\n');
		expect(() => {
			env.load({ INT_NAN: { type: 'integer' } }, { path: tmpDir });
		}).toThrow(/must be an integer/);
	});

	it('coerce — integer min/max', () => {
		env.reset();
		delete process.env.INT_MIN;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'INT_MIN=5\n');
		expect(() => {
			env.load({ INT_MIN: { type: 'integer', min: 10 } }, { path: tmpDir });
		}).toThrow(/must be >= 10/);

		env.reset();
		delete process.env.INT_MAX;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'INT_MAX=100\n');
		expect(() => {
			env.load({ INT_MAX: { type: 'integer', max: 50 } }, { path: tmpDir });
		}).toThrow(/must be <= 50/);
	});

	it('coerce — port valid', () => {
		env.reset();
		delete process.env.GOOD_PORT;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'GOOD_PORT=8080\n');
		env.load({ GOOD_PORT: { type: 'port' } }, { path: tmpDir });
		expect(env.get('GOOD_PORT')).toBe(8080);
	});

	it('coerce — port invalid', () => {
		env.reset();
		delete process.env.BAD_PORT;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BAD_PORT=99999\n');
		expect(() => {
			env.load({ BAD_PORT: { type: 'port' } }, { path: tmpDir });
		}).toThrow(/valid port.*0-65535/);
	});

	it('coerce — boolean values', () => {
		env.reset();
		delete process.env.BV1; delete process.env.BV2; delete process.env.BV3; delete process.env.BV4;
		delete process.env.BV5; delete process.env.BV6; delete process.env.BV7; delete process.env.BV8;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BV1=true\nBV2=false\nBV3=yes\nBV4=no\nBV5=1\nBV6=0\nBV7=on\nBV8=off\n');
		env.load({
			BV1: { type: 'boolean' }, BV2: { type: 'boolean' },
			BV3: { type: 'boolean' }, BV4: { type: 'boolean' },
			BV5: { type: 'boolean' }, BV6: { type: 'boolean' },
			BV7: { type: 'boolean' }, BV8: { type: 'boolean' },
		}, { path: tmpDir });
		expect(env.get('BV1')).toBe(true);
		expect(env.get('BV2')).toBe(false);
		expect(env.get('BV3')).toBe(true);
		expect(env.get('BV4')).toBe(false);
		expect(env.get('BV5')).toBe(true);
		expect(env.get('BV6')).toBe(false);
		expect(env.get('BV7')).toBe(true);
		expect(env.get('BV8')).toBe(false);
	});

	it('coerce — boolean invalid', () => {
		env.reset();
		delete process.env.BOOL_BAD;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BOOL_BAD=maybe\n');
		expect(() => {
			env.load({ BOOL_BAD: { type: 'boolean' } }, { path: tmpDir });
		}).toThrow(/must be a boolean/);
	});

	it('coerce — array with custom separator', () => {
		env.reset();
		delete process.env.LIST_PIPE;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'LIST_PIPE=a|b|c\n');
		env.load({ LIST_PIPE: { type: 'array', separator: '|' } }, { path: tmpDir });
		expect(env.get('LIST_PIPE')).toEqual(['a', 'b', 'c']);
	});

	it('coerce — json', () => {
		env.reset();
		delete process.env.OBJ_GOOD;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'OBJ_GOOD={"key":"val"}\n');
		env.load({ OBJ_GOOD: { type: 'json' } }, { path: tmpDir });
		expect(env.get('OBJ_GOOD')).toEqual({ key: 'val' });
	});

	it('coerce — json invalid', () => {
		env.reset();
		delete process.env.BAD_JSON;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BAD_JSON=not-json\n');
		expect(() => {
			env.load({ BAD_JSON: { type: 'json' } }, { path: tmpDir });
		}).toThrow(/must be valid JSON/);
	});

	it('coerce — url valid', () => {
		env.reset();
		delete process.env.URL_GOOD;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'URL_GOOD=https://example.com\n');
		env.load({ URL_GOOD: { type: 'url' } }, { path: tmpDir });
		expect(env.get('URL_GOOD')).toBe('https://example.com');
	});

	it('coerce — url invalid', () => {
		env.reset();
		delete process.env.BAD_URL;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BAD_URL=notaurl\n');
		expect(() => {
			env.load({ BAD_URL: { type: 'url' } }, { path: tmpDir });
		}).toThrow(/must be a valid URL/);
	});

	it('coerce — enum valid', () => {
		env.reset();
		// avoid NODE_ENV collision: use unique env key
		fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_MODE=production\n');
		env.load({ APP_MODE: { type: 'enum', values: ['development', 'production', 'test'] } }, { path: tmpDir });
		expect(env.get('APP_MODE')).toBe('production');
	});

	it('coerce — enum invalid', () => {
		env.reset();
		delete process.env.ENUM_BAD;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'ENUM_BAD=staging\n');
		expect(() => {
			env.load({ ENUM_BAD: { type: 'enum', values: ['development', 'production'] } }, { path: tmpDir });
		}).toThrow(/must be one of/);
	});

	it('coerce — unknown type returns raw', () => {
		env.reset();
		delete process.env.UNKNOWN_TYPE;
		fs.writeFileSync(path.join(tmpDir, '.env'), 'UNKNOWN_TYPE=hello\n');
		env.load({ UNKNOWN_TYPE: { type: 'custom_unknown' } }, { path: tmpDir });
		expect(env.get('UNKNOWN_TYPE')).toBe('hello');
	});

	it('require() throws for missing key', () => {
		env.reset();
		expect(() => env.require('NONEXISTENT')).toThrow(/not set/);
	});

	it('has() checks store and process.env', () => {
		env.reset();
		expect(env.has('PATH')).toBe(true); // PATH is always set
		expect(env.has('COMPLETELY_MISSING_VAR_' + Date.now())).toBe(false);
	});

	it('all() returns copy of store', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'ALL_A=1\nALL_B=2\n');
		env.load(undefined, { path: tmpDir });
		const all = env.all();
		expect(all.ALL_A).toBe('1');
		expect(all.ALL_B).toBe('2');
	});

	it('proxy access reads values', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'PROXY_TEST=hello\n');
		env.load(undefined, { path: tmpDir });
		expect(env.PROXY_TEST).toBe('hello');
	});

	it('function call syntax works', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'CALL_TEST=world\n');
		env.load(undefined, { path: tmpDir });
		expect(env('CALL_TEST')).toBe('world');
	});

	it('load() with string path argument', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'STR_PATH=yes\n');
		env.load(tmpDir);
		expect(env.get('STR_PATH')).toBe('yes');
	});

	it('load() without schema merges all vars', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'NO_SCHEMA=val\n');
		env.load(undefined, { path: tmpDir });
		expect(env.get('NO_SCHEMA')).toBe('val');
	});

	it('load() with override: false does not overwrite env vars', () => {
		env.reset();
		const key = 'ZERO_TEST_OVERRIDE_' + Date.now();
		process.env[key] = 'original';
		fs.writeFileSync(path.join(tmpDir, '.env'), `${key}=overridden\n`);
		env.load(undefined, { path: tmpDir, override: false });
		expect(process.env[key]).toBe('original');
		delete process.env[key];
	});

	it('load with .env.local file', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), 'BASE=1\n');
		fs.writeFileSync(path.join(tmpDir, '.env.local'), 'LOCAL=2\n');
		env.load(undefined, { path: tmpDir });
		expect(env.get('BASE')).toBe('1');
		expect(env.get('LOCAL')).toBe('2');
		try { fs.unlinkSync(path.join(tmpDir, '.env.local')); } catch {}
	});

	it('multiple validation errors collected', () => {
		env.reset();
		fs.writeFileSync(path.join(tmpDir, '.env'), '');
		expect(() => {
			env.load({
				REQ1: { type: 'string', required: true },
				REQ2: { type: 'string', required: true },
			}, { path: tmpDir });
		}).toThrow(/REQ1.*REQ2|REQ2.*REQ1/s);
	});
});

// =========================================================================
//  env — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  16. ENV — MULTILINE, BACKTICK, INTERPOLATION
// ============================================================
describe('env — parse edge cases', () => {
	it('parses backtick-quoted values', () => {
		const { env } = require('../../');
		const result = env.parse('KEY=`hello world`');
		expect(result.KEY).toBe('hello world');
	});

	it('parses variable interpolation', () => {
		const { env } = require('../../');
		const result = env.parse('BASE=/app\nFULL=${BASE}/lib');
		expect(result.FULL).toBe('/app/lib');
	});

	it('parses multiline values in double quotes', () => {
		const { env } = require('../../');
		const result = env.parse('KEY="line1\nline2"');
		expect(result.KEY).toBe('line1\nline2');
	});

	it('parses export prefix', () => {
		const { env } = require('../../');
		const result = env.parse('export MY_VAR=hello');
		expect(result.MY_VAR).toBe('hello');
	});

	it('strips inline comments', () => {
		const { env } = require('../../');
		const result = env.parse('KEY=value # this is a comment');
		expect(result.KEY).toBe('value');
	});

	it('skips comment-only lines', () => {
		const { env } = require('../../');
		const result = env.parse('# comment\nKEY=val');
		expect(result.KEY).toBe('val');
		expect(Object.keys(result).length).toBe(1);
	});
});
