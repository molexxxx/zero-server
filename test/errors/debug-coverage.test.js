/**
 * Coverage tests for lib/debug.js — targets uncovered _nsColor, pattern
 * matching edges, JSON mode error attachment, text output branches,
 * stderr routing, DEBUG_LEVEL env init, and reset().
 */
const debug = require('../../lib/debug');

describe('Debug Logger: coverage gaps', () =>
{
    let output, stderrOutput;

    beforeEach(() =>
    {
        output = [];
        stderrOutput = [];
        debug.reset();
        debug.output({ write: (s) => output.push(s) });
        debug.colors(false);
        debug.timestamps(false);
        delete process.env.DEBUG;
        debug.enable('*');
    });

    afterEach(() =>
    {
        debug.reset();
        delete process.env.DEBUG;
        delete process.env.DEBUG_LEVEL;
    });

    // =========================================================
    // _nsColor coverage — each new namespace gets unique color
    // =========================================================

    it('assigns unique colors to different namespaces', () =>
    {
        debug.colors(true);
        debug.level('trace');

        // Create many loggers to cycle through all NS_COLORS
        const namespaces = [];
        for (let i = 0; i < 12; i++)
        {
            const ns = `ns${i}`;
            namespaces.push(ns);
            const logger = debug(ns);
            logger.info(`msg from ${ns}`);
        }

        // All 12 should have produced output
        expect(output.length).toBe(12);
        // Each output should contain ANSI color codes
        output.forEach(line => expect(line).toContain('\x1b['));
    });

    it('reuses color for same namespace', () =>
    {
        debug.colors(true);
        debug.level('trace');

        const log1 = debug('same:ns');
        const log2 = debug('same:ns');
        log1.info('first');
        log2.info('second');

        expect(output.length).toBe(2);
    });

    // =========================================================
    // Pattern matching with negation edge cases
    // =========================================================

    it('negation pattern disables specific namespace', () =>
    {
        debug.enable('app:*,-app:internal');
        debug.level('trace');

        const appLog = debug('app:routes');
        const internalLog = debug('app:internal');

        appLog.info('visible');
        internalLog.info('hidden');

        expect(output.length).toBe(1);
        expect(output[0]).toContain('app:routes');
    });

    it('multiple negation patterns', () =>
    {
        debug.enable('*,-db:*,-cache:*');
        debug.level('trace');

        const appLog = debug('app');
        const dbLog = debug('db:queries');
        const cacheLog = debug('cache:redis');

        appLog.info('visible');
        dbLog.info('hidden');
        cacheLog.info('hidden');

        expect(output.length).toBe(1);
    });

    it('disabled namespace has enabled=false', () =>
    {
        debug.enable('app:*,-app:secret');
        const secret = debug('app:secret');
        expect(secret.enabled).toBe(false);
    });

    // =========================================================
    // JSON mode — error attachment
    // =========================================================

    it('JSON mode attaches error when last arg is Error', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log = debug('app');

        const err = new Error('crash');
        err.code = 'E_FAIL';
        log.error('something failed', err);

        const parsed = JSON.parse(output[0]);
        expect(parsed.error).toBeDefined();
        expect(parsed.error.message).toBe('crash');
        expect(parsed.error.code).toBe('E_FAIL');
        expect(parsed.error.stack).toBeDefined();
    });

    it('JSON mode does not attach error when last arg is not Error', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log = debug('app');

        log.info('just a message', 'string arg');

        const parsed = JSON.parse(output[0]);
        expect(parsed.error).toBeUndefined();
    });

    it('JSON mode with no arguments', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log = debug('app');

        log.info();

        const parsed = JSON.parse(output[0]);
        expect(parsed.message).toBe('');
    });

    // =========================================================
    // Text output branches with colors + timestamps
    // =========================================================

    it('text output with colors enabled includes ANSI codes', () =>
    {
        debug.colors(true);
        debug.timestamps(false);
        debug.level('trace');
        const log = debug('colorful');
        log.info('colored message');

        expect(output[0]).toContain('\x1b[');
    });

    it('text output with timestamps enabled includes time', () =>
    {
        debug.timestamps(true);
        debug.colors(false);
        debug.level('trace');
        const log = debug('ts');
        log.info('with timestamp');

        expect(output[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    it('text output with both colors and timestamps', () =>
    {
        debug.colors(true);
        debug.timestamps(true);
        debug.level('trace');
        const log = debug('both');
        log.info('full output');

        expect(output[0]).toContain('\x1b[');
        expect(output[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    it('text output without colors strips ANSI', () =>
    {
        debug.colors(false);
        debug.timestamps(false);
        debug.level('trace');
        const log = debug('plain');
        log.info('plain text');

        expect(output[0]).not.toContain('\x1b[32m');
        expect(output[0]).toContain('INFO');
        expect(output[0]).toContain('plain');
    });

    // =========================================================
    // stderr routing for warn/error/fatal (no custom output)
    // =========================================================

    it('warn/error/fatal route to stderr when no custom output', () =>
    {
        // Reset to no custom output
        debug.reset();
        debug.colors(false);
        debug.timestamps(false);
        debug.enable('*');
        debug.level('trace');

        const stderrLines = [];
        const origWrite = process.stderr.write;
        process.stderr.write = (s) => { stderrLines.push(s); return true; };

        try
        {
            const log = debug('stderr-test');
            log.warn('warning msg');
            log.error('error msg');
            log.fatal('fatal msg');

            expect(stderrLines.length).toBe(3);
            expect(stderrLines[0]).toContain('WARN');
            expect(stderrLines[1]).toContain('ERROR');
            expect(stderrLines[2]).toContain('FATAL');
        }
        finally
        {
            process.stderr.write = origWrite;
        }
    });

    it('info/debug/trace route to stdout (or custom output) not stderr', () =>
    {
        debug.level('trace');
        const log = debug('stdout-test');

        const stderrLines = [];
        const origWrite = process.stderr.write;
        process.stderr.write = (s) => { stderrLines.push(s); return true; };

        try
        {
            log.info('info msg');
            log.debug('debug msg');
            log.trace('trace msg');

            // These should go to custom output, not stderr
            expect(output.length).toBe(3);
            expect(stderrLines.length).toBe(0);
        }
        finally
        {
            process.stderr.write = origWrite;
        }
    });

    // =========================================================
    // debug.level() with numeric value
    // =========================================================

    it('level accepts numeric value', () =>
    {
        debug.level(3); // warn level
        const log = debug('numeric');

        log.info('hidden');
        log.warn('visible');

        expect(output.length).toBe(1);
        expect(output[0]).toContain('WARN');
    });

    it('level with unknown string defaults to debug', () =>
    {
        debug.level('nonexistent');
        const log = debug('fallback');

        log('debug message');
        expect(output.length).toBe(1);
    });

    // =========================================================
    // debug.reset() behavior
    // =========================================================

    it('reset restores all defaults', () =>
    {
        debug.level('silent');
        debug.json(true);
        debug.timestamps(false);
        debug.colors(true);

        debug.reset();

        // After reset, should use default level (debug) and no JSON mode
        // Re-set custom output to capture
        debug.output({ write: (s) => output.push(s) });
        debug.colors(false);
        debug.timestamps(false);
        debug.enable('*');

        const log = debug('reset-test');
        log.info('after reset');
        expect(output.length).toBe(1);
    });

    // =========================================================
    // _format edge cases
    // =========================================================

    it('format %% produces literal percent', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        log.info('100%%');
        expect(output[0]).toContain('100%');
    });

    it('format with excess specifiers', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        log.info('val=%s extra=%d', 'hello');
        // %d with no matching arg should produce %d
        expect(output[0]).toContain('val=hello');
        expect(output[0]).toContain('extra=%d');
    });

    it('format with excess arguments', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        log.info('msg=%s', 'hi', 'extra1', 'extra2');
        expect(output[0]).toContain('msg=hi');
        expect(output[0]).toContain('extra1');
        expect(output[0]).toContain('extra2');
    });

    it('format with %o specifier', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        log.info('obj=%o', { x: 1 });
        expect(output[0]).toContain('{"x":1}');
    });

    it('format with circular object in %j fails gracefully', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        const obj = {};
        obj.self = obj;
        log.info('circ=%j', obj);
        // Should not crash; falls back to String(obj)
        expect(output.length).toBe(1);
    });

    it('format with non-string first argument', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        log.info({ key: 'value' });
        expect(output[0]).toContain('{"key":"value"}');
    });

    it('format with Error object (non-string first arg)', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        const err = new Error('oops');
        log.info(err);
        expect(output[0]).toContain('oops');
    });

    it('format with circular object as non-string arg', () =>
    {
        debug.level('trace');
        const log = debug('fmt');
        const obj = {};
        obj.self = obj;
        log.info(obj);
        expect(output.length).toBe(1);
    });

    // =========================================================
    // debug.json(false) disables JSON mode
    // =========================================================

    it('json(false) switches back to text mode', () =>
    {
        debug.json(true);
        debug.level('trace');
        const log1 = debug('j1');
        log1.info('json');
        expect(() => JSON.parse(output[0])).not.toThrow();

        output.length = 0;
        debug.json(false);
        const log2 = debug('j2');
        log2.info('text');
        expect(() => JSON.parse(output[0])).toThrow();
    });

    // =========================================================
    // DEBUG_LEVEL env var initialization
    // =========================================================

    it('respects DEBUG_LEVEL env var on reset', () =>
    {
        process.env.DEBUG_LEVEL = 'warn';
        debug.reset();
        debug.output({ write: (s) => output.push(s) });
        debug.colors(false);
        debug.timestamps(false);
        debug.enable('*');

        const log = debug('env');
        log.info('should be hidden');
        log.warn('should be visible');

        expect(output.length).toBe(1);
        expect(output[0]).toContain('WARN');

        delete process.env.DEBUG_LEVEL;
    });

    // =========================================================
    // All log levels produce output when level=trace
    // =========================================================

    it('all 6 log methods produce output at trace level', () =>
    {
        debug.level('trace');
        const log = debug('all');

        log.trace('t');
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
        log.fatal('f');

        expect(output.length).toBe(6);
    });

    // =========================================================
    // debug() default call is same as .debug
    // =========================================================

    it('logger.debug is same as default call', () =>
    {
        debug.level('debug');
        const log = debug('dup');
        expect(log.debug).toBe(log);
    });
});
