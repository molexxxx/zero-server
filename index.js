const App = require('./lib/app');
const cors = require('./lib/cors');
const miniFetch = require('./lib/fetch');
const body = require('./lib/body');
const serveStatic = require('./lib/static');

module.exports = {
  createApp: () => new App(),
  cors,
  fetch: miniFetch,
  // body parsers
  json: body.json,
  urlencoded: body.urlencoded,
  text: body.text,
  raw: body.raw,
  multipart: body.multipart,
  static: serveStatic,
};
