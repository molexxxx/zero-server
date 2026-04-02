/**
 * Phase 3 — Model Events & Observers
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
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// Model Events
// ===================================================================
describe('Model Events', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
            email: { type: 'string', required: true },
        }, { name: 'EventUser' });
        await db.sync();
        // Clear any leftover listeners
        User.removeAllListeners();
    });

    it('on() registers and fires creating event', async () =>
    {
        const spy = vi.fn();
        User.on('creating', spy);
        await User.create({ name: 'Alice', email: 'a@b.com' });
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0][0]).toMatchObject({ name: 'Alice' });
    });

    it('on() registers and fires created event', async () =>
    {
        const spy = vi.fn();
        User.on('created', spy);
        const user = await User.create({ name: 'Bob', email: 'b@b.com' });
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0][0].name).toBe('Bob');
    });

    it('on() registers and fires updating event', async () =>
    {
        const spy = vi.fn();
        User.on('updating', spy);
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        await user.update({ name: 'Alice2' });
        expect(spy).toHaveBeenCalledOnce();
    });

    it('on() registers and fires updated event', async () =>
    {
        const spy = vi.fn();
        User.on('updated', spy);
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        await user.update({ name: 'Alice2' });
        expect(spy).toHaveBeenCalledOnce();
    });

    it('on() registers and fires deleting event', async () =>
    {
        const spy = vi.fn();
        User.on('deleting', spy);
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        await user.delete();
        expect(spy).toHaveBeenCalledOnce();
    });

    it('on() registers and fires deleted event', async () =>
    {
        const spy = vi.fn();
        User.on('deleted', spy);
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        await user.delete();
        expect(spy).toHaveBeenCalledOnce();
    });

    it('once() fires only once', async () =>
    {
        const spy = vi.fn();
        User.once('created', spy);
        await User.create({ name: 'A', email: 'a@a.com' });
        await User.create({ name: 'B', email: 'b@b.com' });
        expect(spy).toHaveBeenCalledOnce();
    });

    it('off() removes a listener', async () =>
    {
        const spy = vi.fn();
        User.on('created', spy);
        User.off('created', spy);
        await User.create({ name: 'A', email: 'a@a.com' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('removeAllListeners() removes all listeners for an event', async () =>
    {
        const spy1 = vi.fn();
        const spy2 = vi.fn();
        User.on('created', spy1);
        User.on('created', spy2);
        User.removeAllListeners('created');
        await User.create({ name: 'A', email: 'a@a.com' });
        expect(spy1).not.toHaveBeenCalled();
        expect(spy2).not.toHaveBeenCalled();
    });

    it('removeAllListeners() with no arg removes all', async () =>
    {
        const spy1 = vi.fn();
        const spy2 = vi.fn();
        User.on('created', spy1);
        User.on('deleted', spy2);
        User.removeAllListeners();
        const u = await User.create({ name: 'A', email: 'a@a.com' });
        await u.delete();
        expect(spy1).not.toHaveBeenCalled();
        expect(spy2).not.toHaveBeenCalled();
    });

    it('multiple listeners for the same event all fire', async () =>
    {
        const spy1 = vi.fn();
        const spy2 = vi.fn();
        User.on('created', spy1);
        User.on('created', spy2);
        await User.create({ name: 'A', email: 'a@a.com' });
        expect(spy1).toHaveBeenCalledOnce();
        expect(spy2).toHaveBeenCalledOnce();
    });

    it('events do not fire for unmapped hook names', async () =>
    {
        // _emit with a hook name that has no mapping should be a no-op
        const spy = vi.fn();
        User.on('creating', spy);
        // Directly call _emit with an unmapped hook
        User._emit('someRandomHook', {});
        expect(spy).not.toHaveBeenCalled();
    });

    it('events do not fire when emitter not created', () =>
    {
        // New model class with no emitter
        const db2 = memDb();
        const M = makeModel(db2, 'no_emitter', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NoEmitter' });
        // _emit with no emitter should not throw
        M._emit('afterCreate', {});
    });

    it('on() returns the model class for chaining', () =>
    {
        const result = User.on('created', () => {});
        expect(result).toBe(User);
    });

    it('once() returns the model class for chaining', () =>
    {
        const result = User.once('created', () => {});
        expect(result).toBe(User);
    });

    it('off() returns the model class for chaining', () =>
    {
        const fn = () => {};
        User.on('created', fn);
        const result = User.off('created', fn);
        expect(result).toBe(User);
    });

    it('removeAllListeners() returns the model class for chaining', () =>
    {
        const result = User.removeAllListeners();
        expect(result).toBe(User);
    });

    it('_getEmitter creates a new emitter if none exists', () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'new_emitter', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NewEmitter' });
        const emitter = M._getEmitter();
        expect(emitter).toBeDefined();
        expect(typeof emitter.on).toBe('function');
        // Calling again returns the same emitter
        expect(M._getEmitter()).toBe(emitter);
    });
});

// ===================================================================
// Observers
// ===================================================================
describe('Model Observers', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            name:  { type: 'string', required: true },
            email: { type: 'string', required: true },
        }, { name: 'ObsUser' });
        await db.sync();
        // Clear observers
        User._observers = [];
    });

    it('observe() registers an observer', async () =>
    {
        const observer = { created: vi.fn() };
        User.observe(observer);
        await User.create({ name: 'Alice', email: 'a@b.com' });
        expect(observer.created).toHaveBeenCalledOnce();
    });

    it('observer receives all lifecycle events', async () =>
    {
        const observer = {
            creating: vi.fn(),
            created:  vi.fn(),
            updating: vi.fn(),
            updated:  vi.fn(),
            deleting: vi.fn(),
            deleted:  vi.fn(),
        };
        User.observe(observer);

        const u = await User.create({ name: 'A', email: 'a@a.com' });
        expect(observer.creating).toHaveBeenCalledOnce();
        expect(observer.created).toHaveBeenCalledOnce();

        await u.update({ name: 'B' });
        expect(observer.updating).toHaveBeenCalledOnce();
        expect(observer.updated).toHaveBeenCalledOnce();

        await u.delete();
        expect(observer.deleting).toHaveBeenCalledOnce();
        expect(observer.deleted).toHaveBeenCalledOnce();
    });

    it('unobserve() removes an observer', async () =>
    {
        const observer = { created: vi.fn() };
        User.observe(observer);
        User.unobserve(observer);
        await User.create({ name: 'A', email: 'a@a.com' });
        expect(observer.created).not.toHaveBeenCalled();
    });

    it('multiple observers all receive events', async () =>
    {
        const obs1 = { created: vi.fn() };
        const obs2 = { created: vi.fn() };
        User.observe(obs1);
        User.observe(obs2);
        await User.create({ name: 'A', email: 'a@a.com' });
        expect(obs1.created).toHaveBeenCalledOnce();
        expect(obs2.created).toHaveBeenCalledOnce();
    });

    it('observer with partial methods works fine', async () =>
    {
        const observer = { created: vi.fn() };
        // No updating/deleted methods — should not throw
        User.observe(observer);
        const u = await User.create({ name: 'A', email: 'a@a.com' });
        await u.update({ name: 'B' });
        await u.delete();
        expect(observer.created).toHaveBeenCalledOnce();
    });

    it('observe() returns model class for chaining', () =>
    {
        const result = User.observe({});
        expect(result).toBe(User);
    });

    it('unobserve() returns model class for chaining', () =>
    {
        const obs = {};
        User.observe(obs);
        const result = User.unobserve(obs);
        expect(result).toBe(User);
    });

    it('unobserve on model with no observers is safe', () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'no_obs', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NoObs' });
        // Should not throw
        M.unobserve({});
    });

    it('_notifyObservers with unmapped hookName is a no-op', () =>
    {
        const observer = { randomHook: vi.fn() };
        User.observe(observer);
        User._notifyObservers('randomHook', {});
        expect(observer.randomHook).not.toHaveBeenCalled();
    });

    it('_notifyObservers with no own _observers is safe', () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'notif_test', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'NotifTest' });
        // Should not throw
        M._notifyObservers('afterCreate', {});
    });
});

// ===================================================================
// Events + Hooks interaction
// ===================================================================
describe('Events + Hooks interaction', () =>
{
    let db;

    beforeEach(() =>
    {
        db = memDb();
    });

    it('static hook, events, and observer all fire on create', async () =>
    {
        const hookSpy = vi.fn();
        const eventSpy = vi.fn();
        const observerSpy = vi.fn();

        const M = class extends Model
        {
            static table = 'hook_event';
            static schema = {
                id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true },
            };
            static async beforeCreate(data) { hookSpy(data); }
        };
        Object.defineProperty(M, 'name', { value: 'HookEvent' });
        db.register(M);
        await db.sync();

        M.on('creating', eventSpy);
        M.observe({ creating: observerSpy });

        await M.create({ name: 'Test' });

        expect(hookSpy).toHaveBeenCalledOnce();
        expect(eventSpy).toHaveBeenCalledOnce();
        expect(observerSpy).toHaveBeenCalledOnce();
    });

    it('hooks defined via hooks object also trigger events', async () =>
    {
        const hookSpy = vi.fn();
        const eventSpy = vi.fn();

        const M = makeModel(db, 'hooks_obj_event', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'HooksObjEvent' });
        M.hooks = { beforeCreate: hookSpy };
        await db.sync();

        M.on('creating', eventSpy);
        await M.create({ name: 'Test' });

        expect(hookSpy).toHaveBeenCalledOnce();
        expect(eventSpy).toHaveBeenCalledOnce();
    });
});
