/**
 * @module ws
 * @description WebSocket support for zero-http.
 *              Exports the connection class, upgrade handler, and pool manager.
 */
const WebSocketConnection = require('./connection');
const handleUpgrade = require('./handshake');
const WebSocketPool = require('./room');

module.exports = {
    WebSocketConnection,
    handleUpgrade,
    WebSocketPool,
};
