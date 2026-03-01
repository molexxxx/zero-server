/**
 * @module ws
 * @description WebSocket support for zero-http.
 *              Exports the connection class and upgrade handler.
 */
const WebSocketConnection = require('./connection');
const handleUpgrade = require('./handshake');

module.exports = {
    WebSocketConnection,
    handleUpgrade,
};
