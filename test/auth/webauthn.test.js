const crypto = require('crypto');
const {
    webauthn,
    _cbor: cbor,
    _parseAuthData,
    _coseToPublicKey,
    _coseAlgToNodeAlg,
    _toBase64Url,
    _fromBase64Url,
    COSE_ALG,
    COSE_KEY_TYPE,
} = require('../../lib/auth/webauthn');

// =========================================================
// CBOR decoder
// =========================================================

describe('CBOR decoder', () =>
{
    it('should decode an unsigned integer (small)', () =>
    {
        // CBOR for 10: 0x0a
        const result = cbor.decode(Buffer.from([0x0a]));
        expect(result).toBe(10);
    });

    it('should decode an unsigned integer (24)', () =>
    {
        // CBOR for 24: 0x18 0x18
        const result = cbor.decode(Buffer.from([0x18, 0x18]));
        expect(result).toBe(24);
    });

    it('should decode an unsigned integer (256)', () =>
    {
        // CBOR for 256: 0x19 0x01 0x00
        const result = cbor.decode(Buffer.from([0x19, 0x01, 0x00]));
        expect(result).toBe(256);
    });

    it('should decode an unsigned integer (65536)', () =>
    {
        // CBOR for 65536: 0x1a 0x00 0x01 0x00 0x00
        const result = cbor.decode(Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00]));
        expect(result).toBe(65536);
    });

    it('should decode a negative integer', () =>
    {
        // CBOR for -1: 0x20
        const result = cbor.decode(Buffer.from([0x20]));
        expect(result).toBe(-1);
    });

    it('should decode a negative integer -10: 0x29', () =>
    {
        const result = cbor.decode(Buffer.from([0x29]));
        expect(result).toBe(-10);
    });

    it('should decode a byte string', () =>
    {
        // CBOR for byte string [0x01, 0x02, 0x03]: 0x43 0x01 0x02 0x03
        const result = cbor.decode(Buffer.from([0x43, 0x01, 0x02, 0x03]));
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    });

    it('should decode a text string', () =>
    {
        // CBOR for "hi": 0x62 0x68 0x69
        const result = cbor.decode(Buffer.from([0x62, 0x68, 0x69]));
        expect(result).toBe('hi');
    });

    it('should decode an empty text string', () =>
    {
        const result = cbor.decode(Buffer.from([0x60]));
        expect(result).toBe('');
    });

    it('should decode an array', () =>
    {
        // CBOR for [1, 2, 3]: 0x83 0x01 0x02 0x03
        const result = cbor.decode(Buffer.from([0x83, 0x01, 0x02, 0x03]));
        expect(result).toEqual([1, 2, 3]);
    });

    it('should decode an empty array', () =>
    {
        const result = cbor.decode(Buffer.from([0x80]));
        expect(result).toEqual([]);
    });

    it('should decode a map', () =>
    {
        // CBOR for {1: 2}: 0xa1 0x01 0x02
        const result = cbor.decode(Buffer.from([0xa1, 0x01, 0x02]));
        expect(result).toEqual({ 1: 2 });
    });

    it('should decode boolean false', () =>
    {
        const result = cbor.decode(Buffer.from([0xf4]));
        expect(result).toBe(false);
    });

    it('should decode boolean true', () =>
    {
        const result = cbor.decode(Buffer.from([0xf5]));
        expect(result).toBe(true);
    });

    it('should decode null', () =>
    {
        const result = cbor.decode(Buffer.from([0xf6]));
        expect(result).toBeNull();
    });

    it('should decode undefined', () =>
    {
        const result = cbor.decode(Buffer.from([0xf7]));
        expect(result).toBeUndefined();
    });

    it('should throw on unsupported additional info', () =>
    {
        // major type 0, additional info 28 (reserved)
        expect(() => cbor.decode(Buffer.from([0x1c]))).toThrow();
    });
});

// =========================================================
// Base64URL helpers
// =========================================================

describe('Base64URL helpers', () =>
{
    it('should roundtrip Buffer through base64url', () =>
    {
        const buf = crypto.randomBytes(32);
        const encoded = _toBase64Url(buf);
        const decoded = _fromBase64Url(encoded);
        expect(decoded).toEqual(buf);
    });

    it('should handle empty buffer', () =>
    {
        const encoded = _toBase64Url(Buffer.alloc(0));
        expect(encoded).toBe('');
        const decoded = _fromBase64Url('');
        expect(decoded).toEqual(Buffer.alloc(0));
    });

    it('should handle string input in toBase64Url', () =>
    {
        const encoded = _toBase64Url('hello');
        const decoded = _fromBase64Url(encoded);
        expect(decoded.toString('utf8')).toBe('hello');
    });

    it('should produce URL-safe characters (no +, /, =)', () =>
    {
        // Generate many random buffers to hit all encodings
        for (let i = 0; i < 50; i++)
        {
            const buf = crypto.randomBytes(32);
            const encoded = _toBase64Url(buf);
            expect(encoded).not.toMatch(/[+/=]/);
        }
    });
});

// =========================================================
// COSE key constants
// =========================================================

describe('COSE constants', () =>
{
    it('should have correct algorithm values', () =>
    {
        expect(COSE_ALG.ES256).toBe(-7);
        expect(COSE_ALG.RS256).toBe(-257);
        expect(COSE_ALG.EDDSA).toBe(-8);
    });

    it('should have correct key type values', () =>
    {
        expect(COSE_KEY_TYPE.OKP).toBe(1);
        expect(COSE_KEY_TYPE.EC2).toBe(2);
        expect(COSE_KEY_TYPE.RSA).toBe(3);
    });
});

// =========================================================
// generateRegistrationOptions
// =========================================================

describe('webauthn.generateRegistrationOptions', () =>
{
    it('should generate valid options with challenge', () =>
    {
        const { options, challenge } = webauthn.generateRegistrationOptions({
            rpName: 'Test App',
            rpId: 'test.com',
            userId: 'user-123',
            userName: 'test@test.com',
        });

        expect(options.rp.name).toBe('Test App');
        expect(options.rp.id).toBe('test.com');
        expect(options.user.name).toBe('test@test.com');
        expect(options.user.id).toBeDefined();
        expect(challenge).toBeDefined();
        expect(typeof challenge).toBe('string');
        expect(options.pubKeyCredParams).toHaveLength(3);
        expect(options.timeout).toBe(60000);
        expect(options.attestation).toBe('none');
    });

    it('should throw without rpName', () =>
    {
        expect(() => webauthn.generateRegistrationOptions({
            rpId: 'test.com', userId: '1', userName: 'x',
        })).toThrow('rpName');
    });

    it('should throw without rpId', () =>
    {
        expect(() => webauthn.generateRegistrationOptions({
            rpName: 'X', userId: '1', userName: 'x',
        })).toThrow('rpId');
    });

    it('should throw without userId', () =>
    {
        expect(() => webauthn.generateRegistrationOptions({
            rpName: 'X', rpId: 'x.com', userName: 'x',
        })).toThrow('userId');
    });

    it('should throw without userName', () =>
    {
        expect(() => webauthn.generateRegistrationOptions({
            rpName: 'X', rpId: 'x.com', userId: '1',
        })).toThrow('userName');
    });

    it('should throw with null opts', () =>
    {
        expect(() => webauthn.generateRegistrationOptions(null)).toThrow();
    });

    it('should include excludeCredentials when provided', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com', userId: '1', userName: 'test',
            excludeCredentials: [
                { id: 'cred-1', transports: ['usb'] },
                { id: Buffer.from('cred-2'), transports: ['internal'] },
            ],
        });

        expect(options.excludeCredentials).toHaveLength(2);
        expect(options.excludeCredentials[0].type).toBe('public-key');
    });

    it('should use custom timeout', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com', userId: '1', userName: 'test',
            timeout: 120000,
        });
        expect(options.timeout).toBe(120000);
    });

    it('should use custom attestation', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com', userId: '1', userName: 'test',
            attestation: 'direct',
        });
        expect(options.attestation).toBe('direct');
    });

    it('should accept Buffer userId', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com',
            userId: Buffer.from('user-buf'),
            userName: 'test',
        });
        expect(options.user.id).toBeDefined();
    });

    it('should generate unique challenges', () =>
    {
        const c1 = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com', userId: '1', userName: 'test',
        }).challenge;
        const c2 = webauthn.generateRegistrationOptions({
            rpName: 'Test', rpId: 'test.com', userId: '1', userName: 'test',
        }).challenge;
        expect(c1).not.toBe(c2);
    });
});

// =========================================================
// generateAuthenticationOptions
// =========================================================

describe('webauthn.generateAuthenticationOptions', () =>
{
    it('should generate valid options', () =>
    {
        const { options, challenge } = webauthn.generateAuthenticationOptions({
            rpId: 'test.com',
        });

        expect(options.rpId).toBe('test.com');
        expect(options.userVerification).toBe('required');
        expect(challenge).toBeDefined();
    });

    it('should throw without rpId', () =>
    {
        expect(() => webauthn.generateAuthenticationOptions({})).toThrow('rpId');
    });

    it('should throw with null', () =>
    {
        expect(() => webauthn.generateAuthenticationOptions(null)).toThrow();
    });

    it('should include allowCredentials', () =>
    {
        const { options } = webauthn.generateAuthenticationOptions({
            rpId: 'test.com',
            allowCredentials: [
                { id: 'cred-abc', transports: ['internal'] },
            ],
        });
        expect(options.allowCredentials).toHaveLength(1);
        expect(options.allowCredentials[0].type).toBe('public-key');
    });

    it('should use custom userVerification', () =>
    {
        const { options } = webauthn.generateAuthenticationOptions({
            rpId: 'test.com',
            userVerification: 'discouraged',
        });
        expect(options.userVerification).toBe('discouraged');
    });
});

// =========================================================
// verifyRegistration — error paths
// =========================================================

describe('webauthn.verifyRegistration — error paths', () =>
{
    it('should return error for missing response', () =>
    {
        const result = webauthn.verifyRegistration({
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Missing response');
    });

    it('should return error for missing response.response', () =>
    {
        const result = webauthn.verifyRegistration({
            response: {},
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Missing response');
    });

    it('should return error for wrong client data type', () =>
    {
        const clientData = { type: 'webauthn.get', origin: 'https://test.com', challenge: 'abc' };
        const result = webauthn.verifyRegistration({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    attestationObject: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Invalid type');
    });

    it('should return error for origin mismatch', () =>
    {
        const clientData = { type: 'webauthn.create', origin: 'https://evil.com', challenge: 'abc' };
        const result = webauthn.verifyRegistration({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    attestationObject: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Origin mismatch');
    });

    it('should return error for challenge mismatch', () =>
    {
        const clientData = { type: 'webauthn.create', origin: 'https://test.com', challenge: 'wrong' };
        const result = webauthn.verifyRegistration({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    attestationObject: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'correct',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Challenge mismatch');
    });
});

// =========================================================
// verifyAuthentication — error paths
// =========================================================

describe('webauthn.verifyAuthentication — error paths', () =>
{
    it('should return error for missing response', () =>
    {
        const result = webauthn.verifyAuthentication({
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
            credential: { publicKey: Buffer.alloc(10), counter: 0 },
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Missing response');
    });

    it('should return error for missing credential', () =>
    {
        const clientData = { type: 'webauthn.get', origin: 'https://test.com', challenge: 'abc' };
        const result = webauthn.verifyAuthentication({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    authenticatorData: _toBase64Url(Buffer.alloc(37)),
                    signature: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Missing stored credential');
    });

    it('should return error for wrong client data type', () =>
    {
        const clientData = { type: 'webauthn.create', origin: 'https://test.com', challenge: 'abc' };
        const result = webauthn.verifyAuthentication({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    authenticatorData: _toBase64Url(Buffer.alloc(37)),
                    signature: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
            credential: { publicKey: Buffer.alloc(10), counter: 0 },
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Invalid type');
    });

    it('should return error for origin mismatch in authentication', () =>
    {
        const clientData = { type: 'webauthn.get', origin: 'https://evil.com', challenge: 'abc' };
        const result = webauthn.verifyAuthentication({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    authenticatorData: _toBase64Url(Buffer.alloc(37)),
                    signature: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'abc',
            expectedOrigin: 'https://test.com',
            expectedRPID: 'test.com',
            credential: { publicKey: Buffer.alloc(10), counter: 0 },
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Origin mismatch');
    });
});

// =========================================================
// _parseAuthData
// =========================================================

describe('_parseAuthData', () =>
{
    it('should parse minimal authenticator data (37 bytes)', () =>
    {
        // rpIdHash (32) + flags (1) + signCount (4)
        const authData = Buffer.alloc(37);
        // Set rpIdHash to sha256 of 'test.com'
        const rpIdHash = crypto.createHash('sha256').update('test.com').digest();
        rpIdHash.copy(authData, 0);
        // flags: user present (0x01) | user verified (0x04) = 0x05
        authData[32] = 0x05;
        // signCount: 42
        authData.writeUInt32BE(42, 33);

        const parsed = _parseAuthData(authData);
        expect(parsed.rpIdHash).toEqual(rpIdHash);
        expect(parsed.userPresent).toBe(true);
        expect(parsed.userVerified).toBe(true);
        expect(parsed.signCount).toBe(42);
        expect(parsed.attestedCredDataIncluded).toBe(false);
        expect(parsed.credentialId).toBeNull();
    });

    it('should detect flags correctly', () =>
    {
        const authData = Buffer.alloc(37);
        // flags: none set
        authData[32] = 0x00;

        const parsed = _parseAuthData(authData);
        expect(parsed.userPresent).toBe(false);
        expect(parsed.userVerified).toBe(false);
        expect(parsed.attestedCredDataIncluded).toBe(false);
        expect(parsed.extensionDataIncluded).toBe(false);
    });

    it('should detect extension data flag', () =>
    {
        const authData = Buffer.alloc(37);
        authData[32] = 0x80; // extension data included
        const parsed = _parseAuthData(authData);
        expect(parsed.extensionDataIncluded).toBe(true);
    });

    it('should read sign count correctly', () =>
    {
        const authData = Buffer.alloc(37);
        authData.writeUInt32BE(0, 33);
        expect(_parseAuthData(authData).signCount).toBe(0);

        authData.writeUInt32BE(0xFFFFFFFF, 33);
        expect(_parseAuthData(authData).signCount).toBe(0xFFFFFFFF);
    });
});

// =========================================================
// _coseToPublicKey
// =========================================================

describe('_coseToPublicKey', () =>
{
    it('should parse an EC2 P-256 COSE key', () =>
    {
        // Generate a real EC key pair
        const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = publicKey.export({ format: 'jwk' });

        const coseKey = {
            1: COSE_KEY_TYPE.EC2, // kty
            3: COSE_ALG.ES256,    // alg
            [-2]: Buffer.from(jwk.x, 'base64url'), // x
            [-3]: Buffer.from(jwk.y, 'base64url'), // y
        };

        const result = _coseToPublicKey(coseKey);
        expect(result.algorithm).toBe('ES256');
        expect(result.key.asymmetricKeyType).toBe('ec');
    });

    it('should parse an RSA COSE key', () =>
    {
        const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' });

        const coseKey = {
            1: COSE_KEY_TYPE.RSA,
            3: COSE_ALG.RS256,
            [-1]: Buffer.from(jwk.n, 'base64url'),
            [-2]: Buffer.from(jwk.e, 'base64url'),
        };

        const result = _coseToPublicKey(coseKey);
        expect(result.algorithm).toBe('RS256');
        expect(result.key.asymmetricKeyType).toBe('rsa');
    });

    it('should parse an Ed25519 COSE key', () =>
    {
        const { publicKey } = crypto.generateKeyPairSync('ed25519');
        const raw = publicKey.export({ type: 'spki', format: 'der' });
        // Ed25519 raw public key is the last 32 bytes of SPKI DER
        const pubBytes = raw.subarray(raw.length - 32);

        const coseKey = {
            1: COSE_KEY_TYPE.OKP,
            3: COSE_ALG.EDDSA,
            [-1]: 6, // Ed25519 curve
            [-2]: pubBytes,
        };

        const result = _coseToPublicKey(coseKey);
        expect(result.algorithm).toBe('EdDSA');
        expect(result.key.asymmetricKeyType).toBe('ed25519');
    });

    it('should throw for missing EC2 coordinates', () =>
    {
        expect(() => _coseToPublicKey({ 1: COSE_KEY_TYPE.EC2, 3: COSE_ALG.ES256 }))
            .toThrow('missing x or y');
    });

    it('should throw for missing RSA modulus', () =>
    {
        expect(() => _coseToPublicKey({ 1: COSE_KEY_TYPE.RSA, 3: COSE_ALG.RS256 }))
            .toThrow('missing n or e');
    });

    it('should throw for missing OKP public key', () =>
    {
        expect(() => _coseToPublicKey({ 1: COSE_KEY_TYPE.OKP, [-1]: 6 }))
            .toThrow('missing x');
    });

    it('should throw for unsupported key type', () =>
    {
        expect(() => _coseToPublicKey({ 1: 99 })).toThrow('Unsupported COSE key type');
    });

    it('should throw for unsupported OKP curve', () =>
    {
        expect(() => _coseToPublicKey({ 1: COSE_KEY_TYPE.OKP, [-1]: 99, [-2]: Buffer.alloc(32) }))
            .toThrow('Unsupported OKP curve');
    });
});

// =========================================================
// _coseAlgToNodeAlg
// =========================================================

describe('_coseAlgToNodeAlg', () =>
{
    it('should return SHA256 for ES256', () =>
    {
        expect(_coseAlgToNodeAlg(COSE_ALG.ES256)).toBe('SHA256');
    });

    it('should return SHA256 for RS256', () =>
    {
        expect(_coseAlgToNodeAlg(COSE_ALG.RS256)).toBe('SHA256');
    });

    it('should return null for EdDSA', () =>
    {
        expect(_coseAlgToNodeAlg(COSE_ALG.EDDSA)).toBeNull();
    });

    it('should return SHA256 for unknown algorithm', () =>
    {
        expect(_coseAlgToNodeAlg(-999)).toBe('SHA256');
    });
});

// =========================================================
// Full registration + authentication end-to-end (EC P-256)
// =========================================================

describe('webauthn end-to-end (ES256)', () =>
{
    const rpId = 'test.example.com';
    const rpName = 'Test App';
    const origin = 'https://test.example.com';
    let keyPair;

    beforeAll(() =>
    {
        keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    });

    function buildRegistrationResponse(challenge)
    {
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        const x = Buffer.from(jwk.x, 'base64url');
        const y = Buffer.from(jwk.y, 'base64url');

        // Build authenticator data
        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        const flags = Buffer.from([0x45]); // UP + UV + AT
        const signCount = Buffer.alloc(4);
        signCount.writeUInt32BE(0);
        const aaguid = Buffer.alloc(16);
        const credId = crypto.randomBytes(32);
        const credIdLen = Buffer.alloc(2);
        credIdLen.writeUInt16BE(credId.length);

        // CBOR-encode COSE key (EC2, P-256)
        // Manual CBOR map: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
        const coseKey = _buildEC2CoseKey(x, y);

        const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);

        // Build attestation object (CBOR map: {fmt: "none", attStmt: {}, authData: <bytes>})
        const attObj = _buildAttestationObject('none', authData, Buffer.alloc(0));

        const clientData = JSON.stringify({
            type: 'webauthn.create',
            origin,
            challenge,
        });

        return {
            id: _toBase64Url(credId),
            type: 'public-key',
            response: {
                clientDataJSON: _toBase64Url(clientData),
                attestationObject: _toBase64Url(attObj),
                transports: ['internal'],
            },
        };
    }

    function buildAuthResponse(challenge, credential, counter)
    {
        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        const flags = Buffer.from([0x05]); // UP + UV
        const signCountBuf = Buffer.alloc(4);
        signCountBuf.writeUInt32BE(counter);
        const authDataBuf = Buffer.concat([rpIdHash, flags, signCountBuf]);

        const clientData = JSON.stringify({
            type: 'webauthn.get',
            origin,
            challenge,
        });
        const clientDataBuf = Buffer.from(clientData);
        const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();

        const signedData = Buffer.concat([authDataBuf, clientDataHash]);
        const signature = crypto.sign('SHA256', signedData, keyPair.privateKey);

        return {
            id: credential.id,
            type: 'public-key',
            response: {
                clientDataJSON: _toBase64Url(clientDataBuf),
                authenticatorData: _toBase64Url(authDataBuf),
                signature: _toBase64Url(signature),
            },
        };
    }

    it('should register and authenticate successfully', () =>
    {
        // Registration
        const { options: regOpts, challenge: regChallenge } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
        });

        const regResponse = buildRegistrationResponse(regChallenge);
        const regResult = webauthn.verifyRegistration({
            response: regResponse,
            expectedChallenge: regChallenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(regResult.verified).toBe(true);
        expect(regResult.credential).toBeDefined();
        expect(regResult.credential.id).toBeDefined();
        expect(Buffer.isBuffer(regResult.credential.publicKey)).toBe(true);
        expect(regResult.credential.counter).toBe(0);
        expect(regResult.credential.transports).toContain('internal');

        // Authentication
        const { challenge: authChallenge } = webauthn.generateAuthenticationOptions({ rpId });
        const authResponse = buildAuthResponse(authChallenge, regResult.credential, 1);
        const authResult = webauthn.verifyAuthentication({
            response: authResponse,
            expectedChallenge: authChallenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(true);
        expect(authResult.newCounter).toBe(1);
    });

    it('should reject authentication with counter rollback', () =>
    {
        const regResp = buildRegistrationResponse('challenge123');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'challenge123',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });
        expect(regResult.verified).toBe(true);

        // Simulate stored counter=5
        regResult.credential.counter = 5;

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });
        // Send counter=3 (rollback)
        const authResp = buildAuthResponse(challenge, regResult.credential, 3);
        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('Counter rollback');
    });

    it('should reject authentication with wrong signature', () =>
    {
        const regResp = buildRegistrationResponse('ch1');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch1',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });
        const authResp = buildAuthResponse(challenge, regResult.credential, 1);
        // Corrupt the signature
        const sigBuf = _fromBase64Url(authResp.response.signature);
        sigBuf[5] ^= 0xff;
        authResp.response.signature = _toBase64Url(sigBuf);

        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('Signature');
    });

    it('should reject registration with RP ID hash mismatch', () =>
    {
        const regResp = buildRegistrationResponse('ch2');
        const result = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch2',
            expectedOrigin: origin,
            expectedRPID: 'wrong.example.com', // mismatch
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('RP ID hash mismatch');
    });

    it('should reject authentication with RP ID hash mismatch', () =>
    {
        const regResp = buildRegistrationResponse('ch3');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch3',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });
        const authResp = buildAuthResponse(challenge, regResult.credential, 1);
        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: 'wrong.example.com',
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('RP ID hash mismatch');
    });

    it('should reject registration when user not present', () =>
    {
        const { challenge } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
        });

        const regResp = buildRegistrationResponse(challenge);
        // Patch authData to clear user present flag
        const attObjBuf = _fromBase64Url(regResp.response.attestationObject);
        const decoded = cbor.decode(attObjBuf);
        decoded.authData[32] = 0x40; // AT set but UP cleared
        const patched = _buildAttestationObject('none', decoded.authData, Buffer.alloc(0));
        regResp.response.attestationObject = _toBase64Url(patched);

        const result = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(result.verified).toBe(false);
        expect(result.error).toContain('User not present');
    });

    it('should reject authentication when user not present', () =>
    {
        const regResp = buildRegistrationResponse('ch-up');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch-up',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });
        const authResp = buildAuthResponse(challenge, regResult.credential, 1);
        // Patch authenticator data to clear UP flag
        const authDataBuf = _fromBase64Url(authResp.response.authenticatorData);
        authDataBuf[32] = 0x04; // UV set, UP cleared
        authResp.response.authenticatorData = _toBase64Url(authDataBuf);

        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('User not present');
    });

    it('should reject registration without attested credential data', () =>
    {
        const { challenge } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
        });

        const regResp = buildRegistrationResponse(challenge);
        const attObjBuf = _fromBase64Url(regResp.response.attestationObject);
        const decoded = cbor.decode(attObjBuf);
        // Clear AT flag and truncate authData to 37 bytes (no credential data)
        decoded.authData[32] = 0x05; // UP + UV, no AT
        const stripped = decoded.authData.subarray(0, 37);
        const patched = _buildAttestationObject('none', stripped, Buffer.alloc(0));
        regResp.response.attestationObject = _toBase64Url(patched);

        const result = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(result.verified).toBe(false);
        expect(result.error).toContain('No credential data');
    });

    it('should handle unknown attestation format gracefully', () =>
    {
        const { challenge } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
        });

        const regResp = buildRegistrationResponse(challenge);
        const attObjBuf = _fromBase64Url(regResp.response.attestationObject);
        const decoded = cbor.decode(attObjBuf);
        const patched = _buildAttestationObject('custom-format', decoded.authData, Buffer.alloc(0));
        regResp.response.attestationObject = _toBase64Url(patched);

        const result = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        // Unknown formats are treated as "none" — should still verify
        expect(result.verified).toBe(true);
    });

    it('should allow zero counters (both stored and received)', () =>
    {
        const regResp = buildRegistrationResponse('ch-zero');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch-zero',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });
        expect(regResult.credential.counter).toBe(0);

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });
        // Counter=0 again — both zero, skip check
        const authResp = buildAuthResponse(challenge, regResult.credential, 0);
        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(true);
    });

    it('should use custom authenticatorSelection', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'discouraged' },
        });
        expect(options.authenticatorSelection.authenticatorAttachment).toBe('platform');
    });

    it('should use custom userDisplayName', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
            userDisplayName: 'User One',
        });
        expect(options.user.displayName).toBe('User One');
    });

    it('should handle challengeBytes option', () =>
    {
        const { challenge } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
            challengeBytes: 64,
        });
        // Base64url of 64 bytes = 86 chars
        expect(_fromBase64Url(challenge).length).toBe(64);
    });

    it('should handle challengeBytes in auth options', () =>
    {
        const { challenge } = webauthn.generateAuthenticationOptions({
            rpId,
            challengeBytes: 48,
        });
        expect(_fromBase64Url(challenge).length).toBe(48);
    });

    it('should handle allowCredentials with Buffer IDs', () =>
    {
        const credBuf = crypto.randomBytes(16);
        const { options } = webauthn.generateAuthenticationOptions({
            rpId,
            allowCredentials: [{ id: credBuf, transports: ['usb'] }],
        });
        expect(options.allowCredentials[0].id).toBe(_toBase64Url(credBuf));
    });

    it('should reject authentication with challenge mismatch', () =>
    {
        const regResp = buildRegistrationResponse('ch-auth-mm');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch-auth-mm',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        const authResp = buildAuthResponse('real-challenge', regResult.credential, 1);
        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: 'wrong-challenge',
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('Challenge mismatch');
    });

    it('should reject authentication with origin mismatch', () =>
    {
        const regResp = buildRegistrationResponse('ch-orig');
        const regResult = webauthn.verifyRegistration({
            response: regResp,
            expectedChallenge: 'ch-orig',
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        const { challenge } = webauthn.generateAuthenticationOptions({ rpId });

        // Build auth response with correct origin in clientData
        const authResp = buildAuthResponse(challenge, regResult.credential, 1);
        const authResult = webauthn.verifyAuthentication({
            response: authResp,
            expectedChallenge: challenge,
            expectedOrigin: 'https://evil.com', // mismatch
            expectedRPID: rpId,
            credential: regResult.credential,
        });

        expect(authResult.verified).toBe(false);
        expect(authResult.error).toContain('Origin mismatch');
    });

    it('should handle missing publicKey on stored credential', () =>
    {
        const clientData = { type: 'webauthn.get', origin, challenge: 'c' };
        const result = webauthn.verifyAuthentication({
            response: {
                response: {
                    clientDataJSON: _toBase64Url(JSON.stringify(clientData)),
                    authenticatorData: _toBase64Url(Buffer.alloc(37)),
                    signature: _toBase64Url(Buffer.alloc(10)),
                },
            },
            expectedChallenge: 'c',
            expectedOrigin: origin,
            expectedRPID: rpId,
            credential: { counter: 0 }, // no publicKey
        });
        expect(result.verified).toBe(false);
        expect(result.error).toContain('Missing stored credential');
    });

    it('should handle excludeCredentials with no transports', () =>
    {
        const { options } = webauthn.generateRegistrationOptions({
            rpName, rpId, userId: 'u1', userName: 'u1@test.com',
            excludeCredentials: [{ id: 'cred-1' }],
        });
        expect(options.excludeCredentials[0].transports).toEqual([]);
    });

    it('should handle allowCredentials with no transports', () =>
    {
        const { options } = webauthn.generateAuthenticationOptions({
            rpId,
            allowCredentials: [{ id: 'cred-1' }],
        });
        expect(options.allowCredentials[0].transports).toEqual([]);
    });
});

// =========================================================
// Packed self-attestation
// =========================================================

describe('webauthn — packed self-attestation', () =>
{
    const rpId = 'test.example.com';
    const origin = 'https://test.example.com';

    it('should verify registration with packed self-attestation', () =>
    {
        const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        const x = Buffer.from(jwk.x, 'base64url');
        const y = Buffer.from(jwk.y, 'base64url');

        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        const flags = Buffer.from([0x45]); // UP + UV + AT
        const signCount = Buffer.alloc(4);
        const aaguid = Buffer.alloc(16);
        const credId = crypto.randomBytes(32);
        const credIdLen = Buffer.alloc(2);
        credIdLen.writeUInt16BE(credId.length);
        const coseKey = _buildEC2CoseKey(x, y);
        const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);

        const challenge = 'packed-test-challenge';
        const clientData = JSON.stringify({ type: 'webauthn.create', origin, challenge });
        const clientDataBuf = Buffer.from(clientData);
        const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();

        // Self-attestation: sign authData || clientDataHash with credential private key
        const signedData = Buffer.concat([authData, clientDataHash]);
        const sig = crypto.sign('SHA256', signedData, keyPair.privateKey);

        // Build packed attestation object: { fmt: "packed", attStmt: { alg: -7, sig }, authData }
        const attObj = _buildPackedAttestationObject(authData, sig);

        const response = {
            id: _toBase64Url(credId),
            type: 'public-key',
            response: {
                clientDataJSON: _toBase64Url(clientDataBuf),
                attestationObject: _toBase64Url(attObj),
                transports: ['internal'],
            },
        };

        const result = webauthn.verifyRegistration({
            response,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(result.verified).toBe(true);
        expect(result.credential).toBeDefined();
    });

    it('should reject packed attestation with invalid signature', () =>
    {
        const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        const x = Buffer.from(jwk.x, 'base64url');
        const y = Buffer.from(jwk.y, 'base64url');

        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        const flags = Buffer.from([0x45]);
        const signCount = Buffer.alloc(4);
        const aaguid = Buffer.alloc(16);
        const credId = crypto.randomBytes(32);
        const credIdLen = Buffer.alloc(2);
        credIdLen.writeUInt16BE(credId.length);
        const coseKey = _buildEC2CoseKey(x, y);
        const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);

        const challenge = 'packed-bad-sig';
        const clientData = JSON.stringify({ type: 'webauthn.create', origin, challenge });
        const clientDataBuf = Buffer.from(clientData);

        // Bad signature (random bytes)
        const badSig = crypto.randomBytes(64);

        const attObj = _buildPackedAttestationObject(authData, badSig);

        const response = {
            id: _toBase64Url(credId),
            type: 'public-key',
            response: {
                clientDataJSON: _toBase64Url(clientDataBuf),
                attestationObject: _toBase64Url(attObj),
            },
        };

        const result = webauthn.verifyRegistration({
            response,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(result.verified).toBe(false);
        expect(result.error).toContain('Packed attestation');
    });

    it('should reject packed attestation with missing sig', () =>
    {
        const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        const x = Buffer.from(jwk.x, 'base64url');
        const y = Buffer.from(jwk.y, 'base64url');

        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        const flags = Buffer.from([0x45]);
        const signCount = Buffer.alloc(4);
        const aaguid = Buffer.alloc(16);
        const credId = crypto.randomBytes(32);
        const credIdLen = Buffer.alloc(2);
        credIdLen.writeUInt16BE(credId.length);
        const coseKey = _buildEC2CoseKey(x, y);
        const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);

        const challenge = 'packed-no-sig';
        const clientData = JSON.stringify({ type: 'webauthn.create', origin, challenge });
        const clientDataBuf = Buffer.from(clientData);

        // Build packed attestation with empty attStmt (no sig)
        const attObj = _buildAttestationObject('packed', authData, Buffer.alloc(0));

        const response = {
            id: _toBase64Url(credId),
            type: 'public-key',
            response: {
                clientDataJSON: _toBase64Url(clientDataBuf),
                attestationObject: _toBase64Url(attObj),
            },
        };

        const result = webauthn.verifyRegistration({
            response,
            expectedChallenge: challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
        });

        expect(result.verified).toBe(false);
        expect(result.error).toContain('Packed attestation');
    });
});

// =========================================================
// CBOR edge cases
// =========================================================

describe('CBOR decoder — edge cases', () =>
{
    it('should decode a large unsigned integer (64-bit)', () =>
    {
        // CBOR for 2^32 = 4294967296: 0x1b 0x00 0x00 0x00 0x01 0x00 0x00 0x00 0x00
        const result = cbor.decode(Buffer.from([0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
        expect(result).toBe(4294967296);
    });

    it('should decode a tagged value (skip tag)', () =>
    {
        // Tag 1 followed by integer 100: 0xc1 0x18 0x64
        const result = cbor.decode(Buffer.from([0xc1, 0x18, 0x64]));
        expect(result).toBe(100);
    });

    it('should decode a nested map', () =>
    {
        // {1: {2: 3}}: 0xa1 0x01 0xa1 0x02 0x03
        const result = cbor.decode(Buffer.from([0xa1, 0x01, 0xa1, 0x02, 0x03]));
        expect(result[1][2]).toBe(3);
    });

    it('should decode a float32 (major type 7, ai=26)', () =>
    {
        // CBOR float32 for 1.5: 0xfa 0x3f 0xc0 0x00 0x00
        const result = cbor.decode(Buffer.from([0xfa, 0x3f, 0xc0, 0x00, 0x00]));
        expect(result).toBeCloseTo(1.5);
    });

    it('should decode a float64 (major type 7, ai=27)', () =>
    {
        // CBOR float64 for 1.5: 0xfb + 8 bytes
        const buf = Buffer.alloc(9);
        buf[0] = 0xfb;
        buf.writeDoubleBE(3.14159, 1);
        const result = cbor.decode(buf);
        expect(result).toBeCloseTo(3.14159);
    });

    it('should return simple value for other type 7 items', () =>
    {
        // Major type 7, additional info 0 (simple value 0)
        const result = cbor.decode(Buffer.from([0xe0]));
        expect(result).toBe(0);
    });
});

// =========================================================
// CBOR helpers for building test attestation objects
// =========================================================

/**
 * Build minimal CBOR-encoded COSE key for EC2 P-256
 * @param {Buffer} x
 * @param {Buffer} y
 * @returns {Buffer}
 */
function _buildEC2CoseKey(x, y)
{
    // Hand-build CBOR map: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
    const items = [];
    // Map with 5 entries
    items.push(Buffer.from([0xa5]));
    // 1: 2
    items.push(Buffer.from([0x01, 0x02]));
    // 3: -7
    items.push(Buffer.from([0x03, 0x26]));
    // -1: 1
    items.push(Buffer.from([0x20, 0x01]));
    // -2: x (byte string)
    items.push(Buffer.from([0x21, 0x58, x.length]));
    items.push(x);
    // -3: y (byte string)
    items.push(Buffer.from([0x22, 0x58, y.length]));
    items.push(y);
    return Buffer.concat(items);
}

/**
 * Build a minimal CBOR attestation object
 * @param {string} fmt
 * @param {Buffer} authData
 * @param {Buffer} attStmtBytes - unused for 'none', but needed for other formats
 * @returns {Buffer}
 */
function _buildAttestationObject(fmt, authData, attStmtBytes)
{
    // CBOR map with 3 entries: {fmt: string, attStmt: {}, authData: bytes}
    const items = [];
    items.push(Buffer.from([0xa3])); // map(3)

    // "fmt" key
    const fmtKey = Buffer.from('fmt');
    items.push(Buffer.from([0x63])); // text(3)
    items.push(fmtKey);
    // fmt value
    const fmtVal = Buffer.from(fmt);
    items.push(Buffer.from([0x60 | (fmtVal.length & 0x1f)]));
    if (fmtVal.length >= 24) {
        // Handle longer format strings
        items.pop();
        items.push(Buffer.from([0x78, fmtVal.length]));
    }
    items.push(fmtVal);

    // "attStmt" key
    items.push(Buffer.from([0x67])); // text(7)
    items.push(Buffer.from('attStmt'));
    items.push(Buffer.from([0xa0])); // empty map

    // "authData" key
    items.push(Buffer.from([0x68])); // text(8)
    items.push(Buffer.from('authData'));
    // authData value (byte string)
    if (authData.length < 24)
    {
        items.push(Buffer.from([0x40 | authData.length]));
    }
    else if (authData.length < 256)
    {
        items.push(Buffer.from([0x58, authData.length]));
    }
    else
    {
        items.push(Buffer.from([0x59, (authData.length >> 8) & 0xff, authData.length & 0xff]));
    }
    items.push(authData);

    return Buffer.concat(items);
}

/**
 * Build a CBOR packed attestation object with self-attestation.
 * {fmt: "packed", attStmt: {alg: -7, sig: <bytes>}, authData: <bytes>}
 */
function _buildPackedAttestationObject(authData, sig)
{
    const items = [];
    items.push(Buffer.from([0xa3])); // map(3)

    // "fmt" → "packed"
    items.push(Buffer.from([0x63])); // text(3)
    items.push(Buffer.from('fmt'));
    items.push(Buffer.from([0x66])); // text(6)
    items.push(Buffer.from('packed'));

    // "attStmt" → { alg: -7, sig: <bytes> }
    items.push(Buffer.from([0x67])); // text(7)
    items.push(Buffer.from('attStmt'));
    items.push(Buffer.from([0xa2])); // map(2)
    // "alg" → -7
    items.push(Buffer.from([0x63])); // text(3)
    items.push(Buffer.from('alg'));
    items.push(Buffer.from([0x26])); // -7 in CBOR
    // "sig" → <bytes>
    items.push(Buffer.from([0x63])); // text(3)
    items.push(Buffer.from('sig'));
    items.push(_cborBytes(sig));

    // "authData" → <bytes>
    items.push(Buffer.from([0x68])); // text(8)
    items.push(Buffer.from('authData'));
    items.push(_cborBytes(authData));

    return Buffer.concat(items);
}

function _cborBytes(buf)
{
    if (buf.length < 24)
        return Buffer.concat([Buffer.from([0x40 | buf.length]), buf]);
    if (buf.length < 256)
        return Buffer.concat([Buffer.from([0x58, buf.length]), buf]);
    return Buffer.concat([Buffer.from([0x59, (buf.length >> 8) & 0xff, buf.length & 0xff]), buf]);
}
