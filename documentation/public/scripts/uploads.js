/**
 * uploads.js
 * Upload form handling, file list with pagination, trash management, undo,
 * and the combined uploads+trash JSON view.
 *
 * Depends on: helpers.js (provides $, on, escapeHtml, formatBytes,
 *             showJsonResult, highlightAllPre)
 */

/* -- Pagination State -------------------------------------------------------- */

let currentPage  = 1;
let currentSort  = 'mtime';
let currentOrder = 'desc';
const pageSize   = 4;

/* -- Combined Uploads + Trash JSON ------------------------------------------- */

/**
 * Fetch the combined uploads + trash listing and render it as JSON into the
 * `#uploadResult` container.
 */
async function loadUploadsCombined()
{
    try
    {
        const r = await fetch('/uploads-all', { cache: 'no-store' });
        const j = await r.json();
        showJsonResult($('#uploadResult'), j);
    } catch (e) { }
}

/* -- Convenience: DELETE + Show Result --------------------------------------- */

/**
 * Issue a DELETE request and display the JSON response.
 * @param {string}       path      - Request path.
 * @param {Element|null} container - Output element (defaults to `#uploadResult`).
 */
async function deleteAndShow(path, container)
{
    container = container || $('#uploadResult');
    const r = await fetch(path, { method: 'DELETE' });
    let j;
    try { j = await r.json(); } catch (e) { container.textContent = 'Error parsing response'; return; }
    try { await loadUploadsCombined(); } catch (e) { showJsonResult(container, j); }
}

/* -- Trash Row Factory ------------------------------------------------------- */

/**
 * Build a trash-row DOM node with Restore and Delete Permanently buttons.
 * @param {string} name - Filename in trash.
 * @returns {HTMLElement}
 */
function createTrashRow(name)
{
    const row = document.createElement('div');
    row.className = 'fileRow trash';

    const nameDiv = document.createElement('div');
    nameDiv.innerHTML = `<div>${escapeHtml(name)}</div>`;

    const restore = document.createElement('button');
    restore.textContent = 'Restore';
    restore.className = 'btn';
    restore.addEventListener('click', async () =>
    {
        await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
        try { row.remove(); } catch (e) { }
        try { await loadUploadsCombined(); } catch (e) { }
        loadUploadsList();
        loadTrashList();
    });

    const del = document.createElement('button');
    del.textContent = 'Delete Permanently';
    del.className = 'btn warn';
    del.addEventListener('click', async () =>
    {
        if (!confirm('Permanently delete ' + name + '?')) return;
        await fetch('/uploads-trash/' + encodeURIComponent(name), { method: 'DELETE' });
        try { row.remove(); } catch (e) { }
        loadTrashList();
    });

    row.appendChild(nameDiv);
    row.appendChild(restore);
    row.appendChild(del);
    return row;
}

/* -- Trash List -------------------------------------------------------------- */

/**
 * Fetch the trash listing from the server and render rows into `#trashList`.
 */
async function loadTrashList()
{
    try
    {
        const r = await fetch('/uploads-trash-list', { cache: 'no-store' });
        const j = await r.json();
        const trashList = $('#trashList');
        if (trashList) trashList.innerHTML = '';
        try { await loadUploadsCombined(); } catch (e) { showJsonResult($('#uploadResult'), j); }
        for (const f of j.files) trashList.appendChild(createTrashRow(f.name));
    } catch (e)
    {
        const trashList = $('#trashList');
        if (trashList) trashList.textContent = 'Error loading trash';
    }
}

/**
 * Optimistically insert a single row into the trash list without a full reload.
 * @param {string} name - Filename that was just trashed.
 */
function addTrashRow(name)
{
    const trashList = $('#trashList');
    if (!trashList) return;
    const row = createTrashRow(name);
    if (trashList.firstChild) trashList.insertBefore(row, trashList.firstChild);
    else trashList.appendChild(row);
}

/* -- Undo Toast -------------------------------------------------------------- */

/**
 * Display a transient undo panel when a file is moved to trash.
 * @param {string} name - Trashed filename.
 */
function showUndo(name)
{
    /* Remove any existing undo toast first */
    const prev = document.querySelector('.undo-toast');
    if (prev) prev.remove();

    const box = document.createElement('div');
    box.className = 'undo-toast';
    box.textContent = `Trashed ${name} \u2014 `;

    const btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.className = 'btn';
    box.appendChild(btn);

    const close = document.createElement('button');
    close.className = 'undo-toast-close';
    close.innerHTML = '&times;';
    close.setAttribute('aria-label', 'Dismiss');
    box.appendChild(close);

    document.body.appendChild(box);

    const dismiss = () => { clearTimeout(tid); box.remove(); document.removeEventListener('click', outsideClick); };

    const tid = setTimeout(dismiss, 8000);

    close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });

    /* Click outside to dismiss */
    function outsideClick(e) { if (!box.contains(e.target)) dismiss(); }
    /* Delay listener so the current click doesn't immediately close it */
    setTimeout(() => document.addEventListener('click', outsideClick), 0);

    btn.addEventListener('click', async (e) =>
    {
        e.stopPropagation();
        dismiss();
        await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
        try { await loadUploadsCombined(); } catch (e) { }
        loadUploadsList();
        loadTrashList();
    });
}

/* -- Upload Card Factory ----------------------------------------------------- */

/** Inline SVG placeholder for non-image files. */
const PLACEHOLDER_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' +
    '<rect width="100%" height="100%" fill="#eef2ff" rx="8" ry="8"/>' +
    '<text x="50%" y="50%" font-family="Arial,Helvetica,sans-serif" font-size="12" ' +
    'fill="#111827" dominant-baseline="middle" text-anchor="middle">file</text></svg>'
);

/**
 * Build a file-card DOM node for a single uploaded file.
 * @param {Object}  f            - File descriptor from the server.
 * @param {Element} uploadResult - Container for JSON feedback.
 * @returns {HTMLElement}
 */
function createUploadCard(f, uploadResult)
{
    const card = document.createElement('div');
    card.className = 'file-card';

    /* Thumbnail / image preview */
    const img = document.createElement('img');
    img.src = f.thumb || (f.isImage ? f.url : PLACEHOLDER_SVG);
    img.alt = f.name || '';
    img.loading = 'lazy';
    img.className = 'thumb';
    card.appendChild(img);

    /* File metadata */
    const info = document.createElement('div');
    info.className = 'file-meta';

    const title = document.createElement('div');
    title.className = 'file-title';
    title.textContent = f.name;

    const meta = document.createElement('div');
    meta.className = 'file-submeta';
    meta.textContent = `${formatBytes(f.size)} • ${new Date(f.mtime).toLocaleString()}`;

    info.appendChild(title);
    info.appendChild(meta);
    card.appendChild(info);

    /* Action buttons */
    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const dl = document.createElement('a');
    dl.href = f.url;
    dl.target = '_blank';
    dl.className = 'btn small';
    dl.textContent = 'Download';

    const del = document.createElement('button');
    del.textContent = 'Trash';
    del.className = 'btn warn';
    del.addEventListener('click', async () =>
    {
        if (!confirm('Move ' + f.name + ' to trash?')) return;
        const resp = await fetch('/uploads/' + encodeURIComponent(f.name), { method: 'DELETE' });
        try { await loadUploadsCombined(); } catch (e)
        {
            try { showJsonResult($('#uploadResult'), await resp.json()); }
            catch (err) { $('#uploadResult').textContent = 'Error'; }
        }
        showUndo(f.name);
        try { card.remove(); } catch (e) { }
        addTrashRow(f.name);
        loadUploadsList();
        loadTrashList().catch(() => {});
    });

    actions.appendChild(dl);
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
}

/* -- Paginated Upload List --------------------------------------------------- */

/**
 * Fetch the paginated upload list and render file cards into `#uploadsList`.
 */
async function loadUploadsList()
{
    const uploadsList = $('#uploadsList');
    try
    {
        const url = `/uploads-list?page=${currentPage}&pageSize=${pageSize}` +
            `&sort=${encodeURIComponent(currentSort)}&order=${encodeURIComponent(currentOrder)}`;
        const r = await fetch(url, { cache: 'no-store' });
        const j = await r.json();

        const pageInfo    = $('#pageInfo');
        const prevPageBtn = $('#prevPage');
        const nextPageBtn = $('#nextPage');
        const uploadResult = $('#uploadResult');

        if (uploadsList) uploadsList.innerHTML = '';

        const total    = Number(j.total || 0);
        const maxPages = Math.max(1, Math.ceil(total / (j.pageSize || pageSize)));

        /* Clamp to last page if we overshot */
        if ((j.page || currentPage) > maxPages)
        {
            currentPage = maxPages;
            return loadUploadsList();
        }

        /* Empty state */
        if (!j.files || j.files.length === 0)
        {
            if (total === 0)
            {
                if (uploadsList) uploadsList.textContent = 'No uploads yet';
                if (pageInfo) pageInfo.textContent = '0 / 0';
            }
            else
            {
                if (uploadsList) uploadsList.textContent = 'No uploads on this page';
                if (pageInfo) pageInfo.textContent = `${j.page || currentPage} / ${maxPages}`;
            }
            if (prevPageBtn) prevPageBtn.disabled = (currentPage <= 1);
            if (nextPageBtn) nextPageBtn.disabled = (currentPage >= maxPages);
            return;
        }

        /* Pagination controls */
        if (pageInfo)    pageInfo.textContent   = `${j.page} / ${maxPages}`;
        if (prevPageBtn) prevPageBtn.disabled   = (j.page <= 1);
        if (nextPageBtn) nextPageBtn.disabled   = (j.page >= maxPages);

        /* Render cards */
        for (const f of j.files)
        {
            if (f.name === '.thumbs') continue;
            const card = createUploadCard(f, uploadResult);
            if (uploadsList) uploadsList.appendChild(card);
        }
        try { highlightAllPre(); } catch (e) { }
    } catch (e)
    {
        if (uploadsList) uploadsList.textContent = 'Error loading list';
    }
}

/* -- Wire Upload Form & Bulk Actions ----------------------------------------- */

/**
 * Initialise the upload form (XHR with progress), pagination controls, and
 * bulk delete / empty-trash buttons.  Called once from the DOMContentLoaded
 * handler in app.js.
 */
function initUploads()
{
    /* Upload form */
    on($('#uploadForm'), 'submit', (e) =>
    {
        e.preventDefault();
        try
        {
            const uploadForm     = $('#uploadForm');
            const fileInput      = $('#fileInput');
            const uploadProgress = $('#uploadProgress');
            const uploadResult   = $('#uploadResult');

            const files = (fileInput && fileInput.files) ? fileInput.files : [];
            if (!files || files.length === 0) { uploadResult.textContent = 'No file selected'; return; }

            const fd = new FormData();
            for (const f of files) fd.append('file', f, f.name);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload');

            try { uploadProgress.style.display = 'block'; uploadProgress.value = 0; } catch (e) { }

            const controls = Array.from(uploadForm.querySelectorAll('button, input, select'));
            controls.forEach(c => c.disabled = true);

            if (xhr.upload)
            {
                xhr.upload.onprogress = (ev) =>
                {
                    if (ev.lengthComputable)
                    {
                        try { uploadProgress.value = Math.round((ev.loaded / ev.total) * 100); } catch (e) { }
                    }
                };
            }

            xhr.onload = () =>
            {
                try { uploadProgress.style.display = 'none'; } catch (e) { }
                try { showJsonResult(uploadResult, JSON.parse(xhr.responseText)); }
                catch (err) { uploadResult.textContent = xhr.responseText; }
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
            try { const p = $('#uploadProgress'); if (p) p.style.display = 'none'; } catch (err) { }
            const r = $('#uploadResult'); if (r) r.textContent = 'Upload error';
        }
    });

    /* Bulk delete buttons */
    on($('#delAllBtn'), 'click', async () =>
    {
        if (!confirm('Delete all uploads?')) return;
        const r = await fetch('/uploads', { method: 'DELETE' });
        const j = await r.json();
        try { await loadUploadsCombined(); } catch (e) { showJsonResult($('#uploadResult'), j); }
        loadUploadsList();
    });

    on($('#delKeepBtn'), 'click', async () =>
    {
        if (!confirm('Delete all uploads but keep the first?')) return;
        const r = await fetch('/uploads?keep=1', { method: 'DELETE' });
        const j = await r.json();
        try { await loadUploadsCombined(); } catch (e) { showJsonResult($('#uploadResult'), j); }
        loadUploadsList();
    });

    /* Pagination / sorting controls */
    on($('#sortSelect'), 'change', () => { currentSort = $('#sortSelect').value; currentPage = 1; loadUploadsList(); });
    on($('#sortOrder'),  'change', () => { currentOrder = $('#sortOrder').value;  currentPage = 1; loadUploadsList(); });
    on($('#prevPage'),   'click',  () => { if (currentPage > 1) { currentPage--; loadUploadsList(); } });
    on($('#nextPage'),   'click',  () => { currentPage++; loadUploadsList(); });

    /* Empty trash */
    on($('#emptyTrashBtn'), 'click', async () =>
    {
        if (!confirm('Empty trash? This will permanently delete items.')) return;
        const r = await fetch('/uploads-trash', { method: 'DELETE' });
        const j = await r.json();
        try { await loadUploadsCombined(); } catch (e) { showJsonResult($('#uploadResult'), j); }
        loadTrashList();
    });

    /* File drop / choose area */
    const fileDrop      = $('#fileDrop');
    const fileInput      = $('#fileInput');
    const uploadResult   = $('#uploadResult');
    const fileDropInner  = fileDrop && fileDrop.querySelector('.fileDrop-inner');

    if (fileDrop && fileInput)
    {
        fileDrop.addEventListener('click', (ev) =>
        {
            if (ev.target.tagName === 'INPUT' || ev.target.closest('label')) return;
            fileInput.click();
        });

        fileInput.addEventListener('change', () =>
        {
            const names = fileInput.files && fileInput.files.length
                ? Array.from(fileInput.files).map(f => f.name).join(', ')
                : '';
            if (names)
            {
                if (fileDropInner) fileDropInner.textContent = names;
                if (uploadResult)  uploadResult.textContent  = 'Selected: ' + names;
            }
            else
            {
                if (fileDropInner) fileDropInner.innerHTML = 'Drop files here or <label for="fileInput" class="linkish">choose file</label>';
                if (uploadResult)  uploadResult.textContent = '';
            }
        });
    }

    /* Read initial sort state from DOM */
    const sortOrderEl  = $('#sortOrder');
    const sortSelectEl = $('#sortSelect');
    if (sortOrderEl)  currentOrder = sortOrderEl.value  || currentOrder;
    if (sortSelectEl) currentSort  = sortSelectEl.value || currentSort;

    /* Initial data load */
    loadUploadsList();
    loadTrashList();
    loadUploadsCombined().catch(() => {});
}
