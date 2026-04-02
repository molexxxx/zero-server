#!/usr/bin/env node

/**
 * @module cli
 * @description CLI tool for zero-http ORM operations.
 *              Provides commands for migrations, seeding, and scaffolding.
 *
 *              Requires a `zero.config.js` (or `.zero-http.js`) in your project root
 *              that exports your database adapter and connection settings.
 *
 * @example
 *   // zero.config.js — required by all CLI commands except make:* and help
 *   module.exports = {
 *       adapter: 'sqlite',
 *       connection: { filename: './app.db' },
 *       migrationsDir: './migrations',
 *       seedersDir: './seeders',
 *   };
 *
 *   // Run via npx (no global install needed):
 *   // npx zh migrate
 *   // npx zh migrate:rollback
 *   // npx zh migrate:status
 *   // npx zh seed
 *   // npx zh make:model User
 *   // npx zh make:migration create_posts
 *   // npx zh make:seeder Users
 *
 *   // Or programmatically:
 *   const { runCLI } = require('zero-http');
 *   await runCLI(['migrate']);
 *   await runCLI(['make:model', 'User', '--dir=src/models']);
 */

'use strict';

const fs = require('fs');
const path = require('path');

// -- Helpers -------------------------------------------------

/**
 * @private
 * Print coloured text (ANSI escape codes).
 */
function color(text, code) { return `\x1b[${code}m${text}\x1b[0m`; }
const green  = (t) => color(t, '32');
const red    = (t) => color(t, '31');
const yellow = (t) => color(t, '33');
const cyan   = (t) => color(t, '36');
const bold   = (t) => color(t, '1');
const dim    = (t) => color(t, '2');

/**
 * @private
 * Timestamp for file names.
 */
function timestamp()
{
    const d = new Date();
    return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * @private
 * Convert a name to PascalCase.
 */
function pascalCase(str)
{
    return str.replace(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase())
              .replace(/[_-]/g, '');
}

/**
 * @private
 * Convert a name to snake_case.
 */
function snakeCase(str)
{
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

/**
 * @private
 * Resolve a config file path relative to CWD.
 */
function resolveConfig(configPath)
{
    const cwd = process.cwd();
    const candidates = [
        configPath,
        path.join(cwd, 'zero.config.js'),
        path.join(cwd, 'zero.config.mjs'),
        path.join(cwd, '.zero-http.js'),
    ].filter(Boolean);

    for (const p of candidates)
    {
        const resolved = path.resolve(p);
        if (fs.existsSync(resolved)) return resolved;
    }
    return null;
}

// -- CLI Class -----------------------------------------------

/**
 * CLI runner for zero-http ORM commands.
 * Parses arguments and dispatches to command handlers.
 */
class CLI
{
    /**
     * @constructor
     * @param {string[]} argv - Process arguments (process.argv.slice(2)).
     */
    constructor(argv = [])
    {
        /** @type {string} */
        this.command = argv[0] || 'help';

        /** @type {string[]} */
        this.args = argv.slice(1);

        /** @type {Map<string, string>} */
        this.flags = new Map();

        // Parse flags
        for (let i = 0; i < this.args.length; i++)
        {
            const arg = this.args[i];
            if (arg.startsWith('--'))
            {
                const [key, val] = arg.slice(2).split('=');
                this.flags.set(key, val || 'true');
            }
            else if (arg.startsWith('-'))
            {
                this.flags.set(arg.slice(1), this.args[i + 1] || 'true');
                i++;
            }
        }
    }

    /**
     * Run the CLI command.
     *
     * @returns {Promise<void>}
     */
    async run()
    {
        const commands = {
            'migrate':           () => this._migrate(),
            'migrate:rollback':  () => this._rollback(),
            'migrate:status':    () => this._status(),
            'migrate:reset':     () => this._reset(),
            'migrate:fresh':     () => this._fresh(),
            'migrate:remove':    () => this._removeMigration(),
            'seed':              () => this._seed(),
            'make:model':        () => this._makeModel(),
            'make:migration':    () => this._makeMigration(),
            'make:seeder':       () => this._makeSeeder(),
            'help':              () => this._help(),
            '--help':            () => this._help(),
            '-h':                () => this._help(),
            'version':           () => this._version(),
            '--version':         () => this._version(),
            '-v':                () => this._version(),
        };

        const handler = commands[this.command];
        if (!handler)
        {
            console.error(red(`Unknown command: "${this.command}"`));
            this._help();
            process.exitCode = 1;
            return;
        }

        try
        {
            await handler();
        }
        catch (err)
        {
            console.error(red(`Error: ${err.message}`));
            if (this.flags.has('verbose')) console.error(err.stack);
            process.exitCode = 1;
        }
    }

    // -- Config Loading ----------------------------------

    /**
     * @private
     * Load the database configuration from the project.
     */
    async _loadConfig()
    {
        const configPath = this.flags.get('config') || null;
        const resolved = resolveConfig(configPath);

        if (!resolved)
        {
            throw new Error(
                'No configuration file found.\n' +
                'Create a zero.config.js with database and migration settings.\n' +
                'See "zh help" for examples.'
            );
        }

        const config = require(resolved);
        return typeof config === 'function' ? await config() : config;
    }

    /**
     * @private
     * Connect to the database using config.
     */
    async _connectDb(config)
    {
        const { Database } = require('./orm');
        return Database.connect(config.adapter || config.type || 'memory', config.connection || config.options || {});
    }

    /**
     * @private
     * Create the Migrator from config.
     */
    async _createMigrator(config)
    {
        const db = await this._connectDb(config);
        const { Migrator } = require('./orm');
        const migrator = new Migrator(db, { table: config.migrationsTable || '_migrations' });

        // Load migrations from directory
        const migrationsDir = path.resolve(config.migrationsDir || config.migrations || 'migrations');
        if (fs.existsSync(migrationsDir))
        {
            const files = fs.readdirSync(migrationsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            for (const file of files)
            {
                const migration = require(path.join(migrationsDir, file));
                if (migration.name && migration.up)
                {
                    migrator.add(migration);
                }
            }
        }

        return { db, migrator };
    }

    // -- Migration Commands ------------------------------

    /**
     * @private
     */
    async _migrate()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        console.log(cyan('Running migrations...'));
        const result = await migrator.migrate();

        if (result.migrated.length === 0)
        {
            console.log(dim('Nothing to migrate.'));
        }
        else
        {
            for (const name of result.migrated)
            {
                console.log(green(`  ✓ ${name}`));
            }
            console.log(bold(`\n${result.migrated.length} migration(s) completed (batch ${result.batch}).`));
        }

        await db.close();
    }

    /**
     * @private
     */
    async _rollback()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        console.log(cyan('Rolling back...'));
        const result = await migrator.rollback();

        if (result.rolledBack.length === 0)
        {
            console.log(dim('Nothing to rollback.'));
        }
        else
        {
            for (const name of result.rolledBack)
            {
                console.log(yellow(`  ↺ ${name}`));
            }
            console.log(bold(`\n${result.rolledBack.length} migration(s) rolled back.`));
        }

        await db.close();
    }

    /**
     * @private
     */
    async _status()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        const status = await migrator.status();

        console.log(bold('\nMigration Status'));
        console.log('─'.repeat(50));

        if (status.executed.length > 0)
        {
            console.log(green('\nExecuted:'));
            for (const name of status.executed)
            {
                console.log(green(`  ✓ ${name}`));
            }
        }

        if (status.pending.length > 0)
        {
            console.log(yellow('\nPending:'));
            for (const name of status.pending)
            {
                console.log(yellow(`  ○ ${name}`));
            }
        }

        if (status.executed.length === 0 && status.pending.length === 0)
        {
            console.log(dim('  No migrations registered.'));
        }

        console.log(`\nLast batch: ${status.lastBatch || 'none'}`);

        await db.close();
    }

    /**
     * @private
     */
    async _reset()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        console.log(cyan('Resetting database (rollback all + re-migrate)...'));
        await migrator.reset();
        console.log(green('Database reset complete.'));

        await db.close();
    }

    /**
     * @private
     */
    async _fresh()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        console.log(yellow('⚠ Fresh migration: dropping all tables and re-migrating...'));
        await migrator.fresh();
        console.log(green('Fresh migration complete.'));

        await db.close();
    }

    /**
     * @private
     * Remove the last unapplied migration file and revert the schema snapshot
     * (like EF Core's `remove-migration`).
     */
    async _removeMigration()
    {
        const config = await this._loadConfig();
        const { db, migrator } = await this._createMigrator(config);

        const migrationsDir = path.resolve(config.migrationsDir || config.migrations || 'migrations');

        if (!fs.existsSync(migrationsDir))
        {
            console.log(dim('No migrations directory found.'));
            await db.close();
            return;
        }

        // Find migration files sorted descending
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.js'))
            .sort()
            .reverse();

        if (files.length === 0)
        {
            console.log(dim('No migration files to remove.'));
            await db.close();
            return;
        }

        const lastFile = files[0];
        const lastMigration = require(path.join(migrationsDir, lastFile));

        // Check if it has already been applied
        const status = await migrator.status();
        if (status.executed.includes(lastMigration.name))
        {
            console.error(red(`Cannot remove "${lastMigration.name}" — it has already been applied.`));
            console.error(dim('Run "zh migrate:rollback" first, then try again.'));
            process.exitCode = 1;
            await db.close();
            return;
        }

        // Delete the file
        fs.unlinkSync(path.join(migrationsDir, lastFile));
        console.log(yellow(`Removed: ${lastFile}`));

        // Rebuild snapshot from remaining models (if models exist)
        const {
            buildSnapshot,
            saveSnapshot,
            discoverModels,
        } = require('./orm/snapshot');
        const { Model } = require('./orm');

        const modelsDir = path.resolve(config.modelsDir || config.models || 'models');
        const models = discoverModels(modelsDir, Model);

        if (models.length > 0)
        {
            // Re-read remaining migration files to reconstruct the snapshot
            // that existed before the removed migration was generated.
            // The cleanest approach: rebuild from models but revert to what
            // the second-to-last migration captured.
            // Since we can't replay old snapshots, we rebuild from current models.
            // The next make:migration will diff against this and detect
            // the changes that the removed migration was supposed to capture.
            const rebuilt = buildSnapshot(models);
            saveSnapshot(migrationsDir, rebuilt);
            console.log(dim('Schema snapshot updated.'));
        }

        console.log(green('Migration removed successfully.'));
        await db.close();
    }

    // -- Seed Commands -----------------------------------

    /**
     * @private
     */
    async _seed()
    {
        const config = await this._loadConfig();
        const db = await this._connectDb(config);
        const { SeederRunner } = require('./orm');

        const runner = new SeederRunner(db);
        const seedDir = path.resolve(config.seedersDir || config.seeders || 'seeders');

        if (!fs.existsSync(seedDir))
        {
            console.log(dim('No seeders directory found.'));
            await db.close();
            return;
        }

        const files = fs.readdirSync(seedDir)
            .filter(f => f.endsWith('.js'))
            .sort();

        const seeders = files.map(f => require(path.join(seedDir, f)));

        console.log(cyan('Running seeders...'));
        const result = await runner.run(...seeders);

        for (const name of result)
        {
            console.log(green(`  ✓ ${name}`));
        }
        console.log(bold(`\n${result.length} seeder(s) completed.`));

        await db.close();
    }

    // -- Scaffolding Commands ----------------------------

    /**
     * @private
     */
    _makeModel()
    {
        const name = this.args.find(a => !a.startsWith('-'));
        if (!name)
        {
            console.error(red('Usage: zh make:model <Name>'));
            process.exitCode = 1;
            return;
        }

        const className = pascalCase(name);
        const tableName = snakeCase(name) + 's';
        const dir = this.flags.get('dir') || 'models';
        const filePath = path.resolve(dir, `${className}.js`);

        if (fs.existsSync(filePath))
        {
            console.error(red(`File already exists: ${filePath}`));
            process.exitCode = 1;
            return;
        }

        const content =
`'use strict';

const { Model, TYPES } = require('zero-http');

class ${className} extends Model
{
    static table = '${tableName}';

    static schema = {
        id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        // Add your columns here
    };

    static timestamps = true;
}

module.exports = ${className};
`;

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(green(`Model created: ${filePath}`));
    }

    /**
     * @private
     * Generate a migration file.
     *
     * If `--empty` is passed, a blank template is generated (legacy behaviour).
     * Otherwise the CLI discovers Model classes from `modelsDir`, compares
     * them against the stored schema snapshot and auto-generates migration
     * code that mirrors the detected changes (EF Core–style).
     */
    _makeMigration()
    {
        const name = this.args.find(a => !a.startsWith('-'));
        if (!name)
        {
            console.error(red('Usage: zh make:migration <name>'));
            process.exitCode = 1;
            return;
        }

        const ts   = timestamp();
        const slug = snakeCase(name);
        const migrationName = `${ts}_${slug}`;
        const dir  = this.flags.get('dir') || 'migrations';
        const migrationsDir = path.resolve(dir);

        // --empty : legacy blank-template mode
        if (this.flags.has('empty'))
        {
            const filePath = path.resolve(migrationsDir, `${migrationName}.js`);
            const content =
`'use strict';

module.exports = {
    name: '${migrationName}',

    async up(db) {
        // Write your migration here
    },

    async down(db) {
        // Write your rollback here
    },
};
`;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(green(`Migration created: ${filePath}`));
            return;
        }

        // -- Auto-diff mode -----------------------------------
        const {
            buildSnapshot,
            loadSnapshot,
            saveSnapshot,
            diffSnapshots,
            hasNoChanges,
            generateMigrationCode,
            discoverModels,
        } = require('./orm/snapshot');

        const { Model } = require('./orm');

        // Resolve models directory
        let modelsDir;
        try
        {
            const config = this._loadConfigSync();
            modelsDir = path.resolve(config.modelsDir || config.models || 'models');
        }
        catch (_)
        {
            modelsDir = path.resolve(this.flags.get('models') || 'models');
        }

        // Discover model classes
        const models = discoverModels(modelsDir, Model);

        if (models.length === 0)
        {
            console.log(yellow(`No models found in ${modelsDir}`));
            console.log(dim('Use --empty to create a blank migration, or check your modelsDir config.'));
            process.exitCode = 1;
            return;
        }

        // Build current & previous snapshots, diff
        const current  = buildSnapshot(models);
        const previous = loadSnapshot(migrationsDir);
        const changes  = diffSnapshots(previous, current);

        if (hasNoChanges(changes))
        {
            console.log(dim('No schema changes detected — nothing to migrate.'));
            return;
        }

        // Summarise detected changes
        console.log(cyan('Detected schema changes:'));
        for (const t of changes.tables.created)  console.log(green(`  + Table ${t}`));
        for (const t of changes.tables.dropped)  console.log(red(`  - Table ${t}`));
        for (const c of changes.columns.added)   console.log(green(`  + ${c.table}.${c.column}`));
        for (const c of changes.columns.dropped) console.log(red(`  - ${c.table}.${c.column}`));
        for (const c of changes.columns.altered)  console.log(yellow(`  ~ ${c.table}.${c.column}`));

        // Generate & write migration file
        const code     = generateMigrationCode(migrationName, changes, current);
        const filePath = path.resolve(migrationsDir, `${migrationName}.js`);

        fs.mkdirSync(migrationsDir, { recursive: true });
        fs.writeFileSync(filePath, code, 'utf8');

        // Update snapshot
        saveSnapshot(migrationsDir, current);

        console.log(green(`\nMigration created: ${filePath}`));
    }

    /**
     * @private
     * Synchronous config loader (for make commands that don't need async db).
     */
    _loadConfigSync()
    {
        const configPath = this.flags.get('config') || null;
        const resolved = resolveConfig(configPath);
        if (!resolved) throw new Error('No config');
        const config = require(resolved);
        if (typeof config === 'function') throw new Error('Async config not supported here');
        return config;
    }

    /**
     * @private
     */
    _makeSeeder()
    {
        const name = this.args.find(a => !a.startsWith('-'));
        if (!name)
        {
            console.error(red('Usage: zh make:seeder <name>'));
            process.exitCode = 1;
            return;
        }

        const className = pascalCase(name) + 'Seeder';
        const dir = this.flags.get('dir') || 'seeders';
        const filePath = path.resolve(dir, `${className}.js`);

        if (fs.existsSync(filePath))
        {
            console.error(red(`File already exists: ${filePath}`));
            process.exitCode = 1;
            return;
        }

        const content =
`'use strict';

const { Seeder } = require('zero-http');

class ${className} extends Seeder
{
    async run(db) {
        // Write your seeder here
        // Example:
        // const User = db.model('users');
        // await User.createMany([
        //     { name: 'Alice', email: 'alice@example.com' },
        //     { name: 'Bob',   email: 'bob@example.com' },
        // ]);
    }
}

module.exports = ${className};
`;

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(green(`Seeder created: ${filePath}`));
    }

    // -- Help & Version ----------------------------------

    /**
     * @private
     */
    _help()
    {
        console.log(`
${bold('zh CLI')} — zero-http ORM tooling

${bold('Usage:')}  npx zh <command> [options]

${bold('Commands:')}

  ${cyan('migrate')}              Run pending migrations
  ${cyan('migrate:rollback')}     Rollback the last migration batch
  ${cyan('migrate:status')}       Show migration status
  ${cyan('migrate:reset')}        Rollback all + re-migrate
  ${cyan('migrate:fresh')}        Drop all tables + re-migrate
  ${cyan('migrate:remove')}       Remove the last unapplied migration

  ${cyan('seed')}                 Run all seeders

  ${cyan('make:model')} <name>    Scaffold a new Model file
  ${cyan('make:migration')} <n>   Auto-generate migration from model changes
  ${cyan('make:seeder')} <name>   Scaffold a new seeder file

  ${cyan('help')}                 Show this help message
  ${cyan('version')}              Show version

${bold('Options:')}

  --config=<path>        Path to config file (default: zero.config.js)
  --dir=<path>           Output directory for make commands
  --models=<path>        Models directory (default: modelsDir from config or 'models')
  --empty                Generate a blank migration template (skip auto-diff)
  --verbose              Show full error stack traces

${bold('Config file:')} ${dim('zero.config.js (or .zero-http.js)')}

  All commands except ${cyan('make:*')} and ${cyan('help')} require a config file
  in your project root. Create ${bold('zero.config.js')} with:

  ${dim('// zero.config.js')}
  module.exports = {
      adapter: 'sqlite',                       ${dim('// memory | json | sqlite | mysql | postgres | mongo | redis')}
      connection: { filename: './app.db' },     ${dim('// adapter-specific options')}
      migrationsDir: './migrations',            ${dim('// where migration files live')}
      seedersDir: './seeders',                  ${dim('// where seeder files live')}
      modelsDir: './models',                    ${dim('// where Model classes live (auto-diff)')}
  };

${bold('Auto-generated migrations:')}

  ${dim('$')} npx zh make:migration create_users  ${dim('# detects new User model → generates CREATE TABLE')}
  ${dim('$')} npx zh make:migration add_email     ${dim('# detects new email column → generates ADD COLUMN')}
  ${dim('$')} npx zh make:migration --empty init   ${dim('# blank migration (manual mode)')}
  ${dim('$')} npx zh migrate                      ${dim('# apply pending migrations')}
  ${dim('$')} npx zh migrate:remove               ${dim('# undo last make:migration')}

${bold('Examples:')}

  ${dim('$')} npx zh make:model User             ${dim('# creates models/User.js')}
  ${dim('$')} npx zh make:migration create_users  ${dim('# auto-generates from models')}
  ${dim('$')} npx zh migrate                     ${dim('# runs all pending migrations')}
  ${dim('$')} npx zh migrate --config=db.config.js
  ${dim('$')} npx zh seed                        ${dim('# runs all seeders')}
`);
    }

    /**
     * @private
     */
    _version()
    {
        const pkg = require('../package.json');
        console.log(`zh v${pkg.version} (zero-http)`);
    }
}

// -- Entry point ---------------------------------------------

/**
 * Create and run the CLI.
 *
 * @param {string[]} [argv] - Arguments (defaults to process.argv.slice(2)).
 * @returns {Promise<void>}
 *
 * @example
 *   const { runCLI } = require('zero-http');
 *   await runCLI(['migrate', '--config=./myconfig.js']);
 */
async function runCLI(argv)
{
    const cli = new CLI(argv || process.argv.slice(2));
    await cli.run();
}

module.exports = { CLI, runCLI };

// Run directly if executed as script
if (require.main === module)
{
    runCLI().catch(err =>
    {
        console.error(err);
        process.exitCode = 1;
    });
}
