/**
 * @module webrtc/ice
 * @description Zero-dependency ICE candidate parser, serializer, and address
 *   classifiers (private / loopback / link-local / mDNS) per RFC 8839,
 *   plus a `filterCandidates` helper used by `SignalingHub` to enforce
 *   privacy-preserving policies on relayed offers/answers.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8839
 * @see https://datatracker.ietf.org/doc/html/rfc5245
 */

'use strict';

const { IceError } = require('../errors');

// -- Constants -----------------------------------------------------

/**
 * Recognised ICE candidate types (RFC 5245).
 * @type {ReadonlyArray<string>}
 */
const CANDIDATE_TYPES = Object.freeze(['host', 'srflx', 'prflx', 'relay']);

/**
 * Recognised TCP candidate types (RFC 6544 §4.5).
 * @type {ReadonlyArray<string>}
 */
const TCP_TYPES = Object.freeze(['active', 'passive', 'so']);

// -- Public types --------------------------------------------------

/**
 * @typedef {object} IceCandidate
 * @property {string}  foundation
 * @property {number}  component
 * @property {string}  transport   - 'udp' or 'tcp' (lowercased).
 * @property {number}  priority
 * @property {string}  address     - IPv4, IPv6, or mDNS hostname.
 * @property {number}  port
 * @property {string}  type        - One of CANDIDATE_TYPES.
 * @property {string}  [relatedAddress] - From `raddr`.
 * @property {number}  [relatedPort]    - From `rport`.
 * @property {string}  [tcpType]        - From `tcptype` (active/passive/so).
 * @property {Object<string,string>} extensions - All other key/value pairs, insertion-ordered.
 */

// =================================================================
// Parser
// =================================================================

/**
 * Parse a single ICE candidate line.
 *
 * Accepts inputs with or without the `a=` SDP-attribute prefix.  Returns
 * a plain object; throws `IceError` on any structural problem.
 *
 * @param {string} line - Candidate line, e.g.
 *   `candidate:842163049 1 udp 1677729535 192.168.1.5 50000 typ host`.
 * @returns {IceCandidate} Parsed candidate.
 * @throws {IceError} On malformed input.
 *
 * @example
 *   const c = parseCandidate('candidate:1 1 udp 2122194687 1.2.3.4 50001 typ srflx raddr 192.168.1.5 rport 50000');
 *   if (c.type === 'relay') { console.log('relay candidate'); }
 *
 * @section ICE & TURN
 */
function parseCandidate(line)
{
    if (typeof line !== 'string')
        throw new IceError('parseCandidate: input must be a string');

    let s = line.trim();
    if (s.startsWith('a=')) s = s.slice(2);
    if (!s.startsWith('candidate:'))
        throw new IceError('parseCandidate: missing "candidate:" prefix', { candidate: line });
    s = s.slice('candidate:'.length);

    const tok = s.split(/\s+/);
    if (tok.length < 8)
        throw new IceError('parseCandidate: too few tokens', { candidate: line });

    const [foundation, componentStr, transportRaw, priorityStr,
        address, portStr, typKw, type, ...rest] = tok;

    if (typKw !== 'typ')
        throw new IceError('parseCandidate: expected "typ" keyword', { candidate: line });
    if (!CANDIDATE_TYPES.includes(type))
        throw new IceError(`parseCandidate: unknown type "${type}"`, { candidate: line });

    const component = Number(componentStr);
    const priority  = Number(priorityStr);
    const port      = Number(portStr);
    if (!Number.isInteger(component) || component < 0)
        throw new IceError('parseCandidate: invalid component', { candidate: line });
    if (!Number.isFinite(priority))
        throw new IceError('parseCandidate: invalid priority', { candidate: line });
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new IceError('parseCandidate: invalid port', { candidate: line });

    /** @type {IceCandidate} */
    const out = {
        foundation,
        component,
        transport: transportRaw.toLowerCase(),
        priority,
        address,
        port,
        type,
        extensions: {},
    };

    // Walk remaining key/value pairs.  raddr / rport / tcptype are lifted
    // to named fields; everything else lands in `extensions` in input order.
    for (let i = 0; i < rest.length - 1; i += 2)
    {
        const k = rest[i];
        const v = rest[i + 1];
        if (k === 'raddr')        out.relatedAddress = v;
        else if (k === 'rport')   out.relatedPort = Number(v);
        else if (k === 'tcptype') out.tcpType = v;
        else                       out.extensions[k] = v;
    }

    return out;
}

// =================================================================
// Serializer
// =================================================================

/**
 * Serialize a parsed candidate back to its canonical line format.
 * Round-trips outputs of `parseCandidate` exactly, including the
 * insertion order of `extensions`.
 *
 * @param {IceCandidate} c - Parsed candidate object.
 * @returns {string} `candidate:...` line (no `a=` prefix).
 * @throws {IceError} If required fields are missing.
 *
 * @example
 *   const out = stringifyCandidate(parseCandidate(line));
 *
 * @section ICE & TURN
 */
function stringifyCandidate(c)
{
    if (!c || typeof c !== 'object')
        throw new IceError('stringifyCandidate: input must be an object');
    const required = ['foundation', 'component', 'transport', 'priority', 'address', 'port', 'type'];
    for (const k of required)
    {
        if (c[k] === undefined || c[k] === null)
            throw new IceError(`stringifyCandidate: missing "${k}"`);
    }

    let s = `candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority} ${c.address} ${c.port} typ ${c.type}`;
    if (c.relatedAddress !== undefined) s += ` raddr ${c.relatedAddress}`;
    if (c.relatedPort !== undefined)    s += ` rport ${c.relatedPort}`;
    if (c.tcpType !== undefined)        s += ` tcptype ${c.tcpType}`;
    if (c.extensions)
    {
        for (const [k, v] of Object.entries(c.extensions))
            s += ` ${k} ${v}`;
    }
    return s;
}

// =================================================================
// Address classifiers
// =================================================================

/**
 * Test whether the address looks like an IPv4 string.
 * @private
 */
function _isIPv4(addr)
{
    if (typeof addr !== 'string') return false;
    const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    for (let i = 1; i <= 4; i++) if (Number(m[i]) > 255) return false;
    return true;
}

/**
 * Test whether the address looks like an IPv6 string (very permissive).
 * @private
 */
function _isIPv6(addr)
{
    if (typeof addr !== 'string') return false;
    return addr.includes(':') && /^[0-9a-fA-F:]+$/.test(addr);
}

/**
 * True for RFC 1918, RFC 6598 (CGNAT), and IPv6 ULA (RFC 4193) addresses.
 *
 * @param {string} addr - Address to classify.
 * @returns {boolean}
 *
 * @section ICE & TURN
 */
function isPrivateIp(addr)
{
    if (_isIPv4(addr))
    {
        const [a, b] = addr.split('.').map(Number);
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
        return false;
    }
    if (_isIPv6(addr))
    {
        // fc00::/7 ULA
        const head = addr.toLowerCase().split(':')[0];
        if (head.length === 0) return false;
        const n = parseInt(head, 16);
        return (n & 0xfe00) === 0xfc00;
    }
    return false;
}

/**
 * True for IPv4 127.0.0.0/8 and IPv6 ::1.
 *
 * @param {string} addr - Address to classify.
 * @returns {boolean}
 *
 * @section ICE & TURN
 */
function isLoopbackIp(addr)
{
    if (_isIPv4(addr)) return addr.startsWith('127.');
    if (_isIPv6(addr)) return addr === '::1' || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(addr);
    return false;
}

/**
 * True for IPv4 169.254/16 and IPv6 fe80::/10.
 *
 * @param {string} addr - Address to classify.
 * @returns {boolean}
 *
 * @section ICE & TURN
 */
function isLinkLocalIp(addr)
{
    if (_isIPv4(addr)) return addr.startsWith('169.254.');
    if (_isIPv6(addr))
    {
        const head = addr.toLowerCase().split(':')[0];
        if (head.length === 0) return false;
        const n = parseInt(head, 16);
        return (n & 0xffc0) === 0xfe80;
    }
    return false;
}

/**
 * True for mDNS `.local` hostnames used by browsers to avoid leaking
 * local IPs (Chrome's mDNS ICE candidates - RFC 8624 / draft-ietf-mmusic-mdns-ice-candidates).
 *
 * @param {string} host - Hostname to test.
 * @returns {boolean}
 *
 * @section ICE & TURN
 */
function isMdnsHostname(host)
{
    if (typeof host !== 'string') return false;
    if (_isIPv4(host) || _isIPv6(host)) return false;
    return host.toLowerCase().endsWith('.local');
}

// =================================================================
// Policy filter
// =================================================================

/**
 * @typedef {object} CandidateFilterPolicy
 * @property {boolean}  [blockPrivate=false] - Drop private / loopback / link-local addresses.
 * @property {boolean}  [blockMdns=false]    - Drop `.local` (mDNS) hostnames.
 * @property {boolean}  [blockTcp=false]     - Drop TCP-transport candidates.
 * @property {ReadonlyArray<string>} [allowedTypes] - Whitelist of `type` values (host/srflx/prflx/relay).
 * @property {number}   [maxCandidates]      - Cap the number of returned candidates.
 * @property {(c:IceCandidate)=>boolean} [predicate] - Custom drop function (return false to drop).
 */

/**
 * Filter an array of candidates (lines or parsed objects) against a policy.
 *
 * Returns the same shape it was given: if you pass strings you get strings
 * back; if you pass parsed objects you get parsed objects back.  Unparseable
 * string lines are silently skipped so a single bad candidate never poisons
 * the whole offer.
 *
 * @param {Array<string|IceCandidate>} candidates - Input list.
 * @param {CandidateFilterPolicy} [policy={}] - Policy (all defaults are permissive).
 * @returns {Array<string|IceCandidate>} Surviving candidates, same element shape as input.
 *
 * @example
 *   const safe = filterCandidates(offer.candidates, {
 *       blockPrivate: true,
 *       blockMdns:    true,
 *       allowedTypes: ['srflx', 'relay'],
 *   });
 *
 * @section ICE & TURN
 */
function filterCandidates(candidates, policy = {})
{
    if (!Array.isArray(candidates)) return [];
    const {
        blockPrivate = false,
        blockMdns    = false,
        blockTcp     = false,
        allowedTypes,
        maxCandidates,
        predicate,
    } = policy;

    const out = [];
    for (const item of candidates)
    {
        const isString = typeof item === 'string';
        let parsed;
        try { parsed = isString ? parseCandidate(item) : item; }
        catch { continue; }
        if (!parsed) continue;

        if (allowedTypes && !allowedTypes.includes(parsed.type)) continue;
        if (blockTcp && parsed.transport === 'tcp') continue;
        if (blockMdns && isMdnsHostname(parsed.address)) continue;
        if (blockPrivate)
        {
            const a = parsed.address;
            const r = parsed.relatedAddress;
            const isLocal = (x) => x && (isPrivateIp(x) || isLoopbackIp(x) || isLinkLocalIp(x));
            if (isLocal(a) || isLocal(r)) continue;
        }
        if (predicate && !predicate(parsed)) continue;

        out.push(isString ? item : parsed);
        if (maxCandidates && out.length >= maxCandidates) break;
    }
    return out;
}

module.exports = {
    parseCandidate,
    stringifyCandidate,
    isPrivateIp,
    isLoopbackIp,
    isLinkLocalIp,
    isMdnsHostname,
    filterCandidates,
    CANDIDATE_TYPES,
    TCP_TYPES,
    IceError,
};
