/*
 * Top-level state (no DOM queries at module scope to keep the example lean)
 */
let currentPage = 1;
let currentSort = 'mtime';
let currentOrder = 'desc';
const pageSize = 4;

/*
 * DOM helpers
 * - `$` / `$$` are lightweight selectors for single/multiple elements
 */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from((ctx || document).querySelectorAll(sel));

/*
 * JSON rendering helpers
 * - `jsonHtml` returns a safe HTML string for pretty JSON
 * - `showJsonResult` places JSON into a container and triggers highlighting
 */
const jsonHtml = (obj) => `<pre class="code language-json"><code>${escapeHtml(JSON.stringify(obj, null, 2))}</code></pre>`;
function showJsonResult(container, obj) { if (!container) return; container.innerHTML = jsonHtml(obj); try { highlightAllPre(); } catch (e) { } }

/*
 * Convenience wrapper for DELETE + show JSON
 */
async function deleteAndShow(path, container)
{
    container = container || $('#uploadResult');
    const r = await fetch(path, { method: 'DELETE' });
    let j;
    try { j = await r.json(); } catch (e) { container.textContent = 'Error parsing response'; return; }
    showJsonResult(container, j);
}


function on(el, evt, cb) { if (!el) return; el.addEventListener(evt, cb); }

on($('#uploadForm'), 'submit', (e) =>
{
    e.preventDefault();
    try
    {
        const uploadForm = $('#uploadForm');
        const fileInput = $('#fileInput');
        const uploadProgress = $('#uploadProgress');
        const uploadResult = $('#uploadResult');

        const files = (fileInput && fileInput.files) ? fileInput.files : [];
        if (!files || files.length === 0) { uploadResult.textContent = 'No file selected'; return; }

        const fd = new FormData();
        for (const f of files) fd.append('file', f, f.name);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload');

        try { uploadProgress.style.display = 'block'; uploadProgress.value = 0; } catch (e) { }

        const controls = Array.from(uploadForm.querySelectorAll('button, input, select'));
        controls.forEach(c => c.disabled = true);

        xhr.upload && (xhr.upload.onprogress = (ev) =>
        {
            if (ev.lengthComputable)
            {
                try { uploadProgress.value = Math.round((ev.loaded / ev.total) * 100); } catch (e) { }
            }
        });

        xhr.onload = () =>
        {
            try { uploadProgress.style.display = 'none'; } catch (e) { }
            try
            {
                const j = JSON.parse(xhr.responseText);
                showJsonResult(uploadResult, j);
            } catch (err)
            {
                uploadResult.textContent = xhr.responseText;
            }
            controls.forEach(c => c.disabled = false);

            loadUploadsList();
        };

        xhr.onerror = () =>
        {
            try { uploadProgress.style.display = 'none'; } catch (e) { }
            uploadResult.textContent = 'Upload failed';
            controls.forEach(c => c.disabled = false);
        };

        xhr.send(fd);
    } catch (e)
    {
        try { $('#uploadProgress') && ($('#uploadProgress').style.display = 'none'); } catch (err) { }
        $('#uploadResult') && ($('#uploadResult').textContent = 'Upload error');
    }
});

on($('#delAllBtn'), 'click', async () =>
{
    if (!confirm('Delete all uploads?')) return;
    const r = await fetch('/uploads', { method: 'DELETE' });
    const j = await r.json();
    showJsonResult($('#uploadResult'), j);
    loadUploadsList();
});

on($('#delKeepBtn'), 'click', async () =>
{
    if (!confirm('Delete all uploads but keep the first?')) return;
    const r = await fetch('/uploads?keep=1', { method: 'DELETE' });
    const j = await r.json();
    showJsonResult($('#uploadResult'), j);
    loadUploadsList();
});

// pagination / sorting handlers (use $()/on() to avoid top-level DOM refs)
on($('#sortSelect'), 'change', () => { currentSort = $('#sortSelect').value; currentPage = 1; loadUploadsList(); });
if ($('#sortOrder')) on($('#sortOrder'), 'change', () => { currentOrder = $('#sortOrder').value; currentPage = 1; loadUploadsList(); });
on($('#prevPage'), 'click', () => { if (currentPage > 1) { currentPage--; loadUploadsList(); } });
on($('#nextPage'), 'click', () => { currentPage++; loadUploadsList(); });

/**
 * loadTrashList()
 * Fetch the trash list and render rows. Uses `createTrashRow` for each file.
 */
async function loadTrashList()
{
    try
    {
        const r = await fetch('/uploads-trash-list', { cache: 'no-store' });
        const j = await r.json();
        const trashList = $('#trashList');
        const uploadResult = $('#uploadResult');
        trashList && (trashList.innerHTML = '');
        showJsonResult(uploadResult, j);
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

on($('#emptyTrashBtn'), 'click', async () =>
{
    if (!confirm('Empty trash? This will permanently delete items.')) return;
    const r = await fetch('/uploads-trash', { method: 'DELETE' });
    const j = await r.json();
    showJsonResult($('#uploadResult'), j);
    loadTrashList();
});

/**
 * showUndo(name)
 * Display a transient undo panel when a file is trashed.
 */
function showUndo(name)
{
    const box = document.createElement('div');
    box.className = 'panel';
    box.textContent = `Trashed ${name} — `;
    const btn = document.createElement('button'); btn.textContent = 'Undo'; btn.className = 'btn';
    box.appendChild(btn);
    try { const container = document.querySelector('.ui-shell') || document.querySelector('body'); container && container.prepend(box); } catch (e) { }
    const tid = setTimeout(() => box.remove(), 8000);
    btn.addEventListener('click', async () => { clearTimeout(tid); await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' }); box.remove(); loadUploadsList(); loadTrashList(); });
}

/**
 * addTrashRow(name)
 * Insert a single row into the trash list for optimistic UI updates.
 */
function addTrashRow(name)
{
    try
    {
        const trashList = $('#trashList');
        if (!trashList) return;
        const row = document.createElement('div'); row.className = 'fileRow trash';
        const nameDiv = document.createElement('div'); nameDiv.innerHTML = `<div>${escapeHtml(name)}</div>`;
        const restore = document.createElement('button'); restore.textContent = 'Restore'; restore.className = 'btn';
        restore.addEventListener('click', async () =>
        {
            await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
            try { row.remove(); } catch (e) { }
            loadUploadsList();
        });
        const del = document.createElement('button'); del.textContent = 'Delete Permanently'; del.className = 'btn warn';
        del.addEventListener('click', async () => { if (!confirm('Permanently delete ' + name + '?')) return; await fetch('/uploads-trash/' + encodeURIComponent(name), { method: 'DELETE' }); try { row.remove(); } catch (e) { } });
        row.appendChild(nameDiv); row.appendChild(restore); row.appendChild(del);
        if (trashList.firstChild) trashList.insertBefore(row, trashList.firstChild); else trashList.appendChild(row);
    } catch (e) { }
}

/**
 * formatBytes(n)
 * Human-readable byte formatter used in file metadata.
 */
function formatBytes(n) { if (n === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(n) / Math.log(k)); return (n / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + sizes[i]; }

on($('#jsonPlay'), 'submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const raw = f.json.value || '';
    const playResult = $('#playResult');
    try { JSON.parse(raw); } catch (err) { playResult.innerHTML = `<pre class="code"><code>${escapeHtml('Invalid JSON: ' + err.message)}</code></pre>`; return; }
    const r = await fetch('/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
    const j = await r.json(); showJsonResult(playResult, j);
});

on($('#urlPlay'), 'submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const body = f.url.value || '';
    const playResult = $('#playResult');
    const r = await fetch('/echo-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    const j = await r.json(); showJsonResult(playResult, j);
});

on($('#textPlay'), 'submit', async (e) =>
{
    e.preventDefault(); const f = e.target; const txt = f.txt.value || '';
    const playResult = $('#playResult');
    const r = await fetch('/echo-text', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txt });
    const j = await r.text(); playResult.innerHTML = `<pre class="code"><code>${escapeHtml(j)}</code></pre>`;
    try { highlightAllPre(); } catch (e) { }
});

const proxyForm = $('#proxyForm');
const proxyResult = $('#proxyResult');
if (proxyForm)
{
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
            if (r.status >= 400)
            {
                const j = await r.json(); showJsonResult(proxyResult, j);
                return;
            }
            const ct = (r.headers && (typeof r.headers.get === 'function')) ? (r.headers.get('content-type') || '') : '';
            if (ct.includes('application/json') || ct.includes('application/problem+json'))
            {
                const j = await r.json();
                showJsonResult(proxyResult, j);
            }
            else if (ct.startsWith('image/'))
            {
                const ab = await r.arrayBuffer();
                const blob = new Blob([ab], { type: ct });
                const urlObj = URL.createObjectURL(blob);
                proxyResult.innerHTML = `<div style="display:flex;align-items:center;gap:12px"><img src="${urlObj}" style="max-width:240px;max-height:240px;border-radius:8px"/><div class="mono" style="max-width:480px;overflow:auto">${escapeHtml('Image received: ' + ct)}</div></div>`;
            }
            else if (ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/octet-stream' || ct.includes('wav') || ct.includes('wave'))
            {
                const proxiedUrl = '/proxy?url=' + encodeURIComponent(url);
                let mediaHtml = '';
                if (ct.startsWith('audio/')) mediaHtml = `<audio controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></audio>`;
                else if (ct.startsWith('video/')) mediaHtml = `<video controls src="${proxiedUrl}" style="max-width:480px;display:block;margin-bottom:8px"></video>`;
                const info = `<div class="mono">${escapeHtml('Streaming: ' + ct)}</div>`;
                proxyResult.innerHTML = `<div>${mediaHtml}${info}</div>`;
            }
            else if (ct.startsWith('text/') || ct === '')
            {
                const txt = await r.text();
                proxyResult.innerHTML = `<pre class="code"><code>${escapeHtml(txt)}</code></pre>`;
                try { highlightAllPre(); } catch (e) { }
            }
            else
            {
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
        const uploadsList = $('#uploadsList');
        const pageInfo = $('#pageInfo');
        const prevPageBtn = $('#prevPage');
        const nextPageBtn = $('#nextPage');
        const uploadResult = $('#uploadResult');
        uploadsList && (uploadsList.innerHTML = '');
        const total = Number(j.total || 0);
        const maxPages = Math.max(1, Math.ceil(total / (j.pageSize || pageSize)));
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
                pageInfo && (pageInfo.textContent = '0 / 0');
            } else
            {
                uploadsList.textContent = 'No uploads on this page';
                pageInfo && (pageInfo.textContent = `${j.page || currentPage} / ${maxPages}`);
            }
            prevPageBtn && (prevPageBtn.disabled = (currentPage <= 1));
            nextPageBtn && (nextPageBtn.disabled = (currentPage >= maxPages));
            return;
        }
        pageInfo && (pageInfo.textContent = `${j.page} / ${maxPages}`);
        prevPageBtn && (prevPageBtn.disabled = (j.page <= 1));
        nextPageBtn && (nextPageBtn.disabled = (j.page >= maxPages));
        for (const f of j.files)
        {
            if (f.name === '.thumbs') continue;
            const card = createUploadCard(f, uploadResult);
            uploadsList && uploadsList.appendChild(card);
        }
        try { highlightAllPre(); } catch (e) { }
    } catch (e) { uploadsList.textContent = 'Error loading list'; }
}

/**
 * createUploadCard(file, uploadResult)
 * Returns a DOM node representing a single upload file card and wires actions.
 */
function createUploadCard(f, uploadResult)
{
    const card = document.createElement('div'); card.className = 'file-card';
    const img = document.createElement('img');
    const placeholderSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/><text x="50%" y="50%" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#111827" dominant-baseline="middle" text-anchor="middle">file</text></svg>`);
    img.src = f.thumb || (f.isImage ? f.url : placeholderSvg);
    img.alt = f.name || '';
    img.loading = 'lazy'; img.className = 'thumb'; card.appendChild(img);

    const info = document.createElement('div'); info.className = 'file-meta';
    const title = document.createElement('div'); title.className = 'file-title'; title.textContent = f.name;
    const meta = document.createElement('div'); meta.className = 'file-submeta'; meta.textContent = `${formatBytes(f.size)} • ${new Date(f.mtime).toLocaleString()}`;
    info.appendChild(title); info.appendChild(meta); card.appendChild(info);

    const actions = document.createElement('div'); actions.className = 'file-actions';
    const dl = document.createElement('a'); dl.href = f.url; dl.target = '_blank'; dl.className = 'btn small'; dl.textContent = 'Download';
    const del = document.createElement('button'); del.textContent = 'Trash'; del.className = 'btn warn';
    del.addEventListener('click', async () =>
    {
        if (!confirm('Move ' + f.name + ' to trash?')) return;
        const resp = await fetch('/uploads/' + encodeURIComponent(f.name), { method: 'DELETE' });
        const body = await resp.json();
        showJsonResult($('#uploadResult'), body);
        showUndo(f.name);
        try { card.remove(); } catch (e) { }
        addTrashRow(f.name);
        loadUploadsList();
        loadTrashList().catch(() => { });
    });
    actions.appendChild(dl); actions.appendChild(del); card.appendChild(actions);
    return card;
}

/**
 * escapeHtml(s)
 * Minimal HTML escaper used for safe insertion into `<pre>` blocks.
 */
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// initial load
document.addEventListener('DOMContentLoaded', () =>
{
    try { dedentAllPre(); } catch (e) { }
    try { highlightAllPre(); } catch (e) { }
    try
    {
        const sortOrderEl = $('#sortOrder');
        const sortSelectEl = $('#sortSelect');
        if (sortOrderEl) currentOrder = sortOrderEl.value || currentOrder;
        if (sortSelectEl) currentSort = sortSelectEl.value || currentSort;
        loadUploadsList(); loadTrashList();
    } catch (e) { }
    try
    {
        document.querySelectorAll('details.acc summary').forEach(summary =>
        {
            if (summary.dataset.miniExpressSummary === '1') return;
            summary.dataset.miniExpressSummary = '1';
            summary.addEventListener('click', (ev) =>
            {
                ev.preventDefault();
                const details = summary.parentElement;
                if (!details) return;
                details.open = !details.open;
            });
        });
    } catch (e) { }
    // wire file drop / choose area to the hidden file input and show selection
    try
    {
        const fileDrop = $('#fileDrop');
        const fileInput = $('#fileInput');
        const uploadResult = $('#uploadResult');
        const fileDropInner = fileDrop && fileDrop.querySelector('.fileDrop-inner');
        if (fileDrop && fileInput)
        {
            fileDrop.addEventListener('click', (ev) =>
            {
                if (ev.target.tagName === 'INPUT' || ev.target.closest('label')) return;
                fileInput.click();
            });
            fileInput.addEventListener('change', () =>
            {
                const files = fileInput.files && fileInput.files.length ? Array.from(fileInput.files).map(f => f.name).join(', ') : '';
                if (files)
                {
                    try { if (fileDropInner) fileDropInner.textContent = files; } catch (e) { }
                    try { if (uploadResult) uploadResult.textContent = 'Selected: ' + files; } catch (e) { }
                } else
                {
                    try { if (fileDropInner) fileDropInner.innerHTML = 'Drop files here or <label for="fileInput" class="linkish">choose file</label>'; } catch (e) { }
                    try { if (uploadResult) uploadResult.textContent = ''; } catch (e) { }
                }
            });
        }
    } catch (e) { }
});

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
                    let s = l.replace(/\t/g, '    ');
                    return s.slice(Math.min(minIndent, s.length));
                }).join('\n');
                pre.textContent = dedented;
            }
            pre.dataset.miniExpressDedented = '1';
        } catch (e) { }
    });
}
