'use strict';

/**
 * @module seed/factory
 * @description Factory pattern for generating and persisting model records.
 *
 * @example
 *   const factory = new Factory(User);
 *   factory.define({
 *       name:  () => Fake.fullName(),
 *       email: () => Fake.email({ unique: true }),
 *       role:  'user',
 *   });
 *
 *   // Build without persisting
 *   const data = factory.count(5).make();
 *
 *   // Create and persist
 *   const users = await factory.count(10).create();
 *
 *   // State overrides
 *   factory.state('admin', { role: 'admin' });
 *   const admins = await factory.count(3).withState('admin').create();
 */
class Factory
{
    /**
     * @param {typeof import('../model')} ModelClass
     */
    constructor(ModelClass)
    {
        this._model       = ModelClass;
        this._definition  = {};
        this._count       = 1;
        this._states      = {};
        this._activeState = null;
        this._afterCreate = [];
    }

    /**
     * Define default field generators for the factory.
     * Values can be static literals or functions `(index) => value`.
     *
     * @param {Record<string, any|((index: number) => any)>} definition
     * @returns {Factory}
     */
    define(definition)
    {
        this._definition = definition;
        return this;
    }

    /**
     * Set how many records to build / create.
     *
     * @param {number} n - Positive integer.
     * @returns {Factory}
     */
    count(n)
    {
        const val = Math.floor(n);
        if (!Number.isFinite(val) || val < 1)
            throw new Error('Factory: count must be a positive integer');
        this._count = val;
        return this;
    }

    /**
     * Register a named state (variation) that can override field values.
     *
     * @param {string} name
     * @param {Record<string, any|((index: number) => any)>} overrides
     * @returns {Factory}
     *
     * @example
     *   factory.state('admin', { role: 'admin', verified: true });
     *   await factory.count(3).withState('admin').create();
     */
    state(name, overrides)
    {
        this._states[name] = overrides;
        return this;
    }

    /**
     * Apply a previously registered state to the next create / make call.
     *
     * @param {string} name
     * @returns {Factory}
     */
    withState(name)
    {
        if (!this._states[name])
            throw new Error(`Factory state "${name}" is not defined`);
        this._activeState = name;
        return this;
    }

    /**
     * Register a callback invoked after each record is created.
     * Useful for setting up relationships.
     *
     * @param {(record: any, index: number) => void|Promise<void>} fn
     * @returns {Factory}
     *
     * @example
     *   factory.afterCreating(async (user) => {
     *       await Profile.create({ userId: user.id, bio: Fake.bio() });
     *   });
     */
    afterCreating(fn)
    {
        this._afterCreate.push(fn);
        return this;
    }

    /**
     * Build plain data objects without persisting to the database.
     *
     * @param {object} [overrides] - Per-call field overrides.
     * @returns {object|object[]} Single object when count=1, array otherwise.
     */
    make(overrides = {})
    {
        const records = [];
        for (let i = 0; i < this._count; i++)
            records.push(this._buildOne(overrides, i));
        return this._count === 1 ? records[0] : records;
    }

    /**
     * Create records and persist them to the database.
     *
     * @param {object} [overrides] - Per-call field overrides.
     * @returns {Promise<object|object[]>}
     */
    async create(overrides = {})
    {
        const records = [];
        for (let i = 0; i < this._count; i++)
        {
            const data   = this._buildOne(overrides, i);
            const record = await this._model.create(data);

            for (const fn of this._afterCreate)
                await fn(record, i);

            records.push(record);
        }
        return this._count === 1 ? records[0] : records;
    }

    /**
     * Build a single record data object applying definition → state → overrides.
     * @private
     */
    _buildOne(overrides, index)
    {
        const data = {};

        for (const [key, val] of Object.entries(this._definition))
            data[key] = typeof val === 'function' ? val(index) : val;

        if (this._activeState && this._states[this._activeState])
        {
            for (const [key, val] of Object.entries(this._states[this._activeState]))
                data[key] = typeof val === 'function' ? val(index) : val;
        }

        for (const [key, val] of Object.entries(overrides))
            data[key] = typeof val === 'function' ? val(index) : val;

        return data;
    }
}

module.exports = { Factory };
