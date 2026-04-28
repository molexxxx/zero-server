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
        const rel = filePath.replace(/\\/g, '/').replace(/^.*\/zero-server\//, '').replace(/^.*[/]lib[/]/, 'lib/');
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
function shieldUrl(label, message, color, opts = {}) {
    const l = encodeURIComponent(label);
    const m = encodeURIComponent(message);
    const params = [];
    if (opts.style) params.push(`style=${opts.style}`);
    if (opts.logo) params.push(`logo=${opts.logo}`);
    if (opts.logoColor) params.push(`logoColor=${opts.logoColor}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return `https://img.shields.io/badge/${l}-${m}-${color}${qs}`;
}

function coverageColor(pct) {
    if (pct >= 90) return 'brightgreen';
    if (pct >= 75) return 'green';
    if (pct >= 60) return 'yellowgreen';
    if (pct >= 40) return 'yellow';
    return 'red';
}

const BADGE_STYLE = { style: 'flat-square', logo: 'vitest', logoColor: 'white' };

const testsMessage = allPassed ? `${tests.passed} passing` : `${tests.failed}/${tests.total} failed`;
const testsColor   = allPassed ? 'brightgreen' : 'red';
const covColor     = coverageColor(coverage.statements);

const badges = {
    tests: {
        label: 'tests',
        message: testsMessage,
        color: testsColor,
        url: shieldUrl('tests', testsMessage, testsColor, BADGE_STYLE),
    },
    coverage: {
        label: 'coverage',
        message: `${coverage.statements}%`,
        color: covColor,
        url: shieldUrl('coverage', `${coverage.statements}%`, covColor, BADGE_STYLE),
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

// Replace inline <img> badge rows for tests and coverage (flat-square style)
const testsImgRe = /<img src="https:\/\/img\.shields\.io\/badge\/tests-[^"]+" alt="tests">/;
const covImgRe   = /<img src="https:\/\/img\.shields\.io\/badge\/coverage-[^"]+" alt="coverage">/;

const testsImg = `<img src="${badges.tests.url}" alt="tests">`;
const covImg   = `<img src="${badges.coverage.url}" alt="coverage">`;

if (testsImgRe.test(readme)) readme = readme.replace(testsImgRe, testsImg);
if (covImgRe.test(readme))   readme = readme.replace(covImgRe, covImg);

fs.writeFileSync(readmePath, readme, 'utf8');
console.log(`Updated README.md — tests: ${tests.passed}/${tests.total}, coverage: ${coverage.statements}%`);

/* -- 6. Clean up temp file ------------------------------------------ */
try { fs.unlinkSync(resultsPath); } catch {}
