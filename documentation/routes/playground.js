const { initDatabase } = require('../config/db');
const tasksController = require('../controllers/tasks');
const cookiesController = require('../controllers/cookies');

/**
 * Register the ORM database and mount all playground API routes onto the app.
 * @param {import('../../lib/app').App} app
 */
function mountPlaygroundRoutes(app)
{
    // --- ORM setup ---
    initDatabase();

    // --- Task CRUD ---
    app.get('/api/tasks',              tasksController.list);
    app.get('/api/tasks/stats',        tasksController.stats);
    app.post('/api/tasks',             tasksController.create);
    app.put('/api/tasks/:id',          tasksController.update);
    app.delete('/api/tasks/:id',       tasksController.remove);
    app.post('/api/tasks/:id/restore', tasksController.restore);
    app.delete('/api/tasks',           tasksController.removeAll);

    // --- Cookies ---
    app.get('/api/cookies',            cookiesController.list);
    app.post('/api/cookies',           cookiesController.set);
    app.delete('/api/cookies/:name',   cookiesController.clear);
}

module.exports = mountPlaygroundRoutes;
