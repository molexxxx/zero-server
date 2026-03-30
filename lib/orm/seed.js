/**
 * @module orm/seed
 * @description Database seeder utility for the zero-http ORM.
 *              Provides a structured way to populate databases with initial
 *              or test data, factory patterns for generating fake records,
 *              and built-in helpers for common data types.
 *
 * @example
 *   const { Database, Seeder, Factory } = require('zero-http');
 *
 *   class UserSeeder extends Seeder {
 *       async run(db) {
 *           const factory = new Factory(User);
 *           await factory.count(50).create({
 *               role: 'user',
 *           });
 *       }
 *   }
 *
 *   const db = Database.connect('memory');
 *   const seeder = new SeederRunner(db);
 *   await seeder.run(UserSeeder);
 */

const crypto = require('crypto');
const log = require('../debug')('zero:seed');

// -- Fake Data Helpers ------------------------------------

const FIRST_NAMES = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry',
    'Ivy', 'Jack', 'Karen', 'Leo', 'Mia', 'Nathan', 'Olivia', 'Peter',
    'Quinn', 'Rachel', 'Sam', 'Tina', 'Uma', 'Victor', 'Wendy', 'Xavier',
    'Yara', 'Zach', 'Amelia', 'Ben', 'Clara', 'David', 'Elena', 'Felix',
    'Gina', 'Hugo', 'Iris', 'James', 'Kyra', 'Liam', 'Maya', 'Noah',
];

const LAST_NAMES = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
    'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
    'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King',
];

const DOMAINS = [
    'example.com', 'test.com', 'demo.org', 'sample.net', 'fake.io',
    'acme.com', 'widgets.co', 'app.dev', 'mail.test', 'corp.example',
];

const WORDS = [
    'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'lorem',
    'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
    'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore', 'magna',
    'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation',
    'ullamco', 'laboris', 'nisi', 'aliquip', 'commodo', 'consequat',
];

/**
 * Built-in fake data generator.
 * All methods are static and require no external dependencies.
 */
class Fake
{
    /** Random first name. */
    static firstName()
    {
        return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    }

    /** Random last name. */
    static lastName()
    {
        return LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    }

    /** Random full name. */
    static fullName()
    {
        return `${Fake.firstName()} ${Fake.lastName()}`;
    }

    /** Random email address. */
    static email()
    {
        const first = Fake.firstName().toLowerCase();
        const last = Fake.lastName().toLowerCase();
        const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
        const num = Math.floor(Math.random() * 100);
        return `${first}.${last}${num}@${domain}`;
    }

    /** Random username. */
    static username()
    {
        const first = Fake.firstName().toLowerCase();
        const num = Math.floor(Math.random() * 9999);
        return `${first}${num}`;
    }

    /** Random UUID v4. */
    static uuid()
    {
        return crypto.randomUUID ? crypto.randomUUID() : _fallbackUuid();
    }

    /** Random integer between min and max (inclusive). */
    static integer(min = 0, max = 100)
    {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /** Random float between min and max. */
    static float(min = 0, max = 100, decimals = 2)
    {
        const val = Math.random() * (max - min) + min;
        return Number(val.toFixed(decimals));
    }

    /** Random boolean. */
    static boolean()
    {
        return Math.random() > 0.5;
    }

    /** Random date between start and end. */
    static date(start = new Date(2020, 0, 1), end = new Date())
    {
        const ms = start.getTime() + Math.random() * (end.getTime() - start.getTime());
        return new Date(ms);
    }

    /** Random ISO date string. */
    static dateString(start, end)
    {
        return Fake.date(start, end).toISOString();
    }

    /** Random paragraph (1–5 sentences). */
    static paragraph(sentences = 3)
    {
        const results = [];
        for (let i = 0; i < sentences; i++)
        {
            results.push(Fake.sentence());
        }
        return results.join(' ');
    }

    /** Random sentence (5–15 words). */
    static sentence(wordCount)
    {
        const count = wordCount || Fake.integer(5, 15);
        const words = [];
        for (let i = 0; i < count; i++)
        {
            words.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
        }
        words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
        return words.join(' ') + '.';
    }

    /** Random word. */
    static word()
    {
        return WORDS[Math.floor(Math.random() * WORDS.length)];
    }

    /** Random phone number. */
    static phone()
    {
        const area = Fake.integer(200, 999);
        const mid = Fake.integer(200, 999);
        const last = Fake.integer(1000, 9999);
        return `(${area}) ${mid}-${last}`;
    }

    /** Random hex color. */
    static color()
    {
        return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    }

    /** Random URL. */
    static url()
    {
        const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
        const path = Fake.word();
        return `https://${domain}/${path}`;
    }

    /** Random IP address. */
    static ip()
    {
        return `${Fake.integer(1, 255)}.${Fake.integer(0, 255)}.${Fake.integer(0, 255)}.${Fake.integer(1, 254)}`;
    }

    /** Pick a random element from an array. */
    static pick(arr)
    {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /** Pick N random elements from an array (no duplicates). */
    static pickMany(arr, n)
    {
        const shuffled = [...arr].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, Math.min(n, arr.length));
    }

    /** Random JSON-safe object. */
    static json()
    {
        return {
            key: Fake.word(),
            value: Fake.sentence(3),
            count: Fake.integer(1, 100),
            active: Fake.boolean(),
        };
    }
}

/** @private Fallback UUID generator for Node < 19. */
function _fallbackUuid()
{
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return [
        hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
        hex.slice(16, 20), hex.slice(20, 32),
    ].join('-');
}

// -- Factory Class ----------------------------------------

/**
 * Factory for generating model records.
 *
 * @example
 *   const factory = new Factory(User);
 *   factory.define({
 *       name: () => Fake.fullName(),
 *       email: () => Fake.email(),
 *       role: 'user',
 *   });
 *
 *   // Create 10 users in the database
 *   const users = await factory.count(10).create();
 *
 *   // Build without persisting
 *   const data = factory.count(5).make();
 */
class Factory
{
    /**
     * @param {typeof import('./model')} ModelClass
     */
    constructor(ModelClass)
    {
        this._model = ModelClass;
        this._definition = {};
        this._count = 1;
        this._states = {};
        this._afterCreate = [];
    }

    /**
     * Define default field generators.
     * @param {object} definition - Map of field → value or field → () => value.
     * @returns {Factory}
     */
    define(definition)
    {
        this._definition = definition;
        return this;
    }

    /**
     * Set how many records to create.
     * @param {number} n
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
     * Define a named state (variation) for the factory.
     * @param {string} name
     * @param {object} overrides
     * @returns {Factory}
     *
     * @example
     *   factory.state('admin', { role: 'admin' });
     *   const admins = await factory.count(3).withState('admin').create();
     */
    state(name, overrides)
    {
        this._states[name] = overrides;
        return this;
    }

    /**
     * Apply a named state to the next create/make.
     * @param {string} name
     * @returns {Factory}
     */
    withState(name)
    {
        if (!this._states[name])
        {
            throw new Error(`Factory state "${name}" is not defined`);
        }
        this._activeState = name;
        return this;
    }

    /**
     * Register an after-create callback.
     * @param {Function} fn - `async (record, index) => { ... }`
     * @returns {Factory}
     */
    afterCreating(fn)
    {
        this._afterCreate.push(fn);
        return this;
    }

    /**
     * Build records without persisting.
     * @param {object} [overrides] - Override specific fields.
     * @returns {object[]}
     */
    make(overrides = {})
    {
        const records = [];
        for (let i = 0; i < this._count; i++)
        {
            records.push(this._buildOne(overrides, i));
        }
        return this._count === 1 ? records[0] : records;
    }

    /**
     * Create records and persist to database.
     * @param {object} [overrides] - Override specific fields.
     * @returns {Promise<object|object[]>}
     */
    async create(overrides = {})
    {
        const records = [];
        for (let i = 0; i < this._count; i++)
        {
            const data = this._buildOne(overrides, i);
            const record = await this._model.create(data);
            for (const fn of this._afterCreate)
            {
                await fn(record, i);
            }
            records.push(record);
        }
        return this._count === 1 ? records[0] : records;
    }

    /**
     * Build a single record data object.
     * @private
     */
    _buildOne(overrides, index)
    {
        const data = {};

        // Apply definition
        for (const [key, val] of Object.entries(this._definition))
        {
            data[key] = typeof val === 'function' ? val(index) : val;
        }

        // Apply active state
        if (this._activeState && this._states[this._activeState])
        {
            for (const [key, val] of Object.entries(this._states[this._activeState]))
            {
                data[key] = typeof val === 'function' ? val(index) : val;
            }
        }

        // Apply overrides
        for (const [key, val] of Object.entries(overrides))
        {
            data[key] = typeof val === 'function' ? val(index) : val;
        }

        return data;
    }
}

// -- Seeder Base Class ------------------------------------

/**
 * Base Seeder class. Extend this to create seeders.
 *
 * @example
 *   class UserSeeder extends Seeder {
 *       async run(db) {
 *           await User.createMany([
 *               { name: 'Admin', email: 'admin@example.com', role: 'admin' },
 *               { name: 'User', email: 'user@example.com', role: 'user' },
 *           ]);
 *       }
 *   }
 */
class Seeder
{
    /**
     * Run the seeder.
     * Override this method in subclasses.
     * @param {import('./index').Database} db
     */
    async run(db)
    {
        throw new Error(`Seeder ${this.constructor.name}: run() is not implemented`);
    }
}

// -- Seeder Runner ----------------------------------------

/**
 * Runs seeders against a database.
 *
 * @example
 *   const runner = new SeederRunner(db);
 *   await runner.run(UserSeeder, PostSeeder);
 *   await runner.call(UserSeeder);
 */
class SeederRunner
{
    /**
     * @param {import('./index').Database} db
     */
    constructor(db)
    {
        this._db = db;
    }

    /**
     * Run one or more seeder classes.
     * @param {...Function|Function[]} seeders - Seeder classes or instances.
     * @returns {Promise<string[]>} Names of seeders that ran.
     */
    async run(...seeders)
    {
        const flat = seeders.flat();
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
     * Run a single seeder.
     * @param {Function} SeederClass
     * @returns {Promise<void>}
     */
    async call(SeederClass)
    {
        await this.run(SeederClass);
    }

    /**
     * Truncate all tables for registered models, then run seeders.
     * @param {...Function} seeders
     * @returns {Promise<string[]>}
     */
    async fresh(...seeders)
    {
        // Clear all model data via db
        if (typeof this._db.adapter.clear === 'function')
        {
            await this._db.adapter.clear();
        }
        return this.run(...seeders);
    }
}

module.exports = { Seeder, SeederRunner, Factory, Fake };
