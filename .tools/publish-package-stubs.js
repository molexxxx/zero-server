#!/usr/bin/env node
/**
 * publish-package-stubs.js — Publish every packages/* standalone bundle to npm.
 *
 * Each scoped package is a true standalone bundle — it ships its own copy of the
 * relevant lib/ source files and has NO runtime dependency on @zero-server/sdk.
 * The SDK is listed only as an optional peerDependency for TypeScript types.
 *
 * Publishing the SDK first is still recommended so TypeScript consumers can
 * immediately resolve types via the peer, but it is no longer a hard requirement
 * for the bundles to function at runtime.
 *
 * Usage:
 *   node .tools/publish-package-stubs.js              # publish all bundles
 *   node .tools/publish-package-stubs.js --dry-run    # pack + show metadata
 *   node .tools/publish-package-stubs.js --tag next   # publish under a dist-tag
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noProvenance = args.includes('--no-provenance');
const tagIdx = args.indexOf('--tag');
const tag = tagIdx >= 0 ? args[tagIdx + 1] : undefined;
const userconfigIdx = args.indexOf('--userconfig');
const userconfig = userconfigIdx >= 0 ? args[userconfigIdx + 1] : undefined;
const otpIdx = args.indexOf('--otp');
const otp = otpIdx >= 0 ? args[otpIdx + 1] : undefined;

if (!fs.existsSync(PACKAGES_DIR)) {
    console.error(`No packages/ directory found. Run \`npm run packages:generate\` first.`);
    process.exit(1);
}

const dirs = fs.readdirSync(PACKAGES_DIR).filter((entry) => {
    const p = path.join(PACKAGES_DIR, entry);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'package.json'));
});

console.log(`Publishing ${dirs.length} standalone bundles from packages/*${dryRun ? ' (DRY RUN)' : ''}.`);

for (const entry of dirs) {
    const dir = path.join(PACKAGES_DIR, entry);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const argv = ['publish', '--access=public'];
    if (dryRun) argv.push('--dry-run');
    if (tag) argv.push(`--tag=${tag}`);
    if (!noProvenance) argv.push('--provenance');
    if (userconfig) argv.push(`--userconfig=${userconfig}`);
    if (otp) argv.push(`--otp=${otp}`);

    console.log(`\n→ ${pkg.name}@${pkg.version}`);
    const result = spawnSync('npm', argv, { cwd: dir, shell: true, stdio: 'inherit' });
    if (result.status !== 0) {
        console.error(`Failed to publish ${pkg.name}; aborting.`);
        process.exit(result.status ?? 1);
    }
}

console.log(`\nDone${dryRun ? ' (dry run)' : ''}.`);
