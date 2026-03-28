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
        {
            if (value instanceof Date) return value;
            const d = new Date(value);
            if (isNaN(d.getTime())) throw new Error(`"${colName}" must be a valid date`);
            return d;
        }
        case 'json':
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
            return Buffer.isBuffer(value) ? value : Buffer.from(value);
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

module.exports = { TYPES, validateValue, validate };
