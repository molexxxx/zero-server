/**
 * build-badges.js
 * Runs the test suite with coverage, then:
 *   1. Writes documentation/public/data/badges.json  (consumed by website)
 *   2. Updates README.md badge row with live counts
 *
 * Usage:  npm run badges
 */

const { execSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const root     = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const resultsPath = path.join(root, 'test-results.json');
const coveragePath = path.join(root, 'coverage', 'coverage-summary.json');
const badgesOut  = path.join(root, 'documentation', 'public', 'data', 'badges.json');

/* -- 1. Run tests with coverage + JSON reporter --------------------- */
console.log('Running tests with coverage…');
try {
    execSync('npx vitest run --coverage --reporter=json --outputFile=test-results.json', {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
} catch {
    // vitest exits non-zero on test failure
}

/* -- 2. Parse results ----------------------------------------------- */
let tests = { total: 0, passed: 0, failed: 0 };
let testSuites = [];
if (fs.existsSync(resultsPath)) {
    const j = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    tests = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests };
    // Per-suite breakdown for the website modal
    if (Array.isArray(j.testResults)) {
        testSuites = j.testResults.map(s => ({
            file: s.name.replace(/^.*[/\\]test[/\\]/, ''),
            status: s.status,
            tests: (s.assertionResults || []).length,
            duration: Math.round((s.endTime || 0) - (s.startTime || 0)),
        })).sort((a, b) => a.file.localeCompare(b.file));
    }
}

let coverage = { lines: 0, statements: 0, functions: 0, branches: 0 };
let coverageFiles = [];
if (fs.existsSync(coveragePath)) {
    const raw = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    const c = raw.total;
    coverage = {
        lines: c.lines.pct,
        statements: c.statements.pct,
        functions: c.functions.pct,
        branches: c.branches.pct,
    };
    // Per-file coverage breakdown grouped by directory
    for (const [filePath, data] of Object.entries(raw)) {
        if (filePath === 'total') continue;
        const rel = filePath.replace(/\\/g, '/').replace(/^.*\/zero-http-npm\//, '').replace(/^.*[/]lib[/]/, 'lib/');
        coverageFiles.push({
            file: rel,
            statements: data.statements.pct,
            branches: data.branches.pct,
            functions: data.functions.pct,
            lines: data.lines.pct,
        });
    }
    coverageFiles.sort((a, b) => a.file.localeCompare(b.file));
}

const allPassed = tests.failed === 0 && tests.total > 0;

/* -- 3. Build badge URLs -------------------------------------------- */
function shieldUrl(label, message, color) {
    const l = encodeURIComponent(label);
    const m = encodeURIComponent(message);
    return `https://img.shields.io/badge/${l}-${m}-${color}.svg`;
}

function coverageColor(pct) {
    if (pct >= 90) return 'brightgreen';
    if (pct >= 75) return 'green';
    if (pct >= 60) return 'yellowgreen';
    if (pct >= 40) return 'yellow';
    return 'red';
}

const badges = {
    tests: {
        label: 'tests',
        message: allPassed ? `${tests.passed} passed` : `${tests.failed}/${tests.total} failed`,
        color: allPassed ? 'brightgreen' : 'red',
        url: shieldUrl('tests', allPassed ? `${tests.passed} passed` : `${tests.failed}/${tests.total} failed`, allPassed ? 'brightgreen' : 'red'),
    },
    coverage: {
        label: 'coverage',
        message: `${coverage.statements}%`,
        color: coverageColor(coverage.statements),
        url: shieldUrl('coverage', `${coverage.statements}%`, coverageColor(coverage.statements)),
    },
    /* raw numbers for website display */
    raw: { tests, coverage, testSuites, coverageFiles },
};

/* -- 4. Write badges.json for the website --------------------------- */
fs.mkdirSync(path.dirname(badgesOut), { recursive: true });
fs.writeFileSync(badgesOut, JSON.stringify(badges, null, 2), 'utf8');
console.log(`Wrote ${path.relative(root, badgesOut)}`);

/* -- 5. Update README.md -------------------------------------------- */
let readme = fs.readFileSync(readmePath, 'utf8');

const testsBadge   = `[![Tests](${badges.tests.url})](https://github.com/tonywied17/zero-http/actions)`;
const covBadge     = `[![Coverage](${badges.coverage.url})](https://github.com/tonywied17/zero-http)`;

// Replace or insert the test/coverage badge lines
const badgeRowRe = /\[!\[Tests\].*?\n\[!\[Coverage\].*?\n/;
const newBadgeRow = `${testsBadge}\n${covBadge}\n`;

if (badgeRowRe.test(readme)) {
    readme = readme.replace(badgeRowRe, newBadgeRow);
} else {
    // Insert after the Dependencies badge line
    readme = readme.replace(
        /(\[!\[Dependencies\].*?\n)/,
        `$1${testsBadge}\n${covBadge}\n`
    );
}

fs.writeFileSync(readmePath, readme, 'utf8');
console.log(`Updated README.md — tests: ${tests.passed}/${tests.total}, coverage: ${coverage.statements}%`);

/* -- 6. Clean up temp file ------------------------------------------ */
try { fs.unlinkSync(resultsPath); } catch {}
