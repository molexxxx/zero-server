/**
 * Shared Content-Type matching utility for body parsers.
 *
 * @param {string}                        contentType  - The request Content-Type header value.
 * @param {string|string[]|function}      typeOpt      - MIME pattern to match against (e.g. 'application/json', 'text/*', '*​/*'),
 *                                                       an array of patterns, or a custom predicate `(ct) => boolean`.
 * @returns {boolean}
 */
function isTypeMatch(contentType, typeOpt)
{
    if (!typeOpt) return true;
    if (typeof typeOpt === 'function') return !!typeOpt(contentType);
    if (Array.isArray(typeOpt)) return typeOpt.some(t => isTypeMatch(contentType, t));
    if (!contentType) return false;
    if (typeOpt === '*/*') return true;
    // Strip charset/parameters from content-type for proper matching
    const semiIdx = contentType.indexOf(';');
    const baseType = semiIdx !== -1 ? contentType.substring(0, semiIdx).trim() : contentType;
    if (typeOpt.endsWith('/*'))
    {
        return baseType.startsWith(typeOpt.slice(0, -1));
    }
    // Suffix pattern: application/*+json matches application/vnd.api+json
    const starIdx = typeOpt.indexOf('/*+');
    if (starIdx !== -1)
    {
        const prefix = typeOpt.slice(0, starIdx + 1); // 'application/'
        const suffix = typeOpt.slice(starIdx + 2);     // '+json'
        return baseType.startsWith(prefix) && baseType.endsWith(suffix);
    }
    // Exact or substring match against the base type only
    return baseType.indexOf(typeOpt) !== -1;
}

module.exports = isTypeMatch;
