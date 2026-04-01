#!/usr/bin/env node
/**
 * build-api-md.js — Generate API.md from split section files
 *
 * Reads documentation/public/data/docs-manifest.json and the corresponding
 * per-section files in documentation/public/data/sections/ to produce a
 * comprehensive Markdown API reference.
 *
 * READ-ONLY — never modifies docs.json or any section file.
 *
 * Usage:  node scripts/build-api-md.js
 * npm:    npm run build:api
 */
const fs   = require('fs');
const path = require('path');

const ROOT         = path.resolve(__dirname, '..');
const DATA_DIR     = path.join(ROOT, 'documentation', 'public', 'data');
const MANIFEST     = path.join(DATA_DIR, 'docs-manifest.json');
const SECTIONS_DIR = path.join(DATA_DIR, 'sections');
const OUTPUT       = path.join(ROOT, 'API.md');

// -- Static content ------------------------------------------

const HEADER = `<p align="center">
  <a href="https://z-http.com">
    <img src="documentation/public/icons/logo-animated.svg" alt="zero-http logo" width="120" height="120">
  </a>
</p>

<h1 align="center">zero-http — API Reference</h1>

<p align="center">
  <strong>
    <a href="https://z-http.com">📖 Interactive docs, live playground, and searchable reference at z-http.com →</a>
  </strong>
</p>

---`;

const EXPORTS_SECTION = `## Exports

All exports are available from the package root:

\`\`\`js
const {
  createApp, Router, cors, fetch,
  json, urlencoded, text, raw, multipart,
  static: serveStatic,
  rateLimit, logger, compress,
  helmet, timeout, requestId, cookieParser,
  csrf, validate, errorHandler,
  env, Database, Model, TYPES, Query,
  Migrator, defineMigration, QueryCache,
  Seeder, SeederRunner, Factory, Fake,
  HttpError, NotFoundError, BadRequestError, ValidationError, createError, isHttpError,
  ConnectionError, MigrationError, TransactionError, QueryError, AdapterError, CacheError,
  debug, version,
  WebSocketConnection, WebSocketPool, SSEStream
} = require('zero-http')
\`\`\`

| Export | Type | Description |
|---|---|---|
| \`createApp()\` | function | Create a new application instance |
| \`Router()\` | function | Create a standalone router for modular route grouping |
| \`json\` | function | JSON body parser factory |
| \`urlencoded\` | function | URL-encoded body parser factory |
| \`text\` | function | Text body parser factory |
| \`raw\` | function | Raw/binary body parser factory |
| \`multipart\` | function | Streaming multipart/form-data parser factory |
| \`static\` | function | Static file serving middleware factory |
| \`cors\` | function | CORS middleware factory |
| \`helmet\` | function | Security headers middleware factory |
| \`compress\` | function | Response compression middleware (brotli/gzip/deflate) |
| \`rateLimit\` | function | In-memory rate-limiting middleware factory |
| \`logger\` | function | Request-logging middleware factory |
| \`timeout\` | function | Request timeout middleware factory |
| \`requestId\` | function | Request ID middleware factory |
| \`cookieParser\` | function | Cookie parsing middleware factory |
| \`csrf\` | function | CSRF protection middleware factory |
| \`validate\` | function | Request validation middleware factory |
| \`errorHandler\` | function | Configurable error-handling middleware factory |
| \`env\` | proxy | Typed environment variable loader and accessor |
| \`Database\` | class | ORM database connection factory |
| \`Model\` | class | Base model class for defining database entities |
| \`TYPES\` | enum | Column type constants for model schemas |
| \`Query\` | class | Fluent query builder |
| \`Migrator\` | class | Versioned migration framework |
| \`defineMigration\` | function | Migration definition helper |
| \`QueryCache\` | class | In-memory LRU query cache with TTL |
| \`Seeder\` | class | Base seeder class for data population |
| \`SeederRunner\` | class | Seeder orchestration runner |
| \`Factory\` | class | Model record factory for testing |
| \`Fake\` | class | Built-in fake data generator |
| \`HttpError\` | class | Base HTTP error class with status code |
| \`BadRequestError\` | class | 400 error |
| \`UnauthorizedError\` | class | 401 error |
| \`ForbiddenError\` | class | 403 error |
| \`NotFoundError\` | class | 404 error |
| \`MethodNotAllowedError\` | class | 405 error |
| \`ConflictError\` | class | 409 error |
| \`GoneError\` | class | 410 error |
| \`PayloadTooLargeError\` | class | 413 error |
| \`UnprocessableEntityError\` | class | 422 error |
| \`ValidationError\` | class | 422 error with field-level details |
| \`TooManyRequestsError\` | class | 429 error |
| \`InternalError\` | class | 500 error |
| \`NotImplementedError\` | class | 501 error |
| \`BadGatewayError\` | class | 502 error |
| \`ServiceUnavailableError\` | class | 503 error |
| \`DatabaseError\` | class | Database operation error |
| \`ConnectionError\` | class | Database connection error |
| \`MigrationError\` | class | Migration execution error |
| \`TransactionError\` | class | Transaction error |
| \`QueryError\` | class | Query execution error |
| \`AdapterError\` | class | Adapter-level error |
| \`CacheError\` | class | Cache operation error |
| \`ConfigurationError\` | class | Configuration/setup error |
| \`MiddlewareError\` | class | Middleware pipeline error |
| \`RoutingError\` | class | Routing resolution error |
| \`TimeoutError\` | class | Operation timeout error |
| \`createError\` | function | Create an \`HttpError\` by status code |
| \`isHttpError\` | function | Check if a value is an \`HttpError\` instance |
| \`debug\` | function | Namespaced debug logger factory |
| \`fetch\` | function | Server-side HTTP/HTTPS client |
| \`version\` | string | Package version string |
| \`WebSocketConnection\` | class | WebSocket connection wrapper |
| \`WebSocketPool\` | class | WebSocket connection & room manager |
| \`SSEStream\` | class | SSE stream controller |`;

const EXAMPLES_SECTION = `## Examples

### WebSocket Chat with Rooms

\`\`\`js
const { createApp, WebSocketPool } = require('zero-http')
const app = createApp()
const pool = new WebSocketPool()

app.ws('/chat', (ws, req) => {
  const room = req.query.room || 'general'
  ws.data.name = req.query.name || 'Anon'

  pool.add(ws)
  pool.join(ws, room)
  pool.toRoomJSON(room, { type: 'join', user: ws.data.name }, ws)

  ws.on('message', msg => {
    pool.toRoomJSON(room, { type: 'message', user: ws.data.name, text: msg }, ws)
  })

  ws.on('close', () => {
    pool.toRoomJSON(room, { type: 'leave', user: ws.data.name })
  })
})

app.listen(3000)
\`\`\`

### Real-Time Dashboard with SSE

\`\`\`js
const { createApp, helmet, compress } = require('zero-http')
const app = createApp()
app.use(helmet())
app.use(compress())

const clients = new Set()

app.get('/dashboard/stream', (req, res) => {
  const sse = res.sse({ autoId: true, keepAlive: 15000, pad: 2048 })
  clients.add(sse)
  sse.on('close', () => clients.delete(sse))
})

setInterval(() => {
  const metrics = { cpu: process.cpuUsage(), mem: process.memoryUsage().heapUsed }
  for (const sse of clients) sse.event('metrics', metrics)
}, 1000)

app.listen(3000)
\`\`\`

### File Upload API

\`\`\`js
const { createApp, json, multipart } = require('zero-http')
const app = createApp()
app.use(json())

app.post('/upload', multipart({ dir: './uploads', maxFileSize: 10 * 1024 * 1024 }), (req, res) => {
  const { files, fields } = req.body
  res.json({
    uploaded: Object.keys(files).length,
    details: Object.values(files).map(f => ({
      name: f.originalFilename,
      size: f.size,
      type: f.contentType
    }))
  })
})

app.listen(3000)
\`\`\`

### Middleware Composition

\`\`\`js
// Order matters
app.use(logger())      // 1. Log
app.use(helmet())      // 2. Security headers
app.use(cors())        // 3. CORS
app.use(compress())    // 4. Compress
app.use(rateLimit())   // 5. Rate limit
app.use(json())        // 6. Parse body

// Path-scoped
app.use('/api', rateLimit({ max: 50 }))
app.use('/admin', (req, res, next) => {
  if (!req.get('authorization')) return res.sendStatus(401)
  next()
})

// Error handler goes last
app.onError((err, req, res) => {
  res.status(err.statusCode || 500).json({ error: err.message })
})
\`\`\``;

// -- Helpers -------------------------------------------------

function slugify(text)
{
    return text.toLowerCase()
        .replace(/[^a-z0-9\s\-]/g, '')
        .replace(/\s+/g, '-')
        .trim();
}

function sectionHeading(section)
{
    return `## ${section.section}`;
}

function itemHeading(item, isSubSection)
{
    return isSubSection ? `### ${item.name}` : `## ${item.name}`;
}

function renderMethods(methods)
{
    if (!methods || methods.length === 0) return '';
    const lines = [
        '',
        '| Method | Signature | Description |',
        '|---|---|---|',
    ];
    for (const m of methods)
    {
        const method = (m.method || '').replace(/\|/g, '\\|');
        const sig = (m.signature || '').replace(/\|/g, '\\|');
        const desc = (m.description || '').replace(/\|/g, '\\|');
        lines.push(`| \`${method}\` | \`${sig}\` | ${desc} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function renderMethodGroups(groups)
{
    if (!groups || groups.length === 0) return '';
    const parts = [];
    for (const g of groups)
    {
        parts.push(`\n#### ${g.group || g.category}\n`);
        parts.push('| Method | Signature | Description |');
        parts.push('|---|---|---|');
        for (const m of g.methods)
        {
            const method = (m.method || '').replace(/\|/g, '\\|');
            const sig = (m.signature || '').replace(/\|/g, '\\|');
            const desc = (m.description || '').replace(/\|/g, '\\|');
            parts.push(`| \`${method}\` | \`${sig}\` | ${desc} |`);
        }
        parts.push('');
    }
    return parts.join('\n');
}

function renderParams(params)
{
    if (!params || params.length === 0) return '';
    const lines = [
        '',
        '| Parameter | Type | Required | Description |',
        '|---|---|---|---|',
    ];
    for (const p of params)
    {
        const param = (p.param || '').replace(/\|/g, '\\|');
        const type = (p.type || '').replace(/\|/g, '\\|');
        const required = (p.required || '—').replace(/\|/g, '\\|');
        const notes = (p.notes || '').replace(/\|/g, '\\|');
        lines.push(`| \`${param}\` | ${type} | ${required} | ${notes} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function renderOptions(options)
{
    if (!options || options.length === 0) return '';
    const lines = [
        '',
        '| Option | Type | Default | Description |',
        '|---|---|---|---|',
    ];
    for (const o of options)
    {
        const opt = (o.option || '').replace(/\|/g, '\\|');
        const type = (o.type || '').replace(/\|/g, '\\|');
        const def = (o.default || '—').replace(/\|/g, '\\|');
        const notes = (o.notes || '').replace(/\|/g, '\\|');
        lines.push(`| \`${opt}\` | ${type} | \`${def}\` | ${notes} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function renderOptionGroups(groups)
{
    if (!groups || groups.length === 0) return '';
    const parts = [];
    for (const g of groups)
    {
        parts.push(`\n#### ${g.group || g.category}\n`);
        parts.push('| Option | Type | Default | Description |');
        parts.push('|---|---|---|---|');
        for (const o of g.options)
        {
            const opt = (o.option || '').replace(/\|/g, '\\|');
            const type = (o.type || '').replace(/\|/g, '\\|');
            const def = (o.default || '—').replace(/\|/g, '\\|');
            const notes = (o.notes || '').replace(/\|/g, '\\|');
            parts.push(`| \`${opt}\` | ${type} | \`${def}\` | ${notes} |`);
        }
        parts.push('');
    }
    return parts.join('\n');
}

function renderExample(example, lang)
{
    if (!example) return '';
    const language = lang || 'js';
    return `\n\`\`\`${language}\n${example}\n\`\`\`\n`;
}

function renderTips(tips)
{
    if (!tips || tips.length === 0) return '';
    const lines = [''];
    for (const t of tips)
    {
        lines.push(`> **Tip:** ${t}`);
    }
    lines.push('');
    return lines.join('\n');
}

// -- Build ---------------------------------------------------

function buildToc(sections)
{
    const lines = ['## Table of Contents', ''];

    // Always start with exports
    lines.push('- [Exports](#exports)');

    for (const section of sections)
    {
        // Some sections are rendered as item-level H2s (Getting Started items are standalone)
        if (section.section === 'Getting Started')
        {
            for (const item of section.items)
                lines.push(`- [${item.name}](#${slugify(item.name)})`);
            continue;
        }

        const slug = slugify(section.section);
        if (section.items.length > 1)
        {
            lines.push(`- [${section.section}](#${slug})`);
            for (const item of section.items)
                lines.push(`  - [${item.name}](#${slugify(item.name)})`);
        }
        else if (section.items.length === 1)
        {
            lines.push(`- [${section.name || section.section}](#${slug})`);
        }
    }

    lines.push('- [Examples](#examples)');
    lines.push('');
    return lines.join('\n');
}

function renderItem(item, isSubSection)
{
    const parts = [];
    parts.push(itemHeading(item, isSubSection));
    parts.push('');
    parts.push(item.description);

    if (item.params && item.params.length)
    {
        parts.push('\n#### Parameters');
        parts.push(renderParams(item.params));
    }

    if (item.methods && item.methods.length)
    {
        parts.push('\n#### Methods');
        parts.push(renderMethods(item.methods));
    }

    if (item.methodGroups)
    {
        parts.push(renderMethodGroups(item.methodGroups));
    }

    if (item.options && item.options.length)
    {
        parts.push('\n#### Options');
        parts.push(renderOptions(item.options));
    }

    if (item.optionGroups && item.optionGroups.length)
    {
        parts.push(renderOptionGroups(item.optionGroups));
    }

    if (item.example)
    {
        parts.push(renderExample(item.example, item.exampleLang));
    }

    if (item.tips && item.tips.length)
    {
        parts.push(renderTips(item.tips));
    }

    return parts.join('\n');
}

function renderSection(section)
{
    const parts = [];

    // "Getting Started" items are rendered as top-level sections
    if (section.section === 'Getting Started')
    {
        for (const item of section.items)
        {
            parts.push(renderItem(item, false));
            parts.push('\n---\n');
        }
        return parts.join('\n');
    }

    // Sections with a single item: skip section heading, render item as H2
    if (section.items.length === 1)
    {
        parts.push(renderItem(section.items[0], false));
        parts.push('\n---\n');
        return parts.join('\n');
    }

    // Sections with multiple items: H2 section heading, H3 items
    parts.push(sectionHeading(section));
    parts.push('');

    for (const item of section.items)
    {
        parts.push(renderItem(item, true));
        parts.push('');
    }

    parts.push('\n---\n');
    return parts.join('\n');
}

function build()
{
    /* Load sections in manifest order — read-only, no writes to JSON */
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const data = manifest.map(filename =>
        JSON.parse(fs.readFileSync(path.join(SECTIONS_DIR, filename), 'utf8'))
    );

    const parts = [
        HEADER,
        '',
        buildToc(data),
        '---\n',
        EXPORTS_SECTION,
        '\n---\n',
    ];

    for (const section of data)
    {
        parts.push(renderSection(section));
    }

    parts.push(EXAMPLES_SECTION);
    parts.push('\n\n---\n\n## License\n\nMIT\n');

    const md = parts.join('\n');
    fs.writeFileSync(OUTPUT, md, 'utf8');

    const lines = md.split('\n').length;
    console.log(`✓ API.md generated (${lines} lines) from ${manifest.length} section files`);
}

build();
