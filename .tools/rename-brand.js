const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const targets = [];

function walk(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const p = path.join(abs, e.name);
        const relP = path.relative(ROOT, p);
        if (e.isDirectory()) {
            if (['node_modules', '.git', 'coverage', '.myshit'].includes(e.name)) continue;
            // Skip historical versioned data archives — keep them frozen
            if (relP.replace(/\\/g, '/').startsWith('documentation/public/data/versions')) continue;
            walk(relP);
        } else if (/\.(js|mjs|md|html|css|json|d\.ts)$/.test(e.name)) {
            targets.push(p);
        }
    }
}

walk('lib');
walk('types');
walk('test');
walk('documentation');
walk('.tools');
for (const f of ['index.js', 'README.md', 'API.md']) {
    targets.push(path.join(ROOT, f));
}

let changed = 0;
for (const f of targets) {
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    const o = s;

    // require('@zero-server/sdk') -> require('@zero-server/sdk')
    s = s.replace(/require\(\s*'zero-http'\s*\)/g, "require('@zero-server/sdk')");
    s = s.replace(/from\s+'zero-http'/g, "from '@zero-server/sdk'");
    s = s.replace(/from\s+"zero-http"/g, 'from "@zero-server/sdk"');

    // JSDoc module names
    s = s.replace(/@module @zero-server/sdk\b/g, '@module @zero-server/sdk');

    // npm install
    s = s.replace(/npm install @zero-server/sdk\b/g, 'npm install @zero-server/sdk');

    // npmjs / github / homepage
    s = s.replace(/npmjs\.com\/package\/zero-http/g, 'npmjs.com/package/@zero-server/sdk');
    s = s.replace(/github\.com\/tonywied17\/zero-http\b/g, 'github.com/tonywied17/zero-server');
    s = s.replace(/zero-http\.git/g, 'zero-server.git');
    s = s.replace(/zero-server/g, 'zero-server');
    s = s.replace(/z-http\.com/g, 'z-server.dev');

    // Brand text replacements (descriptions, titles, comments, doc strings)
    s = s.replace(/zero-server is a zero-dependency/gi, 'zero-server is a zero-dependency');
    s = s.replace(/Zero-dependency backend framework/g, 'Zero-dependency backend framework');
    s = s.replace(/the @zero-server/sdk package\b/g, 'the @zero-server/sdk package');
    s = s.replace(/Public entry point for the @zero-server/sdk package/g, 'Public entry point for the @zero-server/sdk package');
    s = s.replace(/zero-server applications\b/g, 'zero-server applications');
    s = s.replace(/zero-server docs build/g, 'zero-server docs build');
    s = s.replace(/zero-server docs/g, 'zero-server docs');
    s = s.replace(/zero-server ORM\b/g, 'zero-server ORM');
    s = s.replace(/zero-http (App|fetch|server|application|framework)/g, 'zero-server $1');
    s = s.replace(/Public entry point for the @zero-server/sdk\b/g, 'Public entry point for the @zero-server/sdk');

    // HTML / meta
    s = s.replace(/<title>zero-server\b/g, '<title>zero-server');
    s = s.replace(/<h1 align="center">zero-http<\/h1>/g, '<h1 align="center">zero-server</h1>');
    s = s.replace(/zero-server — API Reference/g, 'zero-server — API Reference');
    s = s.replace(/zero-server — demo & reference/g, 'zero-server — demo & reference');
    s = s.replace(/zero-server — Zero-dependency/g, 'zero-server — Zero-dependency');
    s = s.replace(/alt="zero-server logo"/g, 'alt="zero-server logo"');
    s = s.replace(/zero-server animated logo/g, 'zero-server animated logo');
    s = s.replace(/aria-label="zero-server\b/g, 'aria-label="zero-server');
    s = s.replace(/content="zero-server"/g, 'content="zero-server"');
    s = s.replace(/(<meta[^>]+(?:og:title|twitter:title)[^>]+content=")zero-http\b/g, '$1zero-server');
    s = s.replace(/zero-http\s+<span id="version-badge"/g, 'zero-server <span id="version-badge"');
    s = s.replace(/class="logo">zero-server\b/g, 'class="logo">zero-server');
    s = s.replace(/Native syntax highlighter for the zero-server\b/g, 'Native syntax highlighter for the zero-server');
    s = s.replace(/WebSocket support for zero-http\./g, 'WebSocket support for zero-server.');
    s = s.replace(/Server-Sent Events support for zero-http\./g, 'Server-Sent Events support for zero-server.');
    s = s.replace(/CLI tool for zero-server\b/g, 'CLI tool for zero-server');
    s = s.replace(/zh CLI'\)\}\s+— zero-http\b/g, "zh CLI')} — zero-server");
    s = s.replace(/zh v\$\{pkg\.version\} \(zero-http\)/g, 'zh v${pkg.version} (zero-server)');
    s = s.replace(/zero-server version\b/g, 'zero-server version');
    s = s.replace(/Versioned migration framework for the zero-server\b/g, 'Versioned migration framework for the zero-server');
    s = s.replace(/Query caching layer for the zero-server\b/g, 'Query caching layer for the zero-server');
    s = s.replace(/Plugin system for the zero-server\b/g, 'Plugin system for the zero-server');
    s = s.replace(/Redis database adapter for the zero-server\b/g, 'Redis database adapter for the zero-server');
    s = s.replace(/gRPC server for zero-server\b/g, 'gRPC server for zero-server');
    s = s.replace(/The zero-server App instance/g, 'The zero-server App instance');
    s = s.replace(/Wraps the zero-server fetch\b/g, 'Wraps the zero-server fetch');
    s = s.replace(/Manages a cluster of worker processes for a zero-server\b/g, 'Manages a cluster of worker processes for a zero-server');

    // .Schema accessor in API.md edge case
    s = s.replace(/'zero-http'\)\.Schema/g, "'@zero-server/sdk').Schema");

    // Top-level README header
    s = s.replace(/<h1 align="center">zero-http<\/h1>/g, '<h1 align="center">zero-server</h1>');
    s = s.replace(/img\.shields\.io\/npm\/v\/zero-http\.svg/g, 'img.shields.io/npm/v/%40zero-server%2Fsdk.svg');
    s = s.replace(/img\.shields\.io\/npm\/dm\/zero-http\.svg/g, 'img.shields.io/npm/dm/%40zero-server%2Fsdk.svg');
    s = s.replace(/zero--server/g, 'zero--server');

    // Keep CLI binary `zh` (back-compat) and `zero.config.js`/`.zero-http.js` filename — leave .zero-http.js as legacy fallback

    if (s !== o) {
        fs.writeFileSync(f, s);
        changed++;
    }
}
console.log('updated', changed, 'files');
