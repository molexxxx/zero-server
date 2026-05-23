/**
 * Tests for lib/webrtc/ice.js - ICE candidate parser + serializer + filters.
 */

const {
    parseCandidate, stringifyCandidate,
    isPrivateIp, isMdnsHostname, isLoopbackIp, isLinkLocalIp,
    filterCandidates,
    IceError,
} = require('../../lib/webrtc/ice');

// ========================================================================
// parseCandidate
// ========================================================================

describe('parseCandidate', () =>
{
    it('parses a host UDP candidate', () =>
    {
        const c = parseCandidate('candidate:842163049 1 udp 1677729535 192.168.1.5 50000 typ host generation 0');
        expect(c).toMatchObject({
            foundation: '842163049',
            component:  1,
            transport:  'udp',
            priority:   1677729535,
            address:    '192.168.1.5',
            port:       50000,
            type:       'host',
        });
        expect(c.extensions.generation).toBe('0');
    });

    it('parses a server-reflexive candidate with raddr/rport', () =>
    {
        const c = parseCandidate('candidate:1 1 udp 2122194687 1.2.3.4 50001 typ srflx raddr 192.168.1.5 rport 50000');
        expect(c.type).toBe('srflx');
        expect(c.relatedAddress).toBe('192.168.1.5');
        expect(c.relatedPort).toBe(50000);
    });

    it('parses a TCP candidate with tcptype', () =>
    {
        const c = parseCandidate('candidate:1 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active');
        expect(c.transport).toBe('tcp');
        expect(c.tcpType).toBe('active');
        expect(c.port).toBe(9);
    });

    it('parses a relay candidate', () =>
    {
        const c = parseCandidate('candidate:4 1 udp 16777215 5.6.7.8 60000 typ relay raddr 0.0.0.0 rport 0');
        expect(c.type).toBe('relay');
    });

    it('parses an IPv6 host candidate', () =>
    {
        const c = parseCandidate('candidate:1 1 udp 2122252543 fe80::1 50000 typ host');
        expect(c.address).toBe('fe80::1');
    });

    it('parses an mDNS .local candidate', () =>
    {
        const c = parseCandidate('candidate:1 1 udp 2122252543 abc-123.local 50000 typ host');
        expect(c.address).toBe('abc-123.local');
    });

    it('accepts an "a=candidate:..." prefix', () =>
    {
        const c = parseCandidate('a=candidate:1 1 udp 2122252543 192.168.1.5 50000 typ host');
        expect(c.address).toBe('192.168.1.5');
    });

    it('collects unknown extensions as string key/value pairs', () =>
    {
        const c = parseCandidate('candidate:1 1 udp 100 1.2.3.4 50000 typ host network-id 1 network-cost 50');
        expect(c.extensions['network-id']).toBe('1');
        expect(c.extensions['network-cost']).toBe('50');
    });

    it('throws IceError on non-string input', () =>
    {
        expect(() => parseCandidate(null)).toThrow(IceError);
    });

    it('throws IceError on missing "candidate:" prefix', () =>
    {
        expect(() => parseCandidate('1 1 udp 100 1.2.3.4 50000 typ host')).toThrow(IceError);
    });

    it('throws IceError when fewer than 8 base tokens', () =>
    {
        expect(() => parseCandidate('candidate:1 1 udp 100 1.2.3.4 50000')).toThrow(IceError);
    });

    it('throws IceError when "typ" keyword missing', () =>
    {
        expect(() => parseCandidate('candidate:1 1 udp 100 1.2.3.4 50000 X host')).toThrow(IceError);
    });

    it('throws IceError on invalid candidate type', () =>
    {
        expect(() => parseCandidate('candidate:1 1 udp 100 1.2.3.4 50000 typ bogus')).toThrow(IceError);
    });

    it('throws IceError on out-of-range port', () =>
    {
        expect(() => parseCandidate('candidate:1 1 udp 100 1.2.3.4 99999 typ host')).toThrow(IceError);
    });

    it('throws IceError on non-numeric priority', () =>
    {
        expect(() => parseCandidate('candidate:1 1 udp NaN 1.2.3.4 50000 typ host')).toThrow(IceError);
    });
});

// ========================================================================
// stringifyCandidate
// ========================================================================

describe('stringifyCandidate', () =>
{
    it('round-trips a host candidate', () =>
    {
        const line = 'candidate:842163049 1 udp 1677729535 192.168.1.5 50000 typ host';
        const c = parseCandidate(line);
        expect(stringifyCandidate(c)).toBe(line);
    });

    it('round-trips an srflx candidate with raddr/rport', () =>
    {
        const line = 'candidate:1 1 udp 2122194687 1.2.3.4 50001 typ srflx raddr 192.168.1.5 rport 50000';
        const c = parseCandidate(line);
        expect(stringifyCandidate(c)).toBe(line);
    });

    it('round-trips a tcp candidate with tcptype', () =>
    {
        const line = 'candidate:1 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active';
        const c = parseCandidate(line);
        expect(stringifyCandidate(c)).toBe(line);
    });

    it('preserves extensions in input order', () =>
    {
        const c = parseCandidate('candidate:1 1 udp 100 1.2.3.4 50000 typ host generation 0 network-id 2');
        const out = stringifyCandidate(c);
        expect(out).toBe('candidate:1 1 udp 100 1.2.3.4 50000 typ host generation 0 network-id 2');
    });

    it('throws IceError when required fields missing', () =>
    {
        expect(() => stringifyCandidate({})).toThrow(IceError);
    });
});

// ========================================================================
// Address classifiers
// ========================================================================

describe('isPrivateIp', () =>
{
    it.each([
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '192.168.255.255',
        '100.64.0.1',          // CGNAT
    ])('returns true for private %s', (ip) => expect(isPrivateIp(ip)).toBe(true));

    it.each([
        '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1',
    ])('returns false for public %s', (ip) => expect(isPrivateIp(ip)).toBe(false));

    it('returns true for IPv6 ULA (fc00::/7)', () =>
    {
        expect(isPrivateIp('fc00::1')).toBe(true);
        expect(isPrivateIp('fd12:3456::1')).toBe(true);
    });

    it('returns false for IPv6 global', () =>
    {
        expect(isPrivateIp('2001:db8::1')).toBe(false);
    });

    it('returns false for non-IP input', () =>
    {
        expect(isPrivateIp('abc.local')).toBe(false);
        expect(isPrivateIp(null)).toBe(false);
    });
});

describe('isLoopbackIp', () =>
{
    it('matches IPv4 loopback', () =>
    {
        expect(isLoopbackIp('127.0.0.1')).toBe(true);
        expect(isLoopbackIp('127.255.255.255')).toBe(true);
    });
    it('matches IPv6 loopback', () =>
    {
        expect(isLoopbackIp('::1')).toBe(true);
    });
    it('rejects non-loopback', () =>
    {
        expect(isLoopbackIp('10.0.0.1')).toBe(false);
        expect(isLoopbackIp(null)).toBe(false);
    });
});

describe('isLinkLocalIp', () =>
{
    it('matches IPv4 169.254/16', () =>
    {
        expect(isLinkLocalIp('169.254.1.1')).toBe(true);
    });
    it('matches IPv6 fe80::/10', () =>
    {
        expect(isLinkLocalIp('fe80::1')).toBe(true);
    });
    it('rejects non-link-local', () =>
    {
        expect(isLinkLocalIp('8.8.8.8')).toBe(false);
    });
});

describe('isMdnsHostname', () =>
{
    it('matches .local hostnames', () =>
    {
        expect(isMdnsHostname('abc-123.local')).toBe(true);
        expect(isMdnsHostname('foo.LOCAL')).toBe(true);
    });
    it('rejects IPs', () =>
    {
        expect(isMdnsHostname('192.168.1.1')).toBe(false);
        expect(isMdnsHostname('::1')).toBe(false);
    });
    it('rejects null/non-string', () =>
    {
        expect(isMdnsHostname(null)).toBe(false);
        expect(isMdnsHostname(123)).toBe(false);
    });
});

// ========================================================================
// filterCandidates
// ========================================================================

describe('filterCandidates', () =>
{
    const host    = 'candidate:1 1 udp 100 192.168.1.5 50000 typ host';
    const srflx   = 'candidate:2 1 udp 100 1.2.3.4 50001 typ srflx raddr 192.168.1.5 rport 50000';
    const relay   = 'candidate:3 1 udp 100 5.6.7.8 60000 typ relay raddr 0.0.0.0 rport 0';
    const mdns    = 'candidate:4 1 udp 100 abc-123.local 50000 typ host';
    const linkLoc = 'candidate:5 1 udp 100 169.254.1.1 50000 typ host';
    const loop    = 'candidate:6 1 udp 100 127.0.0.1 50000 typ host';
    const tcp     = 'candidate:7 1 tcp 100 1.2.3.4 9 typ host tcptype active';
    const all     = [host, srflx, relay, mdns, linkLoc, loop, tcp];

    it('returns all by default', () =>
    {
        expect(filterCandidates(all)).toHaveLength(all.length);
    });

    it('accepts parsed-candidate inputs as well as strings', () =>
    {
        const parsed = all.map(parseCandidate);
        const out = filterCandidates(parsed);
        expect(out).toHaveLength(all.length);
        // Should return same shape it was given - parsed in, parsed out
        expect(out[0]).toHaveProperty('foundation');
    });

    it('blockPrivate strips private + loopback + link-local', () =>
    {
        const out = filterCandidates(all, { blockPrivate: true });
        expect(out.find(c => c.includes('192.168.1.5'))).toBeUndefined();
        expect(out.find(c => c.includes('169.254.1.1'))).toBeUndefined();
        expect(out.find(c => c.includes('127.0.0.1'))).toBeUndefined();
        // public + mdns survive
        expect(out.find(c => c.includes('1.2.3.4'))).toBeDefined();
        expect(out.find(c => c.includes('abc-123.local'))).toBeDefined();
    });

    it('blockMdns strips .local candidates', () =>
    {
        const out = filterCandidates(all, { blockMdns: true });
        expect(out.find(c => c.includes('.local'))).toBeUndefined();
    });

    it('blockTcp strips TCP candidates', () =>
    {
        const out = filterCandidates(all, { blockTcp: true });
        expect(out.find(c => / tcp /.test(c))).toBeUndefined();
    });

    it('allowedTypes restricts to the given candidate types', () =>
    {
        const out = filterCandidates(all, { allowedTypes: ['relay', 'srflx'] });
        expect(out).toEqual(expect.arrayContaining([expect.stringContaining('typ relay')]));
        expect(out.find(c => c.includes('typ host'))).toBeUndefined();
    });

    it('maxCandidates caps the result count', () =>
    {
        const out = filterCandidates(all, { maxCandidates: 3 });
        expect(out).toHaveLength(3);
    });

    it('custom predicate drops candidates returning false', () =>
    {
        const out = filterCandidates(all, { predicate: (c) => c.type !== 'relay' });
        expect(out.find(c => c.includes('typ relay'))).toBeUndefined();
    });

    it('silently skips unparseable lines', () =>
    {
        const out = filterCandidates(['garbage', host], { blockPrivate: false });
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('192.168.1.5');
    });
});
