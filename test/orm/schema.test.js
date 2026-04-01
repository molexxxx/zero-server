/** schema.test.js — ORM DDL, migration, and schema constraint tests */
const { Database, Model, TYPES } = require('../../lib/orm');

// --- Helpers ------------------------------------------------------------

function sqliteDb()
{
    return Database.connect('sqlite', { filename: ':memory:' });
}

function memoryDb()
{
    return Database.connect('memory');
}

// --- SQLite DDL Tests ---------------------------------------------------

describe('SQLite DDL — Foreign Keys', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); db.adapter._db.exec('PRAGMA foreign_keys = ON'); });
    afterEach(() => db.close());

    it('creates a table with a foreign key reference', async () =>
    {
        class Author extends Model
        {
            static table = 'authors';
            static schema = {
                id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true },
            };
        }

        class Book extends Model
        {
            static table = 'books';
            static schema = {
                id:       { type: 'integer', primaryKey: true, autoIncrement: true },
                title:    { type: 'string', required: true },
                authorId: {
                    type: 'integer', required: true,
                    references: { table: 'authors', column: 'id', onDelete: 'CASCADE' },
                },
            };
        }

        db.register(Author).register(Book);
        await db.sync();

        const fks = db.adapter.foreignKeys('books');
        expect(fks.length).toBe(1);
        expect(fks[0].table).toBe('authors');
        expect(fks[0].from).toBe('authorId');
        expect(fks[0].to).toBe('id');
    });

    it('FK CASCADE delete removes child rows', async () =>
    {
        db.adapter._db.exec(`
            CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
            CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT,
                authorId INTEGER REFERENCES "authors"("id") ON DELETE CASCADE);
        `);

        db.adapter._db.exec(`INSERT INTO authors (name) VALUES ('Alice')`);
        db.adapter._db.exec(`INSERT INTO books (title, authorId) VALUES ('Book1', 1)`);
        db.adapter._db.exec(`DELETE FROM authors WHERE id = 1`);

        const rows = db.adapter._db.prepare('SELECT * FROM books').all();
        expect(rows).toHaveLength(0);
    });

    it('FK prevents inserting orphaned references', async () =>
    {
        db.adapter._db.exec(`
            CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT,
                parentId INTEGER NOT NULL REFERENCES "parents"("id"));
        `);

        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO children (parentId) VALUES (999)`);
        }).toThrow();
    });

    it('FK with ON UPDATE CASCADE propagates updates', async () =>
    {
        db.adapter._db.exec(`
            CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT,
                catId INTEGER REFERENCES "categories"("id") ON UPDATE CASCADE);
        `);

        db.adapter._db.exec(`INSERT INTO categories VALUES (1, 'Tech')`);
        db.adapter._db.exec(`INSERT INTO items (catId) VALUES (1)`);
        db.adapter._db.exec(`UPDATE categories SET id = 42 WHERE id = 1`);

        const row = db.adapter._db.prepare('SELECT catId FROM items WHERE id = 1').get();
        expect(row.catId).toBe(42);
    });
});

describe('SQLite DDL — CHECK Constraints', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); });
    afterEach(() => db.close());

    it('creates a column with a CHECK constraint', async () =>
    {
        class Product extends Model
        {
            static table = 'products';
            static schema = {
                id:    { type: 'integer', primaryKey: true, autoIncrement: true },
                price: { type: 'float', required: true, check: '"price" > 0' },
            };
        }
        db.register(Product);
        await db.sync();

        // Valid insert
        await Product.create({ price: 9.99 });
        const all = await Product.all();
        expect(all).toHaveLength(1);

        // Invalid insert should throw
        await expect(Product.create({ price: -1 }))
            .rejects.toThrow();
    });

    it('enforces enum CHECK for non-enum types', async () =>
    {
        class Status extends Model
        {
            static table = 'statuses';
            static schema = {
                id:     { type: 'integer', primaryKey: true, autoIncrement: true },
                status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
            };
        }
        db.register(Status);
        await db.sync();

        await Status.create({ status: 'active' });
        await expect(Status.create({ status: 'unknown' }))
            .rejects.toThrow();
    });
});

describe('SQLite DDL — Indexes', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); });
    afterEach(() => db.close());

    it('creates a single-column index', async () =>
    {
        class User extends Model
        {
            static table = 'users';
            static schema = {
                id:    { type: 'integer', primaryKey: true, autoIncrement: true },
                email: { type: 'string', index: true },
            };
        }
        db.register(User);
        await db.sync();

        const idxs = db.adapter.indexes('users');
        const emailIdx = idxs.find(i => i.name === 'idx_users_email');
        expect(emailIdx).toBeDefined();
    });

    it('creates a named index', async () =>
    {
        class Log extends Model
        {
            static table = 'logs';
            static schema = {
                id:        { type: 'integer', primaryKey: true, autoIncrement: true },
                createdAt: { type: 'datetime', index: 'idx_log_time' },
            };
        }
        db.register(Log);
        await db.sync();

        const idxs = db.adapter.indexes('logs');
        expect(idxs.find(i => i.name === 'idx_log_time')).toBeDefined();
    });

    it('creates composite indexes', async () =>
    {
        class Event extends Model
        {
            static table = 'events';
            static schema = {
                id:     { type: 'integer', primaryKey: true, autoIncrement: true },
                userId: { type: 'integer', compositeIndex: 'user_date' },
                date:   { type: 'datetime', compositeIndex: 'user_date' },
            };
        }
        db.register(Event);
        await db.sync();

        const idxs = db.adapter.indexes('events');
        expect(idxs.find(i => i.name === 'idx_events_user_date')).toBeDefined();
    });
});

describe('SQLite DDL — Composite Primary Keys', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); });
    afterEach(() => db.close());

    it('creates a table with a composite primary key', async () =>
    {
        class Enrollment extends Model
        {
            static table = 'enrollments';
            static schema = {
                studentId: { type: 'integer', primaryKey: true, compositeKey: true },
                courseId:  { type: 'integer', primaryKey: true, compositeKey: true },
                grade:     { type: 'string' },
            };
        }
        db.register(Enrollment);
        await db.sync();

        // Insert valid row
        db.adapter._db.exec(`INSERT INTO enrollments (studentId, courseId, grade) VALUES (1, 101, 'A')`);
        const row = db.adapter._db.prepare('SELECT * FROM enrollments').get();
        expect(row.studentId).toBe(1);
        expect(row.courseId).toBe(101);

        // Duplicate composite PK should fail
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO enrollments (studentId, courseId, grade) VALUES (1, 101, 'B')`);
        }).toThrow();

        // Different combination should succeed
        db.adapter._db.exec(`INSERT INTO enrollments (studentId, courseId, grade) VALUES (1, 102, 'B')`);
        const all = db.adapter._db.prepare('SELECT * FROM enrollments').all();
        expect(all).toHaveLength(2);
    });

    it('_primaryKey returns array for composite PKs', () =>
    {
        class JoinTable extends Model
        {
            static table = 'join_table';
            static schema = {
                leftId:  { type: 'integer', primaryKey: true, compositeKey: true },
                rightId: { type: 'integer', primaryKey: true, compositeKey: true },
            };
        }
        const pk = JoinTable._primaryKey();
        expect(Array.isArray(pk)).toBe(true);
        expect(pk).toEqual(['leftId', 'rightId']);
    });

    it('_primaryKey returns string for single PK', () =>
    {
        class Simple extends Model
        {
            static table = 'simple';
            static schema = {
                id:   { type: 'integer', primaryKey: true },
                name: { type: 'string' },
            };
        }
        expect(Simple._primaryKey()).toBe('id');
    });
});

describe('SQLite DDL — Composite Unique Constraints', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); });
    afterEach(() => db.close());

    it('enforces composite unique constraint', async () =>
    {
        class UserRole extends Model
        {
            static table = 'user_roles';
            static schema = {
                id:     { type: 'integer', primaryKey: true, autoIncrement: true },
                userId: { type: 'integer', required: true, compositeUnique: 'user_role' },
                role:   { type: 'string', required: true, compositeUnique: 'user_role' },
            };
        }
        db.register(UserRole);
        await db.sync();

        db.adapter._db.exec(`INSERT INTO user_roles (userId, role) VALUES (1, 'admin')`);
        db.adapter._db.exec(`INSERT INTO user_roles (userId, role) VALUES (1, 'editor')`); // different role OK
        db.adapter._db.exec(`INSERT INTO user_roles (userId, role) VALUES (2, 'admin')`); // different user OK

        // Same user+role should fail
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO user_roles (userId, role) VALUES (1, 'admin')`);
        }).toThrow();
    });
});

// --- SQLite Migration Methods -------------------------------------------

describe('SQLite Migrations', () =>
{
    let db;
    beforeEach(() =>
    {
        db = sqliteDb();
        db.adapter._db.exec(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    });
    afterEach(() => db.close());

    it('addColumn adds a column', () =>
    {
        db.adapter.addColumn('test_table', 'email', { type: 'string', default: '' });
        const cols = db.adapter.columns('test_table');
        expect(cols.find(c => c.name === 'email')).toBeDefined();
    });

    it('addColumn with references creates FK', () =>
    {
        db.adapter._db.exec(`CREATE TABLE refs (id INTEGER PRIMARY KEY)`);
        db.adapter.addColumn('test_table', 'refId', {
            type: 'integer',
            references: { table: 'refs', column: 'id', onDelete: 'SET NULL' },
        });
        const fks = db.adapter.foreignKeys('test_table');
        expect(fks.find(f => f.from === 'refId')).toBeDefined();
    });

    it('dropColumn removes a column', () =>
    {
        db.adapter.dropColumn('test_table', 'name');
        const cols = db.adapter.columns('test_table');
        expect(cols.find(c => c.name === 'name')).toBeUndefined();
    });

    it('renameColumn renames a column', () =>
    {
        db.adapter.renameColumn('test_table', 'name', 'fullName');
        const cols = db.adapter.columns('test_table');
        expect(cols.find(c => c.name === 'fullName')).toBeDefined();
        expect(cols.find(c => c.name === 'name')).toBeUndefined();
    });

    it('renameTable renames a table', () =>
    {
        db.adapter.renameTable('test_table', 'renamed_table');
        expect(db.adapter.hasTable('renamed_table')).toBe(true);
        expect(db.adapter.hasTable('test_table')).toBe(false);
    });

    it('createIndex and dropIndex work', () =>
    {
        db.adapter.createIndex('test_table', ['name'], { name: 'idx_name' });
        let idxs = db.adapter.indexes('test_table');
        expect(idxs.find(i => i.name === 'idx_name')).toBeDefined();

        db.adapter.dropIndex('test_table', 'idx_name');
        idxs = db.adapter.indexes('test_table');
        expect(idxs.find(i => i.name === 'idx_name')).toBeUndefined();
    });

    it('createIndex with unique creates unique index', () =>
    {
        db.adapter.createIndex('test_table', ['name'], { name: 'uq_name', unique: true });
        const idxs = db.adapter.indexes('test_table');
        const idx = idxs.find(i => i.name === 'uq_name');
        expect(idx).toBeDefined();
        expect(idx.unique).toBe(true);
    });

    it('hasTable returns correct boolean', () =>
    {
        expect(db.adapter.hasTable('test_table')).toBe(true);
        expect(db.adapter.hasTable('nonexistent_table')).toBe(false);
    });

    it('hasColumn returns correct boolean', () =>
    {
        expect(db.adapter.hasColumn('test_table', 'name')).toBe(true);
        expect(db.adapter.hasColumn('test_table', 'nonexistent')).toBe(false);
    });

    it('describeTable returns columns, indexes, and foreign keys', () =>
    {
        const desc = db.adapter.describeTable('test_table');
        expect(desc.columns).toBeDefined();
        expect(desc.indexes).toBeDefined();
        expect(desc.foreignKeys).toBeDefined();
        expect(desc.columns.length).toBeGreaterThanOrEqual(2);
    });
});

// --- Memory Adapter Tests -----------------------------------------------

describe('Memory Adapter — Schema Tracking', () =>
{
    let db;
    beforeEach(() => { db = memoryDb(); });

    it('stores schema on createTable', async () =>
    {
        const schema = {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
        };
        await db.adapter.createTable('users', schema);
        expect(db.adapter._schemas.has('users')).toBe(true);
    });

    it('describeTable returns schema info', async () =>
    {
        const schema = {
            id:    { type: 'integer', primaryKey: true },
            name:  { type: 'string', required: true },
            email: { type: 'string', unique: true },
        };
        await db.adapter.createTable('users', schema);
        const desc = await db.adapter.describeTable('users');
        expect(desc).toHaveLength(3);
        expect(desc.find(c => c.name === 'id').primaryKey).toBe(true);
        expect(desc.find(c => c.name === 'name').nullable).toBe(false);
    });
});

describe('Memory Adapter — Unique Constraint Enforcement', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memoryDb();
        await db.adapter.createTable('users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
            name:  { type: 'string' },
        });
    });

    it('allows inserting unique values', async () =>
    {
        await db.adapter.insert('users', { email: 'a@b.com', name: 'Alice' });
        await db.adapter.insert('users', { email: 'b@c.com', name: 'Bob' });
        const rows = await db.adapter.execute({ action: 'select', table: 'users', where: [] });
        expect(rows).toHaveLength(2);
    });

    it('rejects duplicate unique values', async () =>
    {
        await db.adapter.insert('users', { email: 'a@b.com', name: 'Alice' });
        await expect(
            db.adapter.insert('users', { email: 'a@b.com', name: 'Bob' })
        ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('allows null values for unique columns (SQL semantics)', async () =>
    {
        await db.adapter.insert('users', { name: 'Alice' }); // email is undefined
        await db.adapter.insert('users', { name: 'Bob' });   // email is undefined
        const rows = await db.adapter.execute({ action: 'select', table: 'users', where: [] });
        expect(rows).toHaveLength(2);
    });
});

describe('Memory Adapter — Composite Unique', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memoryDb();
        await db.adapter.createTable('user_roles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer', compositeUnique: 'user_role' },
            role:   { type: 'string', compositeUnique: 'user_role' },
        });
    });

    it('allows different combinations', async () =>
    {
        await db.adapter.insert('user_roles', { userId: 1, role: 'admin' });
        await db.adapter.insert('user_roles', { userId: 1, role: 'editor' });
        await db.adapter.insert('user_roles', { userId: 2, role: 'admin' });
        const rows = await db.adapter.execute({ action: 'select', table: 'user_roles', where: [] });
        expect(rows).toHaveLength(3);
    });

    it('rejects duplicate composite unique combo', async () =>
    {
        await db.adapter.insert('user_roles', { userId: 1, role: 'admin' });
        await expect(
            db.adapter.insert('user_roles', { userId: 1, role: 'admin' })
        ).rejects.toThrow(/UNIQUE constraint failed/);
    });
});

describe('Memory Adapter — Migration Methods', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memoryDb();
        await db.adapter.createTable('items', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.adapter.insert('items', { name: 'Widget' });
    });

    it('addColumn sets default for existing rows', async () =>
    {
        await db.adapter.addColumn('items', 'color', { type: 'string', default: 'blue' });
        const rows = await db.adapter.execute({ action: 'select', table: 'items', where: [] });
        expect(rows[0].color).toBe('blue');
    });

    it('dropColumn removes data from existing rows', async () =>
    {
        await db.adapter.dropColumn('items', 'name');
        const rows = await db.adapter.execute({ action: 'select', table: 'items', where: [] });
        expect(rows[0].name).toBeUndefined();
    });

    it('renameColumn renames field in schema and data', async () =>
    {
        await db.adapter.renameColumn('items', 'name', 'title');
        const rows = await db.adapter.execute({ action: 'select', table: 'items', where: [] });
        expect(rows[0].title).toBe('Widget');
        expect(rows[0].name).toBeUndefined();
        const desc = await db.adapter.describeTable('items');
        expect(desc.find(c => c.name === 'title')).toBeDefined();
        expect(desc.find(c => c.name === 'name')).toBeUndefined();
    });

    it('renameTable moves data and schema', async () =>
    {
        await db.adapter.renameTable('items', 'products');
        expect(await db.adapter.hasTable('products')).toBe(true);
        expect(await db.adapter.hasTable('items')).toBe(false);
        const rows = await db.adapter.execute({ action: 'select', table: 'products', where: [] });
        expect(rows).toHaveLength(1);
    });

    it('hasTable and hasColumn work', async () =>
    {
        expect(await db.adapter.hasTable('items')).toBe(true);
        expect(await db.adapter.hasTable('nope')).toBe(false);
        expect(await db.adapter.hasColumn('items', 'name')).toBe(true);
        expect(await db.adapter.hasColumn('items', 'nope')).toBe(false);
    });

    it('createIndex and dropIndex track metadata', async () =>
    {
        await db.adapter.createIndex('items', ['name'], { name: 'idx_name' });
        let idxs = await db.adapter.indexes('items');
        expect(idxs.find(i => i.name === 'idx_name')).toBeDefined();

        await db.adapter.dropIndex('items', 'idx_name');
        idxs = await db.adapter.indexes('items');
        expect(idxs.find(i => i.name === 'idx_name')).toBeUndefined();
    });

    it('createIndex with unique flag', async () =>
    {
        await db.adapter.createIndex('items', ['name'], { name: 'uq_name', unique: true });
        const idxs = await db.adapter.indexes('items');
        const idx = idxs.find(i => i.name === 'uq_name');
        expect(idx.unique).toBe(true);
    });
});

// --- Database Class Migration Proxies -----------------------------------

describe('Database — Migration API', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memoryDb();
        await db.adapter.createTable('test', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string' },
        });
    });

    it('db.addColumn delegates to adapter', async () =>
    {
        await db.addColumn('test', 'email', { type: 'string', default: '' });
        const desc = await db.describeTable('test');
        expect(desc.find(c => c.name === 'email')).toBeDefined();
    });

    it('db.dropColumn delegates to adapter', async () =>
    {
        await db.dropColumn('test', 'name');
        const desc = await db.describeTable('test');
        expect(desc.find(c => c.name === 'name')).toBeUndefined();
    });

    it('db.renameColumn delegates to adapter', async () =>
    {
        await db.renameColumn('test', 'name', 'title');
        const desc = await db.describeTable('test');
        expect(desc.find(c => c.name === 'title')).toBeDefined();
    });

    it('db.renameTable delegates to adapter', async () =>
    {
        await db.renameTable('test', 'items');
        expect(await db.hasTable('items')).toBe(true);
        expect(await db.hasTable('test')).toBe(false);
    });

    it('db.createIndex and dropIndex delegate to adapter', async () =>
    {
        await db.createIndex('test', 'name', { name: 'idx_n' });
        await db.dropIndex('test', 'idx_n');
    });

    it('db.hasTable and hasColumn delegate to adapter', async () =>
    {
        expect(await db.hasTable('test')).toBe(true);
        expect(await db.hasTable('nope')).toBe(false);
        expect(await db.hasColumn('test', 'name')).toBe(true);
        expect(await db.hasColumn('test', 'nope')).toBe(false);
    });

    it('db.describeTable delegates to adapter', async () =>
    {
        const desc = await db.describeTable('test');
        expect(desc.length).toBeGreaterThanOrEqual(2);
    });
});

// --- Topological Sync Ordering ------------------------------------------

describe('Database — Topological Sync Ordering', () =>
{
    let db;
    afterEach(() => db.close());

    it('creates referenced tables before dependent tables', async () =>
    {
        db = sqliteDb();
        db.adapter._db.exec('PRAGMA foreign_keys = ON');

        const syncOrder = [];
        const origSync = Model.sync;

        class Department extends Model
        {
            static table = 'departments';
            static schema = {
                id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true },
            };
            static async sync()
            {
                syncOrder.push('departments');
                return origSync.call(this);
            }
        }

        class Employee extends Model
        {
            static table = 'employees';
            static schema = {
                id:     { type: 'integer', primaryKey: true, autoIncrement: true },
                name:   { type: 'string', required: true },
                deptId: {
                    type: 'integer',
                    references: { table: 'departments', column: 'id', onDelete: 'SET NULL' },
                },
            };
            static async sync()
            {
                syncOrder.push('employees');
                return origSync.call(this);
            }
        }

        // Register in reverse order (dependent first)
        db.register(Employee).register(Department);
        await db.sync();

        // departments must come before employees
        expect(syncOrder.indexOf('departments')).toBeLessThan(syncOrder.indexOf('employees'));

        // Verify FK actually works
        db.adapter._db.exec(`INSERT INTO departments (name) VALUES ('Engineering')`);
        db.adapter._db.exec(`INSERT INTO employees (name, deptId) VALUES ('Alice', 1)`);
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO employees (name, deptId) VALUES ('Bob', 999)`);
        }).toThrow();
    });

    it('handles models with no FK references', async () =>
    {
        db = memoryDb();

        class A extends Model
        {
            static table = 'a';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }
        class B extends Model
        {
            static table = 'b';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }

        db.register(A).register(B);
        await db.sync();
        expect(await db.hasTable('a')).toBe(true);
        expect(await db.hasTable('b')).toBe(true);
    });
});

// --- Full Integration: Schema with ALL features -------------------------

describe('SQLite — Full-Feature Schema Integration', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); db.adapter._db.exec('PRAGMA foreign_keys = ON'); });
    afterEach(() => db.close());

    it('creates a complex schema with FK, CHECK, index, composite unique', async () =>
    {
        class Team extends Model
        {
            static table = 'teams';
            static schema = {
                id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true, unique: true },
            };
        }

        class Player extends Model
        {
            static table = 'players';
            static schema = {
                id:       { type: 'integer', primaryKey: true, autoIncrement: true },
                name:     { type: 'string', required: true, index: true },
                teamId:   { type: 'integer', references: { table: 'teams', column: 'id', onDelete: 'CASCADE' } },
                jersey:   { type: 'integer', check: '"jersey" >= 0 AND "jersey" <= 99', compositeUnique: 'team_jersey' },
                position: { type: 'string', enum: ['guard', 'forward', 'center'] },
            };
        }

        // Register team first since player depends on it
        db.register(Team).register(Player);
        await db.sync();

        // Verify FK
        const fks = db.adapter.foreignKeys('players');
        expect(fks.length).toBe(1);

        // Verify index on name
        const idxs = db.adapter.indexes('players');
        expect(idxs.find(i => i.name === 'idx_players_name')).toBeDefined();

        // Verify CHECK: jersey must be 0-99
        db.adapter._db.exec(`INSERT INTO teams (name) VALUES ('Lakers')`);
        db.adapter._db.exec(`INSERT INTO players (name, teamId, jersey, position) VALUES ('LeBron', 1, 23, 'forward')`);
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO players (name, teamId, jersey, position) VALUES ('Nobody', 1, 100, 'guard')`);
        }).toThrow();

        // Verify enum CHECK
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO players (name, teamId, jersey, position) VALUES ('Bad', 1, 1, 'goalie')`);
        }).toThrow();

        // Verify FK cascade
        db.adapter._db.exec(`DELETE FROM teams WHERE id = 1`);
        const players = db.adapter._db.prepare('SELECT * FROM players').all();
        expect(players).toHaveLength(0);
    });
});

// --- SQLite Migration Full Workflow -------------------------------------

describe('SQLite — Migration Workflow', () =>
{
    let db;
    beforeEach(() => { db = sqliteDb(); });
    afterEach(() => db.close());

    it('evolves a schema through migration steps', async () =>
    {
        // Step 1: create initial table
        class Article extends Model
        {
            static table = 'articles';
            static schema = {
                id:    { type: 'integer', primaryKey: true, autoIncrement: true },
                title: { type: 'string', required: true },
            };
        }
        db.register(Article);
        await db.sync();

        // Step 2: add column
        db.adapter.addColumn('articles', 'body', { type: 'text', default: '' });
        expect(db.adapter.hasColumn('articles', 'body')).toBe(true);

        // Step 3: add index
        db.adapter.createIndex('articles', ['title'], { name: 'idx_title' });
        const idxs = db.adapter.indexes('articles');
        expect(idxs.find(i => i.name === 'idx_title')).toBeDefined();

        // Step 4: rename column
        db.adapter.renameColumn('articles', 'body', 'content');
        expect(db.adapter.hasColumn('articles', 'content')).toBe(true);
        expect(db.adapter.hasColumn('articles', 'body')).toBe(false);

        // Step 5: verify full description
        const desc = db.adapter.describeTable('articles');
        expect(desc.columns.find(c => c.name === 'content')).toBeDefined();
    });
});

// --- Composite Index in SQLite ------------------------------------------

describe('SQLite — Composite Index via createIndex', () =>
{
    let db;
    beforeEach(() =>
    {
        db = sqliteDb();
        db.adapter._db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, userId INTEGER, date TEXT, type TEXT)`);
    });
    afterEach(() => db.close());

    it('creates a multi-column index', () =>
    {
        db.adapter.createIndex('events', ['userId', 'date'], { name: 'idx_user_date' });
        const idxs = db.adapter.indexes('events');
        expect(idxs.find(i => i.name === 'idx_user_date')).toBeDefined();
    });

    it('creates a unique multi-column index', () =>
    {
        db.adapter.createIndex('events', ['userId', 'type'], { name: 'uq_user_type', unique: true });
        db.adapter._db.exec(`INSERT INTO events (userId, date, type) VALUES (1, '2024-01-01', 'login')`);
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO events (userId, date, type) VALUES (1, '2024-01-02', 'login')`);
        }).toThrow();
    });
});

// --- JSON Adapter inherits from Memory ----------------------------------

describe('JSON Adapter — inherits migration methods from Memory', () =>
{
    it('has migration methods via inheritance', () =>
    {
        const fs = require('fs');
        const path = require('path');
        const tmpDir = path.join(__dirname, '__json_test_' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });

        try
        {
            const db = Database.connect('json', { dir: tmpDir });
            expect(typeof db.adapter.addColumn).toBe('function');
            expect(typeof db.adapter.dropColumn).toBe('function');
            expect(typeof db.adapter.renameColumn).toBe('function');
            expect(typeof db.adapter.renameTable).toBe('function');
            expect(typeof db.adapter.createIndex).toBe('function');
            expect(typeof db.adapter.dropIndex).toBe('function');
            expect(typeof db.adapter.hasTable).toBe('function');
            expect(typeof db.adapter.hasColumn).toBe('function');
            expect(typeof db.adapter.describeTable).toBe('function');
        }
        finally
        {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// --- MySQL Adapter DDL (quick constructor check, no live connection) ----

describe('MySQL Adapter — DDL method signatures', () =>
{
    it('has all migration methods', () =>
    {
        // We can't connect to MySQL in tests, but we can verify the methods exist
        const MysqlAdapter = require('../../lib/orm/adapters/mysql');
        const proto = MysqlAdapter.prototype;
        expect(typeof proto.addColumn).toBe('function');
        expect(typeof proto.dropColumn).toBe('function');
        expect(typeof proto.renameColumn).toBe('function');
        expect(typeof proto.renameTable).toBe('function');
        expect(typeof proto.createIndex).toBe('function');
        expect(typeof proto.dropIndex).toBe('function');
        expect(typeof proto.addForeignKey).toBe('function');
        expect(typeof proto.dropForeignKey).toBe('function');
        expect(typeof proto.hasTable).toBe('function');
        expect(typeof proto.hasColumn).toBe('function');
        expect(typeof proto.describeTable).toBe('function');
    });
});

// --- PostgreSQL Adapter DDL (method signatures) -------------------------

describe('PostgreSQL Adapter — DDL method signatures', () =>
{
    it('has all migration methods', () =>
    {
        const PgAdapter = require('../../lib/orm/adapters/postgres');
        const proto = PgAdapter.prototype;
        expect(typeof proto.addColumn).toBe('function');
        expect(typeof proto.dropColumn).toBe('function');
        expect(typeof proto.renameColumn).toBe('function');
        expect(typeof proto.renameTable).toBe('function');
        expect(typeof proto.createIndex).toBe('function');
        expect(typeof proto.dropIndex).toBe('function');
        expect(typeof proto.addForeignKey).toBe('function');
        expect(typeof proto.dropForeignKey).toBe('function');
        expect(typeof proto.hasTable).toBe('function');
        expect(typeof proto.hasColumn).toBe('function');
        expect(typeof proto.describeTable).toBe('function');
    });
});

// --- MongoDB Adapter DDL (method signatures) ----------------------------

describe('MongoDB Adapter — DDL method signatures', () =>
{
    it('has all migration methods', () =>
    {
        const MongoAdapter = require('../../lib/orm/adapters/mongo');
        const proto = MongoAdapter.prototype;
        expect(typeof proto.hasTable).toBe('function');
        expect(typeof proto.renameTable).toBe('function');
        expect(typeof proto.addColumn).toBe('function');
        expect(typeof proto.dropColumn).toBe('function');
        expect(typeof proto.renameColumn).toBe('function');
        expect(typeof proto.describeTable).toBe('function');
        expect(typeof proto.createIndex).toBe('function');
        expect(typeof proto.dropIndex).toBe('function');
    });
});

// --- Edge Cases ---------------------------------------------------------

describe('Edge Cases', () =>
{
    it('memory adapter clone preserves schema', async () =>
    {
        const db = memoryDb();
        await db.adapter.createTable('items', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string', unique: true },
        });
        await db.adapter.insert('items', { id: 1, name: 'A' });

        const clone = db.adapter.clone();
        expect(clone._schemas.has('items')).toBe(true);
        const desc = await clone.describeTable('items');
        expect(desc.find(c => c.name === 'name')).toBeDefined();
    });

    it('memory unique enforcement ignores undefined and null', async () =>
    {
        const db = memoryDb();
        await db.adapter.createTable('users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
        });
        // Multiple undefined emails should be fine (like SQL NULL semantics)
        await db.adapter.insert('users', {});
        await db.adapter.insert('users', {});
        await db.adapter.insert('users', { email: null });
    });

    it('SQLite with all schema features at once compiles correctly', async () =>
    {
        const db = sqliteDb();
        db.adapter._db.exec('PRAGMA foreign_keys = ON');

        class Parent extends Model
        {
            static table = 'parent';
            static schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
            };
        }

        class Child extends Model
        {
            static table = 'child';
            static schema = {
                id:       { type: 'integer', primaryKey: true, autoIncrement: true },
                parentId: { type: 'integer', references: { table: 'parent', column: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' }, index: true },
                name:     { type: 'string', required: true },
                age:      { type: 'integer', check: '"age" >= 0 AND "age" <= 150' },
                tag1:     { type: 'string', compositeUnique: 'tag_pair' },
                tag2:     { type: 'string', compositeUnique: 'tag_pair' },
                cat1:     { type: 'string', compositeIndex: 'cat_combo' },
                cat2:     { type: 'string', compositeIndex: 'cat_combo' },
            };
        }

        db.register(Parent).register(Child);
        await db.sync();

        // Verify FK
        const fks = db.adapter.foreignKeys('child');
        expect(fks.length).toBe(1);

        // Verify index on parentId
        const idxs = db.adapter.indexes('child');
        expect(idxs.find(i => i.name === 'idx_child_parentId')).toBeDefined();

        // Verify composite index
        expect(idxs.find(i => i.name === 'idx_child_cat_combo')).toBeDefined();

        // Verify CHECK
        db.adapter._db.exec(`INSERT INTO parent (id) VALUES (1)`);
        db.adapter._db.exec(`INSERT INTO child (parentId, name, age) VALUES (1, 'Test', 25)`);
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO child (parentId, name, age) VALUES (1, 'Bad', -1)`);
        }).toThrow();

        // Verify composite unique
        db.adapter._db.exec(`INSERT INTO child (parentId, name, tag1, tag2) VALUES (1, 'A', 'x', 'y')`);
        expect(() =>
        {
            db.adapter._db.exec(`INSERT INTO child (parentId, name, tag1, tag2) VALUES (1, 'B', 'x', 'y')`);
        }).toThrow();

        db.close();
    });
});
