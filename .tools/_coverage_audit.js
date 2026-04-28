// Discover exact uncovered statements, branches, functions for target files
const fs = require('fs');
const cov = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'));

const targets = ['cluster.js', 'errors.js', 'debug.js', 'cli.js', 'lifecycle.js', 'app.js'];

for (const [filePath, data] of Object.entries(cov)) {
    const basename = filePath.replace(/.*[\\/]/, '');
    if (!targets.includes(basename)) continue;
    if (!filePath.match(/lib[\\/](app|cluster|cli|debug|errors|lifecycle)\.js$/)) continue;
    
    console.log(`\n=== ${basename} ===`);
    
    // Uncovered statements
    const uncoveredStmts = [];
    for (const [id, count] of Object.entries(data.s)) {
        if (count === 0) {
            const loc = data.statementMap[id];
            uncoveredStmts.push(loc.start.line);
        }
    }
    console.log(`Uncovered statements (${uncoveredStmts.length}):`, uncoveredStmts.sort((a,b)=>a-b).join(', '));
    
    // Uncovered branches
    const uncoveredBranches = [];
    for (const [id, counts] of Object.entries(data.b)) {
        for (let i = 0; i < counts.length; i++) {
            if (counts[i] === 0) {
                const loc = data.branchMap[id].locations[i];
                uncoveredBranches.push(`L${loc.start.line}:${loc.start.column}(${data.branchMap[id].type})`);
            }
        }
    }
    console.log(`Uncovered branches (${uncoveredBranches.length}):`, uncoveredBranches.join(', '));
    
    // Uncovered functions
    const uncoveredFns = [];
    for (const [id, count] of Object.entries(data.f)) {
        if (count === 0) {
            const loc = data.fnMap[id];
            uncoveredFns.push(`L${loc.loc.start.line}:${loc.name || 'anon'}`);
        }
    }
    console.log(`Uncovered functions (${uncoveredFns.length}):`, uncoveredFns.join(', '));
}
