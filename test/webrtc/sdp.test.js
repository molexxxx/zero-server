/**
 * Tests for lib/webrtc/sdp.js - RFC 8866 SDP parser + serializer.
 */

const { parseSdp, stringifySdp, SdpError } = require('../../lib/webrtc/sdp');

const CRLF = '\r\n';

// A representative WebRTC offer, condensed but realistic.
const SAMPLE_OFFER = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=msid-semantic: WMS stream-id',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 103',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:F7gI',
    'a=ice-pwd:x9cml/YzichV2+XlhiMu8g',
    'a=fingerprint:sha-256 49:66:12:17:0D:1C:91:AE:57:4C:C6:36:DD:D5:97:D2:7D:62:C9:9A:7F:B9:A3:F4:70:03:E7:43:91:73:23:5E',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:103 ISAC/16000',
    'a=ssrc:1001 cname:abc',
    'a=ssrc:1001 msid:stream-id track-id',
    'a=candidate:842163049 1 udp 1677729535 192.168.1.5 50000 typ host generation 0',
    'a=candidate:1 1 udp 2122194687 1.2.3.4 50001 typ srflx raddr 192.168.1.5 rport 50000',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtpmap:96 VP8/90000',
    'a=rid:hi send',
    'a=rid:lo send',
    'a=simulcast:send hi;lo',
    '',
].join(CRLF);

// ========================================================================
// parseSdp
// ========================================================================

describe('parseSdp', () =>
{
    // --- Session-level fields ---

    it('parses version, origin, session name', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.version).toBe(0);
        expect(s.origin).toEqual({
            username:       '-',
            sessionId:      '4611731400430051336',
            sessionVersion: 2,
            netType:        'IN',
            addrType:       'IP4',
            address:        '127.0.0.1',
        });
        expect(s.sessionName).toBe('-');
    });

    it('parses session-level timing', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.timing).toEqual([{ start: 0, stop: 0 }]);
    });

    it('parses session-level attributes', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        const group = s.attributes.find(a => a.key === 'group');
        expect(group).toBeDefined();
        expect(group.value).toBe('BUNDLE 0 1');
    });

    // --- Media sections ---

    it('parses two m= sections with correct kinds and codecs', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media).toHaveLength(2);
        expect(s.media[0].kind).toBe('audio');
        expect(s.media[0].proto).toBe('UDP/TLS/RTP/SAVPF');
        expect(s.media[0].fmts).toEqual(['111', '103']);
        expect(s.media[1].kind).toBe('video');
        expect(s.media[1].fmts).toEqual(['96']);
    });

    it('extracts ICE credentials, fingerprint, setup, mid per m-section', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        const a = s.media[0];
        expect(a.iceUfrag).toBe('F7gI');
        expect(a.icePwd).toBe('x9cml/YzichV2+XlhiMu8g');
        expect(a.setup).toBe('actpass');
        expect(a.mid).toBe('0');
        expect(a.fingerprint.algorithm).toBe('sha-256');
        expect(a.fingerprint.value).toMatch(/^[0-9A-F:]+$/);
    });

    it('extracts direction (sendrecv/sendonly/recvonly/inactive)', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].direction).toBe('sendrecv');
        expect(s.media[1].direction).toBe('sendonly');
    });

    it('detects rtcp-mux flag', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].rtcpMux).toBe(true);
        expect(s.media[1].rtcpMux).toBe(true);
    });

    it('parses rtpmap entries', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].rtpmaps).toEqual([
            { payload: 111, codec: 'opus', clockRate: 48000, channels: 2 },
            { payload: 103, codec: 'ISAC', clockRate: 16000, channels: undefined },
        ]);
        expect(s.media[1].rtpmaps).toEqual([
            { payload: 96, codec: 'VP8', clockRate: 90000, channels: undefined },
        ]);
    });

    it('parses fmtp entries', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].fmtps).toEqual([
            { payload: 111, config: 'minptime=10;useinbandfec=1' },
        ]);
    });

    it('parses rid and simulcast directives', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[1].rids).toEqual([
            { id: 'hi', direction: 'send', params: '' },
            { id: 'lo', direction: 'send', params: '' },
        ]);
        expect(s.media[1].simulcast).toEqual({ send: 'hi;lo' });
    });

    it('parses ssrc attributes grouped by ssrc id', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].ssrcs).toEqual([
            { id: 1001, attribute: 'cname', value: 'abc' },
            { id: 1001, attribute: 'msid',  value: 'stream-id track-id' },
        ]);
    });

    it('parses candidate attributes into the candidates array', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].candidates).toHaveLength(2);
        expect(s.media[0].candidates[0]).toMatch(/^candidate:/);
    });

    it('records m-section connection lines', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        expect(s.media[0].connection).toEqual({ netType: 'IN', addrType: 'IP4', address: '0.0.0.0' });
    });

    // --- Edge cases / robustness ---

    it('accepts LF-only line endings', () =>
    {
        const lf = SAMPLE_OFFER.replace(/\r\n/g, '\n');
        const s = parseSdp(lf);
        expect(s.media).toHaveLength(2);
    });

    it('ignores blank trailing lines', () =>
    {
        const s = parseSdp(SAMPLE_OFFER + '\r\n\r\n');
        expect(s.version).toBe(0);
    });

    it('throws SdpError for empty input', () =>
    {
        expect(() => parseSdp('')).toThrow(SdpError);
    });

    it('throws SdpError when first line is not v=', () =>
    {
        expect(() => parseSdp('s=-\r\n')).toThrow(SdpError);
    });

    it('throws SdpError on malformed line (no = sign)', () =>
    {
        expect(() => parseSdp('v=0\r\nbroken\r\n')).toThrow(SdpError);
    });

    it('throws SdpError on non-string input', () =>
    {
        expect(() => parseSdp(null)).toThrow(SdpError);
        expect(() => parseSdp(42)).toThrow(SdpError);
    });

    it('rejects payload exceeding maxBytes', () =>
    {
        const big = 'v=0\r\n' + 'a=x:' + 'A'.repeat(1024) + '\r\n';
        expect(() => parseSdp(big, { maxBytes: 64 })).toThrow(SdpError);
    });

    it('preserves unknown attributes in the raw list', () =>
    {
        const s = parseSdp('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=custom:hello\r\n');
        expect(s.attributes.find(a => a.key === 'custom').value).toBe('hello');
    });

    it('handles flag-only attributes (no value)', () =>
    {
        const s = parseSdp('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\na=recvonly\r\n');
        expect(s.media[0].direction).toBe('recvonly');
        const flag = s.media[0].attributes.find(a => a.key === 'recvonly');
        expect(flag.value).toBe('');
    });

    it('parses extmap attributes', () =>
    {
        const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n'
            + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
            + 'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n';
        const s = parseSdp(sdp);
        expect(s.media[0].extmaps).toEqual([
            { id: 1, direction: undefined, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', config: undefined },
        ]);
    });
});

// ========================================================================
// stringifySdp
// ========================================================================

describe('stringifySdp', () =>
{
    it('round-trips the sample offer (parsed → stringified → parsed)', () =>
    {
        const s1 = parseSdp(SAMPLE_OFFER);
        const text = stringifySdp(s1);
        const s2 = parseSdp(text);
        expect(s2.media).toHaveLength(2);
        expect(s2.media[0].iceUfrag).toBe('F7gI');
        expect(s2.media[1].direction).toBe('sendonly');
        expect(s2.media[1].simulcast).toEqual({ send: 'hi;lo' });
    });

    it('emits CRLF line endings', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        const out = stringifySdp(s);
        expect(out.endsWith('\r\n')).toBe(true);
        expect(out.includes('\n') && !out.includes('\r\n\r')).toBe(true);
    });

    it('preserves the m-line order and v/o/s/t header order', () =>
    {
        const s = parseSdp(SAMPLE_OFFER);
        const out = stringifySdp(s);
        const lines = out.split('\r\n');
        expect(lines[0]).toBe('v=0');
        expect(lines[1]).toMatch(/^o=/);
        expect(lines[2]).toBe('s=-');
        const audioIdx = lines.findIndex(l => l.startsWith('m=audio'));
        const videoIdx = lines.findIndex(l => l.startsWith('m=video'));
        expect(audioIdx).toBeGreaterThan(0);
        expect(videoIdx).toBeGreaterThan(audioIdx);
    });

    it('throws SdpError when version missing', () =>
    {
        expect(() => stringifySdp({})).toThrow(SdpError);
    });
});
