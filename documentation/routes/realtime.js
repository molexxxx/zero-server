const { WebSocketPool } = require('../..');

/**
 * Mount WebSocket and SSE real-time routes.
 */
function mountRealtimeRoutes(app)
{
    // --- WebSocket Chat ---
    const pool = new WebSocketPool();

    app.ws('/ws/chat', { maxPayload: 64 * 1024, pingInterval: 25000 }, (ws, req) =>
    {
        ws.data.name = ws.query.name || 'anon';
        pool.add(ws);
        ws.send(JSON.stringify({ type: 'system', text: 'Welcome, ' + ws.data.name + '!' }));
        pool.broadcast(JSON.stringify({ type: 'system', text: ws.data.name + ' joined' }), ws);

        ws.on('message', (msg) =>
        {
            pool.broadcastJSON({ type: 'message', name: ws.data.name, text: String(msg) });
        });

        ws.on('close', () =>
        {
            pool.remove(ws);
            pool.broadcastJSON({ type: 'system', text: ws.data.name + ' left' });
        });
    });

    // --- Server-Sent Events ---
    const sseClients = new Set();

    app.get('/sse/events', (req, res) =>
    {
        const sse = res.sse({ retry: 5000, autoId: true, keepAlive: 30000 });
        sseClients.add(sse);
        sse.send({ type: 'connected', clients: sseClients.size });
        sse.on('close', () => sseClients.delete(sse));
    });

    app.post('/sse/broadcast', (req, res) =>
    {
        const data = req.body || {};
        for (const sse of sseClients) sse.event('broadcast', data);
        res.json({ sent: sseClients.size });
    });
}

module.exports = mountRealtimeRoutes;
