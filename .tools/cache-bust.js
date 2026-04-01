/**
 * cache-bust.js
 * Stamps every <link rel="stylesheet" href="...">, <script src="...">,
 * and the window.__v inline version constant in documentation/public/index.html
 * with a ?v=<timestamp> query string.
 * Re-running the script replaces any existing ?v= value.
 *
 * Usage:  node .tools/cache-bust.js
 *         npm run bust:cache
 */

const fs   = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'documentation', 'public', 'index.html');
const version  = Date.now().toString(36);       // compact base-36 timestamp

let html = fs.readFileSync(htmlPath, 'utf8');

// Match href="..." on <link rel="stylesheet"> tags
html = html.replace(
    /(<link\s[^>]*href=")([^"?]+)(?:\?v=[^"]*)?(")/g,
    (m, pre, file, post) => /\.css$/.test(file) ? `${pre}${file}?v=${version}${post}` : m
);

// Match src="..." on <script> tags (skip inline scripts)
html = html.replace(
    /(<script\s[^>]*src=")([^"?]+)(?:\?v=[^"]*)?(")/g,
    (_, pre, file, post) => `${pre}${file}?v=${version}${post}`
);

// Stamp the inline window.__v constant (used by data/manifest/section fetches)
html = html.replace(
    /window\.__v\s*=\s*'[^']*'/,
    `window.__v='${version}'`
);

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`Cache-busted index.html with v=${version} (assets + data fetches)`);
