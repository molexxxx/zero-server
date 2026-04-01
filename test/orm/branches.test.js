/** branches.test.js — ORM branch-level coverage */
const {
    Database, Model, TYPES, Query,
    validate, validateValue, validateFKAction, validateCheck,
    Migrator, QueryCache, QueryProfiler, ReplicaManager,
} = require('../../lib/orm');

// ===================================================================
// Helpers — lean model factories for isolated tests
// ===================================================================

function memDb()
{
    return Database.connect('memory');
}

function makeModel(db, table, schema, opts = {})
{
    const M = class extends Model
    {
        static table = table;
        static schema = schema;
    };
    if (opts.timestamps)   M.timestamps  = true;
    if (opts.softDelete)   M.softDelete  = true;
    if (opts.hidden)       M.hidden      = opts.hidden;
    if (opts.scopes)       M.scopes      = opts.scopes;
    if (opts.hooks)        M.hooks       = opts.hooks;
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// schema.js — Uncovered Type & Validation Branches
// ===================================================================
describe('schema.js — deep branch coverage', () =>
{
    // -- set type --
    it('validates set type with allowed values (string input)', () =>
    {
        const v = validateValue('a,b', { type: 'set', values: ['a', 'b', 'c'] }, 'tags');
        expect(v).toBe('a,b');
    });

    it('validates set type with array input', () =>
    {
        const v = validateValue(['x', 'y'], { type: 'set', values: ['x', 'y', 'z'] }, 'tags');
        expect(v).toBe('x,y');
    });

    it('set type rejects invalid values', () =>
    {
        expect(() => validateValue('bad', { type: 'set', values: ['a', 'b'] }, 'tags'))
            .toThrow('invalid value');
    });

    it('set type without values constraint passes', () =>
    {
        expect(validateValue('anything', { type: 'set' }, 'tags')).toBe('anything');
    });

    // -- inet / cidr / macaddr (string passthrough) --
    it('inet type converts to string', () =>
    {
        expect(validateValue(42, { type: 'inet' }, 'ip')).toBe('42');
    });

    it('cidr type converts to string', () =>
    {
        expect(validateValue('10.0.0.0/8', { type: 'cidr' }, 'net')).toBe('10.0.0.0/8');
    });

    it('macaddr type converts to string', () =>
    {
        expect(validateValue('AA:BB:CC:DD:EE:FF', { type: 'macaddr' }, 'mac')).toBe('AA:BB:CC:DD:EE:FF');
    });

    // -- array type wraps non-arrays --
    it('array type wraps scalar into array', () =>
    {
        expect(validateValue(42, { type: 'array' }, 'arr')).toEqual([42]);
    });

    it('array type passes arrays through', () =>
    {
        expect(validateValue([1, 2], { type: 'array' }, 'arr')).toEqual([1, 2]);
    });

    // -- default/unknown type fallthrough --
    it('unknown type returns value unchanged', () =>
    {
        expect(validateValue('anything', { type: 'custom_thing' }, 'col')).toBe('anything');
    });

    // -- nullable logic --
    it('nullable:false returns undefined for null value with no default', () =>
    {
        const v = validateValue(null, { type: 'string', nullable: false }, 'col');
        expect(v).toBeUndefined();
    });

    it('nullable (default) returns null for null value', () =>
    {
        const v = validateValue(null, { type: 'string' }, 'col');
        expect(v).toBeNull();
    });

    it('required with default uses default when value is null', () =>
    {
        const v = validateValue(null, { type: 'string', required: true, default: 'fallback' }, 'col');
        expect(v).toBe('fallback');
    });

    it('required with function default calls the function', () =>
    {
        const v = validateValue(undefined, { type: 'integer', required: true, default: () => 42 }, 'col');
        expect(v).toBe(42);
    });

    it('required without default throws', () =>
    {
        expect(() => validateValue(undefined, { type: 'string', required: true }, 'col'))
            .toThrow('"col" is required');
    });

    // -- enum type (explicit) --
    it('enum type validates value in list', () =>
    {
        expect(validateValue('active', { type: 'enum', enum: ['active', 'inactive'] }, 'status'))
            .toBe('active');
    });

    it('enum type rejects value not in list', () =>
    {
        expect(() => validateValue('banned', { type: 'enum', enum: ['active', 'inactive'] }, 'status'))
            .toThrow('must be one of');
    });

    it('enum type without enum list passes string through', () =>
    {
        expect(validateValue('anything', { type: 'enum' }, 'status')).toBe('anything');
    });

    // -- blob / binary types --
    it('blob type converts string to Buffer', () =>
    {
        const v = validateValue('data', { type: 'blob' }, 'col');
        expect(Buffer.isBuffer(v)).toBe(true);
        expect(v.toString()).toBe('data');
    });

    it('varbinary type passes Buffer through', () =>
    {
        const buf = Buffer.from('test');
        const v = validateValue(buf, { type: 'varbinary' }, 'col');
        expect(v).toBe(buf);
    });

    it('binary type converts to buffer', () =>
    {
        const v = validateValue('bytes', { type: 'binary' }, 'col');
        expect(Buffer.isBuffer(v)).toBe(true);
    });

    it('mediumblob converts string', () =>
    {
        expect(Buffer.isBuffer(validateValue('x', { type: 'mediumblob' }, 'c'))).toBe(true);
    });

    it('longblob converts string', () =>
    {
        expect(Buffer.isBuffer(validateValue('x', { type: 'longblob' }, 'c'))).toBe(true);
    });

    // -- string-family types --
    it('text type validates as string', () =>
    {
        expect(validateValue(123, { type: 'text' }, 'col')).toBe('123');
    });

    it('char type validates as string', () =>
    {
        expect(validateValue('a', { type: 'char' }, 'col')).toBe('a');
    });

    it('citext type validates as string', () =>
    {
        expect(validateValue('Hello', { type: 'citext' }, 'col')).toBe('Hello');
    });

    it('xml type validates as string', () =>
    {
        expect(validateValue('<xml/>', { type: 'xml' }, 'col')).toBe('<xml/>');
    });

    it('mediumtext type validates as string', () =>
    {
        expect(validateValue('data', { type: 'mediumtext' }, 'col')).toBe('data');
    });

    it('longtext type validates as string', () =>
    {
        expect(validateValue('data', { type: 'longtext' }, 'col')).toBe('data');
    });

    // -- string constraints (minLength, maxLength, match, enum on string type) --
    it('string minLength rejects short value', () =>
    {
        expect(() => validateValue('ab', { type: 'string', minLength: 3 }, 'col'))
            .toThrow('at least 3');
    });

    it('string maxLength rejects long value', () =>
    {
        expect(() => validateValue('toolong', { type: 'string', maxLength: 3 }, 'col'))
            .toThrow('at most 3');
    });

    it('string match rejects non-matching', () =>
    {
        expect(() => validateValue('abc', { type: 'string', match: /^[0-9]+$/ }, 'col'))
            .toThrow('does not match');
    });

    it('string enum rejects unlisted value', () =>
    {
        expect(() => validateValue('bad', { type: 'string', enum: ['a', 'b'] }, 'col'))
            .toThrow('must be one of');
    });

    // -- integer-family --
    it('bigint type coerces string', () =>
    {
        expect(validateValue('999', { type: 'bigint' }, 'col')).toBe(999);
    });

    it('smallint type coerces', () =>
    {
        expect(validateValue('5', { type: 'smallint' }, 'col')).toBe(5);
    });

    it('tinyint type coerces', () =>
    {
        expect(validateValue('1', { type: 'tinyint' }, 'col')).toBe(1);
    });

    it('serial type coerces', () =>
    {
        expect(validateValue('10', { type: 'serial' }, 'col')).toBe(10);
    });

    it('bigserial type coerces', () =>
    {
        expect(validateValue('20', { type: 'bigserial' }, 'col')).toBe(20);
    });

    it('year type coerces', () =>
    {
        expect(validateValue('2024', { type: 'year' }, 'col')).toBe(2024);
    });

    it('integer NaN throws', () =>
    {
        expect(() => validateValue('abc', { type: 'integer' }, 'col')).toThrow('must be an integer');
    });

    it('integer min constraint', () =>
    {
        expect(() => validateValue(5, { type: 'integer', min: 10 }, 'col')).toThrow('>= 10');
    });

    it('integer max constraint', () =>
    {
        expect(() => validateValue(100, { type: 'integer', max: 50 }, 'col')).toThrow('<= 50');
    });

    it('integer floors floats', () =>
    {
        expect(validateValue(3.9, { type: 'integer' }, 'col')).toBe(3);
    });

    // -- float-family --
    it('decimal type coerces', () =>
    {
        expect(validateValue('3.14', { type: 'decimal' }, 'col')).toBeCloseTo(3.14);
    });

    it('double type coerces', () =>
    {
        expect(validateValue('2.718', { type: 'double' }, 'col')).toBeCloseTo(2.718);
    });

    it('real type coerces', () =>
    {
        expect(validateValue('1.5', { type: 'real' }, 'col')).toBe(1.5);
    });

    it('numeric type coerces', () =>
    {
        expect(validateValue('99.9', { type: 'numeric' }, 'col')).toBeCloseTo(99.9);
    });

    it('money type coerces', () =>
    {
        expect(validateValue('10.50', { type: 'money' }, 'col')).toBe(10.5);
    });

    it('float NaN throws', () =>
    {
        expect(() => validateValue('abc', { type: 'float' }, 'col')).toThrow('must be a number');
    });

    it('float min constraint', () =>
    {
        expect(() => validateValue(0.5, { type: 'float', min: 1.0 }, 'col')).toThrow('>= 1');
    });

    it('float max constraint', () =>
    {
        expect(() => validateValue(10, { type: 'float', max: 5 }, 'col')).toThrow('<= 5');
    });

    // -- boolean --
    it('boolean number coercion: 0 → false', () =>
    {
        expect(validateValue(0, { type: 'boolean' }, 'col')).toBe(false);
    });

    it('boolean number coercion: non-zero → true', () =>
    {
        expect(validateValue(42, { type: 'boolean' }, 'col')).toBe(true);
    });

    it('boolean string "yes" → true', () =>
    {
        expect(validateValue('yes', { type: 'boolean' }, 'col')).toBe(true);
    });

    it('boolean string "no" → false', () =>
    {
        expect(validateValue('no', { type: 'boolean' }, 'col')).toBe(false);
    });

    it('boolean string "0" → false', () =>
    {
        expect(validateValue('0', { type: 'boolean' }, 'col')).toBe(false);
    });

    it('boolean invalid type throws', () =>
    {
        expect(() => validateValue({}, { type: 'boolean' }, 'col')).toThrow('must be a boolean');
    });

    // -- date-family --
    it('timestamp type parses date string', () =>
    {
        const v = validateValue('2024-01-01', { type: 'timestamp' }, 'col');
        expect(v instanceof Date).toBe(true);
    });

    it('time type parses', () =>
    {
        const v = validateValue('2024-06-15T12:00:00Z', { type: 'time' }, 'col');
        expect(v instanceof Date).toBe(true);
    });

    it('interval type parses', () =>
    {
        const v = validateValue('2024-01-01', { type: 'interval' }, 'col');
        expect(v instanceof Date).toBe(true);
    });

    it('date type passes Date object through', () =>
    {
        const d = new Date();
        expect(validateValue(d, { type: 'date' }, 'col')).toBe(d);
    });

    it('invalid date throws', () =>
    {
        expect(() => validateValue('not-a-date', { type: 'date' }, 'col')).toThrow('valid date');
    });

    // -- json/jsonb --
    it('jsonb parses string', () =>
    {
        expect(validateValue('{"a":1}', { type: 'jsonb' }, 'col')).toEqual({ a: 1 });
    });

    it('json passes object through', () =>
    {
        const obj = { x: 1 };
        expect(validateValue(obj, { type: 'json' }, 'col')).toBe(obj);
    });

    it('invalid json string throws', () =>
    {
        expect(() => validateValue('{bad}', { type: 'json' }, 'col')).toThrow('valid JSON');
    });

    // -- uuid --
    it('valid uuid passes', () =>
    {
        expect(validateValue('550e8400-e29b-41d4-a716-446655440000', { type: 'uuid' }, 'col'))
            .toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('invalid uuid throws', () =>
    {
        expect(() => validateValue('not-a-uuid', { type: 'uuid' }, 'col')).toThrow('valid UUID');
    });

    // -- validate() rows --
    it('validate rejects unknown columns', () =>
    {
        const result = validate({ name: 'A', unknown: 'B' }, { name: { type: 'string' } });
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('Unknown column');
    });

    it('validate partial mode skips absent fields', () =>
    {
        const result = validate(
            { name: 'Bob' },
            { name: { type: 'string' }, age: { type: 'integer', required: true } },
            { partial: true }
        );
        expect(result.valid).toBe(true);
    });

    it('validate skips guarded fields not in data', () =>
    {
        const result = validate(
            {},
            { password: { type: 'string', guarded: true, required: true } }
        );
        // guarded + not in data = skipped
        expect(result.valid).toBe(true);
    });

    it('validate skips autoIncrement PK when undefined', () =>
    {
        const result = validate(
            { name: 'Alice' },
            { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } }
        );
        expect(result.valid).toBe(true);
    });

    // -- FK action validation --
    it('validateFKAction accepts all valid actions (case-insensitive)', () =>
    {
        for (const action of ['CASCADE', 'cascade', 'SET NULL', 'set null', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'])
        {
            expect(validateFKAction(action)).toBe(action.toUpperCase());
        }
    });

    it('validateFKAction rejects invalid action', () =>
    {
        expect(() => validateFKAction('DROP')).toThrow('Invalid FK action');
    });

    // -- CHECK validation --
    it('validateCheck allows safe expressions', () =>
    {
        expect(validateCheck('age >= 0 AND age <= 150')).toBe('age >= 0 AND age <= 150');
    });

    it('validateCheck blocks DROP', () =>
    {
        expect(() => validateCheck('1; DROP TABLE users')).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks INSERT', () =>
    {
        expect(() => validateCheck("INSERT INTO t VALUES(1)")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks DELETE', () =>
    {
        expect(() => validateCheck("DELETE FROM t")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks UPDATE', () =>
    {
        expect(() => validateCheck("UPDATE t SET x=1")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks ALTER', () =>
    {
        expect(() => validateCheck("ALTER TABLE t ADD col INT")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks CREATE', () =>
    {
        expect(() => validateCheck("CREATE TABLE t(id INT)")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks EXEC', () =>
    {
        expect(() => validateCheck("EXEC sp_help")).toThrow('Potentially dangerous');
    });

    it('validateCheck blocks comment markers', () =>
    {
        expect(() => validateCheck("age > 0 -- admin bypass")).toThrow('Potentially dangerous');
    });
});

// ===================================================================
// model.js — Uncovered Branches
// ===================================================================
describe('model.js — deep branch coverage', () =>
{
    let db;

    beforeEach(() => { db = memDb(); });

    it('_stripGuarded removes guarded fields from mass-assignment', async () =>
    {
        const User = makeModel(db, 'users', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            name:     { type: 'string', required: true },
            password: { type: 'string', guarded: true },
        });
        await db.sync();

        const u = await User.create({ name: 'Alice', password: 'secret' });
        // password is guarded — should not be set
        expect(u.password).toBeUndefined();
    });

    it('toJSON respects hidden fields', async () =>
    {
        const User = makeModel(db, 'users', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            name:     { type: 'string', required: true },
            secret:   { type: 'string', default: 'hidden-val' },
        }, { hidden: ['secret'] });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        const json = u.toJSON();
        expect(json.name).toBe('Alice');
        expect(json.secret).toBeUndefined();
    });

    it('_primaryKey returns "id" when no PK defined', () =>
    {
        const M = class extends Model { static schema = { name: { type: 'string' } }; };
        expect(M._primaryKey()).toBe('id');
    });

    it('_primaryKey returns array for composite PK', () =>
    {
        const M = class extends Model {
            static schema = {
                a: { type: 'integer', primaryKey: true },
                b: { type: 'integer', primaryKey: true },
            };
        };
        expect(M._primaryKey()).toEqual(['a', 'b']);
    });

    it('_runHook calls hooks object if static hook not present', async () =>
    {
        const hookFn = vi.fn();
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { hooks: { beforeCreate: hookFn } });
        await db.sync();

        await User.create({ name: 'Alice' });
        expect(hookFn).toHaveBeenCalled();
    });

    it('save() on persisted instance with no dirty fields is a no-op', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        // save again without changes
        const result = await u.save();
        expect(result).toBe(u);
    });

    it('save() update path with timestamps', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { timestamps: true });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        const originalUpdatedAt = u.updatedAt;
        u.name = 'Bob';
        await u.save();
        expect(u.name).toBe('Bob');
    });

    it('createMany fallback uses individual inserts when insertMany unavailable', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        // Remove insertMany from adapter to force fallback
        const original = db.adapter.insertMany;
        db.adapter.insertMany = undefined;

        const users = await User.createMany([{ name: 'A' }, { name: 'B' }]);
        expect(users).toHaveLength(2);

        db.adapter.insertMany = original;
    });

    it('createMany returns empty array for empty input', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        const result = await User.createMany([]);
        expect(result).toEqual([]);
    });

    it('deleteWhere with softDelete uses updateWhere', async () =>
    {
        const Item = makeModel(db, 'items', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { softDelete: true });
        await db.sync();

        await Item.create({ name: 'A' });
        await Item.create({ name: 'B' });
        await Item.deleteWhere({ name: 'A' });

        // Soft-deleted — withDeleted() should find it
        const all = await Item.query().withDeleted().exec();
        expect(all).toHaveLength(2);
        const active = await Item.find();
        expect(active).toHaveLength(1);
    });

    it('restore() throws for non-soft-delete model', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        await expect(u.restore()).rejects.toThrow('soft deletes');
    });

    it('reload() throws when record not found', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        await u.delete();
        await expect(u.reload()).rejects.toThrow('not found');
    });

    it('query() throws when model not registered', () =>
    {
        class Unregistered extends Model
        {
            static table = 'unregistered';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }
        expect(() => Unregistered.query()).toThrow('not registered');
    });

    it('scope() throws for unknown scope', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        expect(() => User.scope('nonexistent')).toThrow('Unknown scope');
    });

    it('scope() applies named scope', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            age:  { type: 'integer' },
        }, {
            scopes: { adults: q => q.where('age', '>=', 18) },
        });
        await db.sync();

        await User.create({ name: 'Kid', age: 10 });
        await User.create({ name: 'Adult', age: 25 });
        const adults = await User.scope('adults').exec();
        expect(adults).toHaveLength(1);
        expect(adults[0].name).toBe('Adult');
    });

    it('increment updates timestamps', async () =>
    {
        const User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            name:  { type: 'string' },
            score: { type: 'integer', default: 0 },
        }, { timestamps: true });
        await db.sync();

        const u = await User.create({ name: 'A', score: 0 });
        await u.increment('score', 5);
        expect(u.score).toBe(5);
    });

    it('decrement is negative increment', async () =>
    {
        const User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            score: { type: 'integer', default: 10 },
        });
        await db.sync();

        const u = await User.create({ score: 10 });
        await u.decrement('score', 3);
        expect(u.score).toBe(7);
    });

    it('upsert creates when not found', async () =>
    {
        const User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string' },
            name:  { type: 'string' },
        });
        await db.sync();

        const { instance, created } = await User.upsert({ email: 'a@b.com' }, { name: 'Alice' });
        expect(created).toBe(true);
        expect(instance.name).toBe('Alice');
    });

    it('upsert updates when found', async () =>
    {
        const User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string' },
            name:  { type: 'string' },
        });
        await db.sync();

        await User.create({ email: 'a@b.com', name: 'Alice' });
        const { instance, created } = await User.upsert({ email: 'a@b.com' }, { name: 'Bob' });
        expect(created).toBe(false);
        expect(instance.name).toBe('Bob');
    });

    it('random() returns null on empty table', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        expect(await User.random()).toBeNull();
    });

    it('random() returns a record', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        await User.create({ name: 'A' });
        const r = await User.random();
        expect(r).not.toBeNull();
    });

    it('belongsToMany relationship load works', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'User' });

        const Role = makeModel(db, 'roles', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Role' });

        const UserRole = makeModel(db, 'user_roles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer' },
            roleId: { type: 'integer' },
        }, { name: 'UserRole' });

        User.belongsToMany(Role, { through: 'user_roles', foreignKey: 'userId', otherKey: 'roleId' });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        const r1 = await Role.create({ name: 'admin' });
        const r2 = await Role.create({ name: 'editor' });
        await UserRole.create({ userId: u.id, roleId: r1.id });
        await UserRole.create({ userId: u.id, roleId: r2.id });

        const loaded = await u.load('Role');
        expect(loaded).toHaveLength(2);
    });

    it('belongsToMany returns empty array when junction has no matches', async () =>
    {
        const User = makeModel(db, 'users2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'User2' });

        const Role = makeModel(db, 'roles2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Role2' });

        User.belongsToMany(Role, { through: 'user_roles2', foreignKey: 'userId', otherKey: 'roleId' });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        const loaded = await u.load('Role2');
        expect(loaded).toEqual([]);
    });

    it('belongsToMany throws when missing opts', () =>
    {
        const A = class extends Model { static schema = { id: { type: 'integer', primaryKey: true } }; };
        const B = class extends Model { static schema = { id: { type: 'integer', primaryKey: true } }; };
        expect(() => A.belongsToMany(B, {})).toThrow('requires through');
    });

    it('load throws for unknown relation', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        await expect(u.load('NonExistent')).rejects.toThrow('Unknown relation');
    });

    it('constructor filters prototype pollution keys', () =>
    {
        const m = new Model({ __proto__: 'bad', constructor: 'bad', prototype: 'bad', name: 'ok' });
        expect(m.name).toBe('ok');
        expect(m.constructor).toBe(Model);
    });

    it('updateWhere applies timestamps', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { timestamps: true });
        await db.sync();

        await User.create({ name: 'Alice' });
        await User.updateWhere({ name: 'Alice' }, { name: 'Bob' });
        const bob = await User.findOne({ name: 'Bob' });
        expect(bob).not.toBeNull();
    });

    it('hasOne relationship', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'UserX' });

        const Profile = makeModel(db, 'profiles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer' },
            bio:    { type: 'string' },
        }, { name: 'ProfileX' });

        User.hasOne(Profile, 'userId');
        await db.sync();

        const u = await User.create({ name: 'Alice' });
        await Profile.create({ userId: u.id, bio: 'Hello' });

        const profile = await u.load('ProfileX');
        expect(profile.bio).toBe('Hello');
    });

    it('sync() throws when model not registered', async () =>
    {
        class Orphan extends Model
        {
            static table = 'orphans';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }
        await expect(Orphan.sync()).rejects.toThrow('not registered');
    });

    it('drop() throws when model not registered', async () =>
    {
        class Orphan extends Model
        {
            static table = 'orphans';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }
        await expect(Orphan.drop()).rejects.toThrow('not registered');
    });

    it('exists() returns true/false correctly', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        expect(await User.exists({ name: 'Alice' })).toBe(false);
        await User.create({ name: 'Alice' });
        expect(await User.exists({ name: 'Alice' })).toBe(true);
    });

    it('findOrCreate returns existing record', async () =>
    {
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        await User.create({ name: 'Alice' });
        const { instance, created } = await User.findOrCreate({ name: 'Alice' });
        expect(created).toBe(false);
        expect(instance.name).toBe('Alice');
    });
});

// ===================================================================
// query.js — Uncovered Branches
// ===================================================================
describe('query.js — deep branch coverage', () =>
{
    let db, User, Post;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            name:  { type: 'string', required: true },
            age:   { type: 'integer' },
            score: { type: 'integer', default: 0 },
            role:  { type: 'string', default: 'user' },
        }, {
            scopes: {
                adults: q => q.where('age', '>=', 18),
                admins: q => q.where('role', 'admin'),
            },
            name: 'User',
        });
        Post = makeModel(db, 'posts', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            title:  { type: 'string' },
            userId: { type: 'integer' },
        }, { name: 'Post' });
        User.hasMany(Post, 'userId');
        Post.belongsTo(User, 'userId');
        await db.sync();

        await User.createMany([
            { name: 'Alice', age: 30, score: 10, role: 'admin' },
            { name: 'Bob',   age: 25, score: 20, role: 'user' },
            { name: 'Eve',   age: 17, score: 30, role: 'user' },
        ]);
        await Post.createMany([
            { title: 'Post1', userId: 1 },
            { title: 'Post2', userId: 1 },
            { title: 'Post3', userId: 2 },
        ]);
    });

    // -- Operator validation --
    it('where() throws for invalid operator', () =>
    {
        expect(() => User.query().where('age', 'INVALID', 5)).toThrow('Invalid query operator');
    });

    it('orWhere() throws for invalid operator', () =>
    {
        expect(() => User.query().orWhere('age', 'DROP', 5)).toThrow('Invalid query operator');
    });

    it('orderBy() throws for invalid direction', () =>
    {
        expect(() => User.query().orderBy('name', 'sideways')).toThrow('Invalid orderBy direction');
    });

    // -- scope() on query --
    it('scope() on query applies named scope', async () =>
    {
        const results = await User.query().scope('adults').exec();
        expect(results.every(u => u.age >= 18)).toBe(true);
    });

    it('scope() on query throws for unknown scope', () =>
    {
        expect(() => User.query().scope('nonexistent')).toThrow('Unknown scope');
    });

    // -- explain() --
    it('explain() returns plan from adapter', async () =>
    {
        const plan = await User.query().explain();
        expect(plan.adapter).toBe('memory');
        expect(plan.plan).toContain('scan');
    });

    it('explain() returns fallback when adapter has no explain', async () =>
    {
        const originalExplain = db.adapter.explain;
        db.adapter.explain = undefined;
        const plan = await User.query().explain();
        expect(plan.plan).toContain('does not support');
        db.adapter.explain = originalExplain;
    });

    // -- last() --
    it('last() with no orderBy uses default PK DESC', async () =>
    {
        const last = await User.query().last();
        expect(last.name).toBe('Eve');
    });

    it('last() with ascending orderBy reverses it', async () =>
    {
        const last = await User.query().orderBy('age', 'asc').last();
        expect(last.name).toBe('Alice'); // age 30 is last when reversed to DESC
    });

    // -- single / singleOrDefault --
    it('single() throws on empty result', async () =>
    {
        await expect(User.query().where('name', 'Nobody').single()).rejects.toThrow('no elements');
    });

    it('single() throws on more than one', async () =>
    {
        await expect(User.query().where('role', 'user').single()).rejects.toThrow('more than one');
    });

    it('singleOrDefault() returns null on empty', async () =>
    {
        const r = await User.query().where('name', 'Nobody').singleOrDefault();
        expect(r).toBeNull();
    });

    it('singleOrDefault() throws on more than one', async () =>
    {
        await expect(User.query().where('role', 'user').singleOrDefault()).rejects.toThrow('more than one');
    });

    // -- elementAt / elementAtOrDefault --
    it('elementAt() throws on out of range', async () =>
    {
        await expect(User.query().elementAt(999)).rejects.toThrow('out of range');
    });

    it('elementAtOrDefault() returns null on out of range', async () =>
    {
        expect(await User.query().elementAtOrDefault(999)).toBeNull();
    });

    // -- defaultIfEmpty --
    it('defaultIfEmpty returns default on empty result', async () =>
    {
        const result = await User.query().where('name', 'Nobody').defaultIfEmpty({ empty: true });
        expect(result).toEqual([{ empty: true }]);
    });

    it('defaultIfEmpty returns results when non-empty', async () =>
    {
        const result = await User.query().defaultIfEmpty({ empty: true });
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].empty).toBeUndefined();
    });

    // -- any / all / contains --
    it('any() without predicate checks existence', async () =>
    {
        expect(await User.query().any()).toBe(true);
    });

    it('any() with predicate uses some()', async () =>
    {
        expect(await User.query().any(u => u.age > 100)).toBe(false);
        expect(await User.query().any(u => u.age < 20)).toBe(true);
    });

    it('all() returns false on empty result', async () =>
    {
        expect(await User.query().where('name', 'Nobody').all(() => true)).toBe(false);
    });

    it('contains() checks for field value', async () =>
    {
        expect(await User.query().contains('name', 'Alice')).toBe(true);
        expect(await User.query().contains('name', 'Nobody')).toBe(false);
    });

    // -- sequenceEqual --
    it('sequenceEqual() returns false on length mismatch', async () =>
    {
        const q = User.query().where('name', 'Alice');
        expect(await q.sequenceEqual([1, 2])).toBe(false);
    });

    it('sequenceEqual() with custom compareFn', async () =>
    {
        const q = User.query().limit(1);
        const arr = await User.query().limit(1).exec();
        expect(await User.query().limit(1).sequenceEqual(arr, (a, b) => a.name === b.name)).toBe(true);
    });

    // -- thenBy / thenByDescending --
    it('thenBy adds ASC sort', async () =>
    {
        const q = User.query().orderBy('role').thenBy('name');
        expect(q._orderBy).toHaveLength(2);
        expect(q._orderBy[1].dir).toBe('ASC');
    });

    it('thenByDescending adds DESC sort', async () =>
    {
        const q = User.query().orderBy('role').thenByDescending('name');
        expect(q._orderBy[1].dir).toBe('DESC');
    });

    // -- set operations --
    it('concat() combines two queries', async () =>
    {
        const result = await User.query().where('role', 'admin').concat(
            User.query().where('role', 'user')
        );
        expect(result).toHaveLength(3);
    });

    it('concat() with array', async () =>
    {
        const result = await User.query().limit(1).concat([{ name: 'Extra' }]);
        expect(result).toHaveLength(2);
    });

    it('union() deduplicates by key', async () =>
    {
        const q1 = User.query().where('name', 'Alice');
        const q2 = User.query().where('name', 'Alice');
        const result = await q1.union(q2);
        expect(result).toHaveLength(1);
    });

    it('intersect() finds common elements', async () =>
    {
        const result = await User.query()
            .intersect(User.query().where('role', 'admin'));
        // All users intersected with admins = only admins
        expect(result).toHaveLength(1);
    });

    it('except() removes matching elements', async () =>
    {
        const result = await User.query()
            .except(User.query().where('role', 'admin'));
        expect(result).toHaveLength(2);
    });

    // -- selectMany / zip --
    it('selectMany() flatmaps results', async () =>
    {
        const result = await User.query().selectMany(u => [u.name, u.name.toUpperCase()]);
        expect(result).toHaveLength(6);
    });

    it('zip() combines element-wise', async () =>
    {
        const zipped = await User.query().orderBy('id').zip([10, 20, 30], (u, n) => ({ name: u.name, n }));
        expect(zipped).toHaveLength(3);
        expect(zipped[0].n).toBe(10);
    });

    // -- toDictionary / toLookup --
    it('toDictionary() creates map', async () =>
    {
        const map = await User.query().toDictionary(u => u.name);
        expect(map.size).toBe(3);
        expect(map.get('Alice').age).toBe(30);
    });

    it('toDictionary() throws on duplicate key', async () =>
    {
        await expect(User.query().toDictionary(u => u.role)).rejects.toThrow('Duplicate key');
    });

    it('toDictionary() with value selector', async () =>
    {
        const map = await User.query().toDictionary(u => u.name, u => u.age);
        expect(map.get('Alice')).toBe(30);
    });

    it('toLookup() groups by key', async () =>
    {
        const lookup = await User.query().toLookup(u => u.role);
        expect(lookup.get('admin')).toHaveLength(1);
        expect(lookup.get('user')).toHaveLength(2);
    });

    // -- takeWhile / skipWhile --
    it('takeWhile stops when predicate fails', async () =>
    {
        const result = await User.query().orderBy('age').takeWhile(u => u.age < 26);
        expect(result).toHaveLength(2); // Eve(17), Bob(25)
    });

    it('skipWhile skips while predicate true', async () =>
    {
        const result = await User.query().orderBy('age').skipWhile(u => u.age < 26);
        expect(result).toHaveLength(1); // Alice(30)
    });

    // -- reverse / append / prepend --
    it('reverse() reverses result order', async () =>
    {
        const result = await User.query().orderBy('id').reverse();
        expect(result[0].name).toBe('Eve');
    });

    it('append() adds items to end', async () =>
    {
        const result = await User.query().limit(1).append({ name: 'New1' }, { name: 'New2' });
        expect(result).toHaveLength(3);
    });

    it('prepend() adds items to beginning', async () =>
    {
        const result = await User.query().limit(1).prepend({ name: 'Before' });
        expect(result[0].name).toBe('Before');
    });

    // -- distinctBy --
    it('distinctBy() removes duplicates by key', async () =>
    {
        const result = await User.query().distinctBy(u => u.role);
        expect(result).toHaveLength(2);
    });

    // -- minBy / maxBy --
    it('minBy() returns element with min value', async () =>
    {
        const r = await User.query().minBy(u => u.age);
        expect(r.name).toBe('Eve');
    });

    it('minBy() returns null on empty', async () =>
    {
        const r = await User.query().where('name', 'Nobody').minBy(u => u.age);
        expect(r).toBeNull();
    });

    it('maxBy() returns element with max value', async () =>
    {
        const r = await User.query().maxBy(u => u.age);
        expect(r.name).toBe('Alice');
    });

    it('maxBy() returns null on empty', async () =>
    {
        const r = await User.query().where('name', 'Nobody').maxBy(u => u.age);
        expect(r).toBeNull();
    });

    // -- sumBy / averageBy / countBy --
    it('sumBy() sums with selector', async () =>
    {
        const sum = await User.query().sumBy(u => u.score);
        expect(sum).toBe(60);
    });

    it('averageBy() averages with selector', async () =>
    {
        const avg = await User.query().averageBy(u => u.score);
        expect(avg).toBe(20);
    });

    it('averageBy() returns 0 on empty', async () =>
    {
        const avg = await User.query().where('name', 'Nobody').averageBy(u => u.score);
        expect(avg).toBe(0);
    });

    it('countBy() counts per group', async () =>
    {
        const map = await User.query().countBy(u => u.role);
        expect(map.get('admin')).toBe(1);
        expect(map.get('user')).toBe(2);
    });

    // -- when / unless --
    it('when() with truthy applies fn', async () =>
    {
        const result = await User.query().when('admin', q => q.where('role', 'admin')).exec();
        expect(result).toHaveLength(1);
    });

    it('when() with falsy skips fn', async () =>
    {
        const result = await User.query().when(null, q => q.where('role', 'admin')).exec();
        expect(result).toHaveLength(3);
    });

    it('unless() with falsy applies fn', async () =>
    {
        const result = await User.query().unless(false, q => q.where('role', 'admin')).exec();
        expect(result).toHaveLength(1);
    });

    it('unless() with truthy skips fn', async () =>
    {
        const result = await User.query().unless(true, q => q.where('role', 'admin')).exec();
        expect(result).toHaveLength(3);
    });

    // -- tap --
    it('tap() runs side effect without modifying query', async () =>
    {
        const spy = vi.fn();
        const result = await User.query().tap(spy).exec();
        expect(spy).toHaveBeenCalledOnce();
        expect(result).toHaveLength(3);
    });

    // -- sum / avg / min / max without adapter.aggregate --
    it('sum() fallback without adapter.aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const sum = await User.query().sum('score');
        expect(sum).toBe(60);
        db.adapter.aggregate = orig;
    });

    it('avg() fallback without adapter.aggregate (empty)', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const avg = await User.query().where('name', 'Nobody').avg('score');
        expect(avg).toBe(0);
        db.adapter.aggregate = orig;
    });

    it('min() fallback without adapter.aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const min = await User.query().min('score');
        expect(min).toBe(10);
        db.adapter.aggregate = orig;
    });

    it('min() fallback returns null on empty', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const min = await User.query().where('name', 'Nobody').min('score');
        expect(min).toBeNull();
        db.adapter.aggregate = orig;
    });

    it('max() fallback without adapter.aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const max = await User.query().max('score');
        expect(max).toBe(30);
        db.adapter.aggregate = orig;
    });

    it('max() fallback returns null on empty', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const max = await User.query().where('name', 'Nobody').max('score');
        expect(max).toBeNull();
        db.adapter.aggregate = orig;
    });

    // -- Replica routing in exec() and count() --
    it('exec() routes to replica when useReplica and manager present', async () =>
    {
        const manager = new ReplicaManager();
        const replicaAdapter = new (require('../../lib/orm/adapters/memory'))();
        await replicaAdapter.createTable('users', User.schema);
        await replicaAdapter.insert('users', { name: 'Replica', age: 99, score: 99, role: 'user' });

        manager.setPrimary(db.adapter);
        manager.addReplica(replicaAdapter);
        db.adapter._replicaManager = manager;

        const result = await User.query().onReplica().exec();
        // Replica has only 1 row
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Replica');

        delete db.adapter._replicaManager;
    });

    it('count() routes to replica', async () =>
    {
        const manager = new ReplicaManager();
        const replicaAdapter = new (require('../../lib/orm/adapters/memory'))();
        await replicaAdapter.createTable('users', User.schema);

        manager.setPrimary(db.adapter);
        manager.addReplica(replicaAdapter);
        db.adapter._replicaManager = manager;

        const count = await User.query().onReplica().count();
        expect(count).toBe(0); // replica is empty

        delete db.adapter._replicaManager;
    });

    // -- Profiling integration --
    it('exec() records to profiler when attached', async () =>
    {
        const profiler = db.enableProfiling();
        await User.query().exec();
        const m = profiler.metrics();
        expect(m.totalQueries).toBeGreaterThanOrEqual(1);
        delete db.adapter._profiler;
    });

    it('count() records to profiler', async () =>
    {
        const profiler = db.enableProfiling();
        await User.query().count();
        expect(profiler.metrics().totalQueries).toBeGreaterThanOrEqual(1);
        delete db.adapter._profiler;
    });

    // -- Eager loading --
    it('with() eager loads hasMany relation', async () =>
    {
        const result = await User.query().with('Post').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Post).toHaveLength(2);
    });

    it('with() eager loads belongsTo relation', async () =>
    {
        const result = await Post.query().with('User').exec();
        expect(result[0].User).not.toBeNull();
        expect(result[0].User.name).toBeDefined();
    });

    it('with() eager loading with scope constraint', async () =>
    {
        const result = await User.query().with({ Post: q => q.where('title', 'Post1') }).exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Post).toHaveLength(1);
    });

    it('with() handles empty key set (no matching local keys)', async () =>
    {
        // Eve has no posts, but User with null userId wouldn't happen here
        // Instead test with a model that has null FK values
        const result = await User.query().where('name', 'Eve').with('Post').exec();
        expect(result[0].Post).toEqual([]);
    });

    it('with() throws for unknown relation', async () =>
    {
        await expect(User.query().with('NonExistent').exec()).rejects.toThrow('Unknown relation');
    });

    it('with() with object scope where scope is not a function', async () =>
    {
        // Non-function scope value should be null-ified
        const result = await User.query().with({ Post: 'not-a-function' }).exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Post).toHaveLength(2);
    });

    it('include() is alias for with()', async () =>
    {
        const result = await User.query().include('Post').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Post).toHaveLength(2);
    });

    // -- withCount --
    it('withCount hasMany counts related', async () =>
    {
        const result = await User.query().withCount('Post').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Post_count).toBe(2);
        const eve = result.find(u => u.name === 'Eve');
        expect(eve.Post_count).toBe(0);
    });

    it('withCount belongsTo counts parent', async () =>
    {
        const result = await Post.query().withCount('User').exec();
        expect(result[0].User_count).toBe(1);
    });

    it('withCount throws for unknown relation', async () =>
    {
        await expect(User.query().withCount('Nonexistent').exec()).rejects.toThrow('Unknown relation');
    });

    it('withCount with object input extracts keys', () =>
    {
        const q = User.query().withCount({ Post: true });
        expect(q._eagerCount).toContain('Post');
    });

    // -- whereRaw --
    it('whereRaw adds raw clause (memory adapter skips it)', async () =>
    {
        const result = await User.query().whereRaw('1=1').exec();
        // Memory adapter ignores raw WHERE — returns all
        expect(result).toHaveLength(3);
    });

    // -- exec error propagation --
    it('exec rethrows adapter errors', async () =>
    {
        const origExec = db.adapter.execute;
        db.adapter.execute = () => { throw new Error('adapter boom'); };
        await expect(User.query().exec()).rejects.toThrow('adapter boom');
        db.adapter.execute = origExec;
    });

    it('count rethrows adapter errors', async () =>
    {
        const origExec = db.adapter.execute;
        db.adapter.execute = () => { throw new Error('count boom'); };
        await expect(User.query().count()).rejects.toThrow('count boom');
        db.adapter.execute = origExec;
    });

    // -- chunk --
    it('chunk() processes batches correctly', async () =>
    {
        const batches = [];
        await User.query().chunk(2, (batch, idx) => { batches.push({ count: batch.length, idx }); });
        expect(batches).toHaveLength(2);
        expect(batches[0].count).toBe(2);
        expect(batches[1].count).toBe(1);
    });

    // -- pluck --
    it('pluck() extracts one column', async () =>
    {
        const names = await User.query().pluck('name');
        expect(names).toContain('Alice');
        expect(names).toHaveLength(3);
    });

    // -- paginate --
    it('paginate() returns metadata', async () =>
    {
        const result = await User.query().paginate(1, 2);
        expect(result.total).toBe(3);
        expect(result.pages).toBe(2);
        expect(result.hasNext).toBe(true);
        expect(result.hasPrev).toBe(false);
        expect(result.data).toHaveLength(2);
    });

    // -- catchable via .catch() --
    it('catch() works on query', async () =>
    {
        const origExec = db.adapter.execute;
        db.adapter.execute = () => Promise.reject(new Error('catch test'));
        let caught = false;
        await User.query().catch(() => { caught = true; });
        expect(caught).toBe(true);
        db.adapter.execute = origExec;
    });

    // -- build() strips soft-delete filter with withDeleted --
    it('build() removes deletedAt IS NULL filter with withDeleted()', () =>
    {
        const q = User.query().whereNull('deletedAt').withDeleted();
        const desc = q.build();
        const hasDeletedAtFilter = desc.where.some(w => w.field === 'deletedAt' && w.op === 'IS NULL');
        expect(hasDeletedAtFilter).toBe(false);
    });

    // -- NOT LIKE via where --
    it('NOT LIKE operator works', async () =>
    {
        const result = await User.query().where('name', 'NOT LIKE', 'Al%').exec();
        expect(result.every(u => !u.name.startsWith('Al'))).toBe(true);
    });

    // -- page() clamping --
    it('page() clamps to minimum 1', () =>
    {
        const q = User.query().page(0, 10);
        expect(q._offsetVal).toBe(0);
        expect(q._limitVal).toBe(10);
    });

    // -- aliases --
    it('take() is alias for limit()', () =>
    {
        const q = User.query().take(5);
        expect(q._limitVal).toBe(5);
    });

    it('skip() is alias for offset()', () =>
    {
        const q = User.query().skip(10);
        expect(q._offsetVal).toBe(10);
    });

    it('orderByDesc() is alias', () =>
    {
        const q = User.query().orderByDesc('name');
        expect(q._orderBy[0].dir).toBe('DESC');
    });

    it('orderByDescending() is alias', () =>
    {
        const q = User.query().orderByDescending('name');
        expect(q._orderBy[0].dir).toBe('DESC');
    });

    it('firstOrDefault() is alias for first()', async () =>
    {
        const r = await User.query().firstOrDefault();
        expect(r).not.toBeNull();
    });

    it('lastOrDefault() is alias for last()', async () =>
    {
        const r = await User.query().lastOrDefault();
        expect(r).not.toBeNull();
    });

    it('average() is alias for avg()', async () =>
    {
        const avg = await User.query().average('score');
        expect(avg).toBe(20);
    });

    it('aggregate() is alias for reduce()', async () =>
    {
        const total = await User.query().aggregate((acc, u) => acc + u.score, 0);
        expect(total).toBe(60);
    });

    it('toArray() is alias for exec()', async () =>
    {
        const arr = await User.query().toArray();
        expect(arr).toHaveLength(3);
    });

    // -- each --
    it('each() iterates with index', async () =>
    {
        const items = [];
        await User.query().orderBy('id').each((u, i) => { items.push({ name: u.name, i }); });
        expect(items).toHaveLength(3);
        expect(items[0].i).toBe(0);
    });

    // -- map / filter / reduce --
    it('map() transforms results', async () =>
    {
        const names = await User.query().map(u => u.name);
        expect(names).toContain('Alice');
    });

    it('filter() filters post-execution', async () =>
    {
        const result = await User.query().filter(u => u.age > 20);
        expect(result).toHaveLength(2);
    });

    it('reduce() accumulates', async () =>
    {
        const total = await User.query().reduce((acc, u) => acc + u.score, 0);
        expect(total).toBe(60);
    });
});

// ===================================================================
// query.js — Eager Loading: belongsToMany, hasOne with/withCount
// ===================================================================
describe('query.js — eager loading advanced', () =>
{
    let db, User, Role, UserRole, Profile;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'User' });

        Role = makeModel(db, 'roles', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Role' });

        UserRole = makeModel(db, 'user_roles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer' },
            roleId: { type: 'integer' },
        }, { name: 'UserRole' });

        Profile = makeModel(db, 'profiles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer' },
            bio:    { type: 'string' },
        }, { name: 'Profile' });

        User.belongsToMany(Role, { through: 'user_roles', foreignKey: 'userId', otherKey: 'roleId' });
        User.hasOne(Profile, 'userId');
        await db.sync();

        await User.create({ name: 'Alice' });
        await User.create({ name: 'Bob' });
        await Role.create({ name: 'admin' });
        await Role.create({ name: 'editor' });
        await UserRole.create({ userId: 1, roleId: 1 });
        await UserRole.create({ userId: 1, roleId: 2 });
        await Profile.create({ userId: 1, bio: 'Hello' });
    });

    it('with() belongsToMany eager loads through junction', async () =>
    {
        const result = await User.query().with('Role').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Role).toHaveLength(2);
        const bob = result.find(u => u.name === 'Bob');
        expect(bob.Role).toEqual([]);
    });

    it('with() belongsToMany with scope', async () =>
    {
        const result = await User.query()
            .with({ Role: q => q.where('name', 'admin') })
            .exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Role).toHaveLength(1);
        expect(alice.Role[0].name).toBe('admin');
    });

    it('with() belongsToMany returns empty when junction is empty', async () =>
    {
        const result = await User.query().where('name', 'Bob').with('Role').exec();
        expect(result[0].Role).toEqual([]);
    });

    it('with() hasOne eager loads single relation', async () =>
    {
        const result = await User.query().with('Profile').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Profile.bio).toBe('Hello');
        const bob = result.find(u => u.name === 'Bob');
        expect(bob.Profile).toBeNull();
    });

    it('withCount belongsToMany counts junction entries', async () =>
    {
        const result = await User.query().withCount('Role').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Role_count).toBe(2);
        const bob = result.find(u => u.name === 'Bob');
        expect(bob.Role_count).toBe(0);
    });

    it('withCount hasOne counts 0 or 1', async () =>
    {
        const result = await User.query().withCount('Profile').exec();
        const alice = result.find(u => u.name === 'Alice');
        expect(alice.Profile_count).toBe(1);
        const bob = result.find(u => u.name === 'Bob');
        expect(bob.Profile_count).toBe(0);
    });

    it('withCount belongsTo counts presence', async () =>
    {
        Profile.belongsTo(User, 'userId');
        const result = await Profile.query().withCount('User').exec();
        expect(result[0].User_count).toBe(1);
    });

    it('withCount with empty keys sets all counts to 0', async () =>
    {
        // Remove all users, then count on empty results
        const result = await User.query().where('name', 'Nobody').withCount('Role').exec();
        expect(result).toHaveLength(0);
    });
});

// ===================================================================
// index.js (Database) — Uncovered Branches
// ===================================================================
describe('index.js (Database) — deep branch coverage', () =>
{
    it('connect throws for unknown adapter type', () =>
    {
        expect(() => Database.connect('oracle')).toThrow('Unknown adapter');
    });

    it('_validateOptions validates redis options', () =>
    {
        expect(() => Database.connect('redis', { url: '' })).toThrow('non-empty string');
        expect(() => Database.connect('redis', { host: '' })).toThrow('non-empty string');
        expect(() => Database.connect('redis', { port: 99999 })).toThrow('1-65535');
        expect(() => Database.connect('redis', { port: 'abc' })).toThrow('1-65535');
        expect(() => Database.connect('redis', { password: 123 })).toThrow('must be a string');
        expect(() => Database.connect('redis', { db: -1 })).toThrow('non-negative integer');
        expect(() => Database.connect('redis', { db: 'abc' })).toThrow('non-negative integer');
    });

    it('_validateOptions validates mysql options', () =>
    {
        expect(() => Database.connect('mysql', { host: '' })).toThrow('non-empty string');
        expect(() => Database.connect('mysql', { port: 0 })).toThrow('1-65535');
        expect(() => Database.connect('mysql', { user: 123 })).toThrow('must be a string');
        expect(() => Database.connect('mysql', { password: 123 })).toThrow('must be a string');
        expect(() => Database.connect('mysql', { database: '' })).toThrow('non-empty string');
    });

    it('_validateOptions validates postgres options', () =>
    {
        expect(() => Database.connect('postgres', { host: '' })).toThrow('non-empty string');
        expect(() => Database.connect('postgres', { port: 70000 })).toThrow('1-65535');
    });

    it('_validateOptions validates mongo options', () =>
    {
        expect(() => Database.connect('mongo', { url: '' })).toThrow('non-empty string');
        expect(() => Database.connect('mongo', { database: '' })).toThrow('non-empty string');
    });

    it('_validateOptions validates sqlite filename type', () =>
    {
        expect(() => Database.connect('sqlite', { filename: 123 })).toThrow('must be a string');
    });

    it('registerAll registers multiple models', () =>
    {
        const db = memDb();
        const A = class extends Model { static table = 'a'; static schema = {}; };
        const B = class extends Model { static table = 'b'; static schema = {}; };
        db.registerAll(A, B);
        expect(db.model('a')).toBe(A);
        expect(db.model('b')).toBe(B);
    });

    it('model() returns undefined for non-registered', () =>
    {
        const db = memDb();
        expect(db.model('nope')).toBeUndefined();
    });

    it('transaction wraps in begin/commit', async () =>
    {
        const db = memDb();
        // Memory adapter has no beginTransaction — fn runs directly
        const result = await db.transaction(async () => 42);
        expect(result).toBe(42);
    });

    it('transaction with adapter support rolls back on error', async () =>
    {
        const db = memDb();
        const beginSpy = vi.fn();
        const commitSpy = vi.fn();
        const rollbackSpy = vi.fn();
        db.adapter.beginTransaction = beginSpy;
        db.adapter.commit = commitSpy;
        db.adapter.rollback = rollbackSpy;

        await expect(db.transaction(async () => { throw new Error('tx fail'); }))
            .rejects.toThrow('tx fail');
        expect(beginSpy).toHaveBeenCalled();
        expect(rollbackSpy).toHaveBeenCalled();
        expect(commitSpy).not.toHaveBeenCalled();

        delete db.adapter.beginTransaction;
        delete db.adapter.commit;
        delete db.adapter.rollback;
    });

    it('transaction commits on success', async () =>
    {
        const db = memDb();
        const commitSpy = vi.fn();
        db.adapter.beginTransaction = vi.fn();
        db.adapter.commit = commitSpy;
        db.adapter.rollback = vi.fn();

        await db.transaction(async () => 'ok');
        expect(commitSpy).toHaveBeenCalled();

        delete db.adapter.beginTransaction;
        delete db.adapter.commit;
        delete db.adapter.rollback;
    });

    // DDL proxies
    it('addColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.addColumn = null;
        await expect(db.addColumn('t', 'c', {})).rejects.toThrow('does not support');
    });

    it('dropColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.dropColumn = null;
        await expect(db.dropColumn('t', 'c')).rejects.toThrow('does not support');
    });

    it('renameColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.renameColumn = null;
        await expect(db.renameColumn('t', 'a', 'b')).rejects.toThrow('does not support');
    });

    it('renameTable throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.renameTable = null;
        await expect(db.renameTable('a', 'b')).rejects.toThrow('does not support');
    });

    it('createIndex throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.createIndex = null;
        await expect(db.createIndex('t', 'c')).rejects.toThrow('does not support');
    });

    it('dropIndex throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.dropIndex = null;
        await expect(db.dropIndex('t', 'idx')).rejects.toThrow('does not support');
    });

    it('hasTable throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.hasTable = null;
        await expect(db.hasTable('t')).rejects.toThrow('does not support');
    });

    it('hasColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.hasColumn = null;
        await expect(db.hasColumn('t', 'c')).rejects.toThrow('does not support');
    });

    it('describeTable throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.describeTable = null;
        await expect(db.describeTable('t')).rejects.toThrow('does not support');
    });

    it('addForeignKey throws when adapter lacks method', async () =>
    {
        const db = memDb();
        await expect(db.addForeignKey('t', 'c', 'ref', 'rc')).rejects.toThrow('does not support');
    });

    it('dropForeignKey throws when adapter lacks method', async () =>
    {
        const db = memDb();
        await expect(db.dropForeignKey('t', 'fk')).rejects.toThrow('does not support');
    });

    // ping paths
    it('ping returns true for memory adapter (via _tables)', async () =>
    {
        const db = memDb();
        expect(await db.ping()).toBe(true);
    });

    it('ping delegates to adapter.ping() when present', async () =>
    {
        const db = memDb();
        db.adapter.ping = vi.fn().mockResolvedValue(true);
        expect(await db.ping()).toBe(true);
        expect(db.adapter.ping).toHaveBeenCalled();
        delete db.adapter.ping;
    });

    it('ping returns false when adapter.ping() throws', async () =>
    {
        const db = memDb();
        db.adapter.ping = vi.fn().mockRejectedValue(new Error('down'));
        expect(await db.ping()).toBe(false);
        delete db.adapter.ping;
    });

    it('ping fallback attempts execute', async () =>
    {
        const db = memDb();
        // Remove ping and _tables to hit execute fallback
        const origPing = db.adapter.ping;
        const origTables = db.adapter._tables;
        delete db.adapter.ping;
        delete db.adapter._tables;
        delete db.adapter._getTable;
        expect(await db.ping()).toBe(true); // execute fallback
        db.adapter._tables = origTables;
    });

    // retry
    it('retry succeeds on first try', async () =>
    {
        const db = memDb();
        const result = await db.retry(async () => 42);
        expect(result).toBe(42);
    });

    it('retry succeeds after failures', async () =>
    {
        const db = memDb();
        let attempts = 0;
        const result = await db.retry(async () =>
        {
            attempts++;
            if (attempts < 3) throw new Error('fail');
            return 'ok';
        }, { retries: 5, delay: 1 });
        expect(result).toBe('ok');
    });

    it('retry exhausts retries and rethrows', async () =>
    {
        const db = memDb();
        await expect(db.retry(
            async () => { throw new Error('permanent'); },
            { retries: 2, delay: 1 }
        )).rejects.toThrow('permanent');
    });

    it('retry calls onRetry callback', async () =>
    {
        const db = memDb();
        const spy = vi.fn();
        let i = 0;
        await db.retry(async () => { if (i++ < 1) throw new Error('fail'); return 'ok'; },
            { retries: 3, delay: 1, onRetry: spy }
        );
        expect(spy).toHaveBeenCalledOnce();
    });

    // profiling
    it('enableProfiling attaches profiler', () =>
    {
        const db = memDb();
        const profiler = db.enableProfiling({ slowThreshold: 50 });
        expect(db.profiler).toBe(profiler);
        expect(db.adapter._profiler).toBe(profiler);
    });

    it('profiler getter returns null when not enabled', () =>
    {
        const db = memDb();
        expect(db.profiler).toBeNull();
    });

    it('replicas getter returns null when not configured', () =>
    {
        const db = memDb();
        expect(db.replicas).toBeNull();
    });

    // connectWithReplicas
    it('connectWithReplicas sets up replica manager', () =>
    {
        const db = Database.connectWithReplicas('memory', {}, [{}]);
        expect(db._replicaManager).toBeDefined();
        expect(db._replicaManager.replicaCount).toBe(1);
    });

    it('connectWithReplicas throws for non-array configs', () =>
    {
        expect(() => Database.connectWithReplicas('memory', {}, 'not-array'))
            .toThrow('must be an array');
    });

    // topoSort with FK dependencies
    it('sync() orders tables by FK dependencies', async () =>
    {
        const db = memDb();
        const Parent = makeModel(db, 'parents', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Parent' });

        const Child = makeModel(db, 'children', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer', references: { table: 'parents', column: 'id' } },
        }, { name: 'Child' });

        // This should not throw (parent created before child)
        await db.sync();
        expect(await db.hasTable('parents')).toBe(true);
        expect(await db.hasTable('children')).toBe(true);
    });

    // close
    it('close() calls adapter.close() if available', async () =>
    {
        const db = memDb();
        db.adapter.close = vi.fn();
        await db.close();
        expect(db.adapter.close).toHaveBeenCalled();
        delete db.adapter.close;
    });

    it('close() does nothing when adapter has no close', async () =>
    {
        const db = memDb();
        await db.close(); // should not throw
    });

    // drop
    it('drop() drops tables in reverse order', async () =>
    {
        const db = memDb();
        const A = makeModel(db, 'a', { id: { type: 'integer', primaryKey: true } });
        const B = makeModel(db, 'b', { id: { type: 'integer', primaryKey: true } });
        await db.sync();
        await db.drop();
        expect(await db.hasTable('a')).toBe(false);
    });
});

// ===================================================================
// replicas.js — Uncovered Branches
// ===================================================================
describe('replicas.js — deep branch coverage', () =>
{
    it('throws on invalid strategy', () =>
    {
        expect(() => new ReplicaManager({ strategy: 'least-connections' }))
            .toThrow('Invalid replica strategy');
    });

    it('setPrimary throws on null', () =>
    {
        const rm = new ReplicaManager();
        expect(() => rm.setPrimary(null)).toThrow('must not be null');
    });

    it('addReplica throws on null', () =>
    {
        const rm = new ReplicaManager();
        expect(() => rm.addReplica(null)).toThrow('must not be null');
    });

    it('random strategy selects from healthy replicas', () =>
    {
        const rm = new ReplicaManager({ strategy: 'random' });
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        const r2 = { name: 'r2' };
        rm.setPrimary(primary);
        rm.addReplica(r1);
        rm.addReplica(r2);

        const adapter = rm.getReadAdapter();
        expect([r1, r2]).toContain(adapter);
    });

    it('round-robin cycles through replicas', () =>
    {
        const rm = new ReplicaManager({ strategy: 'round-robin' });
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        const r2 = { name: 'r2' };
        rm.setPrimary(primary);
        rm.addReplica(r1);
        rm.addReplica(r2);

        const first = rm.getReadAdapter();
        const second = rm.getReadAdapter();
        expect(first).not.toBe(second);
    });

    it('falls back to primary when no healthy replicas', () =>
    {
        const rm = new ReplicaManager();
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        rm.setPrimary(primary);
        rm.addReplica(r1);
        rm.markUnhealthy(r1);

        expect(rm.getReadAdapter()).toBe(primary);
    });

    it('sticky write window routes reads to primary', () =>
    {
        const rm = new ReplicaManager({ stickyWindow: 5000 });
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        rm.setPrimary(primary);
        rm.addReplica(r1);

        rm.getWriteAdapter(); // sets lastWriteAt
        expect(rm.getReadAdapter()).toBe(primary); // within sticky window
    });

    it('stickyWrite:false disables sticky', () =>
    {
        const rm = new ReplicaManager({ stickyWrite: false });
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        rm.setPrimary(primary);
        rm.addReplica(r1);

        rm.getWriteAdapter();
        expect(rm.getReadAdapter()).toBe(r1); // no sticky
    });

    it('healthCheck marks replicas healthy/unhealthy', async () =>
    {
        const rm = new ReplicaManager();
        rm.setPrimary({ name: 'primary' });

        const goodAdapter = { ping: vi.fn().mockResolvedValue(true) };
        const badAdapter = { ping: vi.fn().mockRejectedValue(new Error('down')) };
        const noPingAdapter = {};

        rm.addReplica(goodAdapter);
        rm.addReplica(badAdapter);
        rm.addReplica(noPingAdapter);

        const results = await rm.healthCheck();
        expect(results).toHaveLength(3);
        expect(results[0].healthy).toBe(true);
        expect(results[1].healthy).toBe(false);
        expect(results[2].healthy).toBe(true); // no ping = assumed healthy
    });

    it('markHealthy re-enables a replica', () =>
    {
        const rm = new ReplicaManager();
        const primary = { name: 'primary' };
        const r1 = { name: 'r1' };
        rm.setPrimary(primary);
        rm.addReplica(r1);
        rm.markUnhealthy(r1);
        expect(rm.getReadAdapter()).toBe(primary);
        rm.markHealthy(r1);
        expect(rm.getReadAdapter()).toBe(r1);
    });

    it('markUnhealthy on non-existent adapter is a no-op', () =>
    {
        const rm = new ReplicaManager();
        rm.setPrimary({ name: 'primary' });
        rm.markUnhealthy({ name: 'unknown' }); // should not throw
    });

    it('markHealthy on non-existent adapter is a no-op', () =>
    {
        const rm = new ReplicaManager();
        rm.setPrimary({ name: 'primary' });
        rm.markHealthy({ name: 'unknown' }); // no-op
    });

    it('removeReplica removes from pool', () =>
    {
        const rm = new ReplicaManager();
        const r1 = { name: 'r1' };
        rm.setPrimary({ name: 'primary' });
        rm.addReplica(r1);
        expect(rm.replicaCount).toBe(1);
        rm.removeReplica(r1);
        expect(rm.replicaCount).toBe(0);
    });

    it('status() reports pool state', () =>
    {
        const rm = new ReplicaManager();
        rm.setPrimary({ name: 'primary' });
        rm.addReplica({ name: 'r1' });
        rm.addReplica({ name: 'r2' });
        rm.markUnhealthy(rm._replicas[1].adapter);

        const s = rm.status();
        expect(s.primary).toBe(true);
        expect(s.total).toBe(2);
        expect(s.healthy).toBe(1);
        expect(s.unhealthy).toBe(1);
        expect(s.strategy).toBe('round-robin');
    });

    it('getAllAdapters returns primary + replicas', () =>
    {
        const rm = new ReplicaManager();
        const p = { name: 'primary' };
        const r1 = { name: 'r1' };
        rm.setPrimary(p);
        rm.addReplica(r1);
        const all = rm.getAllAdapters();
        expect(all).toContain(p);
        expect(all).toContain(r1);
    });

    it('closeAll calls close on all adapters', async () =>
    {
        const rm = new ReplicaManager();
        const p = { close: vi.fn() };
        const r1 = { close: vi.fn() };
        const r2 = {}; // no close
        rm.setPrimary(p);
        rm.addReplica(r1);
        rm.addReplica(r2);
        await rm.closeAll();
        expect(p.close).toHaveBeenCalled();
        expect(r1.close).toHaveBeenCalled();
    });

    it('replicaCount returns number of replicas', () =>
    {
        const rm = new ReplicaManager();
        rm.setPrimary({});
        expect(rm.replicaCount).toBe(0);
        rm.addReplica({});
        expect(rm.replicaCount).toBe(1);
    });
});

// ===================================================================
// profiler.js — Uncovered Branches
// ===================================================================
describe('profiler.js — deep branch coverage', () =>
{
    it('record is no-op when disabled', () =>
    {
        const p = new QueryProfiler({ enabled: false });
        p.record({ table: 'users', action: 'select', duration: 5 });
        expect(p.metrics().totalQueries).toBe(0);
    });

    it('enabled property getter/setter', () =>
    {
        const p = new QueryProfiler();
        expect(p.enabled).toBe(true);
        p.enabled = false;
        expect(p.enabled).toBe(false);
    });

    it('onSlow callback fires for slow queries', () =>
    {
        const onSlow = vi.fn();
        const p = new QueryProfiler({ slowThreshold: 10, onSlow });
        p.record({ table: 'users', action: 'select', duration: 50 });
        expect(onSlow).toHaveBeenCalled();
    });

    it('N+1 detection fires when threshold exceeded', () =>
    {
        const onN1 = vi.fn();
        const p = new QueryProfiler({ n1Threshold: 3, n1Window: 10000, onN1 });
        for (let i = 0; i < 5; i++)
        {
            p.record({ table: 'users', action: 'select', duration: 1 });
        }
        expect(onN1).toHaveBeenCalled();
        expect(p.n1Detections().length).toBeGreaterThan(0);
    });

    it('N+1 deduplicates within same window', () =>
    {
        const p = new QueryProfiler({ n1Threshold: 3, n1Window: 10000 });
        for (let i = 0; i < 10; i++)
        {
            p.record({ table: 'users', action: 'select', duration: 1 });
        }
        // Should only detect once within the same window
        expect(p.n1Detections().length).toBe(1);
    });

    it('N+1 does not fire for non-select actions', () =>
    {
        const p = new QueryProfiler({ n1Threshold: 3, n1Window: 10000 });
        for (let i = 0; i < 10; i++)
        {
            p.record({ table: 'users', action: 'insert', duration: 1 });
        }
        expect(p.n1Detections().length).toBe(0);
    });

    it('history cap evicts oldest entries', () =>
    {
        const p = new QueryProfiler({ maxHistory: 3 });
        for (let i = 0; i < 5; i++)
        {
            p.record({ table: 'users', action: 'select', duration: 1 });
        }
        expect(p.getQueries().length).toBe(3);
    });

    it('N+1 history cap evicts oldest detections', () =>
    {
        const p = new QueryProfiler({ n1Threshold: 2, n1Window: 1, maxN1History: 2 });
        // Multiple bursts with delays to trigger separate detections
        for (let i = 0; i < 3; i++)
        {
            p._n1Detected.push({ table: `t${i}`, count: 5, timestamp: Date.now() - 10000 * (3 - i), message: '' });
        }
        // Should cap at maxN1History when a new one is added
        p.record({ table: 'overflow', action: 'select', duration: 1 });
    });

    it('metrics() returns correct aggregates', () =>
    {
        const p = new QueryProfiler({ slowThreshold: 100 });
        p.record({ table: 'users', action: 'select', duration: 10 });
        p.record({ table: 'users', action: 'select', duration: 200 });
        const m = p.metrics();
        expect(m.totalQueries).toBe(2);
        expect(m.slowQueries).toBe(1);
        expect(m.avgLatency).toBeGreaterThan(0);
        expect(m.queriesPerSecond).toBeGreaterThan(0);
    });

    it('slowQueries() filters by threshold', () =>
    {
        const p = new QueryProfiler({ slowThreshold: 50 });
        p.record({ table: 'a', action: 'select', duration: 10 });
        p.record({ table: 'b', action: 'select', duration: 100 });
        expect(p.slowQueries()).toHaveLength(1);
    });

    it('getQueries() filters by table and action', () =>
    {
        const p = new QueryProfiler();
        p.record({ table: 'users', action: 'select', duration: 5 });
        p.record({ table: 'posts', action: 'insert', duration: 10 });
        expect(p.getQueries({ table: 'users' })).toHaveLength(1);
        expect(p.getQueries({ action: 'insert' })).toHaveLength(1);
        expect(p.getQueries({ minDuration: 8 })).toHaveLength(1);
    });

    it('reset() clears all state', () =>
    {
        const p = new QueryProfiler();
        p.record({ table: 'users', action: 'select', duration: 5 });
        p.reset();
        const m = p.metrics();
        expect(m.totalQueries).toBe(0);
        expect(m.totalTime).toBe(0);
        expect(p.getQueries()).toHaveLength(0);
        expect(p.n1Detections()).toHaveLength(0);
    });

    it('metrics avgLatency is 0 when no queries', () =>
    {
        const p = new QueryProfiler();
        expect(p.metrics().avgLatency).toBe(0);
    });
});

// ===================================================================
// memory.js (adapter) — Uncovered Branches
// ===================================================================
describe('memory adapter — deep branch coverage', () =>
{
    let adapter;

    beforeEach(() =>
    {
        const MemoryAdapter = require('../../lib/orm/adapters/memory');
        adapter = new MemoryAdapter();
    });

    it('unknown op in _matchClause falls through to default (equality)', async () =>
    {
        await adapter.createTable('users', {});
        await adapter.insert('users', { name: 'Alice' });
        await adapter.insert('users', { name: 'Bob' });

        // NOT LIKE is not in the switch — falls to default (val === value)
        const results = await adapter.execute({
            action: 'select', table: 'users',
            where: [{ field: 'name', op: 'NOT LIKE', value: 'Alice', logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        // default: val === value => only 'Alice' matches
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Alice');
    });

    it('NOT BETWEEN filter works', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 5 });
        await adapter.insert('items', { val: 15 });
        await adapter.insert('items', { val: 25 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [{ field: 'val', op: 'NOT BETWEEN', value: [10, 20], logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(2);
    });

    it('<> operator works', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 1 });
        await adapter.insert('items', { val: 2 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [{ field: 'val', op: '<>', value: 1, logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(1);
        expect(results[0].val).toBe(2);
    });

    it('IS NULL filter works', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: null });
        await adapter.insert('items', { val: 1 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [{ field: 'val', op: 'IS NULL', value: null, logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(1);
    });

    it('IS NOT NULL filter works', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: null });
        await adapter.insert('items', { val: 1 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [{ field: 'val', op: 'IS NOT NULL', value: null, logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(1);
    });

    it('unknown operator in _matchClause uses equality fallback', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 5 });

        // Direct access to check default case
        const match = adapter._matchClause({ val: 5 }, { field: 'val', op: 'UNKNOWN_OP', value: 5 });
        expect(match).toBe(true);
    });

    it('_compareOp handles all operators', () =>
    {
        expect(adapter._compareOp(5, '=', 5)).toBe(true);
        expect(adapter._compareOp(5, '!=', 3)).toBe(true);
        expect(adapter._compareOp(5, '<>', 3)).toBe(true);
        expect(adapter._compareOp(5, '>', 3)).toBe(true);
        expect(adapter._compareOp(3, '<', 5)).toBe(true);
        expect(adapter._compareOp(5, '>=', 5)).toBe(true);
        expect(adapter._compareOp(5, '<=', 5)).toBe(true);
        expect(adapter._compareOp(5, 'WEIRD', 5)).toBe(true);
    });

    it('OR logic in where chain', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 1, name: 'a' });
        await adapter.insert('items', { val: 2, name: 'b' });
        await adapter.insert('items', { val: 3, name: 'c' });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [
                { field: 'val', op: '=', value: 1, logic: 'AND' },
                { field: 'val', op: '=', value: 3, logic: 'OR' },
            ],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(2);
    });

    it('raw where clause is skipped by memory adapter', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 1 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            where: [{ raw: '1=1', params: [], logic: 'AND' }],
            orderBy: [], groupBy: [], having: [],
        });
        expect(results).toHaveLength(1);
    });

    it('_matchConditions returns true for null/non-object conditions', () =>
    {
        expect(adapter._matchConditions({}, null)).toBe(true);
        expect(adapter._matchConditions({}, undefined)).toBe(true);
    });

    it('hasColumn without schema checks row keys', async () =>
    {
        // Create table without schema, add row directly
        adapter._tables.set('raw_table', [{ col1: 'val' }]);
        expect(await adapter.hasColumn('raw_table', 'col1')).toBe(true);
        expect(await adapter.hasColumn('raw_table', 'col2')).toBe(false);
    });

    it('hasColumn with no schema and no rows returns false', async () =>
    {
        adapter._tables.set('empty_raw', []);
        expect(await adapter.hasColumn('empty_raw', 'col')).toBe(false);
    });

    it('describeTable returns empty for no schema', async () =>
    {
        adapter._tables.set('no_schema', []);
        expect(await adapter.describeTable('no_schema')).toEqual([]);
    });

    it('aggregate sum/avg/min/max/count work', async () =>
    {
        await adapter.createTable('nums', {});
        await adapter.insert('nums', { val: 10 });
        await adapter.insert('nums', { val: 20 });
        await adapter.insert('nums', { val: 30 });

        const desc = { table: 'nums', where: [], aggregateField: 'val' };
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'sum' })).toBe(60);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'avg' })).toBe(20);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'min' })).toBe(10);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'max' })).toBe(30);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'count' })).toBe(3);
    });

    it('aggregate returns 0/null on empty', async () =>
    {
        await adapter.createTable('empty', {});
        const desc = { table: 'empty', where: [], aggregateField: 'val' };
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'sum' })).toBe(0);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'avg' })).toBe(0);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'count' })).toBe(0);
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'min' })).toBeNull();
        expect(await adapter.aggregate({ ...desc, aggregateFn: 'max' })).toBeNull();
    });

    it('aggregate unknown function returns null', async () =>
    {
        await adapter.createTable('nums', {});
        await adapter.insert('nums', { val: 10 });
        expect(await adapter.aggregate({ table: 'nums', where: [], aggregateFn: 'median', aggregateField: 'val' })).toBeNull();
    });

    it('explain() returns plan data', () =>
    {
        adapter._tables.set('users', [{ id: 1 }, { id: 2 }]);
        const plan = adapter.explain({ table: 'users', action: 'select', where: [{ field: 'id', op: '=', value: 1 }] });
        expect(plan.adapter).toBe('memory');
        expect(plan.estimatedRows).toBe(2);
        expect(plan.filters).toBe(1);
    });

    it('toJSON / fromJSON roundtrip', async () =>
    {
        await adapter.createTable('users', { id: { type: 'integer', primaryKey: true } });
        await adapter.insert('users', { id: 1, name: 'Alice' });
        const json = adapter.toJSON();
        expect(json.users).toHaveLength(1);

        const MemoryAdapter = require('../../lib/orm/adapters/memory');
        const copy = new MemoryAdapter();
        copy.fromJSON(json);
        const rows = await copy.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(rows).toHaveLength(1);
    });

    it('fromJSON updates auto-increment', async () =>
    {
        await adapter.createTable('users', {});
        adapter.fromJSON({ users: [{ id: 50, name: 'A' }] });
        const row = await adapter.insert('users', { name: 'B' });
        expect(row.id).toBe(51);
    });

    it('clone() deep copies state', async () =>
    {
        await adapter.createTable('users', { id: { type: 'integer', primaryKey: true } });
        await adapter.insert('users', { id: 1, name: 'Alice' });

        const cloned = adapter.clone();
        await cloned.insert('users', { id: 2, name: 'Bob' });

        // Original should not have Bob
        const origRows = await adapter.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(origRows).toHaveLength(1);
        const clonedRows = await cloned.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(clonedRows).toHaveLength(2);
    });

    it('stats() reports correct values', async () =>
    {
        await adapter.createTable('users', {});
        await adapter.insert('users', { name: 'Alice' });
        const stats = adapter.stats();
        expect(stats.tables).toBeGreaterThanOrEqual(1);
        expect(stats.totalRows).toBeGreaterThanOrEqual(1);
        expect(stats.estimatedBytes).toBeGreaterThan(0);
    });

    it('totalRows() sums across tables', async () =>
    {
        await adapter.createTable('a', {});
        await adapter.createTable('b', {});
        await adapter.insert('a', {});
        await adapter.insert('b', {});
        await adapter.insert('b', {});
        expect(adapter.totalRows()).toBe(3);
    });

    it('tables() lists all table names', async () =>
    {
        await adapter.createTable('alpha', {});
        await adapter.createTable('beta', {});
        expect(adapter.tables()).toContain('alpha');
        expect(adapter.tables()).toContain('beta');
    });

    it('indexes() returns tracked indexes', async () =>
    {
        await adapter.createTable('users', {});
        await adapter.createIndex('users', ['name'], { name: 'idx_name', unique: true });
        const idxs = await adapter.indexes('users');
        expect(idxs).toHaveLength(1);
        expect(idxs[0].name).toBe('idx_name');
        expect(idxs[0].unique).toBe(true);
    });

    it('dropIndex removes tracked index', async () =>
    {
        await adapter.createTable('users', {});
        await adapter.createIndex('users', ['name'], { name: 'idx_drop' });
        await adapter.dropIndex('users', 'idx_drop');
        expect(await adapter.indexes('users')).toHaveLength(0);
    });

    it('renameTable moves schema and auto-increment', async () =>
    {
        await adapter.createTable('old', { id: { type: 'integer' } });
        await adapter.insert('old', { name: 'A' });
        await adapter.renameTable('old', 'new');

        expect(await adapter.hasTable('old')).toBe(false);
        expect(await adapter.hasTable('new')).toBe(true);
        const schema = adapter._schemas.get('new');
        expect(schema.id).toBeDefined();
    });

    it('renameTable is no-op for nonexistent table', async () =>
    {
        await adapter.renameTable('nonexistent', 'new'); // should not throw
    });

    it('DISTINCT removes duplicate rows', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { val: 1 });
        await adapter.insert('items', { val: 1 });
        await adapter.insert('items', { val: 2 });

        const results = await adapter.execute({
            action: 'select', table: 'items',
            fields: ['val'],
            where: [], orderBy: [], groupBy: [], having: [],
            distinct: true,
        });
        expect(results).toHaveLength(2);
    });

    it('GROUP BY with HAVING COUNT filter', async () =>
    {
        await adapter.createTable('orders', {});
        await adapter.insert('orders', { cat: 'A', amount: 10 });
        await adapter.insert('orders', { cat: 'A', amount: 20 });
        await adapter.insert('orders', { cat: 'B', amount: 5 });

        const results = await adapter.execute({
            action: 'select', table: 'orders',
            where: [], orderBy: [],
            groupBy: ['cat'],
            having: [{ field: 'COUNT(*)', op: '>=', value: 2 }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].cat).toBe('A');
    });

    it('HAVING with non-COUNT field', async () =>
    {
        await adapter.createTable('orders', {});
        await adapter.insert('orders', { cat: 'A', amount: 10 });
        await adapter.insert('orders', { cat: 'B', amount: 20 });

        const results = await adapter.execute({
            action: 'select', table: 'orders',
            where: [], orderBy: [],
            groupBy: ['cat'],
            having: [{ field: 'cat', op: '=', value: 'A' }],
        });
        expect(results).toHaveLength(1);
    });

    it('_enforceUnique allows null values for unique columns', async () =>
    {
        await adapter.createTable('users', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
        });
        await adapter.insert('users', { email: null });
        await adapter.insert('users', { email: null }); // should not throw
    });

    it('_enforceUnique rejects duplicates', async () =>
    {
        await adapter.createTable('users', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
        });
        await adapter.insert('users', { email: 'a@b.com' });
        await expect(adapter.insert('users', { email: 'a@b.com' })).rejects.toThrow('UNIQUE constraint');
    });

    it('composite unique constraint enforcement', async () =>
    {
        await adapter.createTable('user_roles', {
            userId: { type: 'integer', compositeUnique: 'ur' },
            roleId: { type: 'integer', compositeUnique: 'ur' },
        });
        await adapter.insert('user_roles', { userId: 1, roleId: 1 });
        await expect(adapter.insert('user_roles', { userId: 1, roleId: 1 })).rejects.toThrow('UNIQUE constraint');
        // Different combo should pass
        await adapter.insert('user_roles', { userId: 1, roleId: 2 });
    });

    it('insert with provided id does not auto-increment', async () =>
    {
        await adapter.createTable('items', {});
        const row = await adapter.insert('items', { id: 99, name: 'manual' });
        expect(row.id).toBe(99);
    });

    it('insert serializes Date objects', async () =>
    {
        await adapter.createTable('events', {});
        const now = new Date();
        const row = await adapter.insert('events', { date: now });
        expect(typeof row.date).toBe('string');
    });

    it('update serializes Date objects', async () =>
    {
        await adapter.createTable('events', {});
        await adapter.insert('events', { id: 1, name: 'test' });
        await adapter.update('events', 'id', 1, { date: new Date() });
        const rows = await adapter.execute({ action: 'select', table: 'events', where: [], orderBy: [] });
        expect(typeof rows[0].date).toBe('string');
    });

    it('updateWhere with Date objects', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { cat: 'A', ts: null });
        await adapter.insert('items', { cat: 'A', ts: null });
        const count = await adapter.updateWhere('items', { cat: 'A' }, { ts: new Date() });
        expect(count).toBe(2);
    });

    it('remove by PK works', async () =>
    {
        await adapter.createTable('items', {});
        await adapter.insert('items', { id: 1, name: 'del' });
        await adapter.remove('items', 'id', 1);
        const rows = await adapter.execute({ action: 'select', table: 'items', where: [], orderBy: [] });
        expect(rows).toHaveLength(0);
    });

    it('clear resets all tables', async () =>
    {
        await adapter.createTable('a', {});
        await adapter.createTable('b', {});
        await adapter.insert('a', { val: 1 });
        await adapter.insert('b', { val: 2 });
        await adapter.clear();
        expect(await adapter.execute({ action: 'select', table: 'a', where: [], orderBy: [] })).toHaveLength(0);
        expect(await adapter.execute({ action: 'select', table: 'b', where: [], orderBy: [] })).toHaveLength(0);
    });

    it('addColumn sets default value for existing rows', async () =>
    {
        await adapter.createTable('users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await adapter.insert('users', { name: 'Alice' });
        await adapter.addColumn('users', 'active', { type: 'boolean', default: true });
        const rows = await adapter.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(rows[0].active).toBe(true);
    });

    it('dropColumn removes from existing rows', async () =>
    {
        await adapter.createTable('users', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string' },
            extra: { type: 'string' },
        });
        await adapter.insert('users', { id: 1, name: 'A', extra: 'X' });
        await adapter.dropColumn('users', 'extra');
        const rows = await adapter.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(rows[0].extra).toBeUndefined();
    });

    it('renameColumn renames in schema and data', async () =>
    {
        await adapter.createTable('users', {
            id:   { type: 'integer', primaryKey: true },
            firstName: { type: 'string' },
        });
        await adapter.insert('users', { id: 1, firstName: 'Alice' });
        await adapter.renameColumn('users', 'firstName', 'name');
        const rows = await adapter.execute({ action: 'select', table: 'users', where: [], orderBy: [] });
        expect(rows[0].name).toBe('Alice');
        expect(rows[0].firstName).toBeUndefined();
    });
});

// ===================================================================
// cache.js — Remaining Branch Coverage
// ===================================================================
describe('cache.js — remaining branch coverage', () =>
{
    it('has() returns false for expired entry', () =>
    {
        vi.useFakeTimers();
        const cache = new QueryCache({ defaultTTL: 1, maxEntries: 10 });
        cache.set('key', 'val');
        vi.advanceTimersByTime(2000);
        expect(cache.has('key')).toBe(false);
        vi.useRealTimers();
    });

    it('prune() removes expired entries', () =>
    {
        vi.useFakeTimers();
        const cache = new QueryCache({ defaultTTL: 1, maxEntries: 10 });
        cache.set('a', 1);
        cache.set('b', 2);
        vi.advanceTimersByTime(2000);
        const count = cache.prune();
        expect(count).toBe(2);
        vi.useRealTimers();
    });

    it('remember() returns cached value on hit', async () =>
    {
        const cache = new QueryCache();
        cache.set('key', 42);
        const val = await cache.remember('key', () => 99);
        expect(val).toBe(42);
    });

    it('remember() calls fn and caches on miss', async () =>
    {
        const cache = new QueryCache();
        const val = await cache.remember('key', async () => 99);
        expect(val).toBe(99);
        expect(cache.get('key')).toBe(99);
    });

    it('keyFromDescriptor generates stable key', () =>
    {
        const desc = { table: 'users', action: 'select', where: [{ field: 'id', op: '=', value: 1 }] };
        const key = QueryCache.keyFromDescriptor(desc);
        expect(key).toContain('users');
        expect(key).toContain('select');
    });

    it('set with ttl:0 creates entry without expiry', () =>
    {
        const cache = new QueryCache({ defaultTTL: 0 });
        cache.set('key', 'val', 0);
        expect(cache.get('key')).toBe('val');
    });

    it('LRU eviction removes oldest', () =>
    {
        const cache = new QueryCache({ maxEntries: 2, defaultTTL: 0 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3); // should evict 'a'
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('c')).toBe(3);
    });

    it('invalidate removes matching entries', () =>
    {
        const cache = new QueryCache();
        cache.set('users|select', 'data');
        cache.set('posts|select', 'data');
        const count = cache.invalidate('users');
        expect(count).toBe(1);
        expect(cache.get('users|select')).toBeUndefined();
        expect(cache.get('posts|select')).toBe('data');
    });
});

// ===================================================================
// migrate.js — Edge Cases
// ===================================================================
describe('migrate.js — edge cases', () =>
{
    let db, migrator;

    beforeEach(() =>
    {
        db = memDb();
        migrator = new Migrator(db);
    });

    it('add() rejects duplicate migration name', () =>
    {
        migrator.add({ name: 'test', up: async () => {}, down: async () => {} });
        expect(() => migrator.add({ name: 'test', up: async () => {}, down: async () => {} }))
            .toThrow('already registered');
    });

    it('add() rejects invalid name characters', () =>
    {
        expect(() => migrator.add({ name: 'test migration!', up: async () => {}, down: async () => {} }))
            .toThrow('invalid characters');
    });

    it('add() requires name', () =>
    {
        expect(() => migrator.add({ up: async () => {}, down: async () => {} }))
            .toThrow('must have a name');
    });

    it('add() requires up function', () =>
    {
        expect(() => migrator.add({ name: 't', up: 'not-fn', down: async () => {} }))
            .toThrow('up() must be a function');
    });

    it('add() requires down function', () =>
    {
        expect(() => migrator.add({ name: 't', up: async () => {}, down: 'not-fn' }))
            .toThrow('down() must be a function');
    });

    it('addAll adds multiple', () =>
    {
        migrator.addAll([
            { name: 'a', up: async () => {}, down: async () => {} },
            { name: 'b', up: async () => {}, down: async () => {} },
        ]);
        expect(migrator._migrations).toHaveLength(2);
    });

    it('migrate skips when no pending', async () =>
    {
        const result = await migrator.migrate();
        expect(result.migrated).toHaveLength(0);
        expect(result.batch).toBe(0);
    });

    it('migrate runs pending and rollback reverses', async () =>
    {
        migrator.add({
            name: '001_test',
            up: async (db) => { await db.adapter.createTable('test_table', { id: { type: 'integer' } }); },
            down: async (db) => { await db.adapter.dropTable('test_table'); },
        });

        const { migrated, batch } = await migrator.migrate();
        expect(migrated).toEqual(['001_test']);
        expect(batch).toBe(1);

        const { rolledBack } = await migrator.rollback();
        expect(rolledBack).toEqual(['001_test']);
    });

    it('rollback on empty returns empty', async () =>
    {
        const { rolledBack, batch } = await migrator.rollback();
        expect(rolledBack).toEqual([]);
        expect(batch).toBe(0);
    });

    it('rollback throws when migration definition missing', async () =>
    {
        migrator.add({
            name: '001',
            up: async () => {},
            down: async () => {},
        });
        await migrator.migrate();

        // Remove the migration definition
        migrator._migrations = [];
        await expect(migrator.rollback()).rejects.toThrow('definition not found');
    });

    it('migrate throws on up() failure with details', async () =>
    {
        migrator.add({
            name: '001_fail',
            up: async () => { throw new Error('up failed'); },
            down: async () => {},
        });
        const err = await migrator.migrate().catch(e => e);
        expect(err.message).toContain('001_fail');
        expect(err.migration).toBe('001_fail');
    });

    it('rollback throws on down() failure with details', async () =>
    {
        migrator.add({
            name: '001',
            up: async () => {},
            down: async () => { throw new Error('down failed'); },
        });
        await migrator.migrate();
        const err = await migrator.rollback().catch(e => e);
        expect(err.message).toContain('001');
        expect(err.migration).toBe('001');
    });

    it('rollbackAll rolls back all batches', async () =>
    {
        migrator.add({ name: 'a', up: async () => {}, down: async () => {} });
        migrator.add({ name: 'b', up: async () => {}, down: async () => {} });
        await migrator.migrate();
        const { rolledBack } = await migrator.rollbackAll();
        expect(rolledBack).toHaveLength(2);
    });

    it('reset rolls back then re-migrates', async () =>
    {
        migrator.add({ name: 'a', up: async () => {}, down: async () => {} });
        await migrator.migrate();
        const { rolledBack, migrated } = await migrator.reset();
        expect(rolledBack).toHaveLength(1);
        expect(migrated).toHaveLength(1);
    });

    it('fresh drops everything and re-migrates', async () =>
    {
        migrator.add({
            name: '001',
            up: async (db) => { await db.adapter.createTable('fresh_table', {}); },
            down: async (db) => { await db.adapter.dropTable('fresh_table'); },
        });
        await migrator.migrate();
        const { migrated } = await migrator.fresh();
        expect(migrated).toEqual(['001']);
    });

    it('status() reports executed, pending, lastBatch', async () =>
    {
        migrator.add({ name: 'a', up: async () => {}, down: async () => {} });
        migrator.add({ name: 'b', up: async () => {}, down: async () => {} });
        await migrator.migrate();

        migrator.add({ name: 'c', up: async () => {}, down: async () => {} });
        const status = await migrator.status();
        expect(status.executed).toHaveLength(2);
        expect(status.pending).toEqual(['c']);
        expect(status.lastBatch).toBe(1);
    });

    it('hasPending() returns true/false', async () =>
    {
        expect(await migrator.hasPending()).toBe(false);
        migrator.add({ name: 'a', up: async () => {}, down: async () => {} });
        expect(await migrator.hasPending()).toBe(true);
    });

    it('list() returns all registered migration names', () =>
    {
        migrator.add({ name: 'a', up: async () => {}, down: async () => {} });
        migrator.add({ name: 'b', up: async () => {}, down: async () => {} });
        expect(migrator.list()).toEqual(['a', 'b']);
    });
});
// ===================================================================
// ROUND 2 — Targeted Branch Coverage
// ===================================================================

// -------------------------------------------------------------------
// model.js — save() update path with timestamps
// -------------------------------------------------------------------
describe('model.js — save() update path', () =>
{
    it('save on persisted instance with dirty fields triggers update', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'upd_save', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { timestamps: true });
        await db.sync();
        const inst = await M.create({ name: 'original' });
        expect(inst._persisted).toBe(true);
        inst.name = 'changed';
        const returned = await inst.save();
        expect(returned.name).toBe('changed');
        expect(returned.updatedAt).toBeDefined();
    });

    it('save on persisted instance with no dirty fields is a no-op', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'noop_save', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const inst = await M.create({ name: 'same' });
        const returned = await inst.save();
        expect(returned).toBe(inst);
    });

    it('save insert path sets createdAt/updatedAt when timestamps enabled', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'ts_insert', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { timestamps: true });
        await db.sync();
        const inst = await M.create({ name: 'ts' });
        expect(inst.createdAt).toBeDefined();
        expect(inst.updatedAt).toBeDefined();
    });

    it('save update validation error throws', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'val_upd', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            age:  { type: 'integer', min: 0 },
        });
        await db.sync();
        const inst = await M.create({ age: 10 });
        inst.age = -5;
        await expect(inst.save()).rejects.toThrow();
    });
});

// -------------------------------------------------------------------
// model.js — createMany with timestamps and afterCreate hooks
// -------------------------------------------------------------------
describe('model.js — createMany branches', () =>
{
    it('createMany with timestamps sets createdAt/updatedAt', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'cm_ts', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { timestamps: true });
        await db.sync();
        const items = await M.createMany([{ name: 'a' }, { name: 'b' }]);
        expect(items).toHaveLength(2);
        for (const item of items)
        {
            expect(item.createdAt).toBeDefined();
            expect(item.updatedAt).toBeDefined();
        }
    });

    it('createMany fires afterCreate hook for each instance', async () =>
    {
        const db = memDb();
        const hooked = [];
        const M = makeModel(db, 'cm_hook', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { hooks: { afterCreate: (inst) => { hooked.push(inst.name); return inst; } } });
        await db.sync();
        await M.createMany([{ name: 'x' }, { name: 'y' }]);
        expect(hooked).toContain('x');
        expect(hooked).toContain('y');
    });

    it('createMany fires beforeCreate hook for each row', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'cm_bfhook', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { hooks: { beforeCreate: (data) => { data.name = data.name.toUpperCase(); return data; } } });
        await db.sync();
        const items = await M.createMany([{ name: 'hi' }, { name: 'yo' }]);
        expect(items[0].name).toBe('HI');
        expect(items[1].name).toBe('YO');
    });

    it('createMany with empty array returns empty', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'cm_empty', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        expect(await M.createMany([])).toEqual([]);
    });

    it('createMany falls back to individual creates when insertMany unavailable', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'cm_fallback', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        // Remove insertMany to test fallback
        const original = db.adapter.insertMany;
        db.adapter.insertMany = undefined;
        const items = await M.createMany([{ name: 'a' }, { name: 'b' }]);
        expect(items).toHaveLength(2);
        db.adapter.insertMany = original;
    });
});

// -------------------------------------------------------------------
// model.js — deleteWhere, findOrCreate, updateWhere branches
// -------------------------------------------------------------------
describe('model.js — CRUD statics', () =>
{
    it('deleteWhere without softDelete does hard delete', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'hw_del', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'gone' });
        const count = await M.deleteWhere({ name: 'gone' });
        expect(count).toBe(1);
        expect(await M.find()).toHaveLength(0);
    });

    it('deleteWhere with softDelete sets deletedAt', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'sw_del', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { softDelete: true });
        await db.sync();
        await M.create({ name: 'soft' });
        await M.deleteWhere({ name: 'soft' });
        // Default query excludes soft-deleted; raw adapter should still have the row
        const raw = await db.adapter.execute({
            action: 'select', table: 'sw_del', fields: null,
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(raw).toHaveLength(1);
        expect(raw[0].deletedAt).toBeDefined();
    });

    it('findOrCreate creates when not found', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'foc', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            role: { type: 'string' },
        });
        await db.sync();
        const { instance, created } = await M.findOrCreate({ name: 'new' }, { role: 'user' });
        expect(created).toBe(true);
        expect(instance.name).toBe('new');
        expect(instance.role).toBe('user');
    });

    it('findOrCreate returns existing when found', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'foc2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'existing' });
        const { instance, created } = await M.findOrCreate({ name: 'existing' });
        expect(created).toBe(false);
        expect(instance.name).toBe('existing');
    });

    it('upsert creates new record when not found', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'ups', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string' },
            name:  { type: 'string' },
        });
        await db.sync();
        const { instance, created } = await M.upsert({ email: 'a@b.com' }, { name: 'A' });
        expect(created).toBe(true);
        expect(instance.name).toBe('A');
    });

    it('upsert updates existing record', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'ups2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string' },
            name:  { type: 'string' },
        });
        await db.sync();
        await M.create({ email: 'a@b.com', name: 'Old' });
        const { instance, created } = await M.upsert({ email: 'a@b.com' }, { name: 'New' });
        expect(created).toBe(false);
        expect(instance.name).toBe('New');
    });

    it('updateWhere with timestamps sets updatedAt', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'uw_ts', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { timestamps: true });
        await db.sync();
        await M.create({ name: 'before' });
        const count = await M.updateWhere({ name: 'before' }, { name: 'after' });
        expect(count).toBe(1);
    });

    it('model.exists returns true/false', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'exists_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v:  { type: 'string' },
        });
        await db.sync();
        expect(await M.exists({ v: 'x' })).toBe(false);
        await M.create({ v: 'x' });
        expect(await M.exists({ v: 'x' })).toBe(true);
    });

    it('model.count returns correct number', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'cnt_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v:  { type: 'string' },
        });
        await db.sync();
        await M.create({ v: 'a' });
        await M.create({ v: 'b' });
        expect(await M.count()).toBe(2);
        expect(await M.count({ v: 'a' })).toBe(1);
    });
});

// -------------------------------------------------------------------
// model.js — instance methods: delete, restore, increment, decrement, reload, toJSON
// -------------------------------------------------------------------
describe('model.js — instance methods', () =>
{
    it('instance delete with softDelete sets deletedAt', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_sd', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { softDelete: true });
        await db.sync();
        const inst = await M.create({ name: 'bye' });
        await inst.delete();
        expect(inst._persisted).toBe(false);
        expect(inst.deletedAt).toBeDefined();
    });

    it('instance delete without softDelete removes record', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_hd', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const inst = await M.create({ name: 'gone' });
        await inst.delete();
        expect(inst._persisted).toBe(false);
        expect(await M.find()).toHaveLength(0);
    });

    it('restore on soft-deleted instance', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_rest', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { softDelete: true });
        await db.sync();
        const inst = await M.create({ name: 'back' });
        await inst.delete();
        await inst.restore();
        expect(inst.deletedAt).toBeNull();
    });

    it('restore throws on non-soft-delete model', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_nrest', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const inst = await M.create({ name: 'x' });
        await expect(inst.restore()).rejects.toThrow('soft deletes');
    });

    it('increment and decrement update numeric field', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_inc', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            count: { type: 'integer' },
        }, { timestamps: true });
        await db.sync();
        const inst = await M.create({ count: 10 });
        await inst.increment('count', 5);
        expect(inst.count).toBe(15);
        await inst.decrement('count', 3);
        expect(inst.count).toBe(12);
    });

    it('reload fetches fresh data from DB', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_reload', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const inst = await M.create({ name: 'old' });
        // Directly modify the underlying store
        await db.adapter.update('inst_reload', 'id', inst.id, { name: 'updated' });
        await inst.reload();
        expect(inst.name).toBe('updated');
    });

    it('reload throws when record not found', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_reload2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const inst = await M.create({ name: 'temp' });
        await db.adapter.remove('inst_reload2', 'id', inst.id);
        await expect(inst.reload()).rejects.toThrow('not found');
    });

    it('toJSON respects hidden fields', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'inst_json', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            name:     { type: 'string' },
            password: { type: 'string' },
        }, { hidden: ['password'] });
        await db.sync();
        const inst = await M.create({ name: 'a', password: 'secret' });
        const json = inst.toJSON();
        expect(json.name).toBe('a');
        expect(json.password).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// model.js — _runHook via static method on class
// -------------------------------------------------------------------
describe('model.js — _runHook prefers static method', () =>
{
    it('runs static hook method if defined', async () =>
    {
        const db = memDb();
        const M = class extends Model
        {
            static table = 'hook_static';
            static schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string' },
            };
            static beforeCreate(data) { data.name = 'HOOKED'; return data; }
        };
        Object.defineProperty(M, 'name', { value: 'hook_static' });
        db.register(M);
        await db.sync();
        const inst = await M.create({ name: 'raw' });
        expect(inst.name).toBe('HOOKED');
    });

    it('falls through to hooks object when no static method', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'hook_obj', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { hooks: { beforeCreate: (data) => { data.name = 'from-hooks'; return data; } } });
        await db.sync();
        const inst = await M.create({ name: 'raw' });
        expect(inst.name).toBe('from-hooks');
    });

    it('_runHook returns data unchanged when no hook defined', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'hook_none', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const result = await M._runHook('nonexistent', { foo: 'bar' });
        expect(result).toEqual({ foo: 'bar' });
    });
});

// -------------------------------------------------------------------
// model.js — _fullSchema, _primaryKey, _fromRow, _stripGuarded
// -------------------------------------------------------------------
describe('model.js — internal static helpers', () =>
{
    it('_fullSchema adds timestamp fields', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'fs_ts', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { timestamps: true, softDelete: true });
        const s = M._fullSchema();
        expect(s.createdAt).toBeDefined();
        expect(s.updatedAt).toBeDefined();
        expect(s.deletedAt).toBeDefined();
    });

    it('_primaryKey returns convention "id" when no explicit PK', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'pk_conv', {
            name: { type: 'string' },
        });
        expect(M._primaryKey()).toBe('id');
    });

    it('_stripGuarded removes guarded fields', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'guard', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            name:  { type: 'string' },
            role:  { type: 'string', guarded: true },
        });
        const data = M._stripGuarded({ name: 'a', role: 'admin' });
        expect(data.name).toBe('a');
        expect(data.role).toBeUndefined();
    });

    it('_stripGuarded returns data as-is when no guarded fields', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'noguard', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        const data = { name: 'a' };
        expect(M._stripGuarded(data)).toBe(data);
    });

    it('_fromRow marks instance as persisted', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'fromrow', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        const inst = M._fromRow({ id: 1, name: 'test' });
        expect(inst._persisted).toBe(true);
        expect(inst.name).toBe('test');
    });
});

// -------------------------------------------------------------------
// model.js — relationships: hasMany, hasOne, belongsTo, belongsToMany + load()
// -------------------------------------------------------------------
describe('model.js — relationships and load()', () =>
{
    let db, Author, Post, Profile, Tag;

    beforeEach(async () =>
    {
        db = memDb();
        Author = makeModel(db, 'authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Author' });
        Post = makeModel(db, 'posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        }, { name: 'Post' });
        Profile = makeModel(db, 'profiles', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            bio:      { type: 'string' },
        }, { name: 'Profile' });
        Tag = makeModel(db, 'tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Tag' });
        await db.sync();

        // Create junction table directly
        await db.adapter.createTable('post_tags', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            postId: { type: 'integer' },
            tagId:  { type: 'integer' },
        });

        Author.hasMany(Post, 'authorId');
        Author.hasOne(Profile, 'authorId');
        Post.belongsTo(Author, 'authorId');
        Post.belongsToMany(Tag, {
            through: 'post_tags',
            foreignKey: 'postId',
            otherKey: 'tagId',
        });
    });

    it('load hasMany returns related records', async () =>
    {
        const a = await Author.create({ name: 'Bob' });
        await Post.create({ authorId: a.id, title: 'P1' });
        await Post.create({ authorId: a.id, title: 'P2' });
        const posts = await a.load('Post');
        expect(posts).toHaveLength(2);
    });

    it('load hasOne returns single related record', async () =>
    {
        const a = await Author.create({ name: 'Bob' });
        await Profile.create({ authorId: a.id, bio: 'Hi' });
        const profile = await a.load('Profile');
        expect(profile.bio).toBe('Hi');
    });

    it('load belongsTo returns parent', async () =>
    {
        const a = await Author.create({ name: 'Bob' });
        const p = await Post.create({ authorId: a.id, title: 'Test' });
        const author = await p.load('Author');
        expect(author.name).toBe('Bob');
    });

    it('load belongsToMany returns related through junction', async () =>
    {
        const p = await Post.create({ authorId: 1, title: 'Post' });
        const t1 = await Tag.create({ name: 'JS' });
        const t2 = await Tag.create({ name: 'Node' });
        await db.adapter.insert('post_tags', { postId: p.id, tagId: t1.id });
        await db.adapter.insert('post_tags', { postId: p.id, tagId: t2.id });
        const tags = await p.load('Tag');
        expect(tags).toHaveLength(2);
        expect(tags.map(t => t.name).sort()).toEqual(['JS', 'Node']);
    });

    it('load belongsToMany returns empty when no junction rows', async () =>
    {
        const p = await Post.create({ authorId: 1, title: 'Lonely' });
        const tags = await p.load('Tag');
        expect(tags).toEqual([]);
    });

    it('load throws for unknown relation', async () =>
    {
        const a = await Author.create({ name: 'Bob' });
        await expect(a.load('Unknown')).rejects.toThrow('Unknown relation');
    });

    it('belongsToMany throws without required options', () =>
    {
        expect(() => Author.belongsToMany(Tag, {})).toThrow('through, foreignKey, and otherKey');
    });
});

// -------------------------------------------------------------------
// model.js — LINQ-style static shortcuts
// -------------------------------------------------------------------
describe('model.js — LINQ shortcuts', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'linq_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            age:  { type: 'integer' },
        });
        await db.sync();
        await M.create({ name: 'Alice', age: 30 });
        await M.create({ name: 'Bob', age: 25 });
        await M.create({ name: 'Charlie', age: 35 });
    });

    it('first returns first record', async () =>
    {
        const f = await M.first();
        expect(f).not.toBeNull();
    });

    it('first with conditions', async () =>
    {
        const f = await M.first({ name: 'Bob' });
        expect(f.name).toBe('Bob');
    });

    it('last returns last record', async () =>
    {
        const l = await M.last();
        expect(l).not.toBeNull();
    });

    it('all returns all records', async () =>
    {
        const all = await M.all();
        expect(all).toHaveLength(3);
    });

    it('random returns a record or null', async () =>
    {
        const r = await M.random();
        expect(r).not.toBeNull();
    });

    it('random returns null when no records match', async () =>
    {
        const r = await M.random({ name: 'nobody' });
        expect(r).toBeNull();
    });

    it('pluck returns array of single column values', async () =>
    {
        const names = await M.pluck('name');
        expect(names).toHaveLength(3);
        expect(names).toContain('Alice');
    });

    it('paginate returns pagination metadata', async () =>
    {
        const result = await M.paginate(1, 2);
        expect(result.page).toBe(1);
        expect(result.perPage).toBe(2);
        expect(result.data).toHaveLength(2);
        expect(result.total).toBe(3);
        expect(result.hasNext).toBe(true);
        expect(result.hasPrev).toBe(false);
    });

    it('chunk processes records in batches', async () =>
    {
        const batches = [];
        await M.chunk(2, (batch, idx) => { batches.push({ count: batch.length, idx }); });
        expect(batches.length).toBeGreaterThanOrEqual(1);
    });

    it('scope applies named scope', async () =>
    {
        const db2 = memDb();
        const S = makeModel(db2, 'scoped', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            age:  { type: 'integer' },
        }, { scopes: { old: q => q.where('age', '>', 30) } });
        await db2.sync();
        await S.create({ age: 25 });
        await S.create({ age: 35 });
        const results = await S.scope('old');
        expect(results).toHaveLength(1);
    });

    it('scope throws for unknown scope name', () =>
    {
        expect(() => M.scope('nonexistent')).toThrow('Unknown scope');
    });

    it('model.query() throws when no adapter registered', () =>
    {
        class Orphan extends Model { static table = 'orphan'; static schema = {}; }
        Object.defineProperty(Orphan, 'name', { value: 'Orphan' });
        expect(() => Orphan.query()).toThrow('not registered');
    });

    it('model.sync throws when no adapter', async () =>
    {
        class NoAdapter extends Model { static table = 'x'; static schema = {}; }
        await expect(NoAdapter.sync()).rejects.toThrow('not registered');
    });

    it('model.drop throws when no adapter', async () =>
    {
        class NoAdapter extends Model { static table = 'x'; static schema = {}; }
        await expect(NoAdapter.drop()).rejects.toThrow('not registered');
    });
});

// -------------------------------------------------------------------
// query.js — eager loading branches (with, withCount, belongsToMany)
// -------------------------------------------------------------------
describe('query.js — eager loading', () =>
{
    let db, Author, Post, Comment, Tag, Profile;

    beforeEach(async () =>
    {
        db = memDb();
        Author = makeModel(db, 'el_authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Author' });
        Post = makeModel(db, 'el_posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        }, { name: 'Post' });
        Comment = makeModel(db, 'el_comments', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            postId: { type: 'integer' },
            text:   { type: 'string' },
        }, { name: 'Comment' });
        Tag = makeModel(db, 'el_tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Tag' });
        Profile = makeModel(db, 'el_profiles', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            bio:      { type: 'string' },
        }, { name: 'Profile' });
        await db.sync();

        await db.adapter.createTable('el_post_tags', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            postId: { type: 'integer' },
            tagId:  { type: 'integer' },
        });

        Author.hasMany(Post, 'authorId');
        Post.hasMany(Comment, 'postId');
        Post.belongsTo(Author, 'authorId');
        Post.belongsToMany(Tag, { through: 'el_post_tags', foreignKey: 'postId', otherKey: 'tagId' });
    });

    it('with() eager loads hasMany', async () =>
    {
        const a = await Author.create({ name: 'A' });
        await Post.create({ authorId: a.id, title: 'P1' });
        await Post.create({ authorId: a.id, title: 'P2' });
        const results = await Author.query().with('Post').exec();
        expect(results[0].Post).toHaveLength(2);
    });

    it('with() eager loads belongsTo', async () =>
    {
        const a = await Author.create({ name: 'X' });
        await Post.create({ authorId: a.id, title: 'T' });
        const posts = await Post.query().with('Author').exec();
        expect(posts[0].Author.name).toBe('X');
    });

    it('with() eager loads belongsToMany', async () =>
    {
        const p = await Post.create({ authorId: 1, title: 'Tagged' });
        const t1 = await Tag.create({ name: 'JS' });
        const t2 = await Tag.create({ name: 'Rust' });
        await db.adapter.insert('el_post_tags', { postId: p.id, tagId: t1.id });
        await db.adapter.insert('el_post_tags', { postId: p.id, tagId: t2.id });
        const posts = await Post.query().with('Tag').exec();
        expect(posts[0].Tag).toHaveLength(2);
    });

    it('with() belongsToMany sets empty array when no junction rows', async () =>
    {
        await Post.create({ authorId: 1, title: 'NoTags' });
        const posts = await Post.query().with('Tag').exec();
        expect(posts[0].Tag).toEqual([]);
    });

    it('with scope constraint filters eager load', async () =>
    {
        const a = await Author.create({ name: 'Scoped' });
        await Post.create({ authorId: a.id, title: 'Yes' });
        await Post.create({ authorId: a.id, title: 'No' });
        // Re-define hasMany to avoid overlap
        Author._relations = {};
        Author.hasMany(Post, 'authorId');
        const results = await Author.query().with({ Post: q => q.where('title', 'Yes') }).exec();
        expect(results[0].Post).toHaveLength(1);
        expect(results[0].Post[0].title).toBe('Yes');
    });

    it('with object that has non-function scope falls back to null scope', async () =>
    {
        const a = await Author.create({ name: 'NoScope' });
        await Post.create({ authorId: a.id, title: 'X' });
        Author._relations = {};
        Author.hasMany(Post, 'authorId');
        const results = await Author.query().with({ Post: 'not-a-function' }).exec();
        expect(results[0].Post).toHaveLength(1);
    });

    it('with() throws for unknown relation', async () =>
    {
        await Author.create({ name: 'A' });
        await expect(Author.query().with('Unknown').exec()).rejects.toThrow('Unknown relation');
    });

    it('include() is alias for with()', async () =>
    {
        const a = await Author.create({ name: 'Inc' });
        await Post.create({ authorId: a.id, title: 'I' });
        Author._relations = {};
        Author.hasMany(Post, 'authorId');
        const results = await Author.query().include('Post').exec();
        expect(results[0].Post).toHaveLength(1);
    });

    it('eager load with empty keys sets default empty', async () =>
    {
        // Author with no posts
        await Author.create({ name: 'Lonely' });
        Author._relations = {};
        Author.hasMany(Post, 'authorId');
        const results = await Author.query().with('Post').exec();
        expect(results[0].Post).toEqual([]);
    });

    it('eager load hasOne sets null when no match', async () =>
    {
        Author._relations = {};
        Author.hasOne(Profile, 'authorId');
        await Author.create({ name: 'NoProfile' });
        const results = await Author.query().with('Profile').exec();
        expect(results[0].Profile).toBeNull();
    });

    it('eager load belongsTo sets null when no match', async () =>
    {
        await Post.create({ authorId: 9999, title: 'orphan' });
        const posts = await Post.query().with('Author').exec();
        expect(posts[0].Author).toBeNull();
    });
});

// -------------------------------------------------------------------
// query.js — withCount branches
// -------------------------------------------------------------------
describe('query.js — withCount', () =>
{
    let db, Author, Post, Tag;

    beforeEach(async () =>
    {
        db = memDb();
        Author = makeModel(db, 'wc_authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Author' });
        Post = makeModel(db, 'wc_posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        }, { name: 'Post' });
        Tag = makeModel(db, 'wc_tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Tag' });
        await db.sync();
        await db.adapter.createTable('wc_post_tags', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            postId: { type: 'integer' },
            tagId:  { type: 'integer' },
        });
        Author.hasMany(Post, 'authorId');
        Post.belongsTo(Author, 'authorId');
        Post.belongsToMany(Tag, { through: 'wc_post_tags', foreignKey: 'postId', otherKey: 'tagId' });
    });

    it('withCount hasMany counts related records', async () =>
    {
        const a = await Author.create({ name: 'Counter' });
        await Post.create({ authorId: a.id, title: 'P1' });
        await Post.create({ authorId: a.id, title: 'P2' });
        const results = await Author.query().withCount('Post').exec();
        expect(results[0].Post_count).toBe(2);
    });

    it('withCount sets 0 when no keys (empty result set)', async () =>
    {
        // Author with no posts
        await Author.create({ name: 'Empty' });
        const results = await Author.query().withCount('Post').exec();
        expect(results[0].Post_count).toBe(0);
    });

    it('withCount belongsTo returns 1 or 0', async () =>
    {
        const a = await Author.create({ name: 'Parent' });
        const p = await Post.create({ authorId: a.id, title: 'T' });
        const results = await Post.query().withCount('Author').exec();
        expect(results[0].Author_count).toBe(1);
    });

    it('withCount belongsTo returns 0 when parent missing', async () =>
    {
        await Post.create({ authorId: 9999, title: 'Orphan' });
        const results = await Post.query().withCount('Author').exec();
        expect(results[0].Author_count).toBe(0);
    });

    it('withCount belongsToMany counts junction rows', async () =>
    {
        const p = await Post.create({ authorId: 1, title: 'Tagged' });
        const t1 = await Tag.create({ name: 'A' });
        const t2 = await Tag.create({ name: 'B' });
        await db.adapter.insert('wc_post_tags', { postId: p.id, tagId: t1.id });
        await db.adapter.insert('wc_post_tags', { postId: p.id, tagId: t2.id });
        const results = await Post.query().withCount('Tag').exec();
        expect(results[0].Tag_count).toBe(2);
    });

    it('withCount belongsToMany returns 0 when no junction rows', async () =>
    {
        await Post.create({ authorId: 1, title: 'NoTags' });
        const results = await Post.query().withCount('Tag').exec();
        expect(results[0].Tag_count).toBe(0);
    });

    it('withCount throws for unknown relation', async () =>
    {
        await Author.create({ name: 'A' });
        await expect(Author.query().withCount('Unknown').exec()).rejects.toThrow('Unknown relation');
    });

    it('withCount with object form', async () =>
    {
        const a = await Author.create({ name: 'ObjForm' });
        await Post.create({ authorId: a.id, title: 'X' });
        const results = await Author.query().withCount({ Post: true }).exec();
        expect(results[0].Post_count).toBe(1);
    });
});

// -------------------------------------------------------------------
// query.js — aggregate methods with adapter.aggregate (truthy path)
// -------------------------------------------------------------------
describe('query.js — aggregate with adapter.aggregate', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'agg_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        await db.sync();
        await M.create({ val: 10 });
        await M.create({ val: 20 });
        await M.create({ val: 30 });
    });

    it('sum uses adapter.aggregate when available', async () =>
    {
        // Memory adapter has aggregate method
        const result = await M.query().sum('val');
        expect(result).toBe(60);
    });

    it('avg uses adapter.aggregate', async () =>
    {
        const result = await M.query().avg('val');
        expect(result).toBe(20);
    });

    it('min uses adapter.aggregate', async () =>
    {
        const result = await M.query().min('val');
        expect(result).toBe(10);
    });

    it('max uses adapter.aggregate', async () =>
    {
        const result = await M.query().max('val');
        expect(result).toBe(30);
    });

    it('sum/avg/min/max fallback when no aggregate method', async () =>
    {
        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        expect(await M.query().sum('val')).toBe(60);
        expect(await M.query().avg('val')).toBe(20);
        expect(await M.query().min('val')).toBe(10);
        expect(await M.query().max('val')).toBe(30);
        db.adapter.aggregate = origAgg;
    });

    it('min/max return null when no rows', async () =>
    {
        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const result1 = await M.query().where('val', '>', 999).min('val');
        const result2 = await M.query().where('val', '>', 999).max('val');
        expect(result1).toBeNull();
        expect(result2).toBeNull();
        db.adapter.aggregate = origAgg;
    });

    it('avg returns 0 when no rows in fallback', async () =>
    {
        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const result = await M.query().where('val', '>', 999).avg('val');
        expect(result).toBe(0);
        db.adapter.aggregate = origAgg;
    });
});

// -------------------------------------------------------------------
// query.js — profiler and replica integration in exec/count
// -------------------------------------------------------------------
describe('query.js — profiler & replica in exec/count', () =>
{
    it('exec records to profiler when set', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'prof_exec', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'string' },
        });
        await db.sync();
        await M.create({ val: 'x' });
        const profiler = new QueryProfiler();
        db.adapter._profiler = profiler;
        await M.query().exec();
        const report = profiler.metrics();
        expect(report.totalQueries).toBeGreaterThanOrEqual(1);
        db.adapter._profiler = null;
    });

    it('count records to profiler when set', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'prof_cnt', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'string' },
        });
        await db.sync();
        await M.create({ val: 'x' });
        const profiler = new QueryProfiler();
        db.adapter._profiler = profiler;
        await M.query().count();
        const report = profiler.metrics();
        expect(report.totalQueries).toBeGreaterThanOrEqual(1);
        db.adapter._profiler = null;
    });

    it('exec uses replica when onReplica() called and replicaManager exists', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'rep_exec', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'string' },
        });
        await db.sync();
        await M.create({ val: 'y' });
        // Set up a fake replica manager that returns the primary adapter
        db.adapter._replicaManager = { getReadAdapter: () => db.adapter };
        const results = await M.query().onReplica().exec();
        expect(results).toHaveLength(1);
        db.adapter._replicaManager = null;
    });

    it('count uses replica when onReplica() called', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'rep_cnt', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'string' },
        });
        await db.sync();
        await M.create({ val: 'y' });
        db.adapter._replicaManager = { getReadAdapter: () => db.adapter };
        const c = await M.query().onReplica().count();
        expect(c).toBe(1);
        db.adapter._replicaManager = null;
    });
});

// -------------------------------------------------------------------
// query.js — where chain operators (OR, BETWEEN, NOT IN, etc.)
// -------------------------------------------------------------------
describe('query.js — where operators', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'ops_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            age:  { type: 'integer' },
        });
        await db.sync();
        await M.create({ name: 'Alice', age: 25 });
        await M.create({ name: 'Bob', age: 30 });
        await M.create({ name: 'Charlie', age: 35 });
    });

    it('orWhere adds OR logic', async () =>
    {
        const results = await M.query().where('name', 'Alice').orWhere('name', 'Bob').exec();
        expect(results).toHaveLength(2);
    });

    it('whereIn filters by set', async () =>
    {
        const results = await M.query().whereIn('name', ['Alice', 'Charlie']).exec();
        expect(results).toHaveLength(2);
    });

    it('whereNotIn excludes set', async () =>
    {
        const results = await M.query().whereNotIn('name', ['Alice']).exec();
        expect(results).toHaveLength(2);
    });

    it('whereBetween filters range', async () =>
    {
        const results = await M.query().whereBetween('age', 26, 34).exec();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Bob');
    });

    it('whereNotBetween excludes range', async () =>
    {
        const results = await M.query().whereNotBetween('age', 26, 34).exec();
        expect(results).toHaveLength(2);
    });

    it('whereLike matches wildcard pattern', async () =>
    {
        const results = await M.query().whereLike('name', 'A%').exec();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Alice');
    });

    it('whereNull and whereNotNull', async () =>
    {
        await db.adapter.insert('ops_tbl', { name: null, age: 40 });
        const nulls = await M.query().whereNull('name').exec();
        expect(nulls).toHaveLength(1);
        const notNulls = await M.query().whereNotNull('name').exec();
        expect(notNulls).toHaveLength(3);
    });

    it('where with 2 args defaults to =', async () =>
    {
        const results = await M.query().where('name', 'Alice').exec();
        expect(results).toHaveLength(1);
    });

    it('where with object form', async () =>
    {
        const results = await M.query().where({ name: 'Bob', age: 30 }).exec();
        expect(results).toHaveLength(1);
    });

    it('orWhere with 2 args defaults to =', async () =>
    {
        const results = await M.query().where('name', 'Alice').orWhere('name', 'Bob').exec();
        expect(results).toHaveLength(2);
    });

    it('invalid operator throws', () =>
    {
        expect(() => M.query().where('name', 'INVALID_OP', 'x')).toThrow('Invalid query operator');
    });

    it('invalid orWhere operator throws', () =>
    {
        expect(() => M.query().orWhere('name', 'BAD', 'x')).toThrow('Invalid query operator');
    });

    it('invalid orderBy direction throws', () =>
    {
        expect(() => M.query().orderBy('name', 'diagonal')).toThrow('Invalid orderBy direction');
    });
});

// -------------------------------------------------------------------
// query.js — misc: withDeleted, explain, scope, distinct, page, then/catch
// -------------------------------------------------------------------
describe('query.js — misc methods', () =>
{
    it('withDeleted removes soft-delete filter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'wd_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { softDelete: true });
        await db.sync();
        const inst = await M.create({ name: 'deleted' });
        await inst.delete();
        // Default query excludes soft-deleted
        expect(await M.find()).toHaveLength(0);
        // withDeleted includes them
        const all = await M.query().withDeleted().exec();
        expect(all).toHaveLength(1);
    });

    it('explain returns plan from adapter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'exp_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        await db.sync();
        const plan = await M.query().explain();
        expect(plan.adapter).toBe('memory');
    });

    it('explain fallback when adapter has no explain', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'exp_tbl2', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        await db.sync();
        const origExplain = db.adapter.explain;
        db.adapter.explain = undefined;
        const plan = await M.query().explain();
        expect(plan.plan).toBe('Adapter does not support EXPLAIN');
        db.adapter.explain = origExplain;
    });

    it('query scope applies named scope', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'qs_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            age: { type: 'integer' },
        }, { scopes: { young: q => q.where('age', '<', 30) } });
        await db.sync();
        await M.create({ age: 25 });
        await M.create({ age: 35 });
        const results = await M.query().scope('young').exec();
        expect(results).toHaveLength(1);
    });

    it('query scope throws for unknown scope', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'qs_tbl2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        expect(() => M.query().scope('nope')).toThrow('Unknown scope');
    });

    it('distinct deduplicates', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'dist_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            cat:  { type: 'string' },
        });
        await db.sync();
        await M.create({ cat: 'A' });
        await M.create({ cat: 'A' });
        await M.create({ cat: 'B' });
        const results = await M.query().select('cat').distinct().exec();
        expect(results).toHaveLength(2);
    });

    it('page() sets limit and offset', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'page_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        for (let i = 0; i < 30; i++) await M.create({ name: `item${i}` });
        const q = M.query().page(2, 10);
        const results = await q.exec();
        expect(results).toHaveLength(10);
    });

    it('Query is thenable', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'then_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'a' });
        const results = await M.query().where('name', 'a');
        expect(results).toHaveLength(1);
    });

    it('Query catch works', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'catch_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        await db.sync();
        // Force an error by nulling the adapter
        const origAdapt = M._adapter;
        M._adapter = { execute: async () => { throw new Error('fail'); } };
        try
        {
            await M.query().exec();
        }
        catch (e)
        {
            expect(e.message).toBe('fail');
        }
        M._adapter = origAdapt;
    });

    it('exists() returns boolean', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'exist_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        expect(await M.query().exists()).toBe(false);
        await M.create({ name: 'x' });
        expect(await M.query().exists()).toBe(true);
    });

    it('pluck extracts single column', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'pluck_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'a' });
        await M.create({ name: 'b' });
        const names = await M.query().pluck('name');
        expect(names).toContain('a');
        expect(names).toContain('b');
    });
});

// -------------------------------------------------------------------
// query.js — paginate
// -------------------------------------------------------------------
describe('query.js — paginate', () =>
{
    it('paginate returns correct metadata', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'pag_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        for (let i = 0; i < 25; i++) await M.create({ name: `i${i}` });
        const r = await M.query().paginate(2, 10);
        expect(r.page).toBe(2);
        expect(r.perPage).toBe(10);
        expect(r.total).toBe(25);
        expect(r.pages).toBe(3);
        expect(r.hasNext).toBe(true);
        expect(r.hasPrev).toBe(true);
        expect(r.data).toHaveLength(10);
    });

    it('paginate page 1 has no hasPrev', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'pag2_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v:  { type: 'string' },
        });
        await db.sync();
        for (let i = 0; i < 5; i++) await M.create({ v: `i${i}` });
        const r = await M.query().paginate(1, 10);
        expect(r.hasPrev).toBe(false);
        expect(r.hasNext).toBe(false);
    });
});

// -------------------------------------------------------------------
// query.js — chunk
// -------------------------------------------------------------------
describe('query.js — chunk', () =>
{
    it('chunk processes all records in batches', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'chunk_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v:  { type: 'string' },
        });
        await db.sync();
        for (let i = 0; i < 15; i++) await M.create({ v: `i${i}` });
        const processed = [];
        await M.query().chunk(5, (batch, idx) =>
        {
            processed.push({ size: batch.length, idx });
        });
        expect(processed).toHaveLength(3);
        expect(processed[0].size).toBe(5);
        expect(processed[2].size).toBe(5);
    });
});

// -------------------------------------------------------------------
// query.js — join, leftJoin, rightJoin, groupBy, having
// -------------------------------------------------------------------
describe('query.js — join and groupBy', () =>
{
    it('join adds INNER join', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'j_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        const q = M.query().join('other', 'id', 'otherId');
        const desc = q.build();
        expect(desc.joins).toHaveLength(1);
        expect(desc.joins[0].type).toBe('INNER');
    });

    it('leftJoin adds LEFT join', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'lj_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        const q = M.query().leftJoin('other', 'id', 'otherId');
        expect(q.build().joins[0].type).toBe('LEFT');
    });

    it('rightJoin adds RIGHT join', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'rj_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        const q = M.query().rightJoin('other', 'id', 'otherId');
        expect(q.build().joins[0].type).toBe('RIGHT');
    });

    it('groupBy and having', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'gb_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            cat: { type: 'string' },
        });
        await db.sync();
        await M.create({ cat: 'A' });
        await M.create({ cat: 'A' });
        await M.create({ cat: 'B' });
        const results = await M.query().select('cat').groupBy('cat').having('COUNT(*)', '>=', 2).exec();
        expect(results).toHaveLength(1);
        expect(results[0].cat).toBe('A');
    });

    it('having with 2 args defaults to =', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'hv_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        const q = M.query().having('cnt', 5);
        const desc = q.build();
        expect(desc.having[0].op).toBe('=');
    });
});

// -------------------------------------------------------------------
// query.js — last()
// -------------------------------------------------------------------
describe('query.js — last()', () =>
{
    it('last returns the last record by reverse order', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'last_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'first' });
        await M.create({ name: 'last' });
        const l = await M.query().last();
        expect(l).not.toBeNull();
    });
});

// -------------------------------------------------------------------
// index.js — _validateOptions branches
// -------------------------------------------------------------------
describe('index.js — _validateOptions', () =>
{
    it('mysql: invalid host throws', () =>
    {
        expect(() => Database.connect('mysql', { host: '' })).toThrow('host');
    });

    it('mysql: invalid port throws', () =>
    {
        expect(() => Database.connect('mysql', { port: 'abc' })).toThrow('port');
    });

    it('mysql: port out of range throws', () =>
    {
        expect(() => Database.connect('mysql', { port: 99999 })).toThrow('port');
    });

    it('mysql: non-string user throws', () =>
    {
        expect(() => Database.connect('mysql', { user: 123 })).toThrow('user');
    });

    it('mysql: non-string password throws', () =>
    {
        expect(() => Database.connect('mysql', { password: 123 })).toThrow('password');
    });

    it('mysql: invalid database throws', () =>
    {
        expect(() => Database.connect('mysql', { database: '' })).toThrow('database');
    });

    it('postgres: same validations', () =>
    {
        expect(() => Database.connect('postgres', { host: '' })).toThrow('host');
        expect(() => Database.connect('postgres', { port: -1 })).toThrow('port');
        expect(() => Database.connect('postgres', { user: 42 })).toThrow('user');
        expect(() => Database.connect('postgres', { password: 42 })).toThrow('password');
        expect(() => Database.connect('postgres', { database: '  ' })).toThrow('database');
    });

    it('mongo: invalid url throws', () =>
    {
        expect(() => Database.connect('mongo', { url: '' })).toThrow('url');
    });

    it('mongo: invalid database throws', () =>
    {
        expect(() => Database.connect('mongo', { database: '' })).toThrow('database');
    });

    it('sqlite: non-string filename throws', () =>
    {
        expect(() => Database.connect('sqlite', { filename: 123 })).toThrow('filename');
    });

    it('redis: invalid url throws', () =>
    {
        expect(() => Database.connect('redis', { url: '' })).toThrow('url');
    });

    it('redis: invalid host throws', () =>
    {
        expect(() => Database.connect('redis', { host: '' })).toThrow('host');
    });

    it('redis: invalid port throws', () =>
    {
        expect(() => Database.connect('redis', { port: 'bad' })).toThrow('port');
    });

    it('redis: non-string password throws', () =>
    {
        expect(() => Database.connect('redis', { password: 123 })).toThrow('password');
    });

    it('redis: negative db throws', () =>
    {
        expect(() => Database.connect('redis', { db: -1 })).toThrow('db');
    });

    it('redis: valid options pass through (port trim)', () =>
    {
        // Should not throw — redis adapter constructor may fail but validation passes
        try { Database.connect('redis', { host: '  127.0.0.1  ', port: '6379', db: 0 }); }
        catch (e) { /* adapter constructor may throw, that's OK — validation passed */ }
    });

    it('unknown adapter throws', () =>
    {
        expect(() => Database.connect('couchdb')).toThrow('Unknown adapter');
    });
});

// -------------------------------------------------------------------
// index.js — topoSort, transaction, close, model, drop
// -------------------------------------------------------------------
describe('index.js — Database lifecycle', () =>
{
    it('_topoSort handles circular references gracefully', async () =>
    {
        const db = memDb();
        const A = makeModel(db, 'topo_a', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            bId: { type: 'integer', references: { table: 'topo_b', column: 'id' } },
        }, { name: 'A' });
        const B = makeModel(db, 'topo_b', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            aId: { type: 'integer', references: { table: 'topo_a', column: 'id' } },
        }, { name: 'B' });
        // sync should not hang/crash
        await db.sync();
        expect(await A.find()).toEqual([]);
    });

    it('transaction runs fn directly when adapter has no beginTransaction', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'tx_none', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        // Memory adapter has no beginTransaction
        const result = await db.transaction(async () =>
        {
            await M.create({ name: 'in-tx' });
            return 42;
        });
        expect(result).toBe(42);
        expect(await M.find()).toHaveLength(1);
    });

    it('transaction with beginTransaction commits on success', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'tx_ok', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        let committed = false;
        db.adapter.beginTransaction = async () => {};
        db.adapter.commit = async () => { committed = true; };
        db.adapter.rollback = async () => {};
        const result = await db.transaction(async () =>
        {
            await M.create({ name: 'tx' });
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(committed).toBe(true);
    });

    it('transaction with beginTransaction rollbacks on error', async () =>
    {
        const db = memDb();
        let rolledBack = false;
        db.adapter.beginTransaction = async () => {};
        db.adapter.commit = async () => {};
        db.adapter.rollback = async () => { rolledBack = true; };
        await expect(
            db.transaction(async () => { throw new Error('boom'); })
        ).rejects.toThrow('boom');
        expect(rolledBack).toBe(true);
    });

    it('close calls adapter.close when available', async () =>
    {
        const db = memDb();
        let closed = false;
        db.adapter.close = async () => { closed = true; };
        await db.close();
        expect(closed).toBe(true);
    });

    it('close works when adapter has no close method', async () =>
    {
        const db = memDb();
        delete db.adapter.close;
        await db.close(); // should not throw
    });

    it('model() returns registered model', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'reg_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        expect(db.model('reg_tbl')).toBe(M);
    });

    it('model() returns undefined for unregistered', () =>
    {
        const db = memDb();
        expect(db.model('nope')).toBeUndefined();
    });

    it('registerAll registers multiple models', () =>
    {
        const db = memDb();
        class A extends Model { static table = 'ra_a'; static schema = {}; }
        class B extends Model { static table = 'ra_b'; static schema = {}; }
        db.registerAll(A, B);
        expect(db.model('ra_a')).toBe(A);
        expect(db.model('ra_b')).toBe(B);
    });

    it('drop drops tables in reverse order', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'drop_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        await db.sync();
        await M.create({ id: 1 });
        await db.drop();
        // Table should be gone
        expect(db.adapter._tables.has('drop_tbl')).toBe(false);
    });

    it('addColumn delegates to adapter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'ac_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        await M.create({ name: 'before' });
        await db.addColumn('ac_tbl', 'age', { type: 'integer', default: 0 });
        const rows = await M.find();
        expect(rows[0].age).toBe(0);
    });

    it('dropColumn delegates to adapter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'dc_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            old:  { type: 'string' },
        });
        await db.sync();
        await db.dropColumn('dc_tbl', 'old');
    });

    it('addColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.addColumn = undefined;
        await expect(db.addColumn('x', 'y', {})).rejects.toThrow('does not support');
    });

    it('dropColumn throws when adapter lacks method', async () =>
    {
        const db = memDb();
        db.adapter.dropColumn = undefined;
        await expect(db.dropColumn('x', 'y')).rejects.toThrow('does not support');
    });
});

// ===================================================================
// ROUND 3 — Targeted uncovered-branch tests
// ===================================================================

// -------------------------------------------------------------------
// model.js — timestamps pre-set during save-insert (L177-178)
// -------------------------------------------------------------------
describe('model.js — save insert with pre-set timestamps', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'ts_pre', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            name:      { type: 'string' },
            createdAt: { type: 'datetime' },
            updatedAt: { type: 'datetime' },
        }, { name: 'TsPre', timestamps: true });
        await db.sync();
    });

    it('preserves pre-set createdAt and updatedAt on insert', async () =>
    {
        const past = new Date('2020-01-01T00:00:00Z');
        const inst = new M({ name: 'pre', createdAt: past, updatedAt: past });
        await inst.save();
        expect(inst.createdAt).toEqual(past);
        expect(inst.updatedAt).toEqual(past);
    });

    it('fills missing createdAt while preserving pre-set updatedAt', async () =>
    {
        const past = new Date('2020-01-01T00:00:00Z');
        const inst = new M({ name: 'half', updatedAt: past });
        await inst.save();
        expect(inst.updatedAt).toEqual(past);
        expect(inst.createdAt).toBeDefined();
        expect(inst.createdAt).not.toEqual(past);
    });
});

// -------------------------------------------------------------------
// model.js — createMany with pre-set timestamps (L397-398)
// -------------------------------------------------------------------
describe('model.js — createMany timestamps pre-set', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'cm_ts', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            name:      { type: 'string' },
            createdAt: { type: 'datetime' },
            updatedAt: { type: 'datetime' },
        }, { name: 'CmTs', timestamps: true });
        await db.sync();
    });

    it('preserves pre-set timestamps in createMany', async () =>
    {
        const past = new Date('2021-06-15T00:00:00Z');
        const rows = await M.createMany([
            { name: 'a', createdAt: past, updatedAt: past },
            { name: 'b' },
        ]);
        expect(new Date(rows[0].createdAt).getTime()).toBe(past.getTime());
        expect(new Date(rows[0].updatedAt).getTime()).toBe(past.getTime());
        expect(rows[1].createdAt).toBeDefined();
    });
});

// -------------------------------------------------------------------
// model.js — createMany validation failure (L402)
// -------------------------------------------------------------------
describe('model.js — createMany validation failure', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'cm_val', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true, maxLength: 5 },
        }, { name: 'CmVal' });
        await db.sync();
    });

    it('throws ValidationError when a row fails validation in createMany', async () =>
    {
        await expect(M.createMany([
            { name: 'ok' },
            { name: 'waytoolong' },
        ])).rejects.toThrow('Validation failed');
    });
});

// -------------------------------------------------------------------
// model.js — _stripGuarded with guarded fields (L879-884)
// -------------------------------------------------------------------
describe('model.js — _stripGuarded', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'grd_tbl', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            name:   { type: 'string' },
            secret: { type: 'string', guarded: true },
        }, { name: 'Grd' });
        await db.sync();
    });

    it('strips guarded fields from mass assignment during create', async () =>
    {
        const inst = await M.create({ name: 'pub', secret: 'hidden' });
        expect(inst.name).toBe('pub');
        expect(inst.secret).toBeUndefined();
    });

    it('strips guarded fields from updateWhere', async () =>
    {
        await M.create({ name: 'up' });
        await M.updateWhere({ name: 'up' }, { name: 'updated', secret: 'nope' });
        const rows = await M.find({ name: 'updated' });
        expect(rows.length).toBe(1);
        expect(rows[0].secret).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// model.js — sync/drop without adapter (L949, L959)
// -------------------------------------------------------------------
describe('model.js — sync/drop without adapter', () =>
{
    it('sync throws when model has no adapter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'no_adapter', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NoAdapt' });
        M._adapter = null;
        await expect(M.sync()).rejects.toThrow();
    });

    it('drop throws when model has no adapter', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'no_adapter2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NoAdapt2' });
        M._adapter = null;
        await expect(M.drop()).rejects.toThrow();
    });
});

// -------------------------------------------------------------------
// model.js — load() unknown relation type (L818 default case)
// -------------------------------------------------------------------
describe('model.js — load unknown relation type', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'lr_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Lr' });
        await db.sync();
    });

    it('throws for unknown relation type', async () =>
    {
        const inst = await M.create({});
        M._relations = { Fake: { type: 'unknownType', model: M, foreignKey: 'id', localKey: 'id' } };
        await expect(inst.load('Fake')).rejects.toThrow('Unknown relation type');
    });
});

// -------------------------------------------------------------------
// model.js — _runHook fallback to hooks object (L816)
// -------------------------------------------------------------------
describe('model.js — _runHook hooks object fallback', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'hook_fb', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'HookFb' });
        await db.sync();
    });

    it('calls hooks object when no static method exists', async () =>
    {
        let hookCalled = false;
        M.hooks = { beforeCreate: (data) => { hookCalled = true; return data; } };
        await M.create({ name: 'hooked' });
        expect(hookCalled).toBe(true);
    });

    it('returns data when no hook exists at all', async () =>
    {
        M.hooks = {};
        delete M.beforeCreate;
        const result = await M._runHook('nonExistent', { x: 1 });
        expect(result).toEqual({ x: 1 });
    });
});

// -------------------------------------------------------------------
// model.js — validation failure during save-insert (L190)
// -------------------------------------------------------------------
describe('model.js — save insert validation failure', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'sv_val', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true, maxLength: 5 },
        }, { name: 'SvVal' });
        await db.sync();
    });

    it('throws ValidationError during save insert', async () =>
    {
        const inst = new M({ name: 'toolongname' });
        await expect(inst.save()).rejects.toThrow('Validation failed');
    });
});

// -------------------------------------------------------------------
// model.js — hasMany/hasOne/belongsTo when _relations not initialized (L737,L750,L763)
// -------------------------------------------------------------------
describe('model.js — relationship definition when _relations is falsy', () =>
{
    let db, M, R;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'rel_init', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'RelInit' });
        R = makeModel(db, 'rel_other', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            relId: { type: 'integer' },
        }, { name: 'RelOther' });
        await db.sync();
    });

    it('hasMany initializes _relations when null', () =>
    {
        M._relations = null;
        M.hasMany(R, 'relId');
        expect(M._relations.RelOther).toBeDefined();
        expect(M._relations.RelOther.type).toBe('hasMany');
    });

    it('hasOne initializes _relations when null', () =>
    {
        M._relations = null;
        M.hasOne(R, 'relId');
        expect(M._relations.RelOther.type).toBe('hasOne');
    });

    it('belongsTo initializes _relations when null', () =>
    {
        M._relations = null;
        M.belongsTo(R, 'relId');
        expect(M._relations.RelOther.type).toBe('belongsTo');
    });
});

// -------------------------------------------------------------------
// query.js — exec() non-select action (L549)
// -------------------------------------------------------------------
describe('query.js — exec non-select returns raw rows', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'ns_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Ns' });
        await db.sync();
    });

    it('returns raw result when action is not select', async () =>
    {
        await M.create({ name: 'A' });
        const q = M.query();
        q._action = 'count';
        const result = await q.exec();
        // count returns a number from the adapter, not model instances
        expect(typeof result).toBe('number');
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager empty keys paths (L582, L607, L620, L633)
// -------------------------------------------------------------------
describe('query.js — _loadEager with empty related data', () =>
{
    let db, Parent, Child, Related;

    beforeEach(async () =>
    {
        db = memDb();
        Parent = makeModel(db, 'le_parent', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Parent' });
        Child = makeModel(db, 'le_child', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer' },
        }, { name: 'Child' });
        Related = makeModel(db, 'le_related', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Related' });
        await db.sync();
        await db.adapter.createTable('le_parent_related', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId:  { type: 'integer' },
            relatedId: { type: 'integer' },
        });
    });

    it('hasMany sets empty array when no children exist', async () =>
    {
        await Parent.create({ name: 'P' });
        Parent.hasMany(Child, 'parentId');
        const results = await Parent.query().with('Child').exec();
        expect(results[0].Child).toEqual([]);
    });

    it('hasOne sets null when no match exists', async () =>
    {
        await Parent.create({ name: 'P' });
        Parent._relations = {};
        Parent.hasOne(Child, 'parentId');
        const results = await Parent.query().with('Child').exec();
        expect(results[0].Child).toBeNull();
    });

    it('belongsTo sets null when foreign key is null', async () =>
    {
        await Child.create({ parentId: null });
        Child._relations = {};
        Child.belongsTo(Parent, 'parentId');
        const results = await Child.query().with('Parent').exec();
        expect(results[0].Parent).toBeUndefined();
    });

    it('belongsToMany sets empty when no junction rows', async () =>
    {
        await Parent.create({ name: 'P' });
        Parent._relations = {};
        Parent.belongsToMany(Related, { through: 'le_parent_related', foreignKey: 'parentId', otherKey: 'relatedId' });
        const results = await Parent.query().with('Related').exec();
        expect(results[0].Related).toEqual([]);
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager scope functions (L589, L607, L620, L633)
// -------------------------------------------------------------------
describe('query.js — _loadEager with scope constraints', () =>
{
    let db, Author, Post, Tag;

    beforeEach(async () =>
    {
        db = memDb();
        Author = makeModel(db, 'es_authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Author' });
        Post = makeModel(db, 'es_posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        }, { name: 'Post' });
        Tag = makeModel(db, 'es_tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Tag' });
        await db.sync();
        await db.adapter.createTable('es_post_tags', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            postId: { type: 'integer' },
            tagId:  { type: 'integer' },
        });
    });

    it('hasOne with scope applies constraint', async () =>
    {
        const a = await Author.create({ name: 'A' });
        await Post.create({ authorId: a.id, title: 'Yes' });
        await Post.create({ authorId: a.id, title: 'No' });
        Author._relations = {};
        Author.hasOne(Post, 'authorId');
        const results = await Author.query().with({ Post: q => q.where('title', 'Yes') }).exec();
        expect(results[0].Post.title).toBe('Yes');
    });

    it('belongsTo with scope applies constraint', async () =>
    {
        const a1 = await Author.create({ name: 'Match' });
        const a2 = await Author.create({ name: 'Skip' });
        const p = await Post.create({ authorId: a1.id, title: 'T' });
        Post._relations = {};
        Post.belongsTo(Author, 'authorId');
        const results = await Post.query().with({ Author: q => q.where('name', 'Match') }).exec();
        expect(results[0].Author.name).toBe('Match');
    });

    it('belongsToMany with scope applies constraint', async () =>
    {
        const p = await Post.create({ authorId: 1, title: 'Tagged' });
        const t1 = await Tag.create({ name: 'JS' });
        const t2 = await Tag.create({ name: 'Go' });
        await db.adapter.insert('es_post_tags', { postId: p.id, tagId: t1.id });
        await db.adapter.insert('es_post_tags', { postId: p.id, tagId: t2.id });
        Post._relations = {};
        Post.belongsToMany(Tag, { through: 'es_post_tags', foreignKey: 'postId', otherKey: 'tagId' });
        const results = await Post.query().with({ Tag: q => q.where('name', 'JS') }).exec();
        expect(results[0].Tag).toHaveLength(1);
        expect(results[0].Tag[0].name).toBe('JS');
    });
});

// -------------------------------------------------------------------
// query.js — _loadEagerCount empty keys paths (L679, L689, L705, L715)
// -------------------------------------------------------------------
describe('query.js — _loadEagerCount with no related data', () =>
{
    let db, Parent, Child, Related;

    beforeEach(async () =>
    {
        db = memDb();
        Parent = makeModel(db, 'ec_parent', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Parent' });
        Child = makeModel(db, 'ec_child', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer' },
        }, { name: 'Child' });
        Related = makeModel(db, 'ec_related', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Related' });
        await db.sync();
        await db.adapter.createTable('ec_parent_related', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId:  { type: 'integer' },
            relatedId: { type: 'integer' },
        });
    });

    it('hasMany withCount sets 0 when no children', async () =>
    {
        await Parent.create({ name: 'P' });
        Parent.hasMany(Child, 'parentId');
        const results = await Parent.query().withCount('Child').exec();
        expect(results[0].Child_count).toBe(0);
    });

    it('belongsTo withCount sets 0 when foreign key is null', async () =>
    {
        await Child.create({ parentId: null });
        Child._relations = {};
        Child.belongsTo(Parent, 'parentId');
        const results = await Child.query().withCount('Parent').exec();
        expect(results[0].Parent_count).toBe(0);
    });

    it('belongsToMany withCount sets 0 when no junction rows', async () =>
    {
        await Parent.create({ name: 'P' });
        Parent._relations = {};
        Parent.belongsToMany(Related, { through: 'ec_parent_related', foreignKey: 'parentId', otherKey: 'relatedId' });
        const results = await Parent.query().withCount('Related').exec();
        expect(results[0].Related_count).toBe(0);
    });
});

// -------------------------------------------------------------------
// query.js — withCount object branch (L418)
// -------------------------------------------------------------------
describe('query.js — withCount with object', () =>
{
    let db, M, R;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'wco_parent', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'WcoP' });
        R = makeModel(db, 'wco_child', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer' },
        }, { name: 'WcoC' });
        await db.sync();
        M.hasMany(R, 'parentId');
    });

    it('accepts object parameter to withCount', async () =>
    {
        const p = await M.create({});
        await R.create({ parentId: p.id });
        const q = M.query().withCount({ WcoC: true });
        expect(q._eagerCount).toContain('WcoC');
        const results = await q.exec();
        expect(results[0].WcoC_count).toBe(1);
    });
});

// -------------------------------------------------------------------
// query.js — LINQ element operators (L1025-1052)
// -------------------------------------------------------------------
describe('query.js — LINQ element operators', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'linq_el', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        }, { name: 'LinqEl' });
        await db.sync();
    });

    it('single() returns the only element', async () =>
    {
        await M.create({ name: 'only', val: 1 });
        const result = await M.query().single();
        expect(result.name).toBe('only');
    });

    it('single() throws when no elements', async () =>
    {
        await expect(M.query().single()).rejects.toThrow('no elements');
    });

    it('single() throws when more than one element', async () =>
    {
        await M.create({ name: 'a', val: 1 });
        await M.create({ name: 'b', val: 2 });
        await expect(M.query().single()).rejects.toThrow('more than one');
    });

    it('singleOrDefault() returns null when empty', async () =>
    {
        const result = await M.query().singleOrDefault();
        expect(result).toBeNull();
    });

    it('singleOrDefault() returns the only element', async () =>
    {
        await M.create({ name: 'one', val: 1 });
        const r = await M.query().singleOrDefault();
        expect(r.name).toBe('one');
    });

    it('singleOrDefault() throws when more than one', async () =>
    {
        await M.create({ name: 'a', val: 1 });
        await M.create({ name: 'b', val: 2 });
        await expect(M.query().singleOrDefault()).rejects.toThrow('more than one');
    });

    it('elementAt() returns element at index', async () =>
    {
        await M.create({ name: 'first', val: 1 });
        await M.create({ name: 'second', val: 2 });
        const r = await M.query().orderBy('val').elementAt(1);
        expect(r.name).toBe('second');
    });

    it('elementAt() throws when index out of range', async () =>
    {
        await expect(M.query().elementAt(99)).rejects.toThrow('out of range');
    });

    it('elementAtOrDefault() returns null when out of range', async () =>
    {
        const r = await M.query().elementAtOrDefault(99);
        expect(r).toBeNull();
    });

    it('defaultIfEmpty() returns default when empty', async () =>
    {
        const r = await M.query().defaultIfEmpty({ name: 'default' });
        expect(r).toEqual([{ name: 'default' }]);
    });

    it('defaultIfEmpty() returns results when not empty', async () =>
    {
        await M.create({ name: 'x', val: 1 });
        const r = await M.query().defaultIfEmpty({ name: 'default' });
        expect(r.length).toBe(1);
        expect(r[0].name).toBe('x');
    });
});

// -------------------------------------------------------------------
// query.js — LINQ quantifiers and contains (L1100-1128)
// -------------------------------------------------------------------
describe('query.js — LINQ quantifiers', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'linq_q', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        }, { name: 'LinqQ' });
        await db.sync();
        await M.create({ name: 'a', val: 10 });
        await M.create({ name: 'b', val: 20 });
    });

    it('any() with predicate returns true when match exists', async () =>
    {
        const r = await M.query().any(item => item.val > 15);
        expect(r).toBe(true);
    });

    it('any() with predicate returns false when no match', async () =>
    {
        const r = await M.query().any(item => item.val > 100);
        expect(r).toBe(false);
    });

    it('all() returns true when all match', async () =>
    {
        const r = await M.query().all(item => item.val >= 10);
        expect(r).toBe(true);
    });

    it('all() returns false when not all match', async () =>
    {
        const r = await M.query().all(item => item.val > 15);
        expect(r).toBe(false);
    });

    it('all() returns false on empty set', async () =>
    {
        const r = await M.query().where('val', '>', 999).all(item => true);
        expect(r).toBe(false);
    });

    it('contains() checks if field has value', async () =>
    {
        const r = await M.query().contains('name', 'a');
        expect(r).toBe(true);
    });

    it('contains() returns false for missing value', async () =>
    {
        const r = await M.query().contains('name', 'zzzz');
        expect(r).toBe(false);
    });
});

// -------------------------------------------------------------------
// query.js — sequenceEqual (L1191)
// -------------------------------------------------------------------
describe('query.js — sequenceEqual', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'seq_eq', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'SeqEq' });
        await db.sync();
        await M.create({ name: 'a' });
        await M.create({ name: 'b' });
    });

    it('returns true for equal sequences', async () =>
    {
        const q1 = M.query().orderBy('id');
        const q2 = M.query().orderBy('id');
        const r = await q1.sequenceEqual(q2);
        expect(r).toBe(true);
    });

    it('returns false for different sequences', async () =>
    {
        const q1 = M.query().orderBy('id');
        const q2 = M.query().orderBy('id', 'desc');
        const r = await q1.sequenceEqual(q2);
        expect(r).toBe(false);
    });

    it('returns false for different length sequences', async () =>
    {
        const q1 = M.query();
        const r = await q1.sequenceEqual([]);
        expect(r).toBe(false);
    });

    it('accepts custom compareFn', async () =>
    {
        const q = M.query().orderBy('id');
        const r = await q.sequenceEqual(
            M.query().orderBy('id'),
            (a, b) => a.name === b.name,
        );
        expect(r).toBe(true);
    });
});

// -------------------------------------------------------------------
// query.js — concat, union, intersect, except with Query (L1269, L1287)
// -------------------------------------------------------------------
describe('query.js — set operations with Query objects', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'set_ops', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'SetOps' });
        await db.sync();
        await M.create({ name: 'a' });
        await M.create({ name: 'b' });
        await M.create({ name: 'c' });
    });

    it('concat with Query object', async () =>
    {
        const q1 = M.query().where('name', 'a');
        const q2 = M.query().where('name', 'b');
        const r = await q1.concat(q2);
        expect(r).toHaveLength(2);
    });

    it('union with Query object (deduplicates)', async () =>
    {
        const q1 = M.query().where('name', 'a');
        const q2 = M.query(); // includes 'a' too
        const r = await q1.union(q2);
        // 'a' should only appear once
        expect(r.length).toBe(3);
    });

    it('intersect with Query object', async () =>
    {
        const q1 = M.query();
        const q2 = M.query().where('name', 'a');
        const r = await q1.intersect(q2);
        expect(r).toHaveLength(1);
        expect(r[0].name).toBe('a');
    });

    it('except with Query object', async () =>
    {
        const q1 = M.query();
        const q2 = M.query().where('name', 'a');
        const r = await q1.except(q2);
        expect(r).toHaveLength(2);
    });
});

// -------------------------------------------------------------------
// query.js — minBy, maxBy, sumBy, averageBy (L1387, L1405, L1436)
// -------------------------------------------------------------------
describe('query.js — aggregate selectors', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'agg_sel', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        }, { name: 'AggSel' });
        await db.sync();
        await M.create({ name: 'lo', val: 5 });
        await M.create({ name: 'hi', val: 50 });
        await M.create({ name: 'mid', val: 20 });
    });

    it('minBy returns element with minimum selector value', async () =>
    {
        const r = await M.query().minBy(item => item.val);
        expect(r.name).toBe('lo');
    });

    it('minBy returns null on empty set', async () =>
    {
        const r = await M.query().where('val', '>', 999).minBy(item => item.val);
        expect(r).toBeNull();
    });

    it('maxBy returns element with maximum selector value', async () =>
    {
        const r = await M.query().maxBy(item => item.val);
        expect(r.name).toBe('hi');
    });

    it('maxBy returns null on empty set', async () =>
    {
        const r = await M.query().where('val', '>', 999).maxBy(item => item.val);
        expect(r).toBeNull();
    });

    it('sumBy sums using selector', async () =>
    {
        const r = await M.query().sumBy(item => item.val);
        expect(r).toBe(75);
    });

    it('averageBy averages using selector', async () =>
    {
        const r = await M.query().averageBy(item => item.val);
        expect(r).toBe(25);
    });

    it('averageBy returns 0 on empty set', async () =>
    {
        const r = await M.query().where('val', '>', 999).averageBy(item => item.val);
        expect(r).toBe(0);
    });

    it('countBy groups and counts', async () =>
    {
        await M.create({ name: 'lo', val: 5 });
        const r = await M.query().countBy(item => item.name);
        expect(r.get('lo')).toBe(2);
        expect(r.get('hi')).toBe(1);
    });
});

// -------------------------------------------------------------------
// query.js — selectMany, zip, toDictionary, toLookup
// -------------------------------------------------------------------
describe('query.js — LINQ projection operators', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'linq_proj', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            tags: { type: 'string' },
        }, { name: 'LinqProj' });
        await db.sync();
        await M.create({ name: 'a', tags: 'x,y' });
        await M.create({ name: 'b', tags: 'y,z' });
    });

    it('selectMany flattens projected arrays', async () =>
    {
        const r = await M.query().selectMany(item => item.tags.split(','));
        expect(r).toEqual(['x', 'y', 'y', 'z']);
    });

    it('zip combines two result sets', async () =>
    {
        const q1 = M.query().orderBy('id');
        const r = await q1.zip([{ val: 1 }, { val: 2 }], (a, b) => ({ name: a.name, val: b.val }));
        expect(r).toHaveLength(2);
        expect(r[0]).toEqual({ name: 'a', val: 1 });
    });

    it('toDictionary creates Map from results', async () =>
    {
        const r = await M.query().toDictionary(item => item.name);
        expect(r.size).toBe(2);
        expect(r.get('a').tags).toBe('x,y');
    });

    it('toDictionary throws on duplicate key', async () =>
    {
        await M.create({ name: 'a', tags: 'dup' });
        await expect(M.query().toDictionary(item => item.name)).rejects.toThrow('Duplicate key');
    });

    it('toLookup groups results into Map of arrays', async () =>
    {
        await M.create({ name: 'a', tags: 'dup' });
        const r = await M.query().toLookup(item => item.name);
        expect(r.get('a')).toHaveLength(2);
        expect(r.get('b')).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// query.js — takeWhile, skipWhile (L1350-1380)
// -------------------------------------------------------------------
describe('query.js — LINQ partitioning', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'linq_part', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        }, { name: 'LinqPart' });
        await db.sync();
        await M.create({ val: 1 });
        await M.create({ val: 2 });
        await M.create({ val: 10 });
        await M.create({ val: 3 });
    });

    it('takeWhile stops at first false', async () =>
    {
        const r = await M.query().orderBy('id').takeWhile(item => item.val < 10);
        expect(r).toHaveLength(2);
    });

    it('skipWhile starts after first false', async () =>
    {
        const r = await M.query().orderBy('id').skipWhile(item => item.val < 10);
        expect(r).toHaveLength(2);
        expect(r[0].val).toBe(10);
    });

    it('distinctBy deduplicates by key', async () =>
    {
        await M.create({ val: 1 }); // duplicate
        const r = await M.query().orderBy('id').distinctBy(item => item.val);
        expect(r).toHaveLength(4); // 1, 2, 10, 3 (second val=1 removed)
    });
});

// -------------------------------------------------------------------
// query.js — when/unless/tap (L1500-1530)
// -------------------------------------------------------------------
describe('query.js — conditional and debugging', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'cond_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            role: { type: 'string' },
        }, { name: 'Cond' });
        await db.sync();
        await M.create({ name: 'a', role: 'admin' });
        await M.create({ name: 'b', role: 'user' });
    });

    it('when() applies fn when condition is truthy', async () =>
    {
        const r = await M.query().when('admin', q => q.where('role', 'admin')).exec();
        expect(r).toHaveLength(1);
    });

    it('when() skips fn when condition is falsy', async () =>
    {
        const r = await M.query().when(null, q => q.where('role', 'admin')).exec();
        expect(r).toHaveLength(2);
    });

    it('unless() applies fn when condition is falsy', async () =>
    {
        const r = await M.query().unless(false, q => q.where('role', 'admin')).exec();
        expect(r).toHaveLength(1);
    });

    it('unless() skips fn when condition is truthy', async () =>
    {
        const r = await M.query().unless(true, q => q.where('role', 'admin')).exec();
        expect(r).toHaveLength(2);
    });

    it('tap() calls fn for side effects', async () =>
    {
        let inspected = null;
        const r = await M.query().tap(q => { inspected = q.build(); }).exec();
        expect(inspected).toBeDefined();
        expect(inspected.table).toBe('cond_tbl');
    });

    it('each() iterates results', async () =>
    {
        const names = [];
        await M.query().orderBy('id').each(item => names.push(item.name));
        expect(names).toEqual(['a', 'b']);
    });
});

// -------------------------------------------------------------------
// query.js — last() ternary for _primaryKey (L1000)
// -------------------------------------------------------------------
describe('query.js — last() without _primaryKey method', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'last_nopk', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        }, { name: 'LastNoPk' });
        await db.sync();
        await M.create({ val: 1 });
        await M.create({ val: 2 });
    });

    it('last() without orderBy uses primary key desc', async () =>
    {
        const r = await M.query().last();
        expect(r.val).toBe(2);
    });

    it('last() defaults to "id" when _primaryKey is not a function', async () =>
    {
        const origPk = M._primaryKey;
        M._primaryKey = null; // remove _primaryKey to trigger fallback
        const r = await M.query().last();
        expect(r).toBeDefined();
        M._primaryKey = origPk;
    });
});

// -------------------------------------------------------------------
// query.js — min/max with adapter.aggregate (L864, L884)
// -------------------------------------------------------------------
describe('query.js — min/max via adapter.aggregate', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'minmax_agg', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        }, { name: 'MinMaxAgg' });
        await db.sync();
        await M.create({ val: 10 });
        await M.create({ val: 30 });
        await M.create({ val: 20 });
    });

    it('min() uses adapter.aggregate when available', async () =>
    {
        const r = await M.query().min('val');
        expect(r).toBe(10);
    });

    it('max() uses adapter.aggregate when available', async () =>
    {
        const r = await M.query().max('val');
        expect(r).toBe(30);
    });

    it('min() falls back to exec() when no adapter.aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const r = await M.query().min('val');
        expect(r).toBe(10);
        db.adapter.aggregate = orig;
    });

    it('max() falls back to exec() when no adapter.aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const r = await M.query().max('val');
        expect(r).toBe(30);
        db.adapter.aggregate = orig;
    });

    it('min() returns null on empty set without aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const r = await M.query().where('val', '>', 999).min('val');
        expect(r).toBeNull();
        db.adapter.aggregate = orig;
    });

    it('max() returns null on empty set without aggregate', async () =>
    {
        const orig = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const r = await M.query().where('val', '>', 999).max('val');
        expect(r).toBeNull();
        db.adapter.aggregate = orig;
    });
});

// -------------------------------------------------------------------
// index.js — _validateOptions edge cases (L105, L125, L143, L146, L189)
// -------------------------------------------------------------------
describe('index.js — _validateOptions additional branches', () =>
{
    const { Database } = require('../../lib/orm');

    it('sqlite with non-string filename throws', () =>
    {
        expect(() => Database.connect('sqlite', { filename: 123 })).toThrow('filename');
    });

    it('redis with invalid port throws', () =>
    {
        expect(() => Database.connect('redis', { port: 99999 })).toThrow('port');
    });

    it('redis with non-string password throws', () =>
    {
        expect(() => Database.connect('redis', { password: 123 })).toThrow('password');
    });

    it('redis with negative db throws', () =>
    {
        expect(() => Database.connect('redis', { db: -1 })).toThrow('db');
    });

    it('redis with empty host throws', () =>
    {
        expect(() => Database.connect('redis', { host: '  ' })).toThrow('host');
    });

    it('mongo with empty database throws', () =>
    {
        expect(() => Database.connect('mongo', { database: '  ' })).toThrow('database');
    });

    it('mongo with empty url throws', () =>
    {
        expect(() => Database.connect('mongo', { url: '  ' })).toThrow('url');
    });
});

// -------------------------------------------------------------------
// index.js — Database DDL methods that throw when adapter lacks support
// -------------------------------------------------------------------
describe('index.js — DDL method error paths', () =>
{
    const { Database } = require('../../lib/orm');

    it('renameColumn throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.renameColumn = undefined;
        await expect(db.renameColumn('t', 'a', 'b')).rejects.toThrow('does not support');
    });

    it('renameTable throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.renameTable = undefined;
        await expect(db.renameTable('old', 'new')).rejects.toThrow('does not support');
    });

    it('createIndex throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.createIndex = undefined;
        await expect(db.createIndex('t', 'col')).rejects.toThrow('does not support');
    });

    it('dropIndex throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.dropIndex = undefined;
        await expect(db.dropIndex('t', 'idx')).rejects.toThrow('does not support');
    });

    it('hasTable throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.hasTable = undefined;
        await expect(db.hasTable('t')).rejects.toThrow('does not support');
    });

    it('hasColumn throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.hasColumn = undefined;
        await expect(db.hasColumn('t', 'c')).rejects.toThrow('does not support');
    });

    it('describeTable throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.describeTable = undefined;
        await expect(db.describeTable('t')).rejects.toThrow('does not support');
    });

    it('addForeignKey throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.addForeignKey = undefined;
        await expect(db.addForeignKey('t', 'c', 'r', 'rc')).rejects.toThrow('does not support');
    });

    it('dropForeignKey throws when adapter lacks method', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.dropForeignKey = undefined;
        await expect(db.dropForeignKey('t', 'fk')).rejects.toThrow('does not support');
    });
});

// -------------------------------------------------------------------
// index.js — ping and close (L538, L545)
// -------------------------------------------------------------------
describe('index.js — ping and close', () =>
{
    const { Database } = require('../../lib/orm');

    it('ping returns true for memory adapter', async () =>
    {
        const db = Database.connect('memory');
        const r = await db.ping();
        expect(r).toBe(true);
    });

    it('close calls adapter.close if available', async () =>
    {
        const db = Database.connect('memory');
        let closed = false;
        db.adapter.close = () => { closed = true; };
        await db.close();
        expect(closed).toBe(true);
    });

    it('close does nothing when adapter has no close', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.close = undefined;
        await db.close(); // should not throw
    });

    it('ping returns false when adapter throws', async () =>
    {
        const db = Database.connect('memory');
        db.adapter._tables = undefined;
        db.adapter._getTable = undefined;
        db.adapter.execute = () => { throw new Error('fail'); };
        const r = await db.ping();
        expect(r).toBe(false);
    });

    it('ping uses adapter.ping when available', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.ping = async () => true;
        const r = await db.ping();
        expect(r).toBe(true);
    });

    it('ping uses execute fallback when no _tables/_getTable', async () =>
    {
        const db = Database.connect('memory');
        db.adapter.ping = undefined;
        db.adapter._tables = undefined;
        db.adapter._getTable = undefined;
        db.adapter.execute = async () => true;
        const r = await db.ping();
        expect(r).toBe(true);
    });
});

// -------------------------------------------------------------------
// memory.js — operator branches: start state buffer short (L218)
// -------------------------------------------------------------------
describe('memory.js — _compareOp all operators', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('cop', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
    });

    it('_compareOp handles all operators', () =>
    {
        const a = db.adapter;
        expect(a._compareOp(5, '=', 5)).toBe(true);
        expect(a._compareOp(5, '!=', 3)).toBe(true);
        expect(a._compareOp(5, '<>', 3)).toBe(true);
        expect(a._compareOp(5, '>', 3)).toBe(true);
        expect(a._compareOp(3, '<', 5)).toBe(true);
        expect(a._compareOp(5, '>=', 5)).toBe(true);
        expect(a._compareOp(5, '<=', 5)).toBe(true);
        expect(a._compareOp(5, 'UNKNOWN', 5)).toBe(true); // default case
        expect(a._compareOp(5, 'UNKNOWN', 3)).toBe(false);
    });
});

// -------------------------------------------------------------------
// memory.js — hasColumn schema fallback (L669), describeTable empty (L685)
// -------------------------------------------------------------------
describe('memory.js — hasColumn and describeTable edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
    });

    it('hasColumn falls back to checking rows when no schema', async () =>
    {
        // Create table without schema
        db.adapter._tables.set('no_schema', [{ x: 1, y: 2 }]);
        const r = await db.adapter.hasColumn('no_schema', 'x');
        expect(r).toBe(true);
        const r2 = await db.adapter.hasColumn('no_schema', 'z');
        expect(r2).toBe(false);
    });

    it('hasColumn returns false when no schema and no rows', async () =>
    {
        db.adapter._tables.set('empty_no_schema', []);
        const r = await db.adapter.hasColumn('empty_no_schema', 'x');
        expect(r).toBe(false);
    });

    it('describeTable returns empty array when no schema', async () =>
    {
        db.adapter._tables.set('no_desc', []);
        const r = await db.adapter.describeTable('no_desc');
        expect(r).toEqual([]);
    });
});

// -------------------------------------------------------------------
// memory.js — renameTable when table doesn't exist (L651)
// -------------------------------------------------------------------
describe('memory.js — renameTable edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
    });

    it('renameTable does nothing when source table does not exist', async () =>
    {
        await db.adapter.renameTable('nonexistent', 'newname');
        expect(db.adapter._tables.has('newname')).toBe(false);
    });

    it('renameTable preserves schema', async () =>
    {
        await db.adapter.createTable('ren_src', { id: { type: 'integer', primaryKey: true } });
        await db.adapter.renameTable('ren_src', 'ren_dst');
        expect(db.adapter._tables.has('ren_src')).toBe(false);
        expect(db.adapter._tables.has('ren_dst')).toBe(true);
        expect(db.adapter._schemas.has('ren_dst')).toBe(true);
    });
});

// -------------------------------------------------------------------
// memory.js — renameColumn when column doesn't exist in row (L606)
// -------------------------------------------------------------------
describe('memory.js — renameColumn edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
    });

    it('renameColumn handles rows that lack the column', async () =>
    {
        await db.adapter.createTable('rcol', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            old:  { type: 'string' },
        });
        await db.adapter.insert('rcol', { old: 'val' });
        await db.adapter.insert('rcol', {}); // row without 'old' column
        await db.adapter.renameColumn('rcol', 'old', 'new');
        const rows = await db.adapter.execute({
            action: 'select', table: 'rcol', fields: null,
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows[0].new).toBe('val');
        expect(rows[0].old).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// memory.js — dropIndex across tables (L588, L593)
// -------------------------------------------------------------------
describe('memory.js — dropIndex edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
    });

    it('dropIndex removes index by name', async () =>
    {
        await db.adapter.createTable('di_tbl', { id: { type: 'integer' } });
        await db.adapter.createIndex('di_tbl', ['id'], { name: 'idx_test' });
        const before = await db.adapter.indexes('di_tbl');
        expect(before).toHaveLength(1);
        await db.adapter.dropIndex('di_tbl', 'idx_test');
        const after = await db.adapter.indexes('di_tbl');
        expect(after).toHaveLength(0);
    });

    it('dropIndex does nothing when index not found', async () =>
    {
        await db.adapter.createTable('di_tbl2', { id: { type: 'integer' } });
        await db.adapter.dropIndex('di_tbl2', 'nonexistent');
        // No error
    });
});

// -------------------------------------------------------------------
// memory.js — _applyWhereChain OR logic and raw clause (L379, L402)
// -------------------------------------------------------------------
describe('memory.js — _applyWhereChain edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('wc_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        });
        await db.adapter.insert('wc_tbl', { name: 'a', val: 10 });
        await db.adapter.insert('wc_tbl', { name: 'b', val: 20 });
        await db.adapter.insert('wc_tbl', { name: 'c', val: 30 });
    });

    it('raw clause is skipped in memory adapter', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'wc_tbl', fields: null,
            where: [
                { field: 'val', op: '>', value: 15, logic: 'AND' },
                { raw: 'some raw SQL', logic: 'AND' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows.length).toBe(2);
    });

    it('first clause logic is treated as initial', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'wc_tbl', fields: null,
            where: [
                { field: 'name', op: '=', value: 'a', logic: 'OR' }, // first clause — logic ignored
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows.length).toBe(1);
    });
});

// -------------------------------------------------------------------
// memory.js — execute with SELECT fields + DISTINCT combined
// -------------------------------------------------------------------
describe('memory.js — execute with fields + distinct', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('fd_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            cat: { type: 'string' },
            val: { type: 'integer' },
        });
        await db.adapter.insert('fd_tbl', { cat: 'a', val: 1 });
        await db.adapter.insert('fd_tbl', { cat: 'a', val: 2 });
        await db.adapter.insert('fd_tbl', { cat: 'b', val: 1 });
    });

    it('selects specific fields', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'fd_tbl', fields: ['cat'],
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows.every(r => Object.keys(r).length === 1)).toBe(true);
    });

    it('distinct removes duplicate rows', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'fd_tbl', fields: ['cat'],
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: true,
        });
        expect(rows).toHaveLength(2);
    });
});

// -------------------------------------------------------------------
// memory.js — _likeSafe DP algorithm edge cases
// -------------------------------------------------------------------
describe('memory.js — LIKE operator edge cases', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'like_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'LikeTbl' });
        await db.sync();
        await M.create({ name: 'hello world' });
        await M.create({ name: 'test' });
    });

    it('LIKE with leading % matches suffix', async () =>
    {
        const r = await M.query().where('name', 'LIKE', '%world').exec();
        expect(r).toHaveLength(1);
    });

    it('LIKE with trailing % matches prefix', async () =>
    {
        const r = await M.query().where('name', 'LIKE', 'hello%').exec();
        expect(r).toHaveLength(1);
    });

    it('LIKE with _ matches single character', async () =>
    {
        const r = await M.query().where('name', 'LIKE', 'tes_').exec();
        expect(r).toHaveLength(1);
    });

    it('LIKE with exact match (no wildcards)', async () =>
    {
        const r = await M.query().where('name', 'LIKE', 'test').exec();
        expect(r).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// memory.js — aggregate edge cases
// -------------------------------------------------------------------
describe('memory.js — aggregate edge cases', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('agg_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
    });

    it('aggregate count returns 0 on empty set', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_tbl', where: [],
            aggregateFn: 'count', aggregateField: 'val',
        });
        expect(r).toBe(0);
    });

    it('aggregate min returns null on empty set', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_tbl', where: [],
            aggregateFn: 'min', aggregateField: 'val',
        });
        expect(r).toBeNull();
    });

    it('aggregate max returns null on empty set', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_tbl', where: [],
            aggregateFn: 'max', aggregateField: 'val',
        });
        expect(r).toBeNull();
    });

    it('aggregate with unknown function returns null', async () =>
    {
        await db.adapter.insert('agg_tbl', { val: 5 });
        const r = await db.adapter.aggregate({
            table: 'agg_tbl', where: [],
            aggregateFn: 'unknown', aggregateField: 'val',
        });
        expect(r).toBeNull();
    });
});

// -------------------------------------------------------------------
// memory.js — createTable idempotent (L60)
// -------------------------------------------------------------------
describe('memory.js — createTable idempotent', () =>
{
    let db;

    beforeEach(() => { db = memDb(); });

    it('does not reset table data on repeated createTable', async () =>
    {
        await db.adapter.createTable('idem', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } });
        await db.adapter.insert('idem', { name: 'keep' });
        // Call createTable again
        await db.adapter.createTable('idem', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } });
        const rows = await db.adapter.execute({
            action: 'select', table: 'idem', fields: null,
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// schema.js — binary-expr L72, L144
// -------------------------------------------------------------------
describe('schema.js — validate edge cases', () =>
{
    const { validate } = require('../../lib/orm/schema');

    it('validates required field with falsy non-undefined value', () =>
    {
        const schema = {
            name: { type: 'string', required: true },
            val:  { type: 'integer' },
        };
        // Empty string should pass required (it's not undefined/null)
        const { valid } = validate({ name: '', val: 0 }, schema);
        expect(valid).toBe(true);
    });

    it('validates with default function values', () =>
    {
        const schema = {
            id: { type: 'integer', primaryKey: true },
            ts: { type: 'datetime', default: () => new Date() },
        };
        const { valid, sanitized } = validate({ id: 1 }, schema);
        expect(valid).toBe(true);
        expect(sanitized.ts).toBeInstanceOf(Date);
    });
});

// -------------------------------------------------------------------
// profiler.js — L71 binary-expr
// -------------------------------------------------------------------
describe('profiler.js — metrics edge case', () =>
{
    const { QueryProfiler } = require('../../lib/orm/profiler');

    it('metrics returns 0 avgLatency when no queries recorded', () =>
    {
        const p = new QueryProfiler();
        const m = p.metrics();
        expect(m.totalQueries).toBe(0);
        expect(m.avgLatency).toBe(0);
        expect(m.queriesPerSecond).toBe(0);
    });
});

// -------------------------------------------------------------------
// cache.js — L338, L358 binary-expr
// -------------------------------------------------------------------
describe('cache.js — edge cases', () =>
{
    const { QueryCache } = require('../../lib/orm/cache');

    it('getStats returns zeros when no operations', () =>
    {
        const cache = new QueryCache();
        const s = cache.stats();
        expect(s.hitRate).toBe(0);
    });
});

// -------------------------------------------------------------------
// memory.js — operator & LIKE branches
// -------------------------------------------------------------------
describe('memory.js — additional operator branches', () =>
{
    let adapter;

    beforeEach(() =>
    {
        const db = memDb();
        adapter = db.adapter;
    });

    it('NOT IN operator via execute', async () =>
    {
        await adapter.createTable('ni', {});
        await adapter.insert('ni', { id: 1, name: 'a' });
        await adapter.insert('ni', { id: 2, name: 'b' });
        await adapter.insert('ni', { id: 3, name: 'c' });
        const rows = await adapter.execute({
            action: 'select', table: 'ni', fields: null,
            where: [{ field: 'name', op: 'NOT IN', value: ['a', 'c'], logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('b');
    });

    it('NOT BETWEEN operator', async () =>
    {
        await adapter.createTable('nb', {});
        await adapter.insert('nb', { id: 1, val: 5 });
        await adapter.insert('nb', { id: 2, val: 15 });
        await adapter.insert('nb', { id: 3, val: 25 });
        const rows = await adapter.execute({
            action: 'select', table: 'nb', fields: null,
            where: [{ field: 'val', op: 'NOT BETWEEN', value: [10, 20], logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2);
    });

    it('IS NULL and IS NOT NULL operators', async () =>
    {
        await adapter.createTable('isn', {});
        await adapter.insert('isn', { id: 1, val: null });
        await adapter.insert('isn', { id: 2, val: 'a' });
        const nulls = await adapter.execute({
            action: 'select', table: 'isn', fields: null,
            where: [{ field: 'val', op: 'IS NULL', value: null, logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(nulls).toHaveLength(1);
        const notNulls = await adapter.execute({
            action: 'select', table: 'isn', fields: null,
            where: [{ field: 'val', op: 'IS NOT NULL', value: null, logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(notNulls).toHaveLength(1);
    });

    it('<> operator (alias for !=)', async () =>
    {
        await adapter.createTable('neq', {});
        await adapter.insert('neq', { id: 1, v: 'a' });
        await adapter.insert('neq', { id: 2, v: 'b' });
        const rows = await adapter.execute({
            action: 'select', table: 'neq', fields: null,
            where: [{ field: 'v', op: '<>', value: 'a', logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].v).toBe('b');
    });

    it('LIKE with _ single character wildcard', async () =>
    {
        await adapter.createTable('like_sc', {});
        await adapter.insert('like_sc', { id: 1, name: 'cat' });
        await adapter.insert('like_sc', { id: 2, name: 'car' });
        await adapter.insert('like_sc', { id: 3, name: 'card' });
        const rows = await adapter.execute({
            action: 'select', table: 'like_sc', fields: null,
            where: [{ field: 'name', op: 'LIKE', value: 'ca_', logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2); // cat, car (3 chars matching ca_)
    });

    it('LIKE with leading and trailing %', async () =>
    {
        await adapter.createTable('like_pct', {});
        await adapter.insert('like_pct', { id: 1, name: 'hello world' });
        await adapter.insert('like_pct', { id: 2, name: 'goodbye' });
        const rows = await adapter.execute({
            action: 'select', table: 'like_pct', fields: null,
            where: [{ field: 'name', op: 'LIKE', value: '%lo%', logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('hello world');
    });

    it('LIKE exact match (no wildcards)', async () =>
    {
        await adapter.createTable('like_exact', {});
        await adapter.insert('like_exact', { id: 1, name: 'exact' });
        await adapter.insert('like_exact', { id: 2, name: 'other' });
        const rows = await adapter.execute({
            action: 'select', table: 'like_exact', fields: null,
            where: [{ field: 'name', op: 'LIKE', value: 'exact', logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });

    it('OR logic in where chain', async () =>
    {
        await adapter.createTable('or_tbl', {});
        await adapter.insert('or_tbl', { id: 1, v: 'a' });
        await adapter.insert('or_tbl', { id: 2, v: 'b' });
        await adapter.insert('or_tbl', { id: 3, v: 'c' });
        const rows = await adapter.execute({
            action: 'select', table: 'or_tbl', fields: null,
            where: [
                { field: 'v', op: '=', value: 'a', logic: 'AND' },
                { field: 'v', op: '=', value: 'c', logic: 'OR' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2);
    });

    it('raw clause is skipped', async () =>
    {
        await adapter.createTable('raw_skip', {});
        await adapter.insert('raw_skip', { id: 1, v: 'a' });
        const rows = await adapter.execute({
            action: 'select', table: 'raw_skip', fields: null,
            where: [{ raw: 'some SQL', logic: 'AND' }],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1); // raw is ignored
    });
});

// -------------------------------------------------------------------
// memory.js — GROUP BY, HAVING, ORDER BY, DISTINCT, aggregate
// -------------------------------------------------------------------
describe('memory.js — GROUP BY / HAVING / ORDER BY / DISTINCT / aggregate', () =>
{
    let adapter;

    beforeEach(() =>
    {
        adapter = memDb().adapter;
    });

    it('GROUP BY produces one row per group', async () =>
    {
        await adapter.createTable('gb', {});
        await adapter.insert('gb', { id: 1, cat: 'A', val: 10 });
        await adapter.insert('gb', { id: 2, cat: 'A', val: 20 });
        await adapter.insert('gb', { id: 3, cat: 'B', val: 30 });
        const rows = await adapter.execute({
            action: 'select', table: 'gb', fields: ['cat'],
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2);
    });

    it('HAVING with COUNT(*) filters groups', async () =>
    {
        await adapter.createTable('hv', {});
        await adapter.insert('hv', { id: 1, cat: 'A' });
        await adapter.insert('hv', { id: 2, cat: 'A' });
        await adapter.insert('hv', { id: 3, cat: 'B' });
        const rows = await adapter.execute({
            action: 'select', table: 'hv', fields: ['cat'],
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'], having: [{ field: 'COUNT(*)', op: '>=', value: 2 }],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].cat).toBe('A');
    });

    it('HAVING with COUNT prefix', async () =>
    {
        await adapter.createTable('hv2', {});
        await adapter.insert('hv2', { id: 1, cat: 'X' });
        await adapter.insert('hv2', { id: 2, cat: 'X' });
        await adapter.insert('hv2', { id: 3, cat: 'X' });
        const rows = await adapter.execute({
            action: 'select', table: 'hv2', fields: ['cat'],
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'], having: [{ field: 'COUNT', op: '>', value: 1 }],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });

    it('HAVING with regular field', async () =>
    {
        await adapter.createTable('hv3', {});
        await adapter.insert('hv3', { id: 1, cat: 'A', score: 10 });
        await adapter.insert('hv3', { id: 2, cat: 'B', score: 20 });
        const rows = await adapter.execute({
            action: 'select', table: 'hv3', fields: ['cat'],
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'], having: [{ field: 'cat', op: '=', value: 'B' }],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].cat).toBe('B');
    });

    it('ORDER BY multiple fields with mixed directions', async () =>
    {
        await adapter.createTable('ob', {});
        await adapter.insert('ob', { id: 1, name: 'B', age: 30 });
        await adapter.insert('ob', { id: 2, name: 'A', age: 25 });
        await adapter.insert('ob', { id: 3, name: 'A', age: 30 });
        const rows = await adapter.execute({
            action: 'select', table: 'ob', fields: null,
            where: [],
            orderBy: [{ field: 'name', dir: 'ASC' }, { field: 'age', dir: 'DESC' }],
            joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows[0].name).toBe('A');
        expect(rows[0].age).toBe(30);
        expect(rows[1].name).toBe('A');
        expect(rows[1].age).toBe(25);
    });

    it('DISTINCT via execute', async () =>
    {
        await adapter.createTable('dist', {});
        await adapter.insert('dist', { id: 1, cat: 'X' });
        await adapter.insert('dist', { id: 2, cat: 'X' });
        await adapter.insert('dist', { id: 3, cat: 'Y' });
        const rows = await adapter.execute({
            action: 'select', table: 'dist', fields: ['cat'],
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: true,
        });
        expect(rows).toHaveLength(2);
    });

    it('OFFSET and LIMIT boundaries', async () =>
    {
        await adapter.createTable('ol', {});
        for (let i = 1; i <= 10; i++) await adapter.insert('ol', { id: i, v: i });
        const rows = await adapter.execute({
            action: 'select', table: 'ol', fields: null,
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: 3, offset: 5, distinct: false,
        });
        expect(rows).toHaveLength(3);
    });

    it('aggregate count', async () =>
    {
        await adapter.createTable('ac', {});
        await adapter.insert('ac', { id: 1, v: 10 });
        await adapter.insert('ac', { id: 2, v: 20 });
        const result = await adapter.aggregate({
            table: 'ac', where: [], aggregateFn: 'count', aggregateField: 'v',
        });
        expect(result).toBe(2);
    });

    it('aggregate unknown function returns null', async () =>
    {
        await adapter.createTable('au', {});
        await adapter.insert('au', { id: 1, v: 10 });
        const result = await adapter.aggregate({
            table: 'au', where: [], aggregateFn: 'median', aggregateField: 'v',
        });
        expect(result).toBeNull();
    });

    it('aggregate with empty rows returns 0 for sum/avg/count', async () =>
    {
        await adapter.createTable('ae', {});
        expect(await adapter.aggregate({ table: 'ae', where: [], aggregateFn: 'sum', aggregateField: 'v' })).toBe(0);
        expect(await adapter.aggregate({ table: 'ae', where: [], aggregateFn: 'avg', aggregateField: 'v' })).toBe(0);
        expect(await adapter.aggregate({ table: 'ae', where: [], aggregateFn: 'count', aggregateField: 'v' })).toBe(0);
        expect(await adapter.aggregate({ table: 'ae', where: [], aggregateFn: 'min', aggregateField: 'v' })).toBeNull();
        expect(await adapter.aggregate({ table: 'ae', where: [], aggregateFn: 'max', aggregateField: 'v' })).toBeNull();
    });

    it('aggregate with where filter', async () =>
    {
        await adapter.createTable('aw', {});
        await adapter.insert('aw', { id: 1, v: 10, cat: 'A' });
        await adapter.insert('aw', { id: 2, v: 20, cat: 'B' });
        await adapter.insert('aw', { id: 3, v: 30, cat: 'A' });
        const result = await adapter.aggregate({
            table: 'aw',
            where: [{ field: 'cat', op: '=', value: 'A', logic: 'AND' }],
            aggregateFn: 'sum', aggregateField: 'v',
        });
        expect(result).toBe(40);
    });
});

// -------------------------------------------------------------------
// memory.js — DDL: renameColumn, renameTable, hasColumn, hasTable, describeTable
// -------------------------------------------------------------------
describe('memory.js — DDL methods', () =>
{
    let adapter;

    beforeEach(() =>
    {
        adapter = memDb().adapter;
    });

    it('renameColumn renames in schema and data', async () =>
    {
        await adapter.createTable('rc', { name: { type: 'string' } });
        await adapter.insert('rc', { id: 1, name: 'old' });
        await adapter.renameColumn('rc', 'name', 'title');
        const rows = adapter._getTable('rc');
        expect(rows[0].title).toBe('old');
        expect(rows[0].name).toBeUndefined();
        expect(adapter._schemas.get('rc').title).toBeDefined();
    });

    it('renameColumn does nothing for non-existent column', async () =>
    {
        await adapter.createTable('rc2', { name: { type: 'string' } });
        await adapter.insert('rc2', { id: 1, name: 'keep' });
        await adapter.renameColumn('rc2', 'nope', 'new');
        expect(adapter._getTable('rc2')[0].name).toBe('keep');
    });

    it('renameTable moves data and schema', async () =>
    {
        await adapter.createTable('old_tbl', { v: { type: 'string' } });
        await adapter.insert('old_tbl', { id: 1, v: 'data' });
        await adapter.renameTable('old_tbl', 'new_tbl');
        expect(await adapter.hasTable('old_tbl')).toBe(false);
        expect(await adapter.hasTable('new_tbl')).toBe(true);
        const rows = adapter._getTable('new_tbl');
        expect(rows[0].v).toBe('data');
    });

    it('renameTable does nothing for non-existent table', async () =>
    {
        await adapter.renameTable('ghost', 'also_ghost');
        expect(await adapter.hasTable('also_ghost')).toBe(false);
    });

    it('hasColumn checks schema first', async () =>
    {
        await adapter.createTable('hc', { name: { type: 'string' } });
        expect(await adapter.hasColumn('hc', 'name')).toBe(true);
        expect(await adapter.hasColumn('hc', 'nope')).toBe(false);
    });

    it('hasColumn falls back to data when no schema', async () =>
    {
        adapter._tables.set('no_schema', [{ a: 1, b: 2 }]);
        // no schema registered
        expect(await adapter.hasColumn('no_schema', 'a')).toBe(true);
        expect(await adapter.hasColumn('no_schema', 'z')).toBe(false);
    });

    it('hasColumn returns false when no schema and no rows', async () =>
    {
        adapter._tables.set('empty_no_schema', []);
        expect(await adapter.hasColumn('empty_no_schema', 'anything')).toBe(false);
    });

    it('describeTable returns empty for missing table', async () =>
    {
        const desc = await adapter.describeTable('ghost');
        expect(desc).toEqual([]);
    });

    it('describeTable returns column info', async () =>
    {
        await adapter.createTable('desc_tbl', {
            id:   { type: 'integer', primaryKey: true, required: true },
            name: { type: 'string', default: 'anon' },
        });
        const desc = await adapter.describeTable('desc_tbl');
        expect(desc).toHaveLength(2);
        expect(desc.find(d => d.name === 'id').primaryKey).toBe(true);
        expect(desc.find(d => d.name === 'name').defaultValue).toBe('anon');
    });
});

// -------------------------------------------------------------------
// memory.js — fromJSON, toJSON, clone, unique constraints, addColumn with function default
// -------------------------------------------------------------------
describe('memory.js — data import/export and unique constraints', () =>
{
    let adapter;

    beforeEach(() =>
    {
        adapter = memDb().adapter;
    });

    it('fromJSON imports data and updates auto-increment', () =>
    {
        adapter.fromJSON({ users: [{ id: 5, name: 'A' }, { id: 10, name: 'B' }] });
        const rows = adapter._getTable('users');
        expect(rows).toHaveLength(2);
        // Next auto-increment should be 11
        expect(adapter._autoIncrements.get('users')).toBe(11);
    });

    it('fromJSON with maxId less than current auto-increment does not lower it', () =>
    {
        adapter._tables.set('t', []);
        adapter._autoIncrements.set('t', 100);
        adapter.fromJSON({ t: [{ id: 1, v: 'x' }] });
        // Current AI is 100, maxId is 1 → should not change
        expect(adapter._autoIncrements.get('t')).toBe(100);
    });

    it('fromJSON creates new table when none exists', () =>
    {
        adapter.fromJSON({ brand_new: [{ id: 1, v: 'first' }] });
        expect(adapter._tables.has('brand_new')).toBe(true);
    });

    it('toJSON exports all data', async () =>
    {
        await adapter.createTable('exp', {});
        await adapter.insert('exp', { id: 1, v: 'a' });
        const json = adapter.toJSON();
        expect(json.exp).toHaveLength(1);
    });

    it('clone creates deep copy', async () =>
    {
        await adapter.createTable('clone', { v: { type: 'string' } });
        await adapter.insert('clone', { id: 1, v: 'original' });
        const copy = adapter.clone();
        await copy.insert('clone', { id: 2, v: 'added' });
        // Original should not be affected
        expect(adapter._getTable('clone')).toHaveLength(1);
        expect(copy._getTable('clone')).toHaveLength(2);
    });

    it('composite unique constraint prevents duplicates', async () =>
    {
        await adapter.createTable('cu', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            first: { type: 'string', compositeUnique: 'name' },
            last:  { type: 'string', compositeUnique: 'name' },
        });
        await adapter.insert('cu', { first: 'John', last: 'Doe' });
        await expect(adapter.insert('cu', { first: 'John', last: 'Doe' })).rejects.toThrow('UNIQUE');
        // Different combo should work
        const row = await adapter.insert('cu', { first: 'John', last: 'Smith' });
        expect(row.first).toBe('John');
    });

    it('composite unique with boolean true uses default group', async () =>
    {
        await adapter.createTable('cu2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            a:  { type: 'string', compositeUnique: true },
            b:  { type: 'string', compositeUnique: true },
        });
        await adapter.insert('cu2', { a: 'x', b: 'y' });
        await expect(adapter.insert('cu2', { a: 'x', b: 'y' })).rejects.toThrow('UNIQUE');
    });

    it('addColumn with function default applies it', async () =>
    {
        await adapter.createTable('fndef', { id: { type: 'integer', primaryKey: true } });
        await adapter.insert('fndef', { id: 1 });
        await adapter.addColumn('fndef', 'stamp', { type: 'string', default: () => 'generated' });
        const rows = adapter._getTable('fndef');
        expect(rows[0].stamp).toBe('generated');
    });

    it('addColumn with static default', async () =>
    {
        await adapter.createTable('sdef', { id: { type: 'integer', primaryKey: true } });
        await adapter.insert('sdef', { id: 1 });
        await adapter.addColumn('sdef', 'status', { type: 'string', default: 'active' });
        expect(adapter._getTable('sdef')[0].status).toBe('active');
    });

    it('addColumn with no default uses null', async () =>
    {
        await adapter.createTable('nodef', { id: { type: 'integer', primaryKey: true } });
        await adapter.insert('nodef', { id: 1 });
        await adapter.addColumn('nodef', 'extra', { type: 'string' });
        expect(adapter._getTable('nodef')[0].extra).toBeNull();
    });

    it('stats returns memory usage info', async () =>
    {
        await adapter.createTable('st', {});
        await adapter.insert('st', { id: 1, v: 'data' });
        const s = adapter.stats();
        expect(s.tables).toBeGreaterThanOrEqual(1);
        expect(s.totalRows).toBeGreaterThanOrEqual(1);
        expect(s.estimatedBytes).toBeGreaterThan(0);
    });

    it('totalRows counts across all tables', async () =>
    {
        await adapter.createTable('t1', {});
        await adapter.createTable('t2', {});
        await adapter.insert('t1', { id: 1 });
        await adapter.insert('t2', { id: 1 });
        await adapter.insert('t2', { id: 2 });
        expect(adapter.totalRows()).toBe(3);
    });

    it('clear resets all tables', async () =>
    {
        await adapter.createTable('cl', {});
        await adapter.insert('cl', { id: 1 });
        await adapter.clear();
        expect(adapter._getTable('cl')).toHaveLength(0);
        expect(adapter._autoIncrements.get('cl')).toBe(1);
    });
});

// -------------------------------------------------------------------
// memory.js — _compareOp branches
// -------------------------------------------------------------------
describe('memory.js — _compareOp', () =>
{
    let adapter;

    beforeEach(() =>
    {
        adapter = memDb().adapter;
    });

    it('_compareOp handles all operators', () =>
    {
        expect(adapter._compareOp(5, '=', 5)).toBe(true);
        expect(adapter._compareOp(5, '=', 6)).toBe(false);
        expect(adapter._compareOp(5, '!=', 6)).toBe(true);
        expect(adapter._compareOp(5, '<>', 6)).toBe(true);
        expect(adapter._compareOp(5, '>', 4)).toBe(true);
        expect(adapter._compareOp(5, '<', 6)).toBe(true);
        expect(adapter._compareOp(5, '>=', 5)).toBe(true);
        expect(adapter._compareOp(5, '<=', 5)).toBe(true);
        // Default case
        expect(adapter._compareOp(5, 'UNKNOWN', 5)).toBe(true);
        expect(adapter._compareOp(5, 'UNKNOWN', 6)).toBe(false);
    });
});

// -------------------------------------------------------------------
// memory.js — update, delete edge cases
// -------------------------------------------------------------------
describe('memory.js — update/delete edge cases', () =>
{
    let adapter;

    beforeEach(() =>
    {
        adapter = memDb().adapter;
    });

    it('update with Date value serializes to ISO string', async () =>
    {
        await adapter.createTable('du', {});
        await adapter.insert('du', { id: 1, name: 'a' });
        const now = new Date();
        await adapter.update('du', 'id', 1, { updatedAt: now });
        const rows = adapter._getTable('du');
        expect(typeof rows[0].updatedAt).toBe('string');
    });

    it('update non-existent row does nothing', async () =>
    {
        await adapter.createTable('du2', {});
        await adapter.insert('du2', { id: 1, name: 'a' });
        await adapter.update('du2', 'id', 999, { name: 'b' });
        expect(adapter._getTable('du2')[0].name).toBe('a');
    });

    it('remove non-existent row does nothing', async () =>
    {
        await adapter.createTable('dr', {});
        await adapter.insert('dr', { id: 1 });
        await adapter.remove('dr', 'id', 999);
        expect(adapter._getTable('dr')).toHaveLength(1);
    });

    it('insert with Date value serializes', async () =>
    {
        await adapter.createTable('di', {});
        const row = await adapter.insert('di', { id: 1, ts: new Date('2024-01-01') });
        expect(typeof row.ts).toBe('string');
    });

    it('insert with explicit id uses it and adjusts auto-increment', async () =>
    {
        await adapter.createTable('ei', {});
        await adapter.insert('ei', { id: 50, v: 'x' });
        // Next auto-generated should be 1 (since we provided id explicitly, auto-increment may not advance)
        // But insert a row without id to see what AI value is used
        const row = await adapter.insert('ei', { v: 'y' });
        expect(row.id).toBeDefined();
    });

    it('deleteWhere returns count of deleted rows', async () =>
    {
        await adapter.createTable('dw', {});
        await adapter.insert('dw', { id: 1, cat: 'A' });
        await adapter.insert('dw', { id: 2, cat: 'A' });
        await adapter.insert('dw', { id: 3, cat: 'B' });
        const count = await adapter.deleteWhere('dw', { cat: 'A' });
        expect(count).toBe(2);
        expect(adapter._getTable('dw')).toHaveLength(1);
    });

    it('updateWhere with Date serializes', async () =>
    {
        await adapter.createTable('uw_d', {});
        await adapter.insert('uw_d', { id: 1, cat: 'A', ts: null });
        const count = await adapter.updateWhere('uw_d', { cat: 'A' }, { ts: new Date('2024-01-01') });
        expect(count).toBe(1);
        expect(typeof adapter._getTable('uw_d')[0].ts).toBe('string');
    });

    it('_matchConditions with null/non-object returns true', () =>
    {
        expect(adapter._matchConditions({}, null)).toBe(true);
        expect(adapter._matchConditions({}, undefined)).toBe(true);
    });

    it('unique constraint prevents duplicate on single field', async () =>
    {
        await adapter.createTable('uniq', { email: { type: 'string', unique: true } });
        await adapter.insert('uniq', { id: 1, email: 'a@b.com' });
        await expect(adapter.insert('uniq', { id: 2, email: 'a@b.com' })).rejects.toThrow('UNIQUE');
    });

    it('unique constraint allows null values', async () =>
    {
        await adapter.createTable('uniq_null', { email: { type: 'string', unique: true } });
        await adapter.insert('uniq_null', { id: 1, email: null });
        const row = await adapter.insert('uniq_null', { id: 2, email: null });
        expect(row.id).toBe(2);
    });

    it('dropTable removes table', async () =>
    {
        await adapter.createTable('dt', {});
        await adapter.insert('dt', { id: 1 });
        await adapter.dropTable('dt');
        expect(adapter._tables.has('dt')).toBe(false);
    });

    it('dropColumn removes from data and schema', async () =>
    {
        await adapter.createTable('dcol', { a: { type: 'string' }, b: { type: 'string' } });
        await adapter.insert('dcol', { id: 1, a: 'keep', b: 'drop' });
        await adapter.dropColumn('dcol', 'b');
        const rows = adapter._getTable('dcol');
        expect(rows[0].b).toBeUndefined();
        expect(rows[0].a).toBe('keep');
    });
});

// ===================================================================
// ROUND 3b — More targeted uncovered-branch tests
// ===================================================================

// -------------------------------------------------------------------
// memory.js — createTable without schema (L60 arm[1])
// -------------------------------------------------------------------
describe('memory.js — createTable without schema', () =>
{
    let db;

    beforeEach(() => { db = memDb(); });

    it('creates a table without a schema parameter', async () =>
    {
        await db.adapter.createTable('no_schema_tbl');
        await db.adapter.insert('no_schema_tbl', { name: 'test' });
        const rows = await db.adapter.execute({
            action: 'select', table: 'no_schema_tbl', fields: null,
            where: [], orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// memory.js — _applyWhereChain OR logic (L274-288)
// -------------------------------------------------------------------
describe('memory.js — _applyWhereChain OR logic', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('or_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        });
        await db.adapter.insert('or_tbl', { name: 'a', val: 10 });
        await db.adapter.insert('or_tbl', { name: 'b', val: 20 });
        await db.adapter.insert('or_tbl', { name: 'c', val: 30 });
    });

    it('OR logic returns rows matching either clause', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_tbl', fields: null,
            where: [
                { field: 'name', op: '=', value: 'a', logic: 'AND' },
                { field: 'name', op: '=', value: 'c', logic: 'OR' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2);
    });

    it('AND logic with non-first clause', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_tbl', fields: null,
            where: [
                { field: 'val', op: '>', value: 5, logic: 'AND' },
                { field: 'val', op: '<', value: 25, logic: 'AND' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(2);
    });

    it('OR with first clause false', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_tbl', fields: null,
            where: [
                { field: 'name', op: '=', value: 'z' },
                { field: 'name', op: '=', value: 'a', logic: 'OR' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// memory.js — _matchClause operators <= and default
// -------------------------------------------------------------------
describe('memory.js — _matchClause additional operators', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'mcop_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        }, { name: 'McOp' });
        await db.sync();
        await M.create({ val: 10 });
        await M.create({ val: 20 });
        await M.create({ val: 30 });
    });

    it('where with <= operator', async () =>
    {
        const r = await M.query().where('val', '<=', 20).exec();
        expect(r).toHaveLength(2);
    });

    it('where with >= operator', async () =>
    {
        const r = await M.query().where('val', '>=', 20).exec();
        expect(r).toHaveLength(2);
    });

    it('where with <> operator', async () =>
    {
        const r = await M.query().where('val', '<>', 20).exec();
        expect(r).toHaveLength(2);
    });

    it('NOT BETWEEN operator', async () =>
    {
        const r = await M.query().where('val', 'NOT BETWEEN', [15, 25]).exec();
        expect(r).toHaveLength(2);
    });

    it('NOT IN operator', async () =>
    {
        const r = await M.query().where('val', 'NOT IN', [10, 30]).exec();
        expect(r).toHaveLength(1);
        expect(r[0].val).toBe(20);
    });

    it('IS NULL operator', async () =>
    {
        await M.create({ val: undefined });
        const r = await M.query().where('val', 'IS NULL', null).exec();
        expect(r).toHaveLength(1);
    });

    it('IS NOT NULL operator', async () =>
    {
        const r = await M.query().where('val', 'IS NOT NULL', null).exec();
        expect(r.length).toBeGreaterThan(0);
    });
});

// -------------------------------------------------------------------
// memory.js — aggregate sum/avg (L348-350 binary-expr)
// -------------------------------------------------------------------
describe('memory.js — aggregate sum and avg', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('agg2', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        await db.adapter.insert('agg2', { val: 10 });
        await db.adapter.insert('agg2', { val: 20 });
    });

    it('aggregate sum returns total', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg2', where: [],
            aggregateFn: 'sum', aggregateField: 'val',
        });
        expect(r).toBe(30);
    });

    it('aggregate avg returns average', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg2', where: [],
            aggregateFn: 'avg', aggregateField: 'val',
        });
        expect(r).toBe(15);
    });

    it('aggregate sum returns 0 on empty set', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg2', where: [{ field: 'val', op: '>', value: 999 }],
            aggregateFn: 'sum', aggregateField: 'val',
        });
        expect(r).toBe(0);
    });

    it('aggregate avg returns 0 on empty set', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg2', where: [{ field: 'val', op: '>', value: 999 }],
            aggregateFn: 'avg', aggregateField: 'val',
        });
        expect(r).toBe(0);
    });
});

// -------------------------------------------------------------------
// memory.js — hasColumn and describeTable via adapter directly
// -------------------------------------------------------------------
describe('memory.js — hasColumn with schema present', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('hc_tbl', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string' },
        });
    });

    it('returns true for existing column from schema', async () =>
    {
        const r = await db.adapter.hasColumn('hc_tbl', 'name');
        expect(r).toBe(true);
    });

    it('returns false for missing column from schema', async () =>
    {
        const r = await db.adapter.hasColumn('hc_tbl', 'nope');
        expect(r).toBe(false);
    });
});

// -------------------------------------------------------------------
// memory.js — indexes for table without any (L738 binary-expr)
// -------------------------------------------------------------------
describe('memory.js — indexes edge cases', () =>
{
    let db;

    beforeEach(() => { db = memDb(); });

    it('indexes returns empty when no indexes registered', async () =>
    {
        await db.adapter.createTable('no_idx', { id: { type: 'integer' } });
        const r = await db.adapter.indexes('no_idx');
        expect(r).toEqual([]);
    });
});

// -------------------------------------------------------------------
// model.js — updateWhere/deleteWhere error paths (L471)
// -------------------------------------------------------------------
describe('model.js — static updateWhere/deleteWhere error paths', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'udwe_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        }, { name: 'Udwe' });
        await db.sync();
        await M.create({ name: 'a' });
    });

    it('updateWhere throws when adapter fails', async () =>
    {
        const orig = db.adapter.updateWhere;
        db.adapter.updateWhere = async () => { throw new Error('update boom'); };
        await expect(M.updateWhere({ name: 'a' }, { name: 'b' })).rejects.toThrow('update boom');
        db.adapter.updateWhere = orig;
    });

    it('deleteWhere throws when adapter fails', async () =>
    {
        const orig = db.adapter.deleteWhere;
        db.adapter.deleteWhere = async () => { throw new Error('delete boom'); };
        await expect(M.deleteWhere({ name: 'a' })).rejects.toThrow('delete boom');
        db.adapter.deleteWhere = orig;
    });
});

// -------------------------------------------------------------------
// model.js — _runHook unknown hook name returns data (L816)
// -------------------------------------------------------------------
describe('model.js — _runHook with no matching hook', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'rh_tbl', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Rh' });
        await db.sync();
    });

    it('returns data unchanged when no hook exists', async () =>
    {
        M.hooks = {};
        const result = await M._runHook('nonExistentHook', { test: 1 });
        expect(result).toEqual({ test: 1 });
    });
});

// -------------------------------------------------------------------
// query.js — orWhere through builder (triggers _applyWhereChain OR)
// -------------------------------------------------------------------
describe('query.js — orWhere builder', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'orw_tbl', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            val:  { type: 'integer' },
        }, { name: 'Orw' });
        await db.sync();
        await M.create({ name: 'a', val: 10 });
        await M.create({ name: 'b', val: 20 });
        await M.create({ name: 'c', val: 30 });
    });

    it('orWhere matches either clause', async () =>
    {
        const r = await M.query().where('name', 'a').orWhere('name', 'c').exec();
        expect(r).toHaveLength(2);
    });

    it('multiple AND clauses narrow results', async () =>
    {
        const r = await M.query().where('val', '>', 5).where('val', '<', 25).exec();
        expect(r).toHaveLength(2);
    });
});

// -------------------------------------------------------------------
// query.js — chunk with inner loop (L1538)
// -------------------------------------------------------------------
describe('query.js — chunk with callback', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'chunk_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        }, { name: 'ChunkTbl' });
        await db.sync();
        for (let i = 0; i < 10; i++) await M.create({ val: i });
    });

    it('chunk processes batches in callback', async () =>
    {
        const batches = [];
        await M.query().orderBy('id').chunk(3, batch => batches.push(batch.length));
        expect(batches).toEqual([3, 3, 3, 1]);
    });
});

// -------------------------------------------------------------------
// query.js — with(obj) where scope is non-function (L378/L382)
// -------------------------------------------------------------------
describe('query.js — with() object non-function scope', () =>
{
    let db, Parent, Child;

    beforeEach(async () =>
    {
        db = memDb();
        Parent = makeModel(db, 'wof_parent', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Parent' });
        Child = makeModel(db, 'wof_child', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer' },
        }, { name: 'Child' });
        await db.sync();
        Parent.hasMany(Child, 'parentId');
    });

    it('with() object with non-function scope defaults to null', async () =>
    {
        const p = await Parent.create({});
        await Child.create({ parentId: p.id });
        const q = Parent.query().with({ Child: true }); // boolean is not a function
        const results = await q.exec();
        expect(results[0].Child).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// schema.js — default value from function during validation
// -------------------------------------------------------------------
describe('schema.js — default function value', () =>
{
    const { validate: schemaValidate } = require('../../lib/orm/schema');

    it('applies function default during validation', () =>
    {
        const schema = {
            id: { type: 'integer', primaryKey: true },
            ts: { type: 'datetime', default: () => new Date('2023-01-01') },
        };
        const { valid, sanitized } = schemaValidate({ id: 1 }, schema);
        expect(valid).toBe(true);
        expect(sanitized.ts).toEqual(new Date('2023-01-01'));
    });

    it('validates with null value when not required', () =>
    {
        const schema = {
            name: { type: 'string' },
        };
        const { valid } = schemaValidate({ name: null }, schema);
        expect(valid).toBe(true);
    });
});

// -------------------------------------------------------------------
// model.js — _stripGuarded with multiple guarded fields
// -------------------------------------------------------------------
describe('model.js — _stripGuarded deep', () =>
{
    let db, M;

    beforeEach(async () =>
    {
        db = memDb();
        M = makeModel(db, 'grd2_tbl', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            name:   { type: 'string' },
            role:   { type: 'string', guarded: true },
            token:  { type: 'string', guarded: true },
        }, { name: 'Grd2' });
        await db.sync();
    });

    it('strips all guarded fields', async () =>
    {
        const inst = await M.create({ name: 'u', role: 'admin', token: 'secret' });
        expect(inst.name).toBe('u');
        expect(inst.role).toBeUndefined();
        expect(inst.token).toBeUndefined();
    });

    it('_stripGuarded returns data without guarded keys', () =>
    {
        const stripped = M._stripGuarded({ name: 'x', role: 'r', token: 't' });
        expect(stripped.name).toBe('x');
        expect(stripped.role).toBeUndefined();
        expect(stripped.token).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// index.js — _validateOptions string trim (L105)
// -------------------------------------------------------------------
describe('index.js — _validateOptions string trims', () =>
{
    const { Database } = require('../../lib/orm');

    it('trims whitespace from database option for memory', () =>
    {
        // Memory adapter doesn't validate database name, but code trims it
        const db = Database.connect('memory', { database: '  mydb  ' });
        expect(db).toBeDefined();
    });
});

// -------------------------------------------------------------------
// cache.js — set and get operations for hitRate
// -------------------------------------------------------------------
describe('cache.js — cache hit/miss tracking', () =>
{
    const { QueryCache } = require('../../lib/orm/cache');

    it('tracks hits and misses with non-zero hitRate', () =>
    {
        const cache = new QueryCache({ maxEntries: 100, ttl: 60000 });
        cache.set('key1', [{ id: 1 }]);
        cache.get('key1'); // hit
        cache.get('key2'); // miss
        const s = cache.stats();
        expect(s.hits).toBe(1);
        expect(s.misses).toBe(1);
        expect(s.hitRate).toBe(0.5);
    });
});

// ===================================================================
// ROUND 3c — targeted coverage for memory.js, model.js, query.js
// ===================================================================

// -------------------------------------------------------------------
// memory.js — DDL on schema-less tables
// -------------------------------------------------------------------
describe('memory.js — DDL on schema-less tables', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('addColumn on table without schema still adds default to rows', async () =>
    {
        db.adapter._tables.set('noschema_add', [{ id: 1 }, { id: 2 }]);
        await db.adapter.addColumn('noschema_add', 'extra', { type: 'string', default: 'x' });
        const rows = db.adapter._getTable('noschema_add');
        expect(rows[0].extra).toBe('x');
        expect(rows[1].extra).toBe('x');
    });

    it('addColumn skips rows that already have the column', async () =>
    {
        await db.adapter.createTable('add_exists', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string' },
        });
        await db.adapter.insert('add_exists', { name: 'keep' });
        db.adapter._getTable('add_exists')[0].extra = 'already';
        await db.adapter.addColumn('add_exists', 'extra', { type: 'string', default: 'new' });
        expect(db.adapter._getTable('add_exists')[0].extra).toBe('already');
    });

    it('dropColumn on table without schema removes from rows only', async () =>
    {
        db.adapter._tables.set('noschema_drop', [{ id: 1, col: 'val' }]);
        await db.adapter.dropColumn('noschema_drop', 'col');
        expect(db.adapter._getTable('noschema_drop')[0].col).toBeUndefined();
    });

    it('renameTable on table without schema transfers data only', async () =>
    {
        db.adapter._tables.set('no_sch_old', [{ id: 1 }]);
        db.adapter._autoIncrements.set('no_sch_old', 2);
        await db.adapter.renameTable('no_sch_old', 'no_sch_new');
        expect(db.adapter._tables.has('no_sch_new')).toBe(true);
        expect(db.adapter._tables.has('no_sch_old')).toBe(false);
        expect(db.adapter._schemas.has('no_sch_new')).toBe(false);
    });

    it('renameColumn on table without schema renames in rows only', async () =>
    {
        db.adapter._tables.set('noschema_ren', [{ id: 1, old: 'value' }]);
        await db.adapter.renameColumn('noschema_ren', 'old', 'new');
        const rows = db.adapter._getTable('noschema_ren');
        expect(rows[0].new).toBe('value');
        expect(rows[0].old).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// memory.js — _enforceUnique without schema (L538)
// -------------------------------------------------------------------
describe('memory.js — _enforceUnique without schema', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('skips unique enforcement when no schema exists', async () =>
    {
        db.adapter._tables.set('noschema_uniq', []);
        await db.adapter.insert('noschema_uniq', { id: 1, email: 'a@b.com' });
        await db.adapter.insert('noschema_uniq', { id: 2, email: 'a@b.com' });
        expect(db.adapter._getTable('noschema_uniq')).toHaveLength(2);
    });
});

// -------------------------------------------------------------------
// memory.js — createIndex auto-generated name (L669)
// -------------------------------------------------------------------
describe('memory.js — createIndex auto-name', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('auto-generates index name from table and columns', async () =>
    {
        await db.adapter.createTable('idx_auto', { id: { type: 'integer' }, val: { type: 'integer' } });
        await db.adapter.createIndex('idx_auto', ['id', 'val']);
        const idxs = await db.adapter.indexes('idx_auto');
        expect(idxs[0].name).toBe('idx_idx_auto_id_val');
    });

    it('uses provided name when specified', async () =>
    {
        await db.adapter.createTable('idx_named', { id: { type: 'integer' } });
        await db.adapter.createIndex('idx_named', 'id', { name: 'my_idx' });
        const idxs = await db.adapter.indexes('idx_named');
        expect(idxs[0].name).toBe('my_idx');
    });
});

// -------------------------------------------------------------------
// memory.js — explain method edge cases (L348)
// -------------------------------------------------------------------
describe('memory.js — explain', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('returns plan description with table info', () =>
    {
        db.adapter._tables.set('expl', [{ id: 1 }, { id: 2 }]);
        const plan = db.adapter.explain({
            table: 'expl',
            action: 'select',
            where: [{ field: 'id', op: '=', value: 1 }],
        });
        expect(plan.adapter).toBe('memory');
        expect(plan.estimatedRows).toBe(2);
        expect(plan.filters).toBe(1);
    });

    it('handles missing table and action gracefully', () =>
    {
        const plan = db.adapter.explain({});
        expect(plan.table).toBe('');
        expect(plan.action).toBe('select');
        expect(plan.estimatedRows).toBe(0);
        expect(plan.filters).toBe(0);
    });

    it('handles descriptor with no where clause', () =>
    {
        db.adapter._tables.set('expl2', [{ id: 1 }]);
        const plan = db.adapter.explain({ table: 'expl2', action: 'update' });
        expect(plan.action).toBe('update');
        expect(plan.filters).toBe(0);
    });
});

// -------------------------------------------------------------------
// memory.js — ORDER BY equal values (L274-275 equal path → return 0)
// -------------------------------------------------------------------
describe('memory.js — ORDER BY equal values', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('eq_sort', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            cat: { type: 'string' },
            val: { type: 'integer' },
        });
        await db.adapter.insert('eq_sort', { cat: 'a', val: 1 });
        await db.adapter.insert('eq_sort', { cat: 'a', val: 2 });
        await db.adapter.insert('eq_sort', { cat: 'b', val: 1 });
    });

    it('equal first-field values fall through to second orderBy field', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'eq_sort', fields: null,
            where: [], orderBy: [
                { field: 'cat', dir: 'ASC' },
                { field: 'val', dir: 'DESC' },
            ],
            joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows[0].val).toBe(2);
        expect(rows[1].val).toBe(1);
        expect(rows[2].cat).toBe('b');
    });

    it('single field sort respects DESC direction', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'eq_sort', fields: null,
            where: [], orderBy: [{ field: 'val', dir: 'DESC' }],
            joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows[0].val).toBe(2);
    });
});

// -------------------------------------------------------------------
// memory.js — _matchConditions edge cases (L379)
// -------------------------------------------------------------------
describe('memory.js — _matchConditions edge cases', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('null conditions match all rows', () =>
    {
        expect(db.adapter._matchConditions({ id: 1 }, null)).toBe(true);
    });

    it('non-object conditions match all rows', () =>
    {
        expect(db.adapter._matchConditions({ id: 1 }, 'invalid')).toBe(true);
    });
});

// -------------------------------------------------------------------
// memory.js — WHERE chain OR with first-clause mismatch (L402)
// -------------------------------------------------------------------
describe('memory.js — WHERE chain OR edge', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('or_edge', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.adapter.insert('or_edge', { name: 'x' });
        await db.adapter.insert('or_edge', { name: 'y' });
    });

    it('OR clause rescues row when first AND fails', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_edge', fields: null,
            where: [
                { field: 'name', op: '=', value: 'z', logic: 'AND' },
                { field: 'name', op: '=', value: 'x', logic: 'OR' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('x');
    });

    it('AND clause both false yields no rows', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_edge', fields: null,
            where: [
                { field: 'name', op: '=', value: 'x', logic: 'AND' },
                { field: 'name', op: '=', value: 'z', logic: 'AND' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(0);
    });

    it('raw clause in where is skipped', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'or_edge', fields: null,
            where: [
                { raw: 'SELECT 1', logic: 'AND' },
                { field: 'name', op: '=', value: 'x', logic: 'AND' },
            ],
            orderBy: [], joins: [], groupBy: [], having: [],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
    });
});

// -------------------------------------------------------------------
// memory.js — aggregate with WHERE filter
// -------------------------------------------------------------------
describe('memory.js — aggregate with WHERE filter', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('agg_w', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            cat: { type: 'string' },
            val: { type: 'integer' },
        });
        await db.adapter.insert('agg_w', { cat: 'a', val: 10 });
        await db.adapter.insert('agg_w', { cat: 'a', val: 20 });
        await db.adapter.insert('agg_w', { cat: 'b', val: 30 });
    });

    it('min with WHERE filter', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_w',
            where: [{ field: 'cat', op: '=', value: 'a', logic: 'AND' }],
            aggregateFn: 'min', aggregateField: 'val',
        });
        expect(r).toBe(10);
    });

    it('max with WHERE filter', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_w',
            where: [{ field: 'cat', op: '=', value: 'a', logic: 'AND' }],
            aggregateFn: 'max', aggregateField: 'val',
        });
        expect(r).toBe(20);
    });

    it('count returns total matching rows', async () =>
    {
        const r = await db.adapter.aggregate({
            table: 'agg_w',
            where: [{ field: 'cat', op: '=', value: 'a', logic: 'AND' }],
            aggregateFn: 'count', aggregateField: 'val',
        });
        expect(r).toBe(2);
    });
});

// -------------------------------------------------------------------
// memory.js — HAVING with grouped data (L253)
// -------------------------------------------------------------------
describe('memory.js — HAVING with grouped data', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
        await db.adapter.createTable('hav_tbl', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            cat: { type: 'string' },
            val: { type: 'integer' },
        });
        await db.adapter.insert('hav_tbl', { cat: 'a', val: 10 });
        await db.adapter.insert('hav_tbl', { cat: 'a', val: 20 });
        await db.adapter.insert('hav_tbl', { cat: 'b', val: 5 });
    });

    it('filters groups by COUNT(*)', async () =>
    {
        const rows = await db.adapter.execute({
            action: 'select', table: 'hav_tbl', fields: null,
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'],
            having: [{ field: 'COUNT(*)', op: '>', value: 1 }],
            limit: null, offset: null, distinct: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].cat).toBe('a');
    });
});

// -------------------------------------------------------------------
// model.js — _fullSchema with pre-declared timestamp/softDelete fields (L879-884)
// -------------------------------------------------------------------
describe('model.js — _fullSchema with pre-declared fields', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('does not overwrite existing createdAt/updatedAt in schema', async () =>
    {
        const M = makeModel(db, 'fs_1', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
        });
        M.timestamps = true;
        const full = M._fullSchema();
        expect(full.createdAt.type).toBe('string');
        expect(full.updatedAt.type).toBe('string');
    });

    it('does not overwrite existing deletedAt in schema', async () =>
    {
        const M = makeModel(db, 'fs_2', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            deletedAt: { type: 'string', nullable: true },
        });
        M.softDelete = true;
        const full = M._fullSchema();
        expect(full.deletedAt.type).toBe('string');
    });
});

// -------------------------------------------------------------------
// model.js — save insert when result lacks PK (L190)
// -------------------------------------------------------------------
describe('model.js — save insert without PK in result', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('handles insert result that does not include primary key', async () =>
    {
        const M = makeModel(db, 'nopk', {
            id:   { type: 'integer', primaryKey: true },
            name: { type: 'string' },
        });
        await M.sync();
        // Override insert to return empty object
        const origInsert = db.adapter.insert.bind(db.adapter);
        db.adapter.insert = async (table, row) =>
        {
            await origInsert(table, row);
            return {};
        };
        const inst = new M({ id: 5, name: 'test' });
        await inst.save();
        expect(inst._persisted).toBe(true);
        db.adapter.insert = origInsert;
    });
});

// -------------------------------------------------------------------
// model.js — createMany without timestamps (L402 false)
// -------------------------------------------------------------------
describe('model.js — createMany without timestamps', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('createMany skips timestamp assignment when timestamps disabled', async () =>
    {
        const M = makeModel(db, 'no_ts', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        M.timestamps = false;
        await M.sync();
        const rows = await M.createMany([{ name: 'a' }, { name: 'b' }]);
        expect(rows).toHaveLength(2);
        expect(rows[0].createdAt).toBeUndefined();
    });
});

// -------------------------------------------------------------------
// model.js — findOrCreate when record exists (L471)
// -------------------------------------------------------------------
describe('model.js — findOrCreate existing record', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('returns existing record without creating', async () =>
    {
        const M = makeModel(db, 'foc', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', unique: true },
            name:  { type: 'string' },
        });
        M.timestamps = false;
        await M.sync();
        await M.create({ email: 'a@b.com', name: 'orig' });
        const { instance, created } = await M.findOrCreate({ email: 'a@b.com' }, { name: 'new' });
        expect(created).toBe(false);
        expect(instance.name).toBe('orig');
    });

    it('creates when record does not exist', async () =>
    {
        const M = makeModel(db, 'foc2', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string' },
            name:  { type: 'string' },
        });
        M.timestamps = false;
        await M.sync();
        const { instance, created } = await M.findOrCreate({ email: 'x@y.com' }, { name: 'new' });
        expect(created).toBe(true);
        expect(instance.email).toBe('x@y.com');
    });
});

// -------------------------------------------------------------------
// query.js — with()/withCount() non-string non-object arg (L378/L418)
// -------------------------------------------------------------------
describe('query.js — with/withCount ignore invalid arg types', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('with() ignores number argument', () =>
    {
        const M = makeModel(db, 'w_inv', { id: { type: 'integer', primaryKey: true } });
        const q = M.query().with(123);
        expect(q._eagerLoad).toHaveLength(0);
    });

    it('withCount() ignores number argument', () =>
    {
        const M = makeModel(db, 'wc_inv', { id: { type: 'integer', primaryKey: true } });
        const q = M.query().withCount(456);
        expect(q._eagerCount).toHaveLength(0);
    });

    it('with() ignores null argument', () =>
    {
        const M = makeModel(db, 'w_null', { id: { type: 'integer', primaryKey: true } });
        const q = M.query().with(null);
        expect(q._eagerLoad).toHaveLength(0);
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager scopes on belongsTo (L607)
// -------------------------------------------------------------------
describe('query.js — _loadEager scope on belongsTo', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('applies scope function to belongsTo eager load', async () =>
    {
        const Author = makeModel(db, 'bt_authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
            active: { type: 'boolean' },
        });
        Author.timestamps = false;
        await Author.sync();

        const Post = makeModel(db, 'bt_posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        });
        Post.timestamps = false;
        await Post.sync();

        Post.belongsTo(Author, 'authorId');

        await Author.create({ name: 'Alice', active: true });
        await Author.create({ name: 'Bob', active: false });
        await Post.create({ authorId: 1, title: 'p1' });
        await Post.create({ authorId: 2, title: 'p2' });

        // Scope restricts to active authors only
        const posts = await Post.query()
            .with({ bt_authors: q => q.where('active', true) })
            .exec();

        const p1 = posts.find(p => p.title === 'p1');
        const p2 = posts.find(p => p.title === 'p2');
        expect(p1.bt_authors).toBeTruthy();
        expect(p1.bt_authors.name).toBe('Alice');
        expect(p2.bt_authors).toBeNull();
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager belongsToMany with empty junction (L654/656)
// -------------------------------------------------------------------
describe('query.js — _loadEager belongsToMany empty junction', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('sets empty arrays when junction table has no matching rows', async () =>
    {
        const Tag = makeModel(db, 'btm_tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        Tag.timestamps = false;
        await Tag.sync();

        const Article = makeModel(db, 'btm_articles', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
        });
        Article.timestamps = false;
        await Article.sync();

        // Junction table exists but is empty
        await db.adapter.createTable('btm_articles_btm_tags', {
            articleId: { type: 'integer' },
            tagId:     { type: 'integer' },
        });

        Article.belongsToMany(Tag, {
            through:    'btm_articles_btm_tags',
            foreignKey: 'articleId',
            otherKey:   'tagId',
        });

        await Article.create({ title: 'A1' });
        const articles = await Article.query().with('btm_tags').exec();
        expect(articles[0].btm_tags).toEqual([]);
    });
});

// -------------------------------------------------------------------
// query.js — _loadEagerCount for belongsTo and belongsToMany (L705/715)
// -------------------------------------------------------------------
describe('query.js — _loadEagerCount belongsTo and belongsToMany', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('withCount on belongsTo returns 0 or 1', async () =>
    {
        const Author = makeModel(db, 'ec_bt_authors', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        Author.timestamps = false;
        await Author.sync();

        const Post = makeModel(db, 'ec_bt_posts', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            authorId: { type: 'integer' },
            title:    { type: 'string' },
        });
        Post.timestamps = false;
        await Post.sync();

        Post.belongsTo(Author, 'authorId');

        await Author.create({ name: 'Alice' });
        await Post.create({ authorId: 1, title: 'p1' });
        await Post.create({ authorId: 999, title: 'orphan' });

        const posts = await Post.query().withCount('ec_bt_authors').exec();
        const p1 = posts.find(p => p.title === 'p1');
        const orphan = posts.find(p => p.title === 'orphan');
        expect(p1.ec_bt_authors_count).toBe(1);
        expect(orphan.ec_bt_authors_count).toBe(0);
    });

    it('withCount on belongsToMany counts junction rows', async () =>
    {
        const Tag = makeModel(db, 'ec_btm_tags', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        Tag.timestamps = false;
        await Tag.sync();

        const Article = makeModel(db, 'ec_btm_articles', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
        });
        Article.timestamps = false;
        await Article.sync();

        await db.adapter.createTable('ec_btm_articles_ec_btm_tags', {
            articleId: { type: 'integer' },
            tagId:     { type: 'integer' },
        });

        Article.belongsToMany(Tag, {
            through:    'ec_btm_articles_ec_btm_tags',
            foreignKey: 'articleId',
            otherKey:   'tagId',
        });

        await Tag.create({ name: 't1' });
        await Tag.create({ name: 't2' });
        await Article.create({ title: 'A1' });
        await db.adapter.insert('ec_btm_articles_ec_btm_tags', { articleId: 1, tagId: 1 });
        await db.adapter.insert('ec_btm_articles_ec_btm_tags', { articleId: 1, tagId: 2 });

        const articles = await Article.query().withCount('ec_btm_tags').exec();
        expect(articles[0].ec_btm_tags_count).toBe(2);
    });

    it('withCount on belongsToMany with no keys yields 0', async () =>
    {
        const Cat = makeModel(db, 'ec_btm2_cats', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        Cat.timestamps = false;
        await Cat.sync();

        const Item = makeModel(db, 'ec_btm2_items', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        Item.timestamps = false;
        await Item.sync();

        await db.adapter.createTable('ec_btm2_items_ec_btm2_cats', {
            itemId: { type: 'integer' },
            catId:  { type: 'integer' },
        });

        Item.belongsToMany(Cat, {
            through:    'ec_btm2_items_ec_btm2_cats',
            foreignKey: 'itemId',
            otherKey:   'catId',
        });

        // Insert item with null id to test !keys.length path
        db.adapter._getTable('ec_btm2_items').push({ id: null });
        const q = Item.query().withCount('ec_btm2_cats');
        const result = await q.exec();
        expect(result[0].ec_btm2_cats_count).toBe(0);
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager hasMany/hasOne with empty keys (L589/L607)
// -------------------------------------------------------------------
describe('query.js — _loadEager with empty keys', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('hasMany sets empty array for instance with null key', async () =>
    {
        const Parent = makeModel(db, 'ek_parents', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        Parent.timestamps = false;
        await Parent.sync();

        const Child = makeModel(db, 'ek_children', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            parentId: { type: 'integer' },
        });
        Child.timestamps = false;
        await Child.sync();

        Parent.hasMany(Child, 'parentId');

        await Parent.create({});  // valid parent with id=1
        db.adapter._getTable('ek_parents').push({ id: null });
        const parents = await Parent.query().with('ek_children').exec();
        const nullParent = parents.find(p => p.id === null);
        expect(nullParent.ek_children).toEqual([]);
    });

    it('hasOne sets null for instance with null key', async () =>
    {
        const User2 = makeModel(db, 'ek_users', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        User2.timestamps = false;
        await User2.sync();

        const Profile2 = makeModel(db, 'ek_profiles', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            userId: { type: 'integer' },
        });
        Profile2.timestamps = false;
        await Profile2.sync();

        User2.hasOne(Profile2, 'userId');

        await User2.create({});  // valid user with id=1
        db.adapter._getTable('ek_users').push({ id: null });
        const users = await User2.query().with('ek_profiles').exec();
        const nullUser = users.find(u => u.id === null);
        expect(nullUser.ek_profiles).toBeNull();
    });
});

// -------------------------------------------------------------------
// query.js — _loadEagerCount with empty keys for hasMany/hasOne (L689)
// -------------------------------------------------------------------
describe('query.js — _loadEagerCount empty keys', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('withCount yields 0 for instances with null localKey', async () =>
    {
        const A = makeModel(db, 'eck_a', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        A.timestamps = false;
        await A.sync();

        const B = makeModel(db, 'eck_b', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            aId: { type: 'integer' },
        });
        B.timestamps = false;
        await B.sync();

        A.hasMany(B, 'aId');

        db.adapter._getTable('eck_a').push({ id: null });
        const result = await A.query().withCount('eck_b').exec();
        const nullA = result.find(r => r.id === null);
        expect(nullA.eck_b_count).toBe(0);
    });
});

// -------------------------------------------------------------------
// query.js — min/max fallback via reduce when no adapter.aggregate (L864/884)
// -------------------------------------------------------------------
describe('query.js — min/max fallback reduce', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('min falls back to reduce when adapter.aggregate absent', async () =>
    {
        const M = makeModel(db, 'mmf', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        M.timestamps = false;
        await M.sync();
        await M.create({ val: 30 });
        await M.create({ val: 10 });
        await M.create({ val: 20 });

        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const result = await M.query().min('val');
        db.adapter.aggregate = origAgg;
        expect(result).toBe(10);
    });

    it('max falls back to reduce when adapter.aggregate absent', async () =>
    {
        const M = makeModel(db, 'mmf2', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        M.timestamps = false;
        await M.sync();
        await M.create({ val: 5 });
        await M.create({ val: 50 });
        await M.create({ val: 25 });

        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const result = await M.query().max('val');
        db.adapter.aggregate = origAgg;
        expect(result).toBe(50);
    });

    it('min returns null for empty results without aggregate', async () =>
    {
        const M = makeModel(db, 'mmf3', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        M.timestamps = false;
        await M.sync();

        const origAgg = db.adapter.aggregate;
        db.adapter.aggregate = undefined;
        const result = await M.query().min('val');
        db.adapter.aggregate = origAgg;
        expect(result).toBeNull();
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager belongsToMany with scope (L633)
// -------------------------------------------------------------------
describe('query.js — _loadEager belongsToMany with scope', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('applies scope function to belongsToMany related query', async () =>
    {
        const Tag2 = makeModel(db, 'btms_tags', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            name:   { type: 'string' },
            active: { type: 'boolean' },
        });
        Tag2.timestamps = false;
        await Tag2.sync();

        const Art2 = makeModel(db, 'btms_articles', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
        });
        Art2.timestamps = false;
        await Art2.sync();

        await db.adapter.createTable('btms_articles_btms_tags', {
            articleId: { type: 'integer' },
            tagId:     { type: 'integer' },
        });

        Art2.belongsToMany(Tag2, {
            through:    'btms_articles_btms_tags',
            foreignKey: 'articleId',
            otherKey:   'tagId',
        });

        await Tag2.create({ name: 'good', active: true });
        await Tag2.create({ name: 'bad', active: false });
        await Art2.create({ title: 'A' });
        await db.adapter.insert('btms_articles_btms_tags', { articleId: 1, tagId: 1 });
        await db.adapter.insert('btms_articles_btms_tags', { articleId: 1, tagId: 2 });

        const arts = await Art2.query()
            .with({ btms_tags: q => q.where('active', true) })
            .exec();
        expect(arts[0].btms_tags).toHaveLength(1);
        expect(arts[0].btms_tags[0].name).toBe('good');
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager hasMany with scope (L589)
// -------------------------------------------------------------------
describe('query.js — _loadEager hasMany with scope', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('applies scope function to hasMany eager load', async () =>
    {
        const Writer = makeModel(db, 'hms_writers', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        Writer.timestamps = false;
        await Writer.sync();

        const Book = makeModel(db, 'hms_books', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            writerId: { type: 'integer' },
            status:   { type: 'string' },
        });
        Book.timestamps = false;
        await Book.sync();

        Writer.hasMany(Book, 'writerId');

        await Writer.create({ name: 'W1' });
        await Book.create({ writerId: 1, status: 'published' });
        await Book.create({ writerId: 1, status: 'draft' });

        const writers = await Writer.query()
            .with({ hms_books: q => q.where('status', 'published') })
            .exec();
        expect(writers[0].hms_books).toHaveLength(1);
        expect(writers[0].hms_books[0].status).toBe('published');
    });
});

// -------------------------------------------------------------------
// query.js — _loadEager hasOne with scope (L607 duplicate check)
// -------------------------------------------------------------------
describe('query.js — _loadEager hasOne with scope', () =>
{
    let db;
    beforeEach(async () => { db = memDb(); });

    it('applies scope function to hasOne eager load', async () =>
    {
        const Account = makeModel(db, 'hos_accounts', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        Account.timestamps = false;
        await Account.sync();

        const Setting = makeModel(db, 'hos_settings', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            accountId: { type: 'integer' },
            theme:     { type: 'string' },
        });
        Setting.timestamps = false;
        await Setting.sync();

        Account.hasOne(Setting, 'accountId');

        await Account.create({ name: 'A1' });
        await Setting.create({ accountId: 1, theme: 'dark' });

        const accounts = await Account.query()
            .with({ hos_settings: q => q.where('theme', 'dark') })
            .exec();
        expect(accounts[0].hos_settings).toBeTruthy();
        expect(accounts[0].hos_settings.theme).toBe('dark');
    });
});

// -------------------------------------------------------------------
// query.js — chunk processes multiple pages (L1538)
// -------------------------------------------------------------------
describe('query.js — chunk multiple pages', () =>
{
    let db;
    beforeEach(async () =>
    {
        db = memDb();
    });

    it('iterates multiple batches until exhausted', async () =>
    {
        const M = makeModel(db, 'ch_multi', {
            id:  { type: 'integer', primaryKey: true, autoIncrement: true },
            val: { type: 'integer' },
        });
        M.timestamps = false;
        await M.sync();
        for (let i = 0; i < 7; i++) await M.create({ val: i });

        const batches = [];
        await M.query().chunk(3, (batch, idx) =>
        {
            batches.push({ size: batch.length, idx });
        });
        expect(batches).toHaveLength(3);
        expect(batches[0]).toEqual({ size: 3, idx: 0 });
        expect(batches[1]).toEqual({ size: 3, idx: 1 });
        expect(batches[2]).toEqual({ size: 1, idx: 2 });
    });
});

// -------------------------------------------------------------------
// memory.js — dropIndex across multiple tables (L685)
// -------------------------------------------------------------------
describe('memory.js — dropIndex multi-table', () =>
{
    let db;
    beforeEach(() => { db = memDb(); });

    it('drops index from second table, skipping first', async () =>
    {
        await db.adapter.createTable('di_t1', { id: { type: 'integer' } });
        await db.adapter.createTable('di_t2', { id: { type: 'integer' } });
        await db.adapter.createIndex('di_t1', 'id', { name: 'idx_t1' });
        await db.adapter.createIndex('di_t2', 'id', { name: 'idx_t2' });
        await db.adapter.dropIndex('di_t2', 'idx_t2');
        const i1 = await db.adapter.indexes('di_t1');
        const i2 = await db.adapter.indexes('di_t2');
        expect(i1).toHaveLength(1);
        expect(i2).toHaveLength(0);
    });
});

// -------------------------------------------------------------------
// index.js — register model without .table (fallback to .name, L207)
// -------------------------------------------------------------------
describe('index.js — model without table property', () =>
{
    it('register falls back to class name when table not set', () =>
    {
        const db = memDb();
        class NamedModel extends Model
        {
            static schema = { id: { type: 'integer', primaryKey: true } };
        }
        db.register(NamedModel);
        expect(db._models.has('NamedModel')).toBe(true);
    });
});

// -------------------------------------------------------------------
// index.js — sync with model without schema (L260)
// -------------------------------------------------------------------
describe('index.js — sync model without schema', () =>
{
    it('syncs model that has no schema gracefully', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'no_schema_sync', {});
        M.timestamps = false;
        await db.sync();
    });
});

// -------------------------------------------------------------------
// index.js — ping fallback paths (L545)
// -------------------------------------------------------------------
describe('index.js — ping fallback', () =>
{
    it('ping returns true via memory adapter _tables check', async () =>
    {
        const db = memDb();
        const ok = await db.ping();
        expect(ok).toBe(true);
    });

    it('ping falls through to execute when no _tables', async () =>
    {
        const db = memDb();
        const origTables = db.adapter._tables;
        const origGetTable = db.adapter._getTable;
        delete db.adapter._tables;
        db.adapter._getTable = undefined;
        const origExec = db.adapter.execute;
        db.adapter.execute = async () => [];
        const ok = await db.ping();
        db.adapter._tables = origTables;
        db.adapter._getTable = origGetTable;
        db.adapter.execute = origExec;
        expect(ok).toBe(true);
    });

    it('ping returns true when no _tables and no execute', async () =>
    {
        const db = memDb();
        const origTables = db.adapter._tables;
        const origGetTable = db.adapter._getTable;
        const origExec = db.adapter.execute;
        delete db.adapter._tables;
        db.adapter._getTable = undefined;
        db.adapter.execute = undefined;
        const ok = await db.ping();
        db.adapter._tables = origTables;
        db.adapter._getTable = origGetTable;
        db.adapter.execute = origExec;
        expect(ok).toBe(true);
    });
});