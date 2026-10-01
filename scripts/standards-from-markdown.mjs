#!/usr/bin/env node
// Migrates zero-server's docs/STANDARDS.md into docs/standards.toml.
//
// Every numbered conformance statement in the Markdown registry becomes one
// `[[entry]]` in the register that `cargo xtask standards` and `cargo xtask
// links` read: the statement is the entry's subject, the document it cites is
// its designation and url, the crate that owns the behavior is its evidence,
// and the test the statement names is its `at`. Each entry carries the
// release that ships the behavior, so `xtask standards --check` enforces the
// rows at or below `current_release` and reports the rest as pending.
//
//   node scripts/standards-from-markdown.mjs [path/to/STANDARDS.md]
//
// The default source is the sibling zero-server checkout. The source is read
// only; the output is docs/standards.toml under this repository.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT, '..', 'zero-server', 'docs', 'STANDARDS.md');
const OUTPUT = resolve(ROOT, 'docs', 'standards.toml');
const CURRENT_RELEASE = 1;

// The chapters of docs/capabilities.toml that the groups render under.
const GROUPS = [
  ['http', 'HTTP', 'Message framing, semantics, routing, static files and the request policy rules.'],
  ['tls', 'TLS', 'The handshake, protocol negotiation and the session defaults the server terminates.'],
  ['realtime', 'WebSocket and server-sent events', 'Framing, the close handshake and the event stream a browser reads.'],
  ['http3', 'HTTP/3 and QUIC', 'The QPACK and HTTP/3 codecs, and the transport they ride on.'],
  ['auth', 'Authentication', 'Cookies, sessions, tokens, the OAuth 2.0 flows and second factors.'],
  ['data', 'Databases', 'The wire protocols the drivers speak and the quoting rules the SQL renderer keeps.'],
  ['grpc', 'gRPC and Protocol Buffers', 'The gRPC framing over HTTP/2 and the protobuf wire format.'],
  ['observe', 'Observability', 'Metrics exposition, trace context and health reporting.'],
  ['runtime', 'Runtime', 'Shutdown, timeouts and configuration.'],
  ['webrtc', 'WebRTC', 'Signaling, session descriptions, ICE, STUN and TURN.'],
];

// One row per `###` heading of the source: the key prefix its entries take,
// the chapter they render under, the release that ships them and the crate
// that holds the test. `overrides` refine any of those by the document a
// statement cites, matched as a prefix of the citation.
const SECTIONS = {
  'HTTP semantics, routing, and responses': {
    key: 'routing', chapter: 'http', release: 1, crate: 'zero-router',
    overrides: { 'RFC 7239': { crate: 'zero-policy' } },
  },
  'HTTP/1.1 message framing': { key: 'h1', chapter: 'http', release: 1, crate: 'zero-http1' },
  'HTTP/2 and TLS transport': {
    key: 'h2', chapter: 'http', release: 2, crate: 'zero-h2',
    overrides: {
      'RFC 8446': { chapter: 'tls', crate: 'zero-tls', release: 1 },
      'RFC 7301': { chapter: 'tls', crate: 'zero-tls', release: 1 },
      'RFC 7541': { crate: 'zero-hpack' },
    },
  },
  'Error responses': { key: 'errors', chapter: 'http', release: 2, crate: 'zero-http' },
  'Body parsing': {
    key: 'body', chapter: 'http', release: 2, crate: 'zero-http',
    overrides: {
      'RFC 7578': { crate: 'zero-multipart' },
      'RFC 2046': { crate: 'zero-multipart' },
      'RFC 8259': { crate: 'zero-json', release: 1 },
      'URL Standard': { crate: 'zero-qs' },
    },
  },
  'Static files and conditional requests': { key: 'static', chapter: 'http', release: 1, crate: 'zero-static' },
  'Cookies and sessions': {
    key: 'cookies', chapter: 'http', release: 2, crate: 'zero-cookie',
    overrides: { 'OWASP Session Management': { chapter: 'auth', crate: 'zero-auth' } },
  },
  'CSRF, CORS, and security headers': {
    key: 'policy', chapter: 'http', release: 1, crate: 'zero-policy',
    overrides: { 'OWASP CSRF': { release: 2 } },
  },
  'Rate limiting': { key: 'ratelimit', chapter: 'http', release: 2, crate: 'zero-policy' },
  'Compression': { key: 'compress', chapter: 'http', release: 3, crate: 'zero-compress' },
  'JWT, JWS, and JWKS': { key: 'jwt', chapter: 'auth', release: 2, crate: 'zero-jwt' },
  'OAuth 2.0, PKCE, OpenID Connect, and bearer tokens': {
    key: 'oauth', chapter: 'auth', release: 3, crate: 'zero-auth',
    overrides: { 'RFC 6750': { crate: 'zero-policy', release: 2 } },
  },
  'Two-factor authentication and WebAuthn': {
    key: 'mfa', chapter: 'auth', release: 3, crate: 'zero-auth',
    overrides: { 'RFC 4226': { crate: 'zero-totp' }, 'RFC 6238': { crate: 'zero-totp' } },
  },
  'WebSocket and server-sent events': {
    key: 'realtime', chapter: 'realtime', release: 1, crate: 'zero-ws',
    overrides: {
      'HTML': { crate: 'zero-sse' },
      'RFC 7692': { release: 3 },
      'RFC 8441': { crate: 'zero-h2', release: 2 },
    },
  },
  'gRPC and Protocol Buffers': {
    key: 'grpc', chapter: 'grpc', release: 3, crate: 'zero-grpc',
    overrides: {
      'Encoding': { crate: 'zero-proto' },
      'Language Guide': { crate: 'zero-proto' },
      'Proto3 spec': { crate: 'zero-proto' },
    },
  },
  'Observability': {
    key: 'observe', chapter: 'observe', release: 3, crate: 'zero-observe',
    overrides: {
      'Exposition formats': { crate: 'zero-metrics' },
      'Line format': { crate: 'zero-metrics' },
      'Grouping and sorting': { crate: 'zero-metrics' },
      'OpenMetrics': { crate: 'zero-metrics' },
      'Metric and label naming': { crate: 'zero-metrics' },
      'Trace Context': { crate: 'zero-trace' },
      'Baggage': { crate: 'zero-trace' },
    },
  },
  'Runtime, lifecycle, and configuration': {
    key: 'runtime', chapter: 'runtime', release: 2, crate: 'zero-env',
    overrides: {
      'Node.js process, Signal': { crate: 'zero-serve', release: 1 },
      'Node.js process, Event': { crate: 'zero-serve', release: 1 },
      'Node.js http': { crate: 'zero-http', release: 1 },
      'RFC 9112': { crate: 'zero-http', release: 1 },
      'RFC 9110': { crate: 'zero-http', release: 1 },
      'RFC 9113': { crate: 'zero-h2', release: 2 },
      'RFC 6455': { crate: 'zero-ws', release: 1 },
      'Kubernetes': { crate: 'zero-serve', release: 1 },
      'Node.js cluster': { evidence: 'bindings/node/packages/sdk/src/cluster.ts', release: 3 },
      'Node.js zlib': { crate: 'zero-compress', release: 3 },
    },
  },
  'WebRTC signaling, STUN, TURN, and media servers': {
    key: 'webrtc', chapter: 'webrtc', release: 3, crate: 'zero-webrtc',
    overrides: {
      'RFC 8489': { crate: 'zero-stun' },
      'RFC 7064': { crate: 'zero-stun' },
      'RFC 8866': { crate: 'zero-sdp' },
      'RFC 8839': { crate: 'zero-sdp' },
      'RFC 8838': { crate: 'zero-sdp' },
      'RFC 8445': { crate: 'zero-sdp' },
      'RFC 9429': { crate: 'zero-sdp' },
    },
  },
  'Outbound HTTP client': { key: 'fetch', chapter: 'http', release: 2, crate: 'zero-fetch' },
  'PostgreSQL': { key: 'postgres', chapter: 'data', release: 2, crate: 'zero-pg-proto' },
  'MySQL': { key: 'mysql', chapter: 'data', release: 3, crate: 'zero-mysql-proto' },
  'MongoDB and BSON': {
    key: 'mongo', chapter: 'data', release: 3, crate: 'zero-mongo-proto',
    overrides: { 'BSON': { crate: 'zero-bson' } },
  },
  'Redis': { key: 'redis', chapter: 'data', release: 3, crate: 'zero-resp' },
  'SQLite': { key: 'sqlite', chapter: 'data', release: 3, crate: 'zero-sqlite' },
  'SQL identifier quoting and document field names': {
    key: 'sql', chapter: 'data', release: 2, crate: 'zero-sql',
    overrides: {
      'MySQL': { release: 3 },
      'SQLite': { release: 3 },
      'MongoDB': { crate: 'zero-mongo-proto', release: 3 },
      'BSON': { crate: 'zero-bson', release: 3 },
    },
  },
};

// Where a citation that is not an RFC lives, and who publishes it. The first
// matching prefix wins; the URL must appear in the source's sources index.
const DOCUMENTS = [
  ['rfc6265bis-22', 'draft-ietf-httpbis-rfc6265bis-22', 'IETF', 'https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-22.html'],
  ['draft-ietf-httpapi-ratelimit-headers-11', 'draft-ietf-httpapi-ratelimit-headers-11', 'IETF', 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/'],
  ['draft-inadarei-api-health-check-06', 'draft-inadarei-api-health-check-06', 'IETF', 'https://datatracker.ietf.org/doc/draft-inadarei-api-health-check/'],
  ['draft-uberti-behave-turn-rest-00', 'draft-uberti-behave-turn-rest-00', 'IETF', 'https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00'],
  ['OAuth 2.1', 'draft-ietf-oauth-v2-1-16', 'IETF', 'https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/'],
  ['OIDC Core', 'OpenID Connect Core 1.0', 'OpenID Foundation', 'https://openid.net/specs/openid-connect-core-1_0.html'],
  ['NIST SP 800-63B-4', 'NIST SP 800-63B-4', 'NIST', 'https://pages.nist.gov/800-63-4/sp800-63b.html'],
  ['OWASP CSRF', 'OWASP Cross-Site Request Forgery Prevention Cheat Sheet', 'OWASP', 'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html'],
  ['OWASP HTTP Security Response Headers', 'OWASP HTTP Security Response Headers Cheat Sheet', 'OWASP', 'https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html'],
  ['OWASP MFA', 'OWASP Multifactor Authentication Cheat Sheet', 'OWASP', 'https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html'],
  ['OWASP Session Management', 'OWASP Session Management Cheat Sheet', 'OWASP', 'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html'],
  ['Fetch Metadata', 'Fetch Metadata Request Headers', 'W3C', 'https://www.w3.org/TR/fetch-metadata/'],
  ['Fetch', 'Fetch Standard', 'WHATWG', 'https://fetch.spec.whatwg.org/'],
  ['URL Standard', 'URL Standard', 'WHATWG', 'https://url.spec.whatwg.org/'],
  ['HTML Section 9.2', 'HTML Standard, server-sent events', 'WHATWG', 'https://html.spec.whatwg.org/multipage/server-sent-events.html'],
  ['HTML', 'HTML Standard, loading web pages', 'WHATWG', 'https://html.spec.whatwg.org/multipage/browsers.html'],
  ['CSP3', 'Content Security Policy Level 3', 'W3C', 'https://www.w3.org/TR/CSP3/'],
  ['Referrer Policy', 'Referrer Policy', 'W3C', 'https://www.w3.org/TR/referrer-policy/'],
  ['Trace Context', 'Trace Context', 'W3C', 'https://www.w3.org/TR/trace-context/'],
  ['Baggage', 'Baggage', 'W3C', 'https://www.w3.org/TR/baggage/'],
  ['WebAuthn Level 3', 'Web Authentication Level 3', 'W3C', 'https://www.w3.org/TR/webauthn-3/'],
  ['WebRTC', 'WebRTC 1.0', 'W3C', 'https://www.w3.org/TR/webrtc/'],
  ['PROTOCOL-HTTP2', 'gRPC over HTTP2', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md'],
  ['statuscodes', 'gRPC status codes', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/statuscodes.md'],
  ['gRPC Compression', 'gRPC Compression', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/compression.md'],
  ['Keepalive User Guide', 'gRPC Keepalive User Guide', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/keepalive.md'],
  ['Load Balancing in gRPC', 'Load Balancing in gRPC', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/load-balancing.md'],
  ['health-checking.md', 'GRPC Health Checking Protocol', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/health-checking.md'],
  ['server-reflection.md', 'GRPC Server Reflection Protocol', 'gRPC', 'https://github.com/grpc/grpc/blob/master/doc/server-reflection.md'],
  ['health.proto', 'grpc.health.v1', 'gRPC', 'https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto'],
  ['reflection.proto', 'grpc.reflection.v1', 'gRPC', 'https://github.com/grpc/grpc-proto/blob/master/grpc/reflection/v1/reflection.proto'],
  ['Encoding', 'Protocol Buffers encoding', 'Google', 'https://protobuf.dev/programming-guides/encoding/'],
  ['Language Guide', 'Protocol Buffers language guide (proto3)', 'Google', 'https://protobuf.dev/programming-guides/proto3/'],
  ['Proto3 spec', 'Protocol Buffers language specification (proto3)', 'Google', 'https://protobuf.dev/reference/protobuf/proto3-spec/'],
  ['Exposition formats', 'Prometheus exposition formats', 'Prometheus', 'https://prometheus.io/docs/instrumenting/exposition_formats/'],
  ['Line format', 'Prometheus exposition formats', 'Prometheus', 'https://prometheus.io/docs/instrumenting/exposition_formats/'],
  ['Grouping and sorting', 'Prometheus exposition formats', 'Prometheus', 'https://prometheus.io/docs/instrumenting/exposition_formats/'],
  ['Metric and label naming', 'Prometheus metric and label naming', 'Prometheus', 'https://prometheus.io/docs/practices/naming/'],
  ['OpenMetrics', 'OpenMetrics 1.0', 'Prometheus', 'https://prometheus.io/docs/specs/om/open_metrics_spec/'],
  ['OTel Logs Data Model', 'OpenTelemetry Logs Data Model', 'OpenTelemetry', 'https://opentelemetry.io/docs/specs/otel/logs/data-model/'],
  ['Kubernetes Pod Lifecycle', 'Kubernetes Pod Lifecycle', 'Kubernetes', 'https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/'],
  ['Kubernetes probes', 'Kubernetes liveness, readiness and startup probes', 'Kubernetes', 'https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/'],
  ['The Twelve-Factor App', 'The Twelve-Factor App, III. Config', 'Adam Wiggins', 'https://12factor.net/config'],
  ['Node.js Environment Variables', 'Node.js v26.10.0 environment variables', 'Node.js', 'https://nodejs.org/api/environment_variables.html'],
  ['Node.js cluster', 'Node.js v26.10.0 cluster', 'Node.js', 'https://nodejs.org/api/cluster.html'],
  ['Node.js crypto', 'Node.js v26.10.0 crypto', 'Node.js', 'https://nodejs.org/api/crypto.html'],
  ['Node.js dgram', 'Node.js v26.10.0 dgram', 'Node.js', 'https://nodejs.org/api/dgram.html'],
  ['Node.js http2', 'Node.js v26.10.0 http2', 'Node.js', 'https://nodejs.org/api/http2.html'],
  ['Node.js https', 'Node.js v26.10.0 https', 'Node.js', 'https://nodejs.org/api/https.html'],
  ['Node.js http', 'Node.js v26.10.0 http', 'Node.js', 'https://nodejs.org/api/http.html'],
  ['Node.js process', 'Node.js v26.10.0 process', 'Node.js', 'https://nodejs.org/api/process.html'],
  ['Node.js tls', 'Node.js v26.10.0 tls', 'Node.js', 'https://nodejs.org/api/tls.html'],
  ['Node.js zlib', 'Node.js v26.10.0 zlib', 'Node.js', 'https://nodejs.org/api/zlib.html'],
  ['node:sqlite', 'Node.js v26.10.0 sqlite', 'Node.js', 'https://nodejs.org/api/sqlite.html'],
  ['LiveKit Room service API', 'LiveKit Room service API', 'LiveKit', 'https://docs.livekit.io/reference/server/server-apis/'],
  ['mediasoup v3 API', 'mediasoup v3 API', 'mediasoup', 'https://mediasoup.org/documentation/v3/mediasoup/api/'],
  ['PostgreSQL 54.1', 'PostgreSQL 18, 54.1 Overview', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/protocol-overview.html'],
  ['PostgreSQL 54.2', 'PostgreSQL 18, 54.2 Message Flow', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/protocol-flow.html'],
  ['PostgreSQL 54.3', 'PostgreSQL 18, 54.3 SASL Authentication', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/sasl-authentication.html'],
  ['PostgreSQL 54.7', 'PostgreSQL 18, 54.7 Message Formats', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/protocol-message-formats.html'],
  ['PostgreSQL 54.8', 'PostgreSQL 18, 54.8 Error and Notice Message Fields', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/protocol-error-fields.html'],
  ['PostgreSQL 4.1', 'PostgreSQL 18, 4.1 Lexical Structure', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/sql-syntax-lexical.html'],
  ['PostgreSQL', 'PostgreSQL 18, Chapter 54 Frontend/Backend Protocol', 'PostgreSQL Global Development Group', 'https://www.postgresql.org/docs/current/protocol.html'],
  ['MySQL 8.4 Reference Manual 8.4.1.2', 'MySQL 8.4 Reference Manual, 8.4.1.2', 'Oracle', 'https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html'],
  ['MySQL 11.2', 'MySQL 8.4 Reference Manual, 11.2', 'Oracle', 'https://dev.mysql.com/doc/refman/8.4/en/identifiers.html'],
  ['MySQL Packets', 'MySQL source documentation 26.7.0, MySQL Packets', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_packets.html'],
  ['MySQL command page', 'MySQL source documentation 26.7.0, Command Phase', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_command_phase.html'],
  ['MySQL connection page', 'MySQL source documentation 26.7.0, Connection Phase', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase.html'],
  ['Caching_sha2_password information', 'MySQL source documentation 26.7.0, Caching_sha2_password', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_caching_sha2_authentication_exchanges.html'],
  ['Integer Types', 'MySQL source documentation 26.7.0, Integer Types', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_dt_integers.html'],
  ['ERR_Packet', 'MySQL source documentation 26.7.0, ERR_Packet', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_err_packet.html'],
  ['OK_Packet', 'MySQL source documentation 26.7.0, OK_Packet', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_ok_packet.html'],
  ['Text Resultset', 'MySQL source documentation 26.7.0, Text Resultset', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_com_query_response_text_resultset.html'],
  ['Prepared Statements', 'MySQL source documentation 26.7.0, Prepared Statements', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_command_phase_ps.html'],
  ['Protocol::HandshakeResponse', 'MySQL source documentation 26.7.0, Protocol::HandshakeResponse', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase_packets_protocol_handshake_response.html'],
  ['Protocol::HandshakeV10', 'MySQL source documentation 26.7.0, Protocol::HandshakeV10', 'Oracle', 'https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase_packets_protocol_handshake_v10.html'],
  ['MongoDB Authentication', 'MongoDB specifications, Authentication', 'MongoDB', 'https://github.com/mongodb/specifications/blob/master/source/auth/auth.md'],
  ['MongoDB Handshake', 'MongoDB specifications, Handshake', 'MongoDB', 'https://github.com/mongodb/specifications/blob/master/source/mongodb-handshake/handshake.md'],
  ['MongoDB Wire Protocol', 'MongoDB 8.3 Wire Protocol', 'MongoDB', 'https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/'],
  ['MongoDB Field Names', 'MongoDB 8.3, Field Names with Periods and Dollar Signs', 'MongoDB', 'https://www.mongodb.com/docs/manual/core/dot-dollar-considerations/'],
  ['OP_MSG specification', 'MongoDB specifications, OP_MSG', 'MongoDB', 'https://github.com/mongodb/specifications/blob/master/source/message/OP_MSG.md'],
  ['BSON 1.1', 'BSON 1.1', 'BSON', 'https://bsonspec.org/spec.html'],
  ['RESP spec', 'Redis serialization protocol specification', 'Redis', 'https://redis.io/docs/latest/develop/reference/protocol-spec/'],
  ['Cluster spec', 'Redis cluster specification', 'Redis', 'https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/'],
  ['HELLO', 'Redis HELLO', 'Redis', 'https://redis.io/docs/latest/commands/hello/'],
  ['SQLite C-language Interface Specification', 'SQLite C-language interface', 'SQLite', 'https://www.sqlite.org/c3ref/intro.html'],
  ['SQLite Keywords', 'SQLite Keywords', 'SQLite', 'https://www.sqlite.org/lang_keywords.html'],
  ['SQLite Transaction', 'SQLite Transaction', 'SQLite', 'https://www.sqlite.org/lang_transaction.html'],
];

// Citations of a runtime or a hosted service pin a live implementation
// rather than a document's own rule.
const INTEROP = ['Node.js', 'node:sqlite', 'LiveKit', 'mediasoup', 'Kubernetes'];

const HEADER = `# The standards register: every published specification the zero-server core
# implements, the document that defines it, and the test in this repository that
# pins the implementation to that document's own rule or published vector.
# \`cargo xtask docs\` renders the standards page from this file and \`cargo xtask
# links\` fetches every \`url\`, so a specification that moves takes the build with
# it rather than sitting on the page looking authoritative.
#
# Generated by scripts/standards-from-markdown.mjs from zero-server's
# docs/STANDARDS.md; edit that source or the script, then regenerate.
#
# \`chapter\` is one of the capability chapters in docs/capabilities.toml, so a row
# points at the crates that implement it. \`designation\` is the document as its
# publisher writes it, including the revision where the publisher versions one.
# \`evidence\` is the file holding the test that asserts the statement, and \`at\`
# is text from the line to link, the test's \`fn\` line; the link follows that
# text wherever edits move it. \`release\` is the release that ships the behavior:
# \`cargo xtask standards --check\` fails when a row at or below \`current_release\`
# has no such line and reports the later rows as pending. \`anchor\` says what
# that test pins:
#   vector    the specification's published test vector or worked example
#   rule      the specification's own constants, bit layout or equation, asserted directly
#   interop   a live third-party implementation the test talks to
#   internal  a round trip only, with no external vector to pin against
# \`note\` carries the citation as the source registry wrote it.
`;

function fail(message)
{
  console.error(`standards-from-markdown: ${message}`);
  process.exit(1);
}

function tomlString(value)
{
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The test name a statement becomes: its first words in snake_case, prefixed
// when the statement opens with a number, since an identifier cannot.
function snake(text, words)
{
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, words)
    .join('_');
  return /^\d/.test(name) ? `status_${name}` : name;
}

// The trailing parenthetical of a statement, allowing one level of nesting.
function citationOf(statement)
{
  const match = statement.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?$/);
  if (!match) fail(`no citation on: ${statement}`);
  return match[1].trim();
}

function firstSection(citation)
{
  const section = citation.match(/(?:Sections?|Appendix)\s+([A-Z]?[\d.]*\d)/);
  if (!section) return '';
  return citation.includes('Appendix') ? `#appendix-${section[1]}` : `#section-${section[1]}`;
}

function resolveDocument(citation)
{
  const first = citation.split(';')[0].trim();
  const rfc = first.match(/^RFC (\d+)/);
  if (rfc)
  {
    return {
      name: `RFC ${rfc[1]}`,
      designation: `RFC ${rfc[1]}`,
      body: 'IETF',
      url: `https://www.rfc-editor.org/rfc/rfc${rfc[1]}.html${firstSection(first)}`,
    };
  }
  for (const [prefix, designation, body, url] of DOCUMENTS)
  {
    if (first.startsWith(prefix)) return { name: prefix, designation, body, url };
  }
  fail(`no document for citation: ${citation}`);
  return null;
}

function anchorOf(statement, citation)
{
  if (INTEROP.some((name) => citation.includes(name))) return 'interop';
  if (/`[A-Za-z0-9+/]{16,}=+`|`[0-9a-f]{16,}`|\bvector\b/i.test(statement)) return 'vector';
  return 'rule';
}

function parse(markdown)
{
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let section = null;
  let inChecklist = false;
  let sources = 0;
  for (const line of lines)
  {
    const heading = line.match(/^### (.*)$/);
    if (heading)
    {
      section = { heading: heading[1], statements: [] };
      sections.push(section);
      inChecklist = false;
      continue;
    }
    if (/^## /.test(line))
    {
      section = null;
      inChecklist = false;
      continue;
    }
    if (/^#### Conformance checklist/.test(line))
    {
      inChecklist = true;
      continue;
    }
    if (/^- https:\/\//.test(line)) sources += 1;
    const item = line.match(/^(\d+)\. (.*)$/);
    if (item && section && inChecklist)
    {
      section.statements.push({ number: Number(item[1]), text: item[2].trim() });
    }
  }
  return { sections: sections.filter((s) => s.statements.length > 0), sources };
}

function entriesOf(section)
{
  const config = SECTIONS[section.heading];
  if (!config) fail(`no section row for heading: ${section.heading}`);
  const entries = [];
  for (const { number, text } of section.statements)
  {
    const citation = citationOf(text);
    const subject = text.replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.?$/, '').trim();
    const document = resolveDocument(citation);
    let { chapter, release, crate } = config;
    let evidence = null;
    for (const [prefix, override] of Object.entries(config.overrides ?? {}))
    {
      if (!citation.startsWith(prefix)) continue;
      chapter = override.chapter ?? chapter;
      release = override.release ?? release;
      crate = override.crate ?? crate;
      evidence = override.evidence ?? evidence;
      break;
    }
    entries.push({
      key: `${config.key}-${String(number).padStart(2, '0')}`,
      chapter,
      designation: document.designation,
      body: document.body,
      subject,
      url: document.url,
      evidence: evidence ?? `crates/${crate}/src/lib.rs`,
      at: `fn ${snake(subject, 12)}`,
      anchor: anchorOf(text, citation),
      release,
      note: citation,
    });
  }
  return entries;
}

function render(sections)
{
  const out = [HEADER, `current_release = ${CURRENT_RELEASE}`, ''];
  for (const [chapter, title, intent] of GROUPS)
  {
    out.push('[[group]]', `chapter = ${tomlString(chapter)}`, `title = ${tomlString(title)}`, `intent = ${tomlString(intent)}`, '');
  }
  const keys = new Set();
  const perRelease = new Map();
  let total = 0;
  for (const section of sections)
  {
    out.push('', `# ${section.heading}`, '');
    for (const entry of entriesOf(section))
    {
      if (keys.has(entry.key)) fail(`duplicate key ${entry.key}`);
      keys.add(entry.key);
      total += 1;
      perRelease.set(entry.release, (perRelease.get(entry.release) ?? 0) + 1);
      out.push('[[entry]]');
      for (const field of ['key', 'chapter', 'designation', 'body', 'subject', 'url', 'evidence', 'at', 'anchor'])
      {
        out.push(`${field} = ${tomlString(entry[field])}`);
      }
      out.push(`release = ${entry.release}`);
      out.push(`note = ${tomlString(entry.note)}`);
      out.push('');
    }
  }
  return { text: out.join('\n'), total, perRelease };
}

const { sections, sources } = parse(readFileSync(SOURCE, 'utf8'));
const { text, total, perRelease } = render(sections);
writeFileSync(OUTPUT, text, 'utf8');
const releases = [...perRelease.entries()].sort().map(([r, n]) => `release ${r}: ${n}`).join(', ');
console.log(`docs/standards.toml: ${total} entries from ${sections.length} sections and ${sources} sources (${releases})`);
