const fs = require('fs');

/**
 * Resolve TLS certificate paths from environment variables.
 * Falls back to HTTP when certs are missing or unreadable.
 */
const certPath = process.env.TLS_CERT || '';
const keyPath  = process.env.TLS_KEY  || '';

let hasCerts = false;
let tlsOpts;

if (certPath && keyPath)
{
    try
    {
        if (fs.existsSync(certPath) && fs.existsSync(keyPath))
        {
            tlsOpts = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
            hasCerts = true;
        }
    }
    catch (e)
    {
        console.warn('TLS: could not load certificates, falling back to HTTP —', e.message);
    }
}

module.exports = { hasCerts, tlsOpts };
