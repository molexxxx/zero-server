/**
 * Vets the generated `packages/@zero-server/*` scoped packages against
 * `.tools/scope-manifest.js` and the live SDK. This guards against:
 *   - Manifest entries that no longer exist on the SDK (typos / removed exports).
 *   - Generated package stubs drifting from the manifest (someone editing them
 *     by hand instead of re-running `npm run packages:generate`).
 *   - package.json metadata regressions (wrong name, missing dep, etc.).
 *
 * Each scoped package is now a TRUE STANDALONE bundle — it ships its own copy
 * of the lib/ source and has NO runtime dep on @zero-server/sdk.  Cross-scope
 * deps (e.g. @zero-server/auth → @zero-server/fetch) are redirected to local
 * packages/ so the test works without a real npm install.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sdk = require(path.join(ROOT, 'index.js'));
const { scopes } = require(path.join(ROOT, '.tools', 'scope-manifest.js'));

// Redirect ALL @zero-server/* requires to local packages/ so cross-scope deps
// resolve without a real npm install.
const PACKAGES_DIR = path.join(ROOT, 'packages');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
    if (request === '@zero-server/sdk') return path.join(ROOT, 'index.js');
    if (request.startsWith('@zero-server/')) {
        const name = request.slice('@zero-server/'.length);
        const local = path.join(PACKAGES_DIR, name, 'index.js');
        if (fs.existsSync(local)) return local;
    }
    return origResolve.call(this, request, parent, ...rest);
};

// `packages/` is git-ignored (regenerated on every release). Make sure stubs
// exist before the assertions run so the test passes on a fresh CI checkout.
beforeAll(() => {
    const needsGenerate = scopes.some((s) => {
        const dir = path.join(PACKAGES_DIR, s.name);
        return !fs.existsSync(path.join(dir, 'index.js'))
            || !fs.existsSync(path.join(dir, 'index.d.ts'))
            || !fs.existsSync(path.join(dir, 'package.json'));
    });
    if (needsGenerate) {
        execFileSync(
            process.execPath,
            [path.join(ROOT, '.tools', 'generate-package-stubs.js')],
            { cwd: ROOT, stdio: 'inherit' },
        );
    }
});

describe('scoped packages — manifest', () => {
    it('manifest defines at least one scope', () => {
        expect(Array.isArray(scopes)).toBe(true);
        expect(scopes.length).toBeGreaterThan(0);
    });

    it('every manifest export resolves on the SDK', () => {
        const missing = [];
        for (const scope of scopes) {
            for (const name of scope.exports) {
                if (!(name in sdk) || typeof sdk[name] === 'undefined') {
                    missing.push(`${scope.name}: ${name}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('manifest scope names are unique', () => {
        const names = scopes.map((s) => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('manifest export names are unique within each scope', () => {
        for (const scope of scopes) {
            expect(new Set(scope.exports).size).toBe(scope.exports.length);
        }
    });
});

describe('scoped packages — generated stubs', () => {
    it('packages/ directory exists', () => {
        expect(fs.existsSync(PACKAGES_DIR)).toBe(true);
    });

    for (const scope of scopes) {
        describe(`@zero-server/${scope.name}`, () => {
            const dir = path.join(PACKAGES_DIR, scope.name);

            it('directory exists with index.js, index.d.ts, package.json', () => {
                expect(fs.existsSync(dir)).toBe(true);
                expect(fs.existsSync(path.join(dir, 'index.js'))).toBe(true);
                expect(fs.existsSync(path.join(dir, 'index.d.ts'))).toBe(true);
                expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
            });

            it('package.json metadata is correct', () => {
                const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
                expect(pkg.name).toBe(`@zero-server/${scope.name}`);
                expect(pkg.version).toBe(PKG.version);
                expect(pkg.main).toBe('./index.js');
                expect(pkg.types).toBe('./index.d.ts');
                expect(pkg.engines && pkg.engines.node).toBe('>=18.0.0');
                // SDK must NOT be a hard runtime dependency anymore — it is an
                // optional peerDependency used only for TypeScript types.
                expect(pkg.dependencies && pkg.dependencies['@zero-server/sdk']).toBeUndefined();
                expect(pkg.peerDependencies && pkg.peerDependencies['@zero-server/sdk']).toBeDefined();
                expect(pkg.peerDependenciesMeta?.['@zero-server/sdk']?.optional).toBe(true);
                // Scopes that have cross-scope deps must list them correctly
                if (scope.pkgDependencies) {
                    for (const [dep, val] of Object.entries(scope.pkgDependencies)) {
                        const expected = val === true ? PKG.version : val;
                        expect(pkg.dependencies && pkg.dependencies[dep]).toBe(expected);
                    }
                }
            });

            it('index.js loads and re-exports exactly the manifest surface', () => {
                // Bust the require cache so we get a clean load with the patched resolver.
                const entry = path.join(dir, 'index.js');
                // Clear this package and anything in its lib/ from the cache
                for (const key of Object.keys(require.cache)) {
                    if (key.startsWith(dir)) delete require.cache[key];
                }
                const mod = require(entry);

                // Every manifest export must be present and have the same type as the SDK's.
                for (const name of scope.exports) {
                    expect(mod[name], `missing ${scope.name}.${name}`).toBeDefined();
                    // Standalone packages load their own module instances so strict
                    // identity (===) won't hold; check type equality instead.
                    expect(typeof mod[name]).toBe(typeof sdk[name]);
                }

                // Package must not leak surface from other scopes.
                const expected = new Set(scope.exports);
                const extras = Object.keys(mod).filter((k) => !expected.has(k));
                expect(extras).toEqual([]);
            });

            it('index.d.ts re-exports the manifest surface from the SDK', () => {
                const dts = fs.readFileSync(path.join(dir, 'index.d.ts'), 'utf8');
                expect(dts).toMatch(/from\s+["']@zero-server\/sdk["']/);
                for (const name of scope.exports) {
                    // Word-boundary match avoids false positives on substrings.
                    expect(dts).toMatch(new RegExp(`\\b${name}\\b`));
                }
            });
        });
    }
});

describe('scoped packages — coverage of SDK surface', () => {
    it('every SDK value export belongs to at least one scope', () => {
        const covered = new Set();
        for (const scope of scopes) {
            for (const name of scope.exports) covered.add(name);
        }
        const sdkNames = Object.keys(sdk);
        const orphans = sdkNames.filter((name) => !covered.has(name));
        // Anything in this list either needs adding to scope-manifest.js or
        // explicitly opting out below. Currently nothing should be uncovered.
        expect(orphans).toEqual([]);
    });
});
