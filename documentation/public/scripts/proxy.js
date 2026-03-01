/**
 * proxy.js
 * Proxy playground — fetches an external URL through the server and renders
 * the response based on its content-type (JSON, image, audio/video, text,
 * or a binary download link).
 *
 * Depends on: helpers.js (provides $, on, escapeHtml, showJsonResult,
 *             highlightAllPre)
 */

/**
 * Wire the proxy form.  Called once from the DOMContentLoaded handler in
 * app.js.
 */
function initProxy()
{
    const proxyForm   = $('#proxyForm');
    const proxyResult = $('#proxyResult');
    if (!proxyForm) return;

    on(proxyForm, 'submit', async (e) =>
    {
        e.preventDefault();
        const urlInput = $('#proxyUrl');
        const url = urlInput && urlInput.value ? urlInput.value.trim() : '';

        if (!url)
        {
            proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml('Please enter a URL')}</code></pre>`;
            return;
        }

        try
        {
            proxyResult.innerHTML = `<div class="muted">Fetching ${escapeHtml(url)}…</div>`;
            const r = await fetch('/proxy?url=' + encodeURIComponent(url));

            /* Upstream error */
            if (r.status >= 400)
            {
                const j = await r.json();
                showJsonResult(proxyResult, j);
                return;
            }

            const ct = (r.headers && typeof r.headers.get === 'function')
                ? (r.headers.get('content-type') || '')
                : '';

            /* JSON */
            if (ct.includes('application/json') || ct.includes('application/problem+json'))
            {
                showJsonResult(proxyResult, await r.json());
            }
            /* Image */
            else if (ct.startsWith('image/'))
            {
                const blob = new Blob([await r.arrayBuffer()], { type: ct });
                const src  = URL.createObjectURL(blob);
                proxyResult.innerHTML =
                    `<div style="display:flex;align-items:center;gap:12px">` +
                    `<img src="${src}" style="max-width:240px;max-height:240px;border-radius:8px"/>` +
                    `<div class="mono" style="max-width:480px;overflow:auto">${escapeHtml('Image received: ' + ct)}</div></div>`;
            }
            /* Audio / Video / Octet-stream */
            else if (ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/octet-stream' || ct.includes('wav') || ct.includes('wave'))
            {
                const proxiedUrl = '/proxy?url=' + encodeURIComponent(url);
                let mediaHtml = '';
                if (ct.startsWith('audio/'))
                    mediaHtml = `<audio controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></audio>`;
                else if (ct.startsWith('video/'))
                    mediaHtml = `<video controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></video>`;
                proxyResult.innerHTML = `<div>${mediaHtml}<div class="mono">${escapeHtml('Streaming: ' + ct)}</div></div>`;
            }
            /* Text */
            else if (ct.startsWith('text/') || ct === '')
            {
                const txt = await r.text();
                proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(txt)}</code></pre>`;
                try { highlightAllPre(); } catch (e) { }
            }
            /* Binary fallback — offer download */
            else
            {
                const ab   = await r.arrayBuffer();
                const blob = new Blob([ab], { type: ct || 'application/octet-stream' });
                const href = URL.createObjectURL(blob);
                proxyResult.innerHTML =
                    `<div class="mono">${escapeHtml('Binary response: ' + ct + ' — ' + ab.byteLength + ' bytes')}</div>` +
                    `<div style="margin-top:8px"><a href="${href}" download="proxied-file">Download file</a></div>`;
            }
        } catch (err)
        {
            proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(String(err))}</code></pre>`;
        }
    });
}
