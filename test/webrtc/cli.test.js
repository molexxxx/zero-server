/**
 * WebRTC CLI subcommand dispatch.
 *
 *   Validates `runWebRTCCommand(name, flags, deps)` for each subcommand:
 *   help, stun (with injected stunBinding), turn-creds, join-token,
 *   verify-token, and unknown / error paths.
 */
'use strict';

const path = require('node:path');

const { runWebRTCCommand } = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc', 'cli'));
const { signJoinToken } = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc', 'joinToken'));

function captured()
{
    const out = [];
    const err = [];
    let exit = 0;
    return {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        setExit: (code) => { exit = code; },
        get stdout() { return out.join('\n'); },
        get stderr() { return err.join('\n'); },
        get exit() { return exit; },
    };
}

describe('runWebRTCCommand', () =>
{
    it('prints help for "help" / "" / unknown flag forms', async () =>
    {
        for (const name of ['help', '', '--help', '-h'])
        {
            const cap = captured();
            const code = await runWebRTCCommand(name, new Map(), cap);
            expect(code).toBe(0);
            expect(cap.exit).toBe(0);
            expect(cap.stdout).toMatch(/webrtc:stun/);
            expect(cap.stdout).toMatch(/webrtc:turn-creds/);
            expect(cap.stdout).toMatch(/webrtc:join-token/);
            expect(cap.stdout).toMatch(/webrtc:verify-token/);
        }
    });

    it('rejects unknown subcommands with exit 1 and help text', async () =>
    {
        const cap = captured();
        const code = await runWebRTCCommand('nope', new Map(), cap);
        expect(code).toBe(1);
        expect(cap.exit).toBe(1);
        expect(cap.stderr).toMatch(/Unknown webrtc subcommand/);
        expect(cap.stdout).toMatch(/webrtc:stun/);
    });

    describe('webrtc:stun', () =>
    {
        it('invokes the injected stunBinding and prints JSON result', async () =>
        {
            const cap = captured();
            const calls = [];
            const stunBinding = async (opts) =>
            {
                calls.push(opts);
                return { family: 4, address: '203.0.113.42', port: 49152 };
            };
            const flags = new Map([
                ['host', 'stun.example.com'],
                ['port', '19302'],
                ['timeout', '500'],
                ['retries', '2'],
            ]);
            const code = await runWebRTCCommand('stun', flags, { ...cap, stunBinding });
            expect(code).toBe(0);
            expect(calls).toEqual([{ host: 'stun.example.com', port: 19302, timeoutMs: 500, retries: 2 }]);
            expect(JSON.parse(cap.stdout)).toEqual({ family: 4, address: '203.0.113.42', port: 49152 });
        });

        it('defaults port=3478, timeout=1000, retries=1', async () =>
        {
            const cap = captured();
            const calls = [];
            const stunBinding = async (opts) =>
            {
                calls.push(opts);
                return { family: 4, address: '1.2.3.4', port: 1 };
            };
            await runWebRTCCommand('stun', new Map([['host', 'h']]), { ...cap, stunBinding });
            expect(calls[0]).toEqual({ host: 'h', port: 3478, timeoutMs: 1000, retries: 1 });
        });

        it('requires --host', async () =>
        {
            const cap = captured();
            const code = await runWebRTCCommand('stun', new Map(), {
                ...cap,
                stunBinding: async () => { throw new Error('should not be called'); },
            });
            expect(code).toBe(1);
            expect(cap.stderr).toMatch(/--host is required/);
        });

        it('rejects non-numeric --port with a clean error', async () =>
        {
            const cap = captured();
            const code = await runWebRTCCommand('stun', new Map([
                ['host', 'h'], ['port', 'nope'],
            ]), { ...cap, stunBinding: async () => ({ family: 4, address: '', port: 0 }) });
            expect(code).toBe(1);
            expect(cap.stderr).toMatch(/--port must be a number/);
        });

        it('surfaces stunBinding rejections as exit 1', async () =>
        {
            const cap = captured();
            const code = await runWebRTCCommand('stun', new Map([['host', 'h']]), {
                ...cap,
                stunBinding: async () => { throw new Error('boom'); },
            });
            expect(code).toBe(1);
            expect(cap.stderr).toMatch(/boom/);
        });
    });

    describe('webrtc:turn-creds', () =>
    {
        it('emits credentials JSON for valid inputs', async () =>
        {
            const cap = captured();
            const flags = new Map([
                ['secret', 'sshhh'],
                ['user',   'alice'],
                ['servers', 'turn:turn.example.com:3478,turns:turn.example.com:5349'],
                ['ttl',    '600'],
                ['realm',  'example.com'],
            ]);
            const code = await runWebRTCCommand('turn-creds', flags, cap);
            expect(code).toBe(0);
            const creds = JSON.parse(cap.stdout);
            expect(creds.username).toMatch(/:alice$/);
            expect(typeof creds.credential).toBe('string');
            expect(creds.credential.length).toBeGreaterThan(0);
            expect(creds.ttl).toBe(600);
            expect(creds.urls).toEqual([
                'turn:turn.example.com:3478',
                'turns:turn.example.com:5349',
            ]);
        });

        it('requires --secret, --user, --servers', async () =>
        {
            for (const missing of ['secret', 'user', 'servers'])
            {
                const flags = new Map([
                    ['secret', 's'], ['user', 'u'], ['servers', 'turn:h:3478'],
                ]);
                flags.delete(missing);
                const cap = captured();
                const code = await runWebRTCCommand('turn-creds', flags, cap);
                expect(code).toBe(1);
                expect(cap.stderr).toMatch(new RegExp(`--${missing}`));
            }
        });
    });

    describe('webrtc:join-token', () =>
    {
        it('signs a token that round-trips through verify-token', async () =>
        {
            const cap = captured();
            const signFlags = new Map([
                ['secret', 'jtsecret'],
                ['room',   'lobby'],
                ['user',   'alice'],
                ['ttl',    '120'],
            ]);
            const code = await runWebRTCCommand('join-token', signFlags, cap);
            expect(code).toBe(0);
            const token = cap.stdout.trim();
            expect(token.split('.').length).toBe(3);

            const verifyCap = captured();
            const verifyCode = await runWebRTCCommand('verify-token', new Map([
                ['secret', 'jtsecret'],
                ['token',  token],
                ['room',   'lobby'],
            ]), verifyCap);
            expect(verifyCode).toBe(0);
            const payload = JSON.parse(verifyCap.stdout);
            expect(payload.room).toBe('lobby');
            expect(payload.aud).toBe('room:lobby');
        });

        it('requires --secret, --room, --user', async () =>
        {
            for (const missing of ['secret', 'room', 'user'])
            {
                const flags = new Map([
                    ['secret', 's'], ['room', 'r'], ['user', 'u'],
                ]);
                flags.delete(missing);
                const cap = captured();
                const code = await runWebRTCCommand('join-token', flags, cap);
                expect(code).toBe(1);
                expect(cap.stderr).toMatch(new RegExp(`--${missing}`));
            }
        });
    });

    describe('webrtc:verify-token', () =>
    {
        it('rejects invalid signatures with exit 1', async () =>
        {
            const goodToken = signJoinToken({ secret: 'right', user: 'u', room: 'r', ttl: 60 });
            const cap = captured();
            const code = await runWebRTCCommand('verify-token', new Map([
                ['secret', 'wrong'],
                ['token',  goodToken],
                ['room',   'r'],
            ]), cap);
            expect(code).toBe(1);
            expect(cap.stderr).toMatch(/webrtc:verify-token failed/);
        });

        it('rejects token-room mismatch', async () =>
        {
            const token = signJoinToken({ secret: 's', user: 'u', room: 'r1', ttl: 60 });
            const cap = captured();
            const code = await runWebRTCCommand('verify-token', new Map([
                ['secret', 's'],
                ['token',  token],
                ['room',   'r2'],
            ]), cap);
            expect(code).toBe(1);
            expect(cap.stderr).toMatch(/webrtc:verify-token failed/);
        });

        it('requires --secret and --token', async () =>
        {
            for (const missing of ['secret', 'token'])
            {
                const flags = new Map([
                    ['secret', 's'], ['token', 'tok'],
                ]);
                flags.delete(missing);
                const cap = captured();
                const code = await runWebRTCCommand('verify-token', flags, cap);
                expect(code).toBe(1);
                expect(cap.stderr).toMatch(new RegExp(`--${missing}`));
            }
        });
    });

    it('exposes runWebRTCCommand from @zero-server/webrtc index', () =>
    {
        const webrtc = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc'));
        expect(typeof webrtc.runWebRTCCommand).toBe('function');
    });

    it('exposes runWebRTCCommand from the SDK root', () =>
    {
        const sdk = require(path.resolve(__dirname, '..', '..', 'index.js'));
        expect(typeof sdk.runWebRTCCommand).toBe('function');
    });
});
