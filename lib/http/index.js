/**
 * @module http
 * @description HTTP request/response wrappers for zero-server.
 *              Exports Request and Response classes.
 */
const Request = require('./request');
const Response = require('./response');

module.exports = { Request, Response };
