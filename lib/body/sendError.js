/**
 * @module body/sendError
 * @private
 * @description Shared helper for sending HTTP error responses from body parsers.
 *              Centralizes the pattern used across all parsers so changes only happen in one place.
 */

/**
 * Send an HTTP error response.
 *
 * @private
 * @param {object} res    - The response wrapper (or raw response).
 * @param {number} status - HTTP status code.
 * @param {string} message - Error message string for the JSON body.
 */
function sendError(res, status, message)
{
    const raw = res.raw || res;
    if (raw.headersSent) return;
    raw.statusCode = status;
    raw.setHeader('Content-Type', 'application/json');
    raw.end(JSON.stringify({ error: message }));
}

module.exports = sendError;
