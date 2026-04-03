/**
 * docs/sections.js
 * Renders hierarchical documentation sections with sidebar TOC population.
 */

import { escapeHtml, formatNotes, slugify, highlightAllPre } from '../core/helpers.js';
import { histPushAccordion, histPushModal, histCloseModal, histPushHash, histCloseSidebar } from '../core/history.js';
import { initTocCollapsible, expandTocForId, scrollToId, refreshScrollSpy } from '../ui/shell.js';

/* -- Method meta store ------------------------------------- */

const _methodMeta = {};
let _mmCounter = 0;

/* -- Section icon map -------------------------------------- */

const SECTION_ICONS = {
    rocket: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    box: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    parse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/><path d="M15 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/></svg>',
    layers: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    database: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    zap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    activity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    'refresh-cw': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    'alert-triangle': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};

/* -- Anchor link helper ------------------------------------ */

const ANCHOR_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M6.5 11.5h-2a3 3 0 0 1 0-6h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 4.5h2a3 3 0 0 1 0 6h-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function createAnchorLink(id)
{
    const a = document.createElement('a');
    a.className = 'anchor-link';
    a.href = '#' + id;
    a.title = 'Copy link';
    a.innerHTML = ANCHOR_SVG;
    a.addEventListener('click', (e) =>
    {
        e.preventDefault();
        e.stopPropagation();
        const url = location.origin + location.pathname + '#' + id;
        navigator.clipboard.writeText(url).then(() => showCopyToast('Link copied!')).catch(() => {});
    });
    return a;
}

function showCopyToast(text)
{
    const toast = document.getElementById('copy-toast');
    const toastText = document.getElementById('copy-toast-text');
    if (!toast || !toastText) return;
    toastText.textContent = text;
    toast.classList.add('visible');
    clearTimeout(window._copyToastTimer);
    window._copyToastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

/* -- Method detail modal ----------------------------------- */

const BTN_ICONS = {
    opts:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    params:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/><path d="M16 21h2a2 2 0 0 0 2-2v-4a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-2"/></svg>',
    returns: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>'
};

const PILL_LABELS = { opts: 'Options', params: 'Parameters', returns: 'Returns' };

function ensureMethodOptsModal()
{
    if (document.getElementById('meth-opts-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'meth-opts-overlay';
    overlay.className = 'badge-modal-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
        '<div class="badge-modal" style="max-width:720px">' +
            '<div class="badge-modal-header" id="meth-opts-header">' +
                '<div class="mm-title-wrap">' +
                    '<span class="mm-kind-pill" id="meth-opts-pill"></span>' +
                    '<code class="meth-opts-title-code" id="meth-opts-title"></code>' +
                '</div>' +
                '<button class="badge-modal-close" id="meth-opts-close" aria-label="Close">×</button>' +
            '</div>' +
            '<div class="badge-modal-body" id="meth-opts-body"></div>' +
        '</div>';
    document.body.appendChild(overlay);

    const close = () => histCloseModal('meth-opts-overlay');
    document.getElementById('meth-opts-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e =>
    {
        if (e.key === 'Escape' && overlay.getAttribute('aria-hidden') === 'false') close();
    });
}

function _mmRows(kind, data)
{
    const list = document.createElement('div');
    list.className = 'mm-list';
    list.dataset.kind = kind;
    for (const item of data)
    {
        const row = document.createElement('div');
        row.className = 'mm-row';
        if (kind === 'returns')
        {
            row.innerHTML =
                `<div class="mm-row-head">` +
                    `<code class="mm-return-type">${escapeHtml(item.type || 'void')}</code>` +
                `</div>` +
                (item.description ? `<p class="mm-row-desc">${escapeHtml(item.description)}</p>` : '');
        }
        else if (kind === 'params')
        {
            const isReq = item.required === true || item.required === 'true' || item.required === 'yes' || item.required === 'Yes';
            const metaHtml = isReq
                ? `<span class="mm-row-required">required</span>`
                : `<span class="mm-row-optional">optional</span>`;
            row.innerHTML =
                `<div class="mm-row-head">` +
                    `<code class="mm-row-key">${escapeHtml(item.param || item.option || '')}</code>` +
                    (item.type ? `<span class="type-badge">${escapeHtml(item.type)}</span>` : '') +
                    metaHtml +
                `</div>` +
                (item.notes ? `<p class="mm-row-desc">${formatNotes(item.notes)}</p>` : '');

            /* -- collapsible sub-options ---------------------- */
            if (Array.isArray(item._subOptions) && item._subOptions.length)
            {
                const details = document.createElement('details');
                details.className = 'mm-sub-opts';
                const summary = document.createElement('summary');
                summary.className = 'mm-sub-opts-toggle';
                summary.innerHTML = `${BTN_ICONS.opts}<span>${escapeHtml(item.param || item.option || '')} properties</span>`;
                details.appendChild(summary);

                const subList = document.createElement('div');
                subList.className = 'mm-sub-opts-list';
                for (const opt of item._subOptions)
                {
                    const sub = document.createElement('div');
                    sub.className = 'mm-sub-opts-row';
                    const defHtml = opt.default != null
                        ? `<span class="mm-row-default">default:&nbsp;<span class="default-val">${escapeHtml(String(opt.default))}</span></span>`
                        : '';
                    sub.innerHTML =
                        `<div class="mm-row-head">` +
                            `<code class="mm-row-key">${escapeHtml(opt.option || opt.param || '')}</code>` +
                            (opt.type ? `<span class="type-badge">${escapeHtml(opt.type)}</span>` : '') +
                            defHtml +
                        `</div>` +
                        (opt.notes ? `<p class="mm-row-desc">${formatNotes(opt.notes)}</p>` : '');
                    subList.appendChild(sub);
                }
                details.appendChild(subList);
                row.appendChild(details);
            }
        }
        else
        {
            const defHtml = item.default != null
                ? `<span class="mm-row-default">default:&nbsp;<span class="default-val">${escapeHtml(String(item.default))}</span></span>`
                : '';
            row.innerHTML =
                `<div class="mm-row-head">` +
                    `<code class="mm-row-key">${escapeHtml(item.option || item.param || '')}</code>` +
                    (item.type ? `<span class="type-badge">${escapeHtml(item.type)}</span>` : '') +
                    defHtml +
                `</div>` +
                (item.notes ? `<p class="mm-row-desc">${formatNotes(item.notes)}</p>` : '');
        }
        list.appendChild(row);
    }
    return list;
}

function showMethodOptsModal(sig, type, data)
{
    ensureMethodOptsModal();
    document.getElementById('meth-opts-title').textContent = sig;

    const kind = type || 'opts';
    const hdr  = document.getElementById('meth-opts-header');
    hdr.setAttribute('data-kind', kind);

    const pill = document.getElementById('meth-opts-pill');
    pill.className = 'mm-kind-pill mm-kind-pill-' + kind;
    pill.textContent = PILL_LABELS[kind] || kind;

    const body = document.getElementById('meth-opts-body');
    body.innerHTML = '';

    if (kind === 'returns')
    {
        const arr = Array.isArray(data) ? data : [data];
        if (arr.length === 1)
        {
            const ret = arr[0];
            const card = document.createElement('div');
            card.className = 'mm-return-card';
            card.innerHTML =
                `<div class="mm-return-hero">` +
                    `<span class="mm-return-label">Returns</span>` +
                    `<code class="mm-return-type">${escapeHtml(ret.type || 'void')}</code>` +
                `</div>` +
                (ret.description
                    ? `<p class="mm-return-desc">${escapeHtml(ret.description)}</p>`
                    : '');
            body.appendChild(card);
        }
        else
        {
            body.appendChild(_mmRows('returns', arr));
        }
    }
    else if (kind === 'params')
    {
        body.appendChild(_mmRows('params', data));
    }
    else
    {
        body.appendChild(_mmRows('opts', data));
    }

    document.getElementById('meth-opts-overlay').setAttribute('aria-hidden', 'false');
    histPushModal('meth-opts-overlay');
}

// Global click handler for method detail buttons
document.addEventListener('click', e =>
{
    const btn = e.target.closest('.meth-btn[data-mm]');
    if (!btn) return;
    const entry = _methodMeta[btn.dataset.mm];
    if (entry) showMethodOptsModal(entry.sig, entry.type, entry.data);
});

function buildMethodRow(m, parentSlug)
{
    const card = document.createElement('div');
    card.className = 'mm-method-card';
    if (parentSlug && m.method)
    {
        card.id = parentSlug + '--' + slugify(m.method);
    }

    const buttons = [];

    /* -- Merge methodOptions into the matching param -------- */
    const hasOpts   = Array.isArray(m.methodOptions) && m.methodOptions.length;
    const hasParams = Array.isArray(m.methodParams) && m.methodParams.length;
    let mergedParams = hasParams ? m.methodParams.map(p => Object.assign({}, p)) : null;
    let optsStandalone = false; // true → show legacy opts button

    if (hasOpts && mergedParams)
    {
        // Parse sig param names to figure out which options are sub-fields
        const sig = m.signature || '';
        const sigMatch = sig.match(/\(([^)]*)\)/);
        const sigNames = sigMatch
            ? sigMatch[1].split(',').map(s => s.trim().replace(/^\[/, '').replace(/\]$/, '')).filter(Boolean)
            : [];
        const sigSet = new Set(sigNames);

        // Sub-field options are ones whose name is NOT a sig param
        const subOpts = m.methodOptions.filter(o => !sigSet.has(o.option));

        if (subOpts.length)
        {
            // Find the param these belong to (opts-like name or object type)
            const target = mergedParams.find(p =>
                /^(opts|options?|config|settings)$/i.test(p.param) ||
                /opts|options/i.test(p.param)
            ) || mergedParams.filter(p => p.type && /object/i.test(p.type)).pop();

            if (target) target._subOptions = subOpts;
            else optsStandalone = true; // no suitable param found
        }
        // else: all options are positional → already covered by params, skip opts
    }
    else if (hasOpts && !hasParams)
    {
        optsStandalone = true;
    }

    if (optsStandalone)
    {
        const id = 'mm_' + (++_mmCounter);
        _methodMeta[id] = { sig: m.signature || m.method || '', type: 'opts', data: m.methodOptions };
        buttons.push(`<button class="meth-btn meth-btn-opts" data-mm="${id}">${BTN_ICONS.opts}opts</button>`);
    }

    if (mergedParams)
    {
        const id = 'mm_' + (++_mmCounter);
        _methodMeta[id] = { sig: m.signature || m.method || '', type: 'params', data: mergedParams };
        buttons.push(`<button class="meth-btn meth-btn-params" data-mm="${id}">${BTN_ICONS.params}params</button>`);
    }

    if (m.methodReturns)
    {
        const id = 'mm_' + (++_mmCounter);
        const ret = Array.isArray(m.methodReturns) ? m.methodReturns : [m.methodReturns];
        _methodMeta[id] = { sig: m.signature || m.method || '', type: 'returns', data: ret };
        const retType = ret[0] && ret[0].type ? escapeHtml(ret[0].type) : 'returns';
        buttons.push(`<button class="meth-btn meth-btn-returns" data-mm="${id}">${BTN_ICONS.returns}${retType}</button>`);
    }

    const btnsHtml = buttons.length
        ? `<div class="meth-btns">${buttons.join('')}</div>`
        : '';

    card.innerHTML =
        `<div class="mm-method-top">` +
            `<span class="mm-method-name">${escapeHtml(m.method || '')}</span>` +
            `<code class="mm-method-sig">${escapeHtml(m.signature || '')}</code>` +
        `</div>` +
        (m.description ? `<p class="mm-method-desc">${escapeHtml(m.description)}</p>` : '') +
        btnsHtml;
    return card;
}

function formatTipText(text)
{
    let html = escapeHtml(text);
    html = html.replace(/'([^']+)'/g, '<code class="tip-val">\'$1\'</code>');
    html = html.replace(/\b([a-zA-Z][\w.]*)\(([^)]*)\)/g, '<code class="tip-ref">$1($2)</code>');
    html = html.replace(/\b(req|res|app)\.([\w.]+)\b(?![(<])/g, '<code class="tip-ref">$1.$2</code>');
    html = html.replace(/\b(true|false|null)\b/g, '<code class="tip-val">$1</code>');
    return html;
}

/* -- Rendering helpers ------------------------------------- */

function sectionSlug(sectionName)
{
    return 'section-' + slugify(sectionName);
}

function itemSlug(sectionName, itemName)
{
    return slugify(sectionName) + '-' + slugify(itemName);
}

function renderDocItem(item, section)
{
    const slug = itemSlug(section, item.name);
    const d = document.createElement('div');
    d.className = 'doc-item';
    d.id = slug;

    const header = document.createElement('div');
    header.className = 'doc-item-header';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'doc-item-title-row';
    titleWrap.innerHTML = `<span class="doc-item-indicator"></span><h5 class="doc-item-title">${escapeHtml(item.name)}</h5>`;
    titleWrap.appendChild(createAnchorLink(slug));

    /* expand/collapse chevron */
    const chevron = document.createElement('svg');
    chevron.className = 'doc-item-chevron';
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    titleWrap.appendChild(chevron);

    header.appendChild(titleWrap);
    if (item.description)
    {
        const desc = document.createElement('p');
        desc.className = 'doc-item-desc';
        desc.textContent = item.description;
        header.appendChild(desc);
    }
    d.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-item-body';

    /* -- CLI Tool layout ----------------------------------- */
    if (item.cliTool)
    {
        /* -- Config file (setup first) ----------------------- */
        if (Array.isArray(item.configExamples) && item.configExamples.length)
        {
            const h6 = document.createElement('h6');
            h6.textContent = 'Config File';
            body.appendChild(h6);

            const intro = document.createElement('p');
            intro.className = 'cli-cfg-intro';
            intro.innerHTML =
                'The CLI reads a <code>zero.config.js</code> file from your project root to know which database to connect to and where your project files live. ' +
                'Create this file once and every <code>zh</code> command will use it automatically — no flags needed.';
            body.appendChild(intro);

            const dirExplain = document.createElement('div');
            dirExplain.className = 'cli-cfg-dirs';
            dirExplain.innerHTML =
                '<div class="cli-cfg-dir-item">' +
                    '<code>migrationsDir</code>' +
                    '<p>The folder where your migration files live. Migrations are versioned scripts that create or modify database tables ' +
                    'so every developer (and every deploy) gets the exact same schema.  ' +
                    'Run <code>npx zh make:migration &lt;name&gt;</code> to generate one, then <code>npx zh migrate</code> to apply it.</p>' +
                '</div>' +
                '<div class="cli-cfg-dir-item">' +
                    '<code>seedersDir</code>' +
                    '<p>The folder where your seeder files live. Seeders insert sample or default data into your tables — ' +
                    'useful for populating a fresh database during development or setting up initial records in production.  ' +
                    'Run <code>npx zh make:seeder &lt;name&gt;</code> to generate one, then <code>npx zh seed</code> to run them all.</p>' +
                '</div>' +
                '<div class="cli-cfg-dir-item">' +
                    '<code>modelsDir</code>' +
                    '<p>The folder where your Model class files live. When you run <code>npx zh make:migration</code>, the CLI loads every model from this directory, ' +
                    'compares their schemas against the last snapshot, and auto-generates migration code for any changes it detects. ' +
                    'This is what powers the auto-diff migration system.</p>' +
                '</div>';
            body.appendChild(dirExplain);

            const tabs = document.createElement('div');
            tabs.className = 'cli-cfg-tabs';

            const panels = document.createElement('div');
            panels.className = 'cli-cfg-panels';

            item.configExamples.forEach((ex, i) =>
            {
                const btn = document.createElement('button');
                btn.className = 'cli-cfg-tab' + (i === 0 ? ' active' : '');
                btn.textContent = ex.adapter;
                btn.setAttribute('data-idx', i);
                tabs.appendChild(btn);

                const panel = document.createElement('div');
                panel.className = 'cli-cfg-panel' + (i === 0 ? ' active' : '');
                panel.setAttribute('data-idx', i);
                const pre = document.createElement('pre');
                pre.className = 'language-javascript code';
                const code = document.createElement('code');
                code.className = 'language-javascript';
                code.textContent = ex.code;
                pre.appendChild(code);
                panel.appendChild(pre);
                panels.appendChild(panel);
            });

            tabs.addEventListener('click', (e) =>
            {
                const btn = e.target.closest('.cli-cfg-tab');
                if (!btn) return;
                const idx = btn.getAttribute('data-idx');
                tabs.querySelectorAll('.cli-cfg-tab').forEach(t => t.classList.remove('active'));
                panels.querySelectorAll('.cli-cfg-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                panels.querySelector(`.cli-cfg-panel[data-idx="${idx}"]`).classList.add('active');
            });

            body.appendChild(tabs);
            body.appendChild(panels);
        }

        if (Array.isArray(item.cliOptions) && item.cliOptions.length)
        {
            const glabel = document.createElement('div');
            glabel.className = 'mm-group-label';
            glabel.textContent = 'Global Options';
            body.appendChild(glabel);

            const olist = document.createElement('div');
            olist.className = 'mm-prop-list';
            for (const opt of item.cliOptions)
            {
                const row = document.createElement('div');
                row.className = 'mm-prop-row';
                row.innerHTML =
                    `<div class="mm-prop-head">` +
                        `<code class="mm-prop-key">${escapeHtml(opt.flag)}</code>` +
                    `</div>` +
                    `<p class="mm-prop-notes">${escapeHtml(opt.desc)}</p>`;
                olist.appendChild(row);
            }
            body.appendChild(olist);
        }

        /* -- Workflow walkthroughs ----------------------------- */
        if (Array.isArray(item.workflows) && item.workflows.length)
        {
            const wfLabel = document.createElement('div');
            wfLabel.className = 'mm-group-label';
            wfLabel.textContent = 'Workflows';
            body.appendChild(wfLabel);

            /* top-level tabs for switching between workflows */
            const wfTabBar = document.createElement('div');
            wfTabBar.className = 'cli-wf-topbar';

            const wfPanelWrap = document.createElement('div');
            wfPanelWrap.className = 'cli-wf-toppanels';

            item.workflows.forEach((wf, wi) =>
            {
                const btn = document.createElement('button');
                btn.className = 'cli-wf-toptab' + (wi === 0 ? ' active' : '');
                btn.textContent = wf.tab;
                btn.setAttribute('data-wf', wi);
                wfTabBar.appendChild(btn);

                const panel = document.createElement('div');
                panel.className = 'cli-wf-toppanel' + (wi === 0 ? ' active' : '');
                panel.setAttribute('data-wf', wi);

                if (wf.description)
                {
                    const desc = document.createElement('p');
                    desc.className = 'cli-group-desc';
                    desc.textContent = wf.description;
                    panel.appendChild(desc);
                }

                const steps = document.createElement('div');
                steps.className = 'cli-wf-steps';

                for (const step of wf.steps)
                {
                    const card = document.createElement('div');
                    card.className = 'cli-wf-step';

                    const label = document.createElement('div');
                    label.className = 'cli-wf-label';
                    label.textContent = step.label;
                    card.appendChild(label);

                    if (step.note)
                    {
                        const note = document.createElement('p');
                        note.className = 'cli-wf-note';
                        note.innerHTML = step.note;
                        card.appendChild(note);
                    }

                    if (Array.isArray(step.tabs) && step.tabs.length)
                    {
                        const tabBar = document.createElement('div');
                        tabBar.className = 'cli-wf-tabs';

                        const tabPanels = document.createElement('div');
                        tabPanels.className = 'cli-wf-panels';

                        step.tabs.forEach((t, ti) =>
                        {
                            const tabBtn = document.createElement('button');
                            tabBtn.className = 'cli-wf-tab' + (ti === 0 ? ' active' : '');
                            tabBtn.textContent = t.tab;
                            tabBtn.setAttribute('data-idx', ti);
                            tabBar.appendChild(tabBtn);

                            const tp = document.createElement('div');
                            tp.className = 'cli-wf-panel' + (ti === 0 ? ' active' : '');
                            tp.setAttribute('data-idx', ti);
                            const pre = document.createElement('pre');
                            const isShell = t.code.trimStart().startsWith('$');
                            pre.className = (isShell ? 'language-shell' : 'language-javascript') + ' code';
                            const code = document.createElement('code');
                            code.className = isShell ? 'language-shell' : 'language-javascript';
                            code.textContent = t.code;
                            pre.appendChild(code);
                            tp.appendChild(pre);
                            tabPanels.appendChild(tp);
                        });

                        tabBar.addEventListener('click', (e) =>
                        {
                            const b = e.target.closest('.cli-wf-tab');
                            if (!b) return;
                            const idx = b.getAttribute('data-idx');
                            tabBar.querySelectorAll('.cli-wf-tab').forEach(x => x.classList.remove('active'));
                            tabPanels.querySelectorAll('.cli-wf-panel').forEach(x => x.classList.remove('active'));
                            b.classList.add('active');
                            tabPanels.querySelector(`.cli-wf-panel[data-idx="${idx}"]`).classList.add('active');
                        });

                        card.appendChild(tabBar);
                        card.appendChild(tabPanels);
                    }
                    else
                    {
                        const pre = document.createElement('pre');
                        const isShell = step.code.trimStart().startsWith('$');
                        pre.className = (isShell ? 'language-shell' : 'language-javascript') + ' code';
                        const code = document.createElement('code');
                        code.className = isShell ? 'language-shell' : 'language-javascript';
                        code.textContent = step.code;
                        pre.appendChild(code);
                        card.appendChild(pre);
                    }

                    steps.appendChild(card);
                }

                panel.appendChild(steps);
                wfPanelWrap.appendChild(panel);
            });

            wfTabBar.addEventListener('click', (e) =>
            {
                const btn = e.target.closest('.cli-wf-toptab');
                if (!btn) return;
                const idx = btn.getAttribute('data-wf');
                wfTabBar.querySelectorAll('.cli-wf-toptab').forEach(b => b.classList.remove('active'));
                wfPanelWrap.querySelectorAll('.cli-wf-toppanel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                wfPanelWrap.querySelector(`.cli-wf-toppanel[data-wf="${idx}"]`).classList.add('active');
            });

            body.appendChild(wfTabBar);
            body.appendChild(wfPanelWrap);
        }

        /* -- Command groups -------------------------------- */
        if (Array.isArray(item.commandGroups) && item.commandGroups.length)
        {
            for (const group of item.commandGroups)
            {
                const glabel = document.createElement('div');
                glabel.className = 'mm-group-label';
                glabel.textContent = group.label;
                body.appendChild(glabel);

                if (group.description)
                {
                    const gdesc = document.createElement('p');
                    gdesc.className = 'cli-group-desc';
                    gdesc.innerHTML = group.description;
                    body.appendChild(gdesc);
                }

                const list = document.createElement('div');
                list.className = 'cli-cmd-list';
                for (const c of group.commands)
                {
                    const row = document.createElement('div');
                    row.className = 'cli-cmd-row';
                    const pre = document.createElement('pre');
                    pre.className = 'cli-cmd-code language-shell code';
                    const code = document.createElement('code');
                    code.className = 'language-shell';
                    code.textContent = c.cmd;
                    pre.appendChild(code);
                    row.appendChild(pre);

                    const desc = document.createElement('p');
                    desc.className = 'cli-cmd-desc';
                    desc.innerHTML = c.desc;
                    row.appendChild(desc);

                    if (c.args)
                    {
                        const argsSpan = document.createElement('span');
                        argsSpan.className = 'cli-cmd-args';
                        argsSpan.innerHTML = `<span class="cli-cmd-args-label">args</span> <code>${escapeHtml(c.args)}</code>`;
                        row.appendChild(argsSpan);
                    }
                    list.appendChild(row);
                }
                body.appendChild(list);
            }
        }

        d.appendChild(body);
        return d;
    }

    if (Array.isArray(item.params) && item.params.length)
    {
        const glabel = document.createElement('div');
        glabel.className = 'mm-group-label';
        glabel.textContent = 'Parameters';
        body.appendChild(glabel);

        const plist = document.createElement('div');
        plist.className = 'mm-prop-list';
        for (const p of item.params)
        {
            const row = document.createElement('div');
            row.className = 'mm-prop-row';
            const isReq = p.required === true || p.required === 'true' || p.required === 'yes' || p.required === 'Yes' || p.required === 'required';
            const reqHtml = isReq
                ? `<span class="mm-row-required">required</span>`
                : `<span class="mm-row-optional">optional</span>`;
            row.innerHTML =
                `<div class="mm-prop-head">` +
                    `<code class="mm-prop-key">${escapeHtml(p.param)}</code>` +
                    (p.type ? `<span class="type-badge">${escapeHtml(p.type)}</span>` : '') +
                    reqHtml +
                `</div>` +
                (p.notes ? `<p class="mm-prop-notes">${formatNotes(p.notes)}</p>` : '');
            plist.appendChild(row);
        }
        body.appendChild(plist);
    }

    if (Array.isArray(item.options) && item.options.length)
    {
        const glabel = document.createElement('div');
        glabel.className = 'mm-group-label';
        glabel.textContent = 'Options';
        body.appendChild(glabel);

        const olist = document.createElement('div');
        olist.className = 'mm-prop-list';
        for (const opt of item.options)
        {
            const row = document.createElement('div');
            row.className = 'mm-prop-row';
            const defHtml = opt.default != null
                ? `<span class="mm-row-default">default:&nbsp;<span class="default-val">${escapeHtml(String(opt.default))}</span></span>`
                : '';
            row.innerHTML =
                `<div class="mm-prop-head">` +
                    `<code class="mm-prop-key">${escapeHtml(opt.option)}</code>` +
                    (opt.type ? `<span class="type-badge">${escapeHtml(opt.type)}</span>` : '') +
                    defHtml +
                `</div>` +
                (opt.notes ? `<p class="mm-prop-notes">${formatNotes(opt.notes)}</p>` : '');
            olist.appendChild(row);
        }
        body.appendChild(olist);
    }

    if (Array.isArray(item.optionGroups) && item.optionGroups.length)
    {
        for (const group of item.optionGroups)
        {
            const glabel = document.createElement('div');
            glabel.className = 'mm-group-label';
            glabel.textContent = group.category || 'Options';
            body.appendChild(glabel);

            const olist = document.createElement('div');
            olist.className = 'mm-prop-list';
            for (const opt of group.options)
            {
                const row = document.createElement('div');
                row.className = 'mm-prop-row';
                const defHtml = opt.default != null
                    ? `<span class="mm-row-default">default:&nbsp;<span class="default-val">${escapeHtml(String(opt.default))}</span></span>`
                    : '';
                row.innerHTML =
                    `<div class="mm-prop-head">` +
                        `<code class="mm-prop-key">${escapeHtml(opt.option)}</code>` +
                        (opt.type ? `<span class="type-badge">${escapeHtml(opt.type)}</span>` : '') +
                        defHtml +
                    `</div>` +
                    (opt.notes ? `<p class="mm-prop-notes">${formatNotes(opt.notes)}</p>` : '');
                olist.appendChild(row);
            }
            body.appendChild(olist);
        }
    }

    if (Array.isArray(item.methods) && item.methods.length)
    {
        const mlist = document.createElement('div');
        mlist.className = 'mm-method-list';
        for (const m of item.methods)
        {
            mlist.appendChild(buildMethodRow(m, slug));
        }
        body.appendChild(mlist);
    }

    if (Array.isArray(item.methodGroups) && item.methodGroups.length)
    {
        for (const group of item.methodGroups)
        {
            const groupName = group.group || group.category || 'Methods';
            const glabel = document.createElement('div');
            glabel.className = 'mm-group-label';
            glabel.id = slug + '--' + slugify(groupName);
            glabel.textContent = groupName;
            body.appendChild(glabel);

            const mlist = document.createElement('div');
            mlist.className = 'mm-method-list';
            for (const m of group.methods)
            {
                mlist.appendChild(buildMethodRow(m, slug));
            }
            body.appendChild(mlist);
        }
    }

    if (item.example)
    {
        const h6 = document.createElement('h6');
        h6.textContent = 'Example';
        body.appendChild(h6);

        const lang = item.exampleLang || 'javascript';
        const pre = document.createElement('pre');
        pre.className = 'language-' + lang + ' code';
        const code = document.createElement('code');
        code.className = 'language-' + lang;
        code.textContent = item.example;
        pre.appendChild(code);
        body.appendChild(pre);
    }

    if (Array.isArray(item.tips) && item.tips.length)
    {
        const tipsDiv = document.createElement('div');
        tipsDiv.className = 'doc-tips';
        const h6 = document.createElement('h6');
        h6.className = 'doc-tips-heading';
        h6.textContent = 'Tips';
        tipsDiv.appendChild(h6);

        const ul = document.createElement('ul');
        ul.className = 'tips-list';
        for (const tip of item.tips)
        {
            const li = document.createElement('li');
            li.innerHTML = formatTipText(tip);
            ul.appendChild(li);
        }
        tipsDiv.appendChild(ul);
        body.appendChild(tipsDiv);
    }

    if (body.childNodes.length) d.appendChild(body);
    return d;
}

function renderSection(section)
{
    const slug = sectionSlug(section.section);
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-section';
    wrapper.id = slug;

    const header = document.createElement('div');
    header.className = 'doc-section-header';

    const iconHtml = SECTION_ICONS[section.icon] || '';
    header.innerHTML = `<span class="doc-section-icon">${iconHtml}</span><h4 class="doc-section-title">${escapeHtml(section.section)}</h4>`;
    header.appendChild(createAnchorLink(slug));
    wrapper.appendChild(header);

    const divider = document.createElement('div');
    divider.className = 'doc-section-divider';
    wrapper.appendChild(divider);

    if (Array.isArray(section.items))
    {
        const grid = document.createElement('div');
        grid.className = 'doc-items-grid';
        for (const item of section.items)
        {
            grid.appendChild(renderDocItem(item, section.section));
        }
        wrapper.appendChild(grid);
    }

    return wrapper;
}

/* -- TOC population ---------------------------------------- */

const CHEVRON_SVG = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Category groups for sidebar organisation */
const TOC_GROUPS = [
    { label: 'Framework', sections: ['Getting Started', 'Core', 'Body Parsers', 'Middleware'] },
    { label: 'Security & Auth', sections: ['Cookies & Security', 'Authentication & Sessions'] },
    { label: 'Data & I/O', sections: ['Environment', 'Real-Time', 'Networking', 'ORM'] },
    { label: 'Platform', sections: ['Observability', 'Lifecycle & Clustering', 'Error Handling'] }
];

function populateToc(sections)
{
    const nav = document.querySelector('.toc-sidebar nav ul');
    if (!nav) return;

    const playgroundLi = nav.querySelector(':scope > li[data-static="playground"]');

    Array.from(nav.children).forEach(li =>
    {
        if (!li.hasAttribute('data-static') && !li.classList.contains('toc-group-label')) li.remove();
    });

    nav.querySelectorAll('.toc-group-label').forEach(el => el.remove());

    const sectionMap = new Map();
    for (const section of sections) sectionMap.set(section.section, section);

    for (const group of TOC_GROUPS)
    {
        const lbl = document.createElement('li');
        lbl.className = 'toc-group-label';
        lbl.setAttribute('aria-hidden', 'true');
        lbl.textContent = group.label;
        if (playgroundLi) nav.insertBefore(lbl, playgroundLi);
        else nav.appendChild(lbl);

        for (const name of group.sections)
        {
            const section = sectionMap.get(name);
            if (!section) continue;

            const sSlug = sectionSlug(section.section);
            const li = document.createElement('li');
            li.className = 'toc-collapsible toc-collapsed';

            const a = document.createElement('a');
            a.href = '#' + sSlug;
            a.title = section.section;

            /* Section icon */
            const iconHtml = SECTION_ICONS[section.icon];
            if (iconHtml)
            {
                const iconWrap = document.createElement('span');
                iconWrap.className = 'toc-link-icon';
                iconWrap.innerHTML = iconHtml;
                a.appendChild(iconWrap);
            }

            /* Section name — ellipsis via CSS */
            const nameSpan = document.createElement('span');
            nameSpan.className = 'toc-link-text';
            nameSpan.textContent = section.section;
            a.appendChild(nameSpan);

            /* Item count badge */
            const itemCount = Array.isArray(section.items) ? section.items.length : 0;
            if (itemCount)
            {
                const badge = document.createElement('span');
                badge.className = 'toc-item-count';
                badge.textContent = itemCount;
                a.appendChild(badge);
            }

            /* Inline chevron for collapsible toggle */
            if (itemCount)
            {
                const chevron = document.createElement('span');
                chevron.className = 'toc-chevron';
                chevron.innerHTML = CHEVRON_SVG;
                a.appendChild(chevron);
            }

            a.addEventListener('click', (e) =>
            {
                /* If clicked on the chevron area, toggle collapse instead of navigating */
                if (e.target.closest('.toc-chevron') || e.target.closest('.toc-item-count'))
                {
                    e.preventDefault();
                    e.stopPropagation();
                    li.classList.toggle('toc-collapsed');
                    return;
                }
                /* Expand when navigating to a section */
                li.classList.remove('toc-collapsed');
                histCloseSidebar();
            });
            li.appendChild(a);

            if (itemCount)
            {
                const sub = document.createElement('ul');
                sub.className = 'toc-sub';

                for (const item of section.items)
                {
                    const subLi = document.createElement('li');
                    subLi.className = 'toc-sub-item';
                    const subA = document.createElement('a');
                    subA.href = '#' + itemSlug(section.section, item.name);
                    subA.textContent = item.name;
                    subA.title = item.name;
                    subA.addEventListener('click', () => histCloseSidebar());
                    subLi.appendChild(subA);
                    sub.appendChild(subLi);
                }

                li.appendChild(sub);
            }

            if (playgroundLi) nav.insertBefore(li, playgroundLi);
            else nav.appendChild(li);
        }
    }

    initTocCollapsible();
}

/* -- Main loader ------------------------------------------- */

export async function loadDocs(version)
{
    try
    {
        const _v = window.__v ? `?v=${window.__v}` : '';

        /* Resolve paths — always use /data/versions/{ver}/sections/ */
        const ver = version || window._docsVersion;
        if (!ver) return;
        const basePath = `/data/versions/${encodeURIComponent(ver)}`;
        const manifestUrl  = `${basePath}/docs-manifest.json${_v}`;
        const sectionsBase = `${basePath}/sections`;

        const mres = await fetch(manifestUrl);
        if (!mres.ok) return;
        const manifest = await mres.json();

        const results = await Promise.all(
            manifest.map(filename =>
                fetch(`${sectionsBase}/${filename}${_v}`)
                    .then(r => r.ok ? r.json() : null)
            )
        );
        const sections = results.filter(Boolean);
        window._docSections = sections;

        const container = document.getElementById('doc-sections');
        if (!container) return;

        container.innerHTML = '';

        /* -- Progressive rendering: first 3 sections immediately, rest in idle batches -- */
        const EAGER_COUNT = 3;
        const BATCH_SIZE  = 2;
        const _ric = window.requestIdleCallback || (cb => setTimeout(cb, 1));

        function renderAndAppend(si)
        {
            const sectionEl = renderSection(sections[si]);

            if (si === 0 && (!location.hash || location.hash === '#features'))
            {
                const items = sectionEl.querySelectorAll('.doc-item');
                for (let i = 0; i < Math.min(2, items.length); i++)
                {
                    items[i].classList.add('doc-item-expanded');
                }
                /* Expand "Getting Started" in the sidebar to match */
                expandTocForId('section-getting-started');
            }

            container.appendChild(sectionEl);
        }

        /* Eager: render first batch synchronously */
        const eagerEnd = Math.min(EAGER_COUNT, sections.length);
        for (let si = 0; si < eagerEnd; si++) renderAndAppend(si);

        /* Deferred: render remaining in idle batches */
        let deferIdx = eagerEnd;

        function renderBatch()
        {
            if (deferIdx >= sections.length)
            {
                /* All done — finalize */
                finalize();
                return;
            }
            const end = Math.min(deferIdx + BATCH_SIZE, sections.length);
            for (let si = deferIdx; si < end; si++) renderAndAppend(si);
            deferIdx = end;
            _ric(renderBatch);
        }

        function finalize()
        {
            try { highlightAllPre(); } catch (e) { }
            wireAccordions();
            wireScrollExpand();
            refreshScrollSpy();
        }

        function wireAccordions()
        {
            container.querySelectorAll('details.acc summary').forEach(summary =>
            {
                if (summary.dataset.wired === '1') return;
                summary.dataset.wired = '1';
                summary.addEventListener('click', (ev) =>
                {
                    ev.preventDefault();
                    const details = summary.parentElement;
                    if (details) {
                        details.open = !details.open;
                        if (details.id) histPushAccordion(details.id, details.open);
                    }
                });
            });
        }

        /* -- Click-to-toggle expand/collapse for doc items ----- */
        function wireScrollExpand()
        {
            const items = container.querySelectorAll('.doc-item');
            if (!items.length) return;

            items.forEach(item =>
            {
                const hdr = item.querySelector('.doc-item-header');
                if (!hdr || hdr.dataset.wired === '1') return;
                hdr.dataset.wired = '1';
                hdr.addEventListener('click', (e) =>
                {
                    if (e.target.closest('.anchor-link')) return;
                    item.classList.toggle('doc-item-expanded');
                });
            });
        }

        /* Kick off initial highlight + wiring for eager sections */
        try { highlightAllPre(); } catch (e) { }

        container.classList.remove('docs-loading');
        requestAnimationFrame(() => container.classList.add('docs-ready'));

        populateToc(sections);
        wireAccordions();
        wireScrollExpand();
        refreshScrollSpy();

        /* Start deferred rendering */
        if (deferIdx < sections.length) _ric(renderBatch);

        if (location.hash)
        {
            /* Force-render all deferred sections if hash target isn't rendered yet */
            const id = location.hash.slice(1);
            let target = document.getElementById(id);
            if (!target && deferIdx < sections.length)
            {
                while (deferIdx < sections.length) renderAndAppend(deferIdx++);
                finalize();
                target = document.getElementById(id);
            }
            if (target)
            {
                let d = target.closest('details');
                while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }

                /* Expand the target doc-item if it's a collapsible card */
                const docItem = target.closest('.doc-item') || (target.classList.contains('doc-item') ? target : null);
                if (docItem) { docItem.classList.add('doc-item-expanded'); }

                expandTocForId(id);

                document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card')
                    .forEach(s => s.style.contentVisibility = 'visible');

                requestAnimationFrame(() => {
                    void document.documentElement.offsetHeight;
                    const y = target.getBoundingClientRect().top + window.scrollY - 117;
                    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
                });
            }
        }

    } catch (e) { console.error('loadDocs error', e); }
}
