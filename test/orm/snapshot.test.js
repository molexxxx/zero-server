/**
 * Tests for lib/orm/snapshot.js — schema snapshot & diff engine
 */
const fs   = require('fs');
const path = require('path');
const {
    buildSnapshot,
    loadSnapshot,
    saveSnapshot,
    diffSnapshots,
    hasNoChanges,
    generateMigrationCode,
    discoverModels,
    SNAPSHOT_FILE,
} = require('../../lib/orm/snapshot');
const { Model, TYPES } = require('../../lib/orm');

// ===================================================================
// buildSnapshot
// ===================================================================
describe('snapshot — buildSnapshot', () =>
{
    it('builds snapshot from Model classes', () =>
    {
        class User extends Model {
            static table = 'users';
            static schema = {
                id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                name:  { type: TYPES.STRING, required: true },
                email: { type: TYPES.STRING, unique: true },
            };
            static timestamps = true;
        }

        const snap = buildSnapshot([User]);
        expect(snap.users).toBeDefined();
        expect(snap.users.schema.id.type).toBe('integer');
        expect(snap.users.schema.name.required).toBe(true);
        expect(snap.users.timestamps).toBe(true);
    });

    it('includes timestamps columns via _fullSchema', () =>
    {
        class Task extends Model {
            static table = 'tasks';
            static schema = {
                id: { type: TYPES.INTEGER, primaryKey: true },
            };
            static timestamps = true;
        }

        const snap = buildSnapshot([Task]);
        expect(snap.tasks.schema.createdAt).toBeDefined();
        expect(snap.tasks.schema.updatedAt).toBeDefined();
    });

    it('includes softDelete column via _fullSchema', () =>
    {
        class Post extends Model {
            static table = 'posts';
            static schema = {
                id: { type: TYPES.INTEGER, primaryKey: true },
            };
            static softDelete = true;
        }

        const snap = buildSnapshot([Post]);
        expect(snap.posts.schema.deletedAt).toBeDefined();
        expect(snap.posts.softDelete).toBe(true);
    });

    it('skips models without table', () =>
    {
        class Bad extends Model {
            static schema = { id: { type: TYPES.INTEGER } };
        }

        const snap = buildSnapshot([Bad]);
        expect(Object.keys(snap).length).toBe(0);
    });

    it('normalises function defaults to null', () =>
    {
        class Item extends Model {
            static table = 'items';
            static schema = {
                id:   { type: TYPES.INTEGER, primaryKey: true },
                code: { type: TYPES.STRING, default: () => 'abc' },
            };
        }

        const snap = buildSnapshot([Item]);
        expect(snap.items.schema.code.default).toBeNull();
    });

    it('normalises RegExp to source string', () =>
    {
        class Item extends Model {
            static table = 'items';
            static schema = {
                id:   { type: TYPES.INTEGER, primaryKey: true },
                slug: { type: TYPES.STRING, match: /^[a-z-]+$/ },
            };
        }

        const snap = buildSnapshot([Item]);
        expect(snap.items.schema.slug.match).toBe('^[a-z-]+$');
    });

    it('handles multiple models', () =>
    {
        class A extends Model {
            static table = 'aaa';
            static schema = { id: { type: TYPES.INTEGER } };
        }
        class B extends Model {
            static table = 'bbb';
            static schema = { id: { type: TYPES.INTEGER } };
        }

        const snap = buildSnapshot([A, B]);
        expect(Object.keys(snap)).toEqual(['aaa', 'bbb']);
    });
});

// ===================================================================
// loadSnapshot / saveSnapshot
// ===================================================================
describe('snapshot — load / save', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_snap__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loadSnapshot returns {} when file missing', () =>
    {
        const snap = loadSnapshot('/nonexistent/dir');
        expect(snap).toEqual({});
    });

    it('saveSnapshot writes and loadSnapshot reads', () =>
    {
        const data = { users: { schema: { id: { type: 'INTEGER' } }, timestamps: true, softDelete: false } };
        saveSnapshot(tmpDir, data);

        expect(fs.existsSync(path.join(tmpDir, SNAPSHOT_FILE))).toBe(true);

        const loaded = loadSnapshot(tmpDir);
        expect(loaded).toEqual(data);
    });

    it('saveSnapshot creates directory if missing', () =>
    {
        const nested = path.join(tmpDir, 'a', 'b');
        saveSnapshot(nested, { x: 1 });
        expect(fs.existsSync(path.join(nested, SNAPSHOT_FILE))).toBe(true);
    });
});

// ===================================================================
// diffSnapshots
// ===================================================================
describe('snapshot — diffSnapshots', () =>
{
    it('detects new tables', () =>
    {
        const prev = {};
        const curr = {
            users: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const changes = diffSnapshots(prev, curr);
        expect(changes.tables.created).toEqual(['users']);
        expect(changes.tables.dropped).toEqual([]);
    });

    it('detects dropped tables', () =>
    {
        const prev = {
            users: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const curr = {};
        const changes = diffSnapshots(prev, curr);
        expect(changes.tables.dropped).toEqual(['users']);
        expect(changes.tables.created).toEqual([]);
    });

    it('detects added columns', () =>
    {
        const prev = {
            users: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const curr = {
            users: { schema: { id: { type: 'INTEGER' }, email: { type: 'STRING' } }, timestamps: false, softDelete: false },
        };
        const changes = diffSnapshots(prev, curr);
        expect(changes.columns.added).toEqual([{ table: 'users', column: 'email', def: { type: 'STRING' } }]);
    });

    it('detects dropped columns', () =>
    {
        const prev = {
            users: { schema: { id: { type: 'INTEGER' }, email: { type: 'STRING' } }, timestamps: false, softDelete: false },
        };
        const curr = {
            users: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const changes = diffSnapshots(prev, curr);
        expect(changes.columns.dropped).toEqual([{ table: 'users', column: 'email', def: { type: 'STRING' } }]);
    });

    it('detects altered columns', () =>
    {
        const prev = {
            users: { schema: { id: { type: 'INTEGER' }, name: { type: 'STRING', maxLength: 50 } }, timestamps: false, softDelete: false },
        };
        const curr = {
            users: { schema: { id: { type: 'INTEGER' }, name: { type: 'STRING', maxLength: 100 } }, timestamps: false, softDelete: false },
        };
        const changes = diffSnapshots(prev, curr);
        expect(changes.columns.altered.length).toBe(1);
        expect(changes.columns.altered[0].table).toBe('users');
        expect(changes.columns.altered[0].column).toBe('name');
        expect(changes.columns.altered[0].from.maxLength).toBe(50);
        expect(changes.columns.altered[0].to.maxLength).toBe(100);
    });

    it('returns empty when snapshots are identical', () =>
    {
        const snap = {
            users: { schema: { id: { type: 'INTEGER' } }, timestamps: true, softDelete: false },
        };
        const changes = diffSnapshots(snap, snap);
        expect(hasNoChanges(changes)).toBe(true);
    });

    it('handles combined create + add + drop + alter', () =>
    {
        const prev = {
            users: { schema: { id: { type: 'INTEGER' }, old_col: { type: 'TEXT' }, name: { type: 'STRING', maxLength: 50 } }, timestamps: false, softDelete: false },
            legacy: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const curr = {
            users: { schema: { id: { type: 'INTEGER' }, email: { type: 'STRING' }, name: { type: 'STRING', maxLength: 200 } }, timestamps: false, softDelete: false },
            posts: { schema: { id: { type: 'INTEGER' } }, timestamps: false, softDelete: false },
        };
        const changes = diffSnapshots(prev, curr);
        expect(changes.tables.created).toEqual(['posts']);
        expect(changes.tables.dropped).toEqual(['legacy']);
        expect(changes.columns.added.length).toBe(1);
        expect(changes.columns.added[0].column).toBe('email');
        expect(changes.columns.dropped.length).toBe(1);
        expect(changes.columns.dropped[0].column).toBe('old_col');
        expect(changes.columns.altered.length).toBe(1);
        expect(changes.columns.altered[0].column).toBe('name');
    });
});

// ===================================================================
// hasNoChanges
// ===================================================================
describe('snapshot — hasNoChanges', () =>
{
    it('returns true for empty changeset', () =>
    {
        expect(hasNoChanges({
            tables: { created: [], dropped: [] },
            columns: { added: [], dropped: [], altered: [] },
        })).toBe(true);
    });

    it('returns false if tables created', () =>
    {
        expect(hasNoChanges({
            tables: { created: ['x'], dropped: [] },
            columns: { added: [], dropped: [], altered: [] },
        })).toBe(false);
    });

    it('returns false if tables dropped', () =>
    {
        expect(hasNoChanges({
            tables: { created: [], dropped: ['x'] },
            columns: { added: [], dropped: [], altered: [] },
        })).toBe(false);
    });

    it('returns false if columns added', () =>
    {
        expect(hasNoChanges({
            tables: { created: [], dropped: [] },
            columns: { added: [{ table: 'x', column: 'y', def: {} }], dropped: [], altered: [] },
        })).toBe(false);
    });

    it('returns false if columns dropped', () =>
    {
        expect(hasNoChanges({
            tables: { created: [], dropped: [] },
            columns: { added: [], dropped: [{ table: 'x', column: 'y', def: {} }], altered: [] },
        })).toBe(false);
    });

    it('returns false if columns altered', () =>
    {
        expect(hasNoChanges({
            tables: { created: [], dropped: [] },
            columns: { added: [], dropped: [], altered: [{ table: 'x', column: 'y', from: {}, to: {} }] },
        })).toBe(false);
    });
});

// ===================================================================
// generateMigrationCode
// ===================================================================
describe('snapshot — generateMigrationCode', () =>
{
    it('generates createTable for new tables', () =>
    {
        const changes = {
            tables: { created: ['users'], dropped: [] },
            columns: { added: [], dropped: [], altered: [] },
        };
        const snap = {
            users: { schema: { id: { type: 'INTEGER', primaryKey: true }, name: { type: 'STRING' } }, timestamps: false, softDelete: false },
        };
        const code = generateMigrationCode('20250101_create_users', changes, snap);
        expect(code).toContain("createTable('users'");
        expect(code).toContain("dropTable('users')");
        expect(code).toContain("name: '20250101_create_users'");
        expect(code).toContain('async up(db)');
        expect(code).toContain('async down(db)');
    });

    it('generates dropTable for dropped tables', () =>
    {
        const changes = {
            tables: { created: [], dropped: ['legacy'] },
            columns: { added: [], dropped: [], altered: [] },
        };
        const code = generateMigrationCode('20250101_drop_legacy', changes, {});
        expect(code).toContain("dropTable('legacy')");
    });

    it('generates addColumn / dropColumn', () =>
    {
        const changes = {
            tables: { created: [], dropped: [] },
            columns: {
                added: [{ table: 'users', column: 'email', def: { type: 'STRING', unique: true } }],
                dropped: [{ table: 'users', column: 'old', def: { type: 'TEXT' } }],
                altered: [],
            },
        };
        const code = generateMigrationCode('20250101_modify_users', changes, {});
        expect(code).toContain("addColumn('users', 'email'");
        expect(code).toContain("dropColumn('users', 'old')");
    });

    it('generates altered column code', () =>
    {
        const changes = {
            tables: { created: [], dropped: [] },
            columns: {
                added: [],
                dropped: [],
                altered: [{
                    table: 'users',
                    column: 'name',
                    from: { type: 'STRING', maxLength: 50 },
                    to: { type: 'STRING', maxLength: 200 },
                }],
            },
        };
        const code = generateMigrationCode('20250101_alter', changes, {});
        // Altered columns are drop+add in the generated code
        expect(code).toContain("dropColumn('users', 'name')");
        expect(code).toContain("addColumn('users', 'name'");
        expect(code).toContain('maxLength: 200');
    });

    it('generates "No changes" comment when empty', () =>
    {
        const changes = {
            tables: { created: [], dropped: [] },
            columns: { added: [], dropped: [], altered: [] },
        };
        const code = generateMigrationCode('20250101_noop', changes, {});
        expect(code).toContain('No changes');
    });

    it('handles array and object values in def', () =>
    {
        const changes = {
            tables: { created: [], dropped: [] },
            columns: {
                added: [{ table: 't', column: 'c', def: { type: 'STRING', enum: ['a', 'b'] } }],
                dropped: [],
                altered: [],
            },
        };
        const code = generateMigrationCode('test', changes, {});
        expect(code).toContain('enum:');
        expect(code).toContain('"a"');
    });

    it('generates boolean and number values in def', () =>
    {
        const changes = {
            tables: { created: [], dropped: [] },
            columns: {
                added: [{ table: 't', column: 'c', def: { type: 'INTEGER', primaryKey: true, autoIncrement: true } }],
                dropped: [],
                altered: [],
            },
        };
        const code = generateMigrationCode('test', changes, {});
        expect(code).toContain('primaryKey: true');
        expect(code).toContain('autoIncrement: true');
    });
});

// ===================================================================
// discoverModels
// ===================================================================
describe('snapshot — discoverModels', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_snap_models__');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns [] when directory does not exist', () =>
    {
        const models = discoverModels('/nonexistent/path', Model);
        expect(models).toEqual([]);
    });

    it('discovers Model subclasses from directory', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const ormPath = require.resolve('../../lib/orm').replace(/\\/g, '/');
        fs.writeFileSync(path.join(tmpDir, 'User.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class User extends Model {
                static table = 'users';
                static schema = { id: { type: TYPES.INTEGER, primaryKey: true } };
            }
            module.exports = User;
        `, 'utf8');

        const models = discoverModels(tmpDir, Model);
        expect(models.length).toBe(1);
        expect(models[0].table).toBe('users');
    });

    it('skips non-model files gracefully', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'util.js'), `module.exports = { helper: true };`, 'utf8');

        const models = discoverModels(tmpDir, Model);
        expect(models).toEqual([]);
    });

    it('skips files that fail to load', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'bad.js'), `throw new Error('intentional');`, 'utf8');

        const models = discoverModels(tmpDir, Model);
        expect(models).toEqual([]);
    });

    it('handles default export pattern', () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const ormPath = require.resolve('../../lib/orm').replace(/\\/g, '/');
        fs.writeFileSync(path.join(tmpDir, 'Post.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class Post extends Model {
                static table = 'posts';
                static schema = { id: { type: TYPES.INTEGER, primaryKey: true } };
            }
            module.exports = { default: Post };
        `, 'utf8');

        const models = discoverModels(tmpDir, Model);
        expect(models.length).toBe(1);
        expect(models[0].table).toBe('posts');
    });
});

// ===================================================================
// SNAPSHOT_FILE constant
// ===================================================================
describe('snapshot — SNAPSHOT_FILE', () =>
{
    it('is _schema_snapshot.json', () =>
    {
        expect(SNAPSHOT_FILE).toBe('_schema_snapshot.json');
    });
});

// ===================================================================
// Auto-diff migration via CLI integration
// ===================================================================
describe('CLI — auto-diff make:migration', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_snap_cli__');
    const { CLI } = require('../../lib/cli');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('auto-generates migration from model diff (new table)', () =>
    {
        const modelsDir = path.join(tmpDir, 'models');
        const migDir    = path.join(tmpDir, 'migrations');
        fs.mkdirSync(modelsDir, { recursive: true });
        const ormPath = require.resolve('../../lib/orm').replace(/\\/g, '/');

        // Write a Model file
        fs.writeFileSync(path.join(modelsDir, 'User.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class User extends Model {
                static table = 'users';
                static schema = {
                    id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                    name:  { type: TYPES.STRING, required: true },
                };
            }
            module.exports = User;
        `, 'utf8');

        const cli = new CLI(['make:migration', 'create_users', `--dir=${migDir}`, `--models=${modelsDir}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();

        // Migration file should exist
        const files = fs.readdirSync(migDir).filter(f => f.endsWith('.js'));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/create_users\.js$/);

        const content = fs.readFileSync(path.join(migDir, files[0]), 'utf8');
        expect(content).toContain("createTable('users'");
        expect(content).toContain('Auto-generated migration');
        expect(content).toContain('primaryKey: true');

        // Snapshot should exist
        expect(fs.existsSync(path.join(migDir, SNAPSHOT_FILE))).toBe(true);

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Table users');
        expect(output).toContain('Migration created');
        log.mockRestore();
    });

    it('detects no changes and skips', () =>
    {
        const modelsDir = path.join(tmpDir, 'models');
        const migDir    = path.join(tmpDir, 'migrations');
        fs.mkdirSync(modelsDir, { recursive: true });
        const ormPath = require.resolve('../../lib/orm').replace(/\\/g, '/');

        fs.writeFileSync(path.join(modelsDir, 'Item.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class Item extends Model {
                static table = 'items';
                static schema = { id: { type: TYPES.INTEGER, primaryKey: true } };
            }
            module.exports = Item;
        `, 'utf8');

        // Pre-save a snapshot matching current models
        const { buildSnapshot } = require('../../lib/orm/snapshot');
        const snap = buildSnapshot([require(path.join(modelsDir, 'Item.js'))]);
        saveSnapshot(migDir, snap);

        const cli = new CLI(['make:migration', 'noop', `--dir=${migDir}`, `--models=${modelsDir}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();

        // No migration file should be generated
        const files = fs.readdirSync(migDir).filter(f => f.endsWith('.js'));
        expect(files.length).toBe(0);

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No schema changes');
        log.mockRestore();
    });

    it('detects added column on second migration', () =>
    {
        const modelsDir = path.join(tmpDir, 'models');
        const migDir    = path.join(tmpDir, 'migrations');
        fs.mkdirSync(modelsDir, { recursive: true });
        const ormPath = require.resolve('../../lib/orm').replace(/\\/g, '/');

        // First: create initial model + snapshot
        fs.writeFileSync(path.join(modelsDir, 'User.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class User extends Model {
                static table = 'users';
                static schema = { id: { type: TYPES.INTEGER, primaryKey: true } };
            }
            module.exports = User;
        `, 'utf8');

        // Save initial snapshot
        const { buildSnapshot } = require('../../lib/orm/snapshot');
        const initialSnap = buildSnapshot([require(path.join(modelsDir, 'User.js'))]);
        saveSnapshot(migDir, initialSnap);

        // Now update the model: add email column
        // Clear require cache first
        delete require.cache[require.resolve(path.join(modelsDir, 'User.js'))];
        fs.writeFileSync(path.join(modelsDir, 'User.js'), `
            const { Model, TYPES } = require('${ormPath}');
            class User extends Model {
                static table = 'users';
                static schema = {
                    id:    { type: TYPES.INTEGER, primaryKey: true },
                    email: { type: TYPES.STRING, unique: true },
                };
            }
            module.exports = User;
        `, 'utf8');

        const cli = new CLI(['make:migration', 'add_email', `--dir=${migDir}`, `--models=${modelsDir}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._makeMigration();

        const files = fs.readdirSync(migDir).filter(f => f.endsWith('.js'));
        expect(files.length).toBe(1);

        const content = fs.readFileSync(path.join(migDir, files[0]), 'utf8');
        expect(content).toContain("addColumn('users', 'email'");
        expect(content).toContain("dropColumn('users', 'email')");

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('users.email');
        log.mockRestore();
    });
});

// ===================================================================
// CLI — migrate:remove
// ===================================================================
describe('CLI — migrate:remove', () =>
{
    const tmpDir = path.join(__dirname, '__tmp_snap_remove__');
    const { CLI } = require('../../lib/cli');

    afterEach(() =>
    {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes the last unapplied migration file', async () =>
    {
        const migDir = path.join(tmpDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });

        // Write config
        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${migDir.replace(/\\/g, '\\\\')}', modelsDir: '${path.join(tmpDir, 'models').replace(/\\/g, '\\\\')}' };`, 'utf8');

        // Write a migration file
        fs.writeFileSync(path.join(migDir, '20250101000000_to_remove.js'),
            `module.exports = { name: '20250101000000_to_remove', async up(db) {}, async down(db) {} };`,
            'utf8');

        const cli = new CLI(['migrate:remove', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        // File should be deleted
        const remaining = fs.readdirSync(migDir).filter(f => f.endsWith('.js'));
        expect(remaining.length).toBe(0);

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('Removed');
        expect(output).toContain('removed successfully');

        log.mockRestore();
        err.mockRestore();
    });

    it('refuses to remove an applied migration', async () =>
    {
        const migDir = path.join(tmpDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });

        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${migDir.replace(/\\/g, '\\\\')}' };`, 'utf8');

        fs.writeFileSync(path.join(migDir, '20250101000000_applied.js'),
            `module.exports = { name: '20250101000000_applied', async up(db) {}, async down(db) {} };`,
            'utf8');

        const cli = new CLI(['migrate:remove', `--config=${cfgPath}`]);

        // Mock the migrator to report migration as executed
        cli._createMigrator = async () => ({
            db: { close: async () => {} },
            migrator: {
                status: async () => ({
                    executed: ['20250101000000_applied'],
                    pending: [],
                    lastBatch: 1,
                }),
            },
        });

        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await cli.run();

        // File should still exist
        expect(fs.existsSync(path.join(migDir, '20250101000000_applied.js'))).toBe(true);
        const output = err.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('already been applied');

        log.mockRestore();
        err.mockRestore();
    });

    it('handles no migration files to remove', async () =>
    {
        const migDir = path.join(tmpDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });

        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${migDir.replace(/\\/g, '\\\\')}' };`, 'utf8');

        const cli = new CLI(['migrate:remove', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No migration files to remove');
        log.mockRestore();
    });

    it('handles no migrations directory', async () =>
    {
        fs.mkdirSync(tmpDir, { recursive: true });
        const cfgPath = path.join(tmpDir, 'zero.config.js');
        fs.writeFileSync(cfgPath, `module.exports = { adapter: 'memory', migrationsDir: '${path.join(tmpDir, 'nope').replace(/\\/g, '\\\\')}' };`, 'utf8');

        const cli = new CLI(['migrate:remove', `--config=${cfgPath}`]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await cli.run();

        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('No migrations directory');
        log.mockRestore();
    });
});

// ===================================================================
// CLI — _loadConfigSync
// ===================================================================
describe('CLI — _loadConfigSync', () =>
{
    const { CLI } = require('../../lib/cli');

    it('throws when no config found', () =>
    {
        const cli = new CLI(['make:migration', 'test', '--config=/nonexistent.js']);
        expect(() => cli._loadConfigSync()).toThrow('No config');
    });
});

// ===================================================================
// CLI — help text includes new commands
// ===================================================================
describe('CLI — help text updated', () =>
{
    const { CLI } = require('../../lib/cli');

    it('help mentions migrate:remove', () =>
    {
        const cli = new CLI(['help']);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        cli._help();
        const output = log.mock.calls.map(c => c[0]).join('\n');
        expect(output).toContain('migrate:remove');
        expect(output).toContain('--empty');
        expect(output).toContain('modelsDir');
        log.mockRestore();
    });
});
