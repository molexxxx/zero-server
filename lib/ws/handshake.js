/**
 * @module ws/handshake
 * @description WebSocket upgrade handshake logic (RFC 6455).
 *              Handles the HTTP → WS upgrade, verifyClient, sub-protocol
 *              negotiation, query parsing, and instantiation of a
 *              `WebSocketConnection`.
 */
const crypto = require('crypto');
const WebSocketConnection = require('./connection');
const log = require('../debug')('zero:ws');

/** RFC 6455 magic GUID used in the Sec-WebSocket-Accept hash. */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Handle an HTTP upgrade request and turn it into a WebSocket connection.
 *
 * @param {import('http').IncomingMessage} req    - The upgrade request.
 * @param {import('net').Socket}           socket - The underlying TCP socket.
 * @param {Buffer}                         head   - First packet of the upgraded stream.
 * @param {Map<string, { handler: Function, opts: object }>} wsHandlers - Registered WS path→handler map.
 */
function handleUpgrade(req, socket, head, wsHandlers)
{
    // Guard against socket errors (e.g. ECONNRESET from restricted webviews)
    socket.on('error', () => {});

    const urlPath = req.url.split('?')[0];
    const entry = wsHandlers.get(urlPath);

    if (!entry)
    {
        log.warn('no WS handler for %s', urlPath);
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    const { handler, opts } = entry;

    // -- Optional client verification ------------------
    if (typeof opts.verifyClient === 'function')
    {
        try
        {
            if (!opts.verifyClient(req))
            {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        catch (e)
        {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
            return;
        }
    }

    // -- Validate key ----------------------------------
    const key = req.headers['sec-websocket-key'];
    if (!key)
    {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    // -- Negotiate sub-protocol ------------------------
    const clientProtocols = req.headers['sec-websocket-protocol'];
    const extensions = req.headers['sec-websocket-extensions'] || '';

    // -- Perform the WebSocket handshake (RFC 6455) ----
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');

    let handshake =
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n';

    // Echo first requested protocol if any
    const protocol = clientProtocols ? clientProtocols.split(',')[0].trim() : '';
    if (protocol) handshake += 'Sec-WebSocket-Protocol: ' + protocol + '\r\n';

    handshake += '\r\n';
    socket.write(handshake);
    log.info('upgrade complete for %s', urlPath);

    // -- Parse query string ----------------------------
    const qIdx = req.url.indexOf('?');
    const query = {};
    if (qIdx !== -1)
    {
        for (const [k, v] of new URLSearchParams(req.url.slice(qIdx + 1)))
        {
            query[k] = v;
        }
    }

    // -- Create the connection wrapper -----------------
    const ws = new WebSocketConnection(socket, {
        maxPayload: opts.maxPayload,
        pingInterval: opts.pingInterval,
        protocol,
        extensions,
        headers: req.headers,
        ip: req.socket ? req.socket.remoteAddress : null,
        query,
        url: req.url,
        secure: !!(req.socket && req.socket.encrypted),
    });

    try
    {
        handler(ws, req);
    }
    catch (err)
    {
        ws.close(1011, 'Internal error');
    }
}

module.exports = handleUpgrade;
