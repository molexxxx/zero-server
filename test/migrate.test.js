/**
 * Tests for the Migrator framework (lib/orm/migrate.js).
 * Uses the memory adapter so no external database is needed.
 */
const { Database, Model, TYPES, Migrator, defineMigration } = require('../lib/orm');

class User extends Model
{
    static table = 'users';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        email: { type: TYPES.STRING,  required: true, unique: true },
    };
    static timestamps = true;
}

describe('Migrator', () =>
{
    let db, migrator;

    beforeEach(async () =>
    {
        db = Database.connect('memory');
        db.register(User);
        await db.sync();
        migrator = new Migrator(db);
    });

    // -- Registration --

    describe('Registration', () =>
    {
        it('should add a migration', () =>
        {
            migrator.add({
                name: '001_create_posts',
                async up(db) { await db.adapter.createTable('posts', { id: { type: 'integer', primaryKey: true } }); },
                async down(db) { await db.adapter.dropTable('posts'); },
            });
            expect(migrator.list()).toEqual(['001_create_posts']);
        });

        it('should add multiple migrations with addAll', () =>
        {
            migrator.addAll([
                defineMigration('001_a', async () => {}, async () => {}),
                defineMigration('002_b', async () => {}, async () => {}),
            ]);
            expect(migrator.list()).toEqual(['001_a', '002_b']);
        });

        it('should reject migrations without a name', () =>
        {
            expect(() => migrator.add({ up: () => {}, down: () => {} }))
                .toThrow('must have a name');
        });

        it('should reject migrations without up()', () =>
        {
            expect(() => migrator.add({ name: 'bad', up: 'not-fn', down: () => {} }))
                .toThrow('up() must be a function');
        });

        it('should reject migrations without down()', () =>
        {
            expect(() => migrator.add({ name: 'bad', up: () => {}, down: 'not-fn' }))
                .toThrow('down() must be a function');
        });

        it('should reject duplicate migration names', () =>
        {
            migrator.add({ name: 'dup', up: () => {}, down: () => {} });
            expect(() => migrator.add({ name: 'dup', up: () => {}, down: () => {} }))
                .toThrow('already registered');
        });

        it('should support chaining', () =>
        {
            const result = migrator
                .add(defineMigration('001', async () => {}, async () => {}))
                .add(defineMigration('002', async () => {}, async () => {}));
            expect(result).toBe(migrator);
            expect(migrator.list()).toHaveLength(2);
        });
    });

    // -- defineMigration helper --

    describe('defineMigration', () =>
    {
        it('should create a migration object', () =>
        {
            const m = defineMigration('test', async () => 'up', async () => 'down');
            expect(m.name).toBe('test');
            expect(typeof m.up).toBe('function');
            expect(typeof m.down).toBe('function');
        });
    });

    // -- Migrate --

    describe('migrate()', () =>
    {
        it('should run pending migrations and return batch info', async () =>
        {
            migrator.add({
                name: '001_create_posts',
                async up(db) { await db.adapter.createTable('posts', { id: { type: 'integer', primaryKey: true } }); },
                async down(db) { await db.adapter.dropTable('posts'); },
            });

            const result = await migrator.migrate();
            expect(result.migrated).toEqual(['001_create_posts']);
            expect(result.batch).toBe(1);
        });

        it('should return empty list when no pending migrations', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            await migrator.migrate();

            const result = await migrator.migrate();
            expect(result.migrated).toEqual([]);
            expect(result.batch).toBe(0);
        });

        it('should increment batch numbers', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            const first = await migrator.migrate();
            expect(first.batch).toBe(1);

            migrator.add(defineMigration('002', async () => {}, async () => {}));
            const second = await migrator.migrate();
            expect(second.batch).toBe(2);
        });

        it('should run migrations in order', async () =>
        {
            const order = [];
            migrator.addAll([
                defineMigration('001', async () => { order.push('a'); }, async () => {}),
                defineMigration('002', async () => { order.push('b'); }, async () => {}),
                defineMigration('003', async () => { order.push('c'); }, async () => {}),
            ]);
            await migrator.migrate();
            expect(order).toEqual(['a', 'b', 'c']);
        });

        it('should throw and stop on migration failure', async () =>
        {
            migrator.addAll([
                defineMigration('001', async () => {}, async () => {}),
                defineMigration('002', async () => { throw new Error('fail!'); }, async () => {}),
                defineMigration('003', async () => {}, async () => {}),
            ]);
            await expect(migrator.migrate()).rejects.toThrow('002');

            const status = await migrator.status();
            expect(status.executed).toHaveLength(1);
            expect(status.pending).toContain('002');
            expect(status.pending).toContain('003');
        });

        it('should actually create tables when migrations run', async () =>
        {
            migrator.add({
                name: '001_create_items',
                async up(db)
                {
                    await db.adapter.createTable('items', {
                        id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                        name: { type: 'string', required: true },
                    });
                },
                async down(db) { await db.adapter.dropTable('items'); },
            });

            await migrator.migrate();
            expect(await db.adapter.hasTable('items')).toBe(true);

            await db.adapter.insert('items', { name: 'Widget' });
            const rows = await db.adapter.execute({ action: 'select', table: 'items', where: [] });
            expect(rows).toHaveLength(1);
        });
    });

    // -- Rollback --

    describe('rollback()', () =>
    {
        it('should rollback the last batch', async () =>
        {
            migrator.addAll([
                defineMigration('001', async () => {}, async () => {}),
                defineMigration('002', async () => {}, async () => {}),
            ]);
            await migrator.migrate();

            migrator.add(defineMigration('003', async () => {}, async () => {}));
            await migrator.migrate();

            const result = await migrator.rollback();
            expect(result.rolledBack).toEqual(['003']);
            expect(result.batch).toBe(2);
        });

        it('should rollback in reverse order', async () =>
        {
            const order = [];
            migrator.addAll([
                defineMigration('001', async () => {}, async () => { order.push('a'); }),
                defineMigration('002', async () => {}, async () => { order.push('b'); }),
            ]);
            await migrator.migrate();
            await migrator.rollback();
            expect(order).toEqual(['b', 'a']);
        });

        it('should return empty when nothing to rollback', async () =>
        {
            const result = await migrator.rollback();
            expect(result.rolledBack).toEqual([]);
            expect(result.batch).toBe(0);
        });

        it('should throw if migration definition is missing', async () =>
        {
            const migrator2 = new Migrator(db);
            migrator2.add(defineMigration('orphan', async () => {}, async () => {}));
            await migrator2.migrate();

            const migrator3 = new Migrator(db);
            // Does not have 'orphan' registered
            await expect(migrator3.rollback()).rejects.toThrow('definition not found');
        });

        it('should undo table creation', async () =>
        {
            migrator.add({
                name: '001_create_tasks',
                async up(db) { await db.adapter.createTable('tasks', { id: { type: 'integer', primaryKey: true } }); },
                async down(db) { await db.adapter.dropTable('tasks'); },
            });
            await migrator.migrate();
            expect(await db.adapter.hasTable('tasks')).toBe(true);

            await migrator.rollback();
            expect(await db.adapter.hasTable('tasks')).toBe(false);
        });
    });

    // -- rollbackAll --

    describe('rollbackAll()', () =>
    {
        it('should rollback all batches', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            await migrator.migrate();
            migrator.add(defineMigration('002', async () => {}, async () => {}));
            await migrator.migrate();
            migrator.add(defineMigration('003', async () => {}, async () => {}));
            await migrator.migrate();

            const result = await migrator.rollbackAll();
            expect(result.rolledBack).toHaveLength(3);
        });
    });

    // -- reset --

    describe('reset()', () =>
    {
        it('should rollback all then re-migrate', async () =>
        {
            const runCount = { up: 0, down: 0 };
            migrator.add(defineMigration('001',
                async () => { runCount.up++; },
                async () => { runCount.down++; },
            ));
            await migrator.migrate();

            const result = await migrator.reset();
            expect(result.rolledBack).toEqual(['001']);
            expect(result.migrated).toEqual(['001']);
            expect(result.batch).toBe(1); // batch restarts at 1 after rollbackAll
            expect(runCount.up).toBe(2);
            expect(runCount.down).toBe(1);
        });
    });

    // -- fresh --

    describe('fresh()', () =>
    {
        it('should drop everything and re-migrate', async () =>
        {
            migrator.add({
                name: '001_create_tags',
                async up(db)
                {
                    await db.adapter.createTable('tags', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } });
                },
                async down(db) { await db.adapter.dropTable('tags'); },
            });
            await migrator.migrate();

            // Insert data into tags
            await db.adapter.insert('tags', { name: 'javascript' });

            const result = await migrator.fresh();
            expect(result.migrated).toEqual(['001_create_tags']);
            expect(result.batch).toBe(1);
        });
    });

    // -- status --

    describe('status()', () =>
    {
        it('should report executed and pending migrations', async () =>
        {
            migrator.addAll([
                defineMigration('001', async () => {}, async () => {}),
                defineMigration('002', async () => {}, async () => {}),
                defineMigration('003', async () => {}, async () => {}),
            ]);
            await migrator.migrate();

            migrator.add(defineMigration('004', async () => {}, async () => {}));

            const status = await migrator.status();
            expect(status.executed).toHaveLength(3);
            expect(status.pending).toEqual(['004']);
            expect(status.lastBatch).toBe(1);
        });

        it('should report batch info for each executed migration', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            await migrator.migrate();
            migrator.add(defineMigration('002', async () => {}, async () => {}));
            await migrator.migrate();

            const status = await migrator.status();
            expect(status.executed[0].batch).toBe(1);
            expect(status.executed[1].batch).toBe(2);
            expect(status.executed[0]).toHaveProperty('executedAt');
        });

        it('should return empty when no migrations registered', async () =>
        {
            const status = await migrator.status();
            expect(status.executed).toEqual([]);
            expect(status.pending).toEqual([]);
            expect(status.lastBatch).toBe(0);
        });
    });

    // -- hasPending --

    describe('hasPending()', () =>
    {
        it('should return true when there are pending migrations', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            expect(await migrator.hasPending()).toBe(true);
        });

        it('should return false when all migrations are executed', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            await migrator.migrate();
            expect(await migrator.hasPending()).toBe(false);
        });
    });

    // -- list --

    describe('list()', () =>
    {
        it('should return registered migration names', () =>
        {
            migrator.addAll([
                defineMigration('001_a', async () => {}, async () => {}),
                defineMigration('002_b', async () => {}, async () => {}),
            ]);
            expect(migrator.list()).toEqual(['001_a', '002_b']);
        });
    });

    // -- Edge cases --

    describe('Edge Cases', () =>
    {
        it('should use custom migration table name', async () =>
        {
            const m = new Migrator(db, { table: 'custom_migrations' });
            m.add(defineMigration('001', async () => {}, async () => {}));
            await m.migrate();

            expect(await db.adapter.hasTable('custom_migrations')).toBe(true);
        });

        it('should track batch numbers across separate migrate calls', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            const r1 = await migrator.migrate();
            expect(r1.batch).toBe(1);

            migrator.add(defineMigration('002', async () => {}, async () => {}));
            const r2 = await migrator.migrate();
            expect(r2.batch).toBe(2);

            migrator.add(defineMigration('003', async () => {}, async () => {}));
            const r3 = await migrator.migrate();
            expect(r3.batch).toBe(3);
        });

        it('should handle rollback-then-re-migrate cycle', async () =>
        {
            migrator.add(defineMigration('001', async () => {}, async () => {}));
            await migrator.migrate();

            await migrator.rollback();
            const status1 = await migrator.status();
            expect(status1.pending).toContain('001');

            const r = await migrator.migrate();
            expect(r.migrated).toEqual(['001']);
            expect(r.batch).toBe(1); // batch restarts at 1 after full rollback
        });
    });
});
