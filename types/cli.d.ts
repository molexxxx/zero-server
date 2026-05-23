// TypeScript declarations for the bundled CLI runner (`zs` / `zh`).
//
// The CLI lives in `lib/cli.js` and is published both as the `zs` /
// `zh` bin scripts and as a programmatic API on the SDK.  It dispatches
// ORM subcommands (`migrate`, `seed`, `make:*`) to `@zero-server/orm`
// and `webrtc:*` subcommands to `@zero-server/webrtc`, but the runner
// itself is scope-neutral - hence its own declaration file.

/**
 * CLI runner for the bundled `zs` command.
 *
 * Parses `process.argv`-style input, resolves a config file
 * (`zero.config.js` / `.zero-server.js` / `.zero-http.js`), and
 * dispatches to the matching subcommand handler.
 */
export class CLI {
    constructor(argv?: string[]);

    /** The first positional argument (subcommand name). Defaults to `"help"`. */
    readonly command: string;

    /** Remaining positional arguments after the subcommand. */
    readonly args: string[];

    /** Parsed `--flag=value` and `-f value` pairs. */
    readonly flags: Map<string, string>;

    /** Execute the parsed command.  Sets `process.exitCode` on failure. */
    run(): Promise<void>;
}

/**
 * One-shot helper: `new CLI(argv).run()`.
 *
 * @example
 *   const { runCLI } = require('@zero-server/sdk');
 *   await runCLI(['migrate']);
 *   await runCLI(['make:model', 'User', '--dir=src/models']);
 */
export function runCLI(argv?: string[]): Promise<void>;
