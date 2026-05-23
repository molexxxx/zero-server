/**
 * @module webrtc/sdp
 * @description Zero-dependency RFC 8866 SDP parser and serializer with
 *   WebRTC-specific attribute extraction per RFC 8829 (ice-ufrag, ice-pwd,
 *   fingerprint, setup, mid, rtcp-mux, rtpmap, fmtp, ssrc, etc.). Pure
 *   structure — policy lives in the signaling layer.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8866
 * @see https://datatracker.ietf.org/doc/html/rfc8829
 */

'use strict';

const { SdpError } = require('../errors');

// -- Constants -----------------------------------------------------

const CRLF = '\r\n';
const DEFAULT_MAX_BYTES = 65_536; // 64 KiB - sane WebRTC offer ceiling

/**
 * Valid SDP direction attributes (RFC 8866 §6.7).
 * @type {ReadonlyArray<string>}
 */
const DIRECTIONS = Object.freeze(['sendrecv', 'sendonly', 'recvonly', 'inactive']);

// -- Public types --------------------------------------------------

/**
 * @typedef {object} SdpOrigin
 * @property {string} username
 * @property {string} sessionId
 * @property {number} sessionVersion
 * @property {string} netType
 * @property {string} addrType
 * @property {string} address
 */

/**
 * @typedef {object} SdpConnection
 * @property {string} netType
 * @property {string} addrType
 * @property {string} address
 */

/**
 * @typedef {object} SdpAttribute
 * @property {string} key
 * @property {string} value - Empty string for flag-only attributes.
 */

/**
 * @typedef {object} SdpRtpMap
 * @property {number} payload
 * @property {string} codec
 * @property {number} clockRate
 * @property {number|undefined} channels
 */

/**
 * @typedef {object} SdpFmtp
 * @property {number} payload
 * @property {string} config
 */

/**
 * @typedef {object} SdpRid
 * @property {string} id
 * @property {string} direction - 'send' or 'recv'.
 * @property {string} params - Remaining rid params (may be empty).
 */

/**
 * @typedef {object} SdpExtMap
 * @property {number} id
 * @property {string|undefined} direction
 * @property {string} uri
 * @property {string|undefined} config
 */

/**
 * @typedef {object} SdpSsrcAttr
 * @property {number} id
 * @property {string} attribute
 * @property {string} value
 */

/**
 * @typedef {object} SdpFingerprint
 * @property {string} algorithm
 * @property {string} value
 */

/**
 * @typedef {object} SdpMedia
 * @property {string}              kind        - 'audio', 'video', 'application', etc.
 * @property {number}              port
 * @property {number|undefined}    numPorts
 * @property {string}              proto       - e.g. 'UDP/TLS/RTP/SAVPF'.
 * @property {string[]}            fmts        - Format / payload-type list.
 * @property {SdpConnection|undefined} connection
 * @property {SdpAttribute[]}      attributes  - Raw attribute list (round-trip source of truth).
 * @property {string|undefined}    mid
 * @property {boolean}             rtcpMux
 * @property {SdpFingerprint|undefined} fingerprint
 * @property {string|undefined}    iceUfrag
 * @property {string|undefined}    icePwd
 * @property {string|undefined}    setup       - 'actpass' | 'active' | 'passive' | 'holdconn'.
 * @property {string|undefined}    direction
 * @property {string[]}            candidates  - Raw candidate lines (without "a=" prefix).
 * @property {SdpRtpMap[]}         rtpmaps
 * @property {SdpFmtp[]}           fmtps
 * @property {SdpRid[]}            rids
 * @property {Object<string,string>} simulcast - { send?: '<layers>', recv?: '<layers>' }.
 * @property {SdpExtMap[]}         extmaps
 * @property {SdpSsrcAttr[]}       ssrcs
 */

/**
 * @typedef {object} SessionDescription
 * @property {number}        version
 * @property {SdpOrigin}     origin
 * @property {string}        sessionName
 * @property {SdpConnection|undefined} connection
 * @property {Array<{start:number,stop:number}>} timing
 * @property {SdpAttribute[]} attributes
 * @property {SdpMedia[]}    media
 */

// =================================================================
// Parser
// =================================================================

/**
 * Parse an SDP document into a structured `SessionDescription`.
 *
 * Accepts CRLF (RFC 8866) or LF-only line endings.  Validates the leading
 * `v=` line, refuses oversized payloads, and tolerates unknown attribute
 * keys by preserving them on the raw `attributes` list.
 *
 * @param {string} text - The SDP document text.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=65536] - Reject payloads larger than this.
 * @returns {SessionDescription} Parsed structure.
 * @throws {SdpError} On malformed input, oversized payload, or non-string arg.
 *
 * @example
 *   const { parseSdp } = require('@zero-server/webrtc');
 *   const desc = parseSdp(offer.sdp);
 *   console.log(desc.media[0].iceUfrag, desc.media[0].fingerprint);
 *
 * @section Signaling
 */
function parseSdp(text, opts = {})
{
    if (typeof text !== 'string') throw new SdpError('parseSdp: input must be a string');
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (text.length > maxBytes) throw new SdpError(`parseSdp: payload exceeds ${maxBytes} bytes`);
    if (text.length === 0) throw new SdpError('parseSdp: empty input');

    const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
    if (lines.length === 0) throw new SdpError('parseSdp: no non-empty lines');

    /** @type {SessionDescription} */
    const session = {
        version:     0,
        origin:      undefined,
        sessionName: '',
        connection:  undefined,
        timing:      [],
        attributes:  [],
        media:       [],
    };

    let current = session;       // session-level or current media section
    let inMedia = false;

    for (let i = 0; i < lines.length; i++)
    {
        const raw = lines[i];
        const eq  = raw.indexOf('=');
        if (eq < 1) throw new SdpError(`parseSdp: malformed line ${i + 1}`, { line: i + 1 });
        const type = raw.slice(0, eq);
        const val  = raw.slice(eq + 1);

        if (i === 0 && type !== 'v')
            throw new SdpError('parseSdp: SDP must start with v=', { line: 1 });

        switch (type)
        {
            case 'v':
                session.version = Number(val);
                break;

            case 'o':
                session.origin = _parseOrigin(val, i + 1);
                break;

            case 's':
                session.sessionName = val;
                break;

            case 'c':
                current.connection = _parseConnection(val, i + 1);
                break;

            case 't':
            {
                const [start, stop] = val.split(/\s+/).map(Number);
                session.timing.push({ start, stop });
                break;
            }

            case 'm':
                current = _newMedia(val, i + 1);
                session.media.push(current);
                inMedia = true;
                break;

            case 'a':
            {
                const attr = _parseAttribute(val);
                current.attributes.push(attr);
                if (inMedia) _absorbMediaAttr(current, attr);
                break;
            }

            // Other RFC 8866 line types we don't lift into structured fields but
            // also do not reject - they survive as session.attributes is the
            // round-trip source of truth for media attributes only.  v/o/s/t/c
            // are the only session-level lines we currently emit on serialize.
            default:
                // Tolerated but not stored (i, u, e, p, b, r, z, k).
                break;
        }
    }

    if (!session.origin)
        throw new SdpError('parseSdp: missing o= line');

    return session;
}

// -- Parser helpers ------------------------------------------------

/** @private */
function _parseOrigin(val, line)
{
    const parts = val.split(/\s+/);
    if (parts.length < 6)
        throw new SdpError('parseSdp: malformed o= line', { line });
    return {
        username:       parts[0],
        sessionId:      parts[1],
        sessionVersion: Number(parts[2]),
        netType:        parts[3],
        addrType:       parts[4],
        address:        parts.slice(5).join(' '),
    };
}

/** @private */
function _parseConnection(val, line)
{
    const parts = val.split(/\s+/);
    if (parts.length < 3)
        throw new SdpError('parseSdp: malformed c= line', { line });
    return { netType: parts[0], addrType: parts[1], address: parts[2] };
}

/** @private */
function _newMedia(val, line)
{
    const parts = val.split(/\s+/);
    if (parts.length < 4)
        throw new SdpError('parseSdp: malformed m= line', { line });
    const [kind, portSpec, proto, ...fmts] = parts;
    let port, numPorts;
    if (portSpec.includes('/'))
    {
        const [p, n] = portSpec.split('/');
        port = Number(p); numPorts = Number(n);
    }
    else
    {
        port = Number(portSpec);
    }
    return {
        kind, port, numPorts, proto, fmts,
        connection: undefined,
        attributes: [],
        mid: undefined,
        rtcpMux: false,
        fingerprint: undefined,
        iceUfrag: undefined,
        icePwd: undefined,
        setup: undefined,
        direction: undefined,
        candidates: [],
        rtpmaps: [],
        fmtps: [],
        rids: [],
        simulcast: {},
        extmaps: [],
        ssrcs: [],
    };
}

/** @private */
function _parseAttribute(val)
{
    const colon = val.indexOf(':');
    if (colon === -1) return { key: val, value: '' };
    return { key: val.slice(0, colon), value: val.slice(colon + 1) };
}

/** @private */
function _absorbMediaAttr(media, attr)
{
    const { key, value } = attr;

    if (DIRECTIONS.includes(key)) { media.direction = key; return; }

    switch (key)
    {
        case 'mid':       media.mid = value; return;
        case 'rtcp-mux':  media.rtcpMux = true; return;
        case 'ice-ufrag': media.iceUfrag = value; return;
        case 'ice-pwd':   media.icePwd = value; return;
        case 'setup':     media.setup = value; return;

        case 'fingerprint':
        {
            const space = value.indexOf(' ');
            if (space === -1) return;
            media.fingerprint = {
                algorithm: value.slice(0, space).toLowerCase(),
                value:     value.slice(space + 1).trim().toUpperCase(),
            };
            return;
        }

        case 'candidate':
            media.candidates.push(`candidate:${value}`);
            return;

        case 'rtpmap':
        {
            // <PT> <codec>/<rate>[/<channels>]
            const space = value.indexOf(' ');
            if (space === -1) return;
            const payload = Number(value.slice(0, space));
            const tail    = value.slice(space + 1).split('/');
            media.rtpmaps.push({
                payload,
                codec:     tail[0],
                clockRate: Number(tail[1]),
                channels:  tail[2] !== undefined ? Number(tail[2]) : undefined,
            });
            return;
        }

        case 'fmtp':
        {
            const space = value.indexOf(' ');
            if (space === -1) return;
            media.fmtps.push({
                payload: Number(value.slice(0, space)),
                config:  value.slice(space + 1),
            });
            return;
        }

        case 'rid':
        {
            // <id> <direction> [params]
            const parts = value.split(/\s+/);
            if (parts.length < 2) return;
            media.rids.push({
                id:        parts[0],
                direction: parts[1],
                params:    parts.slice(2).join(' '),
            });
            return;
        }

        case 'simulcast':
        {
            // simulcast:<dir> <layers> [<dir> <layers>]
            const parts = value.split(/\s+/);
            for (let i = 0; i < parts.length; i += 2)
            {
                if (parts[i] && parts[i + 1] !== undefined)
                    media.simulcast[parts[i]] = parts[i + 1];
            }
            return;
        }

        case 'extmap':
        {
            // <id>[/<direction>] <uri> [<config>]
            const space = value.indexOf(' ');
            if (space === -1) return;
            const idPart = value.slice(0, space);
            const rest   = value.slice(space + 1).trim();
            const [idStr, direction] = idPart.split('/');
            const space2 = rest.indexOf(' ');
            const uri    = space2 === -1 ? rest : rest.slice(0, space2);
            const config = space2 === -1 ? undefined : rest.slice(space2 + 1);
            media.extmaps.push({ id: Number(idStr), direction, uri, config });
            return;
        }

        case 'ssrc':
        {
            // <id> <attr>[:<value>]
            const space = value.indexOf(' ');
            if (space === -1) return;
            const id      = Number(value.slice(0, space));
            const attrTok = value.slice(space + 1);
            const colon   = attrTok.indexOf(':');
            const attribute = colon === -1 ? attrTok : attrTok.slice(0, colon);
            const v         = colon === -1 ? '' : attrTok.slice(colon + 1);
            media.ssrcs.push({ id, attribute, value: v });
            return;
        }

        default:
            return;
    }
}

// =================================================================
// Serializer
// =================================================================

/**
 * Serialize a `SessionDescription` back to RFC 8866 text with CRLF
 * line endings.  The serializer is round-trip safe for documents
 * produced by `parseSdp`: it emits the raw attribute list verbatim so
 * any media-level attribute we did not lift into a structured field is
 * still preserved.
 *
 * @param {SessionDescription} session - Parsed session description.
 * @returns {string} SDP document terminated with CRLF.
 * @throws {SdpError} If required session fields are missing.
 *
 * @example
 *   const sdp = stringifySdp(parseSdp(offer.sdp));
 *
 * @section Signaling
 */
function stringifySdp(session)
{
    if (!session || typeof session !== 'object')
        throw new SdpError('stringifySdp: session must be an object');
    if (typeof session.version !== 'number')
        throw new SdpError('stringifySdp: missing version');
    if (!session.origin)
        throw new SdpError('stringifySdp: missing origin');

    const out = [];
    out.push(`v=${session.version}`);
    out.push(`o=${_stringifyOrigin(session.origin)}`);
    out.push(`s=${session.sessionName || '-'}`);
    if (session.connection)
        out.push(`c=${_stringifyConnection(session.connection)}`);
    for (const t of session.timing || [])
        out.push(`t=${t.start} ${t.stop}`);
    for (const a of session.attributes || [])
        out.push(a.value === '' ? `a=${a.key}` : `a=${a.key}:${a.value}`);

    for (const m of session.media || [])
    {
        const portSpec = m.numPorts ? `${m.port}/${m.numPorts}` : String(m.port);
        out.push(`m=${m.kind} ${portSpec} ${m.proto} ${(m.fmts || []).join(' ')}`.trim());
        if (m.connection)
            out.push(`c=${_stringifyConnection(m.connection)}`);
        for (const a of m.attributes || [])
            out.push(a.value === '' ? `a=${a.key}` : `a=${a.key}:${a.value}`);
    }

    return out.join(CRLF) + CRLF;
}

/** @private */
function _stringifyOrigin(o)
{
    return `${o.username} ${o.sessionId} ${o.sessionVersion} ${o.netType} ${o.addrType} ${o.address}`;
}

/** @private */
function _stringifyConnection(c)
{
    return `${c.netType} ${c.addrType} ${c.address}`;
}

module.exports = {
    parseSdp,
    stringifySdp,
    SdpError,
    DIRECTIONS,
};
