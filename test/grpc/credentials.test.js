const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChannelCredentials, CredentialType, createRotatingCredentials } = require('../../lib/grpc/credentials');

// =========================================================
// CredentialType enum
// =========================================================

describe('CredentialType', () =>
{
    it('should have correct values', () =>
    {
        expect(CredentialType.INSECURE).toBe('insecure');
        expect(CredentialType.SSL).toBe('ssl');
        expect(CredentialType.METADATA).toBe('metadata');
        expect(CredentialType.COMPOSITE).toBe('composite');
    });
});

// =========================================================
// ChannelCredentials.createInsecure
// =========================================================

describe('ChannelCredentials.createInsecure', () =>
{
    it('should create insecure credentials', () =>
    {
        const creds = ChannelCredentials.createInsecure();
        expect(creds.type).toBe(CredentialType.INSECURE);
    });

    it('should not be secure', () =>
    {
        const creds = ChannelCredentials.createInsecure();
        expect(creds.isSecure()).toBe(false);
    });

    it('should return null connection options', () =>
    {
        const creds = ChannelCredentials.createInsecure();
        expect(creds.getConnectionOptions()).toBeNull();
    });

    it('should generate empty metadata', async () =>
    {
        const creds = ChannelCredentials.createInsecure();
        const md = await creds.generateMetadata({});
        expect(md).toEqual({});
    });
});

// =========================================================
// ChannelCredentials.createSsl
// =========================================================

describe('ChannelCredentials.createSsl', () =>
{
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----');
    const key = Buffer.from('-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----');
    const cert = Buffer.from('-----BEGIN CERTIFICATE-----\nfake-cert\n-----END CERTIFICATE-----');

    it('should create SSL credentials with CA only', () =>
    {
        const creds = ChannelCredentials.createSsl(ca);
        expect(creds.type).toBe(CredentialType.SSL);
        expect(creds.isSecure()).toBe(true);
    });

    it('should create mTLS credentials', () =>
    {
        const creds = ChannelCredentials.createSsl(ca, key, cert);
        expect(creds.isSecure()).toBe(true);
        const opts = creds.getConnectionOptions();
        expect(opts.ca).toBeDefined();
        expect(opts.key).toBeDefined();
        expect(opts.cert).toBeDefined();
    });

    it('should convert string inputs to Buffers', () =>
    {
        const creds = ChannelCredentials.createSsl('ca-string', 'key-string', 'cert-string');
        const opts = creds.getConnectionOptions();
        expect(Buffer.isBuffer(opts.ca)).toBe(true);
        expect(Buffer.isBuffer(opts.key)).toBe(true);
        expect(Buffer.isBuffer(opts.cert)).toBe(true);
    });

    it('should default rejectUnauthorized to true', () =>
    {
        const creds = ChannelCredentials.createSsl(ca);
        const opts = creds.getConnectionOptions();
        expect(opts.rejectUnauthorized).toBe(true);
    });

    it('should allow rejectUnauthorized to be false', () =>
    {
        const creds = ChannelCredentials.createSsl(ca, null, null, { rejectUnauthorized: false });
        const opts = creds.getConnectionOptions();
        expect(opts.rejectUnauthorized).toBe(false);
    });

    it('should throw when key provided without cert', () =>
    {
        expect(() => ChannelCredentials.createSsl(ca, key)).toThrow('without client certificate');
    });

    it('should throw when cert provided without key', () =>
    {
        expect(() => ChannelCredentials.createSsl(ca, null, cert)).toThrow('without client key');
    });

    it('should handle null rootCerts (system defaults)', () =>
    {
        const creds = ChannelCredentials.createSsl(null);
        expect(creds.isSecure()).toBe(true);
        const opts = creds.getConnectionOptions();
        expect(opts.ca).toBeUndefined();
    });

    it('should generate empty metadata', async () =>
    {
        const creds = ChannelCredentials.createSsl(ca);
        const md = await creds.generateMetadata({});
        expect(md).toEqual({});
    });
});

// =========================================================
// ChannelCredentials.createSslFromFiles
// =========================================================

describe('ChannelCredentials.createSslFromFiles', () =>
{
    let tmpDir;
    let caPath, keyPath, certPath;

    beforeEach(() =>
    {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-test-'));
        caPath = path.join(tmpDir, 'ca.pem');
        keyPath = path.join(tmpDir, 'client.key');
        certPath = path.join(tmpDir, 'client.pem');
        fs.writeFileSync(caPath, 'fake-ca');
        fs.writeFileSync(keyPath, 'fake-key');
        fs.writeFileSync(certPath, 'fake-cert');
    });

    afterEach(() =>
    {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should read files and create SSL credentials', () =>
    {
        const creds = ChannelCredentials.createSslFromFiles(caPath, keyPath, certPath);
        expect(creds.isSecure()).toBe(true);
        const opts = creds.getConnectionOptions();
        expect(opts.ca.toString()).toBe('fake-ca');
    });

    it('should handle null paths', () =>
    {
        const creds = ChannelCredentials.createSslFromFiles(caPath, null, null);
        expect(creds.isSecure()).toBe(true);
    });

    it('should throw for non-existent file', () =>
    {
        expect(() => ChannelCredentials.createSslFromFiles('/nonexistent/ca.pem')).toThrow();
    });
});

// =========================================================
// ChannelCredentials.createFromMetadata
// =========================================================

describe('ChannelCredentials.createFromMetadata', () =>
{
    it('should create metadata credentials', () =>
    {
        const creds = ChannelCredentials.createFromMetadata(() => ({ authorization: 'Bearer token' }));
        expect(creds.type).toBe(CredentialType.METADATA);
    });

    it('should not be secure', () =>
    {
        const creds = ChannelCredentials.createFromMetadata(() => ({}));
        expect(creds.isSecure()).toBe(false);
    });

    it('should throw for non-function', () =>
    {
        expect(() => ChannelCredentials.createFromMetadata('not-a-function')).toThrow('requires a function');
    });

    it('should generate metadata from sync generator', async () =>
    {
        const creds = ChannelCredentials.createFromMetadata(() => ({ 'x-api-key': 'abc' }));
        const md = await creds.generateMetadata({ serviceUrl: 'http://test', methodName: 'SayHello' });
        expect(md['x-api-key']).toBe('abc');
    });

    it('should generate metadata from async generator', async () =>
    {
        const creds = ChannelCredentials.createFromMetadata(async () => ({ 'x-api-key': 'async' }));
        const md = await creds.generateMetadata({});
        expect(md['x-api-key']).toBe('async');
    });

    it('should pass params to generator', async () =>
    {
        let receivedParams = null;
        const creds = ChannelCredentials.createFromMetadata((params) =>
        {
            receivedParams = params;
            return {};
        });
        await creds.generateMetadata({ serviceUrl: 'http://test', methodName: 'Ping' });
        expect(receivedParams.serviceUrl).toBe('http://test');
        expect(receivedParams.methodName).toBe('Ping');
    });
});

// =========================================================
// ChannelCredentials.combine
// =========================================================

describe('ChannelCredentials.combine', () =>
{
    it('should combine SSL and metadata credentials', () =>
    {
        const ssl = ChannelCredentials.createSsl(Buffer.from('ca'));
        const md = ChannelCredentials.createFromMetadata(() => ({ auth: 'Bearer token' }));
        const combined = ChannelCredentials.combine(ssl, md);

        expect(combined.type).toBe(CredentialType.COMPOSITE);
        expect(combined.isSecure()).toBe(true);
    });

    it('should throw for multiple channel credentials', () =>
    {
        const ssl1 = ChannelCredentials.createSsl(Buffer.from('ca'));
        const ssl2 = ChannelCredentials.createSsl(Buffer.from('ca2'));
        expect(() => ChannelCredentials.combine(ssl1, ssl2)).toThrow('multiple channel credentials');
    });

    it('should throw for non-ChannelCredentials arguments', () =>
    {
        expect(() => ChannelCredentials.combine({ type: 'fake' })).toThrow('ChannelCredentials instances');
    });

    it('should merge multiple metadata generators', async () =>
    {
        const md1 = ChannelCredentials.createFromMetadata(() => ({ 'x-key-1': 'val1' }));
        const md2 = ChannelCredentials.createFromMetadata(() => ({ 'x-key-2': 'val2' }));
        const combined = ChannelCredentials.combine(md1, md2);

        const md = await combined.generateMetadata({});
        expect(md['x-key-1']).toBe('val1');
        expect(md['x-key-2']).toBe('val2');
    });

    it('should get connection options from embedded channel credential', () =>
    {
        const ssl = ChannelCredentials.createSsl(Buffer.from('ca'));
        const md = ChannelCredentials.createFromMetadata(() => ({}));
        const combined = ChannelCredentials.combine(ssl, md);

        const opts = combined.getConnectionOptions();
        expect(opts).toBeDefined();
        expect(opts.ca.toString()).toBe('ca');
    });

    it('should flatten nested composites', () =>
    {
        const ssl = ChannelCredentials.createSsl(Buffer.from('ca'));
        const md1 = ChannelCredentials.createFromMetadata(() => ({ a: '1' }));
        const composite1 = ChannelCredentials.combine(ssl, md1);

        const md2 = ChannelCredentials.createFromMetadata(() => ({ b: '2' }));
        const combined = ChannelCredentials.combine(composite1, md2);

        expect(combined.type).toBe(CredentialType.COMPOSITE);
        expect(combined.isSecure()).toBe(true);
    });

    it('should not be secure when combining metadata-only credentials', () =>
    {
        const md1 = ChannelCredentials.createFromMetadata(() => ({}));
        const md2 = ChannelCredentials.createFromMetadata(() => ({}));
        const combined = ChannelCredentials.combine(md1, md2);
        expect(combined.isSecure()).toBe(false);
    });

    it('should handle insecure + metadata combination', () =>
    {
        const insecure = ChannelCredentials.createInsecure();
        const md = ChannelCredentials.createFromMetadata(() => ({ auth: 'x' }));
        const combined = ChannelCredentials.combine(insecure, md);

        expect(combined.isSecure()).toBe(false);
        expect(combined.getConnectionOptions()).toBeNull();
    });
});

// =========================================================
// createRotatingCredentials
// =========================================================

describe('createRotatingCredentials', () =>
{
    let tmpDir;

    beforeEach(() =>
    {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-test-'));
        fs.writeFileSync(path.join(tmpDir, 'ca.pem'), 'ca-data');
    });

    afterEach(() =>
    {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should throw without caPath', () =>
    {
        expect(() => createRotatingCredentials({})).toThrow('caPath');
    });

    it('should throw with null opts', () =>
    {
        expect(() => createRotatingCredentials(null)).toThrow();
    });

    it('should return getCurrent and stop functions', () =>
    {
        const rotating = createRotatingCredentials({
            caPath: path.join(tmpDir, 'ca.pem'),
        });

        expect(typeof rotating.getCurrent).toBe('function');
        expect(typeof rotating.stop).toBe('function');

        const creds = rotating.getCurrent();
        expect(creds).toBeInstanceOf(ChannelCredentials);
        expect(creds.isSecure()).toBe(true);

        rotating.stop();
    });

    it('should stop cleanly', () =>
    {
        const rotating = createRotatingCredentials({
            caPath: path.join(tmpDir, 'ca.pem'),
            pollInterval: 100,
        });

        // Should not throw
        rotating.stop();
        rotating.stop(); // double stop is safe
    });
});
