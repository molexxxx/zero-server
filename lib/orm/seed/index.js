'use strict';

/**
 * @module seed/index
 * @description Public API for the seed subsystem.
 *
 * Re-exports:
 *   - `Fake`         — static fake-data generator
 *   - `Factory`      — model factory for defining / creating test fixtures
 *   - `Seeder`       — base class for database seeders
 *   - `SeederRunner` — orchestrates running multiple seeders
 */

const { Fake }                   = require('./fake');
const { Factory }                = require('./factory');
const { Seeder, SeederRunner }   = require('./seeder');

module.exports = { Fake, Factory, Seeder, SeederRunner };
