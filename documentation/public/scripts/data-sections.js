/**
 * data-sections.js
 * Fetches the unified docs.json and renders hierarchical documentation sections
 * with sidebar TOC population. Each section becomes a top-level sidebar category
 * with expandable sub-items.
 *
 * Depends on: helpers.js (provides $, escapeHtml, slugify, highlightAllPre)
 */

/* -- Section icon map -------------------------------------------------------- */
const SECTION_ICONS = {
    rocket: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    box: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    parse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/><path d="M15 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/></svg>',
    layers: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    database: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    zap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
};

/* -- Rendering helpers ------------------------------------------------------- */

function sectionSlug(sectionName)
{
    return 'section-' + slugify(sectionName);
}

function itemSlug(sectionName, itemName)
{
    return slugify(sectionName) + '-' + slugify(itemName);
}

/**
 * Render a single documentation item as a <details> accordion.
 */
function renderDocItem(item, section)
{
    const slug = itemSlug(section, item.name);
    const d = document.createElement('details');
    d.className = 'acc nested doc-item';
    d.id = slug;

    const s = document.createElement('summary');
    s.innerHTML = `<strong>${escapeHtml(item.name)}</strong>`;
    d.appendChild(s);

    const body = document.createElement('div');
    body.className = 'acc-body';

    /* Description */
    if (item.description)
    {
        const p = document.createElement('p');
        p.textContent = item.description;
        body.appendChild(p);
    }

    /* Options table */
    if (Array.isArray(item.options) && item.options.length)
    {
        const h6 = document.createElement('h6');
        h6.textContent = 'Options';
        body.appendChild(h6);

        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Option</th><th>Type</th><th>Default</th><th>Notes</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const opt of item.options)
        {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td><code>${escapeHtml(opt.option)}</code></td>` +
                `<td>${escapeHtml(opt.type || '')}</td>` +
                `<td>${escapeHtml(opt.default != null ? String(opt.default) : '—')}</td>` +
                `<td>${escapeHtml(opt.notes || '')}</td>`;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        body.appendChild(table);
    }

    /* Methods table */
    if (Array.isArray(item.methods) && item.methods.length)
    {
        const h6 = document.createElement('h6');
        h6.textContent = 'Methods';
        body.appendChild(h6);

        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Method</th><th>Signature</th><th>Description</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const m of item.methods)
        {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td><code>${escapeHtml(m.method || '')}</code></td>` +
                `<td><code>${escapeHtml(m.signature || '')}</code></td>` +
                `<td>${escapeHtml(m.description || '')}</td>`;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        body.appendChild(table);
    }

    /* Example code block */
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

    /* Tips */
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
            li.textContent = tip;
            ul.appendChild(li);
        }
        tipsDiv.appendChild(ul);
        body.appendChild(tipsDiv);
    }

    d.appendChild(body);
    return d;
}

/**
 * Render a full documentation section (section heading card + item accordions).
 */
function renderSection(section)
{
    const slug = sectionSlug(section.section);
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-section';
    wrapper.id = slug;

    /* Section header */
    const header = document.createElement('div');
    header.className = 'doc-section-header';

    const iconHtml = SECTION_ICONS[section.icon] || '';
    header.innerHTML = `<span class="doc-section-icon">${iconHtml}</span><h4 class="doc-section-title">${escapeHtml(section.section)}</h4>`;
    wrapper.appendChild(header);

    /* Section divider line */
    const divider = document.createElement('div');
    divider.className = 'doc-section-divider';
    wrapper.appendChild(divider);

    /* Items */
    if (Array.isArray(section.items))
    {
        for (const item of section.items)
        {
            wrapper.appendChild(renderDocItem(item, section.section));
        }
    }

    return wrapper;
}

/* -- TOC population ---------------------------------------------------------- */

/**
 * Build the full sidebar TOC from the docs sections array.
 */
function populateToc(sections)
{
    const nav = document.querySelector('.toc-sidebar nav ul');
    if (!nav) return;

    /* Keep static items (features, quickstart, playground) */
    const staticItems = nav.querySelectorAll(':scope > li[data-static]');
    const playgroundLi = nav.querySelector(':scope > li[data-static="playground"]');

    /* Remove all non-static items */
    Array.from(nav.children).forEach(li =>
    {
        if (!li.hasAttribute('data-static')) li.remove();
    });

    /* Insert section TOC items before playground */
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

        /* Sub-items */
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

    /* Re-init collapsible toggles for new items */
    if (typeof initTocCollapsible === 'function') initTocCollapsible();
}

/* -- Main loader ------------------------------------------------------------- */

/**
 * Fetch docs.json and render all sections + populate sidebar.
 */
async function loadDocs()
{
    try
    {
        const res = await fetch('/data/docs.json', { cache: 'no-store' });
        if (!res.ok) return;

        const sections = await res.json();
        window._docSections = sections;

        const container = document.getElementById('doc-sections');
        if (!container) return;

        container.innerHTML = '';

        for (const section of sections)
        {
            container.appendChild(renderSection(section));
        }

        try { highlightAllPre(); } catch (e) { }

        /* Populate sidebar */
        populateToc(sections);

        /* Wire accordion click handling for new items */
        container.querySelectorAll('details.acc summary').forEach(summary =>
        {
            if (summary.dataset.wired === '1') return;
            summary.dataset.wired = '1';
            summary.addEventListener('click', (ev) =>
            {
                ev.preventDefault();
                const details = summary.parentElement;
                if (details) details.open = !details.open;
            });
        });

    } catch (e) { console.error('loadDocs error', e); }
}

/* Legacy stubs for backwards compat (app.js may still call these) */
async function loadApiReference() { }
async function loadOptions() { }
async function loadExamples() { }
