/**
 * helpers.js
 * Shared DOM selectors, formatters, and rendering utilities used across all
 * documentation scripts. Loaded first so every other module can rely on these.
 */

/* -- DOM Selectors ----------------------------------------------------------- */

/**
 * Query a single element by CSS selector.
 * @param {string} sel  - CSS selector string.
 * @param {Element} ctx - Optional root element (defaults to `document`).
 * @returns {Element|null}
 */
const $ = (sel, ctx = document) => ctx.querySelector(sel);

/**
 * Query all matching elements and return a real array.
 * @param {string} sel  - CSS selector string.
 * @param {Element} ctx - Optional root element (defaults to `document`).
 * @returns {Element[]}
 */
const $$ = (sel, ctx = document) => Array.from((ctx || document).querySelectorAll(sel));

/**
 * Attach an event listener, safely no-ops if element is null.
 * @param {Element|null} el  - Target element.
 * @param {string}       evt - Event name.
 * @param {Function}     cb  - Callback.
 */
function on(el, evt, cb)
{
    if (!el) return;
    el.addEventListener(evt, cb);
}

/* -- String Utilities -------------------------------------------------------- */

/**
 * Escape HTML special characters for safe insertion into the DOM.
 * @param {string} s - Raw string.
 * @returns {string} Escaped string.
 */
function escapeHtml(s)
{
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Convert a human-readable name into a URL-safe slug.
 * @param {string} str - Input string.
 * @returns {string} Lower-cased, hyphenated slug.
 */
function slugify(str)
{
    return (str || '').toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

/**
 * Format a byte count into a human-readable string (B / KB / MB / GB).
 * @param {number} n - Byte count.
 * @returns {string}
 */
function formatBytes(n)
{
    if (n === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(n) / Math.log(k));
    return (n / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + sizes[i];
}

/* -- JSON / Code Rendering --------------------------------------------------- */

/**
 * Build a highlighted `<pre>` block containing pretty-printed JSON.
 * @param {*} obj - Any JSON-serialisable value.
 * @returns {string} HTML string.
 */
function jsonHtml(obj)
{
    return `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(obj, null, 2))}</code></pre>`;
}

/**
 * Render a JSON object into a container element and trigger Prism highlighting.
 * @param {Element|null} container - Target element.
 * @param {*}            obj       - JSON-serialisable value.
 */
function showJsonResult(container, obj)
{
    if (!container) return;
    container.innerHTML = jsonHtml(obj);
    try { highlightAllPre(); } catch (e) { }
    if (window._appReady && window.innerWidth <= 640) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -- Prism / Code-Block Helpers ---------------------------------------------- */

/**
 * Trigger Prism syntax highlighting on all `<pre class="code">` blocks, or
 * fall back to a simple escape-and-wrap if Prism is not loaded.
 */
function highlightAllPre()
{
    if (window.Prism && typeof Prism.highlightAll === 'function')
    {
        try { Prism.highlightAll(); } catch (e) { }
        document.querySelectorAll('pre.code').forEach(p => p.dataset.miniExpressHighlighted = '1');
        return;
    }
    try
    {
        document.querySelectorAll('pre.code').forEach(p =>
        {
            if (p.dataset.miniExpressHighlighted) return;
            const raw = p.textContent || p.innerText || '';
            p.innerHTML = '<code>' + escapeHtml(raw) + '</code>';
            p.dataset.miniExpressHighlighted = '1';
        });
    } catch (e) { }
}

/**
 * Strip common leading whitespace from every `<pre>` block so that indented
 * source pasted into the HTML renders flush-left.
 */
function dedentAllPre()
{
    document.querySelectorAll('pre').forEach(pre =>
    {
        try
        {
            if (pre.dataset.miniExpressDedented) return;
            const txt = pre.textContent || '';
            const lines = txt.replace(/\r/g, '').split('\n');

            while (lines.length && lines[0].trim() === '') lines.shift();
            while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
            if (!lines.length) { pre.dataset.miniExpressDedented = '1'; return; }

            const indents = lines.filter(l => l.trim()).map(l =>
            {
                const match = l.match(/^[\t ]*/)[0] || '';
                return match.replace(/\t/g, '    ').length;
            });
            const minIndent = indents.length ? Math.min(...indents) : 0;

            if (minIndent > 0)
            {
                const dedented = lines.map(l =>
                {
                    const s = l.replace(/\t/g, '    ');
                    return s.slice(Math.min(minIndent, s.length));
                }).join('\n');
                pre.textContent = dedented;
            }
            pre.dataset.miniExpressDedented = '1';
        } catch (e) { }
    });
}
