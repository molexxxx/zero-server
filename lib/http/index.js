/**
 * @module http
 * @description HTTP request/response wrappers for zero-http.
 *              Exports Request and Response classes.
 */
const Request = require('./request');
const { compileTrust } = require('./request');
const Response = require('./response');

module.exports = { Request, Response, compileTrust };
