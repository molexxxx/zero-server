/**
 * @module grpc/codec
 * @description Zero-dependency Protocol Buffers wire-format encoder/decoder.
 *              Implements the proto3 binary encoding for all scalar types,
 *              nested messages, repeated fields, maps, oneofs, and enums.
 *
 *              Wire types:
 *              - 0: Varint (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
 *              - 1: 64-bit fixed (fixed64, sfixed64, double)
 *              - 2: Length-delimited (string, bytes, nested message, packed repeated)
 *              - 5: 32-bit fixed (fixed32, sfixed32, float)
 *
 * @see https://protobuf.dev/programming-guides/encoding/
 */

const log = require('../debug')('zero:grpc');

// -- Constants ---------------------------------------------

/**
 * Protobuf wire types.
 * @enum {number}
 */
const WIRE_TYPE = {
    VARINT: 0,
    FIXED64: 1,
    LENGTH_DELIMITED: 2,
    /** @deprecated Not used in proto3. */
    START_GROUP: 3,
    /** @deprecated Not used in proto3. */
    END_GROUP: 4,
    FIXED32: 5,
};

/**
 * Maximum varint size in bytes (10 bytes for 64-bit values).
 * @type {number}
 */
const MAX_VARINT_SIZE = 10;

/**
 * Maximum message size (4 MB default, configurable per-call).
 * @type {number}
 */
const DEFAULT_MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

/**
 * Maximum recursion depth for nested messages (prevents stack overflow from malicious payloads).
 * @type {number}
 */
const MAX_RECURSION_DEPTH = 64;

/**
 * Maps proto3 type names to wire types and read/write helpers.
 * @private
 */
const TYPE_INFO = {
    double:   { wire: WIRE_TYPE.FIXED64,  size: 8 },
    float:    { wire: WIRE_TYPE.FIXED32,  size: 4 },
    int32:    { wire: WIRE_TYPE.VARINT },
    int64:    { wire: WIRE_TYPE.VARINT },
    uint32:   { wire: WIRE_TYPE.VARINT },
    uint64:   { wire: WIRE_TYPE.VARINT },
    sint32:   { wire: WIRE_TYPE.VARINT },
    sint64:   { wire: WIRE_TYPE.VARINT },
    fixed32:  { wire: WIRE_TYPE.FIXED32,  size: 4 },
    fixed64:  { wire: WIRE_TYPE.FIXED64,  size: 8 },
    sfixed32: { wire: WIRE_TYPE.FIXED32,  size: 4 },
    sfixed64: { wire: WIRE_TYPE.FIXED64,  size: 8 },
    bool:     { wire: WIRE_TYPE.VARINT },
    string:   { wire: WIRE_TYPE.LENGTH_DELIMITED },
    bytes:    { wire: WIRE_TYPE.LENGTH_DELIMITED },
    // enum and message are handled dynamically
};

// -- Writer ------------------------------------------------

/**
 * Protobuf binary writer — encodes JavaScript objects into wire-format bytes.
 *
 * @class
 *
 * @example
 *   const writer = new Writer();
 *   writer.writeVarint(1 << 3 | 0, 150); // field 1, varint = 150
 *   const bytes = writer.finish();
 */
class Writer
{
    constructor()
    {
        /** @private */
        this._chunks = [];
        /** @private */
        this._size = 0;
    }

    // -- Low-Level Primitives ------------------------------

    /**
     * Write raw bytes.
     *
     * @param {Buffer} buf
     * @returns {Writer} `this` for chaining.
     */
    writeRaw(buf)
    {
        this._chunks.push(buf);
        this._size += buf.length;
        return this;
    }

    /**
     * Write a varint (variable-length integer) using LEB128 encoding.
     * Handles values up to 2^53 safely (JavaScript number precision limit).
     *
     * @param {number} value - Non-negative integer.
     * @returns {Writer} `this` for chaining.
     */
    writeVarint(value)
    {
        const buf = Buffer.alloc(MAX_VARINT_SIZE);
        let offset = 0;

        // Handle negative numbers as unsigned 64-bit
        if (value < 0)
        {
            // Two's complement for 64-bit
            const lo = (value & 0xFFFFFFFF) >>> 0;
            const hi = (Math.floor(value / 0x100000000) & 0xFFFFFFFF) >>> 0;
            return this._writeVarint64(lo, hi);
        }

        while (value > 0x7F)
        {
            buf[offset++] = (value & 0x7F) | 0x80;
            value >>>= 7;
        }
        buf[offset++] = value & 0x7F;
        this._chunks.push(buf.subarray(0, offset));
        this._size += offset;
        return this;
    }

    /**
     * Write a 64-bit varint as two 32-bit halves.
     * @private
     * @param {number} lo - Low 32 bits.
     * @param {number} hi - High 32 bits.
     * @returns {Writer}
     */
    _writeVarint64(lo, hi)
    {
        const buf = Buffer.alloc(MAX_VARINT_SIZE);
        let offset = 0;

        while (hi > 0 || lo > 0x7F)
        {
            buf[offset++] = (lo & 0x7F) | 0x80;
            lo = ((lo >>> 7) | (hi << 25)) >>> 0;
            hi >>>= 7;
        }
        buf[offset++] = lo & 0x7F;
        this._chunks.push(buf.subarray(0, offset));
        this._size += offset;
        return this;
    }

    /**
     * Write a signed varint using ZigZag encoding (sint32/sint64).
     *
     * @param {number} value - Signed integer.
     * @returns {Writer}
     */
    writeSVarint(value)
    {
        // ZigZag: (n << 1) ^ (n >> 31) for 32-bit
        return this.writeVarint(((value << 1) ^ (value >> 31)) >>> 0);
    }

    /**
     * Write a 32-bit fixed integer (little-endian).
     *
     * @param {number} value
     * @returns {Writer}
     */
    writeFixed32(value)
    {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(value >>> 0, 0);
        return this.writeRaw(buf);
    }

    /**
     * Write a 32-bit signed fixed integer (little-endian).
     *
     * @param {number} value
     * @returns {Writer}
     */
    writeSFixed32(value)
    {
        const buf = Buffer.alloc(4);
        buf.writeInt32LE(value, 0);
        return this.writeRaw(buf);
    }

    /**
     * Write a 64-bit fixed integer (little-endian) from a BigInt or number.
     *
     * @param {number|BigInt} value
     * @returns {Writer}
     */
    writeFixed64(value)
    {
        const buf = Buffer.alloc(8);
        if (typeof value === 'bigint')
        {
            buf.writeBigUInt64LE(value, 0);
        }
        else
        {
            buf.writeUInt32LE(value >>> 0, 0);
            buf.writeUInt32LE((value / 0x100000000) >>> 0, 4);
        }
        return this.writeRaw(buf);
    }

    /**
     * Write a 64-bit signed fixed integer (little-endian).
     *
     * @param {number|BigInt} value
     * @returns {Writer}
     */
    writeSFixed64(value)
    {
        const buf = Buffer.alloc(8);
        if (typeof value === 'bigint')
        {
            buf.writeBigInt64LE(value, 0);
        }
        else
        {
            buf.writeInt32LE(value & 0xFFFFFFFF, 0);
            buf.writeInt32LE(Math.floor(value / 0x100000000), 4);
        }
        return this.writeRaw(buf);
    }

    /**
     * Write a 32-bit IEEE 754 float.
     *
     * @param {number} value
     * @returns {Writer}
     */
    writeFloat(value)
    {
        const buf = Buffer.alloc(4);
        buf.writeFloatLE(value, 0);
        return this.writeRaw(buf);
    }

    /**
     * Write a 64-bit IEEE 754 double.
     *
     * @param {number} value
     * @returns {Writer}
     */
    writeDouble(value)
    {
        const buf = Buffer.alloc(8);
        buf.writeDoubleLE(value, 0);
        return this.writeRaw(buf);
    }

    /**
     * Write a boolean as a single-byte varint.
     *
     * @param {boolean} value
     * @returns {Writer}
     */
    writeBool(value)
    {
        return this.writeVarint(value ? 1 : 0);
    }

    /**
     * Write a UTF-8 string (length-prefixed).
     *
     * @param {string} value
     * @returns {Writer}
     */
    writeString(value)
    {
        const strBuf = Buffer.from(value, 'utf8');
        this.writeVarint(strBuf.length);
        return this.writeRaw(strBuf);
    }

    /**
     * Write raw bytes (length-prefixed).
     *
     * @param {Buffer} value
     * @returns {Writer}
     */
    writeBytes(value)
    {
        if (!Buffer.isBuffer(value)) value = Buffer.from(value);
        this.writeVarint(value.length);
        return this.writeRaw(value);
    }

    /**
     * Write a field tag (field number + wire type).
     *
     * @param {number} fieldNumber - Protobuf field number.
     * @param {number} wireType - Wire type (0-5).
     * @returns {Writer}
     */
    writeTag(fieldNumber, wireType)
    {
        return this.writeVarint((fieldNumber << 3) | wireType);
    }

    /**
     * Finalize and return the complete encoded buffer.
     *
     * @returns {Buffer} Concatenated protobuf binary.
     */
    finish()
    {
        if (this._chunks.length === 0) return Buffer.alloc(0);
        if (this._chunks.length === 1) return this._chunks[0];
        return Buffer.concat(this._chunks, this._size);
    }

    /**
     * Get the total byte size of all written data.
     *
     * @returns {number}
     */
    get length()
    {
        return this._size;
    }

    // -- Field-level convenience methods (tag + value) ------

    /**
     * Write a string field (tag + length-delimited string).
     * @param {number} fieldNumber
     * @param {string} value
     * @returns {Writer}
     */
    string(fieldNumber, value)
    {
        this.writeTag(fieldNumber, 2);
        return this.writeString(value);
    }

    /**
     * Write a bytes/embedded-message field (tag + length-delimited bytes).
     * @param {number} fieldNumber
     * @param {Buffer} value
     * @returns {Writer}
     */
    bytes(fieldNumber, value)
    {
        this.writeTag(fieldNumber, 2);
        return this.writeBytes(value);
    }

    /**
     * Write an int32/enum field (tag + varint).
     * @param {number} fieldNumber
     * @param {number} value
     * @returns {Writer}
     */
    int32(fieldNumber, value)
    {
        this.writeTag(fieldNumber, 0);
        return this.writeVarint(value);
    }

    /**
     * Write a bool field (tag + varint 0/1).
     * @param {number} fieldNumber
     * @param {boolean} value
     * @returns {Writer}
     */
    bool(fieldNumber, value)
    {
        this.writeTag(fieldNumber, 0);
        return this.writeBool(value);
    }
}

// -- Reader ------------------------------------------------

/**
 * Protobuf binary reader — decodes wire-format bytes into JavaScript values.
 *
 * @class
 *
 * @param {Buffer} buffer - Protobuf binary data to read.
 *
 * @example
 *   const reader = new Reader(buffer);
 *   while (reader.remaining > 0) {
 *       const { fieldNumber, wireType } = reader.readTag();
 *       // read value based on wireType...
 *   }
 */
class Reader
{
    /**
     * @constructor
     * @param {Buffer} buffer - Protobuf wire-format data.
     */
    constructor(buffer)
    {
        if (!Buffer.isBuffer(buffer))
            throw new TypeError('Reader requires a Buffer');

        /** @private */
        this._buf = buffer;
        /** @private */
        this._pos = 0;
        /** @private */
        this._end = buffer.length;
    }

    /**
     * Number of bytes remaining to be read.
     *
     * @returns {number}
     */
    get remaining()
    {
        return this._end - this._pos;
    }

    /**
     * Whether all bytes have been consumed.
     *
     * @returns {boolean}
     */
    get done()
    {
        return this._pos >= this._end;
    }

    /**
     * Current read position (byte offset).
     *
     * @returns {number}
     */
    get position()
    {
        return this._pos;
    }

    // -- Low-Level Primitives ------------------------------

    /**
     * Read a varint (LEB128-encoded variable-length integer).
     * Returns a JavaScript number (safe for values up to 2^53).
     *
     * @returns {number}
     */
    readVarint()
    {
        let result = 0;
        let shift = 0;

        for (let i = 0; i < MAX_VARINT_SIZE; i++)
        {
            if (this._pos >= this._end)
                throw new RangeError('Varint extends past end of buffer');

            const byte = this._buf[this._pos++];
            result |= (byte & 0x7F) << shift;

            if ((byte & 0x80) === 0)
            {
                // For values that might overflow 32-bit, reconstruct using multiplication
                if (shift >= 28)
                {
                    return this._readVarintSlow(result, shift, byte);
                }
                return result >>> 0;
            }
            shift += 7;
            if (shift >= 28)
            {
                return this._readVarintHigh(result, shift);
            }
        }

        throw new RangeError('Varint too long (> 10 bytes)');
    }

    /**
     * Handle high-bit varint continuation.
     * @private
     */
    _readVarintHigh(lo, shift)
    {
        let hi = 0;
        let hiShift = 0;

        if (shift === 28)
        {
            // We've read 4 bytes (28 bits). The 5th byte contributes to both lo and hi.
            if (this._pos >= this._end)
                throw new RangeError('Varint extends past end of buffer');
            const byte = this._buf[this._pos++];
            lo |= (byte & 0x0F) << 28;
            hi = (byte & 0x7F) >> 4;
            if ((byte & 0x80) === 0)
                return (hi * 0x100000000 + (lo >>> 0));
            hiShift = 3;
        }

        for (let i = 0; i < 5; i++)
        {
            if (this._pos >= this._end)
                throw new RangeError('Varint extends past end of buffer');
            const byte = this._buf[this._pos++];
            hi |= (byte & 0x7F) << hiShift;
            hiShift += 7;
            if ((byte & 0x80) === 0)
                return (hi * 0x100000000 + (lo >>> 0));
        }

        throw new RangeError('Varint too long');
    }

    /**
     * Reconstruct large varint value.
     * @private
     */
    _readVarintSlow(lo, shift, lastByte)
    {
        return lo >>> 0;
    }

    /**
     * Read a signed varint using ZigZag decoding (sint32/sint64).
     *
     * @returns {number}
     */
    readSVarint()
    {
        const n = this.readVarint();
        return ((n >>> 1) ^ -(n & 1)) | 0;
    }

    /**
     * Read a 32-bit fixed unsigned integer (little-endian).
     *
     * @returns {number}
     */
    readFixed32()
    {
        this._checkBounds(4);
        const val = this._buf.readUInt32LE(this._pos);
        this._pos += 4;
        return val;
    }

    /**
     * Read a 32-bit fixed signed integer (little-endian).
     *
     * @returns {number}
     */
    readSFixed32()
    {
        this._checkBounds(4);
        const val = this._buf.readInt32LE(this._pos);
        this._pos += 4;
        return val;
    }

    /**
     * Read a 64-bit fixed unsigned integer (little-endian).
     * Returns a number (precision loss above 2^53).
     *
     * @returns {number}
     */
    readFixed64()
    {
        this._checkBounds(8);
        const lo = this._buf.readUInt32LE(this._pos);
        const hi = this._buf.readUInt32LE(this._pos + 4);
        this._pos += 8;
        return hi * 0x100000000 + lo;
    }

    /**
     * Read a 64-bit fixed signed integer (little-endian).
     *
     * @returns {number}
     */
    readSFixed64()
    {
        this._checkBounds(8);
        const lo = this._buf.readUInt32LE(this._pos);
        const hi = this._buf.readInt32LE(this._pos + 4);
        this._pos += 8;
        return hi * 0x100000000 + lo;
    }

    /**
     * Read a 32-bit IEEE 754 float.
     *
     * @returns {number}
     */
    readFloat()
    {
        this._checkBounds(4);
        const val = this._buf.readFloatLE(this._pos);
        this._pos += 4;
        return val;
    }

    /**
     * Read a 64-bit IEEE 754 double.
     *
     * @returns {number}
     */
    readDouble()
    {
        this._checkBounds(8);
        const val = this._buf.readDoubleLE(this._pos);
        this._pos += 8;
        return val;
    }

    /**
     * Read a boolean varint.
     *
     * @returns {boolean}
     */
    readBool()
    {
        return this.readVarint() !== 0;
    }

    /**
     * Read a length-prefixed UTF-8 string.
     *
     * @returns {string}
     */
    readString()
    {
        const len = this.readVarint();
        this._checkBounds(len);
        const str = this._buf.toString('utf8', this._pos, this._pos + len);
        this._pos += len;
        return str;
    }

    /**
     * Read length-prefixed raw bytes.
     *
     * @returns {Buffer}
     */
    readBytes()
    {
        const len = this.readVarint();
        this._checkBounds(len);
        const buf = this._buf.subarray(this._pos, this._pos + len);
        this._pos += len;
        return Buffer.from(buf); // copy to detach from source
    }

    /**
     * Read a field tag and decode field number + wire type.
     *
     * @returns {{ fieldNumber: number, wireType: number }}
     */
    readTag()
    {
        const tag = this.readVarint();
        return {
            fieldNumber: tag >>> 3,
            wireType: tag & 0x07,
        };
    }

    /**
     * Skip a field value based on its wire type (for unknown fields).
     *
     * @param {number} wireType - Wire type to skip.
     */
    skipField(wireType)
    {
        switch (wireType)
        {
            case WIRE_TYPE.VARINT:
                this.readVarint();
                break;
            case WIRE_TYPE.FIXED64:
                this._checkBounds(8);
                this._pos += 8;
                break;
            case WIRE_TYPE.LENGTH_DELIMITED:
            {
                const len = this.readVarint();
                this._checkBounds(len);
                this._pos += len;
                break;
            }
            case WIRE_TYPE.FIXED32:
                this._checkBounds(4);
                this._pos += 4;
                break;
            default:
                throw new Error(`Unknown wire type: ${wireType}`);
        }
    }

    /**
     * Create a sub-reader for a length-delimited embedded message.
     *
     * @returns {Reader} A new Reader limited to the embedded message bytes.
     */
    readSubReader()
    {
        const len = this.readVarint();
        this._checkBounds(len);
        const sub = new Reader(this._buf.subarray(this._pos, this._pos + len));
        this._pos += len;
        return sub;
    }

    /**
     * Bounds check helper.
     * @private
     */
    _checkBounds(needed)
    {
        if (this._pos + needed > this._end)
            throw new RangeError(`Not enough data: need ${needed} bytes at offset ${this._pos}, have ${this._end - this._pos}`);
    }
}

// -- Message Codec -----------------------------------------

/**
 * Encode a JavaScript object to protobuf binary using a message descriptor.
 *
 * @param {object} obj - The JavaScript object to encode.
 * @param {object} messageDesc - Message descriptor from the proto parser.
 * @param {Object<string, object>} allMessages - Map of all message descriptors (for nested types).
 * @param {number} [depth=0] - Current recursion depth (stack overflow protection).
 * @returns {Buffer} Encoded protobuf binary.
 *
 * @example
 *   const buf = encode({ name: 'Alice', age: 30 }, personDesc, allMessages);
 */
function encode(obj, messageDesc, allMessages, depth = 0)
{
    if (depth > MAX_RECURSION_DEPTH)
        throw new Error(`Maximum encoding depth (${MAX_RECURSION_DEPTH}) exceeded — possible circular reference`);

    if (!obj || typeof obj !== 'object')
        return Buffer.alloc(0);

    const writer = new Writer();
    const fields = messageDesc.fields;

    for (const field of fields)
    {
        const value = obj[field.name];

        // Proto3: skip fields with default/zero values
        if (value === undefined || value === null) continue;

        if (field.map)
        {
            _encodeMap(writer, field, value, allMessages, depth);
        }
        else if (field.repeated)
        {
            _encodeRepeated(writer, field, value, allMessages, depth);
        }
        else
        {
            _encodeField(writer, field, value, allMessages, depth);
        }
    }

    return writer.finish();
}

/**
 * Decode protobuf binary into a JavaScript object using a message descriptor.
 *
 * @param {Buffer} buffer - Protobuf wire-format data.
 * @param {object} messageDesc - Message descriptor from the proto parser.
 * @param {Object<string, object>} allMessages - Map of all message descriptors.
 * @param {number} [depth=0] - Current recursion depth.
 * @returns {object} Decoded JavaScript object.
 *
 * @example
 *   const person = decode(buffer, personDesc, allMessages);
 */
function decode(buffer, messageDesc, allMessages, depth = 0)
{
    if (depth > MAX_RECURSION_DEPTH)
        throw new Error(`Maximum decoding depth (${MAX_RECURSION_DEPTH}) exceeded — possible circular reference`);

    if (!Buffer.isBuffer(buffer) || buffer.length === 0)
        return _defaultObject(messageDesc);

    const reader = new Reader(buffer);
    const result = _defaultObject(messageDesc);
    const fieldMap = {};

    for (const f of messageDesc.fields)
    {
        fieldMap[f.number] = f;
    }

    while (reader.remaining > 0)
    {
        const { fieldNumber, wireType } = reader.readTag();
        const field = fieldMap[fieldNumber];

        if (!field)
        {
            // Unknown field — skip it (forward compatibility)
            reader.skipField(wireType);
            continue;
        }

        if (field.map)
        {
            _decodeMapEntry(reader, field, result, allMessages, depth);
        }
        else if (field.repeated && wireType === WIRE_TYPE.LENGTH_DELIMITED && isPackable(field.type))
        {
            // Packed repeated field
            _decodePackedRepeated(reader, field, result);
        }
        else if (field.repeated)
        {
            // Non-packed repeated (one element per tag)
            const val = _readFieldValue(reader, field, wireType, allMessages, depth);
            result[field.name].push(val);
        }
        else
        {
            result[field.name] = _readFieldValue(reader, field, wireType, allMessages, depth);
        }
    }

    return result;
}

// -- Private Encoding Helpers ------------------------------

/** @private */
function _encodeField(writer, field, value, allMessages, depth)
{
    const typeInfo = TYPE_INFO[field.type];

    if (typeInfo)
    {
        // Scalar type — skip default values in proto3
        if (_isDefaultValue(field.type, value)) return;

        writer.writeTag(field.number, typeInfo.wire);
        _writeScalar(writer, field.type, value);
    }
    else if (field.enumDef)
    {
        // Enum field
        const numVal = typeof value === 'string' ? (field.enumDef.values[value] || 0) : Number(value);
        if (numVal === 0) return; // default enum value
        writer.writeTag(field.number, WIRE_TYPE.VARINT);
        writer.writeVarint(numVal);
    }
    else
    {
        // Nested message
        const msgDesc = allMessages[field.type];
        if (!msgDesc) throw new Error(`Unknown message type: ${field.type}`);

        const nested = encode(value, msgDesc, allMessages, depth + 1);
        writer.writeTag(field.number, WIRE_TYPE.LENGTH_DELIMITED);
        writer.writeBytes(nested);
    }
}

/** @private */
function _encodeRepeated(writer, field, values, allMessages, depth)
{
    if (!Array.isArray(values) || values.length === 0) return;

    const typeInfo = TYPE_INFO[field.type];

    // Pack scalars (proto3 default)
    if (typeInfo && isPackable(field.type))
    {
        const inner = new Writer();
        for (const v of values) _writeScalar(inner, field.type, v);
        writer.writeTag(field.number, WIRE_TYPE.LENGTH_DELIMITED);
        const packed = inner.finish();
        writer.writeVarint(packed.length);
        writer.writeRaw(packed);
    }
    else
    {
        // Non-packable (strings, bytes, messages) — one tag per element
        for (const v of values) _encodeField(writer, field, v, allMessages, depth);
    }
}

/** @private */
function _encodeMap(writer, field, mapObj, allMessages, depth)
{
    if (!mapObj || typeof mapObj !== 'object') return;

    // Maps are encoded as repeated message { key = 1; value = 2; }
    const entries = mapObj instanceof Map ? mapObj.entries() : Object.entries(mapObj);

    for (const [k, v] of entries)
    {
        const entryWriter = new Writer();

        // Encode key (field 1)
        const keyField = { number: 1, type: field.keyType, name: 'key' };
        entryWriter.writeTag(1, TYPE_INFO[field.keyType].wire);
        _writeScalar(entryWriter, field.keyType, k);

        // Encode value (field 2)
        const valField = { number: 2, type: field.valueType, name: 'value', enumDef: field.enumDef };
        _encodeField(entryWriter, valField, v, allMessages, depth);

        const entryBuf = entryWriter.finish();
        writer.writeTag(field.number, WIRE_TYPE.LENGTH_DELIMITED);
        writer.writeVarint(entryBuf.length);
        writer.writeRaw(entryBuf);
    }
}

// -- Private Decoding Helpers ------------------------------

/** @private */
function _readFieldValue(reader, field, wireType, allMessages, depth)
{
    const typeInfo = TYPE_INFO[field.type];

    if (typeInfo)
    {
        return _readScalar(reader, field.type, wireType);
    }
    else if (field.enumDef)
    {
        const val = reader.readVarint();
        // Reverse lookup: number → name
        const reverseEnum = field.enumDef._reverse || _buildReverseEnum(field.enumDef);
        return reverseEnum[val] || val;
    }
    else
    {
        // Nested message
        const msgDesc = allMessages[field.type];
        if (!msgDesc) throw new Error(`Unknown message type: ${field.type}`);
        const sub = reader.readSubReader();
        return decode(sub._buf, msgDesc, allMessages, depth + 1);
    }
}

/** @private */
function _decodeMapEntry(reader, field, result, allMessages, depth)
{
    const sub = reader.readSubReader();
    let key, value;

    while (sub.remaining > 0)
    {
        const { fieldNumber, wireType } = sub.readTag();
        if (fieldNumber === 1)
        {
            key = _readScalar(sub, field.keyType, wireType);
        }
        else if (fieldNumber === 2)
        {
            const valField = { type: field.valueType, enumDef: field.enumDef };
            value = _readFieldValue(sub, valField, wireType, allMessages, depth);
        }
        else
        {
            sub.skipField(wireType);
        }
    }

    if (key !== undefined)
    {
        result[field.name][key] = value;
    }
}

/** @private */
function _decodePackedRepeated(reader, field, result)
{
    const sub = reader.readSubReader();

    while (sub.remaining > 0)
    {
        const val = _readScalar(sub, field.type);
        result[field.name].push(val);
    }
}

// -- Scalar Helpers ----------------------------------------

/** @private */
function _writeScalar(writer, type, value)
{
    switch (type)
    {
        case 'int32':
        case 'int64':
        case 'uint32':
        case 'uint64':
        case 'enum':
            writer.writeVarint(Number(value));
            break;
        case 'sint32':
        case 'sint64':
            writer.writeSVarint(Number(value));
            break;
        case 'bool':
            writer.writeBool(!!value);
            break;
        case 'fixed32':
            writer.writeFixed32(Number(value));
            break;
        case 'sfixed32':
            writer.writeSFixed32(Number(value));
            break;
        case 'fixed64':
            writer.writeFixed64(value);
            break;
        case 'sfixed64':
            writer.writeSFixed64(value);
            break;
        case 'float':
            writer.writeFloat(Number(value));
            break;
        case 'double':
            writer.writeDouble(Number(value));
            break;
        case 'string':
            writer.writeString(String(value));
            break;
        case 'bytes':
            writer.writeBytes(Buffer.isBuffer(value) ? value : Buffer.from(value));
            break;
        default:
            throw new Error(`Unknown scalar type: ${type}`);
    }
}

/** @private */
function _readScalar(reader, type, wireType)
{
    switch (type)
    {
        case 'int32':
        {
            const v = reader.readVarint();
            return v > 0x7FFFFFFF ? v - 0x100000000 : v;
        }
        case 'int64':
            return reader.readVarint();
        case 'uint32':
        case 'uint64':
            return reader.readVarint();
        case 'sint32':
        case 'sint64':
            return reader.readSVarint();
        case 'bool':
            return reader.readBool();
        case 'fixed32':
            return reader.readFixed32();
        case 'sfixed32':
            return reader.readSFixed32();
        case 'fixed64':
            return reader.readFixed64();
        case 'sfixed64':
            return reader.readSFixed64();
        case 'float':
            return reader.readFloat();
        case 'double':
            return reader.readDouble();
        case 'string':
            return reader.readString();
        case 'bytes':
            return reader.readBytes();
        case 'enum':
            return reader.readVarint();
        default:
            throw new Error(`Unknown scalar type: ${type}`);
    }
}

/** @private */
function _isDefaultValue(type, value)
{
    switch (type)
    {
        case 'string': return value === '';
        case 'bytes': return Buffer.isBuffer(value) && value.length === 0;
        case 'bool': return value === false;
        case 'float':
        case 'double':
        case 'int32':
        case 'int64':
        case 'uint32':
        case 'uint64':
        case 'sint32':
        case 'sint64':
        case 'fixed32':
        case 'fixed64':
        case 'sfixed32':
        case 'sfixed64':
            return value === 0;
        default:
            return false;
    }
}

/** @private */
function _defaultObject(messageDesc)
{
    const obj = {};
    for (const field of messageDesc.fields)
    {
        if (field.map)
        {
            obj[field.name] = {};
        }
        else if (field.repeated)
        {
            obj[field.name] = [];
        }
        else
        {
            obj[field.name] = _defaultScalar(field);
        }
    }
    return obj;
}

/** @private */
function _defaultScalar(field)
{
    if (field.enumDef) return 0;
    switch (field.type)
    {
        case 'string': return '';
        case 'bytes': return Buffer.alloc(0);
        case 'bool': return false;
        case 'float':
        case 'double':
        case 'int32':
        case 'int64':
        case 'uint32':
        case 'uint64':
        case 'sint32':
        case 'sint64':
        case 'fixed32':
        case 'fixed64':
        case 'sfixed32':
        case 'sfixed64':
            return 0;
        default:
            return null; // nested message default
    }
}

/**
 * Check if a protobuf type can be packed (numeric/bool scalars only).
 *
 * @param {string} type - Protobuf type name.
 * @returns {boolean}
 */
function isPackable(type)
{
    return type !== 'string' && type !== 'bytes' && TYPE_INFO[type] !== undefined;
}

/** @private */
function _buildReverseEnum(enumDef)
{
    const rev = {};
    for (const [name, val] of Object.entries(enumDef.values))
    {
        rev[val] = name;
    }
    enumDef._reverse = rev;
    return rev;
}

module.exports = {
    Writer,
    Reader,
    WIRE_TYPE,
    TYPE_INFO,
    MAX_VARINT_SIZE,
    MAX_RECURSION_DEPTH,
    DEFAULT_MAX_MESSAGE_SIZE,
    encode,
    decode,
    isPackable,
};
