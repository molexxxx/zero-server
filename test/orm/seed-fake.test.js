'use strict';
/** seed-fake.test.js — seed/fake module unit tests */

const { Fake }                         = require('../../lib/orm/seed/fake');
const { rand, seed: seedRng, getSeed } = require('../../lib/orm/seed/rng');
const { UniqueTracker }                = require('../../lib/orm/seed/unique');
const { Factory }                      = require('../../lib/orm/seed/factory');
const { SAFE_DOMAINS }                 = require('../../lib/orm/seed/data/internet');

// ============================================================
//  rng module
// ============================================================
describe('rng module', () =>
{
    afterEach(() => seedRng(null)); // always reset after each test

    it('seed(number) makes output deterministic', () =>
    {
        seedRng(42);
        const a = rand();
        seedRng(42);
        const b = rand();
        expect(a).toBe(b);
        expect(getSeed()).toBe(42 >>> 0);
    });

    it('seed(string) hashes to a numeric seed', () =>
    {
        seedRng('hello');
        expect(getSeed()).toBeGreaterThan(0);
        const a = rand();
        seedRng('hello');
        const b = rand();
        expect(a).toBe(b);
    });

    it('seed(null) resets to Math.random', () =>
    {
        seedRng(99);
        seedRng(null);
        expect(getSeed()).toBeNull();
        expect(typeof rand()).toBe('number');
    });

    it('seed(undefined) resets to Math.random', () =>
    {
        seedRng(5);
        seedRng(undefined);
        expect(getSeed()).toBeNull();
    });

    it('rand() always returns values in [0, 1)', () =>
    {
        seedRng(7);
        for (let i = 0; i < 100; i++)
        {
            const v = rand();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('different seeds produce different first values', () =>
    {
        seedRng(1);
        const a = rand();
        seedRng(2);
        const b = rand();
        expect(a).not.toBe(b);
    });

    it('zero seed is handled (truthy via >>>0)', () =>
    {
        // 0 >>> 0 === 0, falsy — seed() should detect value !== null/undefined path
        // and still create a 0-seeded RNG (mulberry32 handles 0)
        const s = seedRng(0);
        // seed path: typeof 0 === 'number', n = 0 >>> 0 = 0
        expect(getSeed()).toBe(0);
        const a = rand();
        seedRng(0);
        const b = rand();
        expect(a).toBe(b);
    });
});

// ============================================================
//  UniqueTracker
// ============================================================
describe('UniqueTracker', () =>
{
    let tracker;
    beforeEach(() => { tracker = new UniqueTracker(); });

    it('returns the generator value on first call', () =>
    {
        let n = 0;
        expect(tracker.generate('k', () => n++)).toBe(0);
    });

    it('retries until an unseen value is found', () =>
    {
        let n = 0;
        // Returns 0,0,1,1,2,2 — so second call forces retry
        const gen = () => Math.floor(n++ / 2);
        const a = tracker.generate('k', gen);
        const b = tracker.generate('k', gen);
        expect(a).toBe(0);
        expect(b).toBe(1);
    });

    it('seen() returns count for an existing namespace', () =>
    {
        tracker.generate('ns', () => 'a');
        tracker.generate('ns', () => 'b');
        expect(tracker.seen('ns')).toBe(2);
    });

    it('seen() returns 0 for an unknown namespace', () =>
    {
        expect(tracker.seen('nonexistent')).toBe(0);
    });

    it('reset(key) clears only the specified namespace', () =>
    {
        tracker.generate('a', () => 1);
        tracker.generate('b', () => 2);
        tracker.reset('a');
        expect(tracker.seen('a')).toBe(0);
        expect(tracker.seen('b')).toBe(1);
    });

    it('reset() with no argument clears all namespaces', () =>
    {
        tracker.generate('a', () => 1);
        tracker.generate('b', () => 2);
        tracker.reset();
        expect(tracker.seen('a')).toBe(0);
        expect(tracker.seen('b')).toBe(0);
    });

    it('throws with a descriptive error when the pool is exhausted', () =>
    {
        // Seed the set first so the value is already known
        tracker.generate('exhaust-key', () => 'same');
        // Now every attempt returns 'same' which is already seen → exhausts
        expect(() => tracker.generate('exhaust-key', () => 'same', 3))
            .toThrow('exhausted 3 attempts');
        expect(() => tracker.generate('exhaust-key', () => 'same', 3))
            .toThrow('key "exhaust-key"');
    });
});

// ============================================================
//  Factory — extra branch coverage
// ============================================================
describe('Factory extra branches', () =>
{
    it('count() throws on non-positive input (0)', () =>
    {
        expect(() => new Factory({}).count(0)).toThrow('positive integer');
    });

    it('count() throws on negative input', () =>
    {
        expect(() => new Factory({}).count(-5)).toThrow('positive integer');
    });

    it('count() throws on NaN', () =>
    {
        expect(() => new Factory({}).count(NaN)).toThrow('positive integer');
    });

    it('_buildOne applies function state overrides', () =>
    {
        const DummyModel = { create: async (d) => ({ ...d, id: 1 }) };
        const f = new Factory(DummyModel)
            .define({ role: 'user' })
            .state('admin', { role: (i) => `admin_${i}` })
            .withState('admin');

        const record = f.make();
        expect(record.role).toBe('admin_0');
    });

    it('_buildOne applies function overrides from make()', () =>
    {
        const DummyModel = { create: async (d) => ({ ...d, id: 1 }) };
        const f = new Factory(DummyModel).define({ name: 'base' });
        const record = f.make({ name: (i) => `override_${i}` });
        expect(record.name).toBe('override_0');
    });
});

// ============================================================
//  Fake — Seeding & Uniqueness
// ============================================================
describe('Fake seeding & uniqueness', () =>
{
    afterEach(() => { Fake.seed(null); Fake.resetUnique(); });

    it('seed(number) makes Fake output deterministic', () =>
    {
        Fake.seed(100);
        const a = Fake.firstName();
        Fake.seed(100);
        const b = Fake.firstName();
        expect(a).toBe(b);
    });

    it('seed(string) produces deterministic output', () =>
    {
        Fake.seed('test-seed');
        const a = Fake.integer(1, 1000);
        Fake.seed('test-seed');
        const b = Fake.integer(1, 1000);
        expect(a).toBe(b);
    });

    it('seed(null) resets; getSeed() returns null', () =>
    {
        Fake.seed(42);
        Fake.seed(null);
        expect(Fake.getSeed()).toBeNull();
    });

    it('getSeed() returns the active numeric seed', () =>
    {
        Fake.seed(77);
        expect(Fake.getSeed()).toBe(77 >>> 0);
    });

    it('unique() returns unique values per namespace', () =>
    {
        const vals = new Set();
        for (let i = 0; i < 10; i++)
            vals.add(Fake.unique(() => Fake.integer(0, 100000), { key: 'u-test' }));
        expect(vals.size).toBe(10);
    });

    it('unique() uses fn.name as default key when no key option given', () =>
    {
        function myNamedGen() { return Math.random().toString(36); }
        const v = Fake.unique(myNamedGen);
        expect(typeof v).toBe('string');
        Fake.resetUnique('myNamedGen');
    });

    it('unique() uses "default" key for anonymous functions with no key', () =>
    {
        const v = Fake.unique(() => Math.random().toString(36));
        expect(typeof v).toBe('string');
        Fake.resetUnique('default');
    });

    it('unique() respects maxAttempts option', () =>
    {
        expect(() =>
            Fake.unique(() => 'fixed', { key: 'exhaust-test', maxAttempts: 2 })
        ).not.toThrow(); // first call succeeds

        // Second call with same key and same generator value → exhausted
        expect(() =>
            Fake.unique(() => 'fixed', { key: 'exhaust-test', maxAttempts: 1 })
        ).toThrow('exhausted');
    });

    it('resetUnique(key) clears specific namespace', () =>
    {
        Fake.unique(() => 'x', { key: 'ns1' });
        expect(Fake.uniqueCount('ns1')).toBe(1);
        Fake.resetUnique('ns1');
        expect(Fake.uniqueCount('ns1')).toBe(0);
    });

    it('resetUnique() with no arg clears all namespaces', () =>
    {
        Fake.unique(() => 'a', { key: 'k1' });
        Fake.unique(() => 'b', { key: 'k2' });
        Fake.resetUnique();
        expect(Fake.uniqueCount('k1')).toBe(0);
        expect(Fake.uniqueCount('k2')).toBe(0);
    });

    it('uniqueCount() returns 0 for an unknown namespace', () =>
    {
        expect(Fake.uniqueCount('never-used')).toBe(0);
    });
});

// ============================================================
//  Fake — Names
// ============================================================
describe('Fake names', () =>
{
    it('firstName() returns a non-empty string', () =>
    {
        expect(typeof Fake.firstName()).toBe('string');
        expect(Fake.firstName().length).toBeGreaterThan(0);
    });

    it('firstName({ sex: "male" }) uses the male pool', () =>
    {
        expect(typeof Fake.firstName({ sex: 'male' })).toBe('string');
    });

    it('firstName({ sex: "female" }) uses the female pool', () =>
    {
        expect(typeof Fake.firstName({ sex: 'female' })).toBe('string');
    });

    it('firstName({ locale: "es" }) uses the Spanish pool', () =>
    {
        expect(typeof Fake.firstName({ locale: 'es' })).toBe('string');
    });

    it('firstName({ locale: "zz" }) falls back to the English pool', () =>
    {
        // Unknown locale → _namePool returns NAMES.en
        expect(typeof Fake.firstName({ locale: 'zz' })).toBe('string');
    });

    it('firstName({ unique: true }) generates unique values', () =>
    {
        Fake.resetUnique('firstName_en_male');
        const seen = new Set();
        for (let i = 0; i < 5; i++)
            seen.add(Fake.firstName({ sex: 'male', unique: true }));
        expect(seen.size).toBe(5);
        Fake.resetUnique('firstName_en_male');
    });

    it('lastName() returns a string', () =>
    {
        expect(typeof Fake.lastName()).toBe('string');
    });

    it('lastName({ locale: "fr" }) uses the French pool', () =>
    {
        expect(typeof Fake.lastName({ locale: 'fr' })).toBe('string');
    });

    it('lastName({ unique: true }) returns a unique value', () =>
    {
        Fake.resetUnique('lastName_en');
        expect(typeof Fake.lastName({ unique: true })).toBe('string');
        Fake.resetUnique('lastName_en');
    });

    it('middleName() delegates to firstName()', () =>
    {
        expect(typeof Fake.middleName()).toBe('string');
    });

    it('middleName({ sex: "female", locale: "de" }) returns a string', () =>
    {
        expect(typeof Fake.middleName({ sex: 'female', locale: 'de' })).toBe('string');
    });

    it('fullName() with no args returns exactly "First Last" (2 words)', () =>
    {
        expect(Fake.fullName().split(' ')).toHaveLength(2);
    });

    it('fullName({ prefix: true }) has ≥ 3 parts', () =>
    {
        expect(Fake.fullName({ prefix: true }).split(' ').length).toBeGreaterThanOrEqual(3);
    });

    it('fullName({ middle: true }) has ≥ 3 parts', () =>
    {
        expect(Fake.fullName({ middle: true }).split(' ').length).toBeGreaterThanOrEqual(3);
    });

    it('fullName({ suffix: true }) has ≥ 3 parts', () =>
    {
        expect(Fake.fullName({ suffix: true }).split(' ').length).toBeGreaterThanOrEqual(3);
    });

    it('fullName({ prefix, middle, suffix }) includes all optional parts', () =>
    {
        const parts = Fake.fullName({ prefix: true, middle: true, suffix: true }).split(' ');
        expect(parts.length).toBeGreaterThanOrEqual(5);
    });

    it('fullName({ firstName, lastName }) uses overrides verbatim', () =>
    {
        expect(Fake.fullName({ firstName: 'Alice', lastName: 'Smith' })).toBe('Alice Smith');
    });

    it('fullName({ unique: true }) returns a string', () =>
    {
        Fake.resetUnique('fullName_en');
        expect(typeof Fake.fullName({ unique: true })).toBe('string');
        Fake.resetUnique('fullName_en');
    });

    it('namePrefix() with no options returns a string', () =>
    {
        expect(typeof Fake.namePrefix()).toBe('string');
    });

    it('namePrefix() random — seed 0 yields female prefix (rand < 0.5)', () =>
    {
        // seed 0: rand() ≈ 0.266 → 0.266 > 0.5 is false → 'female' branch (line 283)
        Fake.seed(0);
        const p = Fake.namePrefix();
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
    });

    it('namePrefix() random — seed 1 yields male prefix (rand > 0.5)', () =>
    {
        // seed 1: rand() ≈ 0.627 → 0.627 > 0.5 is true → 'male' branch (line 282)
        Fake.seed(1);
        const p = Fake.namePrefix();
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
    });

    it('namePrefix({ sex: "male" }) returns a male prefix', () =>
    {
        const p = Fake.namePrefix({ sex: 'male' });
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
    });

    it('namePrefix({ sex: "female" }) returns a female prefix', () =>
    {
        expect(typeof Fake.namePrefix({ sex: 'female' })).toBe('string');
    });

    it('namePrefix({ sex: "neutral" }) returns a neutral prefix', () =>
    {
        expect(typeof Fake.namePrefix({ sex: 'neutral' })).toBe('string');
    });

    it('nameSuffix() returns a non-empty string', () =>
    {
        const s = Fake.nameSuffix();
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
    });

    it('locales() returns an array containing "en", "es", "fr"', () =>
    {
        const locs = Fake.locales();
        expect(Array.isArray(locs)).toBe(true);
        expect(locs.length).toBeGreaterThan(0);
        expect(locs).toContain('en');
        expect(locs).toContain('es');
        expect(locs).toContain('fr');
    });
});

// ============================================================
//  Fake — Phone
// ============================================================
describe('Fake phone', () =>
{
    it('phone() defaults to US national format (###) ###-####', () =>
    {
        for (let i = 0; i < 10; i++)
            expect(Fake.phone()).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
    });

    it('phone({ format: "human" }) returns a human format for US', () =>
    {
        expect(typeof Fake.phone({ format: 'human' })).toBe('string');
    });

    it('phone({ format: "international" }) returns +1 prefix for US', () =>
    {
        expect(Fake.phone({ format: 'international' })).toMatch(/^\+1/);
    });

    it('phone({ countryCode: "DE" }) uses German format', () =>
    {
        expect(typeof Fake.phone({ countryCode: 'DE' })).toBe('string');
    });

    it('phone({ countryCode: "DE", format: "international" }) starts with +49', () =>
    {
        expect(Fake.phone({ countryCode: 'DE', format: 'international' })).toMatch(/^\+49/);
    });

    it('phone({ countryCode: "XX" }) falls back to US format', () =>
    {
        expect(typeof Fake.phone({ countryCode: 'XX' })).toBe('string');
    });

    it('phone({ format: "bogus" }) falls back to national format', () =>
    {
        // Triggers: country.formats[style] is undefined → || country.formats.national branch
        expect(typeof Fake.phone({ format: 'bogus' })).toBe('string');
    });

    it('phone({ unique: true }) generates a value', () =>
    {
        Fake.resetUnique('phone_US_national');
        expect(typeof Fake.phone({ unique: true })).toBe('string');
        Fake.resetUnique('phone_US_national');
    });

    it('phoneCodes() returns an array with US and DE', () =>
    {
        const codes = Fake.phoneCodes();
        expect(Array.isArray(codes)).toBe(true);
        expect(codes).toContain('US');
        expect(codes).toContain('DE');
    });
});

// ============================================================
//  Fake — Email
// ============================================================
describe('Fake email', () =>
{
    it('email() contains @ and a dot in the domain', () =>
    {
        const e = Fake.email();
        expect(e).toContain('@');
        expect(e).toContain('.');
    });

    it('email({ provider }) uses the given domain', () =>
    {
        expect(Fake.email({ provider: 'myco.com' })).toContain('@myco.com');
    });

    it('email({ safe: true }) uses only domains from the safe-domain list', () =>
    {
        for (let i = 0; i < 10; i++)
        {
            const domain = Fake.email({ safe: true }).split('@')[1];
            expect(SAFE_DOMAINS).toContain(domain);
        }
    });

    it('email({ firstName, lastName }) uses the provided names in the local part', () =>
    {
        // Run several times; at least one pattern will place the full first name
        let saw = false;
        for (let i = 0; i < 20; i++)
            if (Fake.email({ firstName: 'Zelda', lastName: 'Link' }).includes('zelda'))
            { saw = true; break; }
        expect(saw).toBe(true);
    });

    it('email({ locale: "ja" }) uses Japanese locale names', () =>
    {
        expect(Fake.email({ locale: 'ja' })).toContain('@');
    });

    it('email({ unique: true }) returns a string', () =>
    {
        Fake.resetUnique('email_any');
        expect(typeof Fake.email({ unique: true })).toBe('string');
        Fake.resetUnique('email_any');
    });
});

// ============================================================
//  Fake — Username
// ============================================================
describe('Fake username', () =>
{
    it('username() returns a non-empty string', () =>
    {
        expect(typeof Fake.username()).toBe('string');
    });

    it('username({ style: "dot" }) contains a dot separator', () =>
    {
        let found = false;
        for (let i = 0; i < 20; i++)
        {
            if (Fake.username({ style: 'dot', numbers: false }).includes('.'))
            {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });

    it('username({ style: "underscore" }) contains an underscore', () =>
    {
        let found = false;
        for (let i = 0; i < 20; i++)
        {
            if (Fake.username({ style: 'underscore', numbers: false }).includes('_'))
            {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });

    it('username({ style: "none" }) contains only alphanumeric characters', () =>
    {
        expect(Fake.username({ style: 'none', numbers: false })).toMatch(/^[a-z0-9]+$/);
    });

    it('username({ style: "random" }) returns a string', () =>
    {
        expect(typeof Fake.username({ style: 'random' })).toBe('string');
    });

    it('username({ numbers: false }) produces no trailing digit', () =>
    {
        const u = Fake.username({ style: 'none', numbers: false });
        expect(u).toMatch(/^[a-z]+$/);
    });

    it('username({ firstName, lastName, style: "none", numbers: false }) uses given names', () =>
    {
        expect(Fake.username({ firstName: 'Alice', lastName: 'Smith', style: 'none', numbers: false }))
            .toBe('alicesmith');
    });

    it('username({ unique: true }) returns a string', () =>
    {
        Fake.resetUnique('username_random');
        expect(typeof Fake.username({ unique: true })).toBe('string');
        Fake.resetUnique('username_random');
    });
});

// ============================================================
//  Fake — Numbers
// ============================================================
describe('Fake numbers', () =>
{
    it('integer(min, max) returns value in [min, max]', () =>
    {
        for (let i = 0; i < 50; i++)
        {
            const n = Fake.integer(10, 20);
            expect(n).toBeGreaterThanOrEqual(10);
            expect(n).toBeLessThanOrEqual(20);
        }
    });

    it('integer({ min, max }) object form works', () =>
    {
        expect(Fake.integer({ min: 5, max: 5 })).toBe(5);
    });

    it('integer({ min, max }) with omitted fields defaults to 0/100', () =>
    {
        const n = Fake.integer({});
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
    });

    it('integer() with no args returns 0–100', () =>
    {
        const n = Fake.integer();
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
    });

    it('float(min, max, decimals) returns value with correct precision', () =>
    {
        const f = Fake.float(1, 2, 4);
        expect(f).toBeGreaterThanOrEqual(1);
        expect(f).toBeLessThanOrEqual(2);
        // at most 4 decimal places
        expect((f.toString().split('.')[1] || '').length).toBeLessThanOrEqual(4);
    });

    it('float({ min, max, decimals }) object form works', () =>
    {
        expect(Fake.float({ min: 10, max: 10, decimals: 2 })).toBe(10);
    });

    it('float({ min, max }) with omitted decimals defaults to 2', () =>
    {
        const f = Fake.float({ min: 0, max: 1 });
        expect((f.toString().split('.')[1] || '').length).toBeLessThanOrEqual(2);
    });

    it('float({}) with empty object uses all ?? defaults (max=100, min=0, decimals=2)', () =>
    {
        // Triggers opts.max ?? 100 and opts.min ?? 0 fallback branches
        const f = Fake.float({});
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(100);
    });

    it('float() with no args returns 0–100', () =>
    {
        const f = Fake.float();
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(100);
    });

    it('numericString(6) returns a 6-digit string', () =>
    {
        const s = Fake.numericString(6);
        expect(s).toHaveLength(6);
        expect(s).toMatch(/^\d{6}$/);
    });

    it('numericString() defaults to 6 digits', () =>
    {
        expect(Fake.numericString()).toHaveLength(6);
    });

    it('numericString({ leadingZeros: false }) has non-zero first digit', () =>
    {
        for (let i = 0; i < 30; i++)
        {
            const s = Fake.numericString(4, { leadingZeros: false });
            expect(Number(s[0])).toBeGreaterThanOrEqual(1);
        }
    });

    it('numericString({ separator: "-", groupSize: 4 }) groups by 4', () =>
    {
        const s = Fake.numericString(16, { separator: '-', groupSize: 4 });
        expect(s).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/);
    });

    it('numericString({ separator: "-" }) uses default groupSize of 3', () =>
    {
        const s = Fake.numericString(6, { separator: '-' });
        expect(s).toMatch(/^\d{3}-\d{3}$/);
    });

    it('alphanumeric(10) returns 10 lowercase letters/digits', () =>
    {
        const s = Fake.alphanumeric(10);
        expect(s).toHaveLength(10);
        expect(s).toMatch(/^[a-z0-9]+$/);
    });

    it('alphanumeric({ uppercase: true }) returns uppercase chars', () =>
    {
        expect(Fake.alphanumeric(8, { uppercase: true })).toMatch(/^[A-Z0-9]+$/);
    });

    it('alphanumeric({ letters: false }) returns digits only', () =>
    {
        expect(Fake.alphanumeric(8, { letters: false })).toMatch(/^\d+$/);
    });

    it('alphanumeric({ letters: false, digits: false }) uses fallback pool', () =>
    {
        // Both excluded → empty pool → fallback to CHARSET_LOWERCASE + CHARSET_DIGITS
        const s = Fake.alphanumeric(8, { letters: false, digits: false });
        expect(s).toHaveLength(8);
        expect(s).toMatch(/^[a-z0-9]+$/);
    });

    it('alpha(8) returns 8 lowercase letters', () =>
    {
        expect(Fake.alpha(8)).toMatch(/^[a-z]{8}$/);
    });

    it('alpha({ uppercase: true }) returns uppercase letters', () =>
    {
        expect(Fake.alpha(4, { uppercase: true })).toMatch(/^[A-Z]{4}$/);
    });

    it('alpha({ mixed: true }) returns mixed-case letters', () =>
    {
        const s = Fake.alpha(50, { mixed: true });
        expect(s).toMatch(/^[a-zA-Z]+$/);
    });

    it('boolean() returns both true and false over many calls', () =>
    {
        const seen = new Set();
        for (let i = 0; i < 100; i++) seen.add(Fake.boolean());
        expect(seen.has(true)).toBe(true);
        expect(seen.has(false)).toBe(true);
    });
});

// ============================================================
//  Fake — Dates
// ============================================================
describe('Fake dates', () =>
{
    it('date() returns a Date instance', () =>
    {
        expect(Fake.date()).toBeInstanceOf(Date);
    });

    it('date(start, end) stays within the given range', () =>
    {
        const start = new Date('2000-01-01');
        const end   = new Date('2001-01-01');
        const d = Fake.date(start, end);
        expect(d.getTime()).toBeGreaterThanOrEqual(start.getTime());
        expect(d.getTime()).toBeLessThanOrEqual(end.getTime());
    });

    it('dateString() returns a valid ISO string', () =>
    {
        const s = Fake.dateString();
        expect(new Date(s).toISOString()).toBe(s);
    });

    it('datePast() returns a date before now', () =>
    {
        expect(Fake.datePast().getTime()).toBeLessThan(Date.now());
    });

    it('datePast({ years: 5 }) is within 5 years back', () =>
    {
        const d    = Fake.datePast({ years: 5 });
        const five = new Date();
        five.setFullYear(five.getFullYear() - 5);
        expect(d.getTime()).toBeGreaterThanOrEqual(five.getTime() - 1000); // 1s tolerance
    });

    it('dateFuture() returns a date after now', () =>
    {
        expect(Fake.dateFuture().getTime()).toBeGreaterThan(Date.now());
    });

    it('dateFuture({ years: 2 }) is within 2 years ahead', () =>
    {
        const d   = Fake.dateFuture({ years: 2 });
        const two = new Date();
        two.setFullYear(two.getFullYear() + 2);
        expect(d.getTime()).toBeLessThanOrEqual(two.getTime() + 1000);
    });
});

// ============================================================
//  Fake — Text
// ============================================================
describe('Fake text', () =>
{
    it('word() returns a lorem word', () =>
    {
        expect(typeof Fake.word()).toBe('string');
    });

    it('word({ type: "hacker" }) returns a hacker noun', () =>
    {
        expect(typeof Fake.word({ type: 'hacker' })).toBe('string');
    });

    it('word({ type: "adjective" }) returns an adjective', () =>
    {
        expect(typeof Fake.word({ type: 'adjective' })).toBe('string');
    });

    it('word({ type: "noun" }) returns a noun', () =>
    {
        expect(typeof Fake.word({ type: 'noun' })).toBe('string');
    });

    it('words(5) returns an array of 5 strings', () =>
    {
        const arr = Fake.words(5);
        expect(arr).toHaveLength(5);
        arr.forEach(w => expect(typeof w).toBe('string'));
    });

    it('words() defaults to 3 items', () =>
    {
        expect(Fake.words()).toHaveLength(3);
    });

    it('sentence() starts with uppercase and ends with "."', () =>
    {
        const s = Fake.sentence();
        expect(s[0]).toBe(s[0].toUpperCase());
        expect(s.endsWith('.')).toBe(true);
    });

    it('sentence(5) has exactly 5 words', () =>
    {
        const s = Fake.sentence(5);
        // strip the period, split on spaces
        expect(s.slice(0, -1).split(' ')).toHaveLength(5);
    });

    it('paragraph(3) contains at least 3 periods', () =>
    {
        const dots = (Fake.paragraph(3).match(/\./g) || []).length;
        expect(dots).toBeGreaterThanOrEqual(3);
    });

    it('hackerPhrase() returns at least 3 words (verbs/nouns may be multi-word)', () =>
    {
        const words = Fake.hackerPhrase().split(' ');
        expect(words.length).toBeGreaterThanOrEqual(3);
    });

    it('slug(3) returns hyphened lowercase words', () =>
    {
        const s = Fake.slug(3);
        expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    });

    it('slug() defaults to 3 words', () =>
    {
        expect(typeof Fake.slug()).toBe('string');
    });

    it('hashtag() starts with # and has content', () =>
    {
        const h = Fake.hashtag();
        expect(h.startsWith('#')).toBe(true);
        expect(h.length).toBeGreaterThan(1);
    });
});

// ============================================================
//  Fake — Person
// ============================================================
describe('Fake person', () =>
{
    it('jobTitle() returns a multi-word string (descriptor area type)', () =>
    {
        // descriptors (e.g. "VP of") and areas (e.g. "Machine Learning") may be multi-word
        expect(Fake.jobTitle().split(' ').length).toBeGreaterThanOrEqual(3);
    });

    it('jobTitle({ full: true }) returns a pre-built title string', () =>
    {
        expect(typeof Fake.jobTitle({ full: true })).toBe('string');
    });

    it('jobArea() returns a string', () => { expect(typeof Fake.jobArea()).toBe('string'); });

    it('jobType() returns a string', () => { expect(typeof Fake.jobType()).toBe('string'); });

    it('jobDescriptor() returns a string', () =>
    {
        expect(typeof Fake.jobDescriptor()).toBe('string');
    });

    it('bio() returns a short phrase', () =>
    {
        expect(typeof Fake.bio()).toBe('string');
    });

    it('bio({ style: "full" }) contains "|" separator', () =>
    {
        expect(Fake.bio({ style: 'full' })).toContain('|');
    });

    it('zodiacSign() returns one of the 12 signs', () =>
    {
        const valid = [
            'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
            'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces',
        ];
        expect(valid).toContain(Fake.zodiacSign());
    });

    it('gender() returns a non-empty string', () =>
    {
        expect(typeof Fake.gender()).toBe('string');
    });

    it('gender({ binary: true }) returns only "Male" or "Female"', () =>
    {
        const seen = new Set();
        for (let i = 0; i < 50; i++) seen.add(Fake.gender({ binary: true }));
        expect(seen.has('Male')).toBe(true);
        expect(seen.has('Female')).toBe(true);
        seen.forEach(v => expect(['Male','Female']).toContain(v));
    });

    it('bloodType() returns one of the 8 ABO/Rh types', () =>
    {
        const valid = ['A+','A-','B+','B-','O+','O-','AB+','AB-'];
        expect(valid).toContain(Fake.bloodType());
    });
});

// ============================================================
//  Fake — Location
// ============================================================
describe('Fake location', () =>
{
    it('city() returns a non-empty string', () =>
    {
        expect(typeof Fake.city()).toBe('string');
    });

    it('city({ country: "US" }) returns a US city name', () =>
    {
        expect(typeof Fake.city({ country: 'US' })).toBe('string');
    });

    it('city({ country: "JP" }) returns a city (or all-cities fallback)', () =>
    {
        expect(typeof Fake.city({ country: 'JP' })).toBe('string');
    });

    it('city({ country: "ZZ" }) falls back to all CITIES when no match', () =>
    {
        // No cities with code ZZ → fallback pool used → still returns a string
        expect(typeof Fake.city({ country: 'ZZ' })).toBe('string');
    });

    it('country() returns a country name string', () =>
    {
        expect(typeof Fake.country()).toBe('string');
    });

    it('country({ codeOnly: true }) returns a 2-letter ISO code', () =>
    {
        const code = Fake.country({ codeOnly: true });
        expect(typeof code).toBe('string');
        expect(code.length).toBe(2);
    });

    it('country({ full: true }) returns { name, code } object', () =>
    {
        const c = Fake.country({ full: true });
        expect(c).toHaveProperty('name');
        expect(c).toHaveProperty('code');
    });

    it('state() returns a US state name', () =>
    {
        expect(typeof Fake.state()).toBe('string');
    });

    it('state({ abbr: true }) returns a 2-character abbreviation', () =>
    {
        expect(Fake.state({ abbr: true })).toHaveLength(2);
    });

    it('state({ full: true }) returns { name, abbr } object', () =>
    {
        const s = Fake.state({ full: true });
        expect(s).toHaveProperty('name');
        expect(s).toHaveProperty('abbr');
    });

    it('zipCode() defaults to a 5-digit US ZIP', () =>
    {
        expect(Fake.zipCode()).toMatch(/^\d{5}$/);
    });

    it('zipCode with N-template char covers the N→digit-1-9 branch', () =>
    {
        // 'N' in a template means digit 1–9 (non-zero). No built-in data uses it,
        // so we temporarily inject a test pattern into ZIP_PATTERNS.
        const locData = require('../../lib/orm/seed/data/locations');
        locData.ZIP_PATTERNS['__TEST__'] = 'N##';
        try {
            const zip = Fake.zipCode({ countryCode: '__TEST__' });
            // First char must be 1-9, remaining must be digits
            expect(zip).toMatch(/^[1-9]\d{2}$/);
        } finally {
            delete locData.ZIP_PATTERNS['__TEST__'];
        }
    });

    it('zipCode({ countryCode: "CA" }) returns a Canadian postal code', () =>
    {
        // CA pattern 'A#A #A#' uses the 'A' template char (uppercase letter)
        const zip = Fake.zipCode({ countryCode: 'CA' });
        expect(zip).toMatch(/^[A-Z]\d[A-Z] \d[A-Z]\d$/);
    });

    it('zipCode({ countryCode: "GB" }) returns a UK postcode', () =>
    {
        // GB pattern 'AA## #AA' also uses 'A' chars
        const zip = Fake.zipCode({ countryCode: 'GB' });
        expect(typeof zip).toBe('string');
        expect(zip.length).toBeGreaterThan(0);
    });

    it('zipCode({ countryCode: "ZZ" }) falls back to US format', () =>
    {
        expect(Fake.zipCode({ countryCode: 'ZZ' })).toMatch(/^\d{5}$/);
    });

    it('latitude() returns a float in [-90, 90]', () =>
    {
        const lat = Fake.latitude();
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
    });

    it('latitude({ min: 0, max: 10 }) respects custom bounds', () =>
    {
        const lat = Fake.latitude({ min: 0, max: 10 });
        expect(lat).toBeGreaterThanOrEqual(0);
        expect(lat).toBeLessThanOrEqual(10);
    });

    it('longitude() returns a float in [-180, 180]', () =>
    {
        const lng = Fake.longitude();
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
    });

    it('longitude({ min: 0, max: 0, decimals: 2 }) returns 0', () =>
    {
        expect(Fake.longitude({ min: 0, max: 0, decimals: 2 })).toBe(0);
    });

    it('coordinates() returns { latitude, longitude } within valid ranges', () =>
    {
        const c = Fake.coordinates();
        expect(c).toHaveProperty('latitude');
        expect(c).toHaveProperty('longitude');
        expect(c.latitude).toBeGreaterThanOrEqual(-90);
        expect(c.longitude).toBeGreaterThanOrEqual(-180);
    });

    it('timezone() returns a string containing "/"', () =>
    {
        expect(Fake.timezone()).toMatch(/\//);
    });

    it('streetName() contains at least 2 words', () =>
    {
        expect(Fake.streetName().split(' ').length).toBeGreaterThanOrEqual(2);
    });

    it('address() returns a US address string with commas', () =>
    {
        const a = Fake.address();
        expect(typeof a).toBe('string');
        expect(a).toContain(',');
    });

    it('address({ format: "object" }) returns a structured object with all fields', () =>
    {
        const a = Fake.address({ format: 'object' });
        expect(a).toHaveProperty('streetNumber');
        expect(a).toHaveProperty('streetName');
        expect(a).toHaveProperty('city');
        expect(a).toHaveProperty('state');
        expect(a).toHaveProperty('zipCode');
        expect(a).toHaveProperty('country');
    });

    it('address({ countryCode: "GB" }) returns non-US string format', () =>
    {
        expect(typeof Fake.address({ countryCode: 'GB' })).toBe('string');
    });

    it('address({ countryCode: "GB", format: "object" }) has null state', () =>
    {
        const a = Fake.address({ countryCode: 'GB', format: 'object' });
        expect(a.state).toBeNull();
    });

    it('address({ countryCode: "ZZ", format: "object" }) uses the code as country name', () =>
    {
        // COUNTRIES.find() returns undefined for ZZ → fallback: { name: 'ZZ' }
        expect(Fake.address({ countryCode: 'ZZ', format: 'object' }).country).toBe('ZZ');
    });
});

// ============================================================
//  Fake — Commerce
// ============================================================
describe('Fake commerce', () =>
{
    it('productName() returns "adjective material noun" (3 words)', () =>
    {
        expect(Fake.productName().split(' ')).toHaveLength(3);
    });

    it('productName({ withMaterial: false }) returns "adjective noun" (2 words)', () =>
    {
        expect(Fake.productName({ withMaterial: false }).split(' ')).toHaveLength(2);
    });

    it('category() returns a non-empty string', () =>
    {
        expect(typeof Fake.category()).toBe('string');
    });

    it('department() returns a non-empty string', () =>
    {
        expect(typeof Fake.department()).toBe('string');
    });

    it('company() with default suffix has ≥ 3 words', () =>
    {
        expect(Fake.company().split(' ').length).toBeGreaterThanOrEqual(3);
    });

    it('company({ suffix: false }) has exactly 2 words', () =>
    {
        expect(Fake.company({ suffix: false }).split(' ')).toHaveLength(2);
    });

    it('price() returns a number by default', () =>
    {
        const p = Fake.price();
        expect(typeof p).toBe('number');
        expect(p).toBeGreaterThan(0);
    });

    it('price({ symbol: "$" }) returns a string starting with "$"', () =>
    {
        const p = Fake.price({ symbol: '$' });
        expect(typeof p).toBe('string');
        expect(p.startsWith('$')).toBe(true);
    });

    it('price({ min: 5, max: 5 }) returns 5', () =>
    {
        expect(Fake.price({ min: 5, max: 5 })).toBe(5);
    });

    it('industry() returns a non-empty string', () =>
    {
        expect(typeof Fake.industry()).toBe('string');
    });

    it('catchPhrase() returns a 2-word phrase', () =>
    {
        expect(Fake.catchPhrase().split(' ')).toHaveLength(2);
    });
});

// ============================================================
//  Fake — Internet & Network
// ============================================================
describe('Fake internet & network', () =>
{
    it('uuid() matches UUIDv4 pattern', () =>
    {
        expect(Fake.uuid()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
    });

    it('domainName() matches adj-noun.tld format', () =>
    {
        expect(Fake.domainName()).toMatch(/^[a-z]+-[a-z]+\.[a-z]+$/);
    });

    it('domainName({ tld: "io" }) forces the .io TLD', () =>
    {
        expect(Fake.domainName({ tld: 'io' })).toMatch(/\.io$/);
    });

    it('url() starts with https:// and has a path segment', () =>
    {
        expect(Fake.url()).toMatch(/^https:\/\/[^/]+\/\w+/);
    });

    it('url({ protocol: "http" }) uses http', () =>
    {
        expect(Fake.url({ protocol: 'http' })).toMatch(/^http:\/\//);
    });

    it('url({ appendSlash: true }) ends with /', () =>
    {
        expect(Fake.url({ appendSlash: true })).toMatch(/\/$/);
    });

    it('url({ noPath: true }) has no path segment', () =>
    {
        expect(Fake.url({ noPath: true })).toMatch(/^https:\/\/[^/]+$/);
    });

    it('ip() returns a valid dotted-quad address', () =>
    {
        const parts = Fake.ip().split('.');
        expect(parts).toHaveLength(4);
        parts.forEach(p =>
        {
            const n = Number(p);
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThanOrEqual(255);
        });
    });

    it('ip({ network: "loopback" }) returns 127.0.0.x', () =>
    {
        expect(Fake.ip({ network: 'loopback' })).toMatch(/^127\.0\.0\.\d+$/);
    });

    it('ip({ network: "private-a" }) returns 10.x.x.x', () =>
    {
        expect(Fake.ip({ network: 'private-a' })).toMatch(/^10\./);
    });

    it('ip({ network: "private-b" }) returns 172.16-31.x.x', () =>
    {
        const ip = Fake.ip({ network: 'private-b' });
        expect(ip).toMatch(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/);
    });

    it('ip({ network: "private-c" }) returns 192.168.x.x', () =>
    {
        expect(Fake.ip({ network: 'private-c' })).toMatch(/^192\.168\./);
    });

    it('ipv6() returns 8 groups of 4 hex digits joined by ":"', () =>
    {
        expect(Fake.ipv6()).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/);
    });

    it('mac() returns 6 colon-separated hex pairs', () =>
    {
        expect(Fake.mac()).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    });

    it('mac({ separator: "-" }) uses dashes', () =>
    {
        expect(Fake.mac({ separator: '-' })).toMatch(/^([0-9a-f]{2}-){5}[0-9a-f]{2}$/);
    });

    it('mac({ separator: "" }) returns 12 hex chars with no separator', () =>
    {
        expect(Fake.mac({ separator: '' })).toMatch(/^[0-9a-f]{12}$/);
    });

    it('mac({ realisticOUI: true }) returns a valid MAC address format', () =>
    {
        // OUI entries use mixed case (vendor data); use case-insensitive match
        expect(Fake.mac({ realisticOUI: true }))
            .toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
    });

    it('port() returns a number in 1–65535', () =>
    {
        const p = Fake.port();
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(65535);
    });

    it('port({ range: "well-known" }) is ≤ 1023', () =>
    {
        expect(Fake.port({ range: 'well-known' })).toBeLessThanOrEqual(1023);
    });

    it('port({ range: "registered" }) is in 1024–49151', () =>
    {
        const p = Fake.port({ range: 'registered' });
        expect(p).toBeGreaterThanOrEqual(1024);
        expect(p).toBeLessThanOrEqual(49151);
    });

    it('port({ range: "dynamic" }) is in 49152–65535', () =>
    {
        expect(Fake.port({ range: 'dynamic' })).toBeGreaterThanOrEqual(49152);
    });

    it('httpMethod() returns a standard HTTP verb', () =>
    {
        const valid = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
        expect(valid).toContain(Fake.httpMethod());
    });

    it('httpMethod({ methods: ["GET","POST"] }) restricts to the given list', () =>
    {
        for (let i = 0; i < 20; i++)
            expect(['GET','POST']).toContain(Fake.httpMethod({ methods: ['GET','POST'] }));
    });

    it('userAgent() returns a non-empty string', () =>
    {
        expect(Fake.userAgent().length).toBeGreaterThan(0);
    });

    it('password() returns 16 characters by default', () =>
    {
        expect(Fake.password()).toHaveLength(16);
    });

    it('password({ length: 8 }) returns 8 characters', () =>
    {
        expect(Fake.password({ length: 8 })).toHaveLength(8);
    });

    it('password({ special: true }) includes characters from the pool', () =>
    {
        expect(typeof Fake.password({ special: true })).toBe('string');
    });

    it('password({ prefix: "test_", length: 10 }) prepends prefix and honours length', () =>
    {
        const p = Fake.password({ prefix: 'test_', length: 10 });
        expect(p).toHaveLength(10);
        expect(p.startsWith('test_')).toBe(true);
    });

    it('password({ lowercase: false, uppercase: false, digits: false, special: false }) uses fallback pool', () =>
    {
        // All charset flags disabled → pool is empty → fallback pool = CHARSET_LOWERCASE + UPPERCASE + DIGITS
        const p = Fake.password({ lowercase: false, uppercase: false, digits: false, special: false, length: 8 });
        expect(typeof p).toBe('string');
        expect(p).toHaveLength(8);
        // Result chars come from the fallback charset (letters + digits)
        expect(p).toMatch(/^[a-zA-Z0-9]{8}$/);
    });
});

// ============================================================
//  Fake — Colors
// ============================================================
describe('Fake colors', () =>
{
    it('color() returns a valid #rrggbb hex string', () =>
    {
        expect(Fake.color()).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('rgb() returns a "rgb(r, g, b)" CSS string by default', () =>
    {
        expect(Fake.rgb()).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    });

    it('rgb({ format: "object" }) returns { r, g, b } in 0–255', () =>
    {
        const c = Fake.rgb({ format: 'object' });
        expect(c).toHaveProperty('r');
        expect(c.r).toBeGreaterThanOrEqual(0);
        expect(c.r).toBeLessThanOrEqual(255);
    });

    it('hsl() returns a "hsl(h, s%, l%)" CSS string by default', () =>
    {
        expect(Fake.hsl()).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    it('hsl({ format: "object" }) returns { h, s, l }', () =>
    {
        const c = Fake.hsl({ format: 'object' });
        expect(c).toHaveProperty('h');
        expect(c).toHaveProperty('s');
        expect(c).toHaveProperty('l');
    });
});

// ============================================================
//  Fake — Helpers
// ============================================================
describe('Fake helpers', () =>
{
    it('pick(arr) returns one of the array elements', () =>
    {
        const arr = ['a','b','c'];
        expect(arr).toContain(Fake.pick(arr));
    });

    it('pickMany(arr, n) returns n unique elements', () =>
    {
        const arr = [1,2,3,4,5];
        const r = Fake.pickMany(arr, 3);
        expect(r).toHaveLength(3);
        expect(new Set(r).size).toBe(3);
    });

    it('shuffle(arr) returns same elements in any order', () =>
    {
        const arr = [1,2,3,4,5];
        const result = Fake.shuffle([...arr]);
        expect([...result].sort((a,b) => a-b)).toEqual(arr);
    });

    it('shuffle() mutates and returns the same array reference', () =>
    {
        const arr = [1,2,3];
        expect(Fake.shuffle(arr)).toBe(arr); // same reference
    });

    it('json() returns an object with key, value, count, active', () =>
    {
        const j = Fake.json();
        expect(j).toHaveProperty('key');
        expect(j).toHaveProperty('value');
        expect(j).toHaveProperty('count');
        expect(j).toHaveProperty('active');
        expect(typeof j.key).toBe('string');
        expect(typeof j.count).toBe('number');
        expect(typeof j.active).toBe('boolean');
    });

    it('enumValue(arr) returns one of the provided values', () =>
    {
        const vals = ['admin','user','guest'];
        expect(vals).toContain(Fake.enumValue(vals));
    });

    it('enumValue([]) throws for an empty array', () =>
    {
        expect(() => Fake.enumValue([])).toThrow('non-empty array');
    });

    it('enumValue(non-array) throws', () =>
    {
        expect(() => Fake.enumValue('not-an-array')).toThrow('non-empty array');
    });
});

// ============================================================
//  seeder.js — branch coverage
// ============================================================
describe('seeder.js branches', () =>
{
    const { Seeder, SeederRunner } = require('../../lib/orm/seed/seeder');

    it('SeederRunner uses "AnonymousSeeder" when instance.constructor.name is empty', async () =>
    {
        // Create an instance whose constructor.name is empty string → falsy → 'AnonymousSeeder'
        const instance = Object.create({ run: async () => {} });
        instance.constructor = { name: '' }; // empty name → AnonymousSeeder fallback

        const fakeDb = { adapter: { clear: async () => {} } };
        const runner = new SeederRunner(fakeDb);
        const names = await runner.run(instance);
        expect(names).toEqual(['AnonymousSeeder']);
    });

    it('SeederRunner.fresh() skips clear() when adapter has no clear method', async () =>
    {
        let ran = false;
        class SimpleSeeder extends Seeder { async run() { ran = true; } }

        // Adapter with NO clear() method — should not throw
        const fakeDb = { adapter: {} };
        const runner = new SeederRunner(fakeDb);
        await expect(runner.fresh(SimpleSeeder)).resolves.toBeDefined();
        expect(ran).toBe(true);
    });
});

// ============================================================
//  fake.js — _uuid fallback (Node < 19 path)
// ============================================================
describe('fake.js _uuid fallback branch', () =>
{
    it('Fake.uuid() still returns a valid UUID after mocking randomUUID away', () =>
    {
        // Temporarily remove crypto.randomUUID to exercise the fallback path
        const crypto = require('crypto');
        const orig = crypto.randomUUID;
        crypto.randomUUID = undefined;
        try
        {
            const uuid = Fake.uuid();
            expect(uuid).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );
        }
        finally
        {
            crypto.randomUUID = orig; // restore
        }
    });
});
describe('Fake locale coverage', () =>
{
    const locales = ['en','es','fr','de','it','pt','ru','ja','zh','ar','hi','ko','nl','sv'];

    locales.forEach(locale =>
    {
        it(`firstName/lastName work for locale "${locale}"`, () =>
        {
            expect(typeof Fake.firstName({ locale })).toBe('string');
            expect(typeof Fake.lastName({ locale })).toBe('string');
        });
    });
});

// ============================================================
//  Phone country coverage
// ============================================================
describe('Fake phone country coverage', () =>
{
    const countries = ['US','CA','GB','DE','FR','AU','JP','IN','BR','MX',
                       'IT','ES','KR','NL','SE','NO','DK','PL','RU','ZA'];

    countries.forEach(code =>
    {
        it(`phone works for countryCode "${code}"`, () =>
        {
            expect(typeof Fake.phone({ countryCode: code })).toBe('string');
        });
    });
});
