/**
 * @module grpc/frame
 * @description gRPC length-prefixed message framing over HTTP/2.
 *              Each gRPC message on the wire has a 5-byte header:
 *              - Byte 0:   Compression flag (0 = uncompressed, 1 = compressed)
 *              - Bytes 1-4: Message length as 32-bit big-endian unsigned integer
 *              Followed by the protobuf-encoded message body.
 *
 *              Also handles optional gzip compression/decompression.
 *
 * @see https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
 */

const zlib = require('zlib');
const log = require('../debug')('zero:grpc');

// -- Constants ---------------------------------------------

/**
 * Size of the gRPC frame header in bytes.
 * @type {number}
 */
const FRAME_HEADER_SIZE = 5;

/**
 * Maximum frame size (16 MB — matches the default gRPC max).
 * @type {number}
 */
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

/**
 * Compression flag values.
 * @enum {number}
 */
const COMPRESS_FLAG = {
    NONE: 0,
    GZIP: 1,
};

// -- Frame Encoder -----------------------------------------

/**
 * Encode a protobuf message buffer into a gRPC framed message.
 *
 * @param {Buffer} message - Protobuf-encoded message data.
 * @param {object} [opts] - Framing options.
 * @param {boolean} [opts.compress=false] - Whether to gzip-compress the message.
 * @returns {Promise<Buffer>|Buffer} Framed message (async if compressing).
 *
 * @example
 *   const frame = frameEncode(protobufBytes);
 *   stream.write(frame);
 *
 * @example | With compression
 *   const frame = await frameEncode(protobufBytes, { compress: true });
 */
function frameEncode(message, opts = {})
{
    if (!Buffer.isBuffer(message))
        message = Buffer.from(message || []);

    if (opts.compress)
    {
        return new Promise((resolve, reject) =>
        {
            zlib.gzip(message, (err, compressed) =>
            {
                if (err) return reject(err);
                resolve(_buildFrame(compressed, COMPRESS_FLAG.GZIP));
            });
        });
    }

    return _buildFrame(message, COMPRESS_FLAG.NONE);
}

/**
 * Build the 5-byte header + payload buffer.
 * @private
 * @param {Buffer} payload
 * @param {number} flag
 * @returns {Buffer}
 */
function _buildFrame(payload, flag)
{
    const header = Buffer.alloc(FRAME_HEADER_SIZE);
    header[0] = flag;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

// -- Frame Decoder -----------------------------------------

/**
 * Stateful gRPC frame parser — buffers incoming data and emits complete
 * decompressed messages.  Designed to be fed chunks from an HTTP/2 stream.
 *
 * @class
 *
 * @param {object} [opts] - Parser options.
 * @param {number} [opts.maxMessageSize=16777216] - Maximum allowed message size in bytes.
 * @param {boolean} [opts.allowCompressed=true] - Whether to accept compressed frames.
 *
 * @example
 *   const parser = new FrameParser();
 *   parser.onMessage = (buf) => { /* fully deframed protobuf bytes *​/ };
 *   stream.on('data', (chunk) => parser.push(chunk));
 */
class FrameParser
{
    /**
     * @constructor
     * @param {object} [opts] - Parser options.
     * @param {number} [opts.maxMessageSize=16777216] - Max message size.
     * @param {boolean} [opts.allowCompressed=true] - Accept gzip frames.
     */
    constructor(opts = {})
    {
        /** @private */
        this._buffer = Buffer.alloc(0);
        /** @private */
        this._maxMessageSize = opts.maxMessageSize || MAX_FRAME_SIZE;
        /** @private */
        this._allowCompressed = opts.allowCompressed !== false;
        /** @private */
        this._destroyed = false;

        /**
         * Callback invoked with each complete deframed message buffer.
         * @type {Function|null}
         */
        this.onMessage = null;

        /**
         * Callback invoked on parse errors.
         * @type {Function|null}
         */
        this.onError = null;
    }

    /**
     * Feed a data chunk to the parser. May trigger zero or more `onMessage` callbacks.
     *
     * @param {Buffer} chunk - Raw bytes from the HTTP/2 stream.
     */
    push(chunk)
    {
        if (this._destroyed) return;

        this._buffer = this._buffer.length > 0
            ? Buffer.concat([this._buffer, chunk])
            : chunk;

        this._drain();
    }

    /**
     * Process buffered data, extracting complete frames.
     * @private
     */
    _drain()
    {
        while (this._buffer.length >= FRAME_HEADER_SIZE)
        {
            const compressed = this._buffer[0];
            const msgLen = this._buffer.readUInt32BE(1);

            // Security: reject oversized messages before buffering
            if (msgLen > this._maxMessageSize)
            {
                const err = new Error(`gRPC message size ${msgLen} exceeds limit ${this._maxMessageSize}`);
                err.code = 'RESOURCE_EXHAUSTED';
                this._emitError(err);
                this._destroyed = true;
                return;
            }

            const totalLen = FRAME_HEADER_SIZE + msgLen;
            if (this._buffer.length < totalLen)
            {
                // Wait for more data
                return;
            }

            const payload = this._buffer.subarray(FRAME_HEADER_SIZE, totalLen);
            this._buffer = this._buffer.subarray(totalLen);

            if (compressed && !this._allowCompressed)
            {
                const err = new Error('Compressed message received but compression is disabled');
                err.code = 'UNIMPLEMENTED';
                this._emitError(err);
                continue;
            }

            if (compressed)
            {
                // Async decompress
                zlib.gunzip(payload, (err, decompressed) =>
                {
                    if (err)
                    {
                        err.code = 'INTERNAL';
                        this._emitError(err);
                        return;
                    }
                    this._emitMessage(decompressed);
                });
            }
            else
            {
                this._emitMessage(Buffer.from(payload));
            }
        }
    }

    /**
     * Emit a parsed message.
     * @private
     */
    _emitMessage(buf)
    {
        if (this._destroyed) return;
        if (this.onMessage) this.onMessage(buf);
    }

    /**
     * Emit a parse error.
     * @private
     */
    _emitError(err)
    {
        log.error('frame parse error: %s', err.message);
        if (this.onError) this.onError(err);
    }

    /**
     * Reset the parser state, discarding any buffered data.
     */
    reset()
    {
        this._buffer = Buffer.alloc(0);
        this._destroyed = false;
    }

    /**
     * Destroy the parser, preventing further processing.
     */
    destroy()
    {
        this._destroyed = true;
        this._buffer = Buffer.alloc(0);
    }
}

module.exports = {
    FRAME_HEADER_SIZE,
    MAX_FRAME_SIZE,
    COMPRESS_FLAG,
    frameEncode,
    FrameParser,
};
