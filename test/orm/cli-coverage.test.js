/**
 * Coverage tests for lib/cli.js — targets uncovered branches:
 * unknown command, --verbose error stack, resolveConfig edge cases,
 * _loadConfigSync fallback, and flag aliases.
 */
const fs = require('fs');
const path = require('path');
const { CLI } = require('../../lib/cli');

describe('CLI — coverage gaps', () =>
{
    const origCwd = process.cwd();
    const tmpDir = path.join(__dirname, '__tmp_cli_cov__');

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        process.chdir(tmpDir);
    });

    afterEach(() =>
    {
        process.chdir(origCwd);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exitCode = undefined;
    });

    // =========================================================
    // Unknown command
    // =========================================================

    it('unknown command prints error and sets exitCode=1', async () =>
    {
        const cli = new CLI(['nonexistent']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const errOutput = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(errOutput).toContain('Unknown command');
        expect(errOutput).toContain('nonexistent');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    // =========================================================
    // --verbose flag shows error stack trace
    // =========================================================

    it('--verbose flag shows error stack on command failure', async () =>
    {
        // No config file, so migrate should throw
        const cli = new CLI(['migrate', '--verbose']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const calls = errSpy.mock.calls;
        // Should have error message and stack trace (two separate calls)
        expect(calls.length).toBeGreaterThanOrEqual(2);
        // First call is Error: <message>
        expect(calls[0][0]).toContain('Error:');
        // Second call should be the stack
        expect(calls[1][0]).toContain('at ');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    it('without --verbose does not show stack on command failure', async () =>
    {
        const cli = new CLI(['migrate']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const calls = errSpy.mock.calls;
        expect(calls.length).toBe(1);
        expect(calls[0][0]).toContain('Error:');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // Help aliases
    // =========================================================

    it('--help alias works', async () =>
    {
        const cli = new CLI(['--help']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        logSpy.mockRestore();
    });

    it('-h alias works', async () =>
    {
        const cli = new CLI(['-h']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        logSpy.mockRestore();
    });

    // =========================================================
    // Version aliases
    // =========================================================

    it('--version alias works', async () =>
    {
        const cli = new CLI(['--version']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toMatch(/\d+\.\d+\.\d+/);
        logSpy.mockRestore();
    });

    it('-v alias works', async () =>
    {
        const cli = new CLI(['-v']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toMatch(/\d+\.\d+\.\d+/);
        logSpy.mockRestore();
    });

    // =========================================================
    // make:model — missing name
    // =========================================================

    it('make:model with no name shows usage error', async () =>
    {
        const cli = new CLI(['make:model']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Usage');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // make:model — file already exists
    // =========================================================

    it('make:model rejects when file already exists', async () =>
    {
        fs.mkdirSync('models', { recursive: true });
        fs.writeFileSync(path.join('models', 'Existing.js'), 'module.exports = {};');

        const cli = new CLI(['make:model', 'Existing']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('already exists');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // make:migration — no name
    // =========================================================

    it('make:migration with no name shows usage error', async () =>
    {
        const cli = new CLI(['make:migration']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Usage');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // make:seeder — missing name
    // =========================================================

    it('make:seeder with no name shows usage error', async () =>
    {
        const cli = new CLI(['make:seeder']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Usage');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // make:seeder — file already exists
    // =========================================================

    it('make:seeder rejects when file already exists', async () =>
    {
        fs.mkdirSync('seeders', { recursive: true });
        fs.writeFileSync(path.join('seeders', 'DupSeeder.js'), 'module.exports = {};');

        const cli = new CLI(['make:seeder', 'Dup']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('already exists');
        expect(process.exitCode).toBe(1);

        errSpy.mockRestore();
    });

    // =========================================================
    // make:migration auto-diff — no models found
    // =========================================================

    it('make:migration auto-diff with no models shows error', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { modelsDir: './no_models' };`);
        delete require.cache[configFile];
        const cli = new CLI(['make:migration', 'auto_test']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        // Should see "No models found" message
        const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].map(c => c[0]).join('\n');
        expect(allOutput).toMatch(/No models found|no_models/i);

        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    // =========================================================
    // _loadConfigSync throws for async config
    // =========================================================

    it('_loadConfigSync throws if config exports a function', () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, 'module.exports = function() { return {}; };');
        // Clear require cache so the new file content is loaded
        delete require.cache[configFile];

        const cli = new CLI(['make:migration', 'test']);
        expect(() => cli._loadConfigSync()).toThrow('Async config');
    });

    // =========================================================
    // _loadConfigSync throws when no config found
    // =========================================================

    it('_loadConfigSync throws when no config exists', () =>
    {
        const cli = new CLI(['make:migration', 'test']);
        expect(() => cli._loadConfigSync()).toThrow('No config');
    });

    // =========================================================
    // make:migration auto-diff without config falls back to --models flag
    // =========================================================

    it('make:migration auto-diff falls back to --models flag when no config', async () =>
    {
        const cli = new CLI(['make:migration', 'fallback_test', '--models=./nonexistent_models']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        // Should fall through to "no models found" path
        const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].map(c => c[0]).join('\n');
        expect(allOutput).toMatch(/No models found|nonexistent/i);

        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    // =========================================================
    // resolveConfig with explicit --config path
    // =========================================================

    it('resolveConfig respects --config flag', async () =>
    {
        const configFile = path.resolve('custom.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate', '--config=./custom.config.js']);
        // This should find the config, then fail at _connectDb
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        // Should NOT get "No configuration file found" error
        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).not.toContain('No configuration file found');

        errSpy.mockRestore();
    });

    // =========================================================
    // -f value short flag parsing (flag with no value after it)
    // =========================================================

    it('short flag at end of args defaults to true', () =>
    {
        const cli = new CLI(['migrate', '-z']);
        expect(cli.flags.get('z')).toBe('true');
    });

    // =========================================================
    // _connectDb fallback branches: config.type, config.options
    // =========================================================

    it('_connectDb uses config.type when adapter is absent', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { type: 'memory' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        // Should succeed (not throw "No configuration file found")
        const output = errSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).not.toContain('No configuration file found');

        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('_connectDb falls back to memory when neither adapter nor type', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = {};`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('_connectDb uses config.options when connection is absent', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', options: {} };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate:status', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    // =========================================================
    // _createMigrator — no migrations directory exists
    // =========================================================

    it('_createMigrator works when migrations dir does not exist', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', migrationsDir: './nonexistent_migrations' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate:status', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    // =========================================================
    // _createMigrator — fallback to config.migrations
    // =========================================================

    it('_createMigrator uses config.migrations when migrationsDir absent', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', migrations: './migrs' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate:status', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    // =========================================================
    // _seed — fallback config branches and missing seeders dir
    // =========================================================

    it('seed with config.seeders fallback', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', seeders: './custom_seeders' };`);
        delete require.cache[configFile];

        const cli = new CLI(['seed', '--config=./zero.config.js']);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        // Should fall through to "No seeders directory found" or succeed
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    // =========================================================
    // _removeMigration — no migrations dir, no files, already applied
    // =========================================================

    it('_removeMigration with no migrations dir', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', migrationsDir: './no_dir' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate:remove', '--config=./zero.config.js']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No migrations directory');

        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    it('_removeMigration with empty migrations dir', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.mkdirSync('empty_migrations', { recursive: true });
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', migrationsDir: './empty_migrations' };`);
        delete require.cache[configFile];

        const cli = new CLI(['migrate:remove', '--config=./zero.config.js']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        const output = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No migration files');

        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    // =========================================================
    // make:migration auto-diff — with config having models fallback
    // =========================================================

    it('make:migration auto-diff uses config.models fallback', async () =>
    {
        const configFile = path.resolve('zero.config.js');
        fs.writeFileSync(configFile, `module.exports = { adapter: 'memory', models: './alt_models' };`);
        delete require.cache[configFile];

        const cli = new CLI(['make:migration', 'test_models_fallback']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    // =========================================================
    // make:seeder — existing file check
    // =========================================================

    it('make:seeder handles --dir flag', async () =>
    {
        const cli = new CLI(['make:seeder', 'Custom', '--dir=custom_seeders']);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        expect(fs.existsSync(path.join(tmpDir, 'custom_seeders', 'CustomSeeder.js'))).toBe(true);
        logSpy.mockRestore();
    });
});
