'use strict';

/**
 * @module seed/data/words
 * @description Word pools for text-generation helpers (lorem ipsum, hacker,
 *              adjectives, nouns, verbs).
 */

/** Extended lorem ipsum vocabulary for paragraph / sentence generation. */
const LOREM_WORDS = [
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
    'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore', 'magna', 'aliqua',
    'enim', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris',
    'nisi', 'aliquip', 'commodo', 'consequat', 'duis', 'aute', 'irure', 'reprehenderit',
    'voluptate', 'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur',
    'sint', 'occaecat', 'cupidatat', 'proident', 'culpa', 'officia', 'deserunt', 'mollit',
    'anim', 'laborum', 'perspiciatis', 'unde', 'omnis', 'iste', 'natus', 'error',
    'accusantium', 'doloremque', 'laudantium', 'totam', 'aperiam', 'eaque', 'ipsa',
    'quae', 'inventore', 'veritatis', 'quasi', 'architecto', 'beatae', 'vitae',
    'dicta', 'explicabo', 'aspernatur', 'aut', 'odit', 'fugit', 'voluptas', 'esse',
    'blanditiis', 'praesentium', 'voluptatum', 'deleniti', 'atque', 'corrupti',
    'quos', 'molestias', 'excepturi', 'occaecati', 'impedit', 'minus', 'soluta',
    'nobis', 'eligendi', 'optio', 'cumque', 'nihil', 'impedit', 'assumenda',
    'repellendus', 'temporibus', 'quibusdam', 'officiis', 'debitis', 'rerum',
    'saepe', 'eveniet', 'repudiandae', 'recusandae', 'itaque', 'earum', 'facilis',
    'expedita', 'distinctio', 'libero', 'tempore', 'cum', 'soluta', 'nobis',
    'eligendi', 'voluptatem', 'accusantium', 'reiciendis', 'voluptatibus', 'maiores',
];

/** Hacker-speak adjectives (for technical-sounding content). */
const HACKER_ADJECTIVES = [
    'auxiliary', 'back-end', 'binary', 'bluetooth', 'bypass', 'cross-platform',
    'digital', 'distributed', 'encrypted', 'enterprise', 'global', 'haptic',
    'human-readable', 'incremental', 'integrated', 'intuitive', 'iterative',
    'mobile', 'modular', 'multi-byte', 'neural', 'neural-net', 'online',
    'open-source', 'optical', 'primary', 'progressive', 'proxy', 'real-time',
    'redundant', 'responsive', 'scalable', 'solid-state', 'syntactic',
    'third-party', 'turn-key', 'ubiquitous', 'upstream', 'virtual', 'wireless',
];

/** Hacker-speak nouns. */
const HACKER_NOUNS = [
    'array', 'bandwidth', 'circuit', 'codecs', 'bus', 'capacitor', 'driver',
    'feed', 'firewall', 'hard-drive', 'interface', 'matrix', 'microchip',
    'monitor', 'network', 'panel', 'parser', 'payload', 'pixel', 'port',
    'protocol', 'router', 'sensor', 'server', 'socket', 'system', 'terminal',
    'transmitter', 'program', 'card', 'application', 'cache', 'alarm',
    'bandwidth', 'protocol', 'pixel', 'database', 'byte', 'token', 'hash',
];

/** Hacker-speak verbs. */
const HACKER_VERBS = [
    'back up', 'bypass', 'calculate', 'compress', 'connect', 'copy', 'decrypt',
    'disintegrate', 'encrypt', 'encode', 'generate', 'hack', 'index', 'input',
    'install', 'interface', 'navigate', 'override', 'parse', 'program',
    'quantify', 'reboot', 'reinitialize', 'synthesize', 'transmit', 'transpile',
    'quantize', 'serialize', 'virtualize', 'authenticate', 'tokenize', 'deploy',
];

/** Common English adjectives. */
const ADJECTIVES = [
    'adaptable', 'adventurous', 'affectionate', 'ambitious', 'ancient', 'arid',
    'aromatic', 'artificial', 'bold', 'boundless', 'captivating', 'careful',
    'charming', 'cheerful', 'cloudy', 'comfortable', 'complex', 'confident',
    'content', 'crisp', 'curious', 'dazzling', 'decisive', 'delightful',
    'dense', 'determined', 'divine', 'durable', 'elegant', 'ethical',
    'exciting', 'exotic', 'exquisite', 'extraordinary', 'fabulous', 'faithful',
    'famous', 'fancy', 'fantastic', 'fearless', 'flexible', 'fluent',
    'genuine', 'glorious', 'graceful', 'grateful', 'handsome', 'harmonious',
    'helpful', 'honest', 'humble', 'immense', 'impeccable', 'innovative',
    'inspiring', 'intelligent', 'jovial', 'joyful', 'keen', 'lively',
    'logical', 'loyal', 'luxurious', 'magical', 'majestic', 'masterful',
    'mindful', 'natural', 'nimble', 'noble', 'orderly', 'passionate',
    'patient', 'peaceful', 'perfect', 'playful', 'polished', 'powerful',
    'precise', 'productive', 'qualitative', 'radiant', 'refreshing', 'reliable',
    'resilient', 'resourceful', 'restful', 'rhythmic', 'robust', 'secure',
    'serene', 'sincere', 'sophisticated', 'steadfast', 'strategic', 'stunning',
    'sustainable', 'swift', 'thoughtful', 'thriving', 'timeless', 'tranquil',
    'trustworthy', 'unique', 'vibrant', 'vigilant', 'virtuous', 'wonderful',
];

/** Common English nouns. */
const NOUNS = [
    'ability', 'absence', 'access', 'account', 'action', 'activity', 'addition',
    'address', 'advance', 'adventure', 'advice', 'affair', 'agenda', 'agreement',
    'algorithm', 'alliance', 'analysis', 'announcement', 'answer', 'approach',
    'architecture', 'area', 'argument', 'arrangement', 'asset', 'assumption',
    'balance', 'benefit', 'boundary', 'capability', 'challenge', 'change',
    'channel', 'chart', 'choice', 'claim', 'clarity', 'class', 'collection',
    'commitment', 'community', 'component', 'concept', 'concern', 'conclusion',
    'configuration', 'conflict', 'connection', 'constraint', 'context', 'contract',
    'contribution', 'control', 'conversion', 'culture', 'decision', 'delivery',
    'design', 'detail', 'development', 'difference', 'direction', 'discovery',
    'discussion', 'distribution', 'document', 'domain', 'duration', 'element',
    'energy', 'environment', 'evaluation', 'example', 'experience', 'explanation',
    'extension', 'factor', 'feature', 'feedback', 'flow', 'focus', 'format',
    'foundation', 'framework', 'function', 'future', 'growth', 'guide',
    'improvement', 'innovation', 'input', 'insight', 'integration', 'interface',
    'issue', 'iteration', 'journey', 'knowledge', 'language', 'layer', 'level',
    'limit', 'method', 'metric', 'model', 'module', 'network', 'object',
    'option', 'outcome', 'output', 'package', 'pattern', 'performance', 'pipeline',
    'platform', 'policy', 'potential', 'priority', 'problem', 'process', 'product',
    'progress', 'project', 'protocol', 'quality', 'query', 'range', 'record',
    'resource', 'result', 'review', 'risk', 'role', 'rule', 'scope',
    'service', 'session', 'setting', 'signal', 'solution', 'source', 'stage',
    'standard', 'status', 'strategy', 'structure', 'success', 'summary', 'support',
    'task', 'team', 'technology', 'template', 'threshold', 'timeline', 'token',
    'tool', 'transition', 'type', 'update', 'user', 'value', 'version', 'vision',
];

/** Common English verbs (infinitive form). */
const VERBS = [
    'achieve', 'adjust', 'adopt', 'advance', 'analyze', 'apply', 'approve',
    'arrange', 'assess', 'assist', 'build', 'calculate', 'capture', 'change',
    'choose', 'clarify', 'collaborate', 'communicate', 'complete', 'configure',
    'connect', 'consider', 'create', 'decide', 'define', 'deliver', 'design',
    'develop', 'discover', 'distribute', 'document', 'enable', 'establish',
    'evaluate', 'execute', 'explore', 'focus', 'generate', 'guide', 'identify',
    'implement', 'improve', 'increase', 'integrate', 'iterate', 'launch',
    'maintain', 'manage', 'measure', 'migrate', 'monitor', 'optimize', 'plan',
    'prioritize', 'produce', 'provide', 'publish', 'refactor', 'release',
    'resolve', 'review', 'scale', 'simplify', 'streamline', 'support', 'test',
    'transform', 'update', 'validate', 'verify',
];

module.exports = {
    LOREM_WORDS,
    HACKER_ADJECTIVES,
    HACKER_NOUNS,
    HACKER_VERBS,
    ADJECTIVES,
    NOUNS,
    VERBS,
};
