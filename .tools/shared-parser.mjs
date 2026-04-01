/**
 * Shared parsing utilities for audit and patch scripts.
 * Parses types/*.d.ts and documentation JSON files.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT = join(__dirname, '..');

// --- Parse TypeScript declarations -------------------------------

export function parseTypesDts(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const result = {
    interfaces: {},
    classes: {},
    functions: [],
    enums: {},
  };

  const interfaceRe = /export\s+(?:interface|type)\s+(\w+)\s*(?:extends\s+[^{]+)?\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
  let m;
  while ((m = interfaceRe.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const members = { properties: [], methods: [] };

    const methodRe = /^\s*(?:readonly\s+)?(\w+)\s*[\(<]/gm;
    let mm;
    while ((mm = methodRe.exec(body)) !== null) {
      if (!members.methods.includes(mm[1])) {
        members.methods.push(mm[1]);
      }
    }

    const propRe = /^\s*(?:\/\*\*[^*]*\*\/\s*)?(?:readonly\s+)?(\w+)\??\s*:\s*(?!.*\()/gm;
    let pm;
    while ((pm = propRe.exec(body)) !== null) {
      const propName = pm[1];
      if (!members.methods.includes(propName) && !members.properties.includes(propName)) {
        members.properties.push(propName);
      }
    }

    result.interfaces[name] = members;
  }

  const classRe = /export\s+class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([\s\S]*?)(?=\nexport\s|\n\/\/|$)/gs;
  while ((m = classRe.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const cls = { staticMethods: [], instanceMethods: [], staticProps: [], instanceProps: [] };

    const lines = body.split('\n');
    let braceDepth = 0;
    let parenDepth = 0;
    for (const line of lines) {
      const trimmed = line.trim();

      // Track braces/parens on every line (including blanks/comments)
      for (const ch of trimmed) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
        if (ch === '(') parenDepth++;
        if (ch === ')') parenDepth--;
      }

      if (!trimmed || trimmed.startsWith('/**') || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed === '}') continue;

      // If we were already inside a nested context BEFORE this line,
      // only try to detect top-level method starts (which open parens on this line).
      // Lines that are purely inside multi-line signatures or inline objects are skipped for props.
      const isStatic = trimmed.startsWith('static ');
      const cleaned = isStatic ? trimmed.replace('static ', '') : trimmed;

      // Detect method declarations: name( or name<T>(
      const methodMatch = cleaned.match(/^(?:readonly\s+)?(\w+)\s*[\(<]/);
      if (methodMatch) {
        const mName = methodMatch[1];
        if (mName === 'constructor') continue;
        if (isStatic) {
          if (!cls.staticMethods.includes(mName)) cls.staticMethods.push(mName);
        } else {
          if (!cls.instanceMethods.includes(mName)) cls.instanceMethods.push(mName);
        }
        continue;
      }

      // Skip property detection if inside multi-line method signatures or inline object types
      if (braceDepth > 0 || parenDepth > 0) continue;

      const propMatch = cleaned.match(/^(?:readonly\s+)?(\w+)\??\s*:/);
      if (propMatch) {
        const pName = propMatch[1];
        if (isStatic) {
          if (!cls.staticProps.includes(pName)) cls.staticProps.push(pName);
        } else {
          if (!cls.instanceProps.includes(pName)) cls.instanceProps.push(pName);
        }
      }
    }

    result.classes[name] = cls;
  }

  const fnRe = /export\s+function\s+(\w+)/g;
  while ((m = fnRe.exec(src)) !== null) {
    if (!result.functions.includes(m[1])) {
      result.functions.push(m[1]);
    }
  }

  const constObjRe = /export\s+const\s+(\w+)\s*:\s*\{([^}]+)\}/gs;
  while ((m = constObjRe.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const keys = [];
    const keyRe = /readonly\s+(\w+)/g;
    let km;
    while ((km = keyRe.exec(body)) !== null) {
      keys.push(km[1]);
    }
    result.enums[name] = keys;
  }

  return result;
}

// --- Parse Documentation JSON ------------------------------------

export function parseDocJson(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const result = {
    section: raw.section,
    items: [],
  };

  for (const item of (raw.items || [])) {
    const docItem = {
      name: item.name,
      options: (item.options || []).map(o => o.option),
      methods: [],
      methodsWithInfo: [],
      hasDescription: !!item.description,
      hasTips: !!(item.tips && item.tips.length),
      hasExample: !!item.example,
    };

    for (const group of (item.methodGroups || [])) {
      for (const method of (group.methods || [])) {
        docItem.methods.push(method.method);
        docItem.methodsWithInfo.push({
          name: method.method,
          hasDescription: !!method.description,
          hasSignature: !!method.signature,
          hasReturns: !!(method.methodReturns && method.methodReturns.type),
          hasParams: !!(method.methodParams && method.methodParams.length),
          hasOptions: !!(method.methodOptions && method.methodOptions.length),
          optionNames: (method.methodOptions || []).map(o => o.option),
          paramNames: (method.methodParams || []).map(p => p.param),
          emptyDescription: method.description === '' || !method.description,
          emptyNotes: (method.methodParams || []).some(p => !p.notes) ||
                      (method.methodOptions || []).some(o => !o.notes),
        });
      }
    }

    result.items.push(docItem);
  }

  return result;
}

// --- Mapping: types → docs ---------------------------------------

export const TYPES_TO_DOCS_MAP = {
  'app.d.ts': {
    docFile: 'docs-core.json',
    mappings: [
      { typeName: 'App', docName: 'createApp', kind: 'interface' },
      { typeName: 'RouterInstance', docName: 'Router', kind: 'interface' },
      { typeName: 'Request', docName: 'Request', kind: 'interface' },
      { typeName: 'Response', docName: 'Response', kind: 'interface' },
      { typeName: 'CookieOptions', docName: 'Response', kind: 'options-interface', role: 'cookie-options' },
      { typeName: 'SendFileOptions', docName: 'Response', kind: 'options-interface', role: 'sendFile-options' },
      { typeName: 'RouteOptions', docName: 'createApp', kind: 'options-interface', role: 'route-options' },
    ]
  },
  'router.d.ts': {
    docFile: 'docs-core.json',
    mappings: [
      { typeName: 'RouterInstance', docName: 'Router', kind: 'interface' },
      { typeName: 'RouteChain', docName: 'Router', kind: 'interface', role: 'chain' },
    ]
  },
  'request.d.ts': {
    docFile: 'docs-core.json',
    mappings: [
      { typeName: 'Request', docName: 'Request', kind: 'interface' },
    ]
  },
  'response.d.ts': {
    docFile: 'docs-core.json',
    mappings: [
      { typeName: 'Response', docName: 'Response', kind: 'interface' },
    ]
  },
  'middleware.d.ts': {
    docFile: 'docs-middleware.json',
    mappings: [
      { typeName: 'CorsOptions', docName: 'cors', kind: 'options' },
      { typeName: 'CompressOptions', docName: 'compress', kind: 'options' },
      { typeName: 'HelmetOptions', docName: 'helmet', kind: 'options' },
      { typeName: 'StaticOptions', docName: 'static', kind: 'options' },
      { typeName: 'RateLimitOptions', docName: 'rateLimit', kind: 'options' },
      { typeName: 'TimeoutOptions', docName: 'timeout', kind: 'options' },
      { typeName: 'RequestIdOptions', docName: 'requestId', kind: 'options' },
      { typeName: 'LoggerOptions', docName: 'logger', kind: 'options' },
    ]
  },
  'middleware.d.ts:body': {
    docFile: 'docs-body-parsers.json',
    mappings: [
      { typeName: 'JsonParserOptions', docName: 'json', kind: 'options' },
      { typeName: 'UrlencodedParserOptions', docName: 'urlencoded', kind: 'options' },
      { typeName: 'TextParserOptions', docName: 'text', kind: 'options' },
      { typeName: 'BodyParserOptions', docName: 'raw', kind: 'options' },
      { typeName: 'MultipartOptions', docName: 'multipart', kind: 'options' },
    ]
  },
  'middleware.d.ts:cookies': {
    docFile: 'docs-cookies-security.json',
    mappings: [
      { typeName: 'CookieParserStatic', docName: 'cookieParser', kind: 'interface' },
      { typeName: 'CsrfOptions', docName: 'csrf', kind: 'options' },
      { typeName: 'ValidatorSchema', docName: 'validate', kind: 'options' },
      { typeName: 'ValidatorOptions', docName: 'validate', kind: 'options', role: 'validator-opts' },
      { typeName: 'ValidationRule', docName: 'validate', kind: 'options', role: 'rule' },
    ]
  },
  'fetch.d.ts': {
    docFile: 'docs-networking.json',
    mappings: [
      { typeName: 'FetchOptions', docName: 'fetch', kind: 'options' },
      { typeName: 'FetchResponse', docName: 'fetch', kind: 'interface', role: 'response' },
      { typeName: 'FetchHeaders', docName: 'fetch', kind: 'interface', role: 'headers' },
    ]
  },
  'sse.d.ts': {
    docFile: 'docs-real-time.json',
    mappings: [
      { typeName: 'SSEOptions', docName: 'SSE (Server-Sent Events)', kind: 'options' },
      { typeName: 'SSEStream', docName: 'SSE (Server-Sent Events)', kind: 'interface' },
    ]
  },
  'websocket.d.ts': {
    docFile: 'docs-real-time.json',
    mappings: [
      { typeName: 'WebSocketOptions', docName: 'WebSocket', kind: 'options' },
      { typeName: 'WebSocketConnection', docName: 'WebSocket', kind: 'interface' },
      { typeName: 'WebSocketPool', docName: 'WebSocketPool', kind: 'interface' },
    ]
  },
  'env.d.ts': {
    docFile: 'docs-environment.json',
    mappings: [
      { typeName: 'Env', docName: 'env', kind: 'interface' },
      { typeName: 'EnvFieldDef', docName: 'Schema Types', kind: 'options' },
      { typeName: 'EnvLoadOptions', docName: 'env', kind: 'options', role: 'load-options' },
    ]
  },
  'errors.d.ts': {
    docFile: 'docs-error-handling.json',
    mappings: [
      { typeName: 'ErrorHandlerOptions', docName: 'errorHandler', kind: 'options' },
      { typeName: 'Debug', docName: 'debug', kind: 'interface' },
      { typeName: 'DebugLogger', docName: 'debug', kind: 'interface', role: 'logger' },
    ]
  },
  'orm.d.ts': {
    docFile: 'docs-orm.json',
    mappings: [
      { typeName: 'Database', docName: 'Database', kind: 'class' },
      { typeName: 'Model', docName: 'Model', kind: 'class' },
      { typeName: 'Query', docName: 'Query', kind: 'class' },
      { typeName: 'QueryCache', docName: 'QueryCache', kind: 'class' },
      { typeName: 'Migrator', docName: 'Migrator', kind: 'class' },
      { typeName: 'QueryProfiler', docName: 'QueryProfiler', kind: 'class' },
      { typeName: 'ReplicaManager', docName: 'ReplicaManager', kind: 'class' },
      { typeName: 'Factory', docName: 'Seeder & Factory', kind: 'class' },
      { typeName: 'Fake', docName: 'Seeder & Factory', kind: 'class' },
      { typeName: 'Seeder', docName: 'Seeder & Factory', kind: 'class' },
      { typeName: 'SeederRunner', docName: 'Seeder & Factory', kind: 'class' },
      { typeName: 'QueryCacheOptions', docName: 'QueryCache', kind: 'options' },
      { typeName: 'QueryProfilerOptions', docName: 'QueryProfiler', kind: 'options' },
      { typeName: 'ReplicaManagerOptions', docName: 'ReplicaManager', kind: 'options' },
      { typeName: 'SchemaColumnDef', docName: 'Schema DDL', kind: 'options' },
      { typeName: 'SqliteOptions', docName: 'SQLite Adapter', kind: 'options' },
      { typeName: 'SqlitePragmas', docName: 'SQLite Adapter', kind: 'options', role: 'pragmas' },
      { typeName: 'MySqlOptions', docName: 'MySQL Adapter', kind: 'options' },
      { typeName: 'PostgresOptions', docName: 'PostgreSQL Adapter', kind: 'options' },
      { typeName: 'MongoOptions', docName: 'MongoDB Adapter', kind: 'options' },
      { typeName: 'JsonOptions', docName: 'JSON Adapter', kind: 'options' },
      { typeName: 'RedisOptions', docName: 'Redis Adapter', kind: 'options' },
      { typeName: 'SqliteAdapter', docName: 'SQLite Adapter', kind: 'interface' },
      { typeName: 'MySqlAdapter', docName: 'MySQL Adapter', kind: 'interface' },
      { typeName: 'PostgresAdapter', docName: 'PostgreSQL Adapter', kind: 'interface' },
      { typeName: 'MongoAdapter', docName: 'MongoDB Adapter', kind: 'interface' },
      { typeName: 'MemoryAdapter', docName: 'Memory Adapter', kind: 'interface' },
      { typeName: 'JsonAdapter', docName: 'JSON Adapter', kind: 'interface' },
      { typeName: 'RedisAdapter', docName: 'Redis Adapter', kind: 'interface' },
      { typeName: 'RetryOptions', docName: 'Database', kind: 'options', role: 'retry' },
      { typeName: 'ModelHooks', docName: 'Model', kind: 'options', role: 'hooks' },
      { typeName: 'MigrationDefinition', docName: 'Migrator', kind: 'options', role: 'migration-def' },
    ]
  },
};

// Members intentionally not documented (internal)
export const SKIP_TYPE_MEMBERS = new Set([
  'then', 'catch',
  'onfulfilled', 'onrejected',
  '_persisted',
]);

// Methods that are legitimately doc-only (convenience/aliases not in types)
export const DOC_ONLY_METHODS = new Set([]);

// --- Load all types and docs -------------------------------------

export function loadAllTypes() {
  const typesDir = join(ROOT, 'types');
  const allTypes = {};
  for (const f of readdirSync(typesDir).filter(f => f.endsWith('.d.ts'))) {
    allTypes[f] = parseTypesDts(join(typesDir, f));
  }
  return allTypes;
}

export function loadAllDocs() {
  const docsDir = join(ROOT, 'documentation', 'public', 'data', 'sections');
  const allDocs = {};
  for (const f of readdirSync(docsDir).filter(f => f.endsWith('.json'))) {
    allDocs[f] = parseDocJson(join(docsDir, f));
  }
  return allDocs;
}
