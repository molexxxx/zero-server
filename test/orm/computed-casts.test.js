/**
 * Phase 3 — Computed & Virtual Columns, Attribute Casting, Accessors/Mutators
 */
const { Database, Model, TYPES } = require('../../lib/orm');

// ===================================================================
// Helpers
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
    if (opts.computed)     M.computed    = opts.computed;
    if (opts.casts)        M.casts       = opts.casts;
    if (opts.accessors)    M.accessors   = opts.accessors;
    if (opts.mutators)     M.mutators    = opts.mutators;
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// 3.1 Computed & Virtual Columns
// ===================================================================
describe('Computed & Virtual Columns', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            firstName: { type: 'string', required: true },
            lastName:  { type: 'string', required: true },
            role:      { type: 'string', default: 'user' },
            age:       { type: 'integer', default: 0 },
        }, {
            name: 'User',
            computed: {
                fullName: (u) => `${u.firstName} ${u.lastName}`,
                isAdmin:  (u) => u.role === 'admin',
                greeting: (u) => `Hello, ${u.firstName}!`,
            },
        });
        await db.sync();
    });

    it('computed columns appear in toJSON()', async () =>
    {
        const user = await User.create({ firstName: 'Alice', lastName: 'Smith', role: 'admin' });
        const json = user.toJSON();
        expect(json.fullName).toBe('Alice Smith');
        expect(json.isAdmin).toBe(true);
        expect(json.greeting).toBe('Hello, Alice!');
    });

    it('computed columns are not stored in the database', async () =>
    {
        const user = await User.create({ firstName: 'Bob', lastName: 'Jones' });
        const found = await User.findById(user.id);
        // The raw instance doesn't have computed props as own properties
        expect(found.fullName).toBeUndefined();
        // But toJSON includes them
        const json = found.toJSON();
        expect(json.fullName).toBe('Bob Jones');
    });

    it('computed columns update when underlying fields change', async () =>
    {
        const user = await User.create({ firstName: 'Alice', lastName: 'Smith', role: 'user' });
        let json = user.toJSON();
        expect(json.isAdmin).toBe(false);

        await user.update({ role: 'admin' });
        json = user.toJSON();
        expect(json.isAdmin).toBe(true);
    });

    it('hidden fields exclude computed columns too', async () =>
    {
        const HiddenUser = makeModel(db, 'hidden_users', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            firstName: { type: 'string', required: true },
            lastName:  { type: 'string', required: true },
        }, {
            name: 'HiddenUser',
            computed: {
                fullName: (u) => `${u.firstName} ${u.lastName}`,
                secret:   () => 'top-secret',
            },
            hidden: ['secret'],
        });
        await db.sync();
        const user = await HiddenUser.create({ firstName: 'X', lastName: 'Y' });
        const json = user.toJSON();
        expect(json.fullName).toBe('X Y');
        expect(json.secret).toBeUndefined();
    });

    it('getAttribute resolves computed columns', async () =>
    {
        const user = await User.create({ firstName: 'Alice', lastName: 'Smith' });
        expect(user.getAttribute('fullName')).toBe('Alice Smith');
        expect(user.getAttribute('isAdmin')).toBe(false);
    });

    it('computed with empty object has no effect', async () =>
    {
        const Plain = makeModel(db, 'plain', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'Plain', computed: {} });
        await db.sync();
        const p = await Plain.create({ name: 'test' });
        const json = p.toJSON();
        expect(json.name).toBe('test');
        expect(Object.keys(json)).toEqual(['id', 'name']);
    });
});

// ===================================================================
// 3.1 Attribute Casting
// ===================================================================
describe('Attribute Casting', () =>
{
    let db;

    beforeEach(() =>
    {
        db = memDb();
    });

    it('json cast: parse on get, stringify on set', async () =>
    {
        const M = makeModel(db, 'json_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            data: { type: 'string', default: '{}' },
        }, { name: 'JsonCast', casts: { data: 'json' } });
        await db.sync();

        const inst = await M.create({ data: { foo: 'bar' } });
        // Set cast: should stringify
        expect(typeof inst.data).toBe('string');
        expect(inst.data).toBe('{"foo":"bar"}');

        // Get cast via toJSON
        const json = inst.toJSON();
        expect(json.data).toEqual({ foo: 'bar' });

        // Get cast via getAttribute
        expect(inst.getAttribute('data')).toEqual({ foo: 'bar' });
    });

    it('boolean cast', async () =>
    {
        const M = makeModel(db, 'bool_cast', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            active: { type: 'string', default: 'false' },
        }, { name: 'BoolCast', casts: { active: 'boolean' } });
        await db.sync();

        const inst1 = await M.create({ active: 'true' });
        // Via toJSON / getAttribute — casts apply on read
        expect(inst1.toJSON().active).toBe(true);
        expect(inst1.getAttribute('active')).toBe(true);

        const inst2 = await M.create({ active: 0 });
        expect(inst2.toJSON().active).toBe(false);

        const inst3 = await M.create({ active: 'yes' });
        expect(inst3.toJSON().active).toBe(true);

        const inst4 = await M.create({ active: 1 });
        expect(inst4.toJSON().active).toBe(true);

        // Already boolean
        const inst5 = await M.create({ active: true });
        expect(inst5.toJSON().active).toBe(true);
    });

    it('integer cast', async () =>
    {
        const M = makeModel(db, 'int_cast', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            count: { type: 'string', default: '0' },
        }, { name: 'IntCast', casts: { count: 'integer' } });
        await db.sync();

        const inst = await M.create({ count: '42' });
        expect(inst.toJSON().count).toBe(42);
        expect(inst.getAttribute('count')).toBe(42);

        const inst2 = await M.create({ count: 'abc' });
        expect(inst2.toJSON().count).toBe(0); // NaN coerces to 0
    });

    it('float cast', async () =>
    {
        const M = makeModel(db, 'float_cast', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            price: { type: 'string', default: '0' },
        }, { name: 'FloatCast', casts: { price: 'float' } });
        await db.sync();

        const inst = await M.create({ price: '19.99' });
        expect(inst.toJSON().price).toBe(19.99);
        expect(inst.getAttribute('price')).toBe(19.99);
    });

    it('date cast', async () =>
    {
        const M = makeModel(db, 'date_cast', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            birthday: { type: 'string', default: '' },
        }, { name: 'DateCast', casts: { birthday: 'date' } });
        await db.sync();

        const inst = await M.create({ birthday: '2000-01-15' });
        expect(inst.toJSON().birthday).toBeInstanceOf(Date);
        expect(inst.getAttribute('birthday')).toBeInstanceOf(Date);

        // Already a Date
        const d = new Date('2020-06-01');
        const inst2 = await M.create({ birthday: d });
        expect(inst2.toJSON().birthday).toBeInstanceOf(Date);
    });

    it('string cast', async () =>
    {
        const M = makeModel(db, 'str_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            code: { type: 'string', default: '' },
        }, { name: 'StrCast', casts: { code: 'string' } });
        await db.sync();

        const inst = await M.create({ code: '12345' });
        expect(inst.code).toBe('12345');
    });

    it('array cast', async () =>
    {
        const M = makeModel(db, 'arr_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            tags: { type: 'string', default: '[]' },
        }, { name: 'ArrCast', casts: { tags: 'array' } });
        await db.sync();

        const inst = await M.create({ tags: ['a', 'b', 'c'] });
        expect(typeof inst.tags).toBe('string');
        expect(inst.tags).toBe('["a","b","c"]');
        expect(inst.toJSON().tags).toEqual(['a', 'b', 'c']);
    });

    it('custom cast with get/set', async () =>
    {
        const M = makeModel(db, 'custom_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            meta: { type: 'string', default: '{}' },
        }, {
            name: 'CustomCast',
            casts: {
                meta: {
                    get: (v) => v ? JSON.parse(v) : {},
                    set: (v) => JSON.stringify(v || {}),
                },
            },
        });
        await db.sync();

        const inst = await M.create({ meta: { key: 'value' } });
        expect(typeof inst.meta).toBe('string');
        expect(inst.toJSON().meta).toEqual({ key: 'value' });
        expect(inst.getAttribute('meta')).toEqual({ key: 'value' });
    });

    it('null/undefined values pass through casts unchanged', () =>
    {
        expect(Model._applyCastGet(null, 'json')).toBeNull();
        expect(Model._applyCastGet(undefined, 'boolean')).toBeUndefined();
        expect(Model._applyCastSet(null, 'integer')).toBeNull();
        expect(Model._applyCastSet(undefined, 'float')).toBeUndefined();
    });

    it('unknown cast type passes value through', () =>
    {
        expect(Model._applyCastGet('hello', 'unknown_type')).toBe('hello');
        expect(Model._applyCastSet(42, 'unknown_type')).toBe(42);
    });

    it('boolean cast get handles all types', () =>
    {
        expect(Model._applyCastGet(true, 'boolean')).toBe(true);
        expect(Model._applyCastGet(false, 'boolean')).toBe(false);
        expect(Model._applyCastGet(1, 'boolean')).toBe(true);
        expect(Model._applyCastGet(0, 'boolean')).toBe(false);
        expect(Model._applyCastGet('true', 'boolean')).toBe(true);
        expect(Model._applyCastGet('false', 'boolean')).toBe(false);
        expect(Model._applyCastGet('1', 'boolean')).toBe(true);
        expect(Model._applyCastGet('0', 'boolean')).toBe(false);
        expect(Model._applyCastGet('yes', 'boolean')).toBe(true);
        expect(Model._applyCastGet('no', 'boolean')).toBe(false);
        expect(Model._applyCastGet([], 'boolean')).toBe(true);
    });

    it('boolean cast set handles all types', () =>
    {
        expect(Model._applyCastSet(true, 'boolean')).toBe(true);
        expect(Model._applyCastSet(1, 'boolean')).toBe(true);
        expect(Model._applyCastSet('true', 'boolean')).toBe(true);
        expect(Model._applyCastSet('yes', 'boolean')).toBe(true);
        expect(Model._applyCastSet('1', 'boolean')).toBe(true);
        expect(Model._applyCastSet('no', 'boolean')).toBe(false);
        expect(Model._applyCastSet([], 'boolean')).toBe(true);
    });

    it('json cast get handles already parsed objects', () =>
    {
        expect(Model._applyCastGet({ a: 1 }, 'json')).toEqual({ a: 1 });
        expect(Model._applyCastGet('{"a":1}', 'json')).toEqual({ a: 1 });
    });

    it('json cast set handles already stringified values', () =>
    {
        expect(Model._applyCastSet('{"a":1}', 'json')).toBe('{"a":1}');
        expect(Model._applyCastSet({ a: 1 }, 'json')).toBe('{"a":1}');
    });

    it('date cast get handles Date objects', () =>
    {
        const d = new Date('2020-01-01');
        expect(Model._applyCastGet(d, 'date')).toBe(d);
        expect(Model._applyCastGet('2020-01-01', 'date')).toBeInstanceOf(Date);
    });

    it('custom cast get with no get function passes through', () =>
    {
        expect(Model._applyCastGet('hello', { set: v => v })).toBe('hello');
    });

    it('custom cast set with no set function passes through', () =>
    {
        expect(Model._applyCastSet('hello', { get: v => v })).toBe('hello');
    });
});

// ===================================================================
// 3.1 Accessors & Mutators
// ===================================================================
describe('Accessors & Mutators', () =>
{
    let db;

    beforeEach(() =>
    {
        db = memDb();
    });

    it('mutators transform values on create', async () =>
    {
        const M = makeModel(db, 'mut_users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', required: true },
            name:  { type: 'string', required: true },
        }, {
            name: 'MutUser',
            mutators: {
                email: (v) => v ? v.toLowerCase().trim() : v,
                name:  (v) => v ? v.trim() : v,
            },
        });
        await db.sync();

        const u = await M.create({ email: '  ALICE@Example.COM  ', name: '  Bob  ' });
        expect(u.email).toBe('alice@example.com');
        expect(u.name).toBe('Bob');
    });

    it('accessors transform values in toJSON()', async () =>
    {
        const M = makeModel(db, 'acc_users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', required: true },
            name:  { type: 'string', required: true },
        }, {
            name: 'AccUser',
            accessors: {
                email: (v) => v ? v.toUpperCase() : v,
            },
        });
        await db.sync();

        const u = await M.create({ email: 'alice@example.com', name: 'Alice' });
        // Raw value is lowercase
        expect(u.email).toBe('alice@example.com');
        // toJSON accessor makes it uppercase
        const json = u.toJSON();
        expect(json.email).toBe('ALICE@EXAMPLE.COM');
        // getAttribute also applies accessor
        expect(u.getAttribute('email')).toBe('ALICE@EXAMPLE.COM');
    });

    it('setAttribute applies mutator', async () =>
    {
        const M = makeModel(db, 'setattr', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            email: { type: 'string', required: true },
        }, {
            name: 'SetAttr',
            mutators: {
                email: (v) => v ? v.toLowerCase() : v,
            },
        });
        await db.sync();

        const u = await M.create({ email: 'test@test.com' });
        u.setAttribute('email', 'NEW@EXAMPLE.COM');
        expect(u.email).toBe('new@example.com');
    });

    it('setAttribute applies cast when no mutator', async () =>
    {
        const M = makeModel(db, 'setattr_cast', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            count: { type: 'string', default: '0' },
        }, { name: 'SetAttrCast', casts: { count: 'integer' } });
        await db.sync();

        const u = await M.create({ count: '5' });
        u.setAttribute('count', '99');
        expect(u.count).toBe(99);
    });

    it('setAttribute with no mutator or cast sets raw value', async () =>
    {
        const M = makeModel(db, 'setattr_raw', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'SetAttrRaw' });
        await db.sync();

        const u = await M.create({ name: 'Alice' });
        u.setAttribute('name', 'Bob');
        expect(u.name).toBe('Bob');
    });

    it('getAttribute with no accessor or cast returns raw', async () =>
    {
        const M = makeModel(db, 'getattr_raw', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'GetAttrRaw' });
        await db.sync();

        const u = await M.create({ name: 'Alice' });
        expect(u.getAttribute('name')).toBe('Alice');
    });

    it('accessor takes precedence over cast in toJSON', async () =>
    {
        const M = makeModel(db, 'acc_over_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            data: { type: 'string', default: '{}' },
        }, {
            name: 'AccOverCast',
            casts: { data: 'json' },
            accessors: { data: (v) => 'ACCESSOR_WINS' },
        });
        await db.sync();

        const u = await M.create({ data: { test: 1 } });
        expect(u.toJSON().data).toBe('ACCESSOR_WINS');
        expect(u.getAttribute('data')).toBe('ACCESSOR_WINS');
    });

    it('mutator takes precedence over cast in constructor', async () =>
    {
        const M = makeModel(db, 'mut_over_cast', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            val:  { type: 'string', required: true },
        }, {
            name: 'MutOverCast',
            casts: { val: 'integer' },
            mutators: { val: (v) => 'MUTATOR_' + v },
        });
        await db.sync();

        const u = await M.create({ val: 'test' });
        expect(u.val).toBe('MUTATOR_test');
    });
});
