'use strict';

/**
 * @module seed/seeder
 * @description Base Seeder class and SeederRunner for orchestrating database
 *              seeding operations.
 *
 * @example
 *   class UserSeeder extends Seeder {
 *       async run(db) {
 *           const factory = new Factory(User);
 *           factory.define({ name: () => Fake.fullName(), email: () => Fake.email() });
 *           await factory.count(50).create();
 *       }
 *   }
 *
 *   const runner = new SeederRunner(db);
 *   await runner.run(UserSeeder, PostSeeder);
 */

const log = require('../../debug')('zero:seed');

// ================================================================
//  Seeder base class
// ================================================================

/**
 * Extend this class to create a seeder.  Override `run(db)` with your
 * seeding logic.
 */
class Seeder
{
    /**
     * Run the seeder.  Must be overridden in subclasses.
     *
     * @param {import('../index').Database} db - Database instance.
     * @returns {Promise<void>}
     */
    async run(db)  // eslint-disable-line no-unused-vars
    {
        throw new Error(`Seeder ${this.constructor.name}: run() is not implemented`);
    }
}

// ================================================================
//  SeederRunner
// ================================================================

/**
 * Orchestrates running one or more seeders against a database connection.
 *
 * @example
 *   const runner = new SeederRunner(db);
 *   await runner.run(UserSeeder, PostSeeder);
 *   await runner.call(UserSeeder);           // single seeder
 *   await runner.fresh(UserSeeder);          // clear then seed
 */
class SeederRunner
{
    /**
     * @constructor
     * @param {import('../index').Database} db - Database connection instance.
     */
    constructor(db)
    {
        this._db = db;
    }

    /**
     * Run one or more seeder classes (or instances) in order.
     *
     * @param {...(Function|Function[])} seeders - Seeder classes or instances.
     * @returns {Promise<string[]>} Names of the seeders that ran.
     */
    async run(...seeders)
    {
        const flat  = seeders.flat();
        const names = [];

        for (const SeederClass of flat)
        {
            const instance = typeof SeederClass === 'function'
                ? new SeederClass()
                : SeederClass;

            const name = instance.constructor.name || 'AnonymousSeeder';
            log('Seeding: %s', name);

            await instance.run(this._db);
            names.push(name);

            log('Seeded:  %s', name);
        }

        return names;
    }

    /**
     * Run a single seeder class or instance.
     *
     * @param {Function} SeederClass - Seeder class or instance to run.
     * @returns {Promise<void>}
     */
    async call(SeederClass)
    {
        await this.run(SeederClass);
    }

    /**
     * Clear all adapter data then run the provided seeders.
     * Works with adapters that expose a `clear()` method (memory, json, redis).
     *
     * @param {...Function} seeders - Seeder classes to run after clearing.
     * @returns {Promise<string[]>} Names of the seeders that ran.
     */
    async fresh(...seeders)
    {
        if (typeof this._db.adapter.clear === 'function')
            await this._db.adapter.clear();

        return this.run(...seeders);
    }
}

module.exports = { Seeder, SeederRunner };
