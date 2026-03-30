/**
 * @module debug
 * @description Lightweight namespaced debug logger with levels, colors, and timestamps.
 *              Enable via DEBUG env variable: DEBUG=app:*,router (supports glob patterns).
 *              Each namespace gets a unique color for easy visual scanning.
 *
 * Levels: trace (0), debug (1), info (2), warn (3), error (4), fatal (5), silent (6).
 * Set level via DEBUG_LEVEL env var or programmatically.
 *
 * @example
 *   const debug = require('zero-http').debug;
 *   const log = debug('app:routes');
 *   log.info('server started on port %d', 3000);
 *   log.error('failed to connect', err);
 *   log('shorthand for debug level');
 */

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 };
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_COLORS = ['\x1b[2m', '\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[35;1m'];

// Namespace colors (rotate through these)
const NS_COLORS = [
    '\x1b[36m', '\x1b[33m', '\x1b[32m', '\x1b[35m', '\x1b[34m',
    '\x1b[36;1m', '\x1b[33;1m', '\x1b[32;1m', '\x1b[35;1m', '\x1b[34;1m',
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

let _colorIdx = 0;
const _nsColorMap = new Map();

/**
 * Global state
 */
let _globalLevel = LEVELS[process.env.DEBUG_LEVEL] !== undefined
    ? LEVELS[process.env.DEBUG_LEVEL]
    : LEVELS.debug;

let _enabledPatterns = null;
let _output = process.stdout;
let _outputCustom = false;
let _useColors = process.stdout.isTTY || false;
let _timestamps = true;
let _jsonMode = false;

/**
 * Parse DEBUG env var into patterns.
 */
function _parsePatterns()
{
    const raw = process.env.DEBUG;
    if (!raw) return null;
    return raw.split(/[\s,]+/).filter(Boolean).map(p =>
    {
        const neg = p.startsWith('-');
        const pat = neg ? p.slice(1) : p;
        // Convert glob to regex: * => .*, ? => .
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return { neg, re };
    });
}

_enabledPatterns = _parsePatterns();

/**
 * Check if a namespace is enabled.
 * @param {string} ns
 * @returns {boolean}
 */
function _isEnabled(ns)
{
    if (!_enabledPatterns) return true; // No DEBUG set — enable all
    let enabled = false;
    for (const { neg, re } of _enabledPatterns)
    {
        if (re.test(ns)) enabled = !neg;
    }
    return enabled;
}

/**
 * Get a color for a namespace.
 */
function _nsColor(ns)
{
    if (!_nsColorMap.has(ns))
    {
        _nsColorMap.set(ns, NS_COLORS[_colorIdx % NS_COLORS.length]);
        _colorIdx++;
    }
    return _nsColorMap.get(ns);
}

/**
 * Format a timestamp.
 */
function _ts()
{
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Format arguments (like console.log — supports %s, %d, %j, %o).
 */
function _format(args)
{
    if (args.length === 0) return '';
    if (typeof args[0] === 'string' && args.length > 1)
    {
        let i = 1;
        const str = args[0].replace(/%([sdjo%])/g, (_, f) =>
        {
            if (f === '%') return '%';
            if (i >= args.length) return `%${f}`;
            const v = args[i++];
            if (f === 's') return String(v);
            if (f === 'd') return Number(v);
            if (f === 'j' || f === 'o')
            {
                try { return JSON.stringify(v); }
                catch { return String(v); }
            }
            return String(v);
        });
        const rest = args.slice(i).map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
        );
        return rest.length > 0 ? str + ' ' + rest.join(' ') : str;
    }
    return args.map(a =>
    {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object')
        {
            try { return JSON.stringify(a); }
            catch { return String(a); }
        }
        return String(a);
    }).join(' ');
}

/**
 * Write a log entry.
 */
function _write(ns, level, args)
{
    const msg = _format(args);
    const out = (_outputCustom || level < LEVELS.warn) ? _output : process.stderr;

    if (_jsonMode)
    {
        const entry = {
            timestamp: new Date().toISOString(),
            level: LEVEL_NAMES[level],
            namespace: ns,
            message: msg,
        };
        // If last arg is an Error, attach stack
        const last = args[args.length - 1];
        if (last instanceof Error)
        {
            entry.error = { message: last.message, stack: last.stack, code: last.code };
        }
        out.write(JSON.stringify(entry) + '\n');
        return;
    }

    // Pretty text output
    const parts = [];
    if (_timestamps)
    {
        parts.push(_useColors ? `${DIM}${_ts()}${RESET}` : _ts());
    }
    // Level
    const lvlName = LEVEL_NAMES[level];
    if (_useColors)
    {
        parts.push(`${LEVEL_COLORS[level]}${lvlName.padEnd(5)}${RESET}`);
    }
    else
    {
        parts.push(lvlName.padEnd(5));
    }
    // Namespace
    if (_useColors)
    {
        parts.push(`${_nsColor(ns)}${ns}${RESET}`);
    }
    else
    {
        parts.push(ns);
    }
    parts.push(msg);

    out.write(parts.join(' ') + '\n');
}

/**
 * Create a namespaced debug logger.
 *
 * @param {string} namespace - Logger namespace (e.g. 'app:routes', 'db:queries').
 * @returns {Function & { trace, debug, info, warn, error, fatal, enabled }} Logger function.
 */
function debug(namespace)
{
    const enabled = _isEnabled(namespace);

    // Default call = debug level
    const logger = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.debug) return;
        _write(namespace, LEVELS.debug, args);
    };

    logger.trace = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.trace) return;
        _write(namespace, LEVELS.trace, args);
    };

    logger.debug = logger;

    logger.info = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.info) return;
        _write(namespace, LEVELS.info, args);
    };

    logger.warn = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.warn) return;
        _write(namespace, LEVELS.warn, args);
    };

    logger.error = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.error) return;
        _write(namespace, LEVELS.error, args);
    };

    logger.fatal = (...args) =>
    {
        if (!enabled || _globalLevel > LEVELS.fatal) return;
        _write(namespace, LEVELS.fatal, args);
    };

    /** Whether this namespace is active. */
    logger.enabled = enabled;

    /** The namespace string */
    logger.namespace = namespace;

    return logger;
}

// --- Configuration API -------------------------------------------

/**
 * Set the minimum log level globally.
 * @param {string|number} level - Level name or number.
 */
debug.level = function(level)
{
    if (typeof level === 'string') _globalLevel = LEVELS[level.toLowerCase()] ?? LEVELS.debug;
    else _globalLevel = level;
};

/**
 * Enable/disable namespaces programmatically (same syntax as DEBUG env var).
 * @param {string} patterns - Comma-separated patterns. Use '-ns' to exclude.
 */
debug.enable = function(patterns)
{
    process.env.DEBUG = patterns;
    _enabledPatterns = _parsePatterns();
};

/**
 * Disable all debug output.
 */
debug.disable = function()
{
    process.env.DEBUG = '';
    _enabledPatterns = [{ neg: false, re: /^$/ }]; // match nothing
};

/**
 * Enable structured JSON output.
 * @param {boolean} [on=true]
 */
debug.json = function(on = true)
{
    _jsonMode = on;
};

/**
 * Enable/disable timestamps.
 * @param {boolean} [on=true]
 */
debug.timestamps = function(on = true)
{
    _timestamps = on;
};

/**
 * Enable/disable colors.
 * @param {boolean} [on=true]
 */
debug.colors = function(on = true)
{
    _useColors = on;
};

/**
 * Set custom output stream.
 * @param {object} stream - Writable stream with write() method.
 */
debug.output = function(stream)
{
    _output = stream;
    _outputCustom = true;
};

/**
 * Reset all settings to defaults.
 */
debug.reset = function()
{
    _globalLevel = LEVELS[process.env.DEBUG_LEVEL] !== undefined
        ? LEVELS[process.env.DEBUG_LEVEL]
        : LEVELS.debug;
    _enabledPatterns = _parsePatterns();
    _output = process.stdout;
    _outputCustom = false;
    _useColors = process.stdout.isTTY || false;
    _timestamps = true;
    _jsonMode = false;
    _colorIdx = 0;
    _nsColorMap.clear();
};

/** Expose level constants. */
debug.LEVELS = LEVELS;

module.exports = debug;
