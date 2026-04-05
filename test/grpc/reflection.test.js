const { ReflectionService, buildFileDescriptorProto } = require('../../lib/grpc/reflection');

// -- Sample schema for testing ---

function sampleSchema()
{
    return {
        package: 'test.v1',
        syntax: 'proto3',
        services: {
            Greeter: {
                name: 'Greeter',
                methods: {
                    SayHello: {
                        name: 'SayHello',
                        inputType: 'HelloRequest',
                        outputType: 'HelloReply',
                        clientStreaming: false,
                        serverStreaming: false,
                    },
                    StreamGreeting: {
                        name: 'StreamGreeting',
                        inputType: 'HelloRequest',
                        outputType: 'HelloReply',
                        clientStreaming: false,
                        serverStreaming: true,
                    },
                },
            },
        },
        messages: {
            HelloRequest: {
                name: 'HelloRequest',
                fields: [
                    { name: 'name', type: 'string', number: 1, repeated: false, map: false },
                ],
            },
            HelloReply: {
                name: 'HelloReply',
                fields: [
                    { name: 'message', type: 'string', number: 1, repeated: false, map: false },
                ],
            },
        },
        enums: {},
    };
}

// =========================================================
// buildFileDescriptorProto
// =========================================================

describe('buildFileDescriptorProto', () =>
{
    it('should produce a non-empty Buffer', () =>
    {
        const result = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
    });

    it('should produce deterministic output for same inputs', () =>
    {
        const a = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        const b = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        expect(a.equals(b)).toBe(true);
    });

    it('should include filename in descriptor', () =>
    {
        const result = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        // field 1 (name) should contain our filename
        expect(result.includes(Buffer.from('test.proto'))).toBe(true);
    });

    it('should include package name', () =>
    {
        const result = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        expect(result.includes(Buffer.from('test.v1'))).toBe(true);
    });

    it('should include syntax string', () =>
    {
        const result = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        expect(result.includes(Buffer.from('proto3'))).toBe(true);
    });

    it('should handle schema without package', () =>
    {
        const schema = { ...sampleSchema(), package: undefined };
        const result = buildFileDescriptorProto(schema, 'no-pkg.proto');
        expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should handle schema with imports', () =>
    {
        const schema = {
            ...sampleSchema(),
            imports: [{ path: 'google/protobuf/timestamp.proto' }],
        };
        const result = buildFileDescriptorProto(schema, 'test.proto');
        expect(result.includes(Buffer.from('google/protobuf/timestamp.proto'))).toBe(true);
    });

    it('should handle schema with enums', () =>
    {
        const schema = {
            ...sampleSchema(),
            enums: {
                Status: {
                    name: 'Status',
                    values: { UNKNOWN: 0, ACTIVE: 1, INACTIVE: 2 },
                },
            },
        };
        const result = buildFileDescriptorProto(schema, 'test.proto');
        expect(result.includes(Buffer.from('Status'))).toBe(true);
    });

    it('should handle streaming methods', () =>
    {
        const result = buildFileDescriptorProto(sampleSchema(), 'test.proto');
        // StreamGreeting should be present
        expect(result.includes(Buffer.from('StreamGreeting'))).toBe(true);
    });
});

// =========================================================
// ReflectionService
// =========================================================

describe('ReflectionService', () =>
{
    let svc;

    beforeEach(() =>
    {
        svc = new ReflectionService();
    });

    // --- addSchema ---

    it('should register a schema', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        expect(svc._files.has('test.proto')).toBe(true);
    });

    it('should auto-generate filename from package', () =>
    {
        svc.addSchema(sampleSchema());
        expect(svc._files.has('test/v1.proto')).toBe(true);
    });

    it('should use <inline> when no package or filename', () =>
    {
        const schema = { ...sampleSchema(), package: undefined };
        svc.addSchema(schema);
        expect(svc._files.has('<inline>')).toBe(true);
    });

    it('should not re-register same filename', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const size1 = svc._files.size;
        svc.addSchema(sampleSchema(), 'test.proto');
        expect(svc._files.size).toBe(size1);
    });

    it('should index service names', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        expect(svc._serviceNames).toContain('test.v1.Greeter');
    });

    it('should index method symbols', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        expect(svc._symbols.has('test.v1.Greeter.SayHello')).toBe(true);
        expect(svc._symbols.has('test.v1.Greeter.StreamGreeting')).toBe(true);
    });

    it('should index message symbols', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        expect(svc._symbols.has('test.v1.HelloRequest')).toBe(true);
        expect(svc._symbols.has('test.v1.HelloReply')).toBe(true);
    });

    // --- _listServices ---

    it('should list registered services', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._listServices({ host: '' });
        expect(result.list_services_response.service).toEqual(
            expect.arrayContaining([{ name: 'test.v1.Greeter' }])
        );
    });

    it('should always include the reflection service itself', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._listServices({ host: '' });
        const names = result.list_services_response.service.map(s => s.name);
        expect(names).toContain('grpc.reflection.v1.ServerReflection');
    });

    it('should return empty list when no schemas registered', () =>
    {
        const result = svc._listServices({ host: '' });
        const names = result.list_services_response.service.map(s => s.name);
        // Should still have the reflection service
        expect(names).toContain('grpc.reflection.v1.ServerReflection');
    });

    // --- _fileByFilename ---

    it('should return descriptor for registered filename', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._fileByFilename({ file_by_filename: 'test.proto' });
        expect(result.file_descriptor_response).toBeDefined();
        expect(result.file_descriptor_response.file_descriptor_proto).toHaveLength(1);
    });

    it('should return error for unknown filename', () =>
    {
        const result = svc._fileByFilename({ file_by_filename: 'unknown.proto' });
        expect(result.error_response).toBeDefined();
        expect(result.error_response.error_message).toContain('File not found');
    });

    // --- _fileContainingSymbol ---

    it('should find file by service symbol', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._fileContainingSymbol({ file_containing_symbol: 'test.v1.Greeter' });
        expect(result.file_descriptor_response).toBeDefined();
    });

    it('should find file by method symbol', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._fileContainingSymbol({ file_containing_symbol: 'test.v1.Greeter.SayHello' });
        expect(result.file_descriptor_response).toBeDefined();
    });

    it('should find file by message symbol', () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');
        const result = svc._fileContainingSymbol({ file_containing_symbol: 'test.v1.HelloRequest' });
        expect(result.file_descriptor_response).toBeDefined();
    });

    it('should return error for unknown symbol', () =>
    {
        const result = svc._fileContainingSymbol({ file_containing_symbol: 'unknown.Symbol' });
        expect(result.error_response).toBeDefined();
        expect(result.error_response.error_message).toContain('Symbol not found');
    });

    // --- getSchema ---

    it('should return a valid reflection schema', () =>
    {
        const schema = svc.getSchema();
        expect(schema.package).toBe('grpc.reflection.v1');
        expect(schema.services.ServerReflection).toBeDefined();
        expect(schema.services.ServerReflection.methods.ServerReflectionInfo).toBeDefined();
        expect(schema.services.ServerReflection.methods.ServerReflectionInfo.clientStreaming).toBe(true);
        expect(schema.services.ServerReflection.methods.ServerReflectionInfo.serverStreaming).toBe(true);
    });

    // --- getHandlers ---

    it('should return bound handlers', () =>
    {
        const handlers = svc.getHandlers();
        expect(typeof handlers.ServerReflectionInfo).toBe('function');
    });

    // --- _handleReflection (simulated bidi stream) ---

    it('should handle list_services request via stream', async () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');

        const written = [];
        let ended = false;

        // Simulate an async iterable call
        const messages = [{ list_services: '' }];

        const call = {
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            end() { ended = true; },
            [Symbol.asyncIterator]()
            {
                let i = 0;
                return {
                    next()
                    {
                        if (i < messages.length)
                            return Promise.resolve({ value: messages[i++], done: false });
                        return Promise.resolve({ done: true });
                    },
                };
            },
        };

        await svc._handleReflection(call);

        expect(written).toHaveLength(1);
        expect(written[0].list_services_response).toBeDefined();
        expect(ended).toBe(true);
    });

    it('should handle file_by_filename request via stream', async () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');

        const written = [];
        const messages = [{ file_by_filename: 'test.proto' }];

        const call = {
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            end() {},
            [Symbol.asyncIterator]()
            {
                let i = 0;
                return {
                    next()
                    {
                        if (i < messages.length)
                            return Promise.resolve({ value: messages[i++], done: false });
                        return Promise.resolve({ done: true });
                    },
                };
            },
        };

        await svc._handleReflection(call);
        expect(written[0].file_descriptor_response).toBeDefined();
    });

    it('should handle file_containing_symbol request via stream', async () =>
    {
        svc.addSchema(sampleSchema(), 'test.proto');

        const written = [];
        const messages = [{ file_containing_symbol: 'test.v1.Greeter' }];

        const call = {
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            end() {},
            [Symbol.asyncIterator]()
            {
                let i = 0;
                return {
                    next()
                    {
                        if (i < messages.length)
                            return Promise.resolve({ value: messages[i++], done: false });
                        return Promise.resolve({ done: true });
                    },
                };
            },
        };

        await svc._handleReflection(call);
        expect(written[0].file_descriptor_response).toBeDefined();
    });

    it('should return UNIMPLEMENTED for unknown request type', async () =>
    {
        const written = [];
        const messages = [{ unknown_field: 'test' }];

        const call = {
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            end() {},
            [Symbol.asyncIterator]()
            {
                let i = 0;
                return {
                    next()
                    {
                        if (i < messages.length)
                            return Promise.resolve({ value: messages[i++], done: false });
                        return Promise.resolve({ done: true });
                    },
                };
            },
        };

        await svc._handleReflection(call);
        expect(written[0].error_response).toBeDefined();
        expect(written[0].error_response.error_message).toContain('Unsupported');
    });

    // --- Multiple schemas ---

    it('should handle multiple registered schemas', () =>
    {
        svc.addSchema(sampleSchema(), 'greeter.proto');

        const schema2 = {
            package: 'test.v1',
            services: {
                Echo: {
                    name: 'Echo',
                    methods: {
                        Ping: {
                            name: 'Ping',
                            inputType: 'PingRequest',
                            outputType: 'PingResponse',
                        },
                    },
                },
            },
            messages: {
                PingRequest: { name: 'PingRequest', fields: [] },
                PingResponse: { name: 'PingResponse', fields: [] },
            },
            enums: {},
        };
        svc.addSchema(schema2, 'echo.proto');

        const result = svc._listServices({ host: '' });
        const names = result.list_services_response.service.map(s => s.name);
        expect(names).toContain('test.v1.Greeter');
        expect(names).toContain('test.v1.Echo');
    });
});
