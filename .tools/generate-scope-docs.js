#!/usr/bin/env node
/**
 * generate-scope-docs.js — Per-scope documentation.
 *
 * For each scope in .tools/scope-manifest.js this writes:
 *
 *   docs/scopes/<name>.md           long-form scope page (web-friendly).
 *   docs/scopes/README.md           index of all scopes.
 *   packages/<name>/README.md       per-package README published to npm.
 *
 * The site / API.md build owns the full reference; this script focuses on
 * the per-package surface so npm pages and the repo `docs/scopes/` index
 * stay accurate.
 *
 * Usage:  npm run packages:docs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { scopes } = require('./scope-manifest');

const SCOPES_DIR = path.join(ROOT, 'docs', 'scopes');
fs.mkdirSync(SCOPES_DIR, { recursive: true });

function pickUsageImport(scope) {
    const factory = scope.exports.find((n) => /^create[A-Z]/.test(n));
    const sample = factory ? [factory] : scope.exports.slice(0, Math.min(3, scope.exports.length));
    return `const { ${sample.join(', ')} } = require('@zero-server/${scope.name}')`;
}

function exportsTable(scope) {
    if (scope.exports.length === 0) return '_None._';
    const rows = scope.exports.map((name) => `| \`${name}\` |`);
    return `| Symbol |\n| --- |\n${rows.join('\n')}`;
}

const indexRows = ['| Package | Summary |', '| --- | --- |'];

for (const scope of scopes) {
    const pageFile = path.join(SCOPES_DIR, `${scope.name}.md`);
    const body = [
        `# ${scope.title}`,
        '',
        `> ${scope.summary}`,
        '',
        '## Install',
        '',
        '```bash',
        `npm install @zero-server/${scope.name}`,
        '```',
        '',
        '_Or install everything via the meta-package:_',
        '',
        '```bash',
        'npm install @zero-server/sdk',
        '```',
        '',
        '## Overview',
        '',
        scope.description,
        '',
        '## Usage',
        '',
        '```js',
        pickUsageImport(scope),
        '```',
        '',
        '## Public surface',
        '',
        `\`@zero-server/${scope.name}\` re-exports the following names from [\`@zero-server/sdk\`](https://www.npmjs.com/package/@zero-server/sdk):`,
        '',
        exportsTable(scope),
        '',
        '## See also',
        '',
        '- [Top-level README](../../README.md)',
        '- [Full API reference](../../API.md)',
        `- [Live docs site](https://z-server.com)`,
        `- [\`packages/${scope.name}\`](../../packages/${scope.name})`,
        '',
    ].join('\n');
    fs.writeFileSync(pageFile, body);

    const pkgDir = path.join(ROOT, 'packages', scope.name);
    if (fs.existsSync(pkgDir)) {
        const pkgReadme = [
            `# @zero-server/${scope.name}`,
            '',
            `> ${scope.summary}`,
            '',
            scope.description,
            '',
            '## Install',
            '',
            '```bash',
            `npm install @zero-server/${scope.name}`,
            '```',
            '',
            'Or pull in the entire SDK at once:',
            '',
            '```bash',
            'npm install @zero-server/sdk',
            '```',
            '',
            '## Usage',
            '',
            '```js',
            pickUsageImport(scope),
            '```',
            '',
            '## Public surface',
            '',
            `This package narrows \`@zero-server/sdk\` to **${scope.exports.length}** exports. See the [scope page](https://github.com/tonywied17/zero-server/blob/main/docs/scopes/${scope.name}.md#public-surface) for the full list.`,
            '',
            '## Documentation',
            '',
            '- [Scope page](https://github.com/tonywied17/zero-server/blob/main/docs/scopes/' + scope.name + '.md)',
            '- [Full API reference](https://github.com/tonywied17/zero-server/blob/main/API.md)',
            '- [Live docs](https://z-server.com)',
            '',
            '## License',
            '',
            `${PKG.license} © ${PKG.author}`,
            '',
        ].join('\n');
        fs.writeFileSync(path.join(pkgDir, 'README.md'), pkgReadme);
    }

    indexRows.push(`| [\`@zero-server/${scope.name}\`](./${scope.name}.md) | ${scope.summary} |`);
}

const indexBody = [
    '# Scoped packages',
    '',
    '> The full SDK lives at [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk). Every scope below is published as its own narrow package and pinned to the same version.',
    '',
    ...indexRows,
    '',
].join('\n');
fs.writeFileSync(path.join(SCOPES_DIR, 'README.md'), indexBody);

console.log(`Wrote ${scopes.length} scope pages to docs/scopes/ and ${scopes.length} package READMEs.`);
