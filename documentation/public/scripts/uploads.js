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
    row.className = 'ufile-card ufile-card-trash';

    /* File type icon */
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'ufile-thumb ufile-thumb-icon';
    const icon = fileTypeIcon(name);
    thumbWrap.innerHTML = icon.svg;
    row.appendChild(thumbWrap);

    /* Info */
    const info = document.createElement('div');
    info.className = 'ufile-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'ufile-name';
    nameEl.textContent = name;
    nameEl.title = name;
    info.appendChild(nameEl);
    row.appendChild(info);

    /* 3-dot menu */
    const menuWrap = document.createElement('div');
    menuWrap.className = 'ufile-menu-wrap';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'ufile-menu-btn';
    menuBtn.setAttribute('aria-label', 'Trash actions');
    menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'ufile-menu';

    const restoreItem = document.createElement('button');
    restoreItem.className = 'ufile-menu-item';
    restoreItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Restore';
    restoreItem.addEventListener('click', async () =>
    {
        menu.classList.remove('open');
        await fetch('/uploads/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
        try { row.remove(); } catch (e) { }
        try { await loadUploadsCombined(); } catch (e) { }
        loadUploadsList();
        loadTrashList();
    });

    const delItem = document.createElement('button');
    delItem.className = 'ufile-menu-item ufile-menu-danger';
    delItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete';
    delItem.addEventListener('click', async () =>
    {
        menu.classList.remove('open');
        if (!confirm('Permanently delete ' + name + '?')) return;
        await fetch('/uploads-trash/' + encodeURIComponent(name), { method: 'DELETE' });
        try { row.remove(); } catch (e) { }
        loadTrashList();
    });

    menu.appendChild(restoreItem);
    menu.appendChild(delItem);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menu);
    row.appendChild(menuWrap);

    /* Toggle menu */
    menuBtn.addEventListener('click', (e) =>
    {
        e.stopPropagation();
        document.querySelectorAll('.ufile-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
        menu.classList.toggle('open');
    });

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

/** File-type icon lookup — returns SVG markup that uses currentColor for theme adaptability. */
function fileTypeIcon(name)
{
    const ext = (name || '').split('.').pop().toLowerCase();
    const iconMap = {
        pdf:  { color: '#ef4444', label: 'PDF' },
        doc:  { color: '#3b82f6', label: 'DOC' },
        docx: { color: '#3b82f6', label: 'DOC' },
        xls:  { color: '#22c55e', label: 'XLS' },
        xlsx: { color: '#22c55e', label: 'XLS' },
        csv:  { color: '#22c55e', label: 'CSV' },
        zip:  { color: '#f59e0b', label: 'ZIP' },
        rar:  { color: '#f59e0b', label: 'RAR' },
        gz:   { color: '#f59e0b', label: 'GZ' },
        mp3:  { color: '#a855f7', label: 'MP3' },
        wav:  { color: '#a855f7', label: 'WAV' },
        mp4:  { color: '#ec4899', label: 'MP4' },
        mov:  { color: '#ec4899', label: 'MOV' },
        txt:  { color: '#64748b', label: 'TXT' },
        json: { color: '#f59e0b', label: 'JSON' },
        js:   { color: '#facc15', label: 'JS' },
        html: { color: '#f97316', label: 'HTML' },
        css:  { color: '#3b82f6', label: 'CSS' },
        svg:  { color: '#f97316', label: 'SVG' },
    };
    const info = iconMap[ext] || { color: '#64748b', label: ext.toUpperCase().slice(0, 4) || 'FILE' };
    return { svg: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="8" y="2" width="32" height="44" rx="4" fill="${info.color}" opacity="0.15"/>` +
        `<path d="M28 2v10h12" fill="none" stroke="${info.color}" stroke-width="1.5" opacity="0.3"/>` +
        `<rect x="8" y="2" width="32" height="44" rx="4" fill="none" stroke="${info.color}" stroke-width="1.5" opacity="0.4"/>` +
        `<text x="24" y="32" font-family="system-ui,sans-serif" font-size="9" font-weight="700" ` +
        `fill="${info.color}" text-anchor="middle">${info.label}</text></svg>`, color: info.color };
}

/**
 * Draw an image thumbnail on a canvas element using the actual image source.
 * @param {string} src - URL of the source image.
 * @returns {HTMLCanvasElement}
 */
function createImageThumb(src)
{
    const canvas = document.createElement('canvas');
    const size = 88; /* 2× for retina, rendered at 44px via CSS */
    canvas.width = size;
    canvas.height = size;
    canvas.className = 'ufile-canvas';
    const ctx = canvas.getContext('2d');

    /* Draw a placeholder background immediately */
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface-border').trim() || 'rgba(128,128,128,0.1)';
    ctx.fillRect(0, 0, size, size);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () =>
    {
        /* Cover-crop: draw the image centered, filling the square */
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
    };
    img.onerror = () =>
    {
        /* Fallback: show a broken-image icon */
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('IMG', size / 2, size / 2 + 4);
    };
    img.src = src;
    return canvas;
}

/**
 * Build a file-card DOM node for a single uploaded file.
 * @param {Object}  f            - File descriptor from the server.
 * @param {Element} uploadResult - Container for JSON feedback.
 * @returns {HTMLElement}
 */
function createUploadCard(f, uploadResult)
{
    const card = document.createElement('div');
    card.className = 'ufile-card';

    /* Thumbnail */
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'ufile-thumb';
    if (f.isImage)
    {
        const canvas = createImageThumb(f.url);
        thumbWrap.appendChild(canvas);
    }
    else
    {
        const icon = fileTypeIcon(f.name);
        thumbWrap.innerHTML = icon.svg;
        thumbWrap.classList.add('ufile-thumb-icon');
    }
    card.appendChild(thumbWrap);

    /* Info block */
    const info = document.createElement('div');
    info.className = 'ufile-info';

    const title = document.createElement('div');
    title.className = 'ufile-name';
    title.textContent = f.name;
    title.title = f.name;

    const meta = document.createElement('div');
    meta.className = 'ufile-meta';
    meta.innerHTML = `<span>${formatBytes(f.size)}</span><span>${new Date(f.mtime).toLocaleDateString()}</span>`;

    info.appendChild(title);
    info.appendChild(meta);
    card.appendChild(info);

    /* Action menu (3-dot) */
    const menuWrap = document.createElement('div');
    menuWrap.className = 'ufile-menu-wrap';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'ufile-menu-btn';
    menuBtn.setAttribute('aria-label', 'File actions');
    menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'ufile-menu';

    const dlItem = document.createElement('a');
    dlItem.href = f.url;
    dlItem.target = '_blank';
    dlItem.className = 'ufile-menu-item';
    dlItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download';

    const trashItem = document.createElement('button');
    trashItem.className = 'ufile-menu-item ufile-menu-danger';
    trashItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Trash';
    trashItem.addEventListener('click', async () =>
    {
        menu.classList.remove('open');
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

    menu.appendChild(dlItem);
    menu.appendChild(trashItem);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menu);
    card.appendChild(menuWrap);

    /* Toggle menu */
    menuBtn.addEventListener('click', (e) =>
    {
        e.stopPropagation();
        /* Close other open menus */
        document.querySelectorAll('.ufile-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
        menu.classList.toggle('open');
    });

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

            try { uploadProgress.value = 0; uploadProgress.classList.add('uploading'); } catch (e) { }

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
                try { uploadProgress.value = 100; setTimeout(() => { uploadProgress.value = 0; uploadProgress.classList.remove('uploading'); }, 600); } catch (e) { }
                try { showJsonResult(uploadResult, JSON.parse(xhr.responseText)); }
                catch (err) { uploadResult.textContent = xhr.responseText; }
                controls.forEach(c => c.disabled = false);
                /* Auto-open the response accordion */
                const acc = $('#uploadResponseAcc');
                if (acc) acc.open = true;
                loadUploadsList();
                loadTrashList();
            };

            xhr.onerror = () =>
            {
                try { uploadProgress.value = 0; uploadProgress.classList.remove('uploading'); } catch (e) { }
                uploadResult.textContent = 'Upload failed';
                controls.forEach(c => c.disabled = false);
            };

            xhr.send(fd);
        } catch (e)
        {
            try { const p = $('#uploadProgress'); if (p) { p.value = 0; p.classList.remove('uploading'); } } catch (err) { }
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
    const zoneText       = fileDrop && fileDrop.querySelector('.upload-zone-text');

    if (fileDrop && fileInput)
    {
        fileDrop.addEventListener('click', (ev) =>
        {
            if (ev.target.tagName === 'INPUT' || ev.target.closest('label')) return;
            fileInput.click();
        });

        /* Drag-and-drop support */
        fileDrop.addEventListener('dragover', (ev) =>
        {
            ev.preventDefault();
            ev.stopPropagation();
            fileDrop.classList.add('drag-over');
        });

        fileDrop.addEventListener('dragenter', (ev) =>
        {
            ev.preventDefault();
            ev.stopPropagation();
            fileDrop.classList.add('drag-over');
        });

        fileDrop.addEventListener('dragleave', (ev) =>
        {
            ev.preventDefault();
            ev.stopPropagation();
            fileDrop.classList.remove('drag-over');
        });

        fileDrop.addEventListener('drop', (ev) =>
        {
            ev.preventDefault();
            ev.stopPropagation();
            fileDrop.classList.remove('drag-over');

            if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length)
            {
                fileInput.files = ev.dataTransfer.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        fileInput.addEventListener('change', () =>
        {
            const names = fileInput.files && fileInput.files.length
                ? Array.from(fileInput.files).map(f => f.name).join(', ')
                : '';
            if (names)
            {
                if (zoneText)
                {
                    zoneText.innerHTML = '<span class="upload-zone-primary">' + escapeHtml(names) + '</span>' +
                        '<span class="upload-zone-hint">Ready to upload</span>';
                }
            }
            else
            {
                if (zoneText)
                {
                    zoneText.innerHTML = '<span class="upload-zone-primary">Drop files here or <label for="fileInput" class="upload-zone-link">browse</label></span>' +
                        '<span class="upload-zone-hint">Supports any file type</span>';
                }
            }
        });
    }

    /* Read initial sort state from DOM */
    const sortOrderEl  = $('#sortOrder');
    const sortSelectEl = $('#sortSelect');
    if (sortOrderEl)  currentOrder = sortOrderEl.value  || currentOrder;
    if (sortSelectEl) currentSort  = sortSelectEl.value || currentSort;

    /* Close file action menus when clicking outside */
    document.addEventListener('click', () =>
    {
        document.querySelectorAll('.ufile-menu.open').forEach(m => m.classList.remove('open'));
    });

    /* Initial data load */
    loadUploadsList();
    loadTrashList();
    loadUploadsCombined().catch(() => {});
}
