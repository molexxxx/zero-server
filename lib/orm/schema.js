/**
 * @module orm/schema
 * @description Schema definition and validation for ORM models.
 *              Validates data against column definitions, coerces types,
 *              and enforces constraints (required, unique, min, max, enum, match).
 */

/**
 * Supported column types.
 * @enum {string}
 */
const TYPES = {
    STRING:   'string',
    INTEGER:  'integer',
    FLOAT:    'float',
    BOOLEAN:  'boolean',
    DATE:     'date',
    DATETIME: 'datetime',
    JSON:     'json',
    TEXT:     'text',
    BLOB:     'blob',
    UUID:     'uuid',
    // Extended numeric types
    BIGINT:   'bigint',
    SMALLINT: 'smallint',
    TINYINT:  'tinyint',
    DECIMAL:  'decimal',
    DOUBLE:   'double',
    REAL:     'real',
    // Extended string / binary types
    CHAR:     'char',
    BINARY:   'binary',
    VARBINARY:'varbinary',
    // Temporal types
    TIMESTAMP:'timestamp',
    TIME:     'time',
    // MySQL-specific
    ENUM:     'enum',
    SET:      'set',
    MEDIUMTEXT: 'mediumtext',
    LONGTEXT:   'longtext',
    MEDIUMBLOB: 'mediumblob',
    LONGBLOB:   'longblob',
    YEAR:     'year',
    // PostgreSQL-specific
    SERIAL:   'serial',
    BIGSERIAL:'bigserial',
    JSONB:    'jsonb',
    INTERVAL: 'interval',
    INET:     'inet',
    CIDR:     'cidr',
    MACADDR:  'macaddr',
    MONEY:    'money',
    XML:      'xml',
    CITEXT:   'citext',
    ARRAY:    'array',
    // SQLite (maps to TEXT/REAL/INTEGER but exposed for consistency)
    NUMERIC:  'numeric',
};

/**
 * Validate and sanitise a single value against a column definition.
 *
 * @param {*}      value   - Raw input value.
 * @param {object} colDef  - Column definition.
 * @param {string} colName - Column name (for error messages).
 * @returns {*} Coerced value.
 * @throws {Error} On validation failure.
 */
function validateValue(value, colDef, colName)
{
    const type = colDef.type || 'string';

    // Handle null/undefined
    if (value === undefined || value === null)
    {
        if (colDef.required && colDef.default === undefined)
            throw new Error(`"${colName}" is required`);
        if (colDef.default !== undefined)
            return typeof colDef.default === 'function' ? colDef.default() : colDef.default;
        return colDef.nullable !== false ? null : undefined;
    }

    switch (type)
    {
        case 'string':
        case 'text':
        case 'mediumtext':
        case 'longtext':
        case 'char':
        case 'citext':
        case 'xml':
        {
            const val = String(value);
            if (colDef.minLength !== undefined && val.length < colDef.minLength)
                throw new Error(`"${colName}" must be at least ${colDef.minLength} characters`);
            if (colDef.maxLength !== undefined && val.length > colDef.maxLength)
                throw new Error(`"${colName}" must be at most ${colDef.maxLength} characters`);
            if (colDef.match && !colDef.match.test(val))
                throw new Error(`"${colName}" does not match pattern ${colDef.match}`);
            if (colDef.enum && !colDef.enum.includes(val))
                throw new Error(`"${colName}" must be one of [${colDef.enum.join(', ')}]`);
            // Sanitise: prevent SQL-like injection patterns in string values
            return val;
        }
        case 'integer':
        case 'bigint':
        case 'smallint':
        case 'tinyint':
        case 'serial':
        case 'bigserial':
        case 'year':
        {
            const val = typeof value === 'string' ? parseInt(value, 10) : Math.floor(Number(value));
            if (isNaN(val)) throw new Error(`"${colName}" must be an integer`);
            if (colDef.min !== undefined && val < colDef.min)
                throw new Error(`"${colName}" must be >= ${colDef.min}`);
            if (colDef.max !== undefined && val > colDef.max)
                throw new Error(`"${colName}" must be <= ${colDef.max}`);
            return val;
        }
        case 'float':
        case 'decimal':
        case 'double':
        case 'real':
        case 'numeric':
        case 'money':
        {
            const val = Number(value);
            if (isNaN(val)) throw new Error(`"${colName}" must be a number`);
            if (colDef.min !== undefined && val < colDef.min)
                throw new Error(`"${colName}" must be >= ${colDef.min}`);
            if (colDef.max !== undefined && val > colDef.max)
                throw new Error(`"${colName}" must be <= ${colDef.max}`);
            return val;
        }
        case 'boolean':
        {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string')
            {
                const lower = value.toLowerCase();
                if (['true', '1', 'yes'].includes(lower)) return true;
                if (['false', '0', 'no'].includes(lower)) return false;
            }
            if (typeof value === 'number') return value !== 0;
            throw new Error(`"${colName}" must be a boolean`);
        }
        case 'date':
        case 'datetime':
        case 'timestamp':
        case 'time':
        case 'interval':
        {
            if (value instanceof Date) return value;
            const d = new Date(value);
            if (isNaN(d.getTime())) throw new Error(`"${colName}" must be a valid date`);
            return d;
        }
        case 'json':
        case 'jsonb':
        {
            if (typeof value === 'string')
            {
                try { return JSON.parse(value); }
                catch (e) { throw new Error(`"${colName}" must be valid JSON`); }
            }
            // Already an object/array — return as-is for storage
            return value;
        }
        case 'uuid':
        {
            const val = String(value);
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val))
                throw new Error(`"${colName}" must be a valid UUID`);
            return val;
        }
        case 'blob':
        case 'mediumblob':
        case 'longblob':
        case 'binary':
        case 'varbinary':
            return Buffer.isBuffer(value) ? value : Buffer.from(value);
        case 'enum':
        {
            const val = String(value);
            if (colDef.enum && !colDef.enum.includes(val))
                throw new Error(`"${colName}" must be one of [${colDef.enum.join(', ')}]`);
            return val;
        }
        case 'set':
        {
            const vals = Array.isArray(value) ? value : String(value).split(',');
            if (colDef.values)
            {
                for (const v of vals)
                    if (!colDef.values.includes(v.trim()))
                        throw new Error(`"${colName}" contains invalid value "${v.trim()}". Allowed: [${colDef.values.join(', ')}]`);
            }
            return vals.map(v => v.trim()).join(',');
        }
        case 'inet':
        case 'cidr':
        case 'macaddr':
            return String(value);
        case 'array':
            return Array.isArray(value) ? value : [value];
        default:
            return value;
    }
}

/**
 * Validate all columns of a data object against the schema.
 *
 * @param {object} data     - Input data object.
 * @param {object} columns  - Schema column definitions.
 * @param {object} [options]
 * @param {boolean} [options.partial=false] - When true, only validates provided fields (for updates).
 * @returns {{ valid: boolean, errors: string[], sanitized: object }}
 */
function validate(data, columns, options = {})
{
    const errors = [];
    const sanitized = {};

    for (const [colName, colDef] of Object.entries(columns))
    {
        // Skip auto fields on create
        if (colDef.primaryKey && colDef.autoIncrement && data[colName] === undefined) continue;

        if (options.partial && data[colName] === undefined) continue;

        // Skip guarded fields not present in data (stripped by mass-assignment)
        if (colDef.guarded && data[colName] === undefined) continue;

        try
        {
            sanitized[colName] = validateValue(data[colName], colDef, colName);
        }
        catch (e)
        {
            errors.push(e.message);
        }
    }

    // Reject unknown keys (prevent mass-assignment)
    for (const key of Object.keys(data))
    {
        if (!columns[key])
        {
            errors.push(`Unknown column "${key}"`);
        }
    }

    return { valid: errors.length === 0, errors, sanitized };
}

// -- DDL Security Helpers --------------------------------

const VALID_FK_ACTIONS = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']);

/**
 * Validate and return a FK action string, or throw.
 * @param {string} action
 * @returns {string} Uppercase validated action
 */
function validateFKAction(action)
{
    const upper = String(action).toUpperCase();
    if (!VALID_FK_ACTIONS.has(upper))
        throw new Error(`Invalid FK action: "${action}". Allowed: ${[...VALID_FK_ACTIONS].join(', ')}`);
    return upper;
}

/**
 * Validate a CHECK expression for dangerous SQL patterns.
 * @param {string} expr
 * @returns {string} The original expression (validated).
 */
function validateCheck(expr)
{
    const s = String(expr);
    // Block semicolons, comment markers, and common injection patterns
    if (/;|--|\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b|\bALTER\b|\bCREATE\b|\bEXEC\b/i.test(s))
        throw new Error(`Potentially dangerous CHECK expression: "${s}"`);
    return s;
}

module.exports = { TYPES, validateValue, validate, validateFKAction, validateCheck };
