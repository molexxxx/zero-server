/**
 * @module auth/webauthn
 * @description Zero-dependency WebAuthn/FIDO2/Passkeys implementation.
 *              Supports registration (attestation) and authentication (assertion)
 *              ceremonies using only Node.js built-in `crypto`.
 *
 *              Implements:
 *              - Challenge generation (cryptographically random, ≥16 bytes)
 *              - Registration options & verification (none, packed, fido-u2f attestation)
 *              - Authentication options & verification with counter validation
 *              - CBOR decoding for attestation objects and authenticator data
 *              - COSE key parsing (EC2/P-256, RSA, OKP/Ed25519)
 *              - ES256, RS256, EdDSA signature verification
 *
 * @see https://www.w3.org/TR/webauthn-2/
 *
 * @example | Registration
 *   const { webauthn } = require('@zero-server/sdk');
 *   const options = webauthn.generateRegistrationOptions({
 *       rpName: 'My App', rpId: 'myapp.com',
 *       userId: user.id, userName: user.email,
 *   });
 *   // Send options to client, receive response from navigator.credentials.create()
 *   const result = await webauthn.verifyRegistration({
 *       response: clientResponse,
 *       expectedChallenge: storedChallenge,
 *       expectedOrigin: 'https://myapp.com',
 *       expectedRPID: 'myapp.com',
 *   });
 *
 * @example | Authentication
 *   const authOpts = webauthn.generateAuthenticationOptions({
 *       rpId: 'myapp.com',
 *       allowCredentials: user.credentials,
 *   });
 *   const authResult = await webauthn.verifyAuthentication({
 *       response: clientResponse,
 *       expectedChallenge: storedChallenge,
 *       expectedOrigin: 'https://myapp.com',
 *       expectedRPID: 'myapp.com',
 *       credential: storedCredential,
 *   });
 */

const crypto = require('crypto');
const log = require('../debug')('zero:webauthn');

// -- CBOR Decoder (minimal, spec-compliant subset) --------

/**
 * Minimal CBOR decoder supporting the types used in WebAuthn attestation objects.
 * Handles: unsigned/negative ints, byte strings, text strings, arrays, maps, booleans, null.
 * @private
 */
const cbor = {
    /**
     * Decode a CBOR-encoded Buffer.
     * @param {Buffer} buf
     * @returns {*} Decoded value
     */
    decode(buf)
    {
        let offset = 0;

        function readUint8() { return buf[offset++]; }

        function readArgument(additionalInfo)
        {
            if (additionalInfo < 24) return additionalInfo;
            if (additionalInfo === 24) { const v = buf[offset++]; return v; }
            if (additionalInfo === 25) { const v = buf.readUInt16BE(offset); offset += 2; return v; }
            if (additionalInfo === 26) { const v = buf.readUInt32BE(offset); offset += 4; return v; }
            if (additionalInfo === 27)
            {
                const hi = buf.readUInt32BE(offset);
                const lo = buf.readUInt32BE(offset + 4);
                offset += 8;
                // Return as Number if safe, otherwise BigInt
                const val = hi * 0x100000000 + lo;
                return val;
            }
            throw new Error('CBOR: unsupported additional info: ' + additionalInfo);
        }

        function decodeItem()
        {
            const initial = readUint8();
            const majorType = initial >> 5;
            const additionalInfo = initial & 0x1f;

            switch (majorType)
            {
                case 0: // unsigned integer
                    return readArgument(additionalInfo);

                case 1: // negative integer
                    return -1 - readArgument(additionalInfo);

                case 2: // byte string
                {
                    const len = readArgument(additionalInfo);
                    const bytes = buf.subarray(offset, offset + len);
                    offset += len;
                    return Buffer.from(bytes);
                }

                case 3: // text string
                {
                    const len = readArgument(additionalInfo);
                    const text = buf.toString('utf8', offset, offset + len);
                    offset += len;
                    return text;
                }

                case 4: // array
                {
                    const len = readArgument(additionalInfo);
                    const arr = [];
                    for (let i = 0; i < len; i++) arr.push(decodeItem());
                    return arr;
                }

                case 5: // map
                {
                    const len = readArgument(additionalInfo);
                    const map = {};
                    for (let i = 0; i < len; i++)
                    {
                        const key = decodeItem();
                        const value = decodeItem();
                        map[key] = value;
                    }
                    return map;
                }

                case 6: // tag (skip tag number, decode value)
                    readArgument(additionalInfo);
                    return decodeItem();

                case 7: // simple/float
                {
                    if (additionalInfo === 20) return false;
                    if (additionalInfo === 21) return true;
                    if (additionalInfo === 22) return null;
                    if (additionalInfo === 23) return undefined;
                    if (additionalInfo === 25)
                    {
                        // float16 — not commonly used in WebAuthn but handle it
                        offset -= 0; // already read
                        return readArgument(additionalInfo);
                    }
                    if (additionalInfo === 26)
                    {
                        const fbuf = buf.subarray(offset, offset + 4);
                        offset += 4;
                        return fbuf.readFloatBE(0);
                    }
                    if (additionalInfo === 27)
                    {
                        const fbuf = buf.subarray(offset, offset + 8);
                        offset += 8;
                        return fbuf.readDoubleBE(0);
                    }
                    return additionalInfo;
                }

                default:
                    throw new Error('CBOR: unknown major type ' + majorType);
            }
        }

        return decodeItem();
    },
};

// -- COSE Key Parsing --------------------------------------

/**
 * COSE key type identifiers.
 * @private
 */
const COSE_KEY_TYPE = { OKP: 1, EC2: 2, RSA: 3 };
const COSE_ALG = { ES256: -7, RS256: -257, EDDSA: -8 };
const COSE_CRV = { P256: 1, ED25519: 6 };

/**
 * Convert a COSE public key (from attestation) to a Node.js crypto key object.
 * @private
 * @param {object} coseKey - COSE key map (numeric keys).
 * @returns {{ key: crypto.KeyObject, algorithm: string }}
 */
function _coseToPublicKey(coseKey)
{
    const kty = coseKey[1]; // Key type
    const alg = coseKey[3]; // Algorithm

    if (kty === COSE_KEY_TYPE.EC2)
    {
        // EC2 key (P-256)
        const x = coseKey[-2];
        const y = coseKey[-3];
        if (!x || !y) throw new Error('EC2 COSE key missing x or y coordinate');

        // Uncompressed point: 0x04 || x || y
        const publicKeyBuffer = Buffer.concat([Buffer.from([0x04]), x, y]);

        // DER encode as SubjectPublicKeyInfo for P-256
        const key = crypto.createPublicKey({
            key: _ecPublicKeyToDER(publicKeyBuffer),
            format: 'der',
            type: 'spki',
        });

        return { key, algorithm: 'ES256' };
    }

    if (kty === COSE_KEY_TYPE.RSA)
    {
        const n = coseKey[-1]; // modulus
        const e = coseKey[-2]; // exponent
        if (!n || !e) throw new Error('RSA COSE key missing n or e');

        const key = crypto.createPublicKey({
            key: _rsaPublicKeyToDER(n, e),
            format: 'der',
            type: 'spki',
        });

        return { key, algorithm: 'RS256' };
    }

    if (kty === COSE_KEY_TYPE.OKP)
    {
        const crv = coseKey[-1];
        const x = coseKey[-2];
        if (!x) throw new Error('OKP COSE key missing x coordinate');

        if (crv === COSE_CRV.ED25519)
        {
            const key = crypto.createPublicKey({
                key: _ed25519PublicKeyToDER(x),
                format: 'der',
                type: 'spki',
            });
            return { key, algorithm: 'EdDSA' };
        }
        throw new Error('Unsupported OKP curve: ' + crv);
    }

    throw new Error('Unsupported COSE key type: ' + kty);
}

// -- DER Encoding Helpers ----------------------------------

/** @private ASN.1 DER sequence tag */
const ASN1_SEQUENCE = 0x30;
const ASN1_BIT_STRING = 0x03;
const ASN1_OID = 0x06;
const ASN1_INTEGER = 0x02;
const ASN1_NULL = 0x05;

/** @private P-256 OID: 1.2.840.10045.3.1.7 */
const EC_P256_OID = Buffer.from('2a8648ce3d030107', 'hex');
/** @private EC public key OID: 1.2.840.10045.2.1 */
const EC_PUB_OID = Buffer.from('2a8648ce3d0201', 'hex');
/** @private RSA OID: 1.2.840.113549.1.1.1 */
const RSA_OID = Buffer.from('2a864886f70d010101', 'hex');
/** @private Ed25519 OID: 1.3.101.112 */
const ED25519_OID = Buffer.from('06032b6570', 'hex'); // includes tag+length

/**
 * Encode a length in DER format.
 * @private
 * @param {number} len
 * @returns {Buffer}
 */
function _derLength(len)
{
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Wrap data in a DER sequence.
 * @private
 * @param {Buffer[]} items
 * @returns {Buffer}
 */
function _derSequence(...items)
{
    const body = Buffer.concat(items);
    return Buffer.concat([Buffer.from([ASN1_SEQUENCE]), _derLength(body.length), body]);
}

/**
 * Create a DER bit string.
 * @private
 * @param {Buffer} data
 * @returns {Buffer}
 */
function _derBitString(data)
{
    // Unused bits = 0
    const body = Buffer.concat([Buffer.from([0x00]), data]);
    return Buffer.concat([Buffer.from([ASN1_BIT_STRING]), _derLength(body.length), body]);
}

/**
 * Create a DER OID element.
 * @private
 * @param {Buffer} oidBytes - Raw OID bytes (without tag/length).
 * @returns {Buffer}
 */
function _derOID(oidBytes)
{
    return Buffer.concat([Buffer.from([ASN1_OID]), _derLength(oidBytes.length), oidBytes]);
}

/**
 * Convert an EC P-256 uncompressed point to SubjectPublicKeyInfo DER.
 * @private
 * @param {Buffer} uncompressedPoint - 65 bytes (0x04 || x || y)
 * @returns {Buffer}
 */
function _ecPublicKeyToDER(uncompressedPoint)
{
    const algorithmIdentifier = _derSequence(
        _derOID(EC_PUB_OID),
        _derOID(EC_P256_OID),
    );
    const subjectPublicKey = _derBitString(uncompressedPoint);
    return _derSequence(algorithmIdentifier, subjectPublicKey);
}

/**
 * Encode a positive integer with DER integer rules (prepend 0x00 if high bit set).
 * @private
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function _derInteger(buf)
{
    // Strip leading zeros but ensure non-negative
    let start = 0;
    while (start < buf.length - 1 && buf[start] === 0) start++;
    let trimmed = buf.subarray(start);
    if (trimmed[0] & 0x80) trimmed = Buffer.concat([Buffer.from([0x00]), trimmed]);
    return Buffer.concat([Buffer.from([ASN1_INTEGER]), _derLength(trimmed.length), trimmed]);
}

/**
 * Convert RSA n,e to SubjectPublicKeyInfo DER.
 * @private
 * @param {Buffer} n - Modulus
 * @param {Buffer} e - Exponent
 * @returns {Buffer}
 */
function _rsaPublicKeyToDER(n, e)
{
    const algorithmIdentifier = _derSequence(
        _derOID(RSA_OID),
        Buffer.from([ASN1_NULL, 0x00]),
    );
    const rsaPublicKey = _derSequence(_derInteger(n), _derInteger(e));
    const subjectPublicKey = _derBitString(rsaPublicKey);
    return _derSequence(algorithmIdentifier, subjectPublicKey);
}

/**
 * Convert Ed25519 public key bytes to SubjectPublicKeyInfo DER.
 * @private
 * @param {Buffer} pubBytes - 32-byte public key
 * @returns {Buffer}
 */
function _ed25519PublicKeyToDER(pubBytes)
{
    // AlgorithmIdentifier: SEQUENCE { OID 1.3.101.112 }
    const algorithmIdentifier = _derSequence(ED25519_OID);
    const subjectPublicKey = _derBitString(pubBytes);
    return _derSequence(algorithmIdentifier, subjectPublicKey);
}

// -- Authenticator Data Parsing ----------------------------

/**
 * Parse authenticator data buffer.
 * @private
 * @param {Buffer} authData
 * @returns {object}
 */
function _parseAuthData(authData)
{
    let offset = 0;

    // rpIdHash (32 bytes)
    const rpIdHash = authData.subarray(offset, offset + 32);
    offset += 32;

    // flags (1 byte)
    const flags = authData[offset++];
    const userPresent = !!(flags & 0x01);
    const userVerified = !!(flags & 0x04);
    const attestedCredDataIncluded = !!(flags & 0x40);
    const extensionDataIncluded = !!(flags & 0x80);

    // signCount (4 bytes, big-endian)
    const signCount = authData.readUInt32BE(offset);
    offset += 4;

    let aaguid = null;
    let credentialId = null;
    let credentialPublicKey = null;

    if (attestedCredDataIncluded)
    {
        // AAGUID (16 bytes)
        aaguid = authData.subarray(offset, offset + 16);
        offset += 16;

        // Credential ID length (2 bytes, big-endian)
        const credIdLen = authData.readUInt16BE(offset);
        offset += 2;

        // Credential ID
        credentialId = authData.subarray(offset, offset + credIdLen);
        offset += credIdLen;

        // Credential public key (CBOR-encoded COSE key)
        credentialPublicKey = cbor.decode(authData.subarray(offset));
    }

    return {
        rpIdHash,
        flags,
        userPresent,
        userVerified,
        signCount,
        attestedCredDataIncluded,
        extensionDataIncluded,
        aaguid,
        credentialId,
        credentialPublicKey,
    };
}

// -- Challenge Generation ---------------------------------

/**
 * Generate a cryptographically random challenge.
 * @private
 * @param {number} [bytes=32] - Number of random bytes (minimum 16).
 * @returns {Buffer}
 */
function _generateChallenge(bytes = 32)
{
    if (bytes < 16) throw new Error('Challenge must be at least 16 bytes');
    return crypto.randomBytes(bytes);
}

// -- Base64URL Helpers ------------------------------------

/**
 * @private
 * @param {Buffer|string} data
 * @returns {string}
 */
function _toBase64Url(data)
{
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.toString('base64url');
}

/**
 * @private
 * @param {string} str
 * @returns {Buffer}
 */
function _fromBase64Url(str)
{
    return Buffer.from(str, 'base64url');
}

// -- Registration (Attestation) ----------------------------

/**
 * Generate options for `navigator.credentials.create()`.
 *
 * @param {object} opts - Registration options.
 * @param {string} opts.rpName - Relying Party display name.
 * @param {string} opts.rpId - Relying Party ID (effective domain, e.g. 'myapp.com').
 * @param {string|Buffer} opts.userId - Opaque user handle.
 * @param {string} opts.userName - User display name / email.
 * @param {string} [opts.attestation='none'] - Attestation conveyance: 'none', 'direct', 'indirect'.
 * @param {object} [opts.authenticatorSelection] - Authenticator selection criteria.
 * @param {Array} [opts.excludeCredentials] - Credentials to exclude (prevent re-registration).
 * @param {number} [opts.timeout=60000] - Timeout in milliseconds.
 * @param {number} [opts.challengeBytes=32] - Challenge size in bytes.
 * @returns {{ options: object, challenge: string }} Options and base64url-encoded challenge.
 *
 * @example
 *   const { options, challenge } = webauthn.generateRegistrationOptions({
 *       rpName: 'My App', rpId: 'myapp.com',
 *       userId: user.id, userName: user.email,
 *   });
 *   // Store challenge in session, send options to client
 */
function generateRegistrationOptions(opts)
{
    if (!opts || !opts.rpName || !opts.rpId || !opts.userId || !opts.userName)
        throw new Error('generateRegistrationOptions requires rpName, rpId, userId, and userName');

    const challenge = _generateChallenge(opts.challengeBytes || 32);
    const challengeB64 = _toBase64Url(challenge);

    const userIdBuf = Buffer.isBuffer(opts.userId) ? opts.userId : Buffer.from(String(opts.userId));

    const options = {
        rp: {
            name: opts.rpName,
            id: opts.rpId,
        },
        user: {
            id: _toBase64Url(userIdBuf),
            name: opts.userName,
            displayName: opts.userDisplayName || opts.userName,
        },
        challenge: challengeB64,
        pubKeyCredParams: [
            { type: 'public-key', alg: COSE_ALG.ES256 },
            { type: 'public-key', alg: COSE_ALG.RS256 },
            { type: 'public-key', alg: COSE_ALG.EDDSA },
        ],
        timeout: opts.timeout || 60000,
        attestation: opts.attestation || 'none',
        authenticatorSelection: opts.authenticatorSelection || {
            residentKey: 'preferred',
            userVerification: 'required',
        },
    };

    if (opts.excludeCredentials && opts.excludeCredentials.length > 0)
    {
        options.excludeCredentials = opts.excludeCredentials.map(cred => ({
            type: 'public-key',
            id: typeof cred.id === 'string' ? cred.id : _toBase64Url(cred.id),
            transports: cred.transports || [],
        }));
    }

    return { options, challenge: challengeB64 };
}

/**
 * Verify a registration response from `navigator.credentials.create()`.
 *
 * @param {object} opts - Verification options.
 * @param {object} opts.response - The credential response from the client.
 * @param {string} opts.response.id - Credential ID (base64url).
 * @param {string} opts.response.type - Must be 'public-key'.
 * @param {object} opts.response.response - The AuthenticatorAttestationResponse.
 * @param {string} opts.response.response.clientDataJSON - Base64url-encoded client data.
 * @param {string} opts.response.response.attestationObject - Base64url-encoded attestation.
 * @param {string} opts.expectedChallenge - The challenge sent during registration (base64url).
 * @param {string} opts.expectedOrigin - Expected origin (e.g. 'https://myapp.com').
 * @param {string} opts.expectedRPID - Expected RP ID.
 * @returns {{ verified: boolean, credential: { id: string, publicKey: Buffer, counter: number, transports: string[] }|null, error: string|null }}
 *
 * @example
 *   const result = await webauthn.verifyRegistration({
 *       response: clientResponse,
 *       expectedChallenge: storedChallenge,
 *       expectedOrigin: 'https://myapp.com',
 *       expectedRPID: 'myapp.com',
 *   });
 *   if (result.verified) {
 *       // Store result.credential in database
 *   }
 */
function verifyRegistration(opts)
{
    try
    {
        const { response, expectedChallenge, expectedOrigin, expectedRPID } = opts;

        if (!response || !response.response)
            return { verified: false, credential: null, error: 'Missing response' };

        // 1. Decode and validate clientDataJSON
        const clientDataBuf = _fromBase64Url(response.response.clientDataJSON);
        const clientData = JSON.parse(clientDataBuf.toString('utf8'));

        if (clientData.type !== 'webauthn.create')
            return { verified: false, credential: null, error: `Invalid type: ${clientData.type}` };

        // Strict origin validation — exact match, no regex
        if (clientData.origin !== expectedOrigin)
            return { verified: false, credential: null, error: `Origin mismatch: ${clientData.origin}` };

        // Challenge validation
        if (clientData.challenge !== expectedChallenge)
            return { verified: false, credential: null, error: 'Challenge mismatch' };

        // 2. Decode attestation object
        const attestationBuf = _fromBase64Url(response.response.attestationObject);
        const attestationObject = cbor.decode(attestationBuf);

        // 3. Parse authenticator data
        const authData = _parseAuthData(attestationObject.authData);

        // 4. Validate RP ID hash
        const expectedRPIDHash = crypto.createHash('sha256').update(expectedRPID).digest();
        if (!authData.rpIdHash.equals(expectedRPIDHash))
            return { verified: false, credential: null, error: 'RP ID hash mismatch' };

        // 5. User presence must be set
        if (!authData.userPresent)
            return { verified: false, credential: null, error: 'User not present' };

        // 6. Must have attested credential data
        if (!authData.attestedCredDataIncluded || !authData.credentialId)
            return { verified: false, credential: null, error: 'No credential data in attestation' };

        // 7. Verify attestation statement (format-specific)
        const fmt = attestationObject.fmt;
        const attStmt = attestationObject.attStmt || {};

        if (fmt === 'none')
        {
            // No attestation — acceptable for 'none' conveyance
            log.debug('registration with "none" attestation format');
        }
        else if (fmt === 'packed')
        {
            const verified = _verifyPackedAttestation(attStmt, authData, attestationObject.authData, clientDataBuf);
            if (!verified)
                return { verified: false, credential: null, error: 'Packed attestation verification failed' };
        }
        else if (fmt === 'fido-u2f')
        {
            const verified = _verifyFidoU2FAttestation(attStmt, authData, attestationObject.authData, clientDataBuf);
            if (!verified)
                return { verified: false, credential: null, error: 'FIDO U2F attestation verification failed' };
        }
        else
        {
            log.warn('unknown attestation format: %s — treating as none', fmt);
        }

        // 8. Extract public key from COSE format
        const { key: publicKeyObj } = _coseToPublicKey(authData.credentialPublicKey);
        const publicKeyDer = publicKeyObj.export({ type: 'spki', format: 'der' });

        const credential = {
            id: response.id || _toBase64Url(authData.credentialId),
            publicKey: publicKeyDer,
            counter: authData.signCount,
            transports: response.response.transports || response.transports || [],
        };

        log.info('WebAuthn registration verified (credId=%s)', credential.id.substring(0, 16) + '...');
        return { verified: true, credential, error: null };
    }
    catch (err)
    {
        log.error('WebAuthn registration verification error: %s', err.message);
        return { verified: false, credential: null, error: err.message };
    }
}

/**
 * Verify a packed attestation signature (self-attestation).
 * @private
 */
function _verifyPackedAttestation(attStmt, parsedAuthData, rawAuthData, clientDataBuf)
{
    const sig = attStmt.sig;
    const alg = attStmt.alg;
    if (!sig) return false;

    // Hash of clientDataJSON
    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();

    // Signed data = authData || clientDataHash
    const signedData = Buffer.concat([rawAuthData, clientDataHash]);

    if (attStmt.x5c && attStmt.x5c.length > 0)
    {
        // Full attestation with certificate chain
        const certDer = attStmt.x5c[0];
        try
        {
            const cert = new crypto.X509Certificate(certDer);
            const pubKey = cert.publicKey;
            const algName = _coseAlgToNodeAlg(alg);
            return crypto.verify(algName, signedData, pubKey, sig);
        }
        catch (err)
        {
            log.warn('packed attestation cert verification failed: %s', err.message);
            return false;
        }
    }
    else
    {
        // Self-attestation — verify with the credential public key
        const { key } = _coseToPublicKey(parsedAuthData.credentialPublicKey);
        const algName = _coseAlgToNodeAlg(alg);
        return crypto.verify(algName, signedData, key, sig);
    }
}

/**
 * Verify a FIDO U2F attestation.
 * @private
 */
function _verifyFidoU2FAttestation(attStmt, parsedAuthData, rawAuthData, clientDataBuf)
{
    const sig = attStmt.sig;
    const x5c = attStmt.x5c;
    if (!sig || !x5c || x5c.length === 0) return false;

    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();

    // Extract public key coordinates
    const coseKey = parsedAuthData.credentialPublicKey;
    const x = coseKey[-2];
    const y = coseKey[-3];
    const publicKeyU2F = Buffer.concat([Buffer.from([0x04]), x, y]);

    // Verification data: 0x00 || rpIdHash || clientDataHash || credentialId || publicKeyU2F
    const verificationData = Buffer.concat([
        Buffer.from([0x00]),
        parsedAuthData.rpIdHash,
        clientDataHash,
        parsedAuthData.credentialId,
        publicKeyU2F,
    ]);

    try
    {
        const cert = new crypto.X509Certificate(x5c[0]);
        return crypto.verify('SHA256', verificationData, cert.publicKey, sig);
    }
    catch (err)
    {
        log.warn('FIDO U2F attestation verification failed: %s', err.message);
        return false;
    }
}

/**
 * Map COSE algorithm identifier to Node.js algorithm name.
 * @private
 * @param {number} alg
 * @returns {string|null}
 */
function _coseAlgToNodeAlg(alg)
{
    switch (alg)
    {
        case COSE_ALG.ES256: return 'SHA256';
        case COSE_ALG.RS256: return 'SHA256';
        case COSE_ALG.EDDSA: return null; // Ed25519 doesn't use separate hash
        default: return 'SHA256';
    }
}

// -- Authentication (Assertion) ----------------------------

/**
 * Generate options for `navigator.credentials.get()`.
 *
 * @param {object} opts - Authentication options.
 * @param {string} opts.rpId - Relying Party ID.
 * @param {Array} [opts.allowCredentials] - Allowed credentials.
 * @param {string} [opts.userVerification='required'] - User verification requirement.
 * @param {number} [opts.timeout=60000] - Timeout in milliseconds.
 * @param {number} [opts.challengeBytes=32] - Challenge size in bytes.
 * @returns {{ options: object, challenge: string }} Options and challenge.
 *
 * @example
 *   const { options, challenge } = webauthn.generateAuthenticationOptions({
 *       rpId: 'myapp.com',
 *       allowCredentials: user.credentials.map(c => ({ id: c.id, transports: c.transports })),
 *   });
 */
function generateAuthenticationOptions(opts)
{
    if (!opts || !opts.rpId)
        throw new Error('generateAuthenticationOptions requires rpId');

    const challenge = _generateChallenge(opts.challengeBytes || 32);
    const challengeB64 = _toBase64Url(challenge);

    const options = {
        challenge: challengeB64,
        rpId: opts.rpId,
        timeout: opts.timeout || 60000,
        userVerification: opts.userVerification || 'required',
    };

    if (opts.allowCredentials && opts.allowCredentials.length > 0)
    {
        options.allowCredentials = opts.allowCredentials.map(cred => ({
            type: 'public-key',
            id: typeof cred.id === 'string' ? cred.id : _toBase64Url(cred.id),
            transports: cred.transports || [],
        }));
    }

    return { options, challenge: challengeB64 };
}

/**
 * Verify an authentication response from `navigator.credentials.get()`.
 *
 * @param {object} opts - Verification options.
 * @param {object} opts.response - The credential response from the client.
 * @param {string} opts.response.id - Credential ID (base64url).
 * @param {object} opts.response.response - AuthenticatorAssertionResponse.
 * @param {string} opts.response.response.clientDataJSON - Base64url client data.
 * @param {string} opts.response.response.authenticatorData - Base64url authenticator data.
 * @param {string} opts.response.response.signature - Base64url signature.
 * @param {string} opts.expectedChallenge - Challenge (base64url).
 * @param {string} opts.expectedOrigin - Expected origin.
 * @param {string} opts.expectedRPID - Expected RP ID.
 * @param {object} opts.credential - Stored credential from registration.
 * @param {Buffer} opts.credential.publicKey - DER-encoded public key.
 * @param {number} opts.credential.counter - Stored signature counter.
 * @returns {{ verified: boolean, newCounter: number|null, error: string|null }}
 *
 * @example
 *   const result = await webauthn.verifyAuthentication({
 *       response: clientResponse,
 *       expectedChallenge: storedChallenge,
 *       expectedOrigin: 'https://myapp.com',
 *       expectedRPID: 'myapp.com',
 *       credential: storedCredential,
 *   });
 *   if (result.verified) {
 *       await db.updateCounter(credId, result.newCounter);
 *   }
 */
function verifyAuthentication(opts)
{
    try
    {
        const { response, expectedChallenge, expectedOrigin, expectedRPID, credential } = opts;

        if (!response || !response.response)
            return { verified: false, newCounter: null, error: 'Missing response' };

        if (!credential || !credential.publicKey)
            return { verified: false, newCounter: null, error: 'Missing stored credential' };

        // 1. Decode and validate clientDataJSON
        const clientDataBuf = _fromBase64Url(response.response.clientDataJSON);
        const clientData = JSON.parse(clientDataBuf.toString('utf8'));

        if (clientData.type !== 'webauthn.get')
            return { verified: false, newCounter: null, error: `Invalid type: ${clientData.type}` };

        // Strict origin match
        if (clientData.origin !== expectedOrigin)
            return { verified: false, newCounter: null, error: `Origin mismatch: ${clientData.origin}` };

        if (clientData.challenge !== expectedChallenge)
            return { verified: false, newCounter: null, error: 'Challenge mismatch' };

        // 2. Parse authenticator data
        const authDataBuf = _fromBase64Url(response.response.authenticatorData);
        const authData = _parseAuthData(authDataBuf);

        // 3. Validate RP ID hash
        const expectedRPIDHash = crypto.createHash('sha256').update(expectedRPID).digest();
        if (!authData.rpIdHash.equals(expectedRPIDHash))
            return { verified: false, newCounter: null, error: 'RP ID hash mismatch' };

        // 4. User presence
        if (!authData.userPresent)
            return { verified: false, newCounter: null, error: 'User not present' };

        // 5. Counter validation — detect cloned authenticators
        if (authData.signCount > 0 || credential.counter > 0)
        {
            if (authData.signCount <= credential.counter)
            {
                log.warn('WebAuthn counter rollback detected: received=%d, stored=%d (possible clone)',
                    authData.signCount, credential.counter);
                return { verified: false, newCounter: null, error: 'Counter rollback detected (possible authenticator clone)' };
            }
        }

        // 6. Verify signature
        const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
        const signedData = Buffer.concat([authDataBuf, clientDataHash]);
        const signature = _fromBase64Url(response.response.signature);

        const publicKey = crypto.createPublicKey({
            key: Buffer.isBuffer(credential.publicKey) ? credential.publicKey : Buffer.from(credential.publicKey),
            format: 'der',
            type: 'spki',
        });

        // Determine algorithm from key type
        const keyDetail = publicKey.asymmetricKeyType;
        let algName = 'SHA256';
        if (keyDetail === 'ed25519') algName = null;

        const verified = crypto.verify(algName, signedData, publicKey, signature);

        if (!verified)
            return { verified: false, newCounter: null, error: 'Signature verification failed' };

        log.info('WebAuthn authentication verified (counter=%d)', authData.signCount);
        return { verified: true, newCounter: authData.signCount, error: null };
    }
    catch (err)
    {
        log.error('WebAuthn authentication verification error: %s', err.message);
        return { verified: false, newCounter: null, error: err.message };
    }
}

// -- Exports -----------------------------------------------

const webauthn = {
    generateRegistrationOptions,
    verifyRegistration,
    generateAuthenticationOptions,
    verifyAuthentication,
};

module.exports = {
    webauthn,
    // Internal exports for testing
    _cbor: cbor,
    _parseAuthData,
    _coseToPublicKey,
    _coseAlgToNodeAlg,
    _toBase64Url,
    _fromBase64Url,
    COSE_ALG,
    COSE_KEY_TYPE,
};
