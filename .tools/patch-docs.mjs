/**
 * Documentation Patch Script (Type-Driven)
 * 
 * Reads types/*.d.ts declarations, compares against docs JSON files,
 * and adds ONLY stubs for items that exist in the type definitions
 * but are missing from documentation.
 * 
 * SAFETY: This script NEVER invents methods. Every item it adds
 * is verified to exist in a types/*.d.ts file first.
 * 
 * Items that need human-written descriptions are marked with
 * "[TODO: describe]" so they're easy to find and fill in.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ROOT, TYPES_TO_DOCS_MAP, SKIP_TYPE_MEMBERS,
  loadAllTypes, loadAllDocs, parseTypesDts,
} from './shared-parser.mjs';

const DOCS = join(ROOT, 'documentation', 'public', 'data', 'sections');

function readJson(file) {
  return JSON.parse(readFileSync(join(DOCS, file), 'utf8'));
}
function writeJson(file, data) {
  writeFileSync(join(DOCS, file), JSON.stringify(data, null, '\t') + '\n');
}

function findItem(doc, name) {
  return doc.items.find(i => i.name === name);
}
function findOrCreateGroup(item, groupName) {
  if (!item.methodGroups) item.methodGroups = [];
  let g = item.methodGroups.find(g => g.group === groupName);
  if (!g) {
    g = { group: groupName, methods: [] };
    item.methodGroups.push(g);
  }
  return g;
}

function hasMethod(item, methodName) {
  if (!item.methodGroups) return false;
  return item.methodGroups.some(g => g.methods.some(m => m.method === methodName));
}
function hasOption(item, optName) {
  return (item.options || []).some(o => o.option === optName);
}

let totalAdded = 0;
function track(docFile, docItem, name, type) {
  totalAdded++;
  console.log(`  + ${docFile} → ${docItem} → ${name} (${type})`);
}

// ─── Load everything ─────────────────────────────────────────────

const allTypes = loadAllTypes();
const docFiles = {};  // cache of loaded doc JSON by filename

function getDoc(docFile) {
  if (!docFiles[docFile]) {
    docFiles[docFile] = readJson(docFile);
  }
  return docFiles[docFile];
}

// ─── Extract type signature info from .d.ts source ───────────────
// Read the raw source to extract parameter signatures for stubs.

function extractSignatureFromSource(typeFile, typeName, memberName) {
  const filePath = join(ROOT, 'types', typeFile);
  const src = readFileSync(filePath, 'utf8');

  // Try to find the method/property line in the source
  // Look for patterns like:  memberName(...): ReturnType
  //                     or:  memberName?: Type
  //                     or:  static memberName(...): Type
  const patterns = [
    new RegExp(`^\\s*(?:static\\s+)?(?:readonly\\s+)?${memberName}\\s*(<[^>]*>)?\\s*\\(([^)]*)\\)\\s*:\\s*([^;]+)`, 'm'),
    new RegExp(`^\\s*(?:static\\s+)?(?:readonly\\s+)?${memberName}\\??\\s*:\\s*([^;]+)`, 'm'),
  ];

  for (const re of patterns) {
    const match = src.match(re);
    if (match) return match[0].trim().replace(/;$/, '');
  }
  return null;
}

// ─── Patch loop ──────────────────────────────────────────────────

const modifiedDocs = new Set();

for (const [mapKey, mapDef] of Object.entries(TYPES_TO_DOCS_MAP)) {
  const typeFile = mapKey.split(':')[0];
  const typeData = allTypes[typeFile];
  if (!typeData) continue;

  const doc = getDoc(mapDef.docFile);
  if (!doc) continue;

  for (const mapping of mapDef.mappings) {
    const item = findItem(doc, mapping.docName);
    if (!item) continue;

    // ── Options: add missing option stubs ──
    if (mapping.kind === 'options' || mapping.kind === 'options-interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (!iface) continue;

      const typeProps = [...iface.properties, ...iface.methods];

      // Check existing doc options + method options
      const existingOpts = new Set((item.options || []).map(o => o.option));
      const existingMethodOpts = new Set();
      for (const group of (item.methodGroups || [])) {
        for (const m of (group.methods || [])) {
          for (const o of (m.methodOptions || [])) {
            existingMethodOpts.add(o.option);
          }
        }
      }

      for (const prop of typeProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;

        // For prefixed options (e.g. pragmas.journal_mode), check prefix.prop
        const prefix = mapping.role || '';
        const docName = prefix ? `${prefix}.${prop}` : prop;

        if (existingOpts.has(prop) || existingOpts.has(docName) || existingMethodOpts.has(prop)) {
          continue;
        }

        if (!item.options) item.options = [];
        item.options.push({
          option: docName,
          type: '[TODO: type]',
          notes: '[TODO: describe]',
        });
        track(mapDef.docFile, mapping.docName, docName, 'option');
        modifiedDocs.add(mapDef.docFile);
      }
    }

    // ── Interface: add missing method/property stubs ──
    if (mapping.kind === 'interface') {
      const iface = typeData.interfaces[mapping.typeName];
      if (!iface) continue;

      // Determine a group name for new entries
      const groupName = mapping.role
        ? mapping.role.charAt(0).toUpperCase() + mapping.role.slice(1)
        : 'Methods';

      for (const method of iface.methods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (hasMethod(item, method)) continue;

        const group = findOrCreateGroup(item, groupName);
        group.methods.push({
          method,
          signature: `${mapping.docName.toLowerCase()}.${method}()`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, method + '()', 'method');
        modifiedDocs.add(mapDef.docFile);
      }

      for (const prop of iface.properties) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        if (hasMethod(item, prop) || hasOption(item, prop)) continue;

        const group = findOrCreateGroup(item, groupName);
        group.methods.push({
          method: prop,
          signature: `${mapping.docName.toLowerCase()}.${prop}`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, prop, 'property');
        modifiedDocs.add(mapDef.docFile);
      }
    }

    // ── Class: add missing static/instance method/property stubs ──
    if (mapping.kind === 'class') {
      const cls = typeData.classes[mapping.typeName];
      if (!cls) continue;

      const instancePrefix = mapping.docName.charAt(0).toLowerCase() + mapping.docName.slice(1);

      for (const method of cls.staticMethods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (hasMethod(item, method)) continue;

        const group = findOrCreateGroup(item, 'Static Methods');
        group.methods.push({
          method,
          signature: `${mapping.typeName}.${method}()`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, `${mapping.typeName}.${method}()`, 'static method');
        modifiedDocs.add(mapDef.docFile);
      }

      for (const method of cls.instanceMethods) {
        if (SKIP_TYPE_MEMBERS.has(method)) continue;
        if (hasMethod(item, method)) continue;

        const group = findOrCreateGroup(item, 'Instance Methods');
        group.methods.push({
          method,
          signature: `${instancePrefix}.${method}()`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, `${instancePrefix}.${method}()`, 'instance method');
        modifiedDocs.add(mapDef.docFile);
      }

      for (const prop of cls.staticProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        if (hasMethod(item, prop) || hasOption(item, prop)) continue;

        const group = findOrCreateGroup(item, 'Static Properties');
        group.methods.push({
          method: prop,
          signature: `${mapping.typeName}.${prop}`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, `${mapping.typeName}.${prop}`, 'static property');
        modifiedDocs.add(mapDef.docFile);
      }

      for (const prop of cls.instanceProps) {
        if (SKIP_TYPE_MEMBERS.has(prop)) continue;
        if (hasMethod(item, prop) || hasOption(item, prop)) continue;

        const group = findOrCreateGroup(item, 'Instance Properties');
        group.methods.push({
          method: prop,
          signature: `${instancePrefix}.${prop}`,
          description: '[TODO: describe]',
          methodReturns: { type: '[TODO: type]', description: '' },
          methodParams: [],
        });
        track(mapDef.docFile, mapping.docName, `${instancePrefix}.${prop}`, 'instance property');
        modifiedDocs.add(mapDef.docFile);
      }
    }
  }
}

// ─── Write modified files ────────────────────────────────────────

for (const docFile of modifiedDocs) {
  writeJson(docFile, docFiles[docFile]);
  console.log(`  ✅ Wrote ${docFile}`);
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`Total items added: ${totalAdded}`);
if (totalAdded === 0) {
  console.log('Documentation is fully in sync with types — nothing to patch.');
}
console.log(`${'═'.repeat(60)}`);
console.log('\nRun "node .tools/audit-docs.mjs" to verify.\n');
