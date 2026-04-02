/**
 * core/helpers.js
 * DOM query utilities, HTML escaping, formatting, JSON display,
 * syntax highlighting triggers, and code de-indentation.
 */

import { ZHHighlight } from './highlight.js';

export const $ = (sel, ctx = document) => ctx.querySelector(sel);

export const $$ = (sel, ctx = document) => Array.from((ctx || document).querySelectorAll(sel));

export function on(el, evt, cb)
{
    if (!el) return;
    el.addEventListener(evt, cb);
}

export function escapeHtml(s)
{
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escape HTML then apply lightweight inline formatting:
 *   `code`          → <code class="tip-val">code</code>
 *   'value'         → <code class="tip-val">'value'</code>
 *   true/false/null → <code class="tip-val">…</code>
 *   Multi-line      → grid layout when lines start with code values, else <br>
 */
export function formatNotes(s)
{
    let h = escapeHtml(s);
    h = h.replace(/`([^`]+)`/g, '<code class="tip-val">$1</code>');
    h = h.replace(/'([^']+)'/g, '<code class="tip-val">\'$1\'</code>');
    h = h.replace(/\b(true|false|null|undefined)\b/g, '<code class="tip-val">$1</code>');

    if (h.includes('\n'))
    {
        const [first, ...rest] = h.split('\n');
        if (rest.length)
        {
            // Use grid layout only when every continuation line starts with a code value
            const allStructured = rest.every(l => l.trimStart().startsWith('<code'));
            if (allStructured)
            {
                const lines = rest.map(l => `<span class="note-line">${l}</span>`).join('');
                return first + `<span class="note-list">${lines}</span>`;
            }
            // Flowing text (wrapped sentences) — join with spaces
            return first + ' ' + rest.map(l => l.trim()).join(' ');
        }
    }
    return h;
}

export function slugify(str)
{
    return (str || '').toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

export function formatBytes(n)
{
    if (n === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(n) / Math.log(k));
    return (n / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + sizes[i];
}

export function jsonHtml(obj)
{
    return `<pre class="code language-json"><code class="language-json">${escapeHtml(JSON.stringify(obj, null, 2))}</code></pre>`;
}

export function showJsonResult(container, obj)
{
    if (!container) return;
    container.innerHTML = jsonHtml(obj);
    try { highlightAllPre(); } catch (e) { }
    if (window._appReady && window.innerWidth <= 640) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function highlightAllPre()
{
    if (ZHHighlight && typeof ZHHighlight.highlightAll === 'function')
    {
        try { ZHHighlight.highlightAll(); } catch (e) { }
        document.querySelectorAll('pre.code').forEach(p => p.dataset.highlighted = '1');
        return;
    }
    try
    {
        document.querySelectorAll('pre.code').forEach(p =>
        {
            if (p.dataset.highlighted) return;
            const raw = p.textContent || p.innerText || '';
            p.innerHTML = '<code>' + escapeHtml(raw) + '</code>';
            p.dataset.highlighted = '1';
        });
    } catch (e) { }
}

export function dedentAllPre()
{
    document.querySelectorAll('pre').forEach(pre =>
    {
        try
        {
            if (pre.dataset.dedented) return;
            const txt = pre.textContent || '';
            const lines = txt.replace(/\r/g, '').split('\n');

            while (lines.length && lines[0].trim() === '') lines.shift();
            while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
            if (!lines.length) { pre.dataset.dedented = '1'; return; }

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
            pre.dataset.dedented = '1';
        } catch (e) { }
    });
}
