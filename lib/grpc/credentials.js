/**
 * @module grpc/credentials
 * @description Channel credentials for gRPC connections.
 *              Provides factory functions for creating insecure, SSL/TLS,
 *              and metadata-based credentials. Supports certificate rotation
 *              and credential composition.
 *
 *              Uses only Node.js built-in `tls` and `fs` — no external packages.
 *
 * @example | Insecure (plaintext)
 *   const { ChannelCredentials, GrpcClient } = require('zero-http');
 *   const creds = ChannelCredentials.createInsecure();
 *   const client = new GrpcClient({ address: 'http://localhost:50051', credentials: creds }, schema, 'Greeter');
 *
 * @example | Server-only TLS
 *   const creds = ChannelCredentials.createSsl(fs.readFileSync('ca.pem'));
 *
 * @example | Mutual TLS (mTLS)
 *   const creds = ChannelCredentials.createSsl(
 *       fs.readFileSync('ca.pem'),
 *       fs.readFileSync('client-key.pem'),
 *       fs.readFileSync('client-cert.pem'),
 *   );
 *
 * @example | Metadata credentials (e.g. Bearer token)
 *   const creds = ChannelCredentials.createFromMetadata((params) => ({
 *       authorization: 'Bearer ' + getToken(),
 *   }));
 *
 * @example | Composed credentials (TLS + per-call metadata)
 *   const creds = ChannelCredentials.combine(
 *       ChannelCredentials.createSsl(ca),
 *       ChannelCredentials.createFromMetadata(() => ({ authorization: 'Bearer ' + token })),
 *   );
 */

const fs = require('fs');
const log = require('../debug')('zero:grpc:credentials');

// -- Credential Types ----------------------------------------

/** @enum {string} */
const CredentialType = {
    INSECURE: 'insecure',
    SSL: 'ssl',
    METADATA: 'metadata',
    COMPOSITE: 'composite',
};

// -- ChannelCredentials Class --------------------------------

/**
 * Channel credentials define how a gRPC client authenticates to the server.
 *
 * @class
 */
class ChannelCredentials
{
    /**
     * @param {string} type - Credential type.
     * @param {object} [config] - Type-specific configuration.
     * @private
     */
    constructor(type, config = {})
    {
        /** @type {string} */
        this.type = type;
        /** @private */
        this._config = config;
    }

    /**
     * Create insecure (plaintext) credentials.
     * No TLS — suitable for development or service-mesh environments
     * where transport security is handled by the infrastructure.
     *
     * @returns {ChannelCredentials}
     */
    static createInsecure()
    {
        return new ChannelCredentials(CredentialType.INSECURE);
    }

    /**
     * Create SSL/TLS credentials.
     *
     * @param {Buffer|string|null} [rootCerts] - Root CA certificate(s) in PEM format.
     *        If null, uses the system default trust store.
     * @param {Buffer|string|null} [clientKey] - Client private key in PEM format (for mTLS).
     * @param {Buffer|string|null} [clientCert] - Client certificate in PEM format (for mTLS).
     * @param {object} [opts] - Additional options.
     * @param {boolean} [opts.rejectUnauthorized=true] - Reject connections with invalid certs.
     * @returns {ChannelCredentials}
     *
     * @example | Server-only TLS
     *   const creds = ChannelCredentials.createSsl(fs.readFileSync('ca.pem'));
     *
     * @example | Mutual TLS
     *   const creds = ChannelCredentials.createSsl(caPem, keyPem, certPem);
     */
    static createSsl(rootCerts, clientKey, clientCert, opts = {})
    {
        const config = {
            rejectUnauthorized: opts.rejectUnauthorized !== false,
        };

        if (rootCerts)
        {
            config.ca = Buffer.isBuffer(rootCerts) ? rootCerts : Buffer.from(rootCerts);
        }
        if (clientKey)
        {
            config.key = Buffer.isBuffer(clientKey) ? clientKey : Buffer.from(clientKey);
        }
        if (clientCert)
        {
            config.cert = Buffer.isBuffer(clientCert) ? clientCert : Buffer.from(clientCert);
        }

        if (config.key && !config.cert)
            throw new Error('Client key provided without client certificate');
        if (config.cert && !config.key)
            throw new Error('Client certificate provided without client key');

        return new ChannelCredentials(CredentialType.SSL, config);
    }

    /**
     * Create SSL credentials from PEM file paths.
     * Files are read once at creation time.
     *
     * @param {string|null} [caPath] - Path to CA certificate file.
     * @param {string|null} [keyPath] - Path to client key file.
     * @param {string|null} [certPath] - Path to client certificate file.
     * @param {object} [opts] - Additional options.
     * @returns {ChannelCredentials}
     *
     * @example
     *   const creds = ChannelCredentials.createSslFromFiles('./certs/ca.pem', './certs/client.key', './certs/client.pem');
     */
    static createSslFromFiles(caPath, keyPath, certPath, opts = {})
    {
        const ca = caPath ? fs.readFileSync(caPath) : null;
        const key = keyPath ? fs.readFileSync(keyPath) : null;
        const cert = certPath ? fs.readFileSync(certPath) : null;
        return ChannelCredentials.createSsl(ca, key, cert, opts);
    }

    /**
     * Create per-call metadata credentials.
     * The generator function is called before each RPC to produce
     * metadata headers (e.g. authorization tokens).
     *
     * @param {Function} metadataGenerator - `(params?) => object|Promise<object>`.
     *        Returns key-value pairs to merge into call metadata.
     *        `params` includes `{ serviceUrl, methodName }`.
     * @returns {ChannelCredentials}
     *
     * @example
     *   const creds = ChannelCredentials.createFromMetadata(async () => ({
     *       authorization: 'Bearer ' + await getAccessToken(),
     *   }));
     */
    static createFromMetadata(metadataGenerator)
    {
        if (typeof metadataGenerator !== 'function')
            throw new Error('createFromMetadata requires a function');

        return new ChannelCredentials(CredentialType.METADATA, {
            generator: metadataGenerator,
        });
    }

    /**
     * Combine multiple credentials into one.
     * At most one channel credential (insecure/SSL) and any number
     * of call credentials (metadata) can be combined.
     *
     * @param {...ChannelCredentials} credentials - Credentials to combine.
     * @returns {ChannelCredentials}
     *
     * @example
     *   const creds = ChannelCredentials.combine(
     *       ChannelCredentials.createSsl(ca),
     *       ChannelCredentials.createFromMetadata(() => ({ 'x-api-key': apiKey })),
     *       ChannelCredentials.createFromMetadata(async () => ({ authorization: 'Bearer ' + token })),
     *   );
     */
    static combine(...credentials)
    {
        let channelCred = null;
        const metadataGens = [];

        for (const cred of credentials)
        {
            if (!(cred instanceof ChannelCredentials))
                throw new Error('combine() arguments must be ChannelCredentials instances');

            if (cred.type === CredentialType.COMPOSITE)
            {
                // Flatten nested composites
                if (cred._config.channelCred) channelCred = cred._config.channelCred;
                metadataGens.push(...cred._config.metadataGenerators);
            }
            else if (cred.type === CredentialType.INSECURE || cred.type === CredentialType.SSL)
            {
                if (channelCred)
                    throw new Error('Cannot combine multiple channel credentials (use at most one insecure/SSL)');
                channelCred = cred;
            }
            else if (cred.type === CredentialType.METADATA)
            {
                metadataGens.push(cred._config.generator);
            }
        }

        return new ChannelCredentials(CredentialType.COMPOSITE, {
            channelCred,
            metadataGenerators: metadataGens,
        });
    }

    /**
     * Whether this credential uses TLS.
     * @returns {boolean}
     */
    isSecure()
    {
        if (this.type === CredentialType.INSECURE) return false;
        if (this.type === CredentialType.SSL) return true;
        if (this.type === CredentialType.METADATA) return false;
        if (this.type === CredentialType.COMPOSITE)
        {
            const ch = this._config.channelCred;
            return ch ? ch.isSecure() : false;
        }
        return false;
    }

    /**
     * Get the TLS connection options for `http2.connect()`.
     * Returns `null` for insecure/metadata-only credentials.
     *
     * @returns {object|null} TLS options `{ ca, key, cert, rejectUnauthorized }`.
     */
    getConnectionOptions()
    {
        if (this.type === CredentialType.SSL)
        {
            const opts = {};
            if (this._config.ca) opts.ca = this._config.ca;
            if (this._config.key) opts.key = this._config.key;
            if (this._config.cert) opts.cert = this._config.cert;
            opts.rejectUnauthorized = this._config.rejectUnauthorized;
            return opts;
        }

        if (this.type === CredentialType.COMPOSITE && this._config.channelCred)
        {
            return this._config.channelCred.getConnectionOptions();
        }

        return null;
    }

    /**
     * Generate per-call metadata by running all metadata generators.
     *
     * @param {object} [params] - Call parameters `{ serviceUrl, methodName }`.
     * @returns {Promise<object>} Merged metadata key-value pairs.
     */
    async generateMetadata(params)
    {
        const generators = [];

        if (this.type === CredentialType.METADATA)
        {
            generators.push(this._config.generator);
        }
        else if (this.type === CredentialType.COMPOSITE)
        {
            generators.push(...this._config.metadataGenerators);
        }

        if (generators.length === 0) return {};

        const merged = {};
        for (const gen of generators)
        {
            const md = await gen(params);
            if (md && typeof md === 'object')
            {
                Object.assign(merged, md);
            }
        }

        return merged;
    }
}

// -- Certificate Rotation Helper ---------------------------------

/**
 * Create SSL credentials with automatic certificate rotation.
 * Watches certificate files for changes and reloads them.
 *
 * Returns a credentials-like object with `getCurrent()` to get
 * the latest credentials and `stop()` to cease watching.
 *
 * @param {object} opts - Options.
 * @param {string} opts.caPath - Path to CA certificate file.
 * @param {string} [opts.keyPath] - Path to client key file (for mTLS).
 * @param {string} [opts.certPath] - Path to client certificate file (for mTLS).
 * @param {number} [opts.pollInterval=30000] - Check interval in ms (default 30s).
 * @param {object} [opts.sslOpts] - Additional SSL options.
 * @returns {{ getCurrent: () => ChannelCredentials, stop: () => void }}
 *
 * @example
 *   const rotating = createRotatingCredentials({
 *       caPath: '/certs/ca.pem',
 *       keyPath: '/certs/client.key',
 *       certPath: '/certs/client.pem',
 *   });
 *   // Use rotating.getCurrent() when creating clients
 *   const client = new GrpcClient({ address, credentials: rotating.getCurrent() }, schema, service);
 *   // Stop watching on shutdown
 *   rotating.stop();
 */
function createRotatingCredentials(opts)
{
    if (!opts || !opts.caPath)
        throw new Error('createRotatingCredentials requires caPath');

    let current = ChannelCredentials.createSslFromFiles(
        opts.caPath, opts.keyPath || null, opts.certPath || null, opts.sslOpts || {}
    );

    /** @private */ let lastMtimes = _getMtimes(opts);

    const timer = setInterval(() =>
    {
        try
        {
            const mtimes = _getMtimes(opts);
            if (mtimes.ca !== lastMtimes.ca ||
                mtimes.key !== lastMtimes.key ||
                mtimes.cert !== lastMtimes.cert)
            {
                current = ChannelCredentials.createSslFromFiles(
                    opts.caPath, opts.keyPath || null, opts.certPath || null, opts.sslOpts || {}
                );
                lastMtimes = mtimes;
                log.info('SSL credentials rotated');
            }
        }
        catch (err)
        {
            log.error('credential rotation check failed: %s', err.message);
        }
    }, opts.pollInterval || 30000);

    if (timer.unref) timer.unref();

    return {
        getCurrent() { return current; },
        stop() { clearInterval(timer); },
    };
}

/**
 * Get file modification times.
 * @private
 */
function _getMtimes(opts)
{
    return {
        ca: opts.caPath ? _safeMtime(opts.caPath) : 0,
        key: opts.keyPath ? _safeMtime(opts.keyPath) : 0,
        cert: opts.certPath ? _safeMtime(opts.certPath) : 0,
    };
}

/**
 * @private
 */
function _safeMtime(filePath)
{
    try { return fs.statSync(filePath).mtimeMs; }
    catch (_) { return 0; }
}

// -- Exports -------------------------------------------------

module.exports = {
    ChannelCredentials,
    CredentialType,
    createRotatingCredentials,
};
