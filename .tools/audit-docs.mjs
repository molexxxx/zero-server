/**
 * Documentation Audit Script
 * 
 * Compares the types/*.d.ts declarations against
 * documentation/public/data/sections/*.json to find:
 *   1. Methods/options in types but missing from docs        (ERROR)
 *   2. Methods/options in docs but NOT in types (ghosts)     (WARN)
 *   3. Items that exist but have empty descriptions/notes    (WARN)
 *   4. Structural warnings (parser limitations)              (WARN)
 */

import { join } from 'path';
import {
  ROOT, TYPES_TO_DOCS_MAP, SKIP_TYPE_MEMBERS, DOC_ONLY_METHODS,
  loadAllTypes, loadAllDocs,
} from './shared-parser.mjs';

// --- Load --------------------------------------------------------

const allTypes = loadAllTypes();
const allDocs = loadAllDocs();

// --- Compare -----------------------------------------------------

const issues = [];
let warningCount = 0;
let errorCount = 0;

function addIssue(severity, section, item, message) {
  issues.push({ severity, section, item, message });
  if (severity === 'ERROR') errorCount++;
  else warningCount++;
}

// --- Forward check: types → docs ---------------------------------

for (const [mapKey, mapDef] of Object.entries(TYPES_TO_DOCS_MAP)) {
  const typeFile = mapKey.split(':')[0];
  const typeData = allTypes[typeFile];
  const docData = allDocs[mapDef.docFile];

  if (!typeData) {
    addIssue('ERROR', mapDef.docFile, '*', `Types file not found: ${typeFile}`);
    continue;
  }
  if (!docData) {
    addIssue('ERROR', typeFile, '*', `Doc file not found: ${mapDef.docFile}`);
    continue;
  }

  for (const mapping of mapDef.mappings) {
    const docItem = docData.items.find(i => i.name === mapping.docName);

    if (!docItem) {
      addIssue('ERROR', docData.section, mapping.docName, `Doc item "${mapping.docName}" not found in ${mapDef.docFile}`);
      continue;
    }

    if (mapping.kind === 'options' || mapping.kind === 'options-interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (!iface) {
        addIssue('WARN', docData.section, mapping.docName, `Options interface "${mapping.typeName}" not found in types (may be in a different file)`);
        continue;
      }

      const typeProps = [...iface.properties, ...iface.methods];
      const docOpts = docItem.options;

      const allDocMethodOpts = [];
      for (const mi of docItem.methodsWithInfo) {
        allDocMethodOpts.push(...mi.optionNames);
      }

      for (const prop of typeProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        const prefix = mapping.role || '';
        const found = docOpts.includes(prop) || allDocMethodOpts.includes(prop)
          || (prefix && docOpts.some(o => o === `${prefix}.${prop}`));
        if (!found) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Option "${prop}" from ${mapping.typeName} is MISSING from docs`);
        }
      }

      for (const opt of docOpts) {
        const prefix = mapping.role || '';
        const bare = (prefix && opt.startsWith(prefix + '.')) ? opt.slice(prefix.length + 1) : opt;
        if (!typeProps.includes(opt) && !typeProps.includes(bare)) {
          addIssue('WARN', docData.section, `${mapping.docName}`, `Documented option "${opt}" not found in ${mapping.typeName} type definition`);
        }
      }
    }

    if (mapping.kind === 'interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (!iface) continue;

      const typeMethods = iface.methods;
      const typeProps = iface.properties;
      const docMethods = docItem.methods;

      for (const method of typeMethods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (!docMethods.includes(method)) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Method "${method}()" from ${mapping.typeName} is MISSING from docs`);
        }
      }

      for (const prop of typeProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        if (!docMethods.includes(prop) && !docItem.options.includes(prop)) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Property "${prop}" from ${mapping.typeName} is MISSING from docs`);
        }
      }
    }

    if (mapping.kind === 'class') {
      const cls = typeData.classes[mapping.typeName];
      if (!cls) {
        addIssue('WARN', docData.section, mapping.docName, `Class "${mapping.typeName}" not found in parsed types`);
        continue;
      }

      const docMethods = docItem.methods;

      for (const method of cls.staticMethods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (!docMethods.includes(method)) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Static method "${mapping.typeName}.${method}()" is MISSING from docs`);
        }
      }

      for (const method of cls.instanceMethods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (!docMethods.includes(method)) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Instance method "${mapping.typeName}#${method}()" is MISSING from docs`);
        }
      }

      for (const prop of cls.staticProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        if (!docMethods.includes(prop) && !docItem.options.includes(prop)) {
          addIssue('ERROR', docData.section, `${mapping.docName}`, `Static property "${mapping.typeName}.${prop}" is MISSING from docs`);
        }
      }
    }
  }
}

// --- Reverse check: doc methods → types --------------------------
// Catches ghost methods added to docs that don't exist in types.

const typeMembers = {};

for (const [mapKey, mapDef] of Object.entries(TYPES_TO_DOCS_MAP)) {
  const typeFile = mapKey.split(':')[0];
  const typeData = allTypes[typeFile];
  if (!typeData) continue;

  for (const mapping of mapDef.mappings) {
    const key = `${mapDef.docFile}:${mapping.docName}`;
    if (!typeMembers[key]) typeMembers[key] = new Set();
    const memberSet = typeMembers[key];

    if (mapping.kind === 'options' || mapping.kind === 'options-interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (iface) {
        for (const p of iface.properties) memberSet.add(p);
        for (const m of iface.methods) memberSet.add(m);
      }
    }

    if (mapping.kind === 'interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (iface) {
        for (const m of iface.methods) memberSet.add(m);
        for (const p of iface.properties) memberSet.add(p);
      }
    }

    if (mapping.kind === 'class') {
      const cls = typeData.classes[mapping.typeName];
      if (cls) {
        for (const m of cls.staticMethods) memberSet.add(m);
        for (const m of cls.instanceMethods) memberSet.add(m);
        for (const p of cls.staticProps) memberSet.add(p);
        for (const p of cls.instanceProps) memberSet.add(p);
      }
    }
  }
}

for (const [docFile, docData] of Object.entries(allDocs)) {
  for (const item of docData.items) {
    const key = `${docFile}:${item.name}`;
    const members = typeMembers[key];
    if (!members || members.size === 0) continue;

    for (const methodName of item.methods) {
      if (SKIP_TYPE_MEMBERS.has(methodName)) continue;
      if (DOC_ONLY_METHODS.has(methodName)) continue;
      if (!members.has(methodName)) {
        addIssue('WARN', docData.section, item.name,
          `Documented method/property "${methodName}" not found in parsed types — verify it exists in source`);
      }
    }
  }
}

// --- Check for empty descriptions/notes --------------------------

for (const [docFile, docData] of Object.entries(allDocs)) {
  for (const item of docData.items) {
    for (const mi of item.methodsWithInfo) {
      if (mi.emptyDescription) {
        addIssue('WARN', docData.section, `${item.name}`, `Method "${mi.name}()" has empty description`);
      }
    }
  }
}

// --- Check TYPES constants ---------------------------------------

const ormTypes = allTypes['orm.d.ts'];
if (ormTypes && ormTypes.enums.TYPES) {
  const ormDoc = allDocs['docs-orm.json'];
  if (ormDoc) {
    const typesItem = ormDoc.items.find(i => i.name === 'TYPES');
    if (!typesItem) {
      addIssue('ERROR', 'ORM', 'TYPES', 'TYPES constants section not found in docs');
    }
  }
}

// --- Output ------------------------------------------------------

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║             DOCUMENTATION AUDIT REPORT                      ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const bySection = {};
for (const issue of issues) {
  const key = `${issue.section} → ${issue.item}`;
  if (!bySection[key]) bySection[key] = [];
  bySection[key].push(issue);
}

for (const [key, sectionIssues] of Object.entries(bySection).sort()) {
  console.log(`\n┌- ${key}`);
  for (const issue of sectionIssues) {
    const icon = issue.severity === 'ERROR' ? '❌' : '⚠️';
    console.log(`│  ${icon} ${issue.message}`);
  }
  console.log('└-');
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`Total issues: ${issues.length} (${errorCount} errors, ${warningCount} warnings)`);
console.log(`${'-'.repeat(60)}\n`);

const errorsBySection = {};
for (const issue of issues.filter(i => i.severity === 'ERROR')) {
  const sect = issue.section;
  if (!errorsBySection[sect]) errorsBySection[sect] = 0;
  errorsBySection[sect]++;
}

if (Object.keys(errorsBySection).length > 0) {
  console.log('Missing items by section:');
  for (const [sect, count] of Object.entries(errorsBySection).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sect}: ${count} missing`);
  }
}

process.exitCode = errorCount > 0 ? 1 : 0;
