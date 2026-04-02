/**
 * Phase 4 — PluginManager tests
 */
const { PluginManager } = require('../../lib/orm/plugin');

// ===================================================================
// Helpers
// ===================================================================

function makePlugin(overrides = {})
{
    return {
        name: overrides.name || 'test-plugin',
        version: overrides.version || '1.0.0',
        install: overrides.install || vi.fn(),
        boot: overrides.boot || undefined,
        uninstall: overrides.uninstall || undefined,
        dependencies: overrides.dependencies || undefined,
    };
}

// ===================================================================
// Constructor
// ===================================================================
describe('PluginManager — constructor', () =>
{
    it('creates with no args', () =>
    {
        const pm = new PluginManager();
        expect(pm.db).toBeNull();
        expect(pm.size).toBe(0);
        expect(pm._booted).toBe(false);
    });

    it('accepts db', () =>
    {
        const fakeDb = { adapter: {} };
        const pm = new PluginManager(fakeDb);
        expect(pm.db).toBe(fakeDb);
    });
});

// ===================================================================
// Registration
// ===================================================================
describe('PluginManager — register', () =>
{
    it('registers a valid plugin', () =>
    {
        const pm = new PluginManager();
        const plugin = makePlugin();
        pm.register(plugin);
        expect(pm.has('test-plugin')).toBe(true);
        expect(pm.size).toBe(1);
        expect(plugin.install).toHaveBeenCalledWith(pm, {});
    });

    it('returns this for chaining', () =>
    {
        const pm = new PluginManager();
        expect(pm.register(makePlugin())).toBe(pm);
    });

    it('calls install with options', () =>
    {
        const pm = new PluginManager();
        const plugin = makePlugin();
        pm.register(plugin, { key: 'val' });
        expect(plugin.install).toHaveBeenCalledWith(pm, { key: 'val' });
    });

    it('throws on null', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.register(null)).toThrow('must be an object');
    });

    it('throws on non-object', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.register('str')).toThrow('must be an object');
    });

    it('throws on missing name', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.register({ install: () => {} })).toThrow('"name" string');
    });

    it('throws on missing install', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.register({ name: 'x' })).toThrow('"install" function');
    });

    it('throws on duplicate', () =>
    {
        const pm = new PluginManager();
        pm.register(makePlugin({ name: 'a' }));
        expect(() => pm.register(makePlugin({ name: 'a' }))).toThrow('already registered');
    });

    it('throws on missing dependency', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.register(makePlugin({ name: 'b', dependencies: ['a'] })))
            .toThrow('requires "a"');
    });

    it('passes with fulfilled dependency', () =>
    {
        const pm = new PluginManager();
        pm.register(makePlugin({ name: 'a' }));
        pm.register(makePlugin({ name: 'b', dependencies: ['a'] }));
        expect(pm.has('b')).toBe(true);
    });
});

// ===================================================================
// registerAll
// ===================================================================
describe('PluginManager — registerAll', () =>
{
    it('registers multiple plugins', () =>
    {
        const pm = new PluginManager();
        pm.registerAll(
            makePlugin({ name: 'a' }),
            makePlugin({ name: 'b' }),
        );
        expect(pm.size).toBe(2);
    });

    it('accepts [plugin, options] tuples', () =>
    {
        const pm = new PluginManager();
        const p = makePlugin({ name: 'x' });
        pm.registerAll([p, { opt: true }]);
        expect(pm.has('x')).toBe(true);
        expect(p.install).toHaveBeenCalledWith(pm, { opt: true });
    });

    it('returns this', () =>
    {
        const pm = new PluginManager();
        expect(pm.registerAll(makePlugin())).toBe(pm);
    });
});

// ===================================================================
// Unregister
// ===================================================================
describe('PluginManager — unregister', () =>
{
    it('removes a plugin', () =>
    {
        const pm = new PluginManager();
        pm.register(makePlugin({ name: 'a' }));
        pm.unregister('a');
        expect(pm.has('a')).toBe(false);
        expect(pm.size).toBe(0);
    });

    it('calls uninstall if defined', () =>
    {
        const pm = new PluginManager();
        const uninstall = vi.fn();
        pm.register(makePlugin({ name: 'a', uninstall }));
        pm.unregister('a');
        expect(uninstall).toHaveBeenCalledWith(pm);
    });

    it('is a no-op for unknown plugin', () =>
    {
        const pm = new PluginManager();
        expect(pm.unregister('nope')).toBe(pm);
    });

    it('returns this', () =>
    {
        const pm = new PluginManager();
        pm.register(makePlugin({ name: 'a' }));
        expect(pm.unregister('a')).toBe(pm);
    });
});

// ===================================================================
// Boot
// ===================================================================
describe('PluginManager — boot', () =>
{
    it('calls boot on plugins', async () =>
    {
        const pm = new PluginManager();
        const bootFn = vi.fn();
        pm.register(makePlugin({ name: 'a', boot: bootFn }));
        await pm.boot();
        expect(bootFn).toHaveBeenCalledWith(pm, {});
        expect(pm._booted).toBe(true);
    });

    it('passes options to boot', async () =>
    {
        const pm = new PluginManager();
        const bootFn = vi.fn();
        pm.register(makePlugin({ name: 'a', boot: bootFn }), { key: 'val' });
        await pm.boot();
        expect(bootFn).toHaveBeenCalledWith(pm, { key: 'val' });
    });

    it('only boots once', async () =>
    {
        const pm = new PluginManager();
        const bootFn = vi.fn();
        pm.register(makePlugin({ name: 'a', boot: bootFn }));
        await pm.boot();
        await pm.boot();
        expect(bootFn).toHaveBeenCalledTimes(1);
    });

    it('skips plugins without boot', async () =>
    {
        const pm = new PluginManager();
        pm.register(makePlugin({ name: 'a', boot: undefined }));
        const result = await pm.boot();
        expect(result).toBe(pm);
    });
});

// ===================================================================
// Hook system
// ===================================================================
describe('PluginManager — hooks', () =>
{
    it('registers and runs a hook', async () =>
    {
        const pm = new PluginManager();
        const fn = vi.fn().mockReturnValue('result');
        pm.hook('beforeCreate', fn);

        const result = await pm.runHook('beforeCreate', 'model', 'data');
        expect(fn).toHaveBeenCalledWith('model', 'data');
        expect(result).toBe('result');
    });

    it('chains hook results', async () =>
    {
        const pm = new PluginManager();
        pm.hook('transform', (payload) => payload + 1);
        pm.hook('transform', (payload) => payload * 2);

        const result = await pm.runHook('transform', 5);
        expect(result).toBe(12); // (5 + 1) * 2
    });

    it('returns last arg if no hooks registered', async () =>
    {
        const pm = new PluginManager();
        const result = await pm.runHook('nonexistent', 'a', 'b');
        expect(result).toBe('b');
    });

    it('hook returns this for chaining', () =>
    {
        const pm = new PluginManager();
        expect(pm.hook('x', () => {})).toBe(pm);
    });

    it('throws if callback is not a function', () =>
    {
        const pm = new PluginManager();
        expect(() => pm.hook('x', 'not-a-fn')).toThrow('must be a function');
    });

    it('hasHook checks existence', () =>
    {
        const pm = new PluginManager();
        expect(pm.hasHook('x')).toBe(false);
        pm.hook('x', () => {});
        expect(pm.hasHook('x')).toBe(true);
    });

    it('unhook removes a listener', () =>
    {
        const pm = new PluginManager();
        const fn = () => {};
        pm.hook('x', fn);
        expect(pm.hasHook('x')).toBe(true);
        pm.unhook('x', fn);
        expect(pm.hasHook('x')).toBe(false);
    });

    it('unhook is a no-op for unknown hook', () =>
    {
        const pm = new PluginManager();
        expect(pm.unhook('nonexistent', () => {})).toBe(pm);
    });

    it('unhook is a no-op for unknown callback', () =>
    {
        const pm = new PluginManager();
        pm.hook('x', () => {});
        pm.unhook('x', () => {}); // different ref
        expect(pm.hasHook('x')).toBe(true);
    });
});

// ===================================================================
// Query methods
// ===================================================================
describe('PluginManager — query', () =>
{
    let pm;

    beforeEach(() =>
    {
        pm = new PluginManager();
        pm.register(makePlugin({ name: 'a', version: '1.0.0' }));
        pm.register(makePlugin({ name: 'b', version: '2.0.0', boot: vi.fn() }));
    });

    it('has returns true/false', () =>
    {
        expect(pm.has('a')).toBe(true);
        expect(pm.has('c')).toBe(false);
    });

    it('get returns plugin', () =>
    {
        const p = pm.get('a');
        expect(p.name).toBe('a');
    });

    it('get returns undefined for missing', () =>
    {
        expect(pm.get('nope')).toBeUndefined();
    });

    it('getOptions returns stored options', () =>
    {
        const pm2 = new PluginManager();
        pm2.register(makePlugin({ name: 'x' }), { setting: true });
        expect(pm2.getOptions('x')).toEqual({ setting: true });
    });

    it('list returns names', () =>
    {
        expect(pm.list()).toEqual(['a', 'b']);
    });

    it('info returns details', () =>
    {
        const infoArr = pm.info();
        expect(infoArr.length).toBe(2);
        expect(infoArr[0]).toEqual({ name: 'a', version: '1.0.0', hasBootFn: false });
        expect(infoArr[1]).toEqual({ name: 'b', version: '2.0.0', hasBootFn: true });
    });

    it('size returns count', () =>
    {
        expect(pm.size).toBe(2);
    });
});

// ===================================================================
// Plugin name validation (security)
// ===================================================================
describe('PluginManager — name validation (security)', () =>
{
    let pm;

    beforeEach(() =>
    {
        pm = new PluginManager();
    });

    it('rejects plugin names with SQL injection characters', () =>
    {
        const p = makePlugin({ name: 'evil; DROP TABLE' });
        expect(() => pm.register(p)).toThrow('Invalid plugin name');
    });

    it('rejects plugin names with special characters', () =>
    {
        const p1 = makePlugin({ name: 'plugin@v1' });
        expect(() => pm.register(p1)).toThrow('Invalid plugin name');

        const p2 = makePlugin({ name: 'my plugin' });
        expect(() => pm.register(p2)).toThrow('Invalid plugin name');
    });

    it('rejects plugin names starting with a digit', () =>
    {
        const p = makePlugin({ name: '123plugin' });
        expect(() => pm.register(p)).toThrow('Invalid plugin name');
    });

    it('accepts valid plugin names', () =>
    {
        const p1 = makePlugin({ name: 'my_plugin' });
        expect(() => pm.register(p1)).not.toThrow();

        const p2 = makePlugin({ name: 'my-plugin' });
        expect(() => pm.register(p2)).not.toThrow();

        const p3 = makePlugin({ name: '_internal' });
        expect(() => pm.register(p3)).not.toThrow();
    });
});
