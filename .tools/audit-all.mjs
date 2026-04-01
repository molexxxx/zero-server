/**
 * Full audit of all documentation JSON files.
 * Checks:
 *  1. Signature params vs methodParams names
 *  2. methodParams that aren't in the signature
 *  3. methodOptions whose names collide with signature params (should be sub-fields only)
 *  4. Empty/missing descriptions
 *  5. Missing methodReturns
 *  6. Duplicate method names within the same item
 *  7. perPage/default "15" (known wrong value)
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';

const DIR = resolve('documentation/public/data/sections');
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

let totalErrors = 0;
let totalWarnings = 0;

function parseSigParams(sig) {
  if (!sig) return [];
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      let raw = s.replace(/^\[/, '').replace(/\]$/, '').replace(/\s*=\s*.*$/, '');
      // strip leading ...
      const rest = raw.startsWith('...');
      if (rest) raw = raw.slice(3);
      return { name: raw, rest, raw: s };
    });
}

function error(file, item, method, msg) {
  console.log(`  ❌ [${file}] ${item} > ${method}: ${msg}`);
  totalErrors++;
}
function warn(file, item, method, msg) {
  console.log(`  ⚠️  [${file}] ${item} > ${method}: ${msg}`);
  totalWarnings++;
}

for (const file of files) {
  const fp = resolve(DIR, file);
  let json;
  try { json = JSON.parse(readFileSync(fp, 'utf8')); }
  catch (e) { console.log(`  ❌ ${file}: invalid JSON — ${e.message}`); totalErrors++; continue; }

  const items = json.items || [];
  for (const item of items) {
    const itemName = item.name || '(unnamed)';

    // Check item-level options for empty notes
    if (Array.isArray(item.options)) {
      for (const opt of item.options) {
        if (!opt.notes || !opt.notes.trim()) {
          warn(file, itemName, `[item option: ${opt.option}]`, 'empty notes');
        }
      }
    }

    const seenMethods = new Map(); // track duplicates within same item
    const groups = item.methodGroups || [];
    for (const group of groups) {
      const methods = group.methods || [];
      for (const m of methods) {
        const mName = m.method || '(unnamed)';
        const sig = m.signature || '';
        const key = `${mName}__${sig}`;

        // Duplicate check
        if (seenMethods.has(key)) {
          error(file, itemName, sig, `duplicate method entry (same name + signature)`);
        }
        seenMethods.set(key, true);

        // Parse signature params
        const sigParams = parseSigParams(sig);
        const sigParamNames = new Set(sigParams.map(p => p.name));

        // Check methodParams
        const mParams = m.methodParams || [];
        const paramNames = new Set(mParams.map(p => p.param));

        // 1. Sig params missing from methodParams
        for (const sp of sigParams) {
          // skip ...rest style params — name may differ slightly
          const found = mParams.some(p => {
            const pName = p.param.replace(/^\.\.\./, '');
            return pName === sp.name || pName === sp.name.replace(/^\.\.\./, '');
          });
          if (!found && mParams.length > 0) {
            error(file, itemName, sig, `sig param "${sp.name}" missing from methodParams`);
          }
          if (!found && mParams.length === 0 && sigParams.length > 0) {
            // Empty methodParams but sig has params
            const isProperty = !sig.includes('('); // properties like req.xhr don't need params
            if (!isProperty) {
              error(file, itemName, sig, `sig param "${sp.name}" — methodParams is empty`);
            }
          }
        }

        // 2. methodParams not in signature
        for (const mp of mParams) {
          const mpName = mp.param.replace(/^\.\.\./, '');
          const found = sigParams.some(sp => sp.name === mpName || sp.name === '...' + mpName);
          if (!found) {
            error(file, itemName, sig, `methodParam "${mp.param}" not in signature`);
          }
        }

        // 3. methodOptions whose names match sig params (should be sub-fields only)
        if (Array.isArray(m.methodOptions) && m.methodOptions.length) {
          for (const opt of m.methodOptions) {
            if (sigParamNames.has(opt.option)) {
              warn(file, itemName, sig, `methodOption "${opt.option}" collides with sig param — should be a sub-field, not a positional`);
            }
          }
        }

        // 4. Empty description
        if (!m.description || !m.description.trim()) {
          warn(file, itemName, sig, 'empty method description');
        }

        // 5. Empty param notes
        for (const mp of mParams) {
          if (!mp.notes || !mp.notes.trim()) {
            warn(file, itemName, sig, `param "${mp.param}" has empty notes`);
          }
          // Check required field
          if (mp.required !== 'Yes' && mp.required !== 'No') {
            warn(file, itemName, sig, `param "${mp.param}" has non-standard required value: "${mp.required}"`);
          }
        }

        // 6. Check methodOptions for empty notes
        if (Array.isArray(m.methodOptions)) {
          for (const opt of m.methodOptions) {
            if (!opt.notes || !opt.notes.trim()) {
              warn(file, itemName, sig, `option "${opt.option}" has empty notes`);
            }
          }
        }

        // 7. Check for wrong default "15" for perPage
        for (const mp of mParams) {
          if (/perPage/i.test(mp.param) && mp.notes && /default:\s*15\b/.test(mp.notes)) {
            error(file, itemName, sig, `param "${mp.param}" says default 15 — should be 20`);
          }
        }
        if (Array.isArray(m.methodOptions)) {
          for (const opt of m.methodOptions) {
            if (/perPage/i.test(opt.option) && opt.default === '15') {
              error(file, itemName, sig, `option "${opt.option}" default is 15 — should be 20`);
            }
          }
        }

        // 8. Missing methodReturns
        if (!m.methodReturns) {
          warn(file, itemName, sig, 'no methodReturns');
        }
      }
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Audit complete: ${totalErrors} errors, ${totalWarnings} warnings`);
if (totalErrors === 0) console.log('✅ No errors found — ready to publish!');
else console.log('❌ Fix errors before publishing.');
