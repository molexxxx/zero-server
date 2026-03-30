/**
 * playground.js
 * Echo playground forms — JSON, URL-encoded, and plain-text body parsers.
 * WebSocket chat client and SSE event viewer.
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
            if (window.innerWidth <= 640) playResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        if (window.innerWidth <= 640) playResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    /* --- WebSocket Chat --- */
    initWsChat();

    /* --- SSE Viewer --- */
    initSseViewer();

    /* --- ORM CRUD --- */
    initOrmPlayground();

    /* --- Blog Explorer --- */
    initBlogExplorer();

    /* --- Cookie Explorer --- */
    initCookieExplorer();
}

/* ------------------------------------------------------------------ */
/*  WebSocket Chat                                                     */
/* ------------------------------------------------------------------ */
function initWsChat()
{
    let ws = null;
    const connectBtn = $('#wsConnectBtn');
    const disconnectBtn = $('#wsDisconnectBtn');
    const nameInput = $('#wsName');
    const msgInput = $('#wsMsgInput');
    const sendBtn = $('#wsSendBtn');
    const messages = $('#wsMessages');

    if (!connectBtn) return; // guard if elements not in DOM

    function appendMsg(html)
    {
        const div = document.createElement('div');
        div.innerHTML = html;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function setConnected(connected)
    {
        connectBtn.disabled = connected;
        disconnectBtn.disabled = !connected;
        msgInput.disabled = !connected;
        sendBtn.disabled = !connected;
        nameInput.disabled = connected;
    }

    on(connectBtn, 'click', () =>
    {
        const name = encodeURIComponent(nameInput.value || 'anon');
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = location.port ? location.host : location.hostname + ':7273';
        ws = new WebSocket(`${proto}//${wsHost}/ws/chat?name=${name}`);

        ws.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span class="pg-success">● Connected</span>');
        };

        ws.onmessage = (e) =>
        {
            try
            {
                const msg = JSON.parse(e.data);
                if (msg.type === 'system')
                {
                    appendMsg(`<span class="pg-muted">» ${escapeHtml(msg.text)}</span>`);
                } else
                {
                    appendMsg(`<strong>${escapeHtml(msg.name)}</strong>: ${escapeHtml(msg.text)}`);
                }
            } catch (_)
            {
                appendMsg(escapeHtml(e.data));
            }
        };

        ws.onclose = () =>
        {
            setConnected(false);
            appendMsg('<span class="pg-danger">● Disconnected</span>');
            ws = null;
        };

        ws.onerror = () =>
        {
            appendMsg('<span class="pg-danger">● Connection error</span>');
        };
    });

    on(disconnectBtn, 'click', () =>
    {
        if (ws) ws.close();
    });

    on(sendBtn, 'click', () =>
    {
        if (ws && ws.readyState === WebSocket.OPEN && msgInput.value.trim())
        {
            ws.send(msgInput.value.trim());
            msgInput.value = '';
        }
    });

    on(msgInput, 'keydown', (e) =>
    {
        if (e.key === 'Enter')
        {
            e.preventDefault();
            sendBtn.click();
        }
    });
}

/* ------------------------------------------------------------------ */
/*  SSE Event Viewer                                                   */
/* ------------------------------------------------------------------ */
function initSseViewer()
{
    let es = null;
    const connectBtn = $('#sseConnectBtn');
    const disconnectBtn = $('#sseDisconnectBtn');
    const status = $('#sseStatus');
    const messages = $('#sseMessages');
    const broadcastBtn = $('#sseBroadcastBtn');
    const broadcastInput = $('#sseBroadcastInput');

    if (!connectBtn) return; // guard

    function appendMsg(html)
    {
        const div = document.createElement('div');
        div.innerHTML = html;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function setConnected(connected)
    {
        connectBtn.disabled = connected;
        disconnectBtn.disabled = !connected;
        status.textContent = connected ? 'Connected' : 'Disconnected';
        status.style.color = connected ? 'var(--success)' : '';
    }

    on(connectBtn, 'click', () =>
    {
        es = new EventSource('/sse/events');

        es.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span class="pg-success">● SSE connected</span>');
        };

        es.onmessage = (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span class="pg-muted">[${ts}]</span> ${escapeHtml(e.data)}`);
        };

        es.addEventListener('broadcast', (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span class="pg-accent">[${ts} broadcast]</span> ${escapeHtml(e.data)}`);
        });

        es.onerror = () =>
        {
            if (es.readyState === EventSource.CLOSED)
            {
                setConnected(false);
                appendMsg('<span class="pg-danger">● SSE closed</span>');
                es = null;
            } else
            {
                appendMsg('<span class="pg-warn">● SSE reconnecting…</span>');
            }
        };
    });

    on(disconnectBtn, 'click', () =>
    {
        if (es) { es.close(); es = null; }
        setConnected(false);
        appendMsg('<span class="pg-danger">● Disconnected</span>');
    });

    on(broadcastBtn, 'click', async () =>
    {
        const raw = broadcastInput.value || '{}';
        let body;
        try { body = JSON.parse(raw); }
        catch (err)
        {
            appendMsg(`<span style="color:#f66">Invalid JSON: ${escapeHtml(err.message)}</span>`);
            return;
        }

        const r = await fetch('/sse/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const j = await r.json();
        appendMsg(`<span style="color:#aaa">» Broadcast sent to ${j.sent} client(s)</span>`);
    });
}

/* ------------------------------------------------------------------ */
/*  ORM Task Manager Playground                                        */
/* ------------------------------------------------------------------ */
function initOrmPlayground()
{
    const form      = $('#taskForm');
    const titleIn   = $('#taskTitle');
    const statusIn  = $('#taskStatus');
    const priorityIn = $('#taskPriority');
    const searchIn  = $('#taskSearch');
    const scopeIn   = $('#taskScope');
    const delAllBtn = $('#taskDeleteAll');
    const listEl    = $('#taskList');
    const resultEl  = $('#taskResult');
    const statsEl   = $('#ormStats');

    if (!form) return;

    let editingId = null;

    /* ---- helpers ---- */
    function statusBadge(s)
    {
        const colors = { pending: '#fa0', 'in-progress': '#5865f2', done: '#2ecc71' };
        return `<span style="padding:2px 8px;border-radius:4px;font-size:12px;background:${colors[s] || '#555'};color:#fff">${escapeHtml(s)}</span>`;
    }

    function priorityStars(n)
    {
        return '<span style="color:#fa0">' + '★'.repeat(n) + '</span>' + '<span style="color:#333">' + '☆'.repeat(5 - n) + '</span>';
    }

    async function loadStats()
    {
        try
        {
            const r = await fetch('/api/tasks/stats');
            const s = await r.json();
            statsEl.innerHTML =
                `<div class="orm-stat-grid">` +
                `<div class="orm-stat"><span class="orm-stat-val">${s.total}</span><span class="orm-stat-label">Total</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#fa0">${s.pending}</span><span class="orm-stat-label">Pending</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#5865f2">${s.inProgress}</span><span class="orm-stat-label">In-progress</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#2ecc71">${s.done}</span><span class="orm-stat-label">Done</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val">${Number(s.avgPriority).toFixed(1)}</span><span class="orm-stat-label">Avg Priority</span></div>` +
                `</div>`;
        } catch (e) { }
    }

    async function loadTasks()
    {
        try
        {
            const params = new URLSearchParams();
            if (searchIn.value.trim()) params.set('search', searchIn.value.trim());
            if (scopeIn.value) params.set('scope', scopeIn.value);
            params.set('sort', 'createdAt');
            params.set('order', 'desc');

            const r = await fetch('/api/tasks?' + params);
            const data = await r.json();
            showJsonResult(resultEl, data);

            if (!data.tasks || !data.tasks.length)
            {
                listEl.innerHTML = '<div style="padding:12px;color:#98a0aa">No tasks yet — add one above.</div>';
                loadStats();
                return;
            }

            listEl.innerHTML = data.tasks.map(t =>
                `<div class="task-row" data-id="${t.id}">` +
                    `<div class="task-info">` +
                        `<strong>${escapeHtml(t.title)}</strong> ` +
                        statusBadge(t.status) + ' ' + priorityStars(t.priority) +
                        `<div class="small muted">ID ${t.id} · ${new Date(t.createdAt).toLocaleString()}</div>` +
                    `</div>` +
                    `<div class="task-actions">` +
                        `<button class="btn small task-edit-btn" data-id="${t.id}">Edit</button>` +
                        `<button class="btn small task-cycle-btn" data-id="${t.id}" data-status="${t.status}" title="Cycle status">↻</button>` +
                        `<button class="btn small warn task-del-btn" data-id="${t.id}">Delete</button>` +
                    `</div>` +
                `</div>`
            ).join('');

            loadStats();
        }
        catch (e) { listEl.innerHTML = `<div style="color:#f66">${escapeHtml(e.message)}</div>`; }
    }

    /* ---- events ---- */
    on(form, 'submit', async (e) =>
    {
        e.preventDefault();
        const body = {
            title: titleIn.value.trim(),
            status: statusIn.value,
            priority: Number(priorityIn.value),
        };
        if (!body.title) return;

        if (editingId)
        {
            await fetch('/api/tasks/' + editingId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            editingId = null;
            form.querySelector('button[type="submit"]').textContent = 'Add Task';
        }
        else
        {
            await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        titleIn.value = '';
        statusIn.value = 'pending';
        priorityIn.value = '0';
        loadTasks();
    });

    on(listEl, 'click', async (e) =>
    {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;

        if (btn.classList.contains('task-del-btn'))
        {
            await fetch('/api/tasks/' + id, { method: 'DELETE' });
            loadTasks();
        }
        else if (btn.classList.contains('task-cycle-btn'))
        {
            const next = { pending: 'in-progress', 'in-progress': 'done', done: 'pending' };
            await fetch('/api/tasks/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next[btn.dataset.status] || 'pending' }),
            });
            loadTasks();
        }
        else if (btn.classList.contains('task-edit-btn'))
        {
            editingId = id;
            const row = btn.closest('.task-row');
            const title = row.querySelector('strong').textContent;
            titleIn.value = title;
            form.querySelector('button[type="submit"]').textContent = 'Save';
            titleIn.focus();
        }
    });

    let searchTimer;
    on(searchIn, 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTasks, 300); });
    on(scopeIn, 'change', loadTasks);

    on(delAllBtn, 'click', async () =>
    {
        await fetch('/api/tasks', { method: 'DELETE' });
        loadTasks();
    });

    loadTasks();
}

/* ------------------------------------------------------------------ */
/*  Blog Explorer Playground                                           */
/* ------------------------------------------------------------------ */
function initBlogExplorer()
{
    const authorForm  = $('#authorForm');
    const authorName  = $('#authorName');
    const authorEmail = $('#authorEmail');
    const authorBio   = $('#authorBio');
    const authorRole  = $('#authorRole');
    const authorList  = $('#authorList');
    const postForm    = $('#postForm');
    const postAuthor  = $('#postAuthor');
    const postTitle   = $('#postTitle');
    const postBody    = $('#postBody');
    const postCategory = $('#postCategory');
    const postStatus  = $('#postStatus');
    const postSearch  = $('#postSearch');
    const postScopeFilter = $('#postScopeFilter');
    const postCategoryFilter = $('#postCategoryFilter');
    const postList    = $('#blogPostList');
    const pagerEl     = $('#blogPager');
    const statsEl     = $('#blogStats');
    const resultEl    = $('#blogResult');
    const seedBtn     = $('#blogSeedBtn');
    const resetBtn    = $('#blogResetBtn');

    if (!authorForm) return;

    let currentPage = 1;

    /* ---- helpers ---- */
    function statusBadge(s)
    {
        const colors = { draft: '#fa0', published: '#2ecc71', archived: '#98a0aa' };
        return `<span class="blog-status-badge" style="background:${colors[s] || '#555'}22;color:${colors[s] || '#555'}">${escapeHtml(s)}</span>`;
    }

    function roleBadge(r)
    {
        const colors = { author: '#5865f2', editor: '#2ecc71', admin: '#ff6b6b' };
        return `<span style="padding:2px 8px;border-radius:4px;font-size:11px;background:${colors[r] || '#555'}22;color:${colors[r] || '#555'};font-weight:600">${escapeHtml(r)}</span>`;
    }

    /* ---- Stats ---- */
    async function loadStats()
    {
        try
        {
            const r = await fetch('/api/blog/stats');
            const s = await r.json();
            statsEl.innerHTML =
                `<div class="orm-stat"><span class="orm-stat-val">${s.totalAuthors}</span><span class="orm-stat-label">Authors</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val">${s.totalPosts}</span><span class="orm-stat-label">Posts</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#2ecc71">${s.published}</span><span class="orm-stat-label">Published</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#fa0">${s.drafts}</span><span class="orm-stat-label">Drafts</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val">${Number(s.avgViews).toFixed(1)}</span><span class="orm-stat-label">Avg Views</span></div>` +
                `<div class="orm-stat"><span class="orm-stat-val" style="color:#5865f2">${s.totalViews}</span><span class="orm-stat-label">Total Views</span></div>`;
        } catch (e) { }
    }

    /* ---- Authors ---- */
    async function loadAuthors()
    {
        try
        {
            const r = await fetch('/api/blog/authors');
            const data = await r.json();

            if (!data.authors || !data.authors.length)
            {
                authorList.innerHTML = '<div style="padding:12px;color:#98a0aa">No authors yet — add one or click "Seed Demo Data".</div>';
                populateAuthorDropdown([]);
                return;
            }

            authorList.innerHTML = data.authors.map(a =>
                `<div class="task-row" data-id="${a.id}">` +
                    `<div class="task-info">` +
                        `<strong>${escapeHtml(a.name)}</strong> ` +
                        roleBadge(a.role) +
                        `<div class="small muted">${escapeHtml(a.email)}${a.bio ? ' · ' + escapeHtml(a.bio) : ''}</div>` +
                    `</div>` +
                    `<div class="task-actions">` +
                        `<button class="btn small warn author-del-btn" data-id="${a.id}">Delete</button>` +
                    `</div>` +
                `</div>`
            ).join('');

            populateAuthorDropdown(data.authors);
        }
        catch (e) { authorList.innerHTML = `<div style="color:#f66">${escapeHtml(e.message)}</div>`; }
    }

    function populateAuthorDropdown(authors)
    {
        const current = postAuthor.value;
        postAuthor.innerHTML = '<option value="">— select —</option>' +
            authors.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
        if (current && authors.some(a => String(a.id) === current)) postAuthor.value = current;
    }

    /* ---- Posts ---- */
    async function loadPosts()
    {
        try
        {
            const params = new URLSearchParams();
            params.set('page', currentPage);
            params.set('perPage', '6');
            if (postSearch.value.trim()) params.set('search', postSearch.value.trim());
            if (postScopeFilter.value) params.set('scope', postScopeFilter.value);
            if (postCategoryFilter.value) params.set('category', postCategoryFilter.value);
            params.set('sort', 'createdAt');
            params.set('order', 'desc');

            const r = await fetch('/api/blog/posts?' + params);
            const data = await r.json();
            showJsonResult(resultEl, data);

            if (!data.posts || !data.posts.length)
            {
                postList.innerHTML = '<div style="padding:12px;color:#98a0aa;grid-column:1/-1">No posts found.</div>';
                pagerEl.innerHTML = '';
                loadStats();
                return;
            }

            postList.innerHTML = data.posts.map(p =>
                `<div class="blog-post-card" data-id="${p.id}">` +
                    `<h4>${escapeHtml(p.title)}</h4>` +
                    `<div class="blog-post-meta">` +
                        `<span class="blog-author-badge">${escapeHtml(p.authorName)}</span>` +
                        `<span class="blog-category-badge">${escapeHtml(p.category)}</span>` +
                        statusBadge(p.status) +
                        `<span class="small muted">👁 ${p.views}</span>` +
                    `</div>` +
                    (p.body ? `<div class="blog-post-body">${escapeHtml(p.body)}</div>` : '') +
                    `<div class="blog-post-actions">` +
                        `<button type="button" class="btn small post-view-btn" data-id="${p.id}" title="Increment views">👁 View</button>` +
                        `<button type="button" class="btn small post-cycle-btn" data-id="${p.id}" data-status="${p.status}" title="Cycle status">↻</button>` +
                        `<button type="button" class="btn small warn post-del-btn" data-id="${p.id}">Delete</button>` +
                    `</div>` +
                `</div>`
            ).join('');

            // Pager
            const { page, totalPages } = data;
            if (totalPages > 1)
            {
                pagerEl.innerHTML =
                    `<div class="pager">` +
                    `<button class="pager-btn" ${page <= 1 ? 'disabled' : ''} id="blogPrevPage">◀</button>` +
                    `<span class="pageInfo">${page} / ${totalPages}</span>` +
                    `<button class="pager-btn" ${page >= totalPages ? 'disabled' : ''} id="blogNextPage">▶</button>` +
                    `</div>`;
            }
            else pagerEl.innerHTML = '';

            loadStats();
        }
        catch (e) { postList.innerHTML = `<div style="color:#f66">${escapeHtml(e.message)}</div>`; }
    }

    /* ---- Events: Authors ---- */
    on(authorForm, 'submit', async (e) =>
    {
        e.preventDefault();
        const body = {
            name: authorName.value.trim(),
            email: authorEmail.value.trim(),
            bio: authorBio.value.trim(),
            role: authorRole.value,
        };
        if (!body.name || !body.email) return;
        await fetch('/api/blog/authors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        authorName.value = '';
        authorEmail.value = '';
        authorBio.value = '';
        loadAuthors();
        loadStats();
    });

    on(authorList, 'click', async (e) =>
    {
        const btn = e.target.closest('.author-del-btn');
        if (!btn) return;
        await fetch('/api/blog/authors/' + btn.dataset.id, { method: 'DELETE' });
        loadAuthors();
        loadPosts();
    });

    /* ---- Events: Posts ---- */
    on(postForm, 'submit', async (e) =>
    {
        e.preventDefault();
        const body = {
            authorId: Number(postAuthor.value),
            title: postTitle.value.trim(),
            body: postBody.value.trim(),
            category: postCategory.value,
            status: postStatus.value,
        };
        if (!body.title || !body.authorId) return;
        await fetch('/api/blog/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        postTitle.value = '';
        postBody.value = '';
        loadPosts();
    });

    on(postList, 'click', async (e) =>
    {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;

        if (btn.classList.contains('post-del-btn'))
        {
            await fetch('/api/blog/posts/' + id, { method: 'DELETE' });
            loadPosts();
        }
        else if (btn.classList.contains('post-cycle-btn'))
        {
            const next = { draft: 'published', published: 'archived', archived: 'draft' };
            await fetch('/api/blog/posts/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next[btn.dataset.status] || 'draft' }),
            });
            loadPosts();
        }
        else if (btn.classList.contains('post-view-btn'))
        {
            const vr = await fetch('/api/blog/posts/' + id + '/view', { method: 'POST' });
            const vd = await vr.json();
            showJsonResult(resultEl, vd);
            await loadPosts();
            const card = postList.querySelector('.blog-post-card[data-id="' + id + '"]');
            if (card) { card.style.outline = '2px solid #5865f2'; setTimeout(() => { card.style.outline = ''; }, 600); }
        }
    });

    on(pagerEl, 'click', (e) =>
    {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        if (btn.id === 'blogPrevPage') currentPage = Math.max(1, currentPage - 1);
        if (btn.id === 'blogNextPage') currentPage++;
        loadPosts();
    });

    let searchTimer;
    on(postSearch, 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { currentPage = 1; loadPosts(); }, 300); });
    on(postScopeFilter, 'change', () => { currentPage = 1; loadPosts(); });
    on(postCategoryFilter, 'change', () => { currentPage = 1; loadPosts(); });

    /* ---- Seed / Reset ---- */
    on(seedBtn, 'click', async () =>
    {
        const r = await fetch('/api/blog/seed', { method: 'POST' });
        const data = await r.json();
        showJsonResult(resultEl, data);
        loadAuthors();
        loadPosts();
    });

    on(resetBtn, 'click', async () =>
    {
        await fetch('/api/blog/reset', { method: 'POST' });
        loadAuthors();
        loadPosts();
    });

    /* ---- Initial Load ---- */
    loadAuthors();
    loadPosts();
}

/* ------------------------------------------------------------------ */
/*  Cookie Explorer Playground                                         */
/* ------------------------------------------------------------------ */
function initCookieExplorer()
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
