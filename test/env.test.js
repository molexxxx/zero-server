/**
 * Tests for the typed environment variable system.
 */
const path = require('path');
const fs = require('fs');

// We need a fresh env instance each test — import the factory
let env;

beforeEach(() =>
{
    // Clear require cache to get a fresh env module
    delete require.cache[require.resolve('../lib/env')];
    env = require('../lib/env');
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
