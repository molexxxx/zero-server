/**
 * Shared Content-Type matching utility for body parsers.
 *
 * @param {string}            contentType  - The request Content-Type header value.
 * @param {string|function}   typeOpt      - MIME pattern to match against (e.g. 'application/json', 'text/*', '*​/*')
 *                                           or a custom predicate `(ct) => boolean`.
 * @returns {boolean}
 */
function isTypeMatch(contentType, typeOpt)
{
    if (!typeOpt) return true;
    if (typeof typeOpt === 'function') return !!typeOpt(contentType);
    if (!contentType) return false;
    if (typeOpt === '*/*') return true;
    // Strip charset/parameters from content-type for proper matching
    const semiIdx = contentType.indexOf(';');
    const baseType = semiIdx !== -1 ? contentType.substring(0, semiIdx).trim() : contentType;
    if (typeOpt.endsWith('/*'))
    {
        return baseType.startsWith(typeOpt.slice(0, -1));
    }
    // Exact or substring match against the base type only
    return baseType.indexOf(typeOpt) !== -1;
}

module.exports = isTypeMatch;
