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

    /* Random resource URLs for quick testing */
    const SAMPLE_URLS = [
        'https://download.samplelib.com/mp4/sample-5s.mp4',
        'https://download.samplelib.com/mp3/sample-3s.mp3',
        'https://picsum.photos/400/300',
        'https://picsum.photos/600/400',
        'https://picsum.photos/300/300',
        'https://httpbin.org/json',
        'https://httpbin.org/html',
        'https://httpbin.org/xml',
        'https://httpbin.org/image/png',
        'https://httpbin.org/image/jpeg',
        'https://httpbin.org/image/svg',
        'https://httpbin.org/robots.txt',
        'https://httpbin.org/uuid',
        'https://httpbin.org/user-agent',
        'https://httpbin.org/headers',
        'https://httpbin.org/ip',
        'https://jsonplaceholder.typicode.com/posts/1',
        'https://jsonplaceholder.typicode.com/users',
        'https://jsonplaceholder.typicode.com/comments?postId=1',
        'https://jsonplaceholder.typicode.com/albums/1/photos',
        'https://catfact.ninja/fact',
        'https://api.github.com/zen',
        'https://dog.ceo/api/breeds/image/random',
        'https://official-joke-api.appspot.com/random_joke',
        'https://uselessfacts.jsph.pl/api/v2/facts/random?language=en',
        'https://www.boredapi.com/api/activity',
        'https://api.adviceslip.com/advice',
        'https://placeholder.co/400x300/png'
    ];

    const randomBtn = $('#proxyRandomBtn');
    if (randomBtn)
    {
        randomBtn.addEventListener('click', () =>
        {
            const urlInput = $('#proxyUrl');
            if (urlInput)
            {
                urlInput.value = SAMPLE_URLS[Math.floor(Math.random() * SAMPLE_URLS.length)];
                proxyForm.dispatchEvent(new Event('submit', { cancelable: true }));
            }
        });
    }

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

                /* HTML — render in a sandboxed iframe with a <base> tag so
                   relative src/href attributes resolve against the original URL */
                if (ct.includes('text/html'))
                {
                    /* Derive the base URL (origin + path up to last slash) */
                    let baseHref;
                    try
                    {
                        const parsed = new URL(url);
                        const lastSlash = parsed.pathname.lastIndexOf('/');
                        baseHref = parsed.origin + parsed.pathname.substring(0, lastSlash + 1);
                    } catch (_) { baseHref = url; }

                    /* Inject <base> right after <head> (or at the top if no <head>) */
                    const baseTag = '<base href="' + baseHref.replace(/"/g, '&quot;') + '" target="_blank">';
                    let patched = txt;
                    if (/<head[^>]*>/i.test(patched))
                        patched = patched.replace(/(<head[^>]*>)/i, '$1' + baseTag);
                    else
                        patched = baseTag + patched;

                    const blob = new Blob([patched], { type: 'text/html;charset=utf-8' });
                    const blobUrl = URL.createObjectURL(blob);

                    proxyResult.innerHTML =
                        `<iframe src="${blobUrl}" ` +
                        `sandbox="allow-scripts allow-same-origin" ` +
                        `style="width:100%;height:500px;border:1px solid var(--surface-border);border-radius:8px;background:#fff" ` +
                        `title="Proxied page"></iframe>` +
                        `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:13px">View source</summary>` +
                        `<pre class="code" style="margin-top:6px"><code>${escapeHtml(txt)}</code></pre></details>`;
                    try { highlightAllPre(); } catch (e) { }
                }
                else
                {
                    proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(txt)}</code></pre>`;
                    try { highlightAllPre(); } catch (e) { }
                }
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
