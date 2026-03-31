/**
 * Tests for WebSocketConnection — frame building, event emitter, send/close/terminate,
 * and incoming data parsing (text, binary, ping/pong, close frames).
 */
const WebSocketConnection = require('../../lib/ws/connection');
const { EventEmitter } = require('events');

// Mock socket
function createMockSocket()
{
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.write = vi.fn(() => true);
    socket.end = vi.fn();
    socket.destroy = vi.fn();
    socket.writableLength = 0;
    return socket;
}

let socket, ws;
beforeEach(() =>
{
    socket = createMockSocket();
    ws = new WebSocketConnection(socket, { pingInterval: 0, url: '/ws' });
});

// ===========================================================
//  Static constants
// ===========================================================
describe('static constants', () =>
{
    it('exposes ready-state constants', () =>
    {
        expect(WebSocketConnection.CONNECTING).toBe(0);
        expect(WebSocketConnection.OPEN).toBe(1);
        expect(WebSocketConnection.CLOSING).toBe(2);
        expect(WebSocketConnection.CLOSED).toBe(3);
    });
});

// ===========================================================
//  Constructor & properties
// ===========================================================
describe('constructor', () =>
{
    it('sets initial properties', () =>
    {
        expect(ws.readyState).toBe(1);
        expect(ws.id).toBeTruthy();
        expect(ws.ip).toBe('127.0.0.1');
        expect(ws.url).toBe('/ws');
        expect(ws.connectedAt).toBeLessThanOrEqual(Date.now());
    });

    it('generates unique IDs', () =>
    {
        const ws2 = new WebSocketConnection(createMockSocket(), { pingInterval: 0 });
        expect(ws.id).not.toBe(ws2.id);
    });

    it('uses default maxPayload (1MB)', () =>
    {
        expect(ws.maxPayload).toBe(1048576);
    });

    it('respects custom maxPayload', () =>
    {
        const ws2 = new WebSocketConnection(createMockSocket(), { maxPayload: 1024, pingInterval: 0 });
        expect(ws2.maxPayload).toBe(1024);
    });
});

// ===========================================================
//  Event Emitter
// ===========================================================
describe('event emitter', () =>
{
    it('on/emit: registers and fires listeners', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        ws._emit('message', 'hello');
        expect(fn).toHaveBeenCalledWith('hello');
    });

    it('once: fires listener only once', () =>
    {
        const fn = vi.fn();
        ws.once('message', fn);
        ws._emit('message', 'a');
        ws._emit('message', 'b');
        expect(fn).toHaveBeenCalledOnce();
        expect(fn).toHaveBeenCalledWith('a');
    });

    it('off: removes a specific listener', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        ws.off('message', fn);
        ws._emit('message', 'x');
        expect(fn).not.toHaveBeenCalled();
    });

    it('off: removes once-wrapped listener by original fn', () =>
    {
        const fn = vi.fn();
        ws.once('message', fn);
        ws.off('message', fn);
        ws._emit('message', 'x');
        expect(fn).not.toHaveBeenCalled();
    });

    it('off: does nothing for non-existent event', () =>
    {
        expect(() => ws.off('nope', () => {})).not.toThrow();
    });

    it('removeAllListeners: removes all for event', () =>
    {
        ws.on('message', () => {});
        ws.on('message', () => {});
        ws.removeAllListeners('message');
        expect(ws.listenerCount('message')).toBe(0);
    });

    it('removeAllListeners: removes all events when no arg', () =>
    {
        ws.on('message', () => {});
        ws.on('close', () => {});
        ws.removeAllListeners();
        expect(ws.listenerCount('message')).toBe(0);
        expect(ws.listenerCount('close')).toBe(0);
    });

    it('listenerCount: returns count', () =>
    {
        expect(ws.listenerCount('message')).toBe(0);
        ws.on('message', () => {});
        ws.on('message', () => {});
        expect(ws.listenerCount('message')).toBe(2);
    });

    it('_emit: swallows errors in listeners', () =>
    {
        ws.on('message', () => { throw new Error('boom'); });
        expect(() => ws._emit('message', 'data')).not.toThrow();
    });

    it('on returns this for chaining', () =>
    {
        expect(ws.on('message', () => {})).toBe(ws);
    });
});

// ===========================================================
//  _buildFrame
// ===========================================================
describe('_buildFrame', () =>
{
    it('builds small frame (< 126 bytes)', () =>
    {
        const payload = Buffer.from('hello');
        const frame = ws._buildFrame(0x01, payload);
        expect(frame[0]).toBe(0x81); // FIN + text opcode
        expect(frame[1]).toBe(5);    // length
        expect(frame.slice(2).toString()).toBe('hello');
    });

    it('builds medium frame (126-65535 bytes)', () =>
    {
        const payload = Buffer.alloc(200, 0x41); // 200 bytes of 'A'
        const frame = ws._buildFrame(0x02, payload);
        expect(frame[0]).toBe(0x82); // FIN + binary
        expect(frame[1]).toBe(126);
        expect(frame.readUInt16BE(2)).toBe(200);
        expect(frame.length).toBe(4 + 200);
    });

    it('builds large frame (> 65535 bytes)', () =>
    {
        const payload = Buffer.alloc(70000, 0x42);
        const frame = ws._buildFrame(0x01, payload);
        expect(frame[0]).toBe(0x81);
        expect(frame[1]).toBe(127);
        expect(frame.readUInt32BE(6)).toBe(70000);
        expect(frame.length).toBe(10 + 70000);
    });

    it('sets correct opcode for ping (0x09)', () =>
    {
        const frame = ws._buildFrame(0x09, Buffer.alloc(0));
        expect(frame[0]).toBe(0x89);
    });

    it('sets correct opcode for pong (0x0A)', () =>
    {
        const frame = ws._buildFrame(0x0A, Buffer.alloc(0));
        expect(frame[0]).toBe(0x8A);
    });

    it('sets correct opcode for close (0x08)', () =>
    {
        const frame = ws._buildFrame(0x08, Buffer.alloc(2));
        expect(frame[0]).toBe(0x88);
    });
});

// ===========================================================
//  send
// ===========================================================
describe('send', () =>
{
    it('sends text frame', () =>
    {
        ws.send('hello');
        expect(socket.write).toHaveBeenCalledOnce();
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x81); // text
    });

    it('sends binary frame for Buffer', () =>
    {
        ws.send(Buffer.from([1, 2, 3]));
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x82); // binary
    });

    it('sends binary when opts.binary=true', () =>
    {
        ws.send('text', { binary: true });
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x82);
    });

    it('returns false when not OPEN', () =>
    {
        ws.readyState = WebSocketConnection.CLOSED;
        expect(ws.send('test')).toBe(false);
    });

    it('returns false when socket.write throws', () =>
    {
        socket.write = () => { throw new Error('broken'); };
        expect(ws.send('data')).toBe(false);
    });

    it('passes callback to socket.write', () =>
    {
        const cb = vi.fn();
        ws.send('data', { callback: cb });
        expect(socket.write).toHaveBeenCalledWith(expect.any(Buffer), cb);
    });
});

// ===========================================================
//  sendJSON
// ===========================================================
describe('sendJSON', () =>
{
    it('serializes and sends JSON', () =>
    {
        ws.sendJSON({ hello: 'world' });
        expect(socket.write).toHaveBeenCalledOnce();
    });

    it('emits error for circular references', () =>
    {
        const errorFn = vi.fn();
        ws.on('error', errorFn);
        const obj = {};
        obj.self = obj;
        const result = ws.sendJSON(obj);
        expect(result).toBe(false);
        expect(errorFn).toHaveBeenCalled();
    });
});

// ===========================================================
//  ping / pong
// ===========================================================
describe('ping / pong', () =>
{
    it('ping sends a ping frame', () =>
    {
        ws.ping();
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x89);
    });

    it('ping with payload', () =>
    {
        ws.ping('alive');
        expect(socket.write).toHaveBeenCalled();
    });

    it('ping returns false when not OPEN', () =>
    {
        ws.readyState = WebSocketConnection.CLOSED;
        expect(ws.ping()).toBe(false);
    });

    it('ping returns false on socket error', () =>
    {
        socket.write = () => { throw new Error('broken'); };
        expect(ws.ping()).toBe(false);
    });

    it('pong sends a pong frame', () =>
    {
        ws.pong();
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x8A);
    });

    it('pong with Buffer payload', () =>
    {
        ws.pong(Buffer.from('data'));
        expect(socket.write).toHaveBeenCalled();
    });

    it('pong returns false when not OPEN', () =>
    {
        ws.readyState = WebSocketConnection.CLOSED;
        expect(ws.pong()).toBe(false);
    });

    it('pong returns false on socket error', () =>
    {
        socket.write = () => { throw new Error('broken'); };
        expect(ws.pong()).toBe(false);
    });
});

// ===========================================================
//  close
// ===========================================================
describe('close', () =>
{
    it('sends close frame and ends socket', () =>
    {
        ws.close(1000, 'bye');
        expect(ws.readyState).toBe(WebSocketConnection.CLOSING);
        expect(socket.write).toHaveBeenCalled();
        expect(socket.end).toHaveBeenCalled();
        // Close frame opcode
        const frame = socket.write.mock.calls[0][0];
        expect(frame[0]).toBe(0x88);
    });

    it('does nothing if already CLOSED', () =>
    {
        ws.readyState = WebSocketConnection.CLOSED;
        ws.close();
        expect(socket.write).not.toHaveBeenCalled();
    });

    it('does nothing if already CLOSING', () =>
    {
        ws.readyState = WebSocketConnection.CLOSING;
        ws.close();
        expect(socket.write).not.toHaveBeenCalled();
    });

    it('uses default code 1000', () =>
    {
        ws.close();
        const frame = socket.write.mock.calls[0][0];
        // After the header bytes, first 2 payload bytes should be 1000 (0x03E8)
        const headerLen = frame[1] & 0x7F;
        const payloadStart = headerLen < 126 ? 2 : 4;
        const code = frame.readUInt16BE(payloadStart);
        expect(code).toBe(1000);
    });
});

// ===========================================================
//  terminate
// ===========================================================
describe('terminate', () =>
{
    it('destroys socket without close frame', () =>
    {
        ws.terminate();
        expect(ws.readyState).toBe(WebSocketConnection.CLOSED);
        expect(socket.destroy).toHaveBeenCalled();
        expect(socket.write).not.toHaveBeenCalled();
    });
});

// ===========================================================
//  Computed properties
// ===========================================================
describe('computed properties', () =>
{
    it('bufferedAmount returns writableLength', () =>
    {
        socket.writableLength = 512;
        expect(ws.bufferedAmount).toBe(512);
    });

    it('bufferedAmount returns 0 when socket is null', () =>
    {
        ws._socket = null;
        expect(ws.bufferedAmount).toBe(0);
    });

    it('uptime returns positive value', () =>
    {
        expect(ws.uptime).toBeGreaterThanOrEqual(0);
    });
});

// ===========================================================
//  _onData — parsing incoming WebSocket frames
// ===========================================================
describe('_onData - frame parsing', () =>
{
    it('parses incoming unmasked text frame', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        // Unmasked text frame: "hi"
        const payload = Buffer.from('hi');
        const header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text
        header[1] = payload.length; // no mask
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith('hi');
    });

    it('parses incoming masked text frame', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        const text = 'test';
        const payload = Buffer.from(text);
        const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
        const header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length; // masked flag
        ws._onData(Buffer.concat([header, mask, masked]));
        expect(fn).toHaveBeenCalledWith('test');
    });

    it('parses incoming binary frame', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        const payload = Buffer.from([0xDE, 0xAD]);
        const header = Buffer.alloc(2);
        header[0] = 0x82; // binary
        header[1] = payload.length;
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith(Buffer.from([0xDE, 0xAD]));
    });

    it('parses incoming ping and sends pong', () =>
    {
        const fn = vi.fn();
        ws.on('ping', fn);
        const payload = Buffer.from('ping!');
        const header = Buffer.alloc(2);
        header[0] = 0x89; // ping
        header[1] = payload.length;
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith(payload);
        // Should auto-respond with pong
        expect(socket.write).toHaveBeenCalled();
    });

    it('parses incoming pong', () =>
    {
        const fn = vi.fn();
        ws.on('pong', fn);
        const payload = Buffer.from('pong!');
        const header = Buffer.alloc(2);
        header[0] = 0x8A; // pong
        header[1] = payload.length;
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith(payload);
    });

    it('parses incoming close frame', () =>
    {
        const fn = vi.fn();
        ws.on('close', fn);
        const codeBuf = Buffer.alloc(2);
        codeBuf.writeUInt16BE(1000, 0);
        const reason = Buffer.from('bye');
        const payload = Buffer.concat([codeBuf, reason]);
        const header = Buffer.alloc(2);
        header[0] = 0x88; // close
        header[1] = payload.length;
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith(1000, 'bye');
        expect(ws.readyState).toBe(WebSocketConnection.CLOSED);
    });

    it('uses code 1005 for close frame without payload', () =>
    {
        const fn = vi.fn();
        ws.on('close', fn);
        const header = Buffer.alloc(2);
        header[0] = 0x88;
        header[1] = 0;
        ws._onData(header);
        expect(fn).toHaveBeenCalledWith(1005, '');
    });

    it('handles medium-length payload (126-65535)', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        const data = 'A'.repeat(200);
        const payload = Buffer.from(data);
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        ws._onData(Buffer.concat([header, payload]));
        expect(fn).toHaveBeenCalledWith(data);
    });

    it('rejects oversized payload', () =>
    {
        ws.maxPayload = 10;
        const closeFn = vi.fn();
        ws.on('close', closeFn);
        const header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 50;
        const payload = Buffer.alloc(50);
        ws._onData(Buffer.concat([header, payload]));
        // Should send close frame with 1009
        expect(socket.write).toHaveBeenCalled();
    });

    it('handles partial frames by buffering', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        const payload = Buffer.from('hello');
        const header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 5;
        // Send header only first
        ws._onData(header);
        expect(fn).not.toHaveBeenCalled();
        // Then send payload
        ws._onData(payload);
        expect(fn).toHaveBeenCalledWith('hello');
    });

    it('handles multiple frames in one chunk', () =>
    {
        const fn = vi.fn();
        ws.on('message', fn);
        const frames = [];
        for (const msg of ['aaa', 'bbb'])
        {
            const payload = Buffer.from(msg);
            const header = Buffer.alloc(2);
            header[0] = 0x81;
            header[1] = payload.length;
            frames.push(Buffer.concat([header, payload]));
        }
        ws._onData(Buffer.concat(frames));
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenCalledWith('aaa');
        expect(fn).toHaveBeenCalledWith('bbb');
    });
});

// ===========================================================
//  Socket events
// ===========================================================
describe('socket events', () =>
{
    it('emits close on socket close', () =>
    {
        const fn = vi.fn();
        ws.on('close', fn);
        socket.emit('close');
        expect(fn).toHaveBeenCalledWith(1006, '');
        expect(ws.readyState).toBe(WebSocketConnection.CLOSED);
    });

    it('does not emit close twice', () =>
    {
        const fn = vi.fn();
        ws.on('close', fn);
        socket.emit('close');
        socket.emit('close');
        expect(fn).toHaveBeenCalledOnce();
    });

    it('emits error on socket error', () =>
    {
        const fn = vi.fn();
        ws.on('error', fn);
        socket.emit('error', new Error('oops'));
        expect(fn).toHaveBeenCalledWith(expect.any(Error));
    });

    it('emits drain on socket drain', () =>
    {
        const fn = vi.fn();
        ws.on('drain', fn);
        socket.emit('drain');
        expect(fn).toHaveBeenCalled();
    });
});
