const path = require('path');
const { Database } = require('../..');
const Task = require('../models/Task');
const Author = require('../models/Author');
const Post = require('../models/Post');

/**
 * Connect to the database, register all models, and sync tables.
 * Uses SQLite with a Database/ folder for file‑based persistence.
 * All playground models share a single database file.
 * Returns the Database instance for reuse.
 */
function initDatabase()
{
    const db = Database.connect('sqlite', {
        filename: path.join(__dirname, '..', 'Database', 'playground.db'),
    });

    // Register models
    db.register(Task);
    db.register(Author);
    db.register(Post);

    // Sync tables (non-blocking)
    db.sync().then(() => console.log('ORM: SQLite playground.db ready'));

    return db;
}

module.exports = { initDatabase };
