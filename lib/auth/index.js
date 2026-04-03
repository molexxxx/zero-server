/**
 * @module auth
 * @description Authentication & authorization barrel export.
 *              Re-exports JWT, Session, OAuth2, and Authorization helpers.
 */

const { jwt, sign, verify, decode, jwks, tokenPair, createRefreshToken, SUPPORTED_ALGORITHMS } = require('./jwt');
const { session, Session, MemoryStore } = require('./session');
const { oauth, generatePKCE, generateState, PROVIDERS } = require('./oauth');
const { authorize, can, canAny, Policy, gate, attachUserHelpers } = require('./authorize');

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
};
