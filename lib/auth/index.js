/**
 * @module auth
 * @description Authentication & authorization barrel export.
 *              Re-exports JWT, Session, OAuth2, and Authorization helpers.
 */

const { jwt, sign, verify, decode, jwks, tokenPair, createRefreshToken, SUPPORTED_ALGORITHMS } = require('./jwt');
const { session, Session, MemoryStore } = require('./session');
const { oauth, generatePKCE, generateState, PROVIDERS } = require('./oauth');
const { authorize, can, canAny, Policy, gate, attachUserHelpers } = require('./authorize');
const twoFactor = require('./twoFactor');
const { webauthn } = require('./webauthn');
const { trustedDevice } = require('./trustedDevice');
const { enrollment } = require('./enrollment');

module.exports = {
    // JWT
    jwt,
    sign,
    verify,
    decode,
    jwks,
    tokenPair,
    createRefreshToken,
    SUPPORTED_ALGORITHMS,

    // Session
    session,
    Session,
    MemoryStore,

    // OAuth2
    oauth,
    generatePKCE,
    generateState,
    PROVIDERS,

    // Authorization
    authorize,
    can,
    canAny,
    Policy,
    gate,
    attachUserHelpers,

    // Two-Factor Authentication
    twoFactor,

    // WebAuthn / Passkeys
    webauthn,

    // Trusted Device / Remember Me
    trustedDevice,

    // 2FA Enrollment Flow
    enrollment,
};
