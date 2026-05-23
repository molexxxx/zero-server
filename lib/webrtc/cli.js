/**
 * @module webrtc/cli
 * @description CLI subcommands for the `zs webrtc:*` namespace.
 *
 *   Pure-function entry point `runWebRTCCommand(subcmd, flags, deps)` so
 *   the dispatch can be exercised in tests without spawning a child
 *   process or hitting the network.  All side effects (stdout / stderr /
 *   process.exitCode) are injected through `deps`, defaulting to the
 *   real globals when called from `lib/cli.js`.
 *
 * @example
 *   // From the shell, via the top-level CLI:
 *   //   npx zs webrtc:stun --host stun.l.google.com --port 19302
 *   //   npx zs webrtc:turn-creds --secret $SECRET --user alice \
 *   //                           --servers turn:turn.example.com:3478
 *   //   npx zs webrtc:join-token --secret $JT_SECRET --room lobby --sub u1
 *   //   npx zs webrtc:verify-token --secret $JT_SECRET --token $TOKEN
 *
 *   // Programmatically:
 *   const { runWebRTCCommand } = require('@zero-server/webrtc/cli');
 *   await runWebRTCCommand('join-token', new Map([
 *       ['secret', 's'], ['room', 'lobby'], ['sub', 'u1'],
 *   ]));
 */

'use strict';

const defaultStun = require('./stun').stunBinding;
const { issueTurnCredentials } = require('./turn/credentials');
const { signJoinToken, verifyJoinToken } = require('./joinToken');

const SUBCOMMANDS = ['stun', 'turn-creds', 'join-token', 'verify-token', 'help'];

/**
 * @private
 * Coerce a flag Map value to a number; return defaultValue if undefined.
 */
function flagNumber(flags, key, defaultValue)
{
    if (!flags.has(key)) return defaultValue;
    const raw = flags.get(key);
    const n = Number(raw);
    if (!Number.isFinite(n))
        throw new Error(`--${key} must be a number, got "${raw}"`);
    return n;
}

/**
 * @private
 * Split a comma-separated flag into a trimmed, non-empty list.
 */
function flagList(flags, key)
{
    if (!flags.has(key)) return [];
    return String(flags.get(key))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * @private
 * Require a flag, throwing a friendly error otherwise.
 */
function flagRequired(flags, key)
{
    if (!flags.has(key) || flags.get(key) === 'true')
        throw new Error(`--${key} is required`);
    return flags.get(key);
}

/**
 * Run a single `webrtc:*` subcommand.
 *
 * @param {string} subcmd
 *   One of `stun`, `turn-creds`, `join-token`, `verify-token`, `help`.
 * @param {Map<string,string>} flags
 * @param {object} [deps]
 *   Injection seam for tests.
 * @param {(line: string) => void} [deps.out]
 * @param {(line: string) => void} [deps.err]
 * @param {(code: number) => void} [deps.setExit]
 * @param {typeof defaultStun} [deps.stunBinding]
 * @returns {Promise<number>} The exit code that would have been set.
 */
async function runWebRTCCommand(subcmd, flags = new Map(), deps = {})
{
    const out       = deps.out       || ((line) => console.log(line));
    const err       = deps.err       || ((line) => console.error(line));
    const setExit   = deps.setExit   || ((code) => { process.exitCode = code; });
    const stunFn    = deps.stunBinding || defaultStun;

    const name = String(subcmd || '').trim();
    if (!name || name === 'help' || name === '--help' || name === '-h')
    {
        out(helpText());
        return 0;
    }
    if (!SUBCOMMANDS.includes(name))
    {
        err(`Unknown webrtc subcommand: "${name}"`);
        out(helpText());
        setExit(1);
        return 1;
    }

    try
    {
        switch (name)
        {
            case 'stun':         await runStun(flags, { out, stunFn });        break;
            case 'turn-creds':   runTurnCreds(flags, { out });                 break;
            case 'join-token':   runJoinToken(flags, { out });                 break;
            case 'verify-token': runVerifyToken(flags, { out });               break;
        }
        return 0;
    }
    catch (e)
    {
        err(`webrtc:${name} failed: ${e.message}`);
        setExit(1);
        return 1;
    }
}

async function runStun(flags, { out, stunFn })
{
    const host    = flagRequired(flags, 'host');
    const port    = flagNumber(flags, 'port', 3478);
    const timeout = flagNumber(flags, 'timeout', 1000);
    const retries = flagNumber(flags, 'retries', 1);
    const result  = await stunFn({ host, port, timeoutMs: timeout, retries });
    out(JSON.stringify(result));
}

function runTurnCreds(flags, { out })
{
    const secret  = flagRequired(flags, 'secret');
    const userId  = flagRequired(flags, 'user');
    const servers = flagList(flags, 'servers');
    if (servers.length === 0)
        throw new Error('--servers is required (comma-separated turn: or turns: URIs)');
    const ttl     = flags.has('ttl') ? flags.get('ttl') : 3600;
    const realm   = flags.has('realm') ? flags.get('realm') : undefined;
    const creds   = issueTurnCredentials({ secret, userId, servers, ttl, realm });
    out(JSON.stringify(creds));
}

function runJoinToken(flags, { out })
{
    const secret = flagRequired(flags, 'secret');
    const room   = flagRequired(flags, 'room');
    const user   = flagRequired(flags, 'user');
    const ttl    = flagNumber(flags, 'ttl', 300);
    const token  = signJoinToken({ secret, user, room, ttl });
    out(token);
}

function runVerifyToken(flags, { out })
{
    const secret = flagRequired(flags, 'secret');
    const token  = flagRequired(flags, 'token');
    const room   = flags.has('room') ? flags.get('room') : undefined;
    const payload = verifyJoinToken(token, { secret, room });
    out(JSON.stringify(payload));
}

function helpText()
{
    return [
        'zs webrtc:* - WebRTC tooling',
        '',
        'Subcommands:',
        '  webrtc:stun         --host H [--port 3478] [--timeout 1000] [--retries 1]',
        '  webrtc:turn-creds   --secret S --user U --servers turn:host:port[,...] [--ttl 3600] [--realm R]',
        '  webrtc:join-token   --secret S --room R --user U [--ttl 300]',
        '  webrtc:verify-token --secret S --token T [--room R]',
        '  webrtc:help         Show this message',
    ].join('\n');
}

module.exports = { runWebRTCCommand, SUBCOMMANDS };
