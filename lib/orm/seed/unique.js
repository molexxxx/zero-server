'use strict';

/**
 * @module seed/unique
 * @description Per-namespace deduplication tracker used by `Fake.unique()`.
 *              Keeps a `Set` of already-returned values per key and retries
 *              the generator until a fresh value is produced.
 */

const DEFAULT_MAX_ATTEMPTS = 1000;

/**
 * Tracks generated values per namespace so callers can guarantee uniqueness
 * within a seeding session without maintaining external state.
 */
class UniqueTracker {
    constructor() {
        /** @type {Map<string, Set<any>>} */
        this._store = new Map();
    }

    /**
     * Call `fn()` repeatedly until it returns a value not yet seen under `key`.
     *
     * @param {string}   key            - Uniqueness namespace (e.g. `'email'`).
     * @param {() => any} fn            - Value generator.
     * @param {number}   [maxAttempts]  - Give up after this many retries.
     * @returns {any} The unique generated value.
     * @throws {Error} When the generator pool is exhausted.
     */
    generate(key, fn, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
        if (!this._store.has(key)) this._store.set(key, new Set());
        const seen = this._store.get(key);

        for (let i = 0; i < maxAttempts; i++) {
            const val = fn();
            if (!seen.has(val)) {
                seen.add(val);
                return val;
            }
        }

        throw new Error(
            `Fake.unique: exhausted ${maxAttempts} attempts for key "${key}". ` +
            `The data pool may be too small. Call Fake.resetUnique("${key}") to start fresh.`
        );
    }

    /**
     * Clear uniqueness tracking.
     * @param {string} [key] - Clear only this namespace, or all if omitted.
     */
    reset(key) {
        if (key !== undefined) this._store.delete(key);
        else this._store.clear();
    }

    /**
     * How many unique values have been generated for a namespace.
     * @param {string} key - Cache or storage key.
     * @returns {number} Count of unique values tracked for the key.
     */
    seen(key) {
        return this._store.has(key) ? this._store.get(key).size : 0;
    }
}

module.exports = { UniqueTracker };
