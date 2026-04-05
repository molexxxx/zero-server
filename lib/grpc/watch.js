/**
 * @module grpc/watch
 * @description Proto file hot-reload for development.
 *              Watches `.proto` files for changes using `fs.watch()` and
 *              re-parses/re-registers gRPC services automatically.
 *
 *              **Dev-only** — disabled by default when `NODE_ENV=production`.
 *
 * @example
 *   const { createApp, watchProto } = require('zero-http');
 *   const app = createApp();
 *
 *   watchProto(app, './protos/greeter.proto', 'Greeter', handlers, {
 *       onReload: (schema) => console.log('Reloaded!'),
 *   });
 *
 *   app.listen(50051, { http2: true });
 */

const fs = require('fs');
const path = require('path');
const log = require('../debug')('zero:grpc:watch');

// Lazy-load proto parser
let _parseProtoFile = null;
function _getParser()
{
    if (!_parseProtoFile) _parseProtoFile = require('./proto').parseProtoFile;
    return _parseProtoFile;
}

// -- Constants ---------------------------------------------------

const DEFAULT_DEBOUNCE = 300; // ms

// -- watchProto --------------------------------------------------

/**
 * Watch a `.proto` file and hot-reload the gRPC service on changes.
 * Parses the file, registers the service, then watches for modifications.
 *
 * Disabled in production unless `opts.production` is `true`.
 *
 * @param {object} app - The zero-http App instance.
 * @param {string} protoPath - Path to the `.proto` file.
 * @param {string} serviceName - Service name to register.
 * @param {Object<string, Function>} handlers - Method handlers map.
 * @param {object} [opts] - Options.
 * @param {Function[]} [opts.interceptors] - Per-service interceptors.
 * @param {number} [opts.maxMessageSize] - Max incoming message size.
 * @param {boolean} [opts.compress=false] - Compress outgoing messages.
 * @param {number} [opts.debounce=300] - Debounce interval in ms.
 * @param {boolean} [opts.production=false] - Allow in production.
 * @param {Function} [opts.onReload] - `(schema) => void` callback after reload.
 * @param {Function} [opts.onError] - `(err) => void` callback on parse/reload error.
 * @returns {{ stop: () => void, schema: object }} Controller with `stop()` and current schema.
 *
 * @example
 *   const watcher = watchProto(app, './hello.proto', 'Greeter', {
 *       SayHello(call) { return { message: 'Hello ' + call.request.name }; },
 *   });
 *   // Later: watcher.stop();
 */
function watchProto(app, protoPath, serviceName, handlers, opts = {})
{
    if (!opts.production && process.env.NODE_ENV === 'production')
    {
        log.warn('watchProto disabled in production (set { production: true } to override)');
        // Still do an initial load
        const parseProtoFile = _getParser();
        const schema = parseProtoFile(protoPath);
        app.grpc(schema, serviceName, handlers, opts);
        return { stop() {}, schema };
    }

    const debounceMs = opts.debounce || DEFAULT_DEBOUNCE;
    const resolvedPath = path.resolve(protoPath);

    const parseProtoFile = _getParser();
    let currentSchema = null;

    // Initial load
    try
    {
        currentSchema = parseProtoFile(resolvedPath);
        app.grpc(currentSchema, serviceName, handlers, opts);
        log.info('proto loaded: %s → %s', resolvedPath, serviceName);
    }
    catch (err)
    {
        log.error('initial proto parse failed: %s', err.message);
        if (typeof opts.onError === 'function') opts.onError(err);
        else throw err;
    }

    // Debounced reload
    let debounceTimer = null;

    function _reload()
    {
        try
        {
            const schema = parseProtoFile(resolvedPath);

            // Verify the service still exists in the schema
            if (!schema.services[serviceName])
            {
                const err = new Error(`Service "${serviceName}" not found after reload`);
                log.error(err.message);
                if (typeof opts.onError === 'function') opts.onError(err);
                return;
            }

            // Re-register: the grpc registry replaces the existing service entry
            if (app._grpcRegistry)
            {
                app._grpcRegistry.addService(schema, serviceName, handlers, opts);
            }

            currentSchema = schema;
            log.info('proto reloaded: %s', resolvedPath);

            if (typeof opts.onReload === 'function') opts.onReload(schema);
        }
        catch (err)
        {
            log.error('proto reload failed: %s', err.message);
            if (typeof opts.onError === 'function') opts.onError(err);
        }
    }

    // Watch the file
    let watcher;
    try
    {
        watcher = fs.watch(resolvedPath, (eventType) =>
        {
            if (eventType !== 'change') return;

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(_reload, debounceMs);
        });

        watcher.on('error', (err) =>
        {
            log.error('fs.watch error: %s', err.message);
            if (typeof opts.onError === 'function') opts.onError(err);
        });

        log.info('watching proto file: %s', resolvedPath);
    }
    catch (err)
    {
        log.error('failed to watch proto file: %s', err.message);
        if (typeof opts.onError === 'function') opts.onError(err);
    }

    return {
        stop()
        {
            if (debounceTimer) clearTimeout(debounceTimer);
            if (watcher) watcher.close();
            log.info('stopped watching: %s', resolvedPath);
        },
        get schema() { return currentSchema; },
    };
}

// -- Exports -------------------------------------------------

module.exports = {
    watchProto,
};
