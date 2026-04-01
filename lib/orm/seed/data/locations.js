'use strict';

/**
 * @module seed/data/locations
 * @description Data pools for location-based fake data:
 *              cities, countries, US states, street parts, timezones, zip patterns.
 */

/**
 * Top-tier world cities with their country code.
 * Used by Fake.city() and Fake.address().
 */
const CITIES = [
    { name: 'New York',       country: 'US' }, { name: 'Los Angeles',     country: 'US' },
    { name: 'Chicago',        country: 'US' }, { name: 'Houston',         country: 'US' },
    { name: 'Phoenix',        country: 'US' }, { name: 'San Antonio',     country: 'US' },
    { name: 'San Diego',      country: 'US' }, { name: 'Dallas',          country: 'US' },
    { name: 'San Francisco',  country: 'US' }, { name: 'Seattle',         country: 'US' },
    { name: 'Boston',         country: 'US' }, { name: 'Atlanta',         country: 'US' },
    { name: 'Denver',         country: 'US' }, { name: 'Las Vegas',       country: 'US' },
    { name: 'Portland',       country: 'US' }, { name: 'Nashville',       country: 'US' },
    { name: 'London',         country: 'GB' }, { name: 'Manchester',      country: 'GB' },
    { name: 'Birmingham',     country: 'GB' }, { name: 'Edinburgh',       country: 'GB' },
    { name: 'Paris',          country: 'FR' }, { name: 'Lyon',            country: 'FR' },
    { name: 'Marseille',      country: 'FR' }, { name: 'Berlin',          country: 'DE' },
    { name: 'Munich',         country: 'DE' }, { name: 'Hamburg',         country: 'DE' },
    { name: 'Frankfurt',      country: 'DE' }, { name: 'Rome',            country: 'IT' },
    { name: 'Milan',          country: 'IT' }, { name: 'Naples',          country: 'IT' },
    { name: 'Madrid',         country: 'ES' }, { name: 'Barcelona',       country: 'ES' },
    { name: 'Seville',        country: 'ES' }, { name: 'Lisbon',          country: 'PT' },
    { name: 'Porto',          country: 'PT' }, { name: 'São Paulo',       country: 'BR' },
    { name: 'Rio de Janeiro', country: 'BR' }, { name: 'Brasília',        country: 'BR' },
    { name: 'Mexico City',    country: 'MX' }, { name: 'Guadalajara',     country: 'MX' },
    { name: 'Moscow',         country: 'RU' }, { name: 'Saint Petersburg',country: 'RU' },
    { name: 'Tokyo',          country: 'JP' }, { name: 'Osaka',           country: 'JP' },
    { name: 'Kyoto',          country: 'JP' }, { name: 'Beijing',         country: 'CN' },
    { name: 'Shanghai',       country: 'CN' }, { name: 'Shenzhen',        country: 'CN' },
    { name: 'Seoul',          country: 'KR' }, { name: 'Busan',           country: 'KR' },
    { name: 'Mumbai',         country: 'IN' }, { name: 'Delhi',           country: 'IN' },
    { name: 'Bangalore',      country: 'IN' }, { name: 'Dubai',           country: 'AE' },
    { name: 'Abu Dhabi',      country: 'AE' }, { name: 'Cairo',           country: 'EG' },
    { name: 'Lagos',          country: 'NG' }, { name: 'Nairobi',         country: 'KE' },
    { name: 'Johannesburg',   country: 'ZA' }, { name: 'Cape Town',       country: 'ZA' },
    { name: 'Sydney',         country: 'AU' }, { name: 'Melbourne',       country: 'AU' },
    { name: 'Brisbane',       country: 'AU' }, { name: 'Toronto',         country: 'CA' },
    { name: 'Vancouver',      country: 'CA' }, { name: 'Montreal',        country: 'CA' },
    { name: 'Amsterdam',      country: 'NL' }, { name: 'Stockholm',       country: 'SE' },
    { name: 'Copenhagen',     country: 'DK' }, { name: 'Oslo',            country: 'NO' },
    { name: 'Zurich',         country: 'CH' }, { name: 'Geneva',          country: 'CH' },
    { name: 'Vienna',         country: 'AT' }, { name: 'Warsaw',          country: 'PL' },
    { name: 'Prague',         country: 'CZ' }, { name: 'Budapest',        country: 'HU' },
    { name: 'Singapore',      country: 'SG' }, { name: 'Bangkok',         country: 'TH' },
    { name: 'Jakarta',        country: 'ID' }, { name: 'Kuala Lumpur',    country: 'MY' },
    { name: 'Ho Chi Minh',    country: 'VN' }, { name: 'Manila',          country: 'PH' },
    { name: 'Karachi',        country: 'PK' }, { name: 'Lahore',          country: 'PK' },
    { name: 'Dhaka',          country: 'BD' }, { name: 'Colombo',         country: 'LK' },
    { name: 'Santiago',       country: 'CL' }, { name: 'Lima',            country: 'PE' },
    { name: 'Buenos Aires',   country: 'AR' }, { name: 'Bogotá',          country: 'CO' },
];

/**
 * Countries with ISO 3166-1 alpha-2 codes.
 */
const COUNTRIES = [
    { name: 'United States',   code: 'US' }, { name: 'United Kingdom',  code: 'GB' },
    { name: 'Canada',          code: 'CA' }, { name: 'Australia',       code: 'AU' },
    { name: 'Germany',         code: 'DE' }, { name: 'France',          code: 'FR' },
    { name: 'Italy',           code: 'IT' }, { name: 'Spain',           code: 'ES' },
    { name: 'Portugal',        code: 'PT' }, { name: 'Netherlands',     code: 'NL' },
    { name: 'Sweden',          code: 'SE' }, { name: 'Norway',          code: 'NO' },
    { name: 'Denmark',         code: 'DK' }, { name: 'Finland',         code: 'FI' },
    { name: 'Switzerland',     code: 'CH' }, { name: 'Austria',         code: 'AT' },
    { name: 'Belgium',         code: 'BE' }, { name: 'Poland',          code: 'PL' },
    { name: 'Czech Republic',  code: 'CZ' }, { name: 'Hungary',         code: 'HU' },
    { name: 'Russia',          code: 'RU' }, { name: 'Japan',           code: 'JP' },
    { name: 'China',           code: 'CN' }, { name: 'South Korea',     code: 'KR' },
    { name: 'India',           code: 'IN' }, { name: 'Brazil',          code: 'BR' },
    { name: 'Mexico',          code: 'MX' }, { name: 'Argentina',       code: 'AR' },
    { name: 'Chile',           code: 'CL' }, { name: 'Colombia',        code: 'CO' },
    { name: 'Peru',            code: 'PE' }, { name: 'South Africa',    code: 'ZA' },
    { name: 'Nigeria',         code: 'NG' }, { name: 'Kenya',           code: 'KE' },
    { name: 'Egypt',           code: 'EG' }, { name: 'UAE',             code: 'AE' },
    { name: 'Saudi Arabia',    code: 'SA' }, { name: 'Israel',          code: 'IL' },
    { name: 'Turkey',          code: 'TR' }, { name: 'Indonesia',       code: 'ID' },
    { name: 'Thailand',        code: 'TH' }, { name: 'Vietnam',         code: 'VN' },
    { name: 'Malaysia',        code: 'MY' }, { name: 'Singapore',       code: 'SG' },
    { name: 'Philippines',     code: 'PH' }, { name: 'Pakistan',        code: 'PK' },
    { name: 'Bangladesh',      code: 'BD' }, { name: 'New Zealand',     code: 'NZ' },
    { name: 'Greece',          code: 'GR' }, { name: 'Romania',         code: 'RO' },
];

/** US States with 2-letter USPS abbreviations. */
const US_STATES = [
    { name: 'Alabama',        abbr: 'AL' }, { name: 'Alaska',           abbr: 'AK' },
    { name: 'Arizona',        abbr: 'AZ' }, { name: 'Arkansas',         abbr: 'AR' },
    { name: 'California',     abbr: 'CA' }, { name: 'Colorado',         abbr: 'CO' },
    { name: 'Connecticut',    abbr: 'CT' }, { name: 'Delaware',         abbr: 'DE' },
    { name: 'Florida',        abbr: 'FL' }, { name: 'Georgia',          abbr: 'GA' },
    { name: 'Hawaii',         abbr: 'HI' }, { name: 'Idaho',            abbr: 'ID' },
    { name: 'Illinois',       abbr: 'IL' }, { name: 'Indiana',          abbr: 'IN' },
    { name: 'Iowa',           abbr: 'IA' }, { name: 'Kansas',           abbr: 'KS' },
    { name: 'Kentucky',       abbr: 'KY' }, { name: 'Louisiana',        abbr: 'LA' },
    { name: 'Maine',          abbr: 'ME' }, { name: 'Maryland',         abbr: 'MD' },
    { name: 'Massachusetts',  abbr: 'MA' }, { name: 'Michigan',         abbr: 'MI' },
    { name: 'Minnesota',      abbr: 'MN' }, { name: 'Mississippi',      abbr: 'MS' },
    { name: 'Missouri',       abbr: 'MO' }, { name: 'Montana',          abbr: 'MT' },
    { name: 'Nebraska',       abbr: 'NE' }, { name: 'Nevada',           abbr: 'NV' },
    { name: 'New Hampshire',  abbr: 'NH' }, { name: 'New Jersey',       abbr: 'NJ' },
    { name: 'New Mexico',     abbr: 'NM' }, { name: 'New York',         abbr: 'NY' },
    { name: 'North Carolina', abbr: 'NC' }, { name: 'North Dakota',     abbr: 'ND' },
    { name: 'Ohio',           abbr: 'OH' }, { name: 'Oklahoma',         abbr: 'OK' },
    { name: 'Oregon',         abbr: 'OR' }, { name: 'Pennsylvania',     abbr: 'PA' },
    { name: 'Rhode Island',   abbr: 'RI' }, { name: 'South Carolina',   abbr: 'SC' },
    { name: 'South Dakota',   abbr: 'SD' }, { name: 'Tennessee',        abbr: 'TN' },
    { name: 'Texas',          abbr: 'TX' }, { name: 'Utah',             abbr: 'UT' },
    { name: 'Vermont',        abbr: 'VT' }, { name: 'Virginia',         abbr: 'VA' },
    { name: 'Washington',     abbr: 'WA' }, { name: 'West Virginia',    abbr: 'WV' },
    { name: 'Wisconsin',      abbr: 'WI' }, { name: 'Wyoming',          abbr: 'WY' },
];

/** Street type suffixes. */
const STREET_TYPES = [
    'Street', 'Avenue', 'Boulevard', 'Drive', 'Lane', 'Road', 'Court',
    'Place', 'Way', 'Circle', 'Trail', 'Highway', 'Parkway', 'Terrace',
    'Path', 'Ridge', 'Creek', 'Bridge', 'Meadows', 'Heights',
];

/** Street name words (first part of a street name). */
const STREET_NAMES = [
    'Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Walnut', 'Cherry', 'Birch',
    'Willow', 'Aspen', 'Magnolia', 'Chestnut', 'Sycamore', 'Cypress', 'Poplar',
    'Washington', 'Lincoln', 'Jefferson', 'Madison', 'Adams', 'Roosevelt',
    'Kennedy', 'Franklin', 'Hamilton', 'Jackson', 'Grant', 'Harrison',
    'Park', 'Hill', 'Lake', 'River', 'Meadow', 'Forest', 'Valley', 'Highland',
    'Sunrise', 'Sunset', 'Spring', 'Summer', 'Winter', 'Autumn',
    'Church', 'School', 'Mill', 'Bridge', 'Market', 'Garden', 'Union',
    'Cardinal', 'Eagle', 'Hawk', 'Falcon', 'Robin', 'Blue Jay', 'Sparrow',
];

/**
 * Postal / ZIP code format patterns per country code.
 *   #  → random digit 0–9
 *   A  → random uppercase letter
 */
const ZIP_PATTERNS = {
    'US': '#####',
    'CA': 'A#A #A#',
    'GB': 'AA## #AA',
    'DE': '#####',
    'FR': '#####',
    'IT': '#####',
    'ES': '#####',
    'PT': '####-###',
    'BR': '#####-###',
    'MX': '#####',
    'NL': '#### AA',
    'SE': '### ##',
    'NO': '####',
    'DK': '####',
    'FI': '#####',
    'CH': '####',
    'AT': '####',
    'BE': '####',
    'AU': '####',
    'NZ': '####',
    'JP': '###-####',
    'CN': '######',
    'KR': '#####',
    'IN': '######',
    'RU': '######',
    'ZA': '####',
    'NG': '######',
};

/** Common IANA timezone identifiers. */
const TIMEZONES = [
    'America/New_York',    'America/Chicago',       'America/Denver',
    'America/Los_Angeles', 'America/Toronto',        'America/Vancouver',
    'America/Sao_Paulo',   'America/Mexico_City',    'America/Buenos_Aires',
    'America/Santiago',    'America/Bogota',          'America/Lima',
    'Europe/London',       'Europe/Paris',            'Europe/Berlin',
    'Europe/Rome',         'Europe/Madrid',           'Europe/Amsterdam',
    'Europe/Stockholm',    'Europe/Moscow',           'Europe/Warsaw',
    'Europe/Istanbul',     'Europe/Athens',           'Europe/Lisbon',
    'Africa/Cairo',        'Africa/Johannesburg',     'Africa/Lagos',
    'Africa/Nairobi',      'Asia/Dubai',              'Asia/Kolkata',
    'Asia/Kolkata',        'Asia/Karachi',            'Asia/Dhaka',
    'Asia/Bangkok',        'Asia/Jakarta',            'Asia/Singapore',
    'Asia/Kuala_Lumpur',   'Asia/Manila',             'Asia/Shanghai',
    'Asia/Tokyo',          'Asia/Seoul',              'Asia/Hong_Kong',
    'Asia/Taipei',         'Asia/Riyadh',             'Asia/Tehran',
    'Australia/Sydney',    'Australia/Melbourne',     'Australia/Perth',
    'Pacific/Auckland',    'Pacific/Auckland',        'Pacific/Honolulu',
];

module.exports = {
    CITIES,
    COUNTRIES,
    US_STATES,
    STREET_TYPES,
    STREET_NAMES,
    ZIP_PATTERNS,
    TIMEZONES,
};
