/**
 * docs/sections.js
 * Renders hierarchical documentation sections with sidebar TOC population.
 */

import { escapeHtml, slugify, highlightAllPre } from '../core/helpers.js';
import { histPushAccordion, histPushModal, histCloseModal, histPushHash } from '../core/history.js';
import { initTocCollapsible, expandTocForId, scrollToId } from '../ui/shell.js';

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
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    database: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    zap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
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
                (item.notes ? `<p class="mm-row-desc">${escapeHtml(item.notes)}</p>` : '');
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
                (item.notes ? `<p class="mm-row-desc">${escapeHtml(item.notes)}</p>` : '');
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

function buildMethodRow(m)
{
    const card = document.createElement('div');
    card.className = 'mm-method-card';

    const buttons = [];

    if (Array.isArray(m.methodOptions) && m.methodOptions.length)
    {
        const id = 'mm_' + (++_mmCounter);
        _methodMeta[id] = { sig: m.signature || m.method || '', type: 'opts', data: m.methodOptions };
        buttons.push(`<button class="meth-btn meth-btn-opts" data-mm="${id}">${BTN_ICONS.opts}opts</button>`);
    }

    if (Array.isArray(m.methodParams) && m.methodParams.length)
    {
        const id = 'mm_' + (++_mmCounter);
        _methodMeta[id] = { sig: m.signature || m.method || '', type: 'params', data: m.methodParams };
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
    const d = document.createElement('details');
    d.className = 'acc nested doc-item';
    d.id = slug;

    const s = document.createElement('summary');
    s.innerHTML = `<span class="acc-title">${escapeHtml(item.name)}</span>`;
    s.appendChild(createAnchorLink(slug));
    d.appendChild(s);

    const body = document.createElement('div');
    body.className = 'acc-body';

    if (item.description)
    {
        const p = document.createElement('p');
        p.textContent = item.description;
        body.appendChild(p);
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
                (p.notes ? `<p class="mm-prop-notes">${escapeHtml(p.notes)}</p>` : '');
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
                (opt.notes ? `<p class="mm-prop-notes">${escapeHtml(opt.notes)}</p>` : '');
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
                    (opt.notes ? `<p class="mm-prop-notes">${escapeHtml(opt.notes)}</p>` : '');
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
            mlist.appendChild(buildMethodRow(m));
        }
        body.appendChild(mlist);
    }

    if (Array.isArray(item.methodGroups) && item.methodGroups.length)
    {
        for (const group of item.methodGroups)
        {
            const glabel = document.createElement('div');
            glabel.className = 'mm-group-label';
            glabel.textContent = group.group || group.category || 'Methods';
            body.appendChild(glabel);

            const mlist = document.createElement('div');
            mlist.className = 'mm-method-list';
            for (const m of group.methods)
            {
                mlist.appendChild(buildMethodRow(m));
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

    d.appendChild(body);
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
        for (const item of section.items)
        {
            wrapper.appendChild(renderDocItem(item, section.section));
        }
    }

    return wrapper;
}

/* -- TOC population ---------------------------------------- */

function populateToc(sections)
{
    const nav = document.querySelector('.toc-sidebar nav ul');
    if (!nav) return;

    const playgroundLi = nav.querySelector(':scope > li[data-static="playground"]');

    Array.from(nav.children).forEach(li =>
    {
        if (!li.hasAttribute('data-static')) li.remove();
    });

    for (const section of sections)
    {
        const sSlug = sectionSlug(section.section);
        const li = document.createElement('li');
        li.className = 'toc-collapsible toc-collapsed';

        const a = document.createElement('a');
        a.href = '#' + sSlug;
        a.textContent = section.section;
        a.addEventListener('click', () => document.body.classList.remove('toc-open'));
        li.appendChild(a);

        if (Array.isArray(section.items) && section.items.length)
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
                subA.addEventListener('click', () => document.body.classList.remove('toc-open'));
                subLi.appendChild(subA);
                sub.appendChild(subLi);
            }

            li.appendChild(sub);
        }

        if (playgroundLi)
        {
            nav.insertBefore(li, playgroundLi);
        }
        else
        {
            nav.appendChild(li);
        }
    }

    initTocCollapsible();
}

/* -- Main loader ------------------------------------------- */

export async function loadDocs()
{
    try
    {
        const mres = await fetch('/data/docs-manifest.json', { cache: 'no-store' });
        if (!mres.ok) return;
        const manifest = await mres.json();

        const results = await Promise.all(
            manifest.map(filename =>
                fetch(`/data/sections/${filename}`, { cache: 'no-store' })
                    .then(r => r.ok ? r.json() : null)
            )
        );
        const sections = results.filter(Boolean);
        window._docSections = sections;

        const container = document.getElementById('doc-sections');
        if (!container) return;

        container.innerHTML = '';

        for (let si = 0; si < sections.length; si++)
        {
            const sectionEl = renderSection(sections[si]);

            if (si === 0 && !location.hash)
            {
                const items = sectionEl.querySelectorAll('details.acc');
                for (let i = 0; i < Math.min(2, items.length); i++)
                {
                    items[i].open = true;
                }
            }

            container.appendChild(sectionEl);
        }

        try { highlightAllPre(); } catch (e) { }

        container.classList.remove('docs-loading');
        requestAnimationFrame(() => container.classList.add('docs-ready'));

        populateToc(sections);

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

        if (location.hash)
        {
            const id = location.hash.slice(1);
            const target = document.getElementById(id);
            if (target)
            {
                let d = target.closest('details');
                while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }

                expandTocForId(id);

                document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card')
                    .forEach(s => s.style.contentVisibility = 'visible');

                requestAnimationFrame(() => {
                    void document.documentElement.offsetHeight;
                    target.scrollIntoView({ behavior: 'instant', block: 'start' });
                });
            }
        }

    } catch (e) { console.error('loadDocs error', e); }
}
