'use strict';

/**
 * @module seed/rng
 * @description Seeded PRNG (mulberry32) for reproducible fake data generation.
 *              When no seed is set, falls back to Math.random so default
 *              behaviour is indistinguishable from the original implementation.
 *
 * @example
 *   const { seed, rand } = require('./rng');
 *   seed(42);           // deterministic from here on
 *   rand();             // always the same sequence for seed 42
 *   seed(null);         // back to crypto-quality Math.random
 */

/**
 * mulberry32 — minimal, high-quality 32-bit PRNG.
 * @param {number} s - Unsigned 32-bit integer seed.
 * @returns {() => number} Float in [0, 1).
 */
function _mulberry32(s) {
    s = s >>> 0;
    return function () {
        s += 0x6D2B79F5;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** FNV-1a string → unsigned 32-bit integer. */
function _hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

let _rng  = Math.random.bind(Math);
let _seed = null;

/** Return a random float in [0, 1). */
function rand() { return _rng(); }

/**
 * Set a deterministic seed.  Pass `null` / `undefined` to reset to Math.random.
 *
 * @param {number|string|null} [value]
 * @returns {number|null} The numeric seed that was applied (or null if reset).
 */
function seed(value) {
    if (value === undefined || value === null) {
        _rng  = Math.random.bind(Math);
        _seed = null;
    } else {
        const n = typeof value === 'number'
            ? (value >>> 0)
            : _hashString(String(value));
        _seed = n;
        _rng  = _mulberry32(n);
    }
    return _seed;
}

/** @returns {number|null} Active numeric seed, or null when using Math.random. */
function getSeed() { return _seed; }

module.exports = { rand, seed, getSeed };
