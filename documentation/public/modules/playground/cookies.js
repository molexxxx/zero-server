/**
 * playground/cookies.js – Cookie explorer.
 */

import { $, on, escapeHtml, showJsonResult } from '../core/helpers.js';

export function initCookies()
{
    const form      = $('#cookieForm');
    const nameIn    = $('#cookieName');
    const valueIn   = $('#cookieValue');
    const httpOnlyIn = $('#cookieHttpOnly');
    const sameSiteIn = $('#cookieSameSite');
    const maxAgeIn  = $('#cookieMaxAge');
    const refreshBtn = $('#cookieRefresh');
    const jarEl     = $('#cookieJar');
    const resultEl  = $('#cookieResult');

    if (!form) return;

    async function loadCookies()
    {
        try
        {
            const r = await fetch('/api/cookies');
            const data = await r.json();
            showJsonResult(resultEl, data);

            const all = Object.entries(data.cookies || {});
            const signed = Object.entries(data.signedCookies || {});

            if (!all.length && !signed.length)
            {
                jarEl.innerHTML = '<div style="padding:12px;color:#98a0aa">No cookies set — use the form above to create one.</div>';
                return;
            }

            let html = '';
            for (const [name, val] of all)
            {
                html += `<div class="cookie-row">` +
                    `<span class="cookie-name">${escapeHtml(name)}</span>` +
                    `<span class="cookie-val">${escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val))}</span>` +
                    `<button class="btn small warn cookie-del-btn" data-name="${escapeHtml(name)}">Clear</button>` +
                    `</div>`;
            }
            for (const [name, val] of signed)
            {
                html += `<div class="cookie-row">` +
                    `<span class="cookie-name">${escapeHtml(name)} <span style="color:#5865f2;font-size:11px">signed</span></span>` +
                    `<span class="cookie-val">${escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val))}</span>` +
                    `<button class="btn small warn cookie-del-btn" data-name="${escapeHtml(name)}">Clear</button>` +
                    `</div>`;
            }
            jarEl.innerHTML = html;
        }
        catch (e) { jarEl.innerHTML = `<div style="color:#f66">${escapeHtml(e.message)}</div>`; }
    }

    on(form, 'submit', async (e) =>
    {
        e.preventDefault();
        const name = nameIn.value.trim();
        if (!name) return;

        const options = { sameSite: sameSiteIn.value };
        if (httpOnlyIn.value === 'true') options.httpOnly = true;
        if (maxAgeIn.value) options.maxAge = Number(maxAgeIn.value);

        await fetch('/api/cookies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                value: valueIn.value,
                options,
            }),
        });
        nameIn.value = '';
        valueIn.value = '';
        maxAgeIn.value = '';
        httpOnlyIn.value = 'false';
        sameSiteIn.value = 'Lax';
        httpOnlyIn.dispatchEvent(new Event('change', { bubbles: true }));
        sameSiteIn.dispatchEvent(new Event('change', { bubbles: true }));
        loadCookies();
    });

    on(jarEl, 'click', async (e) =>
    {
        const btn = e.target.closest('.cookie-del-btn');
        if (!btn) return;
        await fetch('/api/cookies/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
        loadCookies();
    });

    on(refreshBtn, 'click', loadCookies);

    loadCookies();
}
