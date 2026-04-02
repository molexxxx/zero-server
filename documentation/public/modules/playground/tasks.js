/**
 * playground/tasks.js – ORM task manager playground.
 */

import { $, on, escapeHtml, showJsonResult } from '../core/helpers.js';

export function initTasks()
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

    function statusBadge(s)
    {
        const colors = { pending: '#fa0', 'in-progress': '#5865f2', done: '#2ecc71' };
        return `<span style="padding:2px 8px;border-radius:4px;font-size:12px;background:${colors[s] || '#555'}22;color:${colors[s] || '#555'}">${escapeHtml(s)}</span>`;
    }

    function priorityStars(n)
    {
        return '<span style="color:#fa0">' + '★'.repeat(n) + '</span>' + '<span style="color:var(--muted)">' + '☆'.repeat(5 - n) + '</span>';
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
                        `<button class="btn small task-edit-btn" data-id="${t.id}" data-status="${t.status}" data-priority="${t.priority}">Edit</button>` +
                        `<button class="btn small task-cycle-btn" data-id="${t.id}" data-status="${t.status}" title="Cycle status">↻</button>` +
                        `<button class="btn small warn task-del-btn" data-id="${t.id}">Delete</button>` +
                    `</div>` +
                `</div>`
            ).join('');

            loadStats();
        }
        catch (e) { listEl.innerHTML = `<div style="color:#f66">${escapeHtml(e.message)}</div>`; }
    }

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
        statusIn.dispatchEvent(new Event('change', { bubbles: true }));
        priorityIn.dispatchEvent(new Event('change', { bubbles: true }));
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
            statusIn.value = btn.dataset.status;
            priorityIn.value = btn.dataset.priority;
            statusIn.dispatchEvent(new Event('change', { bubbles: true }));
            priorityIn.dispatchEvent(new Event('change', { bubbles: true }));
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
