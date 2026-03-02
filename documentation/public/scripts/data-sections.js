/**
 * data-sections.js
 * Fetches and renders the three data-driven documentation sections:
 *   - API Reference   (/data/api.json)
 *   - Options Table   (/data/options.json)
 *   - Code Examples   (/data/examples.json)
 *
 * Also populates the sidebar TOC with sub-items for the API reference and
 * examples sections.
 *
 * Depends on: helpers.js (provides $, escapeHtml, slugify, showJsonResult,
 *             highlightAllPre)
 */

/* -- TOC Helpers ------------------------------------------------------------- */

/**
 * Find a top-level `<li>` in the sidebar TOC whose link matches the given
 * href, then append a sub-list of items beneath it.
 * @param {string}   href  - Hash href to match (e.g. "#api-reference").
 * @param {Object[]} items - Array of `{ slug, label }` objects.
 */
function populateTocSub(href, items)
{
    const nav = document.querySelector('.toc-sidebar nav ul');
    if (!nav || !items || !items.length) return;

    const parentLi = Array.from(nav.children).find(li =>
    {
        const a = li.querySelector && li.querySelector(`a[href="${href}"]`);
        return !!a;
    });
    if (!parentLi) return;

    /* Remove existing sub-list if present (re-render safe) */
    const existing = parentLi.querySelector('ul.toc-sub');
    if (existing) existing.remove();

    /* Ensure parent has collapsible behaviour */
    if (!parentLi.classList.contains('toc-collapsible'))
    {
        parentLi.classList.add('toc-collapsible', 'toc-collapsed');
        parentLi.style.paddingLeft = '20px';

        const toggle = document.createElement('button');
        toggle.className = 'toc-collapse-btn';
        toggle.setAttribute('aria-label', 'Toggle section');
        toggle.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        toggle.addEventListener('click', (e) =>
        {
            e.preventDefault();
            e.stopPropagation();
            parentLi.classList.toggle('toc-collapsed');
        });
        parentLi.insertBefore(toggle, parentLi.firstChild);
    }

    const sub = document.createElement('ul');
    sub.className = 'toc-sub';

    for (const { slug, label } of items)
    {
        const li = document.createElement('li');
        li.className = 'toc-sub-item';

        const a = document.createElement('a');
        a.href = '#' + slug;
        a.textContent = label;
        a.addEventListener('click', () => document.body.classList.remove('toc-open'));

        li.appendChild(a);
        sub.appendChild(li);
    }

    parentLi.appendChild(sub);
}

/* -- API Reference ----------------------------------------------------------- */

/**
 * Render a list of API items into the `#api-items` container and Prism-highlight
 * any code examples.
 * @param {HTMLElement} container - Target element.
 * @param {Object[]}   list      - API item descriptors.
 */
function renderApiList(container, list)
{
    container.innerHTML = '';
    if (!list || !list.length) { container.textContent = 'No API items'; return; }

    for (const it of list)
    {
        const d = document.createElement('details');
        d.className = 'acc nested';
        d.id = 'api-' + slugify(it.name || '');

        const s = document.createElement('summary');
        s.innerHTML = `<strong>${escapeHtml(it.name)}</strong>`;
        d.appendChild(s);

        const body = document.createElement('div');
        body.className = 'acc-body';

        /* Description */
        if (it.description)
        {
            const p = document.createElement('p');
            p.innerHTML = escapeHtml(it.description);
            body.appendChild(p);
        }

        /* Options table */
        if (Array.isArray(it.options) && it.options.length)
        {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Option</th><th>Type</th><th>Default</th><th>Notes</th></tr></thead>';
            const tbody = document.createElement('tbody');
            for (const opt of it.options)
            {
                const tr = document.createElement('tr');
                tr.innerHTML =
                    `<td><code>${escapeHtml(opt.option)}</code></td>` +
                    `<td>${escapeHtml(opt.type || '')}</td>` +
                    `<td>${escapeHtml(opt.default || '')}</td>` +
                    `<td>${escapeHtml(opt.notes || '')}</td>`;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            body.appendChild(table);
        }

        /* Methods table */
        if (Array.isArray(it.methods) && it.methods.length)
        {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Method</th><th>Signature</th><th>Description</th></tr></thead>';
            const tbody = document.createElement('tbody');
            for (const m of it.methods)
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
        if (it.example)
        {
            const h6 = document.createElement('h6');
            h6.textContent = 'Example';
            const pre = document.createElement('pre');
            pre.className = 'language-javascript code';
            const code = document.createElement('code');
            code.className = 'language-javascript';
            code.textContent = it.example;
            pre.appendChild(code);
            body.appendChild(h6);
            body.appendChild(pre);
        }

        d.appendChild(body);
        container.appendChild(d);
    }

    try { highlightAllPre(); } catch (e) { }
}

/**
 * Fetch the API reference JSON, render it, populate the sidebar TOC, and wire
 * the search / clear filter controls.
 */
async function loadApiReference()
{
    try
    {
        const res = await fetch('/data/api.json', { cache: 'no-store' });
        if (!res.ok) return;

        const items = await res.json();
        const container = document.getElementById('api-items');
        if (!container) return;

        window._apiItems = items;
        renderApiList(container, items);

        /* Sidebar TOC sub-items */
        populateTocSub('#api-reference', items.map(it => ({
            slug:  'api-' + slugify(it.name),
            label: it.name || '',
        })));

        /* Search / clear filter */
        const search   = document.getElementById('api-search');
        const clearBtn = document.getElementById('api-clear');

        const doFilter = () =>
        {
            const q = (search && search.value || '').trim().toLowerCase();
            if (!q) return renderApiList(container, window._apiItems);
            const filtered = window._apiItems.filter(it =>
                (it.name || '').toLowerCase().includes(q) ||
                (it.description || '').toLowerCase().includes(q) ||
                JSON.stringify(it.options || []).toLowerCase().includes(q)
            );
            renderApiList(container, filtered);
        };

        if (search)   search.addEventListener('input', doFilter);
        if (clearBtn) clearBtn.addEventListener('click', () => { if (search) search.value = ''; renderApiList(container, window._apiItems); });
    } catch (e) { }
}

/* -- Options Table ----------------------------------------------------------- */

/**
 * Fetch the options JSON and render a `<table>` into `#options-items`.
 */
async function loadOptions()
{
    try
    {
        const container = document.getElementById('options-items');
        if (!container) return;

        const res = await fetch('/data/options.json', { cache: 'no-store' });
        if (!res.ok) { container.textContent = 'Error loading options: ' + res.status + ' ' + res.statusText; return; }

        let items;
        try { items = await res.json(); }
        catch (err) { container.textContent = 'Error parsing options JSON'; return; }

        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Option</th><th>Type</th><th>Default</th><th>Notes</th></tr></thead>';
        const tbody = document.createElement('tbody');

        for (const it of items)
        {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td><strong>${escapeHtml(it.option || '')}</strong></td>` +
                `<td>${escapeHtml(it.type || '')}</td>` +
                `<td>${escapeHtml(it.default || '')}</td>` +
                `<td>${escapeHtml(it.notes || it.description || '')}</td>`;
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        container.innerHTML = '';
        container.appendChild(table);
    } catch (e) { console.error('loadOptions error', e); }
}

/* -- Code Examples ----------------------------------------------------------- */

/**
 * Fetch the examples JSON, render each as a collapsible accordion, and
 * populate the sidebar TOC.
 */
async function loadExamples()
{
    try
    {
        const container = document.getElementById('examples-items');
        if (!container) return;

        const res = await fetch('/data/examples.json', { cache: 'no-store' });
        if (!res.ok) { container.textContent = 'Error loading examples: ' + res.status; return; }

        const items = await res.json();
        container.innerHTML = '';

        for (const it of items)
        {
            const id = 'example-' + slugify(it.title);
            const d = document.createElement('details');
            d.className = 'acc nested';
            d.id = id;

            const s = document.createElement('summary');
            s.innerHTML = `<strong>${escapeHtml(it.title || '')}</strong>`;
            d.appendChild(s);

            const body = document.createElement('div');
            body.className = 'acc-body';

            if (it.description)
            {
                const p = document.createElement('p');
                p.className = 'muted';
                p.textContent = it.description;
                body.appendChild(p);
            }

            const pre = document.createElement('pre');
            pre.className = it.language ? 'language-' + it.language + ' code' : 'code';
            const code = document.createElement('code');
            if (it.language) code.className = 'language-' + it.language;
            code.textContent = it.code || '';
            pre.appendChild(code);
            body.appendChild(pre);

            d.appendChild(body);
            container.appendChild(d);
        }

        try { highlightAllPre(); } catch (e) { }

        /* Sidebar TOC sub-items */
        populateTocSub('#simple-examples', items.map(it => ({
            slug:  'example-' + slugify(it.title),
            label: it.title || '',
        })));
    } catch (e) { console.error('loadExamples error', e); }
}
