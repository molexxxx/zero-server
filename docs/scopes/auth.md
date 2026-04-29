# Authentication & Authorization

> JWT, sessions, OAuth, authorize, MFA stack.

## Install

```bash
npm install @zero-server/auth
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Full auth layer with no external libraries: JWT (sign/verify/decode/JWKS/refresh pairs), session middleware with pluggable stores, OAuth 2.0 with PKCE and pre-configured providers, role/permission policies, and the MFA stack (TOTP/WebAuthn/trusted-device/enrollment).

## Usage

```js
const { createRefreshToken } = require('@zero-server/auth')
```

## Public surface

`@zero-server/auth` exports the following public names:

| Symbol |
| --- |
| `jwt` |
| `jwtSign` |
| `jwtVerify` |
| `jwtDecode` |
| `jwks` |
| `tokenPair` |
| `createRefreshToken` |
| `SUPPORTED_ALGORITHMS` |
| `session` |
| `Session` |
| `MemoryStore` |
| `oauth` |
| `generatePKCE` |
| `generateState` |
| `OAUTH_PROVIDERS` |
| `authorize` |
| `can` |
| `canAny` |
| `Policy` |
| `gate` |
| `attachUserHelpers` |
| `twoFactor` |
| `webauthn` |
| `trustedDevice` |
| `enrollment` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/auth`](../../packages/auth)
