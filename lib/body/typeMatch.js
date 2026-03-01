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
    if (typeOpt.endsWith('/*'))
    {
        return contentType.startsWith(typeOpt.slice(0, -1));
    }
    return contentType.indexOf(typeOpt) !== -1;
}

module.exports = isTypeMatch;
