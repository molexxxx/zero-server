#!/usr/bin/env node
// Generates conformance/api-surface.json from the public exports and JSDoc of
// @zero-server/sdk, plus one naming map per binding.
//
//   node scripts/api-surface-from-zero-server.mjs [path/to/zero-server]
//
// The default source is the sibling zero-server checkout, which is read only.
// Every export of its index.js gets one canonical id, `<scope>.<snake_case>`
// after the scoped package it belongs to, and a kind: `ffi` for a
// surface the C ABI carries, `facade` for one each binding writes in its own
// language over the ABI, and `host-only` for classes that stay in the host
// language (Model classes, error classes). CI diffs each binding's generated
// declarations against this file by canonical id; the naming maps say how an
// id is spelled in that binding.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT, '..', 'zero-server');
const OUT_DIR = resolve(ROOT, 'conformance');
const require = createRequire(import.meta.url);

const sdk = require(join(SOURCE, 'index.js'));
const { version } = require(join(SOURCE, 'package.json'));
const { scopes } = require(join(SOURCE, '.tools', 'scope-manifest.js'));
const indexSource = readFileSync(join(SOURCE, 'index.js'), 'utf8');

const KINDS = {
  ffi: 'carried by the C ABI of zero-ffi and reached through the generated declarations of every binding',
  facade: 'written in each binding language over the ABI, keeping the shape the Node SDK gave it',
  'host-only': 'a class that stays in the host language and is checked by a per-binding export test',
};

// Exports each binding writes over the ABI rather than reaching through it.
const FACADE = new Set([
  'createApp', 'Router', 'version', 'logger', 'validate', 'errorHandler', 'env',
  'Database', 'CLI', 'runCLI', 'LifecycleManager', 'LIFECYCLE_STATE',
  'ClusterManager', 'cluster', 'clusterize', 'Logger', 'structuredLogger',
  'authorize', 'can', 'canAny', 'Policy', 'gate', 'attachUserHelpers',
  'watchProto', 'spawnBotPeer', 'bindObservability', 'runWebRTCCommand',
]);

// Scopes whose exports stay in the host language unless named above.
const HOST_ONLY_SCOPES = new Set(['errors', 'orm']);

// Exports the core drops, and the ones it keeps only as a host-side shim.
const DROPPED = new Map([
  ['memoryCheck', 'runtime health checks are host concerns'],
  ['eventLoopCheck', 'runtime health checks are host concerns'],
  ['diskSpaceCheck', 'runtime health checks are host concerns'],
  ['PluginManager', 'no core design exists yet'],
  ['DatabaseView', 'no core design exists yet'],
  ['MediasoupSfuAdapter', 'media adapters are out of scope'],
  ['LiveKitSfuAdapter', 'media adapters are out of scope'],
  ['loadSfuAdapter', 'media adapters are out of scope'],
  ['McuAdapter', 'media adapters are out of scope'],
  ['MemoryMcuAdapter', 'media adapters are out of scope'],
  ['FfmpegMcuAdapter', 'media adapters are out of scope'],
  ['RecordingManager', 'media adapters are out of scope'],
  ['IngressManager', 'media adapters are out of scope'],
  ['useCascade', 'media cascades are out of scope'],
  ['CascadeCoordinator', 'media cascades are out of scope'],
  ['CH_CASCADE', 'media cascades are out of scope'],
  ['E2eeChannel', 'the E2EE helpers are out of scope'],
  ['attachE2ee', 'the E2EE helpers are out of scope'],
  ['generateE2eeKeyPair', 'the E2EE helpers are out of scope'],
  ['sealKey', 'the E2EE helpers are out of scope'],
  ['openSealedKey', 'the E2EE helpers are out of scope'],
]);
const SHIM = new Set(['cluster', 'clusterize', 'ClusterManager']);

// The release whose contract tier first carries an export, by scope, refined
// by name where a scope spans releases.
const RELEASES = {
  core: 1, errors: 1, realtime: 1, lifecycle: 1, middleware: 1,
  body: 2, env: 2, fetch: 2, cli: 2, auth: 2,
  orm: 3, grpc: 3, observe: 3, webrtc: 3,
};
const RELEASE_BY_NAME = {
  rateLimit: 2, timeout: 2, cookieParser: 2, csrf: 2, compress: 3,
  session: 2, Session: 2, MemoryStore: 2,
  oauth: 3, generatePKCE: 3, generateState: 3, OAUTH_PROVIDERS: 3,
  authorize: 3, can: 3, canAny: 3, Policy: 3, gate: 3, attachUserHelpers: 3,
  twoFactor: 3, webauthn: 3, trustedDevice: 3, enrollment: 3,
  cluster: 3, clusterize: 3, ClusterManager: 3,
};

function fail(message)
{
  console.error(`api-surface-from-zero-server: ${message}`);
  process.exit(1);
}

function canonicalId(name)
{
  if (/^[A-Z0-9_]+$/.test(name)) return name.toLowerCase();
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function pascal(name)
{
  return canonicalId(name).split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function typeOf(value)
{
  if (typeof value === 'function')
  {
    return /^class\s/.test(Function.prototype.toString.call(value)) || /^[A-Z]/.test(value.name)
      ? 'class'
      : 'function';
  }
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function listFiles(dir)
{
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }))
  {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

// Every lib file by the `@module` name its header declares and by its path
// under lib/ without the extension, since index.js tags use either.
function indexModules()
{
  const modules = new Map();
  for (const file of listFiles(join(SOURCE, 'lib')))
  {
    const text = readFileSync(file, 'utf8');
    const header = text.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\//);
    const name = header && header[0].match(/@module\s+(\S+)/);
    const path = relative(join(SOURCE, 'lib'), file).replace(/\\/g, '/').replace(/\.js$/, '');
    const module = { file, text };
    modules.set(path, module);
    if (name && !modules.has(name[1])) modules.set(name[1], module);
  }
  return modules;
}

function resolveModule(tag)
{
  if (!tag) return null;
  const direct = modules.get(tag) ?? modules.get(`${tag}/index`);
  if (direct) return direct;
  const suffix = [...modules.keys()].find((key) => key.endsWith(`/${tag}`));
  return suffix ? modules.get(suffix) : null;
}

// The `@see module:` tag that precedes each key of index.js's export object.
function indexModuleTags()
{
  const tags = new Map();
  const body = indexSource.slice(indexSource.indexOf('module.exports = {'));
  let current = null;
  for (const line of body.split(/\r?\n/))
  {
    const see = line.match(/@see module:(\S+)/);
    if (see) current = see[1];
    const key = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*(?::|,)/);
    if (key && current) tags.set(key[1], current);
  }
  return tags;
}

function parseDoc(block)
{
  const lines = block
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, ''));
  const description = [];
  const params = [];
  let returns = null;
  let examples = 0;
  let tag = null;
  for (const line of lines)
  {
    const at = line.match(/^@(\w+)\s*(.*)$/);
    if (at)
    {
      tag = at[1];
      if (tag === 'param')
      {
        const param = at[2].match(/^(?:\{([^}]*)\}\s*)?(\[?[\w$.]+(?:=[^\]]*)?\]?)\s*(?:-\s*)?(.*)$/);
        if (param)
        {
          const optional = param[2].startsWith('[');
          const [name, fallback] = param[2].replace(/^\[|\]$/g, '').split('=');
          params.push({ name, type: param[1] ?? '', optional, default: fallback ?? null, description: param[3].trim() });
        }
      }
      else if (tag === 'returns' || tag === 'return')
      {
        const ret = at[2].match(/^(?:\{([^}]*)\}\s*)?(.*)$/);
        returns = { type: ret[1] ?? '', description: ret[2].trim() };
      }
      else if (tag === 'example') examples += 1;
      else if (tag === 'description') description.push(at[2]);
      continue;
    }
    if (tag === null || tag === 'description')
    {
      description.push(line.trim());
    }
    else if (tag === 'param' && params.length > 0 && line.trim())
    {
      params[params.length - 1].description += ` ${line.trim()}`;
    }
    else if (tag === 'returns' && returns && line.trim())
    {
      returns.description += ` ${line.trim()}`;
    }
  }
  const summary = description.join('\n').trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return { summary, params, returns, examples };
}

// The JSDoc block directly above the declaration of `name` in `text`.
function declarationDoc(text, name)
{
  const escaped = name.replace(/[$]/g, '\\$');
  const declaration = new RegExp(
    `(/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/)\\s*\\n\\s*(?:module\\.exports\\s*=\\s*)?(?:async\\s+)?(?:function\\s*\\*?\\s*${escaped}\\b|class\\s+${escaped}\\b|(?:const|let)\\s+${escaped}\\b(?!\\s*=\\s*require)|${escaped}\\s*[:=(])`,
  );
  const match = text.match(declaration);
  return match ? match[1] : null;
}

// The export's own JSDoc: in its module, then in any file the module's
// directory holds, then the module header as a last resort.
function docFor(module, localName)
{
  const header = module.text.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\//);
  const fallback = header ? parseDoc(header[0]) : { summary: '', params: [], returns: null, examples: 0 };
  let block = declarationDoc(module.text, localName);
  for (const file of listFiles(dirname(module.file)))
  {
    if (block) break;
    block = declarationDoc(readFileSync(file, 'utf8'), localName);
  }
  if (!block) return fallback;
  const doc = parseDoc(block);
  if (!doc.summary) doc.summary = fallback.summary;
  return doc;
}

// Prose copied from the SDK, with the dashes and the spelling this repository
// writes: the en and em dash become a hyphen, and the -ise stems become -ize.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`, 'g');
const STEMS = /\b(normal|serial|token|initial|optim|organ|recogn|author|custom|minim|maxim|util|standard|synchron|final|visual|summar|priorit|categor|special)is(e|ed|es|ing|ation)\b/g;

function plain(text)
{
  return text.replace(DASHES, '-').replace(STEMS, '$1iz$2');
}

const modules = indexModules();
const tags = indexModuleTags();
const exportsOut = [];

for (const [name, value] of Object.entries(sdk))
{
  const scope = scopes.find((s) => s.exports.includes(name)) ?? scopes[0];
  const localName = scope.localMap?.[name] ?? { cluster: 'clusterize', static: 'serveStatic' }[name] ?? name;
  const module = name === 'version'
    ? null
    : resolveModule(tags.get(name) ?? { createApp: 'app', Router: 'router' }[name]);
  const doc = module ? docFor(module, localName) : { summary: '', params: [], returns: null, examples: 0 };
  if (name === 'version') doc.summary = 'The package version string.';
  doc.summary = plain(doc.summary);
  for (const param of doc.params) param.description = plain(param.description);
  if (doc.returns) doc.returns.description = plain(doc.returns.description);
  const id = `${scope.name}.${canonicalId(name)}`;
  const type = typeOf(value);
  let kind = 'ffi';
  if (FACADE.has(name)) kind = 'facade';
  else if (HOST_ONLY_SCOPES.has(scope.name) || /Error$/.test(name)) kind = 'host-only';
  const status = DROPPED.has(name) ? 'dropped' : SHIM.has(name) ? 'shim' : 'kept';
  const entry = {
    id,
    name,
    kind,
    type,
    scope: scope.name,
    module: module ? relative(SOURCE, module.file).replace(/\\/g, '/') : 'package.json',
    status,
    release: RELEASE_BY_NAME[name] ?? RELEASES[scope.name] ?? 1,
    summary: doc.summary,
    params: doc.params,
    returns: doc.returns,
    examples: doc.examples,
  };
  if (status === 'dropped') entry.reason = DROPPED.get(name);
  exportsOut.push(entry);
}

// A scope may hold a class and a function of one name (`Session` and
// `session`); the class keeps the plain id and the other export carries its
// type as a suffix, so every id survives a case-insensitive convention.
const ids = new Set();
for (const entry of exportsOut)
{
  const twins = exportsOut.filter((other) => other.id === entry.id);
  if (twins.length > 1 && entry.type !== 'class') entry.id = `${entry.id}_${entry.type}`;
}
for (const entry of exportsOut)
{
  if (ids.has(entry.id)) fail(`canonical id ${entry.id} is taken twice`);
  ids.add(entry.id);
}

const note = `Generated by scripts/api-surface-from-zero-server.mjs from @zero-server/sdk ${version} (index.js and lib/). Do not edit by hand.`;
const surface = { note, source: { package: '@zero-server/sdk', version }, kinds: KINDS, exports: exportsOut };

function names(language, rules, spell)
{
  const out = {};
  for (const entry of exportsOut) out[entry.id] = spell(entry);
  return { note, language, rules, names: out };
}

const node = names('node', {
  package: '@zero-server/sdk',
  function: 'camelCase, the Node SDK name unchanged',
  class: 'PascalCase, the Node SDK name unchanged',
  constant: 'SCREAMING_SNAKE_CASE, the Node SDK name unchanged',
  error: 'the Node SDK class name, ending in Error',
}, (entry) => entry.name);

const python = names('python', {
  package: 'zero-server',
  function: 'snake_case of the canonical id',
  class: 'PascalCase, the Node SDK name unchanged',
  constant: 'SCREAMING_SNAKE_CASE of the canonical id',
  error: 'the Node SDK class name, ending in Error',
}, (entry) =>
{
  if (entry.type === 'class') return entry.name;
  if (/^[A-Z0-9_]+$/.test(entry.name)) return entry.name;
  return canonicalId(entry.name);
});

const dotnet = names('dotnet', {
  package: 'ZeroServer',
  function: 'PascalCase of the export name; a function spelled like a class of its scope takes the Create prefix',
  class: 'PascalCase, the Node SDK name unchanged',
  constant: 'PascalCase of the export name',
  error: 'the Node SDK class name with Error replaced by Exception',
}, (entry) =>
{
  if (/Error$/.test(entry.name)) return entry.name.replace(/Error$/, 'Exception');
  if (entry.type === 'class') return entry.name;
  const spelled = pascal(entry.name);
  const shadows = exportsOut.some((other) => other.scope === entry.scope && other.type === 'class' && other.name === spelled);
  return shadows ? `Create${spelled}` : spelled;
});

const files = {
  'api-surface.json': surface,
  'api-surface.node.json': node,
  'api-surface.python.json': python,
  'api-surface.dotnet.json': dotnet,
};
for (const [file, data] of Object.entries(files))
{
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const counts = { ffi: 0, facade: 0, 'host-only': 0 };
let params = 0;
let returns = 0;
let examples = 0;
for (const entry of exportsOut)
{
  counts[entry.kind] += 1;
  params += entry.params.length;
  returns += entry.returns ? 1 : 0;
  examples += entry.examples;
}
console.log(
  `conformance/api-surface.json: ${exportsOut.length} exports (${counts.ffi} ffi, ${counts.facade} facade, ${counts['host-only']} host-only; ${params} params, ${returns} returns, ${examples} examples documented)`,
);
