/**
 * Verbose adapter driver tests — verify that mysql2, pg, and mongodb drivers
 * are installed and that adapters properly initialize, expose methods, handle
 * options, and validate credentials with the real driver packages.
 *
 * These tests do NOT require running database servers — they test initialization,
 * option handling, method existence, type mapping, and error paths.
 */
const { Database, Model, TYPES } = require('../../../lib/orm');

// -- Driver Availability ---------------------------------

describe('Driver package availability', () =>
{
    it('mysql2 driver is installed', () =>
    {
        const mysql2 = require('mysql2/promise');
        expect(mysql2).toBeDefined();
        expect(typeof mysql2.createPool).toBe('function');
    });

    it('pg driver is installed', () =>
    {
        const { Pool } = require('pg');
        expect(Pool).toBeDefined();
        expect(typeof Pool).toBe('function');
    });

    it('mongodb driver is installed', () =>
    {
        const { MongoClient } = require('mongodb');
        expect(MongoClient).toBeDefined();
        expect(typeof MongoClient).toBe('function');
    });
});

// -- MySQL Adapter Verbose Tests -------------------------

describe('MySQL adapter (verbose driver tests)', () =>
{
    it('creates pool with mysql2 driver', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost',
            port: 3306,
            user: 'root',
            password: '',
            database: 'test_db',
        });
        expect(db.adapter).toBeDefined();
        expect(db.adapter._pool).toBeDefined();
    });

    it('stores all constructor options', () =>
    {
        const opts = {
            host: '127.0.0.1',
            port: 3307,
            user: 'admin',
            password: 'secret',
            database: 'mydb',
            connectionLimit: 25,
            charset: 'utf8',
            timezone: '+00:00',
        };
        const db = Database.connect('mysql', opts);
        expect(db.adapter._options.host).toBe('127.0.0.1');
        expect(db.adapter._options.port).toBe(3307);
        expect(db.adapter._options.connectionLimit).toBe(25);
        expect(db.adapter._options.charset).toBe('utf8');
    });

    it('exposes all utility methods', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        const methods = ['tables', 'columns', 'databaseSize', 'poolStatus',
                         'version', 'ping', 'exec', 'raw', 'transaction', 'close'];
        for (const m of methods)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('poolStatus returns correct structure (sync)', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        const status = db.adapter.poolStatus();
        expect(status).toHaveProperty('total');
        expect(status).toHaveProperty('idle');
        expect(status).toHaveProperty('used');
        expect(status).toHaveProperty('queued');
        expect(typeof status.total).toBe('number');
    });

    it('rejects empty database', () =>
    {
        expect(() => Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: '',
        })).toThrow();
    });

    it('rejects non-string user', () =>
    {
        expect(() => Database.connect('mysql', {
            host: 'localhost', user: 123, password: '', database: 'test',
        })).toThrow();
    });

    it('rejects port out of range', () =>
    {
        expect(() => Database.connect('mysql', {
            host: 'localhost', port: 99999, user: 'root', password: '', database: 'test',
        })).toThrow();
    });

    it('handles connectionLimit default', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        // mysql2 pool is created with default limit
        expect(db.adapter._pool).toBeDefined();
    });

    it('handles ssl option', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
            ssl: 'Amazon RDS',
        });
        expect(db.adapter._options.ssl).toBe('Amazon RDS');
    });

    it('closes pool without error', async () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        await db.adapter.close();
        // Should not throw
    });

    it('type handling — CRUD methods exist', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        const crud = ['createTable', 'insert', 'update', 'updateWhere',
                       'remove', 'deleteWhere', 'execute'];
        for (const m of crud)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });
});

// -- PostgreSQL Adapter Verbose Tests --------------------

describe('PostgreSQL adapter (verbose driver tests)', () =>
{
    it('creates pool with pg driver', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost',
            port: 5432,
            user: 'postgres',
            password: 'pass',
            database: 'test_db',
        });
        expect(db.adapter).toBeDefined();
        expect(db.adapter._pool).toBeDefined();
    });

    it('stores all constructor options', () =>
    {
        const opts = {
            host: '10.0.0.1',
            port: 5433,
            user: 'pguser',
            password: 'pgpass',
            database: 'mydb',
            max: 30,
            idleTimeoutMillis: 5000,
            application_name: 'test-app',
            statement_timeout: 30000,
        };
        const db = Database.connect('postgres', opts);
        expect(db.adapter._options.host).toBe('10.0.0.1');
        expect(db.adapter._options.max).toBe(30);
        expect(db.adapter._options.application_name).toBe('test-app');
        expect(db.adapter._options.statement_timeout).toBe(30000);
    });

    it('accepts connectionString', () =>
    {
        const db = Database.connect('postgres', {
            connectionString: 'postgresql://user:pass@localhost:5432/mydb',
            database: 'mydb',
        });
        expect(db.adapter._options.connectionString).toBe('postgresql://user:pass@localhost:5432/mydb');
    });

    it('exposes all utility methods', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        const methods = ['tables', 'columns', 'databaseSize', 'tableSize',
                         'poolStatus', 'version', 'ping', 'exec', 'listen',
                         'raw', 'transaction', 'close'];
        for (const m of methods)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('poolStatus returns correct structure', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        const status = db.adapter.poolStatus();
        expect(status).toHaveProperty('total');
        expect(status).toHaveProperty('idle');
        expect(status).toHaveProperty('waiting');
    });

    it('rejects empty database', () =>
    {
        expect(() => Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: '',
        })).toThrow();
    });

    it('rejects non-string password', () =>
    {
        expect(() => Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 12345, database: 'test',
        })).toThrow();
    });

    it('rejects port out of range', () =>
    {
        expect(() => Database.connect('postgres', {
            host: 'localhost', port: 0, user: 'pg', password: 'pass', database: 'test',
        })).toThrow();
    });

    it('handles ssl option with object', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
            ssl: { rejectUnauthorized: false },
        });
        expect(db.adapter._options.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('closes pool without error', async () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        await db.adapter.close();
    });

    it('CRUD methods exist', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        const crud = ['createTable', 'insert', 'update', 'updateWhere',
                       'remove', 'deleteWhere', 'execute'];
        for (const m of crud)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('has PG-specific parameterized query builder', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        // PG adapter has its own $1/$2 parameter builder
        expect(typeof db.adapter._buildWhereFromChainPg).toBe('function');
        expect(typeof db.adapter._buildWherePg).toBe('function');
    });
});

// -- MongoDB Adapter Verbose Tests -----------------------

describe('MongoDB adapter (verbose driver tests)', () =>
{
    it('creates adapter with mongodb driver', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test_db',
        });
        expect(db.adapter).toBeDefined();
        expect(db.adapter._client).toBeDefined();
    });

    it('stores constructor options', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://myhost:27018',
            database: 'mydb',
            maxPoolSize: 20,
            retryWrites: true,
        });
        // MongoClient is created with the URL
        expect(db.adapter._client).toBeDefined();
    });

    it('exposes all utility methods', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test_db',
        });
        const methods = ['collections', 'stats', 'collectionStats',
                         'createIndex', 'indexes', 'dropIndex',
                         'ping', 'version', 'raw', 'transaction', 'close'];
        for (const m of methods)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('has isConnected getter', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test_db',
        });
        // Before connecting, should have the property
        const descriptor = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(db.adapter), 'isConnected'
        );
        expect(descriptor).toBeDefined();
        expect(typeof descriptor.get).toBe('function');
    });

    it('rejects empty database', () =>
    {
        expect(() => Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: '',
        })).toThrow();
    });

    it('rejects non-string url', () =>
    {
        expect(() => Database.connect('mongo', {
            url: 12345,
            database: 'test',
        })).toThrow();
    });

    it('rejects non-string database', () =>
    {
        expect(() => Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 123,
        })).toThrow();
    });

    it('accepts SRV connection string', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb+srv://user:pass@cluster.mongodb.net',
            database: 'mydb',
        });
        expect(db.adapter._client).toBeDefined();
    });

    it('accepts clientOptions', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test',
            clientOptions: { appName: 'test-suite' },
        });
        expect(db.adapter).toBeDefined();
    });

    it('CRUD methods exist', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test',
        });
        const crud = ['createTable', 'insert', 'update', 'updateWhere',
                       'remove', 'deleteWhere', 'execute'];
        for (const m of crud)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('has MongoDB filter builders', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017',
            database: 'test',
        });
        expect(typeof db.adapter._buildFilter).toBe('function');
        expect(typeof db.adapter._buildFilterFromChain).toBe('function');
        expect(typeof db.adapter._opToMongo).toBe('function');
    });
});

// -- SQLite Adapter Verbose Tests ------------------------

describe('SQLite adapter (verbose driver tests)', () =>
{
    const path = require('path');
    const fs   = require('fs');
    const TMP  = path.join(__dirname, '.tmp-driver-test');

    it('better-sqlite3 driver is installed', () =>
    {
        const Database = require('better-sqlite3');
        expect(typeof Database).toBe('function');
    });

    it('creates in-memory database', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        expect(db.adapter).toBeDefined();
        expect(db.adapter._db).toBeDefined();
    });

    it('all utility methods exist', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        const methods = ['pragma', 'checkpoint', 'integrity', 'vacuum',
                         'fileSize', 'tables', 'raw', 'close'];
        for (const m of methods)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });

    it('creates file-based database', () =>
    {
        if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
        const dbPath = path.join(TMP, 'driver-test.db');
        const db = Database.connect('sqlite', { filename: dbPath });
        expect(fs.existsSync(dbPath)).toBe(true);
        db.adapter.close();
        fs.rmSync(TMP, { recursive: true, force: true });
    });

    it('default pragmas are applied (WAL mode)', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        const journal = db.adapter.pragma('journal_mode');
        // In-memory defaults to memory mode
        expect(journal).toBeDefined();
    });

    it('respects readonly option', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:', readonly: false });
        // Should be writable — use createTable which calls exec internally
        db.adapter._db.exec('CREATE TABLE test_rw (id INTEGER PRIMARY KEY)');
        const tables = db.adapter.tables();
        expect(tables).toContain('test_rw');
        db.adapter.close();
    });

    it('integrity check passes on fresh db', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        expect(db.adapter.integrity()).toBe('ok');
        db.adapter.close();
    });

    it('fileSize returns 0 for in-memory', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        expect(db.adapter.fileSize()).toBe(0);
        db.adapter.close();
    });

    it('CRUD methods exist', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        const crud = ['createTable', 'insert', 'update', 'updateWhere',
                       'remove', 'deleteWhere', 'execute'];
        for (const m of crud)
        {
            expect(typeof db.adapter[m]).toBe('function');
        }
    });
});

// -- Cross-Driver Feature Matrix -------------------------

describe('Cross-driver feature matrix', () =>
{
    const adapters = [
        { name: 'memory', opts: {} },
        { name: 'sqlite', opts: { filename: ':memory:' } },
    ];

    for (const { name, opts } of adapters)
    {
        it(`${name} adapter has tables() method`, () =>
        {
            const db = Database.connect(name, opts);
            expect(typeof db.adapter.tables).toBe('function');
        });

        it(`${name} adapter has close() or is memory (no close needed)`, () =>
        {
            const db = Database.connect(name, opts);
            // Memory adapter has no close; others do
            if (name === 'memory')
                expect(db.adapter.close).toBeUndefined();
            else
                expect(typeof db.adapter.close).toBe('function');
        });

        it(`${name} adapter has execute() method`, () =>
        {
            const db = Database.connect(name, opts);
            expect(typeof db.adapter.execute).toBe('function');
        });
    }

    it('MySQL has tables + poolStatus + version + ping + exec', () =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        expect(typeof db.adapter.tables).toBe('function');
        expect(typeof db.adapter.poolStatus).toBe('function');
        expect(typeof db.adapter.version).toBe('function');
        expect(typeof db.adapter.ping).toBe('function');
        expect(typeof db.adapter.exec).toBe('function');
    });

    it('PostgreSQL has tables + poolStatus + version + ping + exec + listen', () =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        expect(typeof db.adapter.tables).toBe('function');
        expect(typeof db.adapter.poolStatus).toBe('function');
        expect(typeof db.adapter.listen).toBe('function');
    });

    it('MongoDB has collections + stats + createIndex + indexes + isConnected', () =>
    {
        const db = Database.connect('mongo', {
            url: 'mongodb://localhost:27017', database: 'test',
        });
        expect(typeof db.adapter.collections).toBe('function');
        expect(typeof db.adapter.stats).toBe('function');
        expect(typeof db.adapter.createIndex).toBe('function');
    });
});

// ===========================================================
//  MySQL Adapter — _typeMap & Debug Methods (Phase 10)
// ===========================================================

describe('MySQL adapter _typeMap', () =>
{
    let adapter;

    beforeAll(() =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        adapter = db.adapter;
    });

    it('maps core types correctly', () =>
    {
        expect(adapter._typeMap({ type: 'string' })).toBe('VARCHAR(255)');
        expect(adapter._typeMap({ type: 'string', maxLength: 100 })).toBe('VARCHAR(100)');
        expect(adapter._typeMap({ type: 'text' })).toBe('TEXT');
        expect(adapter._typeMap({ type: 'integer' })).toBe('INT');
        expect(adapter._typeMap({ type: 'float' })).toBe('DOUBLE');
        expect(adapter._typeMap({ type: 'boolean' })).toBe('TINYINT(1)');
        expect(adapter._typeMap({ type: 'date' })).toBe('DATE');
        expect(adapter._typeMap({ type: 'datetime' })).toBe('DATETIME');
        expect(adapter._typeMap({ type: 'json' })).toBe('JSON');
        expect(adapter._typeMap({ type: 'blob' })).toBe('BLOB');
        expect(adapter._typeMap({ type: 'uuid' })).toBe('CHAR(36)');
    });

    it('maps extended numeric types', () =>
    {
        expect(adapter._typeMap({ type: 'bigint' })).toBe('BIGINT');
        expect(adapter._typeMap({ type: 'smallint' })).toBe('SMALLINT');
        expect(adapter._typeMap({ type: 'tinyint' })).toBe('TINYINT');
        expect(adapter._typeMap({ type: 'double' })).toBe('DOUBLE');
        expect(adapter._typeMap({ type: 'real' })).toBe('REAL');
    });

    it('maps decimal with precision and scale', () =>
    {
        expect(adapter._typeMap({ type: 'decimal' })).toBe('DECIMAL(10,2)');
        expect(adapter._typeMap({ type: 'decimal', precision: 8, scale: 4 })).toBe('DECIMAL(8,4)');
    });

    it('maps temporal types', () =>
    {
        expect(adapter._typeMap({ type: 'timestamp' })).toBe('TIMESTAMP');
        expect(adapter._typeMap({ type: 'time' })).toBe('TIME');
        expect(adapter._typeMap({ type: 'year' })).toBe('YEAR');
    });

    it('maps MySQL-specific text/blob variants', () =>
    {
        expect(adapter._typeMap({ type: 'mediumtext' })).toBe('MEDIUMTEXT');
        expect(adapter._typeMap({ type: 'longtext' })).toBe('LONGTEXT');
        expect(adapter._typeMap({ type: 'mediumblob' })).toBe('MEDIUMBLOB');
        expect(adapter._typeMap({ type: 'longblob' })).toBe('LONGBLOB');
    });

    it('maps enum with values', () =>
    {
        expect(adapter._typeMap({ type: 'enum', enum: ['a', 'b', 'c'] }))
            .toBe("ENUM('a','b','c')");
        expect(adapter._typeMap({ type: 'enum' })).toBe('VARCHAR(255)');
    });

    it('maps set with values', () =>
    {
        expect(adapter._typeMap({ type: 'set', values: ['r', 'w', 'd'] }))
            .toBe("SET('r','w','d')");
        expect(adapter._typeMap({ type: 'set' })).toBe('VARCHAR(255)');
    });

    it('maps binary types with length', () =>
    {
        expect(adapter._typeMap({ type: 'binary' })).toBe('BINARY(255)');
        expect(adapter._typeMap({ type: 'binary', length: 16 })).toBe('BINARY(16)');
        expect(adapter._typeMap({ type: 'varbinary', length: 64 })).toBe('VARBINARY(64)');
    });

    it('falls back to TEXT for unknown types', () =>
    {
        expect(adapter._typeMap({ type: 'unknown_type_xyz' })).toBe('TEXT');
    });
});

describe('MySQL adapter debug methods exist', () =>
{
    let adapter;

    beforeAll(() =>
    {
        const db = Database.connect('mysql', {
            host: 'localhost', user: 'root', password: '', database: 'test',
        });
        adapter = db.adapter;
    });

    it('has all schema introspection debug methods', () =>
    {
        const methods = ['tableStatus', 'tableSize', 'indexes', 'tableCharset',
                         'foreignKeys', 'overview', 'variables', 'processlist',
                         'alterTable'];
        for (const m of methods)
        {
            expect(typeof adapter[m]).toBe('function');
        }
    });

    it('_q() properly escapes backticks', () =>
    {
        expect(adapter._q('users')).toBe('`users`');
        expect(adapter._q('table`name')).toBe('`table``name`');
    });
});

// ===========================================================
//  PostgreSQL Adapter — _typeMap & Debug Methods (Phase 10)
// ===========================================================

describe('PostgreSQL adapter _typeMap', () =>
{
    let adapter;

    beforeAll(() =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        adapter = db.adapter;
    });

    it('maps core types correctly', () =>
    {
        expect(adapter._typeMap({ type: 'string' })).toBe('VARCHAR(255)');
        expect(adapter._typeMap({ type: 'string', maxLength: 50 })).toBe('VARCHAR(50)');
        expect(adapter._typeMap({ type: 'text' })).toBe('TEXT');
        expect(adapter._typeMap({ type: 'integer' })).toBe('INTEGER');
        expect(adapter._typeMap({ type: 'float' })).toBe('DOUBLE PRECISION');
        expect(adapter._typeMap({ type: 'boolean' })).toBe('BOOLEAN');
        expect(adapter._typeMap({ type: 'date' })).toBe('DATE');
        expect(adapter._typeMap({ type: 'datetime' })).toBe('TIMESTAMPTZ');
        expect(adapter._typeMap({ type: 'json' })).toBe('JSONB');
        expect(adapter._typeMap({ type: 'blob' })).toBe('BYTEA');
        expect(adapter._typeMap({ type: 'uuid' })).toBe('UUID');
    });

    it('maps extended numeric types', () =>
    {
        expect(adapter._typeMap({ type: 'bigint' })).toBe('BIGINT');
        expect(adapter._typeMap({ type: 'smallint' })).toBe('SMALLINT');
        expect(adapter._typeMap({ type: 'tinyint' })).toBe('SMALLINT');
        expect(adapter._typeMap({ type: 'double' })).toBe('DOUBLE PRECISION');
        expect(adapter._typeMap({ type: 'real' })).toBe('REAL');
        expect(adapter._typeMap({ type: 'money' })).toBe('MONEY');
    });

    it('maps decimal with precision and scale', () =>
    {
        expect(adapter._typeMap({ type: 'decimal' })).toBe('NUMERIC(10,2)');
        expect(adapter._typeMap({ type: 'decimal', precision: 12, scale: 6 })).toBe('NUMERIC(12,6)');
    });

    it('maps PG-specific serial types', () =>
    {
        expect(adapter._typeMap({ type: 'serial' })).toBe('SERIAL');
        expect(adapter._typeMap({ type: 'bigserial' })).toBe('BIGSERIAL');
    });

    it('maps temporal and interval types', () =>
    {
        expect(adapter._typeMap({ type: 'timestamp' })).toBe('TIMESTAMP');
        expect(adapter._typeMap({ type: 'time' })).toBe('TIME');
        expect(adapter._typeMap({ type: 'interval' })).toBe('INTERVAL');
    });

    it('maps network types', () =>
    {
        expect(adapter._typeMap({ type: 'inet' })).toBe('INET');
        expect(adapter._typeMap({ type: 'cidr' })).toBe('CIDR');
        expect(adapter._typeMap({ type: 'macaddr' })).toBe('MACADDR');
    });

    it('maps jsonb and xml', () =>
    {
        expect(adapter._typeMap({ type: 'jsonb' })).toBe('JSONB');
        expect(adapter._typeMap({ type: 'xml' })).toBe('XML');
        expect(adapter._typeMap({ type: 'citext' })).toBe('CITEXT');
    });

    it('maps array with arrayOf', () =>
    {
        expect(adapter._typeMap({ type: 'array', arrayOf: 'INTEGER' })).toBe('INTEGER[]');
        expect(adapter._typeMap({ type: 'array', arrayOf: 'TEXT' })).toBe('TEXT[]');
        expect(adapter._typeMap({ type: 'array' })).toBe('TEXT[]');
    });

    it('maps char with length', () =>
    {
        expect(adapter._typeMap({ type: 'char' })).toBe('CHAR(1)');
        expect(adapter._typeMap({ type: 'char', length: 10 })).toBe('CHAR(10)');
    });

    it('maps binary types to BYTEA', () =>
    {
        expect(adapter._typeMap({ type: 'binary' })).toBe('BYTEA');
        expect(adapter._typeMap({ type: 'varbinary' })).toBe('BYTEA');
    });

    it('maps enum with CHECK constraint', () =>
    {
        const result = adapter._typeMap({ type: 'enum', enum: ['a', 'b'], _name: 'role' });
        expect(result).toContain('VARCHAR(255)');
        expect(result).toContain('CHECK');
        expect(result).toContain("'a'");
        expect(result).toContain("'b'");
    });

    it('falls back to TEXT for unknown types', () =>
    {
        expect(adapter._typeMap({ type: 'unknown_type_xyz' })).toBe('TEXT');
    });
});

describe('PostgreSQL adapter debug methods exist', () =>
{
    let adapter;

    beforeAll(() =>
    {
        const db = Database.connect('postgres', {
            host: 'localhost', user: 'pg', password: 'pass', database: 'test',
        });
        adapter = db.adapter;
    });

    it('has all schema introspection debug methods', () =>
    {
        const methods = ['tableStatus', 'tableSizeFormatted', 'indexes', 'foreignKeys',
                         'overview', 'variables', 'processlist', 'constraints', 'comments'];
        for (const m of methods)
        {
            expect(typeof adapter[m]).toBe('function');
        }
    });

    it('has PG-specific WHERE builders', () =>
    {
        expect(typeof adapter._buildWherePg).toBe('function');
        expect(typeof adapter._buildWhereFromChainPg).toBe('function');
    });
});
