/**
 * playground.js
 * Echo playground forms — JSON, URL-encoded, and plain-text body parsers.
 *
 * Depends on: helpers.js (provides $, on, escapeHtml, showJsonResult,
 *             highlightAllPre)
 */

/**
 * Wire the three echo playground forms so submissions hit the server and
 * display the response.  Called once from the DOMContentLoaded handler in
 * app.js.
 */
function initPlayground()
{
    /* JSON echo */
    on($('#jsonPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const raw = e.target.json.value || '';
        const playResult = $('#playResult');

        try { JSON.parse(raw); }
        catch (err)
        {
            playResult.innerHTML = `<pre class="code"><code>${escapeHtml('Invalid JSON: ' + err.message)}</code></pre>`;
            return;
        }

        const r = await fetch('/echo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: raw,
        });
        const j = await r.json();
        showJsonResult(playResult, j);
    });

    /* URL-encoded echo */
    on($('#urlPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const body = e.target.url.value || '';
        const playResult = $('#playResult');

        const r = await fetch('/echo-urlencoded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const j = await r.json();
        showJsonResult(playResult, j);
    });

    /* Plain-text echo */
    on($('#textPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const txt = e.target.txt.value || '';
        const playResult = $('#playResult');

        const r = await fetch('/echo-text', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: txt,
        });
        const text = await r.text();
        playResult.innerHTML = `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
        try { highlightAllPre(); } catch (e) { }
    });
}
