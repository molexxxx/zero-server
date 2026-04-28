/**
 * playground/blog.js – Blog explorer (authors + posts CRUD).
 */

import { $, on, escapeHtml, showJsonResult } from '../core/helpers.js';

export function initBlog()
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
        authorRole.value = 'author';
        authorRole.dispatchEvent(new Event('change', { bubbles: true }));
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
        postAuthor.value = '';
        postCategory.value = 'general';
        postStatus.value = 'draft';
        postAuthor.dispatchEvent(new Event('change', { bubbles: true }));
        postCategory.dispatchEvent(new Event('change', { bubbles: true }));
        postStatus.dispatchEvent(new Event('change', { bubbles: true }));
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

    loadAuthors();
    loadPosts();
}
