'use strict';

/**
 * @module seed/fake
 * @description Extensible fake data generator.
 *
 *  Key capabilities:
 *    • Seeded / reproducible output  — Fake.seed(42)
 *    • Guaranteed-unique values      — Fake.unique(() => Fake.email())
 *    • Multi-locale names            — Fake.firstName({ locale: 'ja', sex: 'female' })
 *    • Rich phone formats            — Fake.phone({ countryCode: 'DE', format: 'international' })
 *    • Configurable emails           — Fake.email({ provider: 'company.io' })
 *    • Flexible usernames            — Fake.username({ style: 'underscore' })
 *    • Fixed-length numeric strings  — Fake.numericString(8)
 *    • Person: job titles, bio, zodiac, gender, prefix/suffix
 *    • Location: city, country, state, address, lat/lng, timezone
 *    • Commerce: product, company, category, price, industry
 *    • Internet: password, mac, port, userAgent, domain, ipv6, slug
 *    • All original generators retained (100 % backward-compatible)
 */

const crypto = require('crypto');
const { rand, seed: _seedFn, getSeed } = require('./rng');
const { UniqueTracker }  = require('./unique');

// -- Data modules ------------------------------------------------
const { NAMES, LOCALES }                            = require('./data/names');
const { PHONE_BY_COUNTRY, COUNTRY_CODES }           = require('./data/phone');
const {
    EMAIL_PROVIDERS, SAFE_DOMAINS, TLDS,
    DOMAIN_ADJECTIVES, DOMAIN_NOUNS,
    USERNAME_SEPARATORS, USER_AGENTS, MAC_OUIS,
    CHARSET_LOWERCASE, CHARSET_UPPERCASE, CHARSET_DIGITS, CHARSET_SPECIAL,
}                                                   = require('./data/internet');
const {
    LOREM_WORDS, HACKER_ADJECTIVES, HACKER_NOUNS, HACKER_VERBS,
    ADJECTIVES, NOUNS,
}                                                   = require('./data/words');
const {
    NAME_PREFIXES, NAME_SUFFIXES,
    JOB_DESCRIPTORS, JOB_AREAS, JOB_TYPES, JOB_TITLES,
    ZODIAC_SIGNS, GENDERS, BIO_ADJECTIVES, BIO_NOUNS, BIO_PHRASES,
    BLOOD_TYPES,
}                                                   = require('./data/person');
const {
    CITIES, COUNTRIES, US_STATES,
    STREET_TYPES, STREET_NAMES, ZIP_PATTERNS, TIMEZONES,
}                                                   = require('./data/locations');
const {
    PRODUCT_ADJECTIVES, PRODUCT_MATERIALS, PRODUCT_NOUNS,
    CATEGORIES, DEPARTMENTS,
    COMPANY_ADJECTIVES, COMPANY_NOUNS, COMPANY_SUFFIXES, INDUSTRIES,
    CATCH_PHRASE_ADJECTIVES, CATCH_PHRASE_NOUNS,
}                                                   = require('./data/commerce');

// ================================================================
//  Internal helpers
// ================================================================

/** Pick a random element from an array using the active RNG. */
function _pick(arr) {
    return arr[Math.floor(rand() * arr.length)];
}

/** Pick n unique-indexed elements from an array (no repeats). */
function _pickMany(arr, n) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, arr.length));
}

/** Random integer in [min, max] inclusive. */
function _int(min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
}

/**
 * Expand a phone / zip template string.
 *   #  → digit 0–9   N → digit 1–9   A → uppercase letter
 */
function _expandTemplate(template) {
    return template.replace(/[#NA]/g, c => {
        if (c === '#') return _int(0, 9);
        if (c === 'N') return _int(1, 9);
        return String.fromCharCode(_int(65, 90)); // c === 'A'
    });
}

/** Resolve name pool for a locale, falling back to 'en'. */
function _namePool(locale) {
    return NAMES[locale] || NAMES.en;
}

/** Derive sex ('male'|'female') from options or random. */
function _resolveSex(options = {}) {
    const { sex } = options;
    if (sex === 'male' || sex === 'female') return sex;
    return rand() > 0.5 ? 'male' : 'female';
}

/** UUID v4 fallback for environments without crypto.randomUUID. */
function _uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// ================================================================
//  Fake class
// ================================================================

/**
 * Static fake data generator with seeded RNG, locale support, and
 * built-in uniqueness guarantees.
 *
 * All methods are **100 % backward compatible** with the original Fake class.
 *
 * @example
 *   // Reproducible output
 *   Fake.seed(42);
 *   Fake.firstName();   // always the same value
 *
 *   // Guaranteed unique emails
 *   const emails = Array.from({ length: 200 }, () =>
 *       Fake.unique(() => Fake.email())
 *   );
 *
 *   // Locale-specific names
 *   Fake.firstName({ locale: 'ja', sex: 'female' });  // e.g. 'Hina'
 */
class Fake
{
    // -- Seeding & Uniqueness ------------------------------------------------

    /**
     * Set a deterministic seed so all subsequent calls produce the same output.
     * Pass `null` or `undefined` to reset to Math.random.
     *
     * @param {number|string|null} [value]
     * @returns {number|null} The resolved numeric seed.
     *
     * @example
     *   Fake.seed(42);
     *   Fake.firstName(); // reproducible
     *   Fake.seed(null);  // back to random
     */
    static seed(value) { return _seedFn(value); }

    /** @returns {number|null} Active seed, or null if using Math.random. */
    static getSeed() { return getSeed(); }

    /**
     * Generate a guaranteed-unique value within a namespace.
     *
     * @param {() => any} fn - Generator function.
     * @param {object}  [options]
     * @param {string}  [options.key]          - Namespace key (defaults to function name).
     * @param {number}  [options.maxAttempts]  - Retry limit (default 1000).
     * @returns {any}
     *
     * @example
     *   const email = Fake.unique(() => Fake.email(), { key: 'email' });
     */
    static unique(fn, options = {}) {
        const key = options.key || fn.name || 'default';
        return Fake._tracker.generate(key, fn, options.maxAttempts);
    }

    /**
     * Reset unique-value tracking.
     * @param {string} [key] - Clear only this namespace, or all if omitted.
     */
    static resetUnique(key) { Fake._tracker.reset(key); }

    /**
     * How many unique values have been generated for a namespace.
     * @param {string} key
     * @returns {number}
     */
    static uniqueCount(key) { return Fake._tracker.seen(key); }

    // -- Names --------------------------------------------------------------

    /**
     * Random first name.
     *
     * @param {object}  [options]
     * @param {'male'|'female'} [options.sex]     - Constrain to a sex.
     * @param {string}  [options.locale='en']     - Locale code (en, es, fr, de, …).
     * @param {boolean} [options.unique=false]    - Guarantee uniqueness per locale+sex.
     * @returns {string}
     */
    static firstName(options = {}) {
        const locale  = options.locale || 'en';
        const sex     = _resolveSex(options);
        const pool    = _namePool(locale);
        const fn      = () => _pick(pool[sex]);
        if (options.unique) {
            return Fake.unique(fn, { key: `firstName_${locale}_${sex}` });
        }
        return fn();
    }

    /**
     * Random last name.
     *
     * @param {object}  [options]
     * @param {string}  [options.locale='en']
     * @param {boolean} [options.unique=false]
     * @returns {string}
     */
    static lastName(options = {}) {
        const locale = options.locale || 'en';
        const pool   = _namePool(locale);
        const fn     = () => _pick(pool.last);
        if (options.unique) return Fake.unique(fn, { key: `lastName_${locale}` });
        return fn();
    }

    /**
     * Random middle name (falls back to first-name pool if locale lacks one).
     *
     * @param {object}  [options]
     * @param {'male'|'female'} [options.sex]
     * @param {string}  [options.locale='en']
     * @returns {string}
     */
    static middleName(options = {}) {
        // Reuse first-name pool since most locales share it
        return Fake.firstName({ sex: options.sex, locale: options.locale });
    }

    /**
     * Random full name.
     *
     * @param {object}  [options]
     * @param {'male'|'female'} [options.sex]
     * @param {string}  [options.locale='en']
     * @param {boolean} [options.prefix=false]   - Include name prefix (Mr., Dr., …).
     * @param {boolean} [options.middle=false]   - Include a middle name.
     * @param {boolean} [options.suffix=false]   - Include credential suffix (PhD, Jr., …).
     * @param {string}  [options.firstName]      - Override the first name.
     * @param {string}  [options.lastName]       - Override the last name.
     * @param {boolean} [options.unique=false]   - Guarantee uniqueness per locale.
     * @returns {string}
     */
    static fullName(options = {}) {
        const locale = options.locale || 'en';
        const sex    = _resolveSex(options);

        const fn = () => {
            const parts = [];
            if (options.prefix)    parts.push(Fake.namePrefix({ sex }));
            parts.push(options.firstName || Fake.firstName({ sex, locale }));
            if (options.middle)    parts.push(Fake.middleName({ sex, locale }));
            parts.push(options.lastName || Fake.lastName({ locale }));
            if (options.suffix)    parts.push(Fake.nameSuffix());
            return parts.join(' ');
        };

        if (options.unique) return Fake.unique(fn, { key: `fullName_${locale}` });
        return fn();
    }

    /**
     * Name prefix (Mr., Ms., Dr., Prof., …).
     *
     * @param {object}  [options]
     * @param {'male'|'female'|'neutral'} [options.sex]
     * @returns {string}
     */
    static namePrefix(options = {}) {
        const sex = options.sex === 'male'    ? 'male'
                  : options.sex === 'female'  ? 'female'
                  : options.sex === 'neutral' ? 'neutral'
                  : rand() > 0.5              ? 'male'
                  : 'female';
        return _pick(NAME_PREFIXES[sex]);
    }

    /** Random name suffix (Jr., Sr., PhD, MD, …). */
    static nameSuffix() { return _pick(NAME_SUFFIXES); }

    /** All supported locale codes. */
    static locales() { return LOCALES.slice(); }

    // -- Phone Numbers ------------------------------------------------------

    /**
     * Random phone number.
     *
     * @param {object}  [options]
     * @param {string}  [options.countryCode]                 - ISO 3166-1 alpha-2 (e.g. 'US', 'DE').
     *                                                           Defaults to a random country.
     * @param {'human'|'national'|'international'} [options.format='human']
     * @param {boolean} [options.unique=false]
     * @returns {string}
     *
     * @example
     *   Fake.phone();                             // '(555) 123-4567'
     *   Fake.phone({ countryCode: 'DE' });        // '0174 #######'
     *   Fake.phone({ format: 'international' });  // '+1 555 123 4567'
     */
    static phone(options = {}) {
        const code    = (options.countryCode || 'US').toUpperCase();
        const country = PHONE_BY_COUNTRY[code] || PHONE_BY_COUNTRY['US'];
        // Default to 'national' so bare Fake.phone() produces the classic
        // (###) ###-#### format and remains backward compatible.
        const style   = options.format || 'national';
        const formats = country.formats[style] || country.formats.national;
        const fn      = () => _expandTemplate(_pick(formats));
        if (options.unique) return Fake.unique(fn, { key: `phone_${code}_${style}` });
        return fn();
    }

    /**
     * All supported phone country codes.
     * @returns {string[]}
     */
    static phoneCodes() { return COUNTRY_CODES.slice(); }

    // -- Email --------------------------------------------------------------

    /**
     * Random email address.
     *
     * @param {object}  [options]
     * @param {string}  [options.firstName]            - Override the local-part first name.
     * @param {string}  [options.lastName]             - Override the local-part last name.
     * @param {string}  [options.provider]             - Force a provider domain.
     * @param {boolean} [options.safe=false]           - Use only example./test. safe domains.
     * @param {string}  [options.locale='en']          - Locale for random name generation.
     * @param {boolean} [options.unique=false]
     * @returns {string}
     *
     * @example
     *   Fake.email();
     *   Fake.email({ provider: 'company.io', unique: true });
     *   Fake.email({ safe: true }); // only example.com/test.com domains
     */
    static email(options = {}) {
        const locale = options.locale || 'en';
        const fn = () => {
            const first   = (options.firstName  || Fake.firstName({ locale })).toLowerCase()
                               .replace(/[^a-z0-9]/g, '');
            const last    = (options.lastName   || Fake.lastName({ locale })).toLowerCase()
                               .replace(/[^a-z0-9]/g, '');
            const num     = _int(1, 999);
            const domain  = options.provider
                ? options.provider
                : options.safe
                    ? _pick(SAFE_DOMAINS)
                    : _pick(EMAIL_PROVIDERS);

            const patterns = [
                `${first}.${last}${num}@${domain}`,
                `${first}${last}@${domain}`,
                `${first}_${last}@${domain}`,
                `${first}${num}@${domain}`,
                `${first[0]}${last}@${domain}`,
            ];
            return _pick(patterns);
        };

        if (options.unique) return Fake.unique(fn, { key: `email_${options.provider || 'any'}` });
        return fn();
    }

    // -- Username -----------------------------------------------------------

    /**
     * Random username.
     *
     * @param {object}  [options]
     * @param {string}  [options.firstName]            - Override first name component.
     * @param {string}  [options.lastName]             - Override last name component.
     * @param {'dot'|'underscore'|'none'|'random'} [options.style='random']
     * @param {boolean} [options.numbers=true]         - Append a random number suffix.
     * @param {string}  [options.locale='en']
     * @param {boolean} [options.unique=false]
     * @returns {string}
     *
     * @example
     *   Fake.username();                              // 'alice_smith42'
     *   Fake.username({ style: 'dot' });              // 'john.doe91'
     *   Fake.username({ style: 'none', numbers: false }); // 'janedoe'
     */
    static username(options = {}) {
        const locale  = options.locale || 'en';
        const style   = options.style || 'random';
        const useNums = options.numbers !== false;

        const fn = () => {
            const first = (options.firstName || Fake.firstName({ locale })).toLowerCase()
                             .replace(/[^a-z0-9]/g, '');
            const last  = (options.lastName  || Fake.lastName({ locale })).toLowerCase()
                             .replace(/[^a-z0-9]/g, '');

            let sep;
            if (style === 'dot')        sep = '.';
            else if (style === 'underscore') sep = '_';
            else if (style === 'none')  sep = '';
            else sep = _pick(USERNAME_SEPARATORS);

            const base = `${first}${sep}${last}`;
            const num  = useNums ? _int(1, 9999) : '';
            return `${base}${num}`;
        };

        if (options.unique) return Fake.unique(fn, { key: `username_${style}` });
        return fn();
    }

    // -- Numbers ------------------------------------------------------------

    /**
     * Random integer in [min, max].
     *
     * @param {number|object} [min=0]   - Min bound, or options object.
     * @param {number}        [max=100]
     * @returns {number}
     */
    static integer(min = 0, max = 100) {
        if (typeof min === 'object' && min !== null) {
            const opts = min;
            return _int(opts.min ?? 0, opts.max ?? 100);
        }
        return _int(Math.floor(min), Math.floor(max));
    }

    /**
     * Random float in [min, max].
     *
     * @param {number|object} [min=0]
     * @param {number}        [max=100]
     * @param {number}        [decimals=2]
     * @returns {number}
     */
    static float(min = 0, max = 100, decimals = 2) {
        if (typeof min === 'object' && min !== null) {
            const opts = min;
            return Number((rand() * ((opts.max ?? 100) - (opts.min ?? 0)) + (opts.min ?? 0))
                .toFixed(opts.decimals ?? 2));
        }
        return Number((rand() * (max - min) + min).toFixed(decimals));
    }

    /**
     * Random numeric string with an exact number of digits.
     * Leading zeros are preserved (unlike integer()).
     *
     * @param {number}  [length=6]
     * @param {object}  [options]
     * @param {boolean} [options.leadingZeros=true] - Allow a leading zero.
     * @param {string}  [options.separator='']      - Insert separator every N digits.
     * @param {number}  [options.groupSize=3]        - Group size when using separator.
     * @returns {string}
     *
     * @example
     *   Fake.numericString(6);                              // '047283'
     *   Fake.numericString(16, { separator: '-', groupSize: 4 }); // '1234-5678-9012-3456'
     */
    static numericString(length = 6, options = {}) {
        const allowLeading = options.leadingZeros !== false;
        let str = '';
        for (let i = 0; i < length; i++) {
            const min = (!allowLeading && i === 0) ? 1 : 0;
            str += _int(min, 9);
        }
        if (options.separator) {
            const gs  = options.groupSize || 3;
            const re  = new RegExp(`(.{${gs}})(?=.)`, 'g');
            str = str.replace(re, `$1${options.separator}`);
        }
        return str;
    }

    /**
     * Random alphanumeric string of `length` characters.
     *
     * @param {number}  [length=10]
     * @param {object}  [options]
     * @param {boolean} [options.uppercase=false]
     * @param {boolean} [options.letters=true]
     * @param {boolean} [options.digits=true]
     * @returns {string}
     */
    static alphanumeric(length = 10, options = {}) {
        let pool = '';
        if (options.letters !== false) {
            pool += options.uppercase ? CHARSET_UPPERCASE : CHARSET_LOWERCASE;
        }
        if (options.digits !== false) pool += CHARSET_DIGITS;
        if (!pool) pool = CHARSET_LOWERCASE + CHARSET_DIGITS;
        let str = '';
        for (let i = 0; i < length; i++) str += pool[Math.floor(rand() * pool.length)];
        return str;
    }

    /**
     * Random alpha-only string of `length` characters.
     *
     * @param {number}  [length=8]
     * @param {object}  [options]
     * @param {boolean} [options.uppercase=false] - Use uppercase letters.
     * @param {boolean} [options.mixed=false]     - Mix upper and lower.
     * @returns {string}
     */
    static alpha(length = 8, options = {}) {
        let pool;
        if (options.mixed)          pool = CHARSET_LOWERCASE + CHARSET_UPPERCASE;
        else if (options.uppercase) pool = CHARSET_UPPERCASE;
        else                        pool = CHARSET_LOWERCASE;
        let str = '';
        for (let i = 0; i < length; i++) str += pool[Math.floor(rand() * pool.length)];
        return str;
    }

    /** Random boolean. */
    static boolean() { return rand() > 0.5; }

    // -- Dates --------------------------------------------------------------

    /**
     * Random Date between start and end.
     *
     * @param {Date}   [start]
     * @param {Date}   [end]
     * @returns {Date}
     */
    static date(start = new Date(2020, 0, 1), end = new Date()) {
        const ms = start.getTime() + rand() * (end.getTime() - start.getTime());
        return new Date(ms);
    }

    /**
     * Random ISO date string.
     *
     * @param {Date} [start]
     * @param {Date} [end]
     * @returns {string}
     */
    static dateString(start, end) {
        return Fake.date(start, end).toISOString();
    }

    /**
     * Random date in the past.
     *
     * @param {object} [options]
     * @param {number} [options.years=1] - How many years back the window spans.
     * @returns {Date}
     */
    static datePast(options = {}) {
        const years = options.years || 1;
        const end   = new Date();
        const start = new Date(end);
        start.setFullYear(start.getFullYear() - years);
        return Fake.date(start, end);
    }

    /**
     * Random date in the future.
     *
     * @param {object} [options]
     * @param {number} [options.years=1]
     * @returns {Date}
     */
    static dateFuture(options = {}) {
        const years = options.years || 1;
        const start = new Date();
        const end   = new Date(start);
        end.setFullYear(end.getFullYear() + years);
        return Fake.date(start, end);
    }

    // -- Text ---------------------------------------------------------------

    /**
     * Random word from the lorem ipsum vocabulary.
     *
     * @param {object}  [options]
     * @param {'lorem'|'hacker'|'adjective'|'noun'} [options.type='lorem']
     * @returns {string}
     */
    static word(options = {}) {
        const type = options.type || 'lorem';
        if (type === 'hacker')    return _pick(HACKER_NOUNS);
        if (type === 'adjective') return _pick(ADJECTIVES);
        if (type === 'noun')      return _pick(NOUNS);
        return _pick(LOREM_WORDS);
    }

    /**
     * Array of n random words.
     *
     * @param {number} [n=3]
     * @returns {string[]}
     */
    static words(n = 3) {
        return Array.from({ length: n }, () => Fake.word());
    }

    /**
     * Random sentence of `wordCount` words.
     *
     * @param {number|object} [wordCount]
     * @returns {string}
     */
    static sentence(wordCount) {
        const count = wordCount || _int(5, 15);
        const words = Array.from({ length: count }, () => _pick(LOREM_WORDS));
        words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
        return words.join(' ') + '.';
    }

    /**
     * Random paragraph of `sentences` sentences.
     *
     * @param {number} [sentences=3]
     * @returns {string}
     */
    static paragraph(sentences = 3) {
        return Array.from({ length: sentences }, () => Fake.sentence()).join(' ');
    }

    /**
     * Hacker-speak phrase ("synthesize redundant protocols").
     *
     * @returns {string}
     */
    static hackerPhrase() {
        return `${_pick(HACKER_VERBS)} ${_pick(HACKER_ADJECTIVES)} ${_pick(HACKER_NOUNS)}`;
    }

    /**
     * URL-friendly slug from n random words.
     *
     * @param {number} [words=3]
     * @returns {string}  e.g. 'forward-online-portal'
     */
    static slug(words = 3) {
        return Array.from({ length: words }, () => _pick(ADJECTIVES.concat(NOUNS)))
            .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '-'))
            .join('-');
    }

    /**
     * Random hashtag (no spaces, prefixed with #).
     *
     * @returns {string}  e.g. '#resilientfuture'
     */
    static hashtag() {
        return '#' + _pick(ADJECTIVES) + _pick(NOUNS);
    }

    // -- Person -------------------------------------------------------------

    /**
     * Random job title.
     *
     * @param {object}  [options]
     * @param {boolean} [options.full=false]  - Use a pre-built full title instead of generated.
     * @returns {string}
     */
    static jobTitle(options = {}) {
        if (options.full) return _pick(JOB_TITLES);
        return `${_pick(JOB_DESCRIPTORS)} ${_pick(JOB_AREAS)} ${_pick(JOB_TYPES)}`;
    }

    /** Random job area / department string (e.g. 'Engineering'). */
    static jobArea()       { return _pick(JOB_AREAS); }

    /** Random job type noun (e.g. 'Manager'). */
    static jobType()       { return _pick(JOB_TYPES); }

    /** Random job level descriptor (e.g. 'Senior'). */
    static jobDescriptor() { return _pick(JOB_DESCRIPTORS); }

    /**
     * Random short biography string.
     *
     * @param {object}  [options]
     * @param {'phrase'|'full'} [options.style='phrase']
     * @returns {string}
     *
     * @example
     *   Fake.bio(); // 'avid maker | living one commit at a time'
     */
    static bio(options = {}) {
        if (options.style === 'full') {
            return `${_pick(BIO_ADJECTIVES)} ${_pick(BIO_NOUNS)} | ${_pick(BIO_PHRASES)}`;
        }
        return _pick(BIO_PHRASES);
    }

    /** Random zodiac sign. */
    static zodiacSign()  { return _pick(ZODIAC_SIGNS); }

    /**
     * Random gender label.
     *
     * @param {object}  [options]
     * @param {boolean} [options.binary=false] - Return only 'Male' or 'Female'.
     * @returns {string}
     */
    static gender(options = {}) {
        if (options.binary) return rand() > 0.5 ? 'Male' : 'Female';
        return _pick(GENDERS);
    }

    /** Random blood type (A+, B-, O+, AB+, …). */
    static bloodType() { return _pick(BLOOD_TYPES); }

    // -- Location ----------------------------------------------------------

    /**
     * Random city.
     *
     * @param {object}  [options]
     * @param {string}  [options.country]  - Filter by ISO 3166-1 alpha-2 country code.
     * @returns {string}
     */
    static city(options = {}) {
        const pool = options.country
            ? CITIES.filter(c => c.country === options.country.toUpperCase())
            : CITIES;
        return _pick(pool.length ? pool : CITIES).name;
    }

    /**
     * Random country.
     *
     * @param {object}  [options]
     * @param {boolean} [options.codeOnly=false]  - Return ISO code only.
     * @param {boolean} [options.full=false]      - Return { name, code } object.
     * @returns {string|{name:string,code:string}}
     */
    static country(options = {}) {
        const entry = _pick(COUNTRIES);
        if (options.codeOnly) return entry.code;
        if (options.full)     return { ...entry };
        return entry.name;
    }

    /**
     * Random US state.
     *
     * @param {object}  [options]
     * @param {boolean} [options.abbr=false]  - Return 2-letter abbreviation.
     * @param {boolean} [options.full=false]  - Return { name, abbr } object.
     * @returns {string|{name:string,abbr:string}}
     */
    static state(options = {}) {
        const entry = _pick(US_STATES);
        if (options.abbr) return entry.abbr;
        if (options.full) return { ...entry };
        return entry.name;
    }

    /**
     * Random postal / ZIP code.
     *
     * @param {object} [options]
     * @param {string} [options.countryCode='US']
     * @returns {string}
     */
    static zipCode(options = {}) {
        const code    = (options.countryCode || 'US').toUpperCase();
        const pattern = ZIP_PATTERNS[code] || ZIP_PATTERNS['US'];
        return _expandTemplate(pattern);
    }

    /**
     * Random latitude as a float in [-90, 90].
     *
     * @param {object} [options]
     * @param {number} [options.min=-90]
     * @param {number} [options.max=90]
     * @param {number} [options.decimals=6]
     * @returns {number}
     */
    static latitude(options = {}) {
        return Fake.float(options.min ?? -90, options.max ?? 90, options.decimals ?? 6);
    }

    /**
     * Random longitude as a float in [-180, 180].
     *
     * @param {object} [options]
     * @param {number} [options.min=-180]
     * @param {number} [options.max=180]
     * @param {number} [options.decimals=6]
     * @returns {number}
     */
    static longitude(options = {}) {
        return Fake.float(options.min ?? -180, options.max ?? 180, options.decimals ?? 6);
    }

    /**
     * Random { latitude, longitude } coordinate object.
     *
     * @param {object} [options]  - Passed to latitude() and longitude().
     * @returns {{ latitude: number, longitude: number }}
     */
    static coordinates(options = {}) {
        return { latitude: Fake.latitude(options), longitude: Fake.longitude(options) };
    }

    /** Random IANA timezone identifier (e.g. 'America/New_York'). */
    static timezone() { return _pick(TIMEZONES); }

    /**
     * Random street name (e.g. 'Oak Avenue').
     *
     * @returns {string}
     */
    static streetName() {
        return `${_pick(STREET_NAMES)} ${_pick(STREET_TYPES)}`;
    }

    /**
     * Random full street address.
     *
     * @param {object}  [options]
     * @param {string}  [options.countryCode='US']
     * @param {'string'|'object'} [options.format='string']
     * @returns {string|object}
     *
     * @example
     *   Fake.address();
     *   // '742 Evergreen Terrace, Springfield, IL 62701'
     *
     *   Fake.address({ format: 'object' });
     *   // { streetNumber, streetName, city, state, zipCode, country }
     */
    static address(options = {}) {
        const code        = (options.countryCode || 'US').toUpperCase();
        const streetNum   = _int(1, 9999);
        const street      = Fake.streetName();
        const city        = Fake.city({ country: code });
        const zipCode     = Fake.zipCode({ countryCode: code });
        const stateEntry  = code === 'US' ? _pick(US_STATES) : null;
        const countryName = (COUNTRIES.find(c => c.code === code) || { name: code }).name;

        if (options.format === 'object') {
            return {
                streetNumber: String(streetNum),
                streetName:   street,
                city,
                state:        stateEntry ? stateEntry.abbr : null,
                zipCode,
                country:      countryName,
            };
        }

        if (stateEntry) {
            return `${streetNum} ${street}, ${city}, ${stateEntry.abbr} ${zipCode}`;
        }
        return `${streetNum} ${street}, ${city} ${zipCode}, ${countryName}`;
    }

    // -- Commerce -----------------------------------------------------------

    /**
     * Random product name (adjective + material + noun).
     *
     * @param {object}  [options]
     * @param {boolean} [options.withMaterial=true]  - Include a material word.
     * @returns {string}
     */
    static productName(options = {}) {
        const withMaterial = options.withMaterial !== false;
        if (withMaterial) {
            return `${_pick(PRODUCT_ADJECTIVES)} ${_pick(PRODUCT_MATERIALS)} ${_pick(PRODUCT_NOUNS)}`;
        }
        return `${_pick(PRODUCT_ADJECTIVES)} ${_pick(PRODUCT_NOUNS)}`;
    }

    /** Random product category (e.g. 'Electronics'). */
    static category() { return _pick(CATEGORIES); }

    /** Random business department name. */
    static department() { return _pick(DEPARTMENTS); }

    /**
     * Random company name.
     *
     * @param {object}  [options]
     * @param {boolean} [options.suffix=true] - Append LLC / Inc. / etc.
     * @returns {string}
     */
    static company(options = {}) {
        const withSuffix = options.suffix !== false;
        const name       = `${_pick(COMPANY_ADJECTIVES)} ${_pick(COMPANY_NOUNS)}`;
        return withSuffix ? `${name} ${_pick(COMPANY_SUFFIXES)}` : name;
    }

    /**
     * Random price as a float with 2 decimal places.
     *
     * @param {object} [options]
     * @param {number} [options.min=0.99]
     * @param {number} [options.max=999.99]
     * @param {string} [options.symbol='']  - Prepend a currency symbol.
     * @returns {string|number} - String when symbol is provided, number otherwise.
     */
    static price(options = {}) {
        const val = Fake.float(options.min ?? 0.99, options.max ?? 999.99, 2);
        return options.symbol ? `${options.symbol}${val.toFixed(2)}` : val;
    }

    /** Random industry sector name. */
    static industry() { return _pick(INDUSTRIES); }

    /** Random catch phrase buzzword phrase. */
    static catchPhrase() {
        return `${_pick(CATCH_PHRASE_ADJECTIVES)} ${_pick(CATCH_PHRASE_NOUNS)}`;
    }

    // -- Internet & Network -------------------------------------------------

    /**
     * Random email address (backward-compatible shorthand — same as email()).
     * Accepts no arguments for historical use.
     */

    /** Random UUID v4. */
    static uuid() { return _uuid(); }

    /**
     * Random domain name (adjective-noun.tld).
     *
     * @param {object}  [options]
     * @param {string}  [options.tld]  - Force a specific TLD.
     * @returns {string}
     */
    static domainName(options = {}) {
        const tld = options.tld || _pick(TLDS);
        return `${_pick(DOMAIN_ADJECTIVES)}-${_pick(DOMAIN_NOUNS)}.${tld}`;
    }

    /**
     * Random URL.
     *
     * @param {object}  [options]
     * @param {'http'|'https'} [options.protocol='https']
     * @param {boolean} [options.appendSlash=false]
     * @returns {string}
     */
    static url(options = {}) {
        const proto = options.protocol || 'https';
        const path  = options.noPath ? '' : `/${Fake.word()}`;
        const slash = options.appendSlash ? '/' : '';
        return `${proto}://${Fake.domainName()}${path}${slash}`;
    }

    /**
     * Random IPv4 address.
     *
     * @param {object}  [options]
     * @param {'any'|'private-a'|'private-b'|'private-c'|'loopback'} [options.network='any']
     * @returns {string}
     */
    static ip(options = {}) {
        const net = options.network || 'any';
        if (net === 'loopback')  return `127.0.0.${_int(1, 254)}`;
        if (net === 'private-a') return `10.${_int(0,255)}.${_int(0,255)}.${_int(1,254)}`;
        if (net === 'private-b') return `172.${_int(16,31)}.${_int(0,255)}.${_int(1,254)}`;
        if (net === 'private-c') return `192.168.${_int(0,255)}.${_int(1,254)}`;
        return `${_int(1,254)}.${_int(0,255)}.${_int(0,255)}.${_int(1,254)}`;
    }

    /**
     * Random IPv6 address.
     *
     * @returns {string}
     */
    static ipv6() {
        const groups = Array.from({ length: 8 }, () =>
            _int(0, 65535).toString(16).padStart(4, '0')
        );
        return groups.join(':');
    }

    /**
     * Random MAC address.
     *
     * @param {object}  [options]
     * @param {':'|'-'|''} [options.separator=':']
     * @param {boolean}   [options.realisticOUI=false] - Use a real vendor OUI prefix.
     * @returns {string}
     */
    static mac(options = {}) {
        const sep = options.separator ?? ':';
        if (options.realisticOUI) {
            const oui  = _pick(MAC_OUIS).replace(/:/g, sep);
            const rest = Array.from({ length: 3 }, () =>
                _int(0, 255).toString(16).padStart(2, '0')
            ).join(sep);
            return `${oui}${sep}${rest}`;
        }
        return Array.from({ length: 6 }, () =>
            _int(0, 255).toString(16).padStart(2, '0')
        ).join(sep);
    }

    /**
     * Random network port number.
     *
     * @param {object}  [options]
     * @param {'well-known'|'registered'|'dynamic'|'any'} [options.range='any']
     *   well-known  → 1–1023
     *   registered  → 1024–49151
     *   dynamic     → 49152–65535
     *   any         → 1–65535
     * @returns {number}
     */
    static port(options = {}) {
        const range = options.range || 'any';
        if (range === 'well-known')  return _int(1, 1023);
        if (range === 'registered')  return _int(1024, 49151);
        if (range === 'dynamic')     return _int(49152, 65535);
        return _int(1, 65535);
    }

    /**
     * Random HTTP method.
     *
     * @param {object}  [options]
     * @param {string[]} [options.methods]  - Restrict to specific methods.
     * @returns {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'}
     */
    static httpMethod(options = {}) {
        const pool = options.methods || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        return _pick(pool);
    }

    /**
     * Random user agent string (realistic browser/client).
     *
     * @returns {string}
     */
    static userAgent() { return _pick(USER_AGENTS); }

    /**
     * Random password-like string. NOT suitable for real passwords — uses a
     * PRNG seeded from Math.random, not a CSPRNG.
     *
     * @param {object}  [options]
     * @param {number}  [options.length=16]          - Character count.
     * @param {boolean} [options.uppercase=true]     - Include uppercase letters.
     * @param {boolean} [options.lowercase=true]     - Include lowercase letters.
     * @param {boolean} [options.digits=true]        - Include digits.
     * @param {boolean} [options.special=false]      - Include special characters.
     * @param {string}  [options.prefix='']          - Prepend a prefix.
     * @returns {string}
     */
    static password(options = {}) {
        const len     = options.length    ?? 16;
        const prefix  = options.prefix    ?? '';
        let pool = '';
        if (options.lowercase !== false) pool += CHARSET_LOWERCASE;
        if (options.uppercase !== false) pool += CHARSET_UPPERCASE;
        if (options.digits    !== false) pool += CHARSET_DIGITS;
        if (options.special   === true)  pool += CHARSET_SPECIAL;
        pool = pool || (CHARSET_LOWERCASE + CHARSET_UPPERCASE + CHARSET_DIGITS);
        const body = Array.from({ length: Math.max(0, len - prefix.length) }, () =>
            pool[Math.floor(rand() * pool.length)]
        ).join('');
        return `${prefix}${body}`;
    }

    // -- Colors -------------------------------------------------------------

    /**
     * Random hex color code.
     *
     * @returns {string}  e.g. '#3a7f2b'
     */
    static color() {
        return '#' + Math.floor(rand() * 16777215).toString(16).padStart(6, '0');
    }

    /**
     * Random RGB color object or string.
     *
     * @param {object}  [options]
     * @param {'object'|'css'} [options.format='css']
     * @returns {{ r:number, g:number, b:number }|string}
     */
    static rgb(options = {}) {
        const r = _int(0, 255), g = _int(0, 255), b = _int(0, 255);
        if (options.format === 'object') return { r, g, b };
        return `rgb(${r}, ${g}, ${b})`;
    }

    /**
     * Random HSL color string or object.
     *
     * @param {object}  [options]
     * @param {'object'|'css'} [options.format='css']
     * @returns {{ h:number, s:number, l:number }|string}
     */
    static hsl(options = {}) {
        const h = _int(0, 360), s = _int(20, 100), l = _int(20, 80);
        if (options.format === 'object') return { h, s, l };
        return `hsl(${h}, ${s}%, ${l}%)`;
    }

    // -- Helpers ------------------------------------------------------------

    /**
     * Pick a random element from an array.
     *
     * @template T
     * @param {T[]} arr
     * @returns {T}
     */
    static pick(arr) { return _pick(arr); }

    /**
     * Pick n random elements from an array (no duplicates).
     *
     * @template T
     * @param {T[]}   arr
     * @param {number} n
     * @returns {T[]}
     */
    static pickMany(arr, n) { return _pickMany(arr, n); }

    /**
     * Shuffle an array in-place using Fisher-Yates and return it.
     *
     * @template T
     * @param {T[]} arr
     * @returns {T[]}
     */
    static shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /**
     * Random JSON-safe object (useful as a quick fixture value).
     *
     * @returns {{ key: string, value: string, count: number, active: boolean }}
     */
    static json() {
        return {
            key:    Fake.word(),
            value:  Fake.sentence(3),
            count:  _int(1, 100),
            active: Fake.boolean(),
        };
    }

    /**
     * Random element from an enum-like array, validated at call time.
     *
     * @template T
     * @param {readonly T[]} values
     * @returns {T}
     */
    static enumValue(values) {
        if (!Array.isArray(values) || values.length === 0) {
            throw new Error('Fake.enumValue: requires a non-empty array');
        }
        return _pick(values);
    }
}

// Static uniqueness tracker — shared across all calls in the process lifetime
Fake._tracker = new UniqueTracker();

module.exports = { Fake };
