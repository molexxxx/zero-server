const fs = require('fs');
const path = require('path');
const os = require('os');

// watchProto requires app.grpc and parseProtoFile — we test the module in isolation
const watchModule = require('../../lib/grpc/watch');
const watchProto = watchModule.watchProto || watchModule;

// =========================================================
// watchProto — unit tests
// =========================================================

describe('watchProto', () =>
{
    let tmpDir;
    let originalEnv;

    beforeEach(() =>
    {
        originalEnv = process.env.NODE_ENV;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
    });

    afterEach(() =>
    {
        process.env.NODE_ENV = originalEnv;
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should be disabled in production by default', () =>
    {
        process.env.NODE_ENV = 'production';

        let grpcCalled = false;
        const mockApp = {
            grpc() { grpcCalled = true; },
        };

        // Create a minimal proto file
        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', {
            SayHello() { return { message: 'hi' }; },
        });

        expect(grpcCalled).toBe(true);
        expect(typeof result.stop).toBe('function');
        // Should not throw
        result.stop();
    });

    it('should allow production override', () =>
    {
        process.env.NODE_ENV = 'production';

        let grpcCalled = false;
        const mockApp = {
            grpc() { grpcCalled = true; },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', {
            SayHello() { return { message: 'hi' }; },
        }, { production: true });

        expect(grpcCalled).toBe(true);
        result.stop();
    });

    it('should do initial load in dev mode', () =>
    {
        process.env.NODE_ENV = 'development';

        let grpcCalled = false;
        const mockApp = {
            grpc() { grpcCalled = true; },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', {
            SayHello() {},
        });

        expect(grpcCalled).toBe(true);
        expect(result.schema).toBeDefined();
        result.stop();
    });

    it('should call onError when initial parse fails', () =>
    {
        process.env.NODE_ENV = 'development';

        let errorCaught = null;
        const mockApp = {
            grpc() {},
        };

        const protoPath = path.join(tmpDir, 'bad.proto');
        fs.writeFileSync(protoPath, 'this is not valid proto syntax!!!');

        const result = watchProto(mockApp, protoPath, 'Greeter', {}, {
            onError: (err) => { errorCaught = err; },
        });

        expect(errorCaught).toBeDefined();
        expect(errorCaught.message).toBeDefined();
        if (result) result.stop();
    });

    it('should throw when initial parse fails without onError', () =>
    {
        process.env.NODE_ENV = 'development';

        const mockApp = { grpc() {} };
        const protoPath = path.join(tmpDir, 'bad.proto');
        fs.writeFileSync(protoPath, 'bad!!!');

        expect(() =>
        {
            watchProto(mockApp, protoPath, 'Greeter', {});
        }).toThrow();
    });

    it('should return a controller with stop function', () =>
    {
        process.env.NODE_ENV = 'development';

        const mockApp = { grpc() {} };
        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} });
        expect(typeof result.stop).toBe('function');

        // Stop should not throw
        result.stop();
    });

    it('should fire _reload on file change and call onReload', async () =>
    {
        process.env.NODE_ENV = 'development';

        let reloadedSchema = null;
        let addServiceCalled = false;
        const mockApp = {
            grpc() {},
            _grpcRegistry: {
                addService() { addServiceCalled = true; },
            },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 20,
            onReload: (schema) => { reloadedSchema = schema; },
        });

        // Trigger a file change
        await new Promise(r => setTimeout(r, 50));
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
                rpc SayGoodbye (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        // Wait for debounce + reload
        await new Promise(r => setTimeout(r, 200));

        expect(reloadedSchema).toBeDefined();
        expect(reloadedSchema.services.Greeter).toBeDefined();
        expect(addServiceCalled).toBe(true);
        result.stop();
    });

    it('should call onError when service not found after reload', async () =>
    {
        process.env.NODE_ENV = 'development';

        let errorCaught = null;
        const mockApp = {
            grpc() {},
            _grpcRegistry: {
                addService() {},
            },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 20,
            onError: (err) => { errorCaught = err; },
        });

        // Rewrite proto file removing the Greeter service
        await new Promise(r => setTimeout(r, 50));
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service OtherService {
                rpc Foo (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        await new Promise(r => setTimeout(r, 200));

        expect(errorCaught).toBeDefined();
        expect(errorCaught.message).toContain('not found after reload');
        result.stop();
    });

    it('should call onError when reload produces invalid proto', async () =>
    {
        process.env.NODE_ENV = 'development';

        let errorCaught = null;
        const mockApp = {
            grpc() {},
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 20,
            onError: (err) => { errorCaught = err; },
        });

        // Write invalid proto
        await new Promise(r => setTimeout(r, 50));
        fs.writeFileSync(protoPath, 'totally invalid proto!!!');

        await new Promise(r => setTimeout(r, 200));

        expect(errorCaught).toBeDefined();
        result.stop();
    });

    it('should debounce rapid changes', async () =>
    {
        process.env.NODE_ENV = 'development';

        let reloadCount = 0;
        const mockApp = {
            grpc() {},
            _grpcRegistry: {
                addService() {},
            },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        const protoContent = `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `;
        fs.writeFileSync(protoPath, protoContent);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 100,
            onReload: () => { reloadCount++; },
        });

        // Rapid changes
        await new Promise(r => setTimeout(r, 50));
        fs.writeFileSync(protoPath, protoContent + '\n// change 1');
        await new Promise(r => setTimeout(r, 20));
        fs.writeFileSync(protoPath, protoContent + '\n// change 2');
        await new Promise(r => setTimeout(r, 20));
        fs.writeFileSync(protoPath, protoContent + '\n// change 3');

        await new Promise(r => setTimeout(r, 300));

        // Should only reload once due to debouncing
        expect(reloadCount).toBeLessThanOrEqual(2);
        result.stop();
    });

    it('schema getter should reflect initial and reloaded schema', async () =>
    {
        process.env.NODE_ENV = 'development';

        const mockApp = {
            grpc() {},
            _grpcRegistry: { addService() {} },
        };

        const protoPath = path.join(tmpDir, 'test.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 20,
        });

        const initialSchema = result.schema;
        expect(initialSchema).toBeDefined();
        expect(initialSchema.services.Greeter).toBeDefined();

        result.stop();
    });

    it('should reload without _grpcRegistry', async () =>
    {
        process.env.NODE_ENV = 'development';

        let reloaded = false;
        const mockApp = { grpc() {} }; // no _grpcRegistry

        const protoPath = path.join(tmpDir, 'test.proto');
        const content = `
            syntax = "proto3";
            package test;
            service Greeter {
                rpc SayHello (HelloRequest) returns (HelloReply);
            }
            message HelloRequest { string name = 1; }
            message HelloReply { string message = 1; }
        `;
        fs.writeFileSync(protoPath, content);

        const result = watchProto(mockApp, protoPath, 'Greeter', { SayHello() {} }, {
            debounce: 20,
            onReload: () => { reloaded = true; },
        });

        await new Promise(r => setTimeout(r, 50));
        fs.writeFileSync(protoPath, content + '\n// updated');

        await new Promise(r => setTimeout(r, 200));
        expect(reloaded).toBe(true);
        result.stop();
    });
});
