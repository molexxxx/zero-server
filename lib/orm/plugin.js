/**
 * @module orm/plugin
 * @description Plugin system for the zero-http ORM.
 *              Provides a registration API, lifecycle hooks, and
 *              a standard interface for extending the framework.
 *
 * @example
 *   const { PluginManager } = require('zero-http');
 *
 *   // Define a plugin
 *   const timestampPlugin = {
 *       name: 'timestamps',
 *       version: '1.0.0',
 *       install(manager, options) {
 *           manager.hook('beforeCreate', (model, data) => {
 *               data.createdAt = new Date().toISOString();
 *               return data;
 *           });
 *       },
 *   };
 *
 *   // Register it
 *   const plugins = new PluginManager(db);
 *   plugins.register(timestampPlugin);
 */

const log = require('../debug')('zero:orm:plugin');

// -- Plugin Manager ------------------------------------------

/**
 * Plugin registration and lifecycle manager.
 * Plugins can hook into ORM events and extend functionality.
 */
class PluginManager
{
    /**
     * @constructor
     * @param {import('./index').Database} [db] - Database instance (optional, can be set later).
     *
     * @example
     *   const plugins = new PluginManager(db);
     */
    constructor(db)
    {
        /** @type {import('./index').Database|null} */
        this.db = db || null;

        /** @type {Map<string, object>} Registered plugins keyed by name. */
        this._plugins = new Map();

        /** @type {Map<string, Function[]>} Hook listeners keyed by hook name. */
        this._hooks = new Map();

        /** @type {Map<string, object>} Plugin options keyed by name. */
        this._options = new Map();

        /** @type {boolean} Whether the manager has been booted. */
        this._booted = false;
    }

    // -- Registration ------------------------------------

    /**
     * Register a plugin.
     *
     * @param {object}   plugin - Plugin definition object.
     * @param {string}   plugin.name    - Unique plugin name.
     * @param {string}   [plugin.version]  - Plugin version string.
     * @param {Function} plugin.install - Install function `(manager, options) => {}`.
     * @param {Function} [plugin.boot]  - Boot function called after all plugins are registered.
     * @param {Function} [plugin.uninstall] - Cleanup function.
     * @param {string[]} [plugin.dependencies] - Required plugin names.
     * @param {object}   [options] - Plugin-specific options.
     * @returns {PluginManager} this (for chaining)
     *
     * @example
     *   plugins.register({
     *       name: 'soft-delete',
     *       install(manager) {
     *           manager.hook('beforeDelete', (model, instance) => {
     *               // intercept delete
     *           });
     *       },
     *   });
     */
    register(plugin, options = {})
    {
        if (!plugin || typeof plugin !== 'object')
        {
            throw new Error('Plugin must be an object');
        }
        if (!plugin.name || typeof plugin.name !== 'string')
        {
            throw new Error('Plugin must have a "name" string property');
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(plugin.name))
        {
            throw new Error(`Invalid plugin name: "${plugin.name}"`);
        }
        if (typeof plugin.install !== 'function')
        {
            throw new Error(`Plugin "${plugin.name}" must have an "install" function`);
        }
        if (this._plugins.has(plugin.name))
        {
            throw new Error(`Plugin "${plugin.name}" is already registered`);
        }

        // Check dependencies
        if (Array.isArray(plugin.dependencies))
        {
            for (const dep of plugin.dependencies)
            {
                if (!this._plugins.has(dep))
                {
                    throw new Error(`Plugin "${plugin.name}" requires "${dep}" which is not registered`);
                }
            }
        }

        this._plugins.set(plugin.name, plugin);
        this._options.set(plugin.name, options);

        // Install immediately
        plugin.install(this, options);

        log('plugin registered', plugin.name, plugin.version || '');
        return this;
    }

    /**
     * Register multiple plugins at once.
     *
     * @param {...(object|[object, object])} plugins - Plugin objects or [plugin, options] tuples.
     * @returns {PluginManager} this (for chaining)
     *
     * @example
     *   plugins.registerAll(
     *       pluginA,                        // no options
     *       [pluginB, { key: 'value' }],   // with options
     *   );
     */
    registerAll(...plugins)
    {
        for (const entry of plugins)
        {
            if (Array.isArray(entry))
            {
                this.register(entry[0], entry[1] || {});
            }
            else
            {
                this.register(entry);
            }
        }
        return this;
    }

    /**
     * Unregister a plugin by name.
     *
     * @param {string} name - Plugin name.
     * @returns {PluginManager} this (for chaining)
     */
    unregister(name)
    {
        const plugin = this._plugins.get(name);
        if (!plugin) return this;

        if (typeof plugin.uninstall === 'function')
        {
            plugin.uninstall(this);
        }

        this._plugins.delete(name);
        this._options.delete(name);
        log('plugin unregistered', name);
        return this;
    }

    // -- Lifecycle ---------------------------------------

    /**
     * Boot all registered plugins.
     * Calls the `boot()` method on each plugin (if defined).
     * Should be called after all plugins are registered.
     *
     * @returns {Promise<PluginManager>} this (for chaining)
     *
     * @example
     *   plugins.register(pluginA).register(pluginB);
     *   await plugins.boot();
     */
    async boot()
    {
        if (this._booted) return this;

        for (const [name, plugin] of this._plugins)
        {
            if (typeof plugin.boot === 'function')
            {
                await plugin.boot(this, this._options.get(name) || {});
                log('plugin booted', name);
            }
        }

        this._booted = true;
        return this;
    }

    // -- Hook System -------------------------------------

    /**
     * Register a hook listener.
     *
     * @param {string}   name     - Hook name (e.g. 'beforeCreate', 'afterUpdate').
     * @param {Function} callback - Hook callback function.
     * @returns {PluginManager} this (for chaining)
     *
     * @example
     *   manager.hook('beforeCreate', (model, data) => {
     *       data.slug = slugify(data.title);
     *       return data;
     *   });
     */
    hook(name, callback)
    {
        if (typeof callback !== 'function')
        {
            throw new Error('Hook callback must be a function');
        }

        if (!this._hooks.has(name))
        {
            this._hooks.set(name, []);
        }
        this._hooks.get(name).push(callback);
        return this;
    }

    /**
     * Remove a hook listener.
     *
     * @param {string}   name     - Hook name.
     * @param {Function} callback - The exact function reference to remove.
     * @returns {PluginManager} this (for chaining)
     */
    unhook(name, callback)
    {
        const handlers = this._hooks.get(name);
        if (!handlers) return this;

        const idx = handlers.indexOf(callback);
        if (idx !== -1) handlers.splice(idx, 1);
        return this;
    }

    /**
     * Execute all listeners for a hook.
     * Listeners run in registration order. If a listener returns a value,
     * that value is passed to the next listener as the payload.
     *
     * @param {string} name     - Hook name.
     * @param {...*}   args     - Arguments to pass to hook callbacks.
     * @returns {Promise<*>} Final transformed value (or last arg if no transforms).
     *
     * @example
     *   const data = await manager.runHook('beforeCreate', model, rawData);
     */
    async runHook(name, ...args)
    {
        const handlers = this._hooks.get(name);
        if (!handlers || handlers.length === 0) return args[args.length - 1];

        let result = args[args.length - 1];
        for (const fn of handlers)
        {
            const out = await fn(...args.slice(0, -1), result);
            if (out !== undefined) result = out;
        }
        return result;
    }

    /**
     * Check if any listeners exist for a hook.
     *
     * @param {string} name - Hook name.
     * @returns {boolean}
     */
    hasHook(name)
    {
        const handlers = this._hooks.get(name);
        return !!handlers && handlers.length > 0;
    }

    // -- Query -------------------------------------------

    /**
     * Check if a plugin is registered.
     *
     * @param {string} name - Plugin name.
     * @returns {boolean}
     */
    has(name)
    {
        return this._plugins.has(name);
    }

    /**
     * Get a registered plugin by name.
     *
     * @param {string} name - Plugin name.
     * @returns {object|undefined} Plugin object, or undefined.
     */
    get(name)
    {
        return this._plugins.get(name);
    }

    /**
     * Get options for a registered plugin.
     *
     * @param {string} name - Plugin name.
     * @returns {object|undefined}
     */
    getOptions(name)
    {
        return this._options.get(name);
    }

    /**
     * List all registered plugin names.
     *
     * @returns {string[]}
     *
     * @example
     *   plugins.list(); // ['timestamps', 'soft-delete']
     */
    list()
    {
        return [...this._plugins.keys()];
    }

    /**
     * Get detailed info about all registered plugins.
     *
     * @returns {Array<{name: string, version: string, hasBootFn: boolean}>}
     */
    info()
    {
        const result = [];
        for (const [name, plugin] of this._plugins)
        {
            result.push({
                name,
                version: plugin.version || '0.0.0',
                hasBootFn: typeof plugin.boot === 'function',
            });
        }
        return result;
    }

    /**
     * Number of registered plugins.
     *
     * @type {number}
     */
    get size()
    {
        return this._plugins.size;
    }
}

module.exports = { PluginManager };
