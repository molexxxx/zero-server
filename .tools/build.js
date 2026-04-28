#!/usr/bin/env node
/**
 * build.js — Unified documentation build pipeline.
 *
 * Generates ALL section JSON files from scratch by parsing JSDoc
 * comments & section headers in lib/ source files.
 *
 * 1. Reads section layout from docs-config.js
 * 2. For each source-backed item, parses JSDoc from the source file
 *    to auto-discover description, params, options, returns, examples,
 *    method groups (from `// -- Group Name --` section comments),
 *    attached methods (`fn.method = ...`), and error class declarations.
 * 3. Runs tests + generates badges
 * 4. Writes sections to data/sections/ and data/versions/{ver}/
 * 5. Generates API.md, cache-busts index.html, updates versions.json
 *
 * Usage:  node .tools/build.js
 * npm:    npm run build
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT          = path.resolve(__dirname, '..');
const PKG           = require(path.join(ROOT, 'package.json'));
const version       = PKG.version;

const DATA_DIR      = path.join(ROOT, 'website-docs', 'public', 'data');
const VERSIONS_DIR  = path.join(DATA_DIR, 'versions');
const VERSIONS_JSON = path.join(DATA_DIR, 'versions.json');
const BADGES_FILE   = path.join(DATA_DIR, 'badges.json');
const HTML_PATH     = path.join(ROOT, 'website-docs', 'public', 'index.html');

/* ======================================================================
 *  JSDoc Parser
 * ====================================================================== 
*/

const _fileCache = new Map();

/**
 * Parse all JSDoc blocks from a source file.
 * Returns an array of { description, params[], returns, examples[],
 *                        see, module, private, constructor, name, offset }.
 */
function parseFile(relPath)
{
	if (_fileCache.has(relPath)) return _fileCache.get(relPath);

	const absPath = path.join(ROOT, relPath);
	if (!fs.existsSync(absPath)) { _fileCache.set(relPath, []); return []; }

	const source = fs.readFileSync(absPath, 'utf8');
	const blocks = [];
	const re = /\/\*\*([\s\S]*?)\*\//g;
	let match;

	while ((match = re.exec(source)) !== null)
	{
		const parsed = parseJSDocBlock(match[1]);
		if (parsed.private) continue;

		const after = source.slice(match.index + match[0].length, match.index + match[0].length + 500);
		parsed.name = extractName(after);
		parsed.offset = match.index;

		// Check if the JSDoc precedes a class declaration
		const cm = after.match(/^\s*class\s+(\w+)/);
		if (cm) parsed.className = cm[1];
		blocks.push(parsed);
	}

	_fileCache.set(relPath, blocks);
	return blocks;
}

function extractName(codeAfter)
{
	const s = codeAfter.replace(/^[\s\n]+/, '');
	if (/^class\s/.test(s)) return null;

	// module.exports = function name(
	const m1 = s.match(/^(?:module\.exports\s*=\s*)?(?:async\s+)?function\s+(\w+)\s*\(/);
	if (m1) return m1[1];

	// property assignment: obj.name = function name(  or  obj.name = function(
	const m2 = s.match(/^\w+\.(\w+)\s*=\s*(?:async\s+)?function\s*(\w*)\s*\(/);
	if (m2) return m2[2] || m2[1];

	// class method: [static] [async] [get|set] name(
	const m3 = s.match(/^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/);
	if (m3)
	{
		const skip = ['if', 'for', 'while', 'switch', 'return', 'const', 'let', 'var',
		              'new', 'throw', 'catch', 'module', 'require', 'try', 'else'];
		if (!skip.includes(m3[1])) return m3[1];
	}
	return null;
}

/**
 * Extract a balanced-brace type expression from a string starting at `pos`.
 * `str[pos]` must be '{'. Returns `{ type, rest }` where `rest` is everything
 * after the closing '}', or `null` on mismatch.
 */
function extractBracedType(str, pos = 0)
{
	if (str[pos] !== '{') return null;
	let depth = 0;
	for (let i = pos; i < str.length; i++)
	{
		if (str[i] === '{') depth++;
		else if (str[i] === '}') { depth--; if (depth === 0) return { type: str.slice(pos + 1, i).trim(), rest: str.slice(i + 1) }; }
	}
	return null;
}

function parseJSDocBlock(raw)
{
	const lines = raw.split('\n').map(l => l.replace(/^\s*\*\s?/, ''));
	const result = {
		description: '', params: [], returns: null, examples: [],
		module: null, private: false, constructor: false, see: null,
		section: null
	};

	let mode = 'description';
	let exampleBuf = [];
	let exampleLang = 'javascript';
	let exampleTitle = null;

	function flushExample()
	{
		if (exampleBuf.length) { result.examples.push({ code: exampleBuf.join('\n').trimEnd(), lang: exampleLang, ...(exampleTitle ? { title: exampleTitle } : {}) }); exampleBuf = []; }
		exampleLang = 'javascript';
		exampleTitle = null;
	}

	for (const line of lines)
	{
		const t = line.trim();

		if (t.startsWith('@param'))
		{
			flushExample(); mode = 'param';
			const braceIdx = t.indexOf('{');
			const bt = braceIdx !== -1 ? extractBracedType(t, braceIdx) : null;
			if (bt)
			{
				const m = bt.rest.match(/^\s+(\[?)([^\]= \t]+)(?:=([^\]]*))?\]?\s*(?:-\s*)?(.*)$/);
				if (m)
				{
					result.params.push({
						type: bt.type,
						optional: !!m[1],
						name: m[2].trim(),
						default: m[3] !== undefined ? m[3].trim() : undefined,
						description: (m[4] || '').trim(),
					});
				}
			}
		}
		else if (t.startsWith('@returns') || t.startsWith('@return'))
		{
			flushExample(); mode = 'returns';
			const braceIdx = t.indexOf('{');
			const bt = braceIdx !== -1 ? extractBracedType(t, braceIdx) : null;
			if (bt) result.returns = { type: bt.type, description: bt.rest.trim() };
		}
		else if (t.startsWith('@example'))
		{
			flushExample(); mode = 'example'; exampleBuf = [];
			const meta = t.replace(/^@example\s*/, '').trim();
			if (meta)
			{
				const pipeIdx = meta.indexOf('|');
				if (pipeIdx !== -1)
				{
					exampleLang = meta.slice(0, pipeIdx).trim() || 'javascript';
					exampleTitle = meta.slice(pipeIdx + 1).trim() || null;
				}
				else
				{
					exampleLang = meta;
				}
			}
		}
		else if (t.startsWith('@private'))
		{
			result.private = true;
		}
		else if (t.startsWith('@constructor'))
		{
			result.constructor = true;
		}
		else if (t.startsWith('@description'))
		{
			flushExample(); mode = 'description';
			const text = t.replace(/@description\s*/, '').trim();
			if (text) result.description += (result.description ? ' ' : '') + text;
		}
		else if (t.startsWith('@module'))
		{
			flushExample(); mode = 'skip';
			result.module = t.replace(/@module\s*/, '').trim() || null;
		}
		else if (t.startsWith('@see'))
		{
			flushExample(); mode = 'skip';
			result.see = t.replace(/@see\s*/, '').trim();
		}
		else if (t.startsWith('@section'))
		{
			flushExample(); mode = 'skip';
			result.section = t.replace(/@section\s*/, '').trim() || null;
		}
		else if (t.startsWith('@'))
		{
			flushExample(); mode = 'skip';
		}
		else
		{
			switch (mode)
			{
				case 'description':
					if (t) result.description += (result.description ? ' ' : '') + t;
					break;
				case 'param':
					if (t && result.params.length) result.params[result.params.length - 1].description += '\n' + t;
					break;
				case 'returns':
					if (t && result.returns) result.returns.description += ' ' + t;
					break;
				case 'example':
					exampleBuf.push(line);
					break;
			}
		}
	}
	flushExample();
	return result;
}

/* -- JSDoc → output converters ----------------------------------------- */

const OPTION_PARENTS = new Set(['options', 'opts', 'opt', 'config', 'o']);

function normalizeType(t) { return t.replace(/\s*\|\s*/g, ' | '); }

function isOptionParent(name) { return OPTION_PARENTS.has(name); }

/**
 * Assign parsed examples ({code, lang, title?}) to an item.
 * Sets item.example/exampleLang for the first example (backward compat)
 * and item.examples for the full list.
 */
function assignExamples(item, ...sources)
{
	const ex = sources.find(arr => arr && arr.length);
	if (!ex) return;
	item.example = ex[0].code;
	if (ex[0].lang !== 'javascript') item.exampleLang = ex[0].lang;
	item.examples = ex;
}

function jsdocToOptions(params)
{
	return params
		.filter(p => p.name.includes('.'))
		.map(p => ({
			option:  p.name.split('.').slice(1).join('.'),
			type:    normalizeType(p.type),
			default: p.default !== undefined ? String(p.default) : '—',
			notes:   p.description || '',
		}));
}

function jsdocToParams(params, keepOptionParents)
{
	return params
		.filter(p => !p.name.includes('.') && (keepOptionParents || !isOptionParent(p.name)))
		.map(p => ({
			param:    p.name,
			type:     normalizeType(p.type.replace(/^\.\.\./, '')),
			required: p.optional ? 'No' : 'Yes',
			notes:    p.description || '',
		}));
}

function jsdocToReturns(ret)
{
	if (!ret) return undefined;
	return { type: normalizeType(ret.type), description: ret.description || '' };
}

function buildSignature(name, params)
{
	const topLevel = params.filter(p => !p.name.includes('.'));
	const parts = topLevel.map(p =>
	{
		const isRest = (p.type && p.type.startsWith('...')) || p.name.startsWith('...');
		const clean  = p.name.replace(/^\.\.\./, '');
		if (isRest) return '...' + clean;
		if (p.optional) return '[' + clean + ']';
		return clean;
	});
	return name + '(' + parts.join(', ') + ')';
}

/* ======================================================================
 *  Source File Analyzer
 * ====================================================================== */

/**
 * Parse section comments and @section JSDoc tags from source code.
 * Matches: // -- Name --, // --- Name ---, // === Name ===, and @section Name inside JSDoc blocks.
 * Returns sorted by offset.
 */
function parseSectionComments(source)
{
	const comments = [];
	// Comment-style sections: // -- Name --, // --- Name ---, // === Name ===
	const re = /^\s*\/\/\s*[-=]{2,}\s+(.+?)\s+[-=]+\s*$/gm;
	let m;
	while ((m = re.exec(source)) !== null)
	{
		comments.push({ name: m[1].trim(), offset: m.index });
	}
	// JSDoc @section tags
	const sectionRe = /\/\*\*([\s\S]*?)\*\//g;
	while ((m = sectionRe.exec(source)) !== null)
	{
		const sm = m[1].match(/@section\s+(.+)/); 
		if (sm) comments.push({ name: sm[1].trim(), offset: m.index });
	}
	comments.sort((a, b) => a.offset - b.offset);
	return comments;
}

/**
 * Detect attached methods on an exported name.
 * Finds patterns like:
 *   exportName.method = function name(...) {...}
 *   exportName.method = existingFn;
 */
function detectAttachedMethods(source, exportName)
{
	const methods = [];
	if (!exportName) return methods;

	// fn.method = function name(...) or fn.method = function(...)
	const fnRe = new RegExp(
		exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
		'\\.(\\w+)\\s*=\\s*(?:async\\s+)?function\\s*(\\w*)',
		'g'
	);
	let m;
	while ((m = fnRe.exec(source)) !== null)
	{
		methods.push({ property: m[1], fnName: m[2] || m[1], offset: m.index });
	}

	// fn.method = existingFn; (simple reference assignment)
	const refRe = new RegExp(
		exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
		'\\.(\\w+)\\s*=\\s*(\\w+)\\s*;',
		'g'
	);
	while ((m = refRe.exec(source)) !== null)
	{
		if (!methods.find(x => x.property === m[1]))
		{
			methods.push({ property: m[1], fnName: m[2], offset: m.index });
		}
	}

	return methods;
}

/**
 * Detect error class declarations.
 * Returns: [{ name, extends, statusCode, errorCode, offset }]
 */
function detectErrorClasses(source)
{
	const classes = [];

	// Match class declarations with extends
	const classRe = /^class\s+(\w+)\s+extends\s+(\w+)\s*\{/gm;
	let m;
	while ((m = classRe.exec(source)) !== null)
	{
		const name = m[1];
		const ext = m[2];
		const offset = m.index;

		// Extract status code from super() call within constructor
		const bodyStart = source.indexOf('{', m.index + m[0].length - 1);
		const bodySlice = source.slice(bodyStart, bodyStart + 800);
		let statusCode = null;
		let errorCode = null;

		const superMatch = bodySlice.match(/super\((\d+)/);
		if (superMatch) statusCode = parseInt(superMatch[1], 10);

		// Check for explicit code in super opts
		const codeMatch = bodySlice.match(/code:\s*'([^']+)'/);
		if (codeMatch) errorCode = codeMatch[1];

		classes.push({ name, extends: ext, statusCode, errorCode, offset });
	}

	// Also handle the base class (extends Error, not another HttpError)
	const baseRe = /^class\s+(\w+)\s+extends\s+Error\s*\{/gm;
	while ((m = baseRe.exec(source)) !== null)
	{
		if (!classes.find(c => c.name === m[1]))
		{
			classes.push({ name: m[1], extends: 'Error', statusCode: null, errorCode: null, offset: m.index });
		}
	}

	return classes.sort((a, b) => a.offset - b.offset);
}

/**
 * Find the module.exports value.
 * Returns the exported identifier name, or null.
 */
function findExportName(source)
{
	// module.exports = name;
	const m = source.match(/module\.exports\s*=\s*(\w+)\s*;/);
	return m ? m[1] : null;
}

/**
 * Find class declarations (non-error pattern).
 * Returns [{ name, offset }].
 */
function findClasses(source)
{
	const classes = [];
	const re = /^class\s+(\w+)/gm;
	let m;
	while ((m = re.exec(source)) !== null)
	{
		classes.push({ name: m[1], offset: m.index });
	}
	return classes;
}

/**
 * Determine the current section heading for a given offset.
 */
function getSectionForOffset(sections, offset)
{
	let current = null;
	for (const s of sections)
	{
		if (s.offset < offset) current = s.name;
		else break;
	}
	return current;
}

/* ======================================================================
 *  Item Builders
 * ====================================================================== */

/**
 * Build a method entry from a JSDoc block.
 */
function buildMethodEntry(name, block)
{
	const entry = {
		method:    name,
		signature: buildSignature(name, block.params),
	};

	// Description: from JSDoc or @see text
	if (block.description)
	{
		entry.description = block.description;
	}
	else if (block.see)
	{
		// @see App#route — shortcut for GET requests.
		const seeDesc = block.see.replace(/^[\w#.]+\s*—?\s*/, '').trim();
		if (seeDesc) entry.description = seeDesc.charAt(0).toUpperCase() + seeDesc.slice(1);
	}

	const params = jsdocToParams(block.params, true);
	const opts   = jsdocToOptions(block.params);
	const ret    = jsdocToReturns(block.returns);

	if (params.length)  entry.methodParams   = params;
	if (opts.length)    entry.methodOptions   = opts;
	if (ret)            entry.methodReturns   = ret;

	// Propagate examples from the JSDoc block
	if (block.examples && block.examples.length)
	{
		entry.example = block.examples[0].code;
		if (block.examples[0].lang !== 'javascript') entry.exampleLang = block.examples[0].lang;
		entry.examples = block.examples;
	}

	return entry;
}

/**
 * Build a doc item from a simple factory function source file.
 */
function buildFunctionItem(itemName, relPath)
{
	const absPath = path.join(ROOT, relPath);
	const source  = fs.readFileSync(absPath, 'utf8');
	const blocks  = parseFile(relPath);
	const sections = parseSectionComments(source);

	// Find the module-level JSDoc (has @module tag)
	const moduleBlock = blocks.find(b => b.module);

	// Find the main function — prefer the exported function by name
	const exportName = findExportName(source);
	const mainBlock = (exportName && blocks.find(b => b.name === exportName))
	               || blocks.find(b => !b.module && !b.constructor && b.params.length > 0)
	               || blocks.find(b => !b.module && b.name);

	const item = { name: itemName };

	// Description from module JSDoc or main function JSDoc
	item.description = (moduleBlock && moduleBlock.description)
	                || (mainBlock && mainBlock.description)
	                || '';

	// Options and params from main function
	if (mainBlock)
	{
		const opts   = jsdocToOptions(mainBlock.params);
		const params = jsdocToParams(mainBlock.params);
		const ret    = jsdocToReturns(mainBlock.returns);

		if (opts.length)   item.options = opts;
		if (params.length) item.params  = params;
		if (ret)           item.returns = ret;
	}

	// Example from module or main function
	assignExamples(item, moduleBlock && moduleBlock.examples, mainBlock && mainBlock.examples);

	// Detect attached methods (cookieParser.sign, validate.field, etc.)
	const attached = detectAttachedMethods(source, exportName);

	if (attached.length > 0)
	{
		// Group attached methods by section comments that precede them
		const groups = {};

		for (const att of attached)
		{
			const groupName = getSectionForOffset(sections, att.offset) || 'Methods';
			if (!groups[groupName]) groups[groupName] = [];

			// Find the JSDoc block for this method
			const block = blocks.find(b => b.name === att.fnName || b.name === att.property);
			if (block)
			{
				groups[groupName].push(buildMethodEntry(att.property, block));
			}
		}

		const methodGroups = Object.entries(groups).map(([group, methods]) => ({ group, methods }));
		if (methodGroups.length) item.methodGroups = methodGroups;
	}

	// Detect named object exports: module.exports = { a, b, c }
	if (!item.methodGroups && !exportName)
	{
		const objMatch = source.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
		if (objMatch)
		{
			const names  = [...objMatch[1].matchAll(/\b(\w+)\b/g)].map(m => m[1]);
			const groups = {};

			for (const name of names)
			{
				const block = blocks.find(b => b.name === name && b !== mainBlock && !b.module && !b.constructor);
				if (block && (block.params.length > 0 || block.returns))
				{
					const groupName = getSectionForOffset(sections, block.offset) || 'Methods';
					if (!groups[groupName]) groups[groupName] = [];
					groups[groupName].push(buildMethodEntry(name, block));
				}
			}

			const methodGroups = Object.entries(groups).map(([group, methods]) => ({ group, methods }));
			if (methodGroups.length) item.methodGroups = methodGroups;
		}
	}

	return item;
}

/**
 * Build a doc item from a class source file.
 * Auto-groups methods by `// -- Section Name --` comments.
 */
function buildClassItem(itemName, relPath)
{
	const absPath = path.join(ROOT, relPath);
	const source  = fs.readFileSync(absPath, 'utf8');
	const blocks  = parseFile(relPath);
	const sections = parseSectionComments(source);

	const moduleBlock = blocks.find(b => b.module);

	// Description from module JSDoc
	const item = { name: itemName };
	item.description = (moduleBlock && moduleBlock.description) || '';

	// Example from module JSDoc
	assignExamples(item, moduleBlock && moduleBlock.examples);

	// Constructor options/params
	const ctorBlock = blocks.find(b => b.constructor)
	               || blocks.find(b => b.name === 'constructor');
	if (ctorBlock)
	{
		const opts   = jsdocToOptions(ctorBlock.params);
		const params = jsdocToParams(ctorBlock.params);
		if (opts.length)   item.options = opts;
		if (params.length) item.params  = params;
	}

	// Collect all class methods (non-constructor, non-null name)
	const methods = blocks.filter(b =>
		b.name &&
		b.name !== 'constructor' &&
		!b.module &&
		!b.constructor &&
		// skip internal names that start with _
		!b.name.startsWith('_')
	);

	if (methods.length > 0)
	{
		// Group methods by preceding section comments
		const groups = {};
		const ungrouped = [];

		for (const block of methods)
		{
			const groupName = getSectionForOffset(sections, block.offset);
			if (groupName)
			{
				// Skip group names that indicate internals
				const lower = groupName.toLowerCase();
				if (lower.includes('internal') || lower.includes('private')) continue;

				if (!groups[groupName]) groups[groupName] = [];
				groups[groupName].push(buildMethodEntry(block.name, block));
			}
			else
			{
				ungrouped.push(buildMethodEntry(block.name, block));
			}
		}

		const methodGroups = Object.entries(groups)
			.map(([group, methods]) => ({ group, methods }));

		if (ungrouped.length > 0)
		{
			methodGroups.push({ group: 'Methods', methods: ungrouped });
		}

		if (methodGroups.length) item.methodGroups = methodGroups;
	}

	return item;
}

/**
 * Build a doc item for a CLI / terminal tool.
 * Shows only the module description and usage example — no methods or constructor params.
 */
function buildCliToolItem(itemName, relPath)
{
	const blocks = parseFile(relPath);
	const moduleBlock = blocks.find(b => b.module);

	const item = { name: itemName };
	item.description = (moduleBlock && moduleBlock.description) || '';

	// Structured CLI commands for the frontend renderer — grouped by category
	item.commandGroups = [
		{
			label: 'Scaffolding',
			description: 'Generate starter files so you don\'t write boilerplate by hand. Every file is placed in the directory set by your config (or overridden with <code>--dir</code>).',
			commands: [
				{ cmd: 'npx zh make:migration <name>',  desc: 'Auto-generate a migration by comparing your current Model schemas against the last snapshot. The CLI writes the <code>up()</code> and <code>down()</code> code for you — no manual SQL. Pass <code>--empty</code> to get a blank template instead.', args: '--dir=<path> --models=<path> --empty' },
				{ cmd: 'npx zh make:model <name>',     desc: 'Create a new Model class with a table name, primary key, and <code>timestamps</code> enabled.', args: '--dir=<path>' },
				{ cmd: 'npx zh make:seeder <name>',     desc: 'Create a new Seeder class for inserting sample or default data.', args: '--dir=<path>' },
			],
		},
		{
			label: 'Seeding',
			description: 'Populate your database with initial or test data. Seeders run in alphabetical file order.',
			commands: [
				{ cmd: 'npx zh seed', desc: 'Run every seeder file in the seeders directory.' },
			],
		},
		{
			label: 'Running Migrations',
			description: 'Apply, rollback, and inspect versioned migration files. Each run is tracked in a <code>_migrations</code> table so every environment stays in sync.',
			commands: [
				{ cmd: 'npx zh migrate',          desc: 'Run all pending migrations in order. Tracks each run in a numbered batch for easy rollback.' },
				{ cmd: 'npx zh migrate:rollback',  desc: 'Undo the last batch of migrations. Calls each migration\'s <code>down()</code> in reverse order.' },
				{ cmd: 'npx zh migrate:status',    desc: 'Show which migrations have been applied and which are still pending.' },
				{ cmd: 'npx zh migrate:reset',     desc: 'Rollback every migration, then re-run them all from the start.' },
				{ cmd: 'npx zh migrate:fresh',     desc: 'Drop <strong>all</strong> tables and re-run every migration from scratch. Useful during early development.' },
				{ cmd: 'npx zh migrate:remove',    desc: 'Delete the most recent migration file — but only if it hasn\'t been applied yet. Also reverts the schema snapshot.' },
			],
		},
		{
			label: 'Info',
			commands: [
				{ cmd: 'npx zh help',    desc: 'Print the full help message with all commands and options.' },
				{ cmd: 'npx zh version', desc: 'Print the installed zero-server version.' },
			],
		},
	];

	item.cliOptions = [
		{ flag: '--config=<path>',  desc: 'Path to config file (default: zero.config.js).' },
		{ flag: '--dir=<path>',     desc: 'Output directory for make:* commands.' },
		{ flag: '--models=<path>',  desc: 'Models directory for auto-diff migrations (default: modelsDir from config or "models").' },
		{ flag: '--empty',          desc: 'Generate a blank migration template (skip auto-diff).' },
		{ flag: '--verbose',        desc: 'Show full error stack traces.' },
	];

	// Typical workflow walkthrough
	item.workflows = [
		{
			tab: 'Migrations',
			description: 'Set up your project, create models, and let the CLI auto-generate migrations from your schemas.',
			steps: [
				{ label: '1. Create a config file', code: '// zero.config.js\nmodule.exports = {\n    adapter:       \'sqlite\',\n    connection:    { filename: \'./app.db\' },\n    migrationsDir: \'./migrations\',\n    seedersDir:    \'./seeders\',\n    modelsDir:     \'./models\',\n};' },
				{
					label: '2. Create your models',
					note: 'Scaffold new model files with the CLI, or point <code>modelsDir</code> at models you already have.',
					tabs: [
						{ tab: 'Scaffold new', code: '$ npx zh make:model User\n$ npx zh make:model Post' },
						{ tab: 'Use existing', code: '// If you already have model files, just make sure\n// modelsDir in zero.config.js points to them:\n\nmodelsDir: \'./src/models\',' },
					],
				},
				{ label: '3. Define your schemas', code: '// models/User.js\nclass User extends Model {\n    static table = \'users\';\n    static schema = {\n        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },\n        name:  { type: TYPES.STRING, required: true, maxLength: 100 },\n        email: { type: TYPES.STRING, required: true, unique: true },\n    };\n    static timestamps = true;\n}' },
				{ label: '4. Auto-generate the migration', code: '$ npx zh make:migration initial_schema\n\n  Detected schema changes:\n    + Table users\n\n  Migration created: migrations/20260402120000_initial_schema.js' },
				{ label: '5. Apply the migration', code: '$ npx zh migrate\n\n  Running migrations...\n    ✓ 20260402120000_initial_schema\n\n  1 migration(s) completed (batch 1).' },
				{ label: '6. Later — add a column', code: '// Add to models/User.js schema:\n//   avatar: { type: TYPES.STRING, maxLength: 255 },\n\n$ npx zh make:migration add_avatar_to_users\n\n  Detected schema changes:\n    + users.avatar\n\n  Migration created: migrations/20260403090000_add_avatar_to_users.js\n\n$ npx zh migrate' },
			],
		},
		{
			tab: 'Seeding',
			description: 'Populate your database with sample or default data. Seeders run alphabetically — use numeric prefixes to control the order.',
			steps: [
				{ label: '1. Scaffold a seeder', code: '$ npx zh make:seeder Users' },
				{ label: '2. Write your seed data', code: '// seeders/UsersSeeder.js\nconst { Seeder, Factory, Fake } = require(\'@zero-server/sdk\');\nconst User = require(\'../models/User\');\n\nclass UsersSeeder extends Seeder\n{\n    async run(db) {\n        const factory = new Factory(User);\n        factory.define({\n            name:  () => Fake.fullName(),\n            email: () => Fake.email({ unique: true }),\n            role:  \'user\',\n        });\n\n        await factory.count(20).create();\n\n        // create a few admins\n        factory.state(\'admin\', { role: \'admin\' });\n        await factory.count(3).withState(\'admin\').create();\n    }\n}\n\nmodule.exports = UsersSeeder;' },
				{ label: '3. Run your seeders', code: '$ npx zh seed\n\n  Running seeders...\n    ✓ UsersSeeder\n\n  1 seeder(s) completed.' },
			],
		},
		{
			tab: 'Undo & Redo',
			description: 'Roll back mistakes, reset your schema, or start fresh during development.',
			steps: [
				{ label: 'Rollback the last batch', code: '$ npx zh migrate:rollback\n\n  Rolling back batch 2...\n    ✓ 20260403090000_add_avatar_to_users\n\n  1 migration(s) rolled back.' },
				{ label: 'Check current status', code: '$ npx zh migrate:status\n\n  Applied:\n    ✓ 20260402120000_initial_schema  (batch 1)\n\n  Pending:\n    ○ 20260403090000_add_avatar_to_users' },
				{ label: 'Remove an unapplied migration', code: '$ npx zh migrate:remove\n\n  Removed: 20260403090000_add_avatar_to_users.js\n  Snapshot updated.' },
				{ label: 'Start completely fresh', code: '// Drop all tables and re-run every migration\n$ npx zh migrate:fresh\n\n  Dropped all tables.\n  Running migrations...\n    ✓ 20260402120000_initial_schema\n\n  1 migration(s) completed (batch 1).' },
			],
		},
	];

	item.configExamples = [
		{
			adapter: 'SQLite',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'sqlite\',\n' +
				'    connection: { filename: \'./app.db\' },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'MySQL',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'mysql\',\n' +
				'    connection: {\n' +
				'        host: \'127.0.0.1\',\n' +
				'        port: 3306,\n' +
				'        user: \'root\',\n' +
				'        password: \'\',\n' +
				'        database: \'myapp\',\n' +
				'    },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'PostgreSQL',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'postgres\',\n' +
				'    connection: {\n' +
				'        host: \'127.0.0.1\',\n' +
				'        port: 5432,\n' +
				'        user: \'postgres\',\n' +
				'        password: \'\',\n' +
				'        database: \'myapp\',\n' +
				'    },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'MongoDB',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'mongo\',\n' +
				'    connection: {\n' +
				'        url: \'mongodb://127.0.0.1:27017\',\n' +
				'        database: \'myapp\',\n' +
				'    },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'Redis',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'redis\',\n' +
				'    connection: {\n' +
				'        host: \'127.0.0.1\',\n' +
				'        port: 6379,\n' +
				'    },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'Memory',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'memory\',\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
		{
			adapter: 'JSON file',
			code:
				'// zero.config.js\n' +
				'module.exports = {\n' +
				'    adapter: \'json\',\n' +
				'    connection: { dir: \'./data\' },\n' +
				'    migrationsDir: \'./migrations\',\n' +
				'    seedersDir:    \'./seeders\',\n' +
				'    modelsDir:     \'./models\',\n' +
				'};',
		},
	];

	// Mark as CLI tool for the frontend renderer
	item.cliTool = true;

	return item;
}

/**
 * Build a doc item from a proxy-style file (env).
 * Detects `envFn.method = method;` assignments and groups by section comments.
 */
function buildProxyItem(itemName, relPath)
{
	const absPath = path.join(ROOT, relPath);
	const source  = fs.readFileSync(absPath, 'utf8');
	const blocks  = parseFile(relPath);
	const sections = parseSectionComments(source);
	const moduleBlock = blocks.find(b => b.module);

	const item = { name: itemName };
	item.description = (moduleBlock && moduleBlock.description) || '';

	assignExamples(item, moduleBlock && moduleBlock.examples);

	// Find the proxy target name (e.g. envFn)
	const proxyMatch = source.match(/new\s+Proxy\(\s*(\w+)/);
	const proxyTarget = proxyMatch ? proxyMatch[1] : null;

	if (proxyTarget)
	{
		// Find all attached methods: target.method = existingFn;
		const attached = detectAttachedMethods(source, proxyTarget);

		if (attached.length > 0)
		{
			const groups = {};

			for (const att of attached)
			{
				// Find the function's actual JSDoc block (by the function name, not the property)
				const block = blocks.find(b => b.name === att.fnName)
				           || blocks.find(b => b.name === att.property);
				if (!block) continue;

				const groupName = getSectionForOffset(sections, block.offset) || 'Methods';
				// Skip internal sections
				const lower = groupName.toLowerCase();
				if (lower.includes('internal') || lower.includes('private')) continue;

				if (!groups[groupName]) groups[groupName] = [];
				groups[groupName].push(buildMethodEntry(att.property, block));
			}

			const methodGroups = Object.entries(groups)
				.map(([group, methods]) => ({ group, methods }));
			if (methodGroups.length) item.methodGroups = methodGroups;
		}
	}

	return item;
}

/**
 * Build a doc item for error classes.
 * Auto-discovers all class declarations, extracts status codes,
 * and groups by `// --- Section Name ---` comments.
 */
function buildErrorItem(itemName, relPath)
{
	const absPath = path.join(ROOT, relPath);
	const source  = fs.readFileSync(absPath, 'utf8');
	const blocks  = parseFile(relPath);
	const sections = parseSectionComments(source);
	const moduleBlock = blocks.find(b => b.module);

	const item = { name: itemName };
	item.description = (moduleBlock && moduleBlock.description) || '';

	assignExamples(item, moduleBlock && moduleBlock.examples);

	const errorClasses = detectErrorClasses(source);

	// STATUS_TEXT map for deriving default error codes
	const STATUS_TEXT = {
		400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
		403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
		406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
		410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
		418: "I'm a Teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests',
		500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
		503: 'Service Unavailable', 504: 'Gateway Timeout',
	};

	function deriveCode(statusCode)
	{
		const text = STATUS_TEXT[statusCode] || 'ERROR';
		return text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/(^_|_$)/g, '');
	}

	// Group error classes by section comments
	const groups = {};

	for (let ci = 0; ci < errorClasses.length; ci++)
	{
		const cls = errorClasses[ci];
		const groupName = getSectionForOffset(sections, cls.offset) || 'Errors';
		// Skip factory/status-text sections
		const lower = groupName.toLowerCase();
		if (lower.includes('factory') || lower.includes('status text') || lower.includes('exports'))
			continue;

		if (!groups[groupName]) groups[groupName] = [];

		// Find class-level JSDoc by className match (extractName returns null for class decls)
		const classDoc = blocks.find(b => b.className === cls.name);

		// Find constructor JSDoc INSIDE the class body (offset after class, before next class)
		const nextOffset = ci < errorClasses.length - 1
			? errorClasses[ci + 1].offset
			: source.length;
		const ctorDoc = blocks.find(b =>
			b.offset > cls.offset && b.offset < nextOffset &&
			(b.name === 'constructor' || b.constructor || b.params.length > 0)
		);

		// Pick best doc for signature and params: constructor JSDoc if present, else class-level
		const paramDoc = ctorDoc || classDoc;

		// Build entry
		const status = cls.statusCode || '—';
		const code = cls.errorCode || (cls.statusCode ? deriveCode(cls.statusCode) : '—');

		const entry = {
			method: cls.name,
			signature: cls.extends === 'Error'
				? `new ${cls.name}(statusCode, [message], [opts])`
				: `new ${cls.name}([message], [opts])`,
			description: (classDoc && classDoc.description) || (cls.statusCode ? STATUS_TEXT[cls.statusCode] || '' : ''),
		};

		if (paramDoc && paramDoc.params.length > 0)
		{
			// Rebuild signature from actual constructor params
			entry.signature = `new ${cls.name}(${
				paramDoc.params
					.filter(p => !p.name.includes('.'))
					.map(p => p.optional ? `[${p.name}]` : p.name)
					.join(', ')
			})`;

			entry.methodParams = jsdocToParams(paramDoc.params, true);
			const opts = jsdocToOptions(paramDoc.params);
			if (opts.length) entry.methodOptions = opts;
		}
		else
		{
			// No constructor JSDoc — show actual constructor params
			if (cls.extends === 'Error')
				entry.methodParams = [
					{ param: 'statusCode', type: 'number', required: 'Yes', notes: 'HTTP status code' },
					{ param: 'message', type: 'string', required: 'No', notes: 'Human-readable error message' },
					{ param: 'opts', type: 'object', required: 'No', notes: 'Additional options (code, details)' },
				];
			else
				entry.methodParams = [
					{ param: 'message', type: 'string', required: 'No', notes: 'Human-readable error message' },
					{ param: 'opts', type: 'object', required: 'No', notes: 'Additional options (code, details)' },
				];
		}

		groups[groupName].push(entry);
	}

	// Also add factory functions (createError, isHttpError) - standalone functions after classes
	const factoryFns = blocks.filter(b =>
		b.name && !b.module && !b.constructor &&
		(b.name === 'createError' || b.name === 'isHttpError')
	);

	if (factoryFns.length > 0)
	{
		const factoryMethods = factoryFns.map(b => buildMethodEntry(b.name, b));
		groups['Utilities'] = factoryMethods;
	}

	const methodGroups = Object.entries(groups)
		.map(([group, methods]) => ({ group, methods }));
	if (methodGroups.length) item.methodGroups = methodGroups;

	return item;
}

/**
 * Build a doc item for the TYPES constant from schema.js.
 * Extracts property names and JSDoc description.
 */
function buildTypesItem(itemName, relPath)
{
	const absPath = path.join(ROOT, relPath);
	const source  = fs.readFileSync(absPath, 'utf8');
	const blocks  = parseFile(relPath);
	const moduleBlock = blocks.find(b => b.module);

	const item = { name: itemName };
	item.description = 'Column type constants for ORM schema definitions. Use these when defining model schemas to specify the data type of each column.';

	// Extract TYPES constant entries, grouped by inline comments
	const typesMatch = source.match(/const\s+TYPES\s*=\s*\{([^}]+)\}/s);
	if (typesMatch)
	{
		const lines  = typesMatch[1].split('\n');
		const groups = [];
		let cur = { category: 'Core', options: [] };

		for (const line of lines)
		{
			const cmatch = line.match(/^\s*\/\/\s*(.+)/);
			if (cmatch)
			{
				if (cur.options.length) groups.push(cur);
				cur = { category: cmatch[1].trim(), options: [] };
				continue;
			}
			const ematch = line.match(/(\w+):\s*'([^']+)'/);
			if (ematch)
			{
				cur.options.push({ option: ematch[1], type: 'string', default: `'${ematch[2]}'`, notes: `Maps to '${ematch[2]}' column type.` });
			}
		}
		if (cur.options.length) groups.push(cur);

		if (groups.length > 1) item.optionGroups = groups;
		else if (groups.length === 1) item.options = groups[0].options;
	}

	const typesBlock = blocks.find(b => b.name === 'TYPES');
	assignExamples(item, typesBlock && typesBlock.examples);
	if (!item.example)
	{
		item.example = [
			"const { TYPES } = require('@zero-server/sdk')",
			'',
			'const schema = {',
			'\tname:    { type: TYPES.STRING,  required: true },',
			'\tage:     { type: TYPES.INTEGER },',
			'\tactive:  { type: TYPES.BOOLEAN, default: true },',
			'\tprofile: { type: TYPES.JSON },',
			'}'
		].join('\n');
	}

	return item;
}

/**
 * Build a filtered error item showing only specific groups.
 */
function buildFilteredErrorItem(itemName, relPath, groupFilter)
{
	const fullItem = buildErrorItem(itemName, relPath);
	if (fullItem.methodGroups)
	{
		fullItem.methodGroups = fullItem.methodGroups.filter(g => groupFilter.includes(g.group));
	}
	fullItem.name = itemName;
	fullItem.description = 'Specialized error classes for framework internals, ORM operations, and infrastructure failures. All extend HttpError and carry structured context.';
	return fullItem;
}

/**
 * Build a doc item from multiple source files (Seeder & Factory).
 * Parses each source as a class and merges results.
 */
function buildMultiSourceItem(itemConfig)
{
	const item = { name: itemConfig.name, description: '' };
	const allGroups = [];

	// Primary source
	const sources = [itemConfig.source, ...(itemConfig.extras || [])];

	for (const relPath of sources)
	{
		const absPath = path.join(ROOT, relPath);
		if (!fs.existsSync(absPath)) continue;

		const source  = fs.readFileSync(absPath, 'utf8');
		const blocks  = parseFile(relPath);
		const sections = parseSectionComments(source);
		const moduleBlock = blocks.find(b => b.module);
		const classes = findClasses(source);

		// Use first file's module description if main item has none
		if (!item.description && moduleBlock && moduleBlock.description)
		{
			item.description = moduleBlock.description;
		}
		if (!item.example) assignExamples(item, moduleBlock && moduleBlock.examples);

		// For each class in the file, build methods
		for (const cls of classes)
		{
			const classMethods = blocks.filter(b =>
				b.name && b.name !== 'constructor' && !b.module && !b.constructor &&
				!b.name.startsWith('_') && b.offset > cls.offset
			);

			// Constructor params become a method entry for the class
			const ctorBlock = blocks.find(b =>
				(b.constructor || b.name === 'constructor') && b.offset > cls.offset
			);

			// Get class-level JSDoc
			const classDoc = blocks.find(b => b.className === cls.name);
			const classDesc = (classDoc && classDoc.description) || '';

			// Build constructor entry
			let ctorEntry = null;
			if (ctorBlock)
			{
				ctorEntry = buildMethodEntry('constructor', ctorBlock);
				ctorEntry.method = cls.name;
				ctorEntry.signature = buildSignature('new ' + cls.name, ctorBlock.params);
				if (classDesc) ctorEntry.description = classDesc;
			}

			// Collect class methods, grouped by section comments
			const sectionGroups = {};
			const ungrouped = [];

			for (const block of classMethods)
			{
				const nextCls = classes.find(c => c.offset > cls.offset);
				if (nextCls && block.offset > nextCls.offset) continue;

				const groupName = getSectionForOffset(sections, block.offset);
				const lower = (groupName || '').toLowerCase();
				if (lower.includes('internal') || lower.includes('private')) continue;

				const entry = buildMethodEntry(block.name, block);
				if (groupName)
				{
					if (!sectionGroups[groupName]) sectionGroups[groupName] = [];
					sectionGroups[groupName].push(entry);
				}
				else
				{
					ungrouped.push(entry);
				}
			}

			const sectionKeys = Object.keys(sectionGroups);

			if (sectionKeys.length > 1)
			{
				// Multiple section groups → split into separate groups
				if (ctorEntry) allGroups.push({ group: cls.name, methods: [ctorEntry] });
				for (const groupName of sectionKeys)
				{
					allGroups.push({ group: groupName, methods: sectionGroups[groupName] });
				}
				if (ungrouped.length) allGroups.push({ group: cls.name, methods: ungrouped });
			}
			else
			{
				// Single or no sections → keep in one group
				const methods = [];
				if (ctorEntry) methods.push(ctorEntry);
				if (sectionKeys.length === 1) methods.push(...sectionGroups[sectionKeys[0]]);
				methods.push(...ungrouped);
				if (methods.length) allGroups.push({ group: cls.name, methods });
			}
		}
	}

	if (allGroups.length) item.methodGroups = allGroups;
	return item;
}

/* ======================================================================
 *  Source type detection & dispatch
 * ====================================================================== */

/**
 * Determine what kind of source file this is and build the item accordingly.
 */
function buildFromSource(itemConfig)
{
	const relPath = itemConfig.source;
	const absPath = path.join(ROOT, relPath);

	if (!fs.existsSync(absPath))
	{
		console.warn(`  ⚠  Source file not found: ${relPath}`);
		return { name: itemConfig.name, description: 'Source file not found.' };
	}

	// Special: TYPES symbol — extract constant properties as options
	if (itemConfig.symbol === 'TYPES')
	{
		return buildTypesItem(itemConfig.name, relPath);
	}

	// Special: filtered error groups (Framework Errors)
	if (itemConfig.groups)
	{
		return buildFilteredErrorItem(itemConfig.name, relPath, itemConfig.groups);
	}

	// Special: multi-source item (Seeder & Factory)
	if (itemConfig.extras)
	{
		return buildMultiSourceItem(itemConfig);
	}

	// Special: CLI / terminal tool — show description + example only, no methods
	if (itemConfig.cliTool)
	{
		return buildCliToolItem(itemConfig.name, relPath);
	}

	const source = fs.readFileSync(absPath, 'utf8');

	// Detect file type by content patterns
	const classes = findClasses(source);
	const hasProxy = /new\s+Proxy\(/.test(source);
	const errorClassCount = (source.match(/class\s+\w+\s+extends\s+(?:HttpError|DatabaseError|Error)\s*\{/g) || []).length;

	// Error file: many error class declarations
	if (errorClassCount >= 3)
	{
		return buildErrorItem(itemConfig.name, relPath);
	}

	// Proxy file: exports a Proxy-wrapped function
	if (hasProxy)
	{
		return buildProxyItem(itemConfig.name, relPath);
	}

	// Class file: one or more classes
	if (classes.length >= 1)
	{
		return buildClassItem(itemConfig.name, relPath);
	}

	// Function file (default)
	return buildFunctionItem(itemConfig.name, relPath);
}

/* ======================================================================
 *  Pipeline
 * ====================================================================== */

const config = require('./docs-config');

console.log(`\n  zero-server docs build — v${version}\n`);

/* -- 1. Generate section JSON files -------------------------------- */

/* Clean up legacy root-level data files (now versioned only) */
const legacySections = path.join(DATA_DIR, 'sections');
if (fs.existsSync(legacySections)) fs.rmSync(legacySections, { recursive: true });
const legacyManifest = path.join(DATA_DIR, 'docs-manifest.json');
if (fs.existsSync(legacyManifest)) fs.unlinkSync(legacyManifest);

const versionDir = path.join(VERSIONS_DIR, version);
if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true });
fs.mkdirSync(path.join(versionDir, 'sections'), { recursive: true });

const manifest = [];
let totalItems = 0;
let sourceItems = 0;

for (const section of config)
{
	const output = {
		section: section.section,
		icon:    section.icon,
		items:   [],
	};

	for (const itemCfg of section.items)
	{
		totalItems++;

		if (itemCfg.static)
		{
			// Static items: use content directly from config
			const staticItem = { name: itemCfg.name };
			if (itemCfg.description)  staticItem.description  = itemCfg.description;
			if (itemCfg.example)      staticItem.example      = itemCfg.example;
			if (itemCfg.exampleLang)  staticItem.exampleLang  = itemCfg.exampleLang;
			if (itemCfg.tips)         staticItem.tips         = itemCfg.tips;
			if (itemCfg.options)      staticItem.options      = itemCfg.options;
			if (itemCfg.params)       staticItem.params       = itemCfg.params;
			output.items.push(staticItem);
		}
		else if (itemCfg.source)
		{
			// Source-backed items: auto-build from JSDoc
			const item = buildFromSource(itemCfg);
			output.items.push(item);
			sourceItems++;
		}
	}

	const json = JSON.stringify(output, null, '\t') + '\n';
	fs.writeFileSync(path.join(versionDir, 'sections', section.file), json);
	manifest.push(section.file);
}

// Write manifest
const manifestJson = JSON.stringify(manifest, null, '\t') + '\n';
fs.writeFileSync(path.join(versionDir, 'docs-manifest.json'), manifestJson);

console.log(`  ✓ Generated ${manifest.length} sections (${sourceItems} from source, ${totalItems - sourceItems} static)`);

/* -- 1b. Generate patch notes -------------------------------------- */

/**
 * Compare two version section sets and produce a patch-notes.json
 * listing added/removed/changed items and methods.
 */
function generatePatchNotes(currentVer, currentDir)
{
	// Find the previous version
	let prevVersions = [];
	try { prevVersions = JSON.parse(fs.readFileSync(VERSIONS_JSON, 'utf8')); }
	catch { prevVersions = []; }

	const prev = prevVersions.find(v => v.version !== currentVer);
	if (!prev)
	{
		// First version — everything is "added"
		const notes = { version: currentVer, previousVersion: null, date: new Date().toISOString().split('T')[0], changes: [] };
		const sections = loadSections(currentDir);
		for (const section of sections)
		{
			for (const item of section.items || [])
			{
				notes.changes.push({
					type:    'added',
					kind:    'item',
					section: section.section,
					name:    item.name,
					description: item.description || '',
				});
			}
		}
		return notes;
	}

	const prevDir = path.join(VERSIONS_DIR, prev.version);
	if (!fs.existsSync(prevDir)) return null;

	const oldSections = loadSections(prevDir);
	const newSections = loadSections(currentDir);

	const notes = {
		version:         currentVer,
		previousVersion: prev.version,
		date:            new Date().toISOString().split('T')[0],
		changes:         [],
	};

	// Index old items: "Section > ItemName" → { item, methods: Set }
	const oldIndex = new Map();
	for (const s of oldSections)
	{
		for (const item of s.items || [])
		{
			const key = s.section + ' > ' + item.name;
			const methods = new Set();
			for (const g of item.methodGroups || [])
			{
				for (const m of g.methods || [])
				{
					if (m.method) methods.add(m.method);
				}
			}
			oldIndex.set(key, { item, methods, section: s.section });
		}
	}

	// Index new items
	const newIndex = new Map();
	for (const s of newSections)
	{
		for (const item of s.items || [])
		{
			const key = s.section + ' > ' + item.name;
			const methods = new Set();
			for (const g of item.methodGroups || [])
			{
				for (const m of g.methods || [])
				{
					if (m.method) methods.add(m.method);
				}
			}
			newIndex.set(key, { item, methods, section: s.section });
		}
	}

	// Detect added items
	for (const [key, entry] of newIndex)
	{
		if (!oldIndex.has(key))
		{
			notes.changes.push({
				type: 'added', kind: 'item',
				section: entry.section, name: entry.item.name,
				description: entry.item.description || '',
			});
		}
	}

	// Detect removed items
	for (const [key, entry] of oldIndex)
	{
		if (!newIndex.has(key))
		{
			notes.changes.push({
				type: 'removed', kind: 'item',
				section: entry.section, name: entry.item.name,
				description: entry.item.description || '',
			});
		}
	}

	// Detect method-level changes for shared items
	for (const [key, newEntry] of newIndex)
	{
		const oldEntry = oldIndex.get(key);
		if (!oldEntry) continue;

		for (const m of newEntry.methods)
		{
			if (!oldEntry.methods.has(m))
			{
				notes.changes.push({
					type: 'added', kind: 'method',
					section: newEntry.section, name: newEntry.item.name,
					method: m,
				});
			}
		}

		for (const m of oldEntry.methods)
		{
			if (!newEntry.methods.has(m))
			{
				notes.changes.push({
					type: 'removed', kind: 'method',
					section: newEntry.section, name: newEntry.item.name,
					method: m,
				});
			}
		}
	}

	// Reconcile items that moved between sections (same name + description, different section).
	// These should not appear as "removed + added" — reclassify as "moved".
	const addedItems  = notes.changes.filter(c => c.type === 'added'  && c.kind === 'item');
	const removedItems = notes.changes.filter(c => c.type === 'removed' && c.kind === 'item');
	const movedNames = new Set();
	for (const a of addedItems)
	{
		const match = removedItems.find(r => r.name === a.name && r.description === a.description && r.section !== a.section);
		if (match)
		{
			movedNames.add(a.name);
			notes.changes.push({
				type: 'moved', kind: 'item',
				section: a.section, name: a.name,
				fromSection: match.section,
				description: a.description,
			});
		}
	}
	if (movedNames.size)
	{
		notes.changes = notes.changes.filter(c =>
			!(c.kind === 'item' && (c.type === 'added' || c.type === 'removed') && movedNames.has(c.name))
		);
	}

	// Detect new sections
	const oldSectionNames = new Set(oldSections.map(s => s.section));
	const newSectionNames = new Set(newSections.map(s => s.section));
	for (const s of newSectionNames) { if (!oldSectionNames.has(s)) notes.changes.push({ type: 'added', kind: 'section', section: s, name: s }); }
	for (const s of oldSectionNames) { if (!newSectionNames.has(s)) notes.changes.push({ type: 'removed', kind: 'section', section: s, name: s }); }

	return notes;
}

function loadSections(versionDir)
{
	const manifestPath = path.join(versionDir, 'docs-manifest.json');
	if (!fs.existsSync(manifestPath)) return [];
	const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const sections = [];
	for (const f of files)
	{
		const fp = path.join(versionDir, 'sections', f);
		if (fs.existsSync(fp)) sections.push(JSON.parse(fs.readFileSync(fp, 'utf8')));
	}
	return sections;
}

const patchNotes = generatePatchNotes(version, versionDir);
if (patchNotes)
{
	fs.writeFileSync(path.join(versionDir, 'patch-notes.json'), JSON.stringify(patchNotes, null, '\t') + '\n');
	console.log(`  ✓ patch-notes.json (${patchNotes.changes.length} change${patchNotes.changes.length !== 1 ? 's' : ''})`);
}

/* -- 2. Run tests + generate badges -------------------------------- */

console.log('\n  Running tests + badges…\n');
try
{
	execSync('node .tools/build-badges.js', { cwd: ROOT, stdio: 'inherit' });
	console.log('  ✓ Tests + badges');
}
catch (err)
{
	console.error('  ⚠  Tests completed with failures (badges still generated)');
}

if (fs.existsSync(BADGES_FILE))
{
	fs.copyFileSync(BADGES_FILE, path.join(versionDir, 'badges.json'));
	fs.unlinkSync(BADGES_FILE);
}

/* -- 3. Update versions.json --------------------------------------- */

let versions = [];
try { versions = JSON.parse(fs.readFileSync(VERSIONS_JSON, 'utf8')); }
catch { versions = []; }

versions = versions.filter(v => v.version !== version);
versions.unshift({ version, date: new Date().toISOString().split('T')[0], latest: true });
for (let i = 1; i < versions.length; i++) versions[i].latest = false;

fs.writeFileSync(VERSIONS_JSON, JSON.stringify(versions, null, '\t') + '\n');
console.log(`  ✓ versions.json (${versions.length} version${versions.length !== 1 ? 's' : ''})`);

/* -- 4. Generate API.md -------------------------------------------- */

try
{
	execSync(`node .tools/build-api-md.js ${version}`, { cwd: ROOT, stdio: 'inherit' });
	console.log('  ✓ API.md');
}
catch (err)
{
	console.error('  ✗ API.md generation failed');
	process.exit(1);
}

/* -- 5. Cache-bust ------------------------------------------------- */

const stamp = Date.now().toString(36);
let html = fs.readFileSync(HTML_PATH, 'utf8');

html = html.replace(
	/(<link\s[^>]*href=")([^"?]+)(?:\?v=[^"]*)?(")/g,
	(m, pre, file, post) => /\.css$/.test(file) ? `${pre}${file}?v=${stamp}${post}` : m
);
html = html.replace(
	/(<script\s[^>]*src=")([^"?]+)(?:\?v=[^"]*)?(")/g,
	(_, pre, file, post) => `${pre}${file}?v=${stamp}${post}`
);
html = html.replace(
	/window\.__v\s*=\s*'[^']*'/,
	`window.__v='${stamp}'`
);

fs.writeFileSync(HTML_PATH, html, 'utf8');
console.log(`  ✓ Cache-bust (v=${stamp})`);

/* -- Done ---------------------------------------------------------- */

console.log(`\n  ✓ Build complete — v${version}\n`);
