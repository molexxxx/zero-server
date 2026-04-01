/**
 * Tests for middleware barrel exports and ORM Database retry/ping/dropForeignKey.
 * Also covers schema validateFKAction and validateCheck security helpers.
 */

// ===========================================================
//  Middleware barrel exports
// ===========================================================
describe('middleware/index exports', () =>
{
    const middleware = require('../../lib/middleware');

    it('exports all built-in middleware functions', () =>
    {
        expect(typeof middleware.cors).toBe('function');
        expect(typeof middleware.logger).toBe('function');
        expect(typeof middleware.rateLimit).toBe('function');
        expect(typeof middleware.compress).toBe('function');
        expect(typeof middleware.static).toBe('function');
        expect(typeof middleware.helmet).toBe('function');
        expect(typeof middleware.timeout).toBe('function');
        expect(typeof middleware.requestId).toBe('function');
        expect(typeof middleware.cookieParser).toBe('function');
        expect(typeof middleware.errorHandler).toBe('function');
    });

    it('exports exactly the expected keys', () =>
    {
        const keys = Object.keys(middleware).sort();
        expect(keys).toEqual([
            'compress', 'cookieParser', 'cors', 'errorHandler',
            'helmet', 'logger', 'rateLimit', 'requestId', 'static', 'timeout',
        ]);
    });
});

// ===========================================================
//  Schema security helpers
// ===========================================================
describe('schema security helpers', () =>
{
    const { validateFKAction, validateCheck } = require('../../lib/orm/schema');

    describe('validateFKAction', () =>
    {
        it('accepts valid FK actions (case insensitive)', () =>
        {
            expect(validateFKAction('CASCADE')).toBe('CASCADE');
            expect(validateFKAction('set null')).toBe('SET NULL');
            expect(validateFKAction('Set Default')).toBe('SET DEFAULT');
            expect(validateFKAction('restrict')).toBe('RESTRICT');
            expect(validateFKAction('NO ACTION')).toBe('NO ACTION');
        });

        it('rejects invalid FK actions', () =>
        {
            expect(() => validateFKAction('DROP TABLE')).toThrow('Invalid FK action');
            expect(() => validateFKAction('')).toThrow('Invalid FK action');
            expect(() => validateFKAction('DELETE')).toThrow('Invalid FK action');
        });
    });

    describe('validateCheck', () =>
    {
        it('accepts valid CHECK expressions', () =>
        {
            expect(validateCheck('age > 0')).toBe('age > 0');
            expect(validateCheck('status IN (1,2,3)')).toBe('status IN (1,2,3)');
            expect(validateCheck('price >= 0.0')).toBe('price >= 0.0');
        });

        it('rejects SQL injection patterns', () =>
        {
            expect(() => validateCheck('1; DROP TABLE users')).toThrow('Potentially dangerous');
            expect(() => validateCheck('1 -- comment')).toThrow('Potentially dangerous');
            expect(() => validateCheck('DROP foo')).toThrow('Potentially dangerous');
            expect(() => validateCheck('DELETE FROM x')).toThrow('Potentially dangerous');
            expect(() => validateCheck('INSERT INTO x')).toThrow('Potentially dangerous');
            expect(() => validateCheck('UPDATE x SET y=1')).toThrow('Potentially dangerous');
            expect(() => validateCheck('ALTER TABLE x')).toThrow('Potentially dangerous');
            expect(() => validateCheck('CREATE TABLE x')).toThrow('Potentially dangerous');
            expect(() => validateCheck('EXEC sp_help')).toThrow('Potentially dangerous');
        });
    });
});

// ===========================================================
//  ORM Database.retry
// ===========================================================
describe('Database.retry', () =>
{
    const { Database } = require('../../lib/orm');
    let db;

    beforeEach(() =>
    {
        db = Database.connect('memory');
    });

    it('returns result on first try success', async () =>
    {
        const result = await db.retry(async () => 42, { retries: 3 });
        expect(result).toBe(42);
    });

    it('retries on failure and eventually succeeds', async () =>
    {
        let attempt = 0;
        const result = await db.retry(async () =>
        {
            attempt++;
            if (attempt < 3) throw new Error('fail');
            return 'success';
        }, { retries: 5, delay: 10 });
        expect(result).toBe('success');
        expect(attempt).toBe(3);
    });

    it('throws after exhausting retries', async () =>
    {
        await expect(db.retry(async () =>
        {
            throw new Error('always fails');
        }, { retries: 2, delay: 10 })).rejects.toThrow('always fails');
    });

    it('calls onRetry callback', async () =>
    {
        const onRetry = vi.fn();
        let attempt = 0;
        await db.retry(async () =>
        {
            attempt++;
            if (attempt < 3) throw new Error('fail');
            return 'ok';
        }, { retries: 5, delay: 10, onRetry });
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
        expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
    });

    it('respects maxDelay', async () =>
    {
        const start = Date.now();
        let attempt = 0;
        await db.retry(async () =>
        {
            attempt++;
            if (attempt < 3) throw new Error('fail');
            return 'ok';
        }, { retries: 5, delay: 10, maxDelay: 20, factor: 100 });
        // Should complete quickly since maxDelay caps the wait
        expect(Date.now() - start).toBeLessThan(1000);
    });
});

// ===========================================================
//  ORM Database.ping
// ===========================================================
describe('Database.ping', () =>
{
    const { Database } = require('../../lib/orm');

    it('returns true for memory adapter', async () =>
    {
        const db = Database.connect('memory');
        expect(await db.ping()).toBe(true);
    });

    it('returns true when adapter has ping() method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.ping = async () => true;
        expect(await db.ping()).toBe(true);
    });

    it('returns false when adapter ping throws', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.ping = async () => { throw new Error('down'); };
        expect(await db.ping()).toBe(false);
    });
});

// ===========================================================
//  ORM Database.addForeignKey / dropForeignKey
// ===========================================================
describe('Database FK methods', () =>
{
    const { Database } = require('../../lib/orm');

    it('throws when adapter has no addForeignKey', async () =>
    {
        const db = Database.connect('memory');
        await expect(db.addForeignKey('t', 'c', 'rt', 'rc')).rejects.toThrow('addForeignKey');
    });

    it('throws when adapter has no dropForeignKey', async () =>
    {
        const db = Database.connect('memory');
        await expect(db.dropForeignKey('t', 'fk')).rejects.toThrow('dropForeignKey');
    });

    it('delegates to adapter when method exists', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.addForeignKey = vi.fn();
        db.adapter.dropForeignKey = vi.fn();
        await db.addForeignKey('t', 'c', 'rt', 'rc');
        await db.dropForeignKey('t', 'fk');
        expect(db.adapter.addForeignKey).toHaveBeenCalledWith('t', 'c', 'rt', 'rc', {});
        expect(db.adapter.dropForeignKey).toHaveBeenCalledWith('t', 'fk');
    });
});


// =========================================================================
//  orm index — deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('orm index — deep branch coverage', () => {
	it('_validateOptions validates mysql host', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mysql', { host: '' })).toThrow(/host/);
		expect(() => Database.connect('mysql', { host: 123 })).toThrow(/host/);
	});

	it('_validateOptions validates port range', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mysql', { port: 0 })).toThrow(/port/);
		expect(() => Database.connect('mysql', { port: 70000 })).toThrow(/port/);
		expect(() => Database.connect('mysql', { port: 'abc' })).toThrow(/port/);
	});

	it('_validateOptions validates user type', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mysql', { user: 123 })).toThrow(/user/);
	});

	it('_validateOptions validates password type', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mysql', { password: 123 })).toThrow(/password/);
	});

	it('_validateOptions validates database name', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mysql', { database: '' })).toThrow(/database/);
		expect(() => Database.connect('mysql', { database: 123 })).toThrow(/database/);
	});

	it('_validateOptions validates postgres options too', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('postgres', { host: '' })).toThrow(/host/);
		expect(() => Database.connect('postgres', { port: -1 })).toThrow(/port/);
	});

	it('_validateOptions validates mongo url', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('mongo', { url: 123 })).toThrow();
	});

	it('_validateOptions validates sqlite filename', () => {
		const { Database } = require('../../');
		// sqlite with bad options — depends on validation
		expect(() => Database.connect('sqlite', { filename: 123 })).toThrow();
	});

	it('_validateOptions validates redis options', () => {
		const { Database } = require('../../');
		expect(() => Database.connect('redis', { host: '' })).toThrow(/host/);
		expect(() => Database.connect('redis', { port: 99999 })).toThrow(/port/);
		expect(() => Database.connect('redis', { db: 'abc' })).toThrow();
	});

	it('connect returns a Database instance for memory adapter', () => {
		const { Database } = require('../../');
		const db = Database.connect('memory');
		expect(db).toBeDefined();
		expect(db.adapter).toBeDefined();
	});

	it('register and sync models', async () => {
		const { Database, Model, TYPES } = require('../../');
		const db = Database.connect('memory');

		class TestModel extends Model {
			static table = 'test_deep_' + Date.now();
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name: { type: TYPES.STRING },
			};
		}

		db.register(TestModel);
		await db.sync();

		const item = await TestModel.create({ name: 'test' });
		expect(item.name).toBe('test');
		expect(item.id).toBeDefined();
	});

	it('registerAll registers multiple models', async () => {
		const { Database, Model, TYPES } = require('../../');
		const db = Database.connect('memory');

		class M1 extends Model {
			static table = 'ra_m1_' + Date.now();
			static schema = { id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true } };
		}
		class M2 extends Model {
			static table = 'ra_m2_' + Date.now();
			static schema = { id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true } };
		}

		db.registerAll(M1, M2);
		await db.sync();
		expect(await M1.count()).toBe(0);
		expect(await M2.count()).toBe(0);
	});

	it('transaction wraps operations', async () => {
		const { Database, Model, TYPES } = require('../../');
		const db = Database.connect('memory');

		class TxModel extends Model {
			static table = 'tx_test_' + Date.now();
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				val: { type: TYPES.STRING },
			};
		}
		db.register(TxModel);
		await db.sync();

		await db.transaction(async () => {
			await TxModel.create({ val: 'in-tx' });
		});

		expect(await TxModel.count()).toBe(1);
	});

	it('model() retrieves a registered model by name', async () => {
		const { Database, Model, TYPES } = require('../../');
		const db = Database.connect('memory');
		const tbl = 'model_lookup_' + Date.now();

		class LookupModel extends Model {
			static table = tbl;
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				value: { type: TYPES.STRING },
			};
		}
		db.register(LookupModel);
		const found = db.model(tbl);
		expect(found).toBe(LookupModel);
		expect(db.model('nonexistent_' + Date.now())).toBeUndefined();
	});

	it('ping returns true for healthy adapter', async () => {
		const { Database } = require('../../');
		const db = Database.connect('memory');
		const result = await db.ping();
		expect(result).toBe(true);
	});

	it('retry retries a function on failure', async () => {
		const { Database } = require('../../');
		const db = Database.connect('memory');
		let attempts = 0;
		const result = await db.retry(async () => {
			attempts++;
			if (attempts < 3) throw new Error('fail');
			return 'ok';
		}, { retries: 5, delay: 10 });
		expect(result).toBe('ok');
		expect(attempts).toBe(3);
	});

	it('hasTable/hasColumn for memory adapter', async () => {
		const { Database, Model, TYPES } = require('../../');
		const db = Database.connect('memory');
		const tableName = 'ht_test_' + Date.now();

		class HTModel extends Model {
			static table = tableName;
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name: { type: TYPES.STRING },
			};
		}
		db.register(HTModel);
		await db.sync();

		const has = await db.hasTable(tableName);
		expect(has).toBe(true);
	});
});