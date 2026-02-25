const uploadForm = document.getElementById('uploadForm');
const uploadsList = document.getElementById('uploadsList');
const uploadProgress = document.getElementById('uploadProgress');
const uploadResult = document.getElementById('uploadResult');
const fileDrop = document.getElementById('fileDrop');
const fileInput = document.getElementById('fileInput');
const delAllBtn = document.getElementById('delAllBtn');
const delKeepBtn = document.getElementById('delKeepBtn');
const trashList = document.getElementById('trashList');
const emptyTrashBtn = document.getElementById('emptyTrashBtn');
const playResult = document.getElementById('playResult');
const sortSelect = document.getElementById('sortSelect');
const sortOrder = document.getElementById('sortOrder');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
let currentPage = 1; let currentSort = 'mtime'; let currentOrder = (sortOrder && sortOrder.value) || 'desc'; const pageSize = 4;

uploadForm.addEventListener('submit', (e) =>
{
    e.preventDefault();
    const fd = new FormData(uploadForm);
    const xhr = new XMLHttpRequest();
    const controls = uploadForm.querySelectorAll('button,input,select,textarea');
    controls.forEach(c => c.disabled = true);
    currentPage = 1;
    uploadsList.innerHTML = '';
    uploadProgress.style.display = 'block';
    uploadProgress.value = 0;
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) uploadProgress.value = Math.round(ev.loaded / ev.total * 100); };
    xhr.onload = () =>
    {
        uploadProgress.style.display = 'none';
        try { const j = JSON.parse(xhr.responseText); uploadResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`; }
        catch (err) { uploadResult.textContent = xhr.responseText; }
        controls.forEach(c => c.disabled = false);
        try { highlightAllPre(); } catch (e) { }
        loadUploadsList();
    };
    xhr.onerror = () => { uploadProgress.style.display = 'none'; uploadResult.textContent = 'Upload failed'; };
    xhr.send(fd);
    });

delAllBtn.addEventListener('click', async () =>
{
    if (!confirm('Delete all uploads?')) return;
    const r = await fetch('/uploads', { method: 'DELETE' });
    const j = await r.json();
    uploadResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
    loadUploadsList();
});

delKeepBtn.addEventListener('click', async () =>
{
    if (!confirm('Delete all uploads but keep the first?')) return;
    const r = await fetch('/uploads?keep=1', { method: 'DELETE' });
    const j = await r.json();
    uploadResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
    loadUploadsList();
});

// pagination / sorting handlers
sortSelect.addEventListener('change', () => { currentSort = sortSelect.value; currentPage = 1; loadUploadsList(); });
if (sortOrder) sortOrder.addEventListener('change', () => { currentOrder = sortOrder.value; currentPage = 1; loadUploadsList(); });
prevPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; loadUploadsList(); } });
nextPageBtn.addEventListener('click', () => { currentPage++; loadUploadsList(); });

// Trash handling
async function loadTrashList()
{
    try
    {
        const r = await fetch('/uploads-trash-list', { cache: 'no-store' });
        const j = await r.json();
        trashList.innerHTML = '';
        if (!j.files || j.files.length === 0) { trashList.textContent = 'Trash is empty'; return; }
        for (const f of j.files)
        {
            const row = document.createElement('div'); row.className = 'fileRow trash';
            const name = document.createElement('div'); name.innerHTML = `<div>${f.name}</div>`;
            const restore = document.createElement('button'); restore.textContent = 'Restore'; restore.className = 'btn';
            restore.addEventListener('click', async () => { await fetch('/uploads/' + encodeURIComponent(f.name) + '/restore', { method: 'POST' }); loadTrashList(); loadUploadsList(); });
            const del = document.createElement('button'); del.textContent = 'Delete Permanently'; del.className = 'btn warn';
            del.addEventListener('click', async () => { if (!confirm('Permanently delete ' + f.name + '?')) return; await fetch('/uploads-trash/' + encodeURIComponent(f.name), { method: 'DELETE' }); loadTrashList(); });
            row.appendChild(name); row.appendChild(restore); row.appendChild(del); trashList.appendChild(row);
        }
    } catch (e) { trashList.textContent = 'Error loading trash'; }
}

emptyTrashBtn.addEventListener('click', async () =>
{
    if (!confirm('Empty trash? This will permanently delete items.')) return;
    const r = await fetch('/uploads-trash', { method: 'DELETE' });
    const j = await r.json();
    uploadResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
    loadTrashList();
});

function showUndo(name)
{
    const box = document.createElement('div');
    box.className = 'panel';
    box.textContent = `Trashed ${name} — `;
    const btn = document.createElement('button'); btn.textContent = 'Undo'; btn.className = 'btn';
    box.appendChild(btn);
    try
    {
        const container = document.querySelector('.ui-shell') || document.querySelector('body');
        container && container.prepend(box);
    } catch (e) { }
    const tid = setTimeout(() => box.remove(), 8000);
    btn.addEventListener('click', async () => { clearTimeout(tid); await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' }); box.remove(); loadUploadsList(); loadTrashList(); });
}

// Add a single trash row to the UI (used for optimistic updates)
function addTrashRow(name)
{
    try
    {
        // ensure trashList exists
        if (!trashList) return;
        // create row similar to loadTrashList
        const row = document.createElement('div'); row.className = 'fileRow trash';
        const nameDiv = document.createElement('div'); nameDiv.innerHTML = `<div>${escapeHtml(name)}</div>`;
        const restore = document.createElement('button'); restore.textContent = 'Restore'; restore.className = 'btn';
        restore.addEventListener('click', async () =>
        {
            await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
            // remove row from UI
            try { row.remove(); } catch (e) { }
            // refresh uploads list
            loadUploadsList();
        });
        const del = document.createElement('button'); del.textContent = 'Delete Permanently'; del.className = 'btn warn';
        del.addEventListener('click', async () => { if (!confirm('Permanently delete ' + name + '?')) return; await fetch('/uploads-trash/' + encodeURIComponent(name), { method: 'DELETE' }); try { row.remove(); } catch (e) { } });
        row.appendChild(nameDiv); row.appendChild(restore); row.appendChild(del);
        // prepend so newest trash appears on top
        if (trashList.firstChild) trashList.insertBefore(row, trashList.firstChild); else trashList.appendChild(row);
    } catch (e) { }
}

function formatBytes(n) { if (n === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(n) / Math.log(k)); return (n / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + sizes[i]; }

// Playground handlers
// Playground handlers: use textareas for nicer multiline input and show highlighted results
document.getElementById('jsonPlay').addEventListener('submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const raw = f.json.value || '';
    try
    {
        JSON.parse(raw); // validate
    } catch (err) { playResult.innerHTML = `<pre class="code"><code>${escapeHtml('Invalid JSON: ' + err.message)}</code></pre>`; return; }
    const r = await fetch('/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
    const j = await r.json(); playResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
    try { highlightAllPre(); } catch (e) { }
});
document.getElementById('urlPlay').addEventListener('submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const body = f.url.value || '';
    const r = await fetch('/echo-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    const j = await r.json(); playResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
    try { highlightAllPre(); } catch (e) { }
});
document.getElementById('textPlay').addEventListener('submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const txt = f.txt.value || '';
    const r = await fetch('/echo-text', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txt });
    const j = await r.text(); playResult.innerHTML = `<pre class="code"><code>${escapeHtml(j)}</code></pre>`;
    try { highlightAllPre(); } catch (e) { }
});

// Proxy form handler (client-side) - submits to server /proxy endpoint
const proxyForm = document.getElementById('proxyForm');
const proxyResult = document.getElementById('proxyResult');
if (proxyForm)
{
    proxyForm.addEventListener('submit', async (e) =>
    {
        e.preventDefault();
        const urlInput = document.getElementById('proxyUrl');
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
            if (r.status >= 400)
            {
                const j = await r.json(); proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`; try { highlightAllPre(); } catch (e) { }
                return;
            }
            const ct = (r.headers && (typeof r.headers.get === 'function')) ? (r.headers.get('content-type') || '') : '';
            if (ct.includes('application/json') || ct.includes('application/problem+json'))
            {
                const j = await r.json();
                proxyResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(j, null, 2))}</code></pre>`;
                try { highlightAllPre(); } catch (e) { }
            }
            else if (ct.startsWith('image/'))
            {
                // render image result
                const ab = await r.arrayBuffer();
                const blob = new Blob([ab], { type: ct });
                const urlObj = URL.createObjectURL(blob);
                proxyResult.innerHTML = `<div style="display:flex;align-items:center;gap:12px"><img src="${urlObj}" style="max-width:240px;max-height:240px;border-radius:8px"/><div class="mono" style="max-width:480px;overflow:auto">${escapeHtml('Image received: ' + ct)}</div></div>`;
            }
            else if (ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/octet-stream' || ct.includes('wav') || ct.includes('wave'))
            {
                // For media, set the src of a player to the proxied URL so the browser streams natively
                const proxiedUrl = '/proxy?url=' + encodeURIComponent(url);
                let mediaHtml = '';
                if (ct.startsWith('audio/')) mediaHtml = `<audio controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></audio>`;
                else if (ct.startsWith('video/')) mediaHtml = `<video controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></video>`;
                const info = `<div class="mono">${escapeHtml('Streaming: ' + ct)}</div>`;
                proxyResult.innerHTML = `<div>${mediaHtml}${info}</div>`;
            }
            else if (ct.startsWith('text/') || ct === '')
            {
                // treat as text
                const txt = await r.text();
                proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(txt)}</code></pre>`;
                try { highlightAllPre(); } catch (e) { }
            }
            else
            {
                // unknown non-text binary — offer download
                const ab = await r.arrayBuffer();
                const blob = new Blob([ab], { type: ct || 'application/octet-stream' });
                const urlObj = URL.createObjectURL(blob);
                proxyResult.innerHTML = `<div class="mono">${escapeHtml('Binary response: ' + ct + ' — ' + ab.byteLength + ' bytes')}</div><div style="margin-top:8px"><a href="${urlObj}" download="proxied-file">Download file</a></div>`;
            }
        } catch (err)
        {
            proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(String(err))}</code></pre>`;
        }
    });
}

async function loadUploadsList()
{
    try
    {
        const r = await fetch(`/uploads-list?page=${currentPage}&pageSize=${pageSize}&sort=${encodeURIComponent(currentSort)}&order=${encodeURIComponent(currentOrder)}`, { cache: 'no-store' });
        const j = await r.json();
        uploadsList.innerHTML = '';
        const total = Number(j.total || 0);
        const maxPages = Math.max(1, Math.ceil(total / (j.pageSize || pageSize)));
        // if requested page is out of range, clamp and reload once
        if ((j.page || currentPage) > maxPages)
        {
            currentPage = maxPages;
            return loadUploadsList();
        }
        if (!j.files || j.files.length === 0)
        {
            if (total === 0)
            {
                uploadsList.textContent = 'No uploads yet';
                pageInfo.textContent = '0 / 0';
            } else
            {
                uploadsList.textContent = 'No uploads on this page';
                pageInfo.textContent = `${j.page || currentPage} / ${maxPages}`;
            }
            prevPageBtn.disabled = (currentPage <= 1);
            nextPageBtn.disabled = (currentPage >= maxPages);
            return;
        }
        pageInfo.textContent = `${j.page} / ${maxPages}`;
        prevPageBtn.disabled = (j.page <= 1);
        nextPageBtn.disabled = (j.page >= maxPages);
        for (const f of j.files)
        {
            if (f.name === '.thumbs') continue;
            const card = document.createElement('div');
            card.className = 'file-card';
            const img = document.createElement('img');
            const placeholderSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/><text x="50%" y="50%" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111827" dominant-baseline="middle" text-anchor="middle">file</text></svg>`);
            img.src = f.thumb || (f.isImage ? f.url : placeholderSvg);
            img.alt = f.name || '';
            img.loading = 'lazy';
            img.className = 'thumb';
            card.appendChild(img);

            const info = document.createElement('div');
            info.className = 'file-meta';
            const title = document.createElement('div');
            title.className = 'file-title';
            title.textContent = f.name;
            const meta = document.createElement('div');
            meta.className = 'file-submeta';
            meta.textContent = `${formatBytes(f.size)} • ${new Date(f.mtime).toLocaleString()}`;
            info.appendChild(title); info.appendChild(meta);
            card.appendChild(info);

            const actions = document.createElement('div'); actions.className = 'file-actions';
            const dl = document.createElement('a'); dl.href = f.url; dl.target = '_blank'; dl.className = 'btn small'; dl.textContent = 'Download';
            const del = document.createElement('button'); del.textContent = 'Trash'; del.className = 'btn warn';
            del.addEventListener('click', async () =>
            {
                if (!confirm('Move ' + f.name + ' to trash?')) return;
                const resp = await fetch('/uploads/' + encodeURIComponent(f.name), { method: 'DELETE' });
                const body = await resp.json();
                uploadResult.innerHTML = `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(body, null, 2))}</code></pre>`;
                try { highlightAllPre(); } catch (e) { }
                showUndo(f.name);
                try { card.remove(); } catch (e) { }
                addTrashRow(f.name);
                loadUploadsList();
                loadTrashList().then(() => { try { highlightAllPre(); } catch (e) { } }).catch(() => { });
            });
            actions.appendChild(dl); actions.appendChild(del);
            card.appendChild(actions);
            uploadsList.appendChild(card);
        }
        try { highlightAllPre(); } catch (e) { }
    } catch (e) { uploadsList.textContent = 'Error loading list'; }
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// initial load
// Run earlier on DOMContentLoaded so we dedent before Prism's highlight runs
document.addEventListener('DOMContentLoaded', () =>
{
    try { dedentAllPre(); } catch (e) { }
    try { highlightAllPre(); } catch (e) { }
    try { loadUploadsList(); loadTrashList(); } catch (e) { }
});

// highlight code blocks in the page (basic)
function highlightAllPre()
{
    // Prefer Prism if available - it handles languages robustly and avoids messing HTML
    if (window.Prism && typeof Prism.highlightAll === 'function')
    {
        try { Prism.highlightAll(); } catch (e) { }
        document.querySelectorAll('pre.code').forEach(p => p.dataset.miniExpressHighlighted = '1');
        return;
    }
    // Fallback: don't inject spans — only escape and wrap in <code>
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

// Remove common leading indentation from code blocks inserted in HTML
function dedentAllPre()
{
    document.querySelectorAll('pre').forEach(pre =>
    {
        try
        {
            // only process if not already dedented
            if (pre.dataset.miniExpressDedented) return;
            const txt = pre.textContent || '';
            const lines = txt.replace(/\r/g, '').split('\n');
            // trim leading/trailing blank lines
            while (lines.length && lines[0].trim() === '') lines.shift();
            while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
            if (!lines.length) { pre.dataset.miniExpressDedented = '1'; return; }
            // compute minimum indent (in spaces) across non-empty lines
            const indents = lines.filter(l => l.trim()).map(l =>
            {
                const match = l.match(/^[\t ]*/)[0] || '';
                // convert tabs to 4 spaces for measurement
                return match.replace(/\t/g, '    ').length;
            });
            const minIndent = indents.length ? Math.min(...indents) : 0;
            if (minIndent > 0)
            {
                const dedented = lines.map(l =>
                {
                    // remove up to minIndent characters from left (treat tabs as 4)
                    let s = l.replace(/\t/g, '    ');
                    return s.slice(Math.min(minIndent, s.length));
                }).join('\n');
                // set the raw text content so Prism or fallback sees dedented content
                pre.textContent = dedented;
            }
            pre.dataset.miniExpressDedented = '1';
        } catch (e) { }
    });
}
