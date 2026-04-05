/**
 * @module grpc/status
 * @description Standard gRPC status codes (as defined by the gRPC specification).
 *              Each code has a numeric value, a name, and a human-readable description.
 *              Used by both server and client to communicate call outcomes via trailers.
 *
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */

const log = require('../debug')('zero:grpc');

// -- Status Codes ------------------------------------------

/**
 * gRPC status code enum. Mirrors the canonical codes from the gRPC spec.
 *
 * @enum {number}
 *
 * @example
 *   const { GrpcStatus } = require('zero-http');
 *   call.sendError(GrpcStatus.NOT_FOUND, 'User not found');
 */
const GrpcStatus = {
    /** The operation completed successfully. */
    OK: 0,
    /** The operation was cancelled (typically by the caller). */
    CANCELLED: 1,
    /** Unknown error — a catch-all for unexpected failures. */
    UNKNOWN: 2,
    /** The client specified an invalid argument. */
    INVALID_ARGUMENT: 3,
    /** The deadline expired before the operation could complete. */
    DEADLINE_EXCEEDED: 4,
    /** The requested entity was not found. */
    NOT_FOUND: 5,
    /** The entity that a client attempted to create already exists. */
    ALREADY_EXISTS: 6,
    /** The caller does not have permission to execute the operation. */
    PERMISSION_DENIED: 7,
    /** Some resource has been exhausted (e.g. quota, disk space). */
    RESOURCE_EXHAUSTED: 8,
    /** The operation was rejected because the system is not in a required state. */
    FAILED_PRECONDITION: 9,
    /** The operation was aborted, typically due to a concurrency conflict. */
    ABORTED: 10,
    /** The operation was attempted past the valid range. */
    OUT_OF_RANGE: 11,
    /** The operation is not implemented or not supported. */
    UNIMPLEMENTED: 12,
    /** Internal error — invariants expected by the server have been broken. */
    INTERNAL: 13,
    /** The service is currently unavailable, usually a transient condition. */
    UNAVAILABLE: 14,
    /** Unrecoverable data loss or corruption. */
    DATA_LOSS: 15,
    /** The request does not have valid authentication credentials. */
    UNAUTHENTICATED: 16,
};

/**
 * Reverse lookup: number → string name.
 * @type {Object<number, string>}
 */
const STATUS_NAMES = {};
for (const [name, code] of Object.entries(GrpcStatus))
{
    STATUS_NAMES[code] = name;
}

/**
 * Map gRPC status code to the appropriate HTTP/2 status code for trailers-only responses.
 *
 * @param {number} grpcCode - gRPC status code.
 * @returns {number} Corresponding HTTP status code.
 */
function grpcToHttp(grpcCode)
{
    switch (grpcCode)
    {
        case GrpcStatus.OK: return 200;
        case GrpcStatus.INVALID_ARGUMENT: return 400;
        case GrpcStatus.FAILED_PRECONDITION: return 400;
        case GrpcStatus.OUT_OF_RANGE: return 400;
        case GrpcStatus.UNAUTHENTICATED: return 401;
        case GrpcStatus.PERMISSION_DENIED: return 403;
        case GrpcStatus.NOT_FOUND: return 404;
        case GrpcStatus.ALREADY_EXISTS: return 409;
        case GrpcStatus.ABORTED: return 409;
        case GrpcStatus.RESOURCE_EXHAUSTED: return 429;
        case GrpcStatus.CANCELLED: return 499;
        case GrpcStatus.UNIMPLEMENTED: return 501;
        case GrpcStatus.UNAVAILABLE: return 503;
        case GrpcStatus.DEADLINE_EXCEEDED: return 504;
        case GrpcStatus.UNKNOWN:
        case GrpcStatus.INTERNAL:
        case GrpcStatus.DATA_LOSS:
        default:
            return 500;
    }
}

/**
 * Get the human-readable name for a gRPC status code.
 *
 * @param {number} code - gRPC status code.
 * @returns {string} Status name or 'UNKNOWN'.
 */
function statusName(code)
{
    return STATUS_NAMES[code] || 'UNKNOWN';
}

module.exports = {
    GrpcStatus,
    STATUS_NAMES,
    grpcToHttp,
    statusName,
};
