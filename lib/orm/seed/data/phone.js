'use strict';

/**
 * @module seed/data/phone
 * @description Phone format templates and country-code metadata.
 *
 *  Format characters:
 *    #  any digit (0–9)
 *    N  non-zero digit (1–9)
 *    X  subscriber digit (2–9)
 */

/**
 * Array of { countryCode, dialCode, formats }
 *
 * formats.human       – human-input style  (e.g. 555-770-7727 x1234)
 * formats.national    – national format    (e.g. (555) 123-4567)
 * formats.international – E.123 style      (e.g. +1 555 123 4567)
 */
const PHONE_DATA = [
    {
        countryCode: 'US',
        dialCode: '+1',
        formats: {
            human:         ['###-###-####', '(###) ###-####', '###.###.####', '###-###-#### x###'],
            national:      ['(###) ###-####'],
            international: ['+1 (###) ###-####', '+1-###-###-####'],
        },
    },
    {
        countryCode: 'CA',
        dialCode: '+1',
        formats: {
            human:         ['###-###-####', '(###) ###-####', '###.###.####'],
            national:      ['(###) ###-####'],
            international: ['+1 (###) ###-####'],
        },
    },
    {
        countryCode: 'GB',
        dialCode: '+44',
        formats: {
            human:         ['07### ######', '01### ######', '02# #### ####'],
            national:      ['07### ######', '(01###) ######'],
            international: ['+44 7### ######', '+44 1### ######'],
        },
    },
    {
        countryCode: 'DE',
        dialCode: '+49',
        formats: {
            human:         ['0### #######', '0## ########', '01## #######'],
            national:      ['(0###) #######'],
            international: ['+49 ### #######', '+49 ## ########'],
        },
    },
    {
        countryCode: 'FR',
        dialCode: '+33',
        formats: {
            human:         ['0# ## ## ## ##', '06 ## ## ## ##', '07 ## ## ## ##'],
            national:      ['0# ## ## ## ##'],
            international: ['+33 # ## ## ## ##'],
        },
    },
    {
        countryCode: 'IT',
        dialCode: '+39',
        formats: {
            human:         ['### #######', '3## #######'],
            national:      ['(###) #######'],
            international: ['+39 ### #######'],
        },
    },
    {
        countryCode: 'ES',
        dialCode: '+34',
        formats: {
            human:         ['### ### ###', '6## ### ###'],
            national:      ['(###) ### ###'],
            international: ['+34 ### ### ###'],
        },
    },
    {
        countryCode: 'PT',
        dialCode: '+351',
        formats: {
            human:         ['2## ### ###', '9## ### ###'],
            national:      ['(2##) ### ###'],
            international: ['+351 ### ### ###'],
        },
    },
    {
        countryCode: 'BR',
        dialCode: '+55',
        formats: {
            human:         ['(##) ####-####', '(##) 9####-####'],
            national:      ['(##) ####-####'],
            international: ['+55 ## #### ####'],
        },
    },
    {
        countryCode: 'MX',
        dialCode: '+52',
        formats: {
            human:         ['(###) ###-####', '## #### ####'],
            national:      ['(###) ###-####'],
            international: ['+52 ### ### ####'],
        },
    },
    {
        countryCode: 'RU',
        dialCode: '+7',
        formats: {
            human:         ['8 (###) ###-##-##', '8-###-###-##-##'],
            national:      ['(###) ###-##-##'],
            international: ['+7 (###) ###-##-##'],
        },
    },
    {
        countryCode: 'IN',
        dialCode: '+91',
        formats: {
            human:         ['#####-#####', '(0##) ###-####'],
            national:      ['##### #####'],
            international: ['+91 ##### #####'],
        },
    },
    {
        countryCode: 'CN',
        dialCode: '+86',
        formats: {
            human:         ['### #### ####', '1## #### ####'],
            national:      ['(0##) #### ####'],
            international: ['+86 ### #### ####'],
        },
    },
    {
        countryCode: 'JP',
        dialCode: '+81',
        formats: {
            human:         ['0##-####-####', '080-####-####', '090-####-####'],
            national:      ['(0##) ####-####'],
            international: ['+81 ##-####-####'],
        },
    },
    {
        countryCode: 'KR',
        dialCode: '+82',
        formats: {
            human:         ['0##-####-####', '010-####-####'],
            national:      ['(0##) ####-####'],
            international: ['+82 ##-####-####'],
        },
    },
    {
        countryCode: 'AU',
        dialCode: '+61',
        formats: {
            human:         ['04## ### ###', '0# #### ####'],
            national:      ['04## ### ###', '(0#) #### ####'],
            international: ['+61 4## ### ###', '+61 # #### ####'],
        },
    },
    {
        countryCode: 'NL',
        dialCode: '+31',
        formats: {
            human:         ['0## ### ####', '06 ## ## ## ##'],
            national:      ['(0##) ### ####'],
            international: ['+31 ## ### ####'],
        },
    },
    {
        countryCode: 'SE',
        dialCode: '+46',
        formats: {
            human:         ['0## ### ## ##', '07# ### ## ##'],
            national:      ['(0##) ### ## ##'],
            international: ['+46 ## ### ## ##'],
        },
    },
    {
        countryCode: 'ZA',
        dialCode: '+27',
        formats: {
            human:         ['0## ### ####', '081 ### ####'],
            national:      ['(0##) ### ####'],
            international: ['+27 ## ### ####'],
        },
    },
    {
        countryCode: 'NG',
        dialCode: '+234',
        formats: {
            human:         ['080 #### ####', '081 #### ####', '0## ### ####'],
            national:      ['0## ### ####'],
            international: ['+234 ## #### ####'],
        },
    },
];

/** Indexed by country code for O(1) lookups. */
const PHONE_BY_COUNTRY = Object.fromEntries(
    PHONE_DATA.map(p => [p.countryCode, p])
);

/** All supported country codes. */
const COUNTRY_CODES = PHONE_DATA.map(p => p.countryCode);

module.exports = { PHONE_DATA, PHONE_BY_COUNTRY, COUNTRY_CODES };
