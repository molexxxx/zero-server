const { Router, validate, fetch, version } = require('../..');
const proxyController = require('../controllers/proxy');

/**
 * Mount the /api sub-router, validation demo, proxy, and debug routes.
 */
function mountApiRoutes(app)
{
    // --- Router Demo (sub-app) ---
    const apiRouter = Router();
    apiRouter.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
    apiRouter.get('/info', (req, res) => res.json({
        secure: req.secure,
        protocol: req.protocol,
        ip: req.ip,
        method: req.method,
        url: req.url,
    }));
    apiRouter.get('/version', (req, res) => res.json({ version }));
    app.use('/api', apiRouter);

    // --- Validation Demo ---
    app.post('/demo/validate', validate({
        body: {
            name: { type: 'string', required: true, min: 1, max: 100 },
            age:  { type: 'number', min: 0, max: 150 },
        },
    }), (req, res) => res.json({ ok: true, data: req.body }));

    // --- Proxy ---
    const proxyFetch = (typeof globalThis !== 'undefined' && globalThis.fetch) || fetch;
    app.get('/proxy', proxyController.proxy(proxyFetch));

    // --- Route introspection ---
    app.get('/debug/routes', (req, res) =>
    {
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify(app.routes(), null, 2));
    });
}

module.exports = mountApiRoutes;
