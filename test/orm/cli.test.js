/**
 * Phase 4 — CLI tests
 */
const fs = require('fs');
const path = require('path');
const { CLI } = require('../../lib/cli');

// ===================================================================
// Constructor / argument parsing
// ===================================================================
describe('CLI — constructor', () =>
{
    it('defaults to help', () =>
    {
        const cli = new CLI([]);
        expect(cli.command).toBe('help');
        expect(cli.args).toEqual([]);
    });

    it('parses command', () =>
    {
        const cli = new CLI(['migrate']);
        expect(cli.command).toBe('migrate');
    });

    it('parses positional args', () =>
    {
        const cli = new CLI(['make:model', 'User']);
        expect(cli.command).toBe('make:model');
        expect(cli.args).toEqual(['User']);
    });

    it('parses --flag=value', () =>
    {
        const cli = new CLI(['migrate', '--config=custom.js']);
        expect(cli.flags.get('config')).toBe('custom.js');
    });

    it('parses --flag (boolean)', () =>
    {
        const cli = new CLI(['migrate', '--verbose']);
        expect(cli.flags.get('verbose')).toBe('true');
    });

    it('parses -f value', () =>
    {
        const cli = new CLI(['migrate', '-c', 'custom.js']);
        expect(cli.flags.get('c')).toBe('custom.js');
    });
});

// ===================================================================
// Help / version (no side effects)
// ===================================================================
describe('CLI — help / version', () =>
{
    it('help prints usage', () =>
    {
        const cli = new CLI(['help']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._help();
        expect(log).toHaveBeenCalled();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        expect(output).toContain('migrate');
        expect(output).toContain('make:model');
        log.mockRestore();
    });

    it('version prints package version', () =>
    {
        const cli = new CLI(['version']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._version();
        const output = log.mock.calls[0][0];
        expect(output).toMatch(/zh v\d+\.\d+\.\d+ \(zero-http\)/);
        log.mockRestore();
    });
});

// ===================================================================
// make:model
// ===================================================================
describe('CLI — make:model', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_model__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir))
        {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('scaffolds a model file', () =>
    {
        const cli = new CLI(['make:model', 'User', `--dir=${tmpDir}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeModel();

        const filePath = path.join(tmpDir, 'User.js');
        expect(fs.existsSync(filePath)).toBe(true);

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('class User extends Model');
        expect(content).toContain("static table = 'users'");
        expect(content).toContain('TYPES.INTEGER');
        log.mockRestore();
    });

    it('refuses if file already exists', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'User.js'), 'x', 'utf8');

        const cli = new CLI(['make:model', 'User', `--dir=${tmpDir}`]);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        cli._makeModel();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('already exists');
        err.mockRestore();
    });

    it('errors on missing name', () =>
    {
        const cli = new CLI(['make:model']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        cli._makeModel();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('Usage');
        err.mockRestore();
    });
});

// ===================================================================
// make:migration
// ===================================================================
describe('CLI — make:migration', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_migration__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir))
        {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('scaffolds a blank migration with --empty', () =>
    {
        const migDir = path.join(tmpDir, 'mig');
        const cli = new CLI(['make:migration', 'create_posts', `--dir=${migDir}`, '--empty']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();

        const files = fs.readdirSync(migDir);
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/^\d{14}_create_posts\.js$/);

        const content = fs.readFileSync(path.join(migDir, files[0]), 'utf8');
        expect(content).toContain("name: '");
        expect(content).toContain('async up(db)');
        expect(content).toContain('async down(db)');
        log.mockRestore();
    });

    it('errors on missing name', () =>
    {
        const cli = new CLI(['make:migration']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        cli._makeMigration();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('Usage');
        err.mockRestore();
    });

    it('shows error when no models found (auto-diff mode)', () =>
    {
        const migDir = path.join(tmpDir, 'mig');
        const cli = new CLI(['make:migration', 'init', `--dir=${migDir}`, `--models=${path.join(tmpDir, 'no_models')}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No models found');
        log.mockRestore();
    });
});

// ===================================================================
// make:seeder
// ===================================================================
describe('CLI — make:seeder', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_seeder__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir))
        {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('scaffolds a seeder file', () =>
    {
        const cli = new CLI(['make:seeder', 'User', `--dir=${tmpDir}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeSeeder();

        const filePath = path.join(tmpDir, 'UserSeeder.js');
        expect(fs.existsSync(filePath)).toBe(true);

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('class UserSeeder extends Seeder');
        expect(content).toContain('async run(db)');
        log.mockRestore();
    });

    it('refuses if file already exists', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'UserSeeder.js'), 'x', 'utf8');

        const cli = new CLI(['make:seeder', 'User', `--dir=${tmpDir}`]);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        cli._makeSeeder();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('already exists');
        err.mockRestore();
    });

    it('errors on missing name', () =>
    {
        const cli = new CLI(['make:seeder']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        cli._makeSeeder();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('Usage');
        err.mockRestore();
    });
});

// ===================================================================
// run() — unknown command
// ===================================================================
describe('CLI — run unknown command', () =>
{
    it('sets exitCode for unknown command', async () =>
    {
        const cli = new CLI(['nonexistent']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const origExitCode = process.exitCode;
        await cli.run();

        expect(err).toHaveBeenCalled();
        expect(err.mock.calls[0][0]).toContain('Unknown command');
        process.exitCode = origExitCode;
        err.mockRestore();
        log.mockRestore();
    });
});

// ===================================================================
// Config loading edge cases
// ===================================================================
describe('CLI — config loading', () =>
{
    it('_loadConfig throws when no config file found', async () =>
    {
        const cli = new CLI(['migrate', '--config=/nonexistent/path.js']);
        await expect(cli._loadConfig()).rejects.toThrow('No configuration file found');
    });

    it('_loadConfig resolves function config', async () =>
    {
        const tmpDir = path.join(__dirname, '__tmp_cli_config__');
        fs.mkdirSync(tmpDir, { recursive: true });
        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = function() { return { adapter: 'memory' }; };`, 'utf8');

        const cli = new CLI(['migrate', `--config=${cfgPath}`]);
        const config = await cli._loadConfig();
        expect(config.adapter).toBe('memory');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ===================================================================
// run() dispatching aliases
// ===================================================================
describe('CLI — run() dispatching', () =>
{
    it('dispatches --help to _help', async () =>
    {
        const cli = new CLI(['--help']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        log.mockRestore();
    });

    it('dispatches -h to _help', async () =>
    {
        const cli = new CLI(['-h']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        log.mockRestore();
    });

    it('dispatches --version to _version', async () =>
    {
        const cli = new CLI(['--version']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        expect(log.mock.calls[0][0]).toMatch(/zh v\d+\.\d+\.\d+/);
        log.mockRestore();
    });

    it('dispatches -v to _version', async () =>
    {
        const cli = new CLI(['-v']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        expect(log.mock.calls[0][0]).toMatch(/zh v\d+\.\d+\.\d+/);
        log.mockRestore();
    });

    it('catches handler errors and sets exitCode', async () =>
    {
        const cli = new CLI(['migrate', '--config=/nonexistent/__no_config.js']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const origExitCode = process.exitCode;
        await cli.run();
        expect(process.exitCode).toBe(1);
        expect(err).toHaveBeenCalled();
        process.exitCode = origExitCode;
        err.mockRestore();
    });

    it('prints stack trace with --verbose flag', async () =>
    {
        const cli = new CLI(['migrate', '--config=/nonexistent/__no_config.js', '--verbose']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const origExitCode = process.exitCode;
        await cli.run();
        // Should have multiple console.error calls: message + stack
        expect(err.mock.calls.length).toBeGreaterThanOrEqual(2);
        process.exitCode = origExitCode;
        err.mockRestore();
    });
});

// ===================================================================
// Migration commands (with mocked DB)
// ===================================================================
describe('CLI — migration commands', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_mig_cmds__');
    let cfgPath;

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory' };`, 'utf8');
    });

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('_migrate with nothing to migrate', async () =>
    {
        const cli = new CLI(['migrate', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Nothing to migrate');
        log.mockRestore();
    });

    it('_rollback with nothing to rollback', async () =>
    {
        const cli = new CLI(['migrate:rollback', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Nothing to rollback');
        log.mockRestore();
    });

    it('_status with no migrations', async () =>
    {
        const cli = new CLI(['migrate:status', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Migration Status');
        expect(output).toContain('No migrations registered');
        log.mockRestore();
    });

    it('_reset runs without error', async () =>
    {
        const cli = new CLI(['migrate:reset', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('reset');
        log.mockRestore();
    });

    it('_fresh runs without error', async () =>
    {
        const cli = new CLI(['migrate:fresh', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Fresh migration');
        log.mockRestore();
    });
});

// ===================================================================
// Migrate with actual migration files
// ===================================================================
describe('CLI — migrate with files', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_mig_files__');
    let cfgPath;

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const migDir = path.join(tmpDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });

        // Write a simple migration
        fs.writeFileSync(path.join(migDir, '20250101000000_init.js'),
            `module.exports = {
                name: '20250101000000_init',
                async up(db) { await db.adapter.execute({ raw: 'CREATE TABLE IF NOT EXISTS _test (id INTEGER PRIMARY KEY)' }); },
                async down(db) { await db.adapter.execute({ raw: 'DROP TABLE IF EXISTS _test' }); },
            };`, 'utf8');

        cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${migDir.replace(/\\/g, '\\\\')}' };`, 'utf8');
    });

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('_migrate runs pending migrations', async () =>
    {
        const cli = new CLI(['migrate', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('20250101000000_init');
        expect(output).toContain('migration(s) completed');
        log.mockRestore();
    });
});

// ===================================================================
// Seed command
// ===================================================================
describe('CLI — seed command', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_seed__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('_seed with no seeders directory', async () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', seedersDir: '${path.join(tmpDir, 'seeders').replace(/\\/g, '\\\\')}' };`, 'utf8');

        const cli = new CLI(['seed', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No seeders directory');
        log.mockRestore();
    });

    it('_seed runs seeder files', async () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const seedDir = path.join(tmpDir, 'seeders');
        fs.mkdirSync(seedDir, { recursive: true });

        // Write a minimal seeder
        fs.writeFileSync(path.join(seedDir, 'TestSeeder.js'),
            `module.exports = { name: 'TestSeeder', async run() {} };`, 'utf8');

        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', seedersDir: '${seedDir.replace(/\\/g, '\\\\')}' };`, 'utf8');

        const cli = new CLI(['seed', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('seeder(s) completed');
        log.mockRestore();
    });
});

// ===================================================================
// Scaffolding defaults
// ===================================================================
describe('CLI — scaffolding with default dir', () =>
{
    const origCwd = process.cwd();
    const tmpDir = path.join(__dirname, '__tmp_cli_scaffold__');

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        process.chdir(tmpDir);
    });

    afterEach(() =>
    {
        process.chdir(origCwd);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('make:model uses default "models" dir', () =>
    {
        const cli = new CLI(['make:model', 'Post']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeModel();
        const filePath = path.join(tmpDir, 'models', 'Post.js');
        expect(fs.existsSync(filePath)).toBe(true);
        log.mockRestore();
    });

    it('make:migration uses default "migrations" dir', () =>
    {
        const cli = new CLI(['make:migration', 'add_posts', '--empty']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();
        const files = fs.readdirSync(path.join(tmpDir, 'migrations'));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/^\d{14}_add_posts\.js$/);
        log.mockRestore();
    });

    it('make:seeder uses default "seeders" dir', () =>
    {
        const cli = new CLI(['make:seeder', 'Post']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeSeeder();
        const filePath = path.join(tmpDir, 'seeders', 'PostSeeder.js');
        expect(fs.existsSync(filePath)).toBe(true);
        log.mockRestore();
    });
});

// ===================================================================
// Short flag with no following arg
// ===================================================================
describe('CLI — flag edge cases', () =>
{
    it('-f with no following value defaults to true', () =>
    {
        const cli = new CLI(['migrate', '-v']);
        expect(cli.flags.get('v')).toBe('true');
    });
});

// ===================================================================
// runCLI entry point
// ===================================================================
describe('CLI — runCLI', () =>
{
    it('runCLI runs help', async () =>
    {
        const { runCLI } = require('../../lib/cli');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await runCLI(['help']);
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        log.mockRestore();
    });

    it('runCLI defaults to process.argv if no args', async () =>
    {
        const { runCLI } = require('../../lib/cli');
        const origArgv = process.argv;
        process.argv = ['node', 'zh', 'help'];
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await runCLI();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('zh CLI');
        process.argv = origArgv;
        log.mockRestore();
    });
});

// ===================================================================
// Dispatch arrows via run() — covers command map arrow functions
// ===================================================================
describe('CLI — dispatch arrows via run()', () =>
{
    const origCwd = process.cwd();
    const tmpDir = path.join(__dirname, '__tmp_cli_dispatch__');

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        process.chdir(tmpDir);
    });

    afterEach(() =>
    {
        process.chdir(origCwd);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('run() dispatches make:model', async () =>
    {
        const cli = new CLI(['make:model', 'Dispatch']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        expect(fs.existsSync(path.join(tmpDir, 'models', 'Dispatch.js'))).toBe(true);
        log.mockRestore();
    });

    it('run() dispatches make:migration', async () =>
    {
        const cli = new CLI(['make:migration', 'test_dispatch', '--empty']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const files = fs.readdirSync(path.join(tmpDir, 'migrations'));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/test_dispatch/);
        log.mockRestore();
    });

    it('run() dispatches make:seeder', async () =>
    {
        const cli = new CLI(['make:seeder', 'Dispatch']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        expect(fs.existsSync(path.join(tmpDir, 'seeders', 'DispatchSeeder.js'))).toBe(true);
        log.mockRestore();
    });

    it('run() dispatches version', async () =>
    {
        const cli = new CLI(['version']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toMatch(/\d+\.\d+\.\d+/);
        log.mockRestore();
    });
});

// ===================================================================
// Rollback / status with actual migration data
// ===================================================================
describe('CLI — rollback/status with migrations', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_cli_rb__');
    let cfgPath;

    beforeEach(() =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const migDir = path.join(tmpDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });

        fs.writeFileSync(path.join(migDir, '20250101000000_rb.js'),
            `module.exports = {
                name: '20250101000000_rb',
                async up(db) { await db.adapter.execute({ raw: 'CREATE TABLE IF NOT EXISTS _rb_test (id INTEGER PRIMARY KEY)' }); },
                async down(db) { await db.adapter.execute({ raw: 'DROP TABLE IF EXISTS _rb_test' }); },
            };`, 'utf8');

        cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${migDir.replace(/\\/g, '\\\\')}' };`, 'utf8');
    });

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('_status shows executed and pending migrations', async () =>
    {
        const cli = new CLI(['migrate:status', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock _createMigrator to return a migrator with known status
        cli._createMigrator = async () => ({
            db: { close: async () => {} },
            migrator: {
                status: async () => ({
                    executed: ['20250101000000_rb'],
                    pending: ['20250102000000_add_col'],
                    lastBatch: 1,
                }),
            },
        });

        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Executed');
        expect(output).toContain('20250101000000_rb');
        expect(output).toContain('Pending');
        expect(output).toContain('20250102000000_add_col');
        log.mockRestore();
    });

    it('_rollback rolls back applied migrations', async () =>
    {
        const cli = new CLI(['migrate:rollback', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock _createMigrator to return a migrator that reports rolled back items
        cli._createMigrator = async () => ({
            db: { close: async () => {} },
            migrator: {
                rollback: async () => ({ rolledBack: ['20250101000000_rb'] }),
            },
        });

        await cli.run();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('↺');
        expect(output).toContain('migration(s) rolled back');
        log.mockRestore();
    });
});

// ===================================================================
// pascalCase regex callback coverage
// ===================================================================
describe('CLI — pascalCase regex callback', () =>
{
    it('converts underscore-delimited names via run() dispatch', async () =>
    {
        const origCwd = process.cwd();
        const tmpDir = path.join(__dirname, '__tmp_cli_pascal__');
        fs.mkdirSync(tmpDir, { recursive: true });
        process.chdir(tmpDir);

        const cli = new CLI(['make:model', 'user_profile']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();
        // pascalCase('user_profile') → 'UserProfile'
        expect(fs.existsSync(path.join(tmpDir, 'models', 'UserProfile.js'))).toBe(true);

        process.chdir(origCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        log.mockRestore();
    });
});
