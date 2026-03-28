const { raw } = require('../..');
const rootController    = require('../controllers/root');
const headersController = require('../controllers/headers');
const echoController    = require('../controllers/echo');

/**
 * Mount core routes: root, headers, echo parsers.
 */
function mountCoreRoutes(app)
{
    app.get('/',                rootController.getRoot);
    app.get('/headers',         headersController.getHeaders);
    app.post('/echo-json',      echoController.echoJson);
    app.post('/echo',           echoController.echo);
    app.post('/echo-urlencoded', echoController.echoUrlencoded);
    app.post('/echo-text',      echoController.echoText);
    app.post('/echo-raw',       raw(), echoController.echoRaw);
}

module.exports = mountCoreRoutes;
