'use strict';

/**
 * @module seed/data/person
 * @description Data pools for generated person attributes:
 *              job titles, prefixes/suffixes, gender, bio phrases, zodiac signs.
 */

/** Title prefixes — separate lists per target sex for contextual use. */
const NAME_PREFIXES = {
    male:    ['Mr.', 'Dr.', 'Prof.'],
    female:  ['Ms.', 'Mrs.', 'Dr.', 'Prof.', 'Miss'],
    neutral: ['Dr.', 'Prof.', 'Rev.', 'Hon.'],
};

/** Credential / generational suffixes. */
const NAME_SUFFIXES = [
    'Jr.', 'Sr.', 'I', 'II', 'III', 'IV', 'V',
    'PhD', 'MD', 'MBA', 'DDS', 'Esq.', 'PE',
];

/** Job-level descriptors (prepended to job titles). */
const JOB_DESCRIPTORS = [
    'Senior', 'Junior', 'Lead', 'Principal', 'Staff', 'Associate',
    'Global', 'Regional', 'District', 'National', 'Chief', 'Head of',
    'VP of', 'Director of', 'Manager of', 'Specialist in',
];

/** Functional areas / departments. */
const JOB_AREAS = [
    'Engineering', 'Software', 'Frontend', 'Backend', 'Full-Stack',
    'Data', 'Infrastructure', 'Cloud', 'Security', 'DevOps', 'QA',
    'Product', 'Design', 'UX', 'Brand', 'Marketing', 'Growth',
    'Sales', 'Account', 'Customer Success', 'Support', 'Finance',
    'Operations', 'Legal', 'HR', 'Research', 'Analytics', 'Business',
    'Mobile', 'AI', 'Machine Learning', 'Platform', 'Solutions',
];

/** Job title nouns. */
const JOB_TYPES = [
    'Engineer', 'Developer', 'Designer', 'Architect', 'Analyst',
    'Strategist', 'Consultant', 'Coordinator', 'Administrator',
    'Manager', 'Director', 'Officer', 'Executive', 'Specialist',
    'Researcher', 'Scientist', 'Associate', 'Advisor', 'Lead',
    'Partner', 'Representative', 'Recruiter', 'Writer', 'Editor',
    'Technician', 'Operator', 'Planner', 'Producer', 'Advocate',
];

/** Pre-built full job titles for use when a complete title is needed. */
const JOB_TITLES = [
    'Software Engineer', 'Senior Software Engineer', 'Lead Developer',
    'Full-Stack Developer', 'Frontend Developer', 'Backend Engineer',
    'DevOps Engineer', 'Site Reliability Engineer', 'Platform Engineer',
    'Data Engineer', 'Data Scientist', 'Machine Learning Engineer',
    'Product Manager', 'Senior Product Manager', 'Technical Product Manager',
    'UX Designer', 'UI Designer', 'Product Designer', 'Brand Designer',
    'Marketing Manager', 'Growth Hacker', 'Content Strategist', 'SEO Specialist',
    'Sales Engineer', 'Account Executive', 'Customer Success Manager',
    'Business Analyst', 'Financial Analyst', 'Chief Financial Officer',
    'Chief Technology Officer', 'Chief Executive Officer', 'VP of Engineering',
    'Director of Operations', 'Head of Growth', 'Engineering Manager',
    'QA Engineer', 'Security Engineer', 'Cloud Architect', 'Solutions Architect',
    'HR Business Partner', 'Talent Acquisition Specialist', 'Legal Counsel',
    'Data Analyst', 'BI Developer', 'Mobile Developer', 'iOS Engineer',
    'Android Developer', 'Technical Writer', 'Developer Advocate',
];

/** Zodiac sign names. */
const ZODIAC_SIGNS = [
    'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
    'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

/** Inclusive gender labels. */
const GENDERS = [
    'Male', 'Female', 'Non-binary', 'Gender fluid', 'Agender',
    'Bigender', 'Genderqueer', 'Two-spirit', 'Trans man', 'Trans woman',
    'Pangender', 'Neutrois', 'Androgynous', 'Gender non-conforming',
];

/** Short biography phrase fragments, combinable into a fun bio. */
const BIO_ADJECTIVES = [
    'avid', 'aspiring', 'passionate', 'reformed', 'recovering', 'proud',
    'self-taught', 'seasoned', 'aspiring', 'enthusiastic', 'relentless',
    'certified', 'award-winning', 'self-proclaimed', 'part-time', 'full-time',
];

const BIO_NOUNS = [
    'coder', 'developer', 'designer', 'hacker', 'maker', 'builder',
    'tinkerer', 'skeptic', 'advocate', 'coffee drinker', 'pizza lover',
    'cat person', 'dog person', 'night owl', 'morning person', 'traveler',
    'bookworm', 'gamer', 'runner', 'cyclist', 'climber', 'swimmer',
    'foodie', 'chef', 'photographer', 'musician', 'artist', 'dreamer',
    'blogger', 'podcaster', 'content creator', 'open-source contributor',
];

const BIO_PHRASES = [
    'lover of all things tech', 'always learning something new',
    'living one commit at a time', 'making things that matter',
    'caffeinated and ready to ship', 'here to build great products',
    'not all who wander are lost', 'just vibing and deploying hotfixes',
    'ask me about my side projects', 'one bug at a time',
    'pushing to prod on Fridays', 'debug everything, regret nothing',
    'refactoring the world, one function at a time',
    'building the future from the terminal',
    'professional overthinker', 'chaos engineer in training',
    '10x developer (citation needed)', 'it works on my machine',
    'turning coffee into code since forever',
    'probably thinking about distributed systems right now',
];

/** Blood type options. */
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

module.exports = {
    NAME_PREFIXES,
    NAME_SUFFIXES,
    JOB_DESCRIPTORS,
    JOB_AREAS,
    JOB_TYPES,
    JOB_TITLES,
    ZODIAC_SIGNS,
    GENDERS,
    BIO_ADJECTIVES,
    BIO_NOUNS,
    BIO_PHRASES,
    BLOOD_TYPES,
};
