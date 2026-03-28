const path = require('path');
const { Database } = require('../..');
const Task = require('../models/Task');

/**
 * Connect to the database, register all models, and sync tables.
 * Uses SQLite with a Database/ folder for file‑based persistence.
 * Returns the Database instance for reuse.
 */
function initDatabase()
{
    const db = Database.connect('sqlite', {
        filename: path.join(__dirname, '..', 'Database', 'tasks.db'),
    });

    // Register models
    db.register(Task);

    // Sync tables (non-blocking)
    db.sync().then(() => console.log('ORM: SQLite tasks.db ready'));

    return db;
}

module.exports = { initDatabase };
