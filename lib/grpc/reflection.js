/**
 * @module grpc/reflection
 * @description gRPC Server Reflection Protocol implementation (grpc.reflection.v1).
 *              Enables `grpcurl`, `grpcui`, Postman, and other debugging tools to
 *              introspect registered services without supplying `.proto` files.
 *
 * @see https://github.com/grpc/grpc/blob/master/doc/server-reflection.md
 *
 * @example
 *   const app = createApp();
 *   app.grpc(schema, 'Greeter', handlers);
 *   app.grpcReflection();  // dev-only by default
 *   app.listen(50051, { http2: true });
 */

const log = require('../debug')('zero:grpc:reflection');
const { GrpcStatus } = require('./status');
const { encode, decode } = require('./codec');
const { Writer } = require('./codec');

// -- Protobuf field type numbers (google.protobuf.FieldDescriptorProto.Type) --

const PB_TYPE = {
    double: 1, float: 2, int64: 3, uint64: 4, int32: 5,
    fixed64: 6, fixed32: 7, bool: 8, string: 9, group: 10,
    message: 11, bytes: 12, uint32: 13, enum: 14, sfixed32: 15,
    sfixed64: 16, sint32: 17, sint64: 18,
};

const PB_LABEL = { optional: 1, required: 2, repeated: 3 };

// -- FileDescriptorProto Builder (protobuf self-description) ---

/**
 * Build a serialized FileDescriptorProto from a parsed proto schema.
 * This is the binary format returned by the reflection service.
 *
 * We hand-construct the protobuf wire format directly since we can't
 * use the codec (which needs descriptors that we're building).
 * Uses the Writer class for encoding.
 *
 * @private
 * @param {object} schema - Parsed proto schema.
 * @param {string} [filename] - File name for the descriptor.
 * @returns {Buffer} Serialized FileDescriptorProto.
 */
function buildFileDescriptorProto(schema, filename)
{
    const w = new Writer();

    // field 1: name (string)
    if (filename) w.string(1, filename);

    // field 2: package (string)
    if (schema.package) w.string(2, schema.package);

    // field 3: dependency (repeated string) — imported file names
    if (schema.imports)
    {
        for (const imp of schema.imports)
            w.string(3, imp.path);
    }

    // field 4: message_type (repeated DescriptorProto)
    for (const [name, msg] of Object.entries(schema.messages))
    {
        // Only emit top-level messages (skip nested ones that were flattened)
        if (name.includes('.') && !name.startsWith(schema.package)) continue;
        // Skip if it's a duplicate from flattening (name has package prefix)
        const shortName = name.includes('.') ? name.split('.').pop() : name;
        if (shortName !== name && schema.messages[shortName] === msg) continue;

        const msgBytes = _buildDescriptorProto(msg, schema);
        w.bytes(4, msgBytes);
    }

    // field 5: enum_type (repeated EnumDescriptorProto)
    for (const [name, enumDef] of Object.entries(schema.enums))
    {
        if (name.includes('.')) continue; // skip flattened duplicates
        const enumBytes = _buildEnumDescriptorProto(enumDef);
        w.bytes(5, enumBytes);
    }

    // field 6: service (repeated ServiceDescriptorProto)
    for (const [name, svc] of Object.entries(schema.services))
    {
        const svcBytes = _buildServiceDescriptorProto(svc, schema);
        w.bytes(6, svcBytes);
    }

    // field 12: syntax (string)
    if (schema.syntax) w.string(12, schema.syntax);

    return w.finish();
}

/**
 * Build a DescriptorProto (message descriptor).
 * @private
 */
function _buildDescriptorProto(msg, schema)
{
    const w = new Writer();

    // field 1: name
    w.string(1, msg.name);

    // field 2: field (repeated FieldDescriptorProto)
    if (msg.fields)
    {
        for (const field of msg.fields)
        {
            if (field.map)
            {
                const fieldBytes = _buildMapFieldDescriptor(field, schema);
                w.bytes(2, fieldBytes);
            }
            else
            {
                const fieldBytes = _buildFieldDescriptorProto(field, schema);
                w.bytes(2, fieldBytes);
            }
        }
    }

    // field 3: nested_type (repeated DescriptorProto)
    if (msg.nested)
    {
        for (const nested of Object.values(msg.nested))
        {
            w.bytes(3, _buildDescriptorProto(nested, schema));
        }
    }

    // field 4: enum_type (repeated EnumDescriptorProto)
    if (msg.nestedEnums)
    {
        for (const nested of Object.values(msg.nestedEnums))
        {
            w.bytes(4, _buildEnumDescriptorProto(nested));
        }
    }

    // field 8: oneof_decl (repeated OneofDescriptorProto)
    if (msg.oneofs)
    {
        let idx = 0;
        const oneofIndices = {};
        for (const oneofName of Object.keys(msg.oneofs))
        {
            const ow = new Writer();
            ow.string(1, oneofName);
            w.bytes(8, ow.finish());
            oneofIndices[oneofName] = idx++;
        }
    }

    return w.finish();
}

/**
 * Build a FieldDescriptorProto.
 * @private
 */
function _buildFieldDescriptorProto(field, schema)
{
    const w = new Writer();

    // field 1: name
    w.string(1, field.name);

    // field 3: number
    w.int32(3, field.number);

    // field 4: label
    if (field.repeated) w.int32(4, PB_LABEL.repeated);
    else w.int32(4, PB_LABEL.optional);

    // field 5: type
    const pbType = _resolveFieldType(field, schema);
    w.int32(5, pbType);

    // field 6: type_name (for message and enum types)
    if (pbType === PB_TYPE.message || pbType === PB_TYPE.enum)
    {
        const typeName = field.type.startsWith('.') ? field.type : '.' + (schema.package ? schema.package + '.' : '') + field.type;
        w.string(6, typeName);
    }

    // field 9: oneof_index (if in a oneof)
    if (field.oneofName !== undefined)
    {
        // Will use the index from the parent — simplified to 0 for now
        w.int32(9, 0);
    }

    return w.finish();
}

/**
 * Build a map field descriptor (as a repeated message with map_entry option).
 * @private
 */
function _buildMapFieldDescriptor(field, schema)
{
    const w = new Writer();
    w.string(1, field.name);
    w.int32(3, field.number);
    w.int32(4, PB_LABEL.repeated);
    w.int32(5, PB_TYPE.message);
    // type_name for the auto-generated entry type
    const entryName = field.name.charAt(0).toUpperCase() + field.name.slice(1) + 'Entry';
    w.string(6, '.' + (schema.package ? schema.package + '.' : '') + entryName);
    return w.finish();
}

/**
 * Build an EnumDescriptorProto.
 * @private
 */
function _buildEnumDescriptorProto(enumDef)
{
    const w = new Writer();

    // field 1: name
    w.string(1, enumDef.name);

    // field 2: value (repeated EnumValueDescriptorProto)
    if (enumDef.values)
    {
        for (const [name, number] of Object.entries(enumDef.values))
        {
            const vw = new Writer();
            vw.string(1, name);
            vw.int32(2, number);
            w.bytes(2, vw.finish());
        }
    }

    return w.finish();
}

/**
 * Build a ServiceDescriptorProto.
 * @private
 */
function _buildServiceDescriptorProto(svc, schema)
{
    const w = new Writer();

    // field 1: name
    w.string(1, svc.name);

    // field 2: method (repeated MethodDescriptorProto)
    for (const method of Object.values(svc.methods))
    {
        const mw = new Writer();
        mw.string(1, method.name);
        // input type (fully qualified)
        mw.string(2, '.' + (schema.package ? schema.package + '.' : '') + method.inputType);
        // output type
        mw.string(3, '.' + (schema.package ? schema.package + '.' : '') + method.outputType);
        // client_streaming
        if (method.clientStreaming) mw.bool(5, true);
        // server_streaming
        if (method.serverStreaming) mw.bool(6, true);

        w.bytes(2, mw.finish());
    }

    return w.finish();
}

/**
 * Resolve a field type string to protobuf type number.
 * @private
 */
function _resolveFieldType(field, schema)
{
    if (PB_TYPE[field.type]) return PB_TYPE[field.type];
    if (schema.enums && schema.enums[field.type]) return PB_TYPE.enum;
    if (schema.messages && schema.messages[field.type]) return PB_TYPE.message;
    // Default to message type for unknown types (custom messages)
    return PB_TYPE.message;
}

// -- Reflection Request/Response Descriptors ----------------

const _reflectionRequestDesc = {
    name: 'ServerReflectionRequest',
    fields: [
        { name: 'host', type: 'string', number: 1, repeated: false, optional: false, map: false },
        { name: 'file_by_filename', type: 'string', number: 3, repeated: false, optional: false, map: false, oneofName: 'message_request' },
        { name: 'file_containing_symbol', type: 'string', number: 4, repeated: false, optional: false, map: false, oneofName: 'message_request' },
        { name: 'list_services', type: 'string', number: 7, repeated: false, optional: false, map: false, oneofName: 'message_request' },
    ],
};

const _reflectionResponseDesc = {
    name: 'ServerReflectionResponse',
    fields: [
        { name: 'valid_host', type: 'string', number: 1, repeated: false, optional: false, map: false },
        { name: 'original_request', type: 'ServerReflectionRequest', number: 2, repeated: false, optional: false, map: false },
        { name: 'file_descriptor_response', type: 'FileDescriptorResponse', number: 4, repeated: false, optional: false, map: false, oneofName: 'message_response' },
        { name: 'all_extension_numbers_response', type: 'ExtensionNumberResponse', number: 5, repeated: false, optional: false, map: false, oneofName: 'message_response' },
        { name: 'list_services_response', type: 'ListServiceResponse', number: 6, repeated: false, optional: false, map: false, oneofName: 'message_response' },
        { name: 'error_response', type: 'ErrorResponse', number: 7, repeated: false, optional: false, map: false, oneofName: 'message_response' },
    ],
};

const _fileDescriptorResponseDesc = {
    name: 'FileDescriptorResponse',
    fields: [
        { name: 'file_descriptor_proto', type: 'bytes', number: 1, repeated: true, optional: false, map: false },
    ],
};

const _listServiceResponseDesc = {
    name: 'ListServiceResponse',
    fields: [
        { name: 'service', type: 'ServiceResponse', number: 1, repeated: true, optional: false, map: false },
    ],
};

const _serviceResponseDesc = {
    name: 'ServiceResponse',
    fields: [
        { name: 'name', type: 'string', number: 1, repeated: false, optional: false, map: false },
    ],
};

const _errorResponseDesc = {
    name: 'ErrorResponse',
    fields: [
        { name: 'error_code', type: 'int32', number: 1, repeated: false, optional: false, map: false },
        { name: 'error_message', type: 'string', number: 2, repeated: false, optional: false, map: false },
    ],
};

const _reflectionMessages = {
    ServerReflectionRequest: _reflectionRequestDesc,
    ServerReflectionResponse: _reflectionResponseDesc,
    FileDescriptorResponse: _fileDescriptorResponseDesc,
    ListServiceResponse: _listServiceResponseDesc,
    ServiceResponse: _serviceResponseDesc,
    ErrorResponse: _errorResponseDesc,
};

// -- Reflection Service ----------------------------------------

/**
 * Server Reflection service implementation.
 * Caches serialized descriptors at registration time.
 *
 * @class
 */
class ReflectionService
{
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.production=false] - Enable in production.
     */
    constructor(opts = {})
    {
        /** @private */
        this._production = opts.production || false;

        /**
         * Registered schemas indexed by filename.
         * @type {Map<string, { schema: object, descriptor: Buffer }>}
         */
        this._files = new Map();

        /**
         * Symbol → filename mapping for file_containing_symbol lookups.
         * @type {Map<string, string>}
         */
        this._symbols = new Map();

        /**
         * All registered service names (fully qualified).
         * @type {string[]}
         */
        this._serviceNames = [];
    }

    /**
     * Register a schema for reflection.
     * Builds and caches the FileDescriptorProto at registration time.
     *
     * @param {object} schema - Parsed proto schema.
     * @param {string} [filename] - Filename to use. Defaults to schema package or '<inline>'.
     */
    addSchema(schema, filename)
    {
        const fname = filename || (schema.package ? schema.package.replace(/\./g, '/') + '.proto' : '<inline>');

        if (this._files.has(fname)) return; // already registered

        // Build and cache the serialized descriptor
        const descriptor = buildFileDescriptorProto(schema, fname);
        this._files.set(fname, { schema, descriptor });

        // Index symbols
        const prefix = schema.package ? schema.package + '.' : '';

        for (const name of Object.keys(schema.services))
        {
            const fqn = prefix + name;
            this._symbols.set(fqn, fname);
            this._serviceNames.push(fqn);

            // Index methods
            for (const methodName of Object.keys(schema.services[name].methods))
            {
                this._symbols.set(fqn + '.' + methodName, fname);
            }
        }

        for (const name of Object.keys(schema.messages))
        {
            if (!name.includes('.')) // only top-level
                this._symbols.set(prefix + name, fname);
        }

        for (const name of Object.keys(schema.enums))
        {
            if (!name.includes('.'))
                this._symbols.set(prefix + name, fname);
        }

        log.info('registered schema for reflection: %s (%d bytes)', fname, descriptor.length);
    }

    /**
     * Get the schema for server registration.
     * @returns {object}
     */
    getSchema()
    {
        return {
            package: 'grpc.reflection.v1',
            services: {
                ServerReflection: {
                    methods: {
                        ServerReflectionInfo: {
                            name: 'ServerReflectionInfo',
                            inputType: 'ServerReflectionRequest',
                            outputType: 'ServerReflectionResponse',
                            clientStreaming: true,
                            serverStreaming: true,
                        },
                    },
                },
            },
            messages: _reflectionMessages,
            enums: {},
        };
    }

    /**
     * Get the handler map.
     * @returns {Object<string, Function>}
     */
    getHandlers()
    {
        return {
            ServerReflectionInfo: (call) => this._handleReflection(call),
        };
    }

    /**
     * Handle the bidirectional reflection stream.
     * @private
     * @param {import('./call').BidiStreamCall} call
     */
    async _handleReflection(call)
    {
        for await (const req of call)
        {
            if (call._ended || call._cancelled) break;

            let response;

            if (req.list_services !== undefined)
            {
                response = this._listServices(req);
            }
            else if (req.file_by_filename)
            {
                response = this._fileByFilename(req);
            }
            else if (req.file_containing_symbol)
            {
                response = this._fileContainingSymbol(req);
            }
            else
            {
                response = {
                    valid_host: req.host || '',
                    error_response: {
                        error_code: GrpcStatus.UNIMPLEMENTED,
                        error_message: 'Unsupported reflection request type',
                    },
                };
            }

            call.write(response);
        }

        if (!call._ended) call.end();
    }

    /**
     * Handle list_services request.
     * @private
     */
    _listServices(req)
    {
        const services = this._serviceNames.map(name => ({ name }));

        // Always include the reflection service itself
        if (!services.find(s => s.name === 'grpc.reflection.v1.ServerReflection'))
            services.push({ name: 'grpc.reflection.v1.ServerReflection' });

        return {
            valid_host: req.host || '',
            list_services_response: { service: services },
        };
    }

    /**
     * Handle file_by_filename request.
     * @private
     */
    _fileByFilename(req)
    {
        const entry = this._files.get(req.file_by_filename);
        if (!entry)
        {
            return {
                valid_host: req.host || '',
                error_response: {
                    error_code: GrpcStatus.NOT_FOUND,
                    error_message: `File not found: ${req.file_by_filename}`,
                },
            };
        }

        return {
            valid_host: req.host || '',
            file_descriptor_response: {
                file_descriptor_proto: [entry.descriptor],
            },
        };
    }

    /**
     * Handle file_containing_symbol request.
     * @private
     */
    _fileContainingSymbol(req)
    {
        const filename = this._symbols.get(req.file_containing_symbol);
        if (!filename)
        {
            return {
                valid_host: req.host || '',
                error_response: {
                    error_code: GrpcStatus.NOT_FOUND,
                    error_message: `Symbol not found: ${req.file_containing_symbol}`,
                },
            };
        }

        const entry = this._files.get(filename);
        return {
            valid_host: req.host || '',
            file_descriptor_response: {
                file_descriptor_proto: [entry.descriptor],
            },
        };
    }
}

module.exports = {
    ReflectionService,
    buildFileDescriptorProto,
};
