const fs = require('fs');

const CERT_PATH = '/www/server/panel/vhost/cert/z-http.com/fullchain.pem';
const KEY_PATH  = '/www/server/panel/vhost/cert/z-http.com/privkey.pem';

const hasCerts = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);

const tlsOpts = hasCerts
    ? { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }
    : undefined;

module.exports = { hasCerts, tlsOpts };
