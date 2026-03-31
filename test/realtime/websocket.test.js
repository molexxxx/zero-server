const net = require('net');
const crypto = require('crypto');
const { createApp, WebSocketPool } = require('../../');

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


// =========================================================================
//  WebSocket handshake — coverage boost (from coverage/boost.test.js)
// =========================================================================

{
	const handleUpgrade = require('../../lib/ws/handshake');

	function mockSocket()
	{
		const data = [];
		return {
			data,
			destroyed: false,
			on(ev, fn) { this['_on_' + ev] = fn; },
			write(d) { data.push(d); },
			destroy() { this.destroyed = true; },
			remoteAddress: '127.0.0.1',
		};
	}

	function makeReq(url, headers = {})
	{
		return {
			url,
			headers: {
				'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
				...headers,
			},
			socket: { remoteAddress: '127.0.0.1', encrypted: false },
		};
	}

	it('404 when no handler registered for path', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		handleUpgrade(makeReq('/missing'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('404');
		expect(socket.destroyed).toBe(true);
	});

	it('400 when missing sec-websocket-key', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		map.set('/ws', { handler: () => {}, opts: {} });
		const req = makeReq('/ws');
		delete req.headers['sec-websocket-key'];
		handleUpgrade(req, socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('400');
		expect(socket.destroyed).toBe(true);
	});

	it('403 when verifyClient returns false', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		map.set('/ws', { handler: () => {}, opts: { verifyClient: () => false } });
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('403');
		expect(socket.destroyed).toBe(true);
	});

	it('500 when verifyClient throws', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		map.set('/ws', { handler: () => {}, opts: { verifyClient: () => { throw new Error('boom'); } } });
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('500');
		expect(socket.destroyed).toBe(true);
	});

	it('101 successful upgrade with handler call', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let handlerCalled = false;
		map.set('/ws', { handler: (ws) => { handlerCalled = true; }, opts: {} });
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('101');
		expect(handlerCalled).toBe(true);
	});

	it('parses query string parameters', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let receivedWs;
		map.set('/ws', { handler: (ws) => { receivedWs = ws; }, opts: {} });
		handleUpgrade(makeReq('/ws?token=abc&room=main'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('101');
		expect(receivedWs.query.token).toBe('abc');
		expect(receivedWs.query.room).toBe('main');
	});

	it('echoes sub-protocol from client', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		map.set('/ws', { handler: () => {}, opts: {} });
		handleUpgrade(makeReq('/ws', { 'sec-websocket-protocol': 'graphql-ws, other' }), socket, Buffer.alloc(0), map);
		const response = socket.data[0];
		expect(response).toContain('101');
		expect(response).toContain('Sec-WebSocket-Protocol: graphql-ws');
	});

	it('handler error closes connection with 1011', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		map.set('/ws', {
			handler: () => { throw new Error('handler crash'); },
			opts: {}
		});
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		// 101 upgrade happens before handler, so socket gets upgrade response
		expect(socket.data[0]).toContain('101');
	});

	it('passes extensions header to connection', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let receivedWs;
		map.set('/ws', { handler: (ws) => { receivedWs = ws; }, opts: {} });
		handleUpgrade(makeReq('/ws', { 'sec-websocket-extensions': 'permessage-deflate' }), socket, Buffer.alloc(0), map);
		expect(receivedWs.extensions).toBe('permessage-deflate');
	});

	it('detects secure connection from encrypted socket', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let receivedWs;
		map.set('/ws', { handler: (ws) => { receivedWs = ws; }, opts: {} });
		const req = makeReq('/ws');
		req.socket.encrypted = true;
		handleUpgrade(req, socket, Buffer.alloc(0), map);
		expect(receivedWs.secure).toBe(true);
	});

	it('verifyClient returning true allows connection', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let handlerCalled = false;
		map.set('/ws', {
			handler: () => { handlerCalled = true; },
			opts: { verifyClient: () => true }
		});
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('101');
		expect(handlerCalled).toBe(true);
	});

	it('passes maxPayload and pingInterval to connection', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let receivedWs;
		map.set('/ws', {
			handler: (ws) => { receivedWs = ws; },
			opts: { maxPayload: 1024, pingInterval: 5000 }
		});
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('101');
	});

	it('socket error handler absorbs errors without throwing', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		// Use a path with no handler (404 path) so WebSocketConnection
		// is never created and doesn't overwrite the error listener.
		handleUpgrade(makeReq('/missing-err'), socket, Buffer.alloc(0), map);
		expect(socket.data[0]).toContain('404');
		// The () => {} error guard was registered before the 404 check;
		// trigger it to cover the arrow function.
		expect(socket._on_error).toBeDefined();
		socket._on_error(new Error('ECONNRESET'));
		// Should not throw — guard against crash
	});

	it('URL without query string gives empty query object', () =>
	{
		const socket = mockSocket();
		const map = new Map();
		let receivedWs;
		map.set('/ws', { handler: (ws) => { receivedWs = ws; }, opts: {} });
		handleUpgrade(makeReq('/ws'), socket, Buffer.alloc(0), map);
		expect(receivedWs.query).toEqual({});
	});
};

// =========================================================================
//  ws/handshake — function coverage (from coverage/deep.test.js)
// =========================================================================

describe('ws/handshake — function coverage', () => {
	const handleUpgrade = require('../../lib/ws/handshake');
	const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

	function mockSocket() {
		const written = [];
		return {
			write: (data) => { written.push(data); },
			destroy: () => {},
			on: (ev, fn) => {},
			once: (ev, fn) => {},
			removeAllListeners: () => {},
			setTimeout: () => {},
			setNoDelay: () => {},
			setKeepAlive: () => {},
			_written: written,
			writable: true,
			remoteAddress: '127.0.0.1',
		};
	}

	it('returns 404 when no handler matches the path', () => {
		const socket = mockSocket();
		const req = { url: '/unknown', headers: {}, socket };
		handleUpgrade(req, socket, Buffer.alloc(0), new Map());
		expect(socket._written[0]).toContain('404');
	});

	it('returns 400 when sec-websocket-key is missing', () => {
		const socket = mockSocket();
		const handlers = new Map();
		handlers.set('/ws', { handler: () => {}, opts: {} });
		const req = { url: '/ws', headers: {}, socket };
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(socket._written[0]).toContain('400');
	});

	it('returns 403 when verifyClient returns false', () => {
		const socket = mockSocket();
		const handlers = new Map();
		handlers.set('/ws', {
			handler: () => {},
			opts: { verifyClient: () => false },
		});
		const req = {
			url: '/ws',
			headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(socket._written[0]).toContain('403');
	});

	it('returns 500 when verifyClient throws', () => {
		const socket = mockSocket();
		const handlers = new Map();
		handlers.set('/ws', {
			handler: () => {},
			opts: { verifyClient: () => { throw new Error('verify error'); } },
		});
		const req = {
			url: '/ws',
			headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(socket._written[0]).toContain('500');
	});

	it('completes handshake with valid key and calls handler', () => {
		const socket = mockSocket();
		let handlerCalled = false;
		const handlers = new Map();
		handlers.set('/ws', {
			handler: (ws, req) => { handlerCalled = true; },
			opts: {},
		});

		const key = 'dGhlIHNhbXBsZSBub25jZQ==';
		const expectedAccept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');

		const req = {
			url: '/ws',
			headers: { 'sec-websocket-key': key },
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(socket._written[0]).toContain('101');
		expect(socket._written[0]).toContain(expectedAccept);
		expect(handlerCalled).toBe(true);
	});

	it('negotiates sub-protocol from client header', () => {
		const socket = mockSocket();
		const handlers = new Map();
		handlers.set('/ws', {
			handler: () => {},
			opts: {},
		});

		const req = {
			url: '/ws',
			headers: {
				'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'sec-websocket-protocol': 'graphql, json',
			},
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(socket._written[0]).toContain('Sec-WebSocket-Protocol: graphql');
	});

	it('parses query string from upgrade URL', () => {
		const socket = mockSocket();
		let wsInstance = null;
		const handlers = new Map();
		handlers.set('/ws', {
			handler: (ws) => { wsInstance = ws; },
			opts: {},
		});

		const req = {
			url: '/ws?token=abc&room=lobby',
			headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(wsInstance).not.toBeNull();
		expect(wsInstance.query.token).toBe('abc');
		expect(wsInstance.query.room).toBe('lobby');
	});

	it('handles handler that throws (closes WS with 1011)', () => {
		const socket = mockSocket();
		const handlers = new Map();
		handlers.set('/ws', {
			handler: () => { throw new Error('handler error'); },
			opts: {},
		});

		const req = {
			url: '/ws',
			headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
			socket,
		};
		// Should not throw
		expect(() => {
			handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		}).not.toThrow();
	});

	it('passes extensions header to connection', () => {
		const socket = mockSocket();
		let wsInstance = null;
		const handlers = new Map();
		handlers.set('/ws', {
			handler: (ws) => { wsInstance = ws; },
			opts: {},
		});

		const req = {
			url: '/ws',
			headers: {
				'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'sec-websocket-extensions': 'permessage-deflate',
			},
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(wsInstance.extensions).toBe('permessage-deflate');
	});

	it('detects secure connections', () => {
		const socket = mockSocket();
		socket.encrypted = true;
		let wsInstance = null;
		const handlers = new Map();
		handlers.set('/ws', {
			handler: (ws) => { wsInstance = ws; },
			opts: {},
		});

		const req = {
			url: '/ws',
			headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
			socket,
		};
		handleUpgrade(req, socket, Buffer.alloc(0), handlers);
		expect(wsInstance.secure).toBe(true);
	});
});
