/**
 * @module grpc/proto
 * @description Zero-dependency proto3 parser — reads `.proto` file text and produces
 *              message descriptors, enum definitions, and service/RPC declarations
 *              that the codec and server use at runtime.
 *
 *              Supports:
 *              - `syntax = "proto3";`
 *              - `package`, `option`, `import` (recorded but not resolved)
 *              - Scalar types, enums, nested messages, `oneof`, `map`, `repeated`
 *              - Services with unary, server-streaming, client-streaming, and bidi RPCs
 *              - Comments (// and /* ... *​/)
 *              - Reserved fields and field options like `[deprecated = true]`
 *
 * @see https://protobuf.dev/programming-guides/proto3/
 *
 * @example
 *   const { parseProto } = require('./proto');
 *   const schema = parseProto(fs.readFileSync('chat.proto', 'utf8'));
 *   // schema.messages  — { MessageName: { fields: [...] } }
 *   // schema.enums     — { EnumName: { values: { ... } } }
 *   // schema.services  — { ServiceName: { methods: { ... } } }
 */

const fs = require('fs');
const path = require('path');
const log = require('../debug')('zero:grpc');

// -- Token Types -------------------------------------------

/** @private */
const TOK = {
    IDENT: 'IDENT',
    NUMBER: 'NUMBER',
    STRING: 'STRING',
    SYMBOL: 'SYMBOL',
    EOF: 'EOF',
};

// -- Lexer -------------------------------------------------

/**
 * Tokenize proto3 source text.
 * @private
 * @param {string} source
 * @returns {{ type: string, value: string, line: number }[]}
 */
function tokenize(source)
{
    const tokens = [];
    let i = 0;
    let line = 1;

    while (i < source.length)
    {
        const ch = source[i];

        // Newlines
        if (ch === '\n') { line++; i++; continue; }
        if (ch === '\r') { i++; continue; }

        // Whitespace
        if (ch === ' ' || ch === '\t') { i++; continue; }

        // Single-line comment
        if (ch === '/' && source[i + 1] === '/')
        {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
        }

        // Block comment
        if (ch === '/' && source[i + 1] === '*')
        {
            i += 2;
            while (i < source.length - 1)
            {
                if (source[i] === '\n') line++;
                if (source[i] === '*' && source[i + 1] === '/')
                {
                    i += 2;
                    break;
                }
                i++;
            }
            continue;
        }

        // String literal
        if (ch === '"' || ch === "'")
        {
            const quote = ch;
            let str = '';
            i++;
            while (i < source.length && source[i] !== quote)
            {
                if (source[i] === '\\' && i + 1 < source.length)
                {
                    const esc = source[i + 1];
                    if (esc === 'n') str += '\n';
                    else if (esc === 't') str += '\t';
                    else if (esc === '\\') str += '\\';
                    else if (esc === quote) str += quote;
                    else str += esc;
                    i += 2;
                }
                else
                {
                    str += source[i++];
                }
            }
            i++; // skip closing quote
            tokens.push({ type: TOK.STRING, value: str, line });
            continue;
        }

        // Number (integer or float, including negative)
        if ((ch >= '0' && ch <= '9') || (ch === '-' && source[i + 1] >= '0' && source[i + 1] <= '9'))
        {
            let num = '';
            if (ch === '-') { num = '-'; i++; }

            // Hex
            if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X'))
            {
                num += '0x'; i += 2;
                while (i < source.length && /[0-9a-fA-F]/.test(source[i])) num += source[i++];
            }
            else
            {
                while (i < source.length && ((source[i] >= '0' && source[i] <= '9') || source[i] === '.' || source[i] === 'e' || source[i] === 'E' || source[i] === '+' || source[i] === '-'))
                {
                    // Avoid consuming the next field's minus sign
                    if ((source[i] === '+' || source[i] === '-') && source[i - 1] !== 'e' && source[i - 1] !== 'E') break;
                    num += source[i++];
                }
            }
            tokens.push({ type: TOK.NUMBER, value: num, line });
            continue;
        }

        // Identifier or keyword
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_')
        {
            let ident = '';
            while (i < source.length && ((source[i] >= 'a' && source[i] <= 'z') || (source[i] >= 'A' && source[i] <= 'Z') || (source[i] >= '0' && source[i] <= '9') || source[i] === '_' || source[i] === '.'))
            {
                ident += source[i++];
            }
            tokens.push({ type: TOK.IDENT, value: ident, line });
            continue;
        }

        // Symbols: { } ( ) ; = , < > [ ]
        tokens.push({ type: TOK.SYMBOL, value: ch, line });
        i++;
    }

    tokens.push({ type: TOK.EOF, value: '', line });
    return tokens;
}

// -- Parser ------------------------------------------------

/**
 * Parse a proto3 source string into a structured schema.
 *
 * @param {string} source - Proto3 source text.
 * @param {object} [opts] - Parser options.
 * @param {string} [opts.filename] - File name for error messages.
 * @param {string} [opts.basePath] - Base directory for resolving imports.
 * @param {boolean} [opts.resolveImports=false] - Whether to recursively parse imported files.
 * @returns {ProtoSchema} Parsed schema with messages, enums, and services.
 *
 * @example
 *   const schema = parseProto('syntax = "proto3"; message Ping { string msg = 1; }');
 *   schema.messages.Ping.fields[0].name;  // 'msg'
 *   schema.messages.Ping.fields[0].type;  // 'string'
 */
function parseProto(source, opts = {})
{
    const tokens = tokenize(source);
    let pos = 0;
    const filename = opts.filename || '<inline>';

    const schema = {
        syntax: 'proto3',
        package: '',
        imports: [],
        options: {},
        messages: {},
        enums: {},
        services: {},
    };

    /**
     * Get current token.
     * @private
     */
    function peek()
    {
        return tokens[pos];
    }

    /**
     * Consume and return the current token.
     * @private
     */
    function next()
    {
        return tokens[pos++];
    }

    /**
     * Expect a specific token value or type.
     * @private
     */
    function expect(value, type)
    {
        const tok = next();
        if (type && tok.type !== type)
            throw new SyntaxError(`${filename}:${tok.line}: expected ${type} "${value}", got ${tok.type} "${tok.value}"`);
        if (value && tok.value !== value)
            throw new SyntaxError(`${filename}:${tok.line}: expected "${value}", got "${tok.value}"`);
        return tok;
    }

    /**
     * Check if current token matches value.
     * @private
     */
    function match(value)
    {
        return peek().value === value;
    }

    /**
     * Consume if current token matches value.
     * @private
     */
    function eat(value)
    {
        if (match(value)) { next(); return true; }
        return false;
    }

    // -- Top-Level Parsing ---------------------------------

    while (peek().type !== TOK.EOF)
    {
        const tok = peek();

        if (tok.value === 'syntax')
        {
            next(); expect('='); schema.syntax = next().value; expect(';');
            if (schema.syntax !== 'proto3')
                log.warn('proto file uses syntax "%s" — only proto3 is fully supported', schema.syntax);
        }
        else if (tok.value === 'package')
        {
            next(); schema.package = next().value; expect(';');
        }
        else if (tok.value === 'import')
        {
            next();
            const weak = eat('weak');
            const pub = eat('public');
            const importPath = next().value;
            expect(';');
            schema.imports.push({ path: importPath, weak, public: pub });

            if (opts.resolveImports && opts.basePath)
            {
                try
                {
                    const fullPath = path.resolve(opts.basePath, importPath);
                    const importSource = fs.readFileSync(fullPath, 'utf8');
                    const importSchema = parseProto(importSource, {
                        filename: importPath,
                        basePath: path.dirname(fullPath),
                        resolveImports: true,
                    });
                    // Merge imported definitions
                    Object.assign(schema.messages, importSchema.messages);
                    Object.assign(schema.enums, importSchema.enums);
                    Object.assign(schema.services, importSchema.services);
                }
                catch (err)
                {
                    log.warn('failed to resolve import "%s": %s', importPath, err.message);
                }
            }
        }
        else if (tok.value === 'option')
        {
            next(); _parseOption(schema.options);
        }
        else if (tok.value === 'message')
        {
            next();
            const name = next().value;
            schema.messages[name] = _parseMessage(name);
        }
        else if (tok.value === 'enum')
        {
            next();
            const name = next().value;
            schema.enums[name] = _parseEnum(name);
        }
        else if (tok.value === 'service')
        {
            next();
            const name = next().value;
            schema.services[name] = _parseService(name);
        }
        else if (tok.value === ';')
        {
            next(); // skip stray semicolons
        }
        else
        {
            throw new SyntaxError(`${filename}:${tok.line}: unexpected token "${tok.value}"`);
        }
    }

    // Link enum definitions into message fields
    _linkEnums(schema);

    log.info('parsed %s: %d messages, %d enums, %d services',
        filename,
        Object.keys(schema.messages).length,
        Object.keys(schema.enums).length,
        Object.keys(schema.services).length,
    );

    return schema;

    // -- Helper Functions (closures over peek/next/expect/match/eat) --

    /**
     * Parse a message definition (including nested messages and enums).
     * @param {string} msgName
     * @returns {object}
     */
    function _parseMessage(msgName)
    {
        const msg = { name: msgName, fields: [], oneofs: {}, nested: {}, nestedEnums: {}, options: {} };

        expect('{');

        while (!match('}'))
        {
            const tok = peek();

            if (tok.value === 'message')
            {
                next();
                const nestedName = next().value;
                msg.nested[nestedName] = _parseMessage(nestedName);
            }
            else if (tok.value === 'enum')
            {
                next();
                const enumName = next().value;
                msg.nestedEnums[enumName] = _parseEnum(enumName);
            }
            else if (tok.value === 'oneof')
            {
                next();
                const oneofName = next().value;
                msg.oneofs[oneofName] = _parseOneof(oneofName, msg.fields);
            }
            else if (tok.value === 'map')
            {
                _parseMapField(msg.fields);
            }
            else if (tok.value === 'reserved')
            {
                _parseReserved();
            }
            else if (tok.value === 'option')
            {
                next(); _parseOption(msg.options);
            }
            else if (tok.value === ';')
            {
                next();
            }
            else
            {
                _parseField(msg.fields);
            }
        }

        expect('}');
        if (peek().value === ';') next();

        return msg;
    }

    /**
     * Parse a field declaration.
     * @param {object[]} fieldsArray
     */
    function _parseField(fieldsArray)
    {
        let repeated = false;
        let optional = false;

        if (match('repeated')) { next(); repeated = true; }
        else if (match('optional')) { next(); optional = true; }

        const type = next().value;
        const fName = next().value;
        expect('=');
        const number = parseInt(next().value, 10);

        const fieldOpts = {};
        if (match('['))
        {
            next();
            while (!match(']'))
            {
                const optName = next().value;
                expect('=');
                const optVal = next().value;
                fieldOpts[optName] = optVal;
                eat(',');
            }
            expect(']');
        }

        expect(';');

        fieldsArray.push({
            name: fName,
            type,
            number,
            repeated,
            optional,
            map: false,
            options: fieldOpts,
        });
    }

    /**
     * Parse a map field: `map<KeyType, ValueType> name = N;`
     * @param {object[]} fieldsArray
     */
    function _parseMapField(fieldsArray)
    {
        expect('map');
        expect('<');
        const keyType = next().value;
        expect(',');
        const valueType = next().value;
        expect('>');
        const fName = next().value;
        expect('=');
        const number = parseInt(next().value, 10);

        const fieldOpts = {};
        if (match('['))
        {
            next();
            while (!match(']'))
            {
                const optName = next().value;
                expect('=');
                const optVal = next().value;
                fieldOpts[optName] = optVal;
                eat(',');
            }
            expect(']');
        }

        expect(';');

        fieldsArray.push({
            name: fName,
            type: `map<${keyType},${valueType}>`,
            keyType,
            valueType,
            number,
            repeated: false,
            optional: false,
            map: true,
            mapKeyType: keyType,
            mapValueType: valueType,
            options: fieldOpts,
        });
    }

    /**
     * Parse oneof block.
     * @param {string} oneofName
     * @param {object[]} fieldsArray
     * @returns {string[]}
     */
    function _parseOneof(oneofName, fieldsArray)
    {
        const fieldNames = [];
        expect('{');

        while (!match('}'))
        {
            if (match('option'))
            {
                next(); _parseOption({});
            }
            else if (match(';'))
            {
                next();
            }
            else
            {
                const type = next().value;
                const fName = next().value;
                expect('=');
                const number = parseInt(next().value, 10);

                const fieldOpts = {};
                if (match('['))
                {
                    next();
                    while (!match(']'))
                    {
                        const optName = next().value;
                        expect('=');
                        const optVal = next().value;
                        fieldOpts[optName] = optVal;
                        eat(',');
                    }
                    expect(']');
                }

                expect(';');

                fieldsArray.push({
                    name: fName,
                    type,
                    number,
                    repeated: false,
                    optional: false,
                    map: false,
                    oneofName,
                    options: fieldOpts,
                });
                fieldNames.push(fName);
            }
        }

        expect('}');
        return fieldNames;
    }

    /**
     * Parse an enum definition.
     * @param {string} eName
     * @returns {object}
     */
    function _parseEnum(eName)
    {
        const enumDef = { name: eName, values: {}, options: {} };
        expect('{');

        while (!match('}'))
        {
            if (match('option'))
            {
                next(); _parseOption(enumDef.options);
            }
            else if (match('reserved'))
            {
                _parseReserved();
            }
            else if (match(';'))
            {
                next();
            }
            else
            {
                const valueName = next().value;
                expect('=');
                const valueNumber = parseInt(next().value, 10);

                if (match('['))
                {
                    next();
                    while (!match(']'))
                    {
                        next(); eat('='); next(); eat(',');
                    }
                    expect(']');
                }

                expect(';');
                enumDef.values[valueName] = valueNumber;
            }
        }

        expect('}');
        if (peek().value === ';') next();

        return enumDef;
    }

    /**
     * Parse a service definition with RPC methods.
     * @param {string} sName
     * @returns {object}
     */
    function _parseService(sName)
    {
        const service = { name: sName, methods: {}, options: {} };
        expect('{');

        while (!match('}'))
        {
            if (match('rpc'))
            {
                next();
                const methodName = next().value;
                expect('(');
                const clientStreaming = eat('stream');
                const inputType = next().value;
                expect(')');
                expect('returns');
                expect('(');
                const serverStreaming = eat('stream');
                const outputType = next().value;
                expect(')');

                const methodOpts = {};
                if (match('{'))
                {
                    next();
                    while (!match('}'))
                    {
                        if (match('option'))
                        {
                            next(); _parseOption(methodOpts);
                        }
                        else
                        {
                            next();
                        }
                    }
                    expect('}');
                }
                else
                {
                    expect(';');
                }

                service.methods[methodName] = {
                    name: methodName,
                    inputType,
                    outputType,
                    clientStreaming: !!clientStreaming,
                    serverStreaming: !!serverStreaming,
                    options: methodOpts,
                };
            }
            else if (match('option'))
            {
                next(); _parseOption(service.options);
            }
            else if (match(';'))
            {
                next();
            }
            else
            {
                next();
            }
        }

        expect('}');
        if (peek().value === ';') next();

        return service;
    }

    /**
     * Parse an option statement: `option name = value;`
     * @param {object} target
     */
    function _parseOption(target)
    {
        let optName = '';
        if (match('('))
        {
            next();
            optName = '(' + next().value + ')';
            expect(')');
        }
        else
        {
            optName = next().value;
        }

        while (match('.'))
        {
            next();
            optName += '.' + next().value;
        }

        expect('=');
        const value = next().value;
        expect(';');
        target[optName] = value;
    }

    /**
     * Skip a `reserved` statement.
     */
    function _parseReserved()
    {
        next(); // consume 'reserved'
        while (peek().value !== ';' && peek().type !== TOK.EOF) next();
        if (peek().value === ';') next();
    }
}

// -- Post-Processing --------------------------------------

/**
 * Link enum definitions into message fields so the codec knows how to encode/decode them.
 * Also flattens nested messages and enums into the top-level maps for easy lookup.
 * @private
 * @param {object} schema
 */
function _linkEnums(schema)
{
    // Flatten nested messages and enums
    const flatMsgs = {};
    const flatEnums = {};

    function flatten(messages, enums, prefix)
    {
        for (const [name, msg] of Object.entries(messages))
        {
            const fullName = prefix ? `${prefix}.${name}` : name;
            flatMsgs[fullName] = msg;
            flatMsgs[name] = msg; // also store short name for convenience

            if (msg.nested) flatten(msg.nested, {}, fullName);
            if (msg.nestedEnums)
            {
                for (const [eName, eDef] of Object.entries(msg.nestedEnums))
                {
                    const fullEnum = prefix ? `${prefix}.${name}.${eName}` : `${name}.${eName}`;
                    flatEnums[fullEnum] = eDef;
                    flatEnums[eName] = eDef; // short name
                }
            }
        }

        for (const [name, def] of Object.entries(enums))
        {
            const fullName = prefix ? `${prefix}.${name}` : name;
            flatEnums[fullName] = def;
            flatEnums[name] = def;
        }
    }

    flatten(schema.messages, schema.enums, schema.package);

    // Merge flattened into schema
    Object.assign(schema.messages, flatMsgs);
    Object.assign(schema.enums, flatEnums);

    // Link enum types into message fields
    for (const msg of Object.values(schema.messages))
    {
        if (!msg.fields) continue;
        for (const field of msg.fields)
        {
            if (!field.map && schema.enums[field.type])
            {
                field.enumDef = schema.enums[field.type];
            }
            // Map value enums
            if (field.map && schema.enums[field.valueType])
            {
                field.enumDef = schema.enums[field.valueType];
            }
        }
    }
}

// -- File Loader -------------------------------------------

/**
 * Parse a `.proto` file from disk.
 *
 * @param {string} filePath - Path to the `.proto` file.
 * @param {object} [opts] - Parser options.
 * @param {boolean} [opts.resolveImports=false] - Whether to recursively resolve imports.
 * @returns {ProtoSchema} Parsed schema.
 *
 * @example
 *   const schema = parseProtoFile('./protos/chat.proto');
 */
function parseProtoFile(filePath, opts = {})
{
    const resolved = path.resolve(filePath);
    const source = fs.readFileSync(resolved, 'utf8');
    return parseProto(source, {
        filename: path.basename(resolved),
        basePath: path.dirname(resolved),
        ...opts,
    });
}

module.exports = {
    parseProto,
    parseProtoFile,
    tokenize,
};
