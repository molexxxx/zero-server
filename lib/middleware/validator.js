/**
 * @module middleware/validator
 * @description Request validation middleware.
 *              Validates `req.body`, `req.query`, and `req.params` against a
 *              schema object.  Returns 422 with detailed errors on failure.
 *
 * @example
 *   const { createApp, validate } = require('zero-http');
 *   const app = createApp();
 *
 *   app.post('/users', validate({
 *       body: {
 *           name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
 *           email: { type: 'string', required: true, match: /^[^@]+@[^@]+\.[^@]+$/ },
 *           age:   { type: 'integer', min: 0, max: 150 },
 *       },
 *       query: {
 *           format: { type: 'string', enum: ['json', 'xml'], default: 'json' },
 *       },
 *   }), (req, res) => {
 *       // req.body / req.query are now validated and sanitised
 *   });
 */

/**
 * Supported shorthand types for validation rules.
 * @private
 */
const COERCE = {
    string(v)  { return v == null ? v : String(v); },
    integer(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? v : n; },
    number(v)  { const n = Number(v); return Number.isNaN(n) ? v : n; },
    float(v)   { const n = parseFloat(v); return Number.isNaN(n) ? v : n; },
    boolean(v)
    {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string')
        {
            const l = v.toLowerCase();
            if (l === 'true' || l === '1' || l === 'yes' || l === 'on') return true;
            if (l === 'false' || l === '0' || l === 'no' || l === 'off') return false;
        }
        return v;
    },
    array(v)
    {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string')
        {
            try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch {}
            return v.split(',').map(s => s.trim());
        }
        return v;
    },
    json(v)
    {
        if (typeof v === 'string') { try { return JSON.parse(v); } catch {} }
        return v;
    },
    date(v)
    {
        if (v instanceof Date) return v;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? v : d;
    },
    uuid(v)   { return v == null ? v : String(v); },
    email(v)  { return v == null ? v : String(v).trim().toLowerCase(); },
    url(v)    { return v == null ? v : String(v).trim(); },
};

/**
 * Validate a single value against a rule definition.
 *
 * @param {*}      value    - Raw input value.
 * @param {object} rule     - Rule definition.
 * @param {string} field    - Field name (for error messages).
 * @returns {{ value: *, error: string|null }}
 */
function validateField(value, rule, field)
{
    // Apply default
    if ((value === undefined || value === null || value === '') && rule.default !== undefined)
    {
        value = typeof rule.default === 'function' ? rule.default() : rule.default;
    }

    // Required check
    if (rule.required && (value === undefined || value === null || value === ''))
    {
        return { value, error: `${field} is required` };
    }

    // If not required and absent, skip further checks
    if (value === undefined || value === null) return { value, error: null };

    // Type coercion
    if (rule.type && COERCE[rule.type]) value = COERCE[rule.type](value);

    // Type validation
    if (rule.type)
    {
        switch (rule.type)
        {
            case 'string':
                if (typeof value !== 'string') return { value, error: `${field} must be a string` };
                break;
            case 'integer':
                if (!Number.isInteger(value)) return { value, error: `${field} must be an integer` };
                break;
            case 'number':
            case 'float':
                if (typeof value !== 'number' || Number.isNaN(value)) return { value, error: `${field} must be a number` };
                break;
            case 'boolean':
                if (typeof value !== 'boolean') return { value, error: `${field} must be a boolean` };
                break;
            case 'array':
                if (!Array.isArray(value)) return { value, error: `${field} must be an array` };
                break;
            case 'date':
                if (!(value instanceof Date)) return { value, error: `${field} must be a valid date` };
                break;
            case 'email':
                if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
                    return { value, error: `${field} must be a valid email` };
                break;
            case 'url':
                try { new URL(value); }
                catch { return { value, error: `${field} must be a valid URL` }; }
                break;
            case 'uuid':
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
                    return { value, error: `${field} must be a valid UUID` };
                break;
        }
    }

    // Constraints
    if (rule.minLength !== undefined && typeof value === 'string' && value.length < rule.minLength)
        return { value, error: `${field} must be at least ${rule.minLength} characters` };
    if (rule.maxLength !== undefined && typeof value === 'string' && value.length > rule.maxLength)
        return { value, error: `${field} must be at most ${rule.maxLength} characters` };
    if (rule.min !== undefined && typeof value === 'number' && value < rule.min)
        return { value, error: `${field} must be >= ${rule.min}` };
    if (rule.max !== undefined && typeof value === 'number' && value > rule.max)
        return { value, error: `${field} must be <= ${rule.max}` };
    if (rule.match && typeof value === 'string' && !rule.match.test(value))
        return { value, error: `${field} format is invalid` };
    if (rule.enum && !rule.enum.includes(value))
        return { value, error: `${field} must be one of: ${rule.enum.join(', ')}` };
    if (rule.minItems !== undefined && Array.isArray(value) && value.length < rule.minItems)
        return { value, error: `${field} must have at least ${rule.minItems} items` };
    if (rule.maxItems !== undefined && Array.isArray(value) && value.length > rule.maxItems)
        return { value, error: `${field} must have at most ${rule.maxItems} items` };

    // Custom validator function
    if (typeof rule.validate === 'function')
    {
        const msg = rule.validate(value);
        if (typeof msg === 'string') return { value, error: msg };
    }

    return { value, error: null };
}

/**
 * Validate an object against a schema.
 *
 * @param {object} data   - Input data.
 * @param {object} schema - { fieldName: ruleObject }
 * @param {object} [opts] - Configuration options.
 * @param {boolean} [opts.stripUnknown=true] - Remove fields not in schema.
 * @returns {{ sanitized: object, errors: string[] }}
 */
function validateObject(data, schema, opts = {})
{
    const errors = [];
    const sanitized = {};
    const stripUnknown = opts.stripUnknown !== false;
    const source = data || {};

    for (const [field, rule] of Object.entries(schema))
    {
        const { value, error } = validateField(source[field], rule, field);
        if (error) errors.push(error);
        else if (value !== undefined) sanitized[field] = value;
    }

    // Preserve unknown fields if not stripping
    if (!stripUnknown)
    {
        for (const key of Object.keys(source))
        {
            if (!(key in schema)) sanitized[key] = source[key];
        }
    }

    return { sanitized, errors };
}

/**
 * Create a validation middleware.
 *
 * @param {object} schema - Validation rules object.
 * @param {object} [schema.body]   - Rules for req.body fields.
 * @param {object} [schema.query]  - Rules for req.query fields.
 * @param {object} [schema.params] - Rules for req.params fields.
 * @param {object} [options] - Validation options.
 * @param {boolean}  [options.stripUnknown=true] - Remove fields not in schema.
 * @param {Function} [options.onError]           - Custom error handler `(errors, req, res) => {}`.
 * @returns {Function} Middleware function.
 */
function validate(schema, options = {})
{
    return function validatorMiddleware(req, res, next)
    {
        const allErrors = [];

        if (schema.body)
        {
            const { sanitized, errors } = validateObject(req.body, schema.body, options);
            if (errors.length) allErrors.push(...errors.map(e => `body.${e}`));
            else req.body = sanitized;
        }

        if (schema.query)
        {
            const { sanitized, errors } = validateObject(req.query, schema.query, options);
            if (errors.length) allErrors.push(...errors.map(e => `query.${e}`));
            else req.query = sanitized;
        }

        if (schema.params)
        {
            const { sanitized, errors } = validateObject(req.params, schema.params, options);
            if (errors.length) allErrors.push(...errors.map(e => `params.${e}`));
            else req.params = sanitized;
        }

        if (allErrors.length > 0)
        {
            if (options.onError) return options.onError(allErrors, req, res);
            res.status(422).json({ errors: allErrors });
            return;
        }

        next();
    };
}

// Also export helpers for standalone use
validate.field = validateField;
validate.object = validateObject;

module.exports = validate;
