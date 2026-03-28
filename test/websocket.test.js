const net = require('net');
const crypto = require('crypto');
const { createApp, WebSocketPool } = require('../');

function mockWs(id) {
    const listeners = {};
    return {
        id, readyState: 1, sent: [],
        send(data) { this.sent.push(data); },
        close() { this.readyState = 3; },
        on(evt, fn) { if (!listeners[evt]) listeners[evt] = []; listeners[evt].push(fn); },
        once(evt, fn) {
            const wrapped = (...args) => { this.off(evt, wrapped); fn(...args); };
            this.on(evt, wrapped);
        },
        off(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn); },
        emit(evt, ...args) { if (listeners[evt]) listeners[evt].forEach(fn => fn(...args)); },
    };
}

function wsConnect(portNum, wsPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(portNum, '127.0.0.1', () => {
            let h = `GET ${wsPath} HTTP/1.1\r\nHost: localhost:${portNum}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
            for (const [k, v] of Object.entries(headers)) h += `${k}: ${v}\r\n`;
            h += '\r\n';
            socket.write(h);
        });

        let upgraded = false, headerBuf = '', responseHeaders = '';
        const messages = [];

        socket.on('data', (chunk) => {
            if (!upgraded) {
                headerBuf += chunk.toString();
                if (headerBuf.includes('\r\n\r\n')) {
                    upgraded = true;
                    responseHeaders = headerBuf.split('\r\n\r\n')[0];
                    const remaining = chunk.slice(chunk.indexOf(Buffer.from('\r\n\r\n')) + 4);
                    if (remaining.length > 0) parseFrames(remaining);
                }
                return;
            }
            parseFrames(chunk);
        });

        function parseFrames(buf) {
            while (buf.length >= 2) {
                const opcode = buf[0] & 0x0F;
                let payloadLen = buf[1] & 0x7F, offset = 2;
                if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
                else if (payloadLen === 127) { payloadLen = buf.readUInt32BE(6); offset = 10; }
                if (buf.length < offset + payloadLen) break;
                const payload = buf.slice(offset, offset + payloadLen);
                if (opcode === 0x01) messages.push(payload.toString('utf8'));
                else if (opcode === 0x08) { socket.end(); return; }
                buf = buf.slice(offset + payloadLen);
            }
        }

        function sendFrame(text) {
            const payload = Buffer.from(text, 'utf8');
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
            let header;
            if (payload.length < 126) {
                header = Buffer.alloc(2);
                header[0] = 0x81; header[1] = 0x80 | payload.length;
            } else {
                header = Buffer.alloc(4);
                header[0] = 0x81; header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
            }
            socket.write(Buffer.concat([header, mask, masked]));
        }

        socket.on('error', reject);
        setTimeout(() => resolve({ socket, messages, sendFrame, responseHeaders }), 100);
    });
}

describe('WebSocket Pool', () => {
    it('WebSocketPool is exported', () => {
        expect(typeof WebSocketPool).toBe('function');
    });

    it('add() tracks connections', () => {
        const pool = new WebSocketPool();
        pool.add(mockWs('a'));
        pool.add(mockWs('b'));
        pool.add(mockWs('c'));
        expect(pool.size).toBe(3);
    });

    it('rooms + join + roomSize + in()', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2'), ws3 = mockWs('3');
        pool.add(ws1); pool.add(ws2); pool.add(ws3);
        pool.join(ws1, 'room1'); pool.join(ws2, 'room1'); pool.join(ws3, 'room2');
        expect(pool.rooms.length).toBe(2);
        expect(pool.roomSize('room1')).toBe(2);
        expect(pool.in('room1').length).toBe(2);
    });

    it('broadcast to all', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2');
        pool.add(ws1); pool.add(ws2);
        pool.broadcast('hello');
        expect(ws1.sent).toContain('hello');
        expect(ws2.sent).toContain('hello');
    });

    it('broadcast excludes sender', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2');
        pool.add(ws1); pool.add(ws2);
        pool.broadcast('msg', ws1);
        expect(ws1.sent).not.toContain('msg');
        expect(ws2.sent).toContain('msg');
    });

    it('toRoom sends to room members only', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2'), ws3 = mockWs('3');
        pool.add(ws1); pool.add(ws2); pool.add(ws3);
        pool.join(ws1, 'r1'); pool.join(ws2, 'r1');
        pool.toRoom('r1', 'room-msg');
        expect(ws1.sent).toContain('room-msg');
        expect(ws2.sent).toContain('room-msg');
        expect(ws3.sent).not.toContain('room-msg');
    });

    it('broadcastJSON serializes', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1');
        pool.add(ws1);
        pool.broadcastJSON({ test: true });
        expect(ws1.sent[0]).toBe('{"test":true}');
    });

    it('toRoomJSON serializes', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1');
        pool.add(ws1);
        pool.join(ws1, 'r1');
        pool.toRoomJSON('r1', { room: true });
        expect(ws1.sent[0]).toBe('{"room":true}');
    });

    it('roomsOf returns rooms for a connection', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1');
        pool.add(ws1);
        pool.join(ws1, 'room1');
        expect(pool.roomsOf(ws1)).toContain('room1');
    });

    it('leave reduces room size', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2');
        pool.add(ws1); pool.add(ws2);
        pool.join(ws1, 'r1'); pool.join(ws2, 'r1');
        pool.leave(ws1, 'r1');
        expect(pool.roomSize('r1')).toBe(1);
        expect(pool.roomsOf(ws1)).not.toContain('r1');
    });

    it('remove reduces size and cleans rooms', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1'), ws2 = mockWs('2');
        pool.add(ws1); pool.add(ws2);
        pool.join(ws1, 'r1');
        pool.remove(ws1);
        expect(pool.size).toBe(1);
        expect(pool.roomSize('r1')).toBe(0);
    });

    it('clients getter', () => {
        const pool = new WebSocketPool();
        pool.add(mockWs('1')); pool.add(mockWs('2'));
        expect(pool.clients.length).toBe(2);
    });

    it('closeAll empties pool', () => {
        const pool = new WebSocketPool();
        const ws1 = mockWs('1');
        pool.add(ws1);
        pool.closeAll();
        expect(pool.size).toBe(0);
        expect(ws1.readyState).toBe(3);
    });
});

describe('WebSocket Integration', () => {
    let server, port;

    beforeAll(async () => {
        const app = createApp();
        app.ws('/ws-echo', (ws) => {
            ws.on('message', (data) => ws.send('echo:' + data));
        });
        app.ws('/ws-json', { pingInterval: 0 }, (ws) => {
            ws.on('message', (data) => {
                try { ws.sendJSON({ received: JSON.parse(data) }); }
                catch { ws.send('parse error'); }
            });
        });
        app.ws('/ws-verify', {
            verifyClient: (req) => req.headers['x-token'] === 'valid',
            pingInterval: 0
        }, (ws) => { ws.send('authenticated'); });

        server = app.listen(0);
        await new Promise(r => server.on('listening', r));
        port = server.address().port;
    });

    afterAll(() => server?.close());

    it('101 handshake + echo', async () => {
        const ws = await wsConnect(port, '/ws-echo');
        expect(ws.responseHeaders).toContain('101');
        ws.sendFrame('hello');
        await new Promise(r => setTimeout(r, 100));
        expect(ws.messages).toContain('echo:hello');
        ws.socket.end();
    });

    it('JSON exchange', async () => {
        const ws = await wsConnect(port, '/ws-json');
        ws.sendFrame(JSON.stringify({ foo: 'bar' }));
        await new Promise(r => setTimeout(r, 100));
        expect(ws.messages.length).toBeGreaterThan(0);
        expect(JSON.parse(ws.messages[0]).received.foo).toBe('bar');
        ws.socket.end();
    });

    it('verifyClient rejects without token', async () => {
        const data = await new Promise((resolve) => {
            const key = crypto.randomBytes(16).toString('base64');
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write(`GET /ws-verify HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            });
            let buf = '';
            socket.on('data', c => buf += c.toString());
            socket.on('end', () => resolve(buf));
            socket.on('close', () => resolve(buf));
            setTimeout(() => { socket.end(); resolve(buf); }, 200);
        });
        expect(data).toContain('403');
    });

    it('verifyClient accepts with token', async () => {
        const ws = await wsConnect(port, '/ws-verify', { 'X-Token': 'valid' });
        await new Promise(r => setTimeout(r, 100));
        expect(ws.messages).toContain('authenticated');
        ws.socket.end();
    });

    it('404 for unknown WS path', async () => {
        const data = await new Promise((resolve) => {
            const key = crypto.randomBytes(16).toString('base64');
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write(`GET /no-such-ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            });
            let buf = '';
            socket.on('data', c => buf += c.toString());
            setTimeout(() => { socket.end(); resolve(buf); }, 200);
        });
        expect(data).toContain('404');
    });
});
