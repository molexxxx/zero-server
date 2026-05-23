/**
 * Validates that the TypeScript surface in types/webrtc.d.ts is complete:
 * every export listed in the webrtc scope of `.tools/scope-manifest.js`
 * MUST appear in the .d.ts.  Catches drift between runtime exports and
 * the bundled types that ship in @zero-server/webrtc.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { scopes } = require(path.join(ROOT, '.tools', 'scope-manifest.js'));

const WEBRTC = scopes.find((s) => s.name === 'webrtc');
const DTS_PATH = path.join(ROOT, 'types', 'webrtc.d.ts');
const DTS = fs.readFileSync(DTS_PATH, 'utf8');

/**
 * The .d.ts may declare a symbol as `class X`, `function X`, `const X`,
 * `let X`, `var X`, `enum X`, `interface X`, `type X`, or as a re-export
 * group.  This single regex finds them all on a per-line basis.
 */
function dtsHas(name)
{
    // Match `export declare (class|function|const|let|var|enum) NAME`
    // or `export (interface|type|class|function|const) NAME`
    const re = new RegExp(
        `\\bexport\\s+(?:declare\\s+)?(?:class|function|const|let|var|enum|interface|type|namespace)\\s+${name}\\b`,
    );
    if (re.test(DTS)) return true;
    // Or named re-exports: `export { Foo, NAME, Bar }`
    const grp = new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
    return grp.test(DTS);
}

describe('webrtc TypeScript surface', () =>
{
    it('manifest entry exists', () =>
    {
        expect(WEBRTC).toBeDefined();
        expect(WEBRTC.exports.length).toBeGreaterThan(0);
    });

    it('every manifest export is declared in types/webrtc.d.ts', () =>
    {
        const missing = WEBRTC.exports.filter((name) => !dtsHas(name));
        expect(missing).toEqual([]);
    });

    it('PEER_STATE is declared as a readonly object literal', () =>
    {
        expect(DTS).toMatch(/declare\s+const\s+PEER_STATE\s*:\s*Readonly</);
    });

    it('SignalingHub extends EventEmitter and exposes typed events', () =>
    {
        expect(DTS).toMatch(/class\s+SignalingHub\s+extends\s+EventEmitter/);
        expect(DTS).toMatch(/interface\s+SignalingHubEvents/);
        // Cluster + E2EE events must be in the typed event map
        expect(DTS).toMatch(/e2eeKey\s*:/);
        expect(DTS).toMatch(/clusterError\s*:/);
    });

    it('cluster adapter contract is exported', () =>
    {
        expect(DTS).toMatch(/interface\s+ClusterAdapter/);
        expect(DTS).toMatch(/class\s+MemoryClusterAdapter\s+implements\s+ClusterAdapter/);
    });

    it('E2EE primitives accept Buffer | KeyObject', () =>
    {
        expect(DTS).toMatch(/sealKey\([^)]*KeyObject\s*\|\s*Buffer/);
        expect(DTS).toMatch(/openSealedKey\([^)]*KeyObject\s*\|\s*Buffer/);
    });
});
