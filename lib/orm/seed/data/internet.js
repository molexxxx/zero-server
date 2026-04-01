'use strict';

/**
 * @module seed/data/internet
 * @description Data pools for internet-related fake data generation.
 */

/** Public email providers (for Fake.email when provider is not specified). */
const EMAIL_PROVIDERS = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
    'protonmail.com', 'aol.com', 'live.com', 'msn.com', 'ymail.com',
    'mail.com', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com',
];

/** Safe example domains that cannot belong to real people (RFC 2606). */
const SAFE_DOMAINS = [
    'example.com', 'example.org', 'example.net', 'test.com', 'test.org',
    'demo.com', 'demo.org', 'sample.com', 'fake.io', 'acme.example',
    'placeholder.dev', 'noreply.example', 'sandbox.example',
];

/** Common TLDs used for domain generation. */
const TLDS = [
    'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'info', 'biz', 'us',
    'uk', 'ca', 'au', 'de', 'fr', 'jp', 'in', 'br', 'mx', 'tech',
    'site', 'online', 'store', 'shop', 'cloud', 'ai', 'xyz', 'me',
];

/** Adjectives for generated domain names. */
const DOMAIN_ADJECTIVES = [
    'quick', 'bright', 'dark', 'silent', 'loud', 'smart', 'wild', 'swift',
    'bold', 'calm', 'crisp', 'deep', 'fast', 'fresh', 'grand', 'happy',
    'keen', 'light', 'mighty', 'neat', 'open', 'proud', 'rapid', 'sharp',
    'steady', 'strong', 'thin', 'tough', 'warm', 'wise', 'young', 'agile',
    'blue', 'clever', 'cool', 'epic', 'free', 'great', 'huge', 'ideal',
];

/** Nouns for generated domain names. */
const DOMAIN_NOUNS = [
    'apple', 'arrow', 'atlas', 'base', 'beam', 'blade', 'bridge', 'byte',
    'cache', 'chain', 'cloud', 'code', 'core', 'crest', 'cube', 'data',
    'deck', 'edge', 'field', 'flame', 'fleet', 'flow', 'forge', 'frame',
    'gate', 'grid', 'grove', 'harbor', 'heap', 'hub', 'index', 'kit',
    'lab', 'leaf', 'link', 'loop', 'map', 'matrix', 'mesh', 'mint',
    'node', 'orbit', 'path', 'peak', 'pixel', 'plugin', 'pod', 'port',
    'prism', 'pulse', 'realm', 'ridge', 'root', 'route', 'scope', 'seed',
    'shift', 'signal', 'site', 'snap', 'socket', 'source', 'spike', 'stack',
    'storm', 'stream', 'summit', 'sync', 'thread', 'tide', 'token', 'tower',
    'trace', 'vault', 'vector', 'vibe', 'vista', 'wave', 'wire', 'zone',
];

/**
 * Username separator styles.
 *   dot       → john.doe99
 *   underscore → john_doe99
 *   none      → johndoe99
 */
const USERNAME_SEPARATORS   = ['.', '_', ''];
const USERNAME_STYLES       = ['dot', 'underscore', 'none', 'random'];

/** Realistic browser user-agent strings for 5 major browsers. */
const USER_AGENTS = [
    // Chrome
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    // Safari
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    // Edge
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    // Android Chrome
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36',
    // curl / bot style
    'curl/7.88.1',
    'python-requests/2.31.0',
];

/** MAC address segment values (OUIs from well-known vendors for realism). */
const MAC_OUIS = [
    '00:1A:2B', '00:50:56', '08:00:27', 'AC:BC:32', 'B8:27:EB',
    'DC:A6:32', 'E4:5F:01', '3C:22:FB', '70:B3:D5', 'F4:5C:89',
];

/** Password character pool constants. */
const CHARSET_LOWERCASE  = 'abcdefghijklmnopqrstuvwxyz';
const CHARSET_UPPERCASE  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CHARSET_DIGITS     = '0123456789';
const CHARSET_SPECIAL    = '!@#$%^&*()-_=+[]{}|;:,.<>?';
const CHARSET_AMBIGUOUS  = 'lI1O0';   // chars to optionally exclude

module.exports = {
    EMAIL_PROVIDERS,
    SAFE_DOMAINS,
    TLDS,
    DOMAIN_ADJECTIVES,
    DOMAIN_NOUNS,
    USERNAME_SEPARATORS,
    USERNAME_STYLES,
    USER_AGENTS,
    MAC_OUIS,
    CHARSET_LOWERCASE,
    CHARSET_UPPERCASE,
    CHARSET_DIGITS,
    CHARSET_SPECIAL,
    CHARSET_AMBIGUOUS,
};
