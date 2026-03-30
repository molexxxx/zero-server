const { validate } = require('../..');
const { initDatabase } = require('../config/db');
const tasksController = require('../controllers/tasks');
const cookiesController = require('../controllers/cookies');
const blogController = require('../controllers/blog');

/**
 * Register the ORM database and mount all playground API routes onto the app.
 * @param {import('../../lib/app').App} app
 */
function mountPlaygroundRoutes(app)
{
    // --- ORM setup ---
    initDatabase();

    // --- Task CRUD ---
    const taskBody = validate({
        body: {
            title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
            status:   { type: 'string', enum: ['pending', 'in-progress', 'done'] },
            priority: { type: 'integer', min: 0, max: 5 },
        },
    });
    app.get('/api/tasks',              tasksController.list);
    app.get('/api/tasks/stats',        tasksController.stats);
    app.post('/api/tasks',             taskBody, tasksController.create);
    app.put('/api/tasks/:id',          tasksController.update);
    app.delete('/api/tasks/:id',       tasksController.remove);
    app.post('/api/tasks/:id/restore', tasksController.restore);
    app.delete('/api/tasks',           tasksController.removeAll);

    // --- Blog Explorer ---
    const authorBody = validate({
        body: {
            name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
            email: { type: 'email', required: true },
            bio:   { type: 'string', maxLength: 500 },
            role:  { type: 'string', enum: ['author', 'editor', 'admin'] },
        },
    });
    const postBody = validate({
        body: {
            authorId: { type: 'integer', required: true },
            title:    { type: 'string', required: true, minLength: 1, maxLength: 200 },
            body:     { type: 'string', required: true, minLength: 1, maxLength: 5000 },
            status:   { type: 'string', enum: ['draft', 'published', 'archived'] },
            category: { type: 'string', enum: ['general', 'tech', 'lifestyle', 'news'] },
        },
    });
    app.get('/api/blog/authors',            blogController.listAuthors);
    app.post('/api/blog/authors',           authorBody, blogController.createAuthor);
    app.delete('/api/blog/authors/:id',     blogController.deleteAuthor);
    app.get('/api/blog/posts',              blogController.listPosts);
    app.post('/api/blog/posts',             postBody, blogController.createPost);
    app.put('/api/blog/posts/:id',          blogController.updatePost);
    app.delete('/api/blog/posts/:id',       blogController.deletePost);
    app.post('/api/blog/posts/:id/restore', blogController.restorePost);
    app.post('/api/blog/posts/:id/view',    blogController.incrementViews);
    app.get('/api/blog/stats',              blogController.blogStats);
    app.post('/api/blog/seed',              blogController.seed);
    app.post('/api/blog/reset',             blogController.reset);

    // --- Cookies ---
    const cookieBody = validate({
        body: {
            name:  { type: 'string', required: true, minLength: 1, maxLength: 64 },
            value: { type: 'string', required: true, maxLength: 4096 },
        },
    });
    app.get('/api/cookies',            cookiesController.list);
    app.post('/api/cookies',           cookieBody, cookiesController.set);
    app.delete('/api/cookies/:name',   cookiesController.clear);
}

module.exports = mountPlaygroundRoutes;
