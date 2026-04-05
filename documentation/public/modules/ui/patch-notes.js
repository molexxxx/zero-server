/**
 * ui/patch-notes.js
 * Patch notes modal — shows what changed between documentation versions.
 */

import { escapeHtml } from '../core/helpers.js';
import { histPushModal, histCloseModal } from '../core/history.js';
import { getSelectedVersion, getVersions } from './version-selector.js';

let _overlay = null;
let _cache = new Map();

const CHANGE_ICONS = {
	added:   '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#3fb950" stroke-width="1.5"/><path d="M8 5v6M5 8h6" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round"/></svg>',
	removed: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#f85149" stroke-width="1.5"/><path d="M5 8h6" stroke="#f85149" stroke-width="1.5" stroke-linecap="round"/></svg>',
	moved:   '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#58a6ff" stroke-width="1.5"/><path d="M5 8h6" stroke="#58a6ff" stroke-width="1.5" stroke-linecap="round"/><path d="M9 5.5L11.5 8 9 10.5" stroke="#58a6ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const KIND_LABELS = {
	section: 'Section',
	item:    'API',
	method:  'Method',
};

function ensureOverlay()
{
	if (_overlay) return;

	_overlay = document.createElement('div');
	_overlay.id = 'patch-notes-overlay';
	_overlay.className = 'badge-modal-overlay';
	_overlay.setAttribute('aria-hidden', 'true');
	_overlay.innerHTML =
		'<div class="badge-modal" style="max-width:620px">' +
			'<div class="badge-modal-header">' +
				'<h3 id="patch-notes-title">Patch Notes</h3>' +
				'<button class="badge-modal-close" id="patch-notes-close" aria-label="Close">×</button>' +
			'</div>' +
			'<div class="badge-modal-body" id="patch-notes-body" style="padding:16px 22px 22px"></div>' +
		'</div>';
	document.body.appendChild(_overlay);

	const close = () => { document.body.style.overflow = ''; histCloseModal('patch-notes-overlay'); };
	document.getElementById('patch-notes-close').addEventListener('click', close);
	_overlay.addEventListener('click', e => { if (e.target === _overlay) close(); });
	document.addEventListener('keydown', e =>
	{
		if (e.key === 'Escape' && _overlay.getAttribute('aria-hidden') === 'false') close();
	});

	// Restore body scroll if modal is closed via browser back button
	new MutationObserver(() =>
	{
		if (_overlay.getAttribute('aria-hidden') === 'true') document.body.style.overflow = '';
	}).observe(_overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
}

async function fetchPatchNotes(ver)
{
	if (_cache.has(ver)) return _cache.get(ver);

	const _v = window.__v ? `?v=${window.__v}` : '';
	try
	{
		const res = await fetch(`/data/versions/${encodeURIComponent(ver)}/patch-notes.json${_v}`);
		if (!res.ok) { _cache.set(ver, null); return null; }
		const data = await res.json();
		_cache.set(ver, data);
		return data;
	}
	catch { _cache.set(ver, null); return null; }
}

function renderPatchNotes(notes)
{
	const body = document.getElementById('patch-notes-body');
	const title = document.getElementById('patch-notes-title');
	if (!body || !title) return;

	title.textContent = `What's New in v${notes.version}`;

	if (!notes.changes || !notes.changes.length)
	{
		body.innerHTML = '<p class="pn-empty">No changes detected from the previous version.</p>';
		return;
	}

	// Group changes by type
	const added = notes.changes.filter(c => c.type === 'added');
	const removed = notes.changes.filter(c => c.type === 'removed');
	const moved = notes.changes.filter(c => c.type === 'moved');

	let html = '';

	if (notes.previousVersion)
	{
		html += `<p class="pn-subtitle">Changes from <strong>v${escapeHtml(notes.previousVersion)}</strong> to <strong>v${escapeHtml(notes.version)}</strong></p>`;
	}

	if (added.length)
	{
		html += '<div class="pn-group">';
		html += `<div class="pn-group-title pn-added">${CHANGE_ICONS.added}<span>Added (${added.length})</span></div>`;
		html += renderChangeList(added);
		html += '</div>';
	}

	if (moved.length)
	{
		html += '<div class="pn-group">';
		html += `<div class="pn-group-title pn-moved">${CHANGE_ICONS.moved}<span>Moved (${moved.length})</span></div>`;
		html += renderChangeList(moved);
		html += '</div>';
	}

	if (removed.length)
	{
		html += '<div class="pn-group">';
		html += `<div class="pn-group-title pn-removed">${CHANGE_ICONS.removed}<span>Removed (${removed.length})</span></div>`;
		html += renderChangeList(removed);
		html += '</div>';
	}

	body.innerHTML = html;
}

function renderChangeList(changes)
{
	let html = '<div class="pn-list">';

	for (const c of changes)
	{
		const kindLabel = KIND_LABELS[c.kind] || c.kind;
		const icon = CHANGE_ICONS[c.type] || '';
		let section = c.section ? `<span class="pn-section">${escapeHtml(c.section)}</span>` : '';
		if (c.type === 'moved' && c.fromSection)
		{
			section = `<span class="pn-section">${escapeHtml(c.fromSection)} → ${escapeHtml(c.section)}</span>`;
		}

		let nameHtml = escapeHtml(c.name);
		if (c.kind === 'method' && c.method)
		{
			nameHtml = `${escapeHtml(c.name)} › <code>${escapeHtml(c.method)}</code>`;
		}

		html += `<div class="pn-item pn-item-${c.type}">` +
			`<span class="pn-kind">${escapeHtml(kindLabel)}</span>` +
			`<span class="pn-name">${nameHtml}</span>` +
			section +
			'</div>';
	}

	html += '</div>';
	return html;
}

export async function showPatchNotes(ver)
{
	ensureOverlay();

	const body = document.getElementById('patch-notes-body');
	const title = document.getElementById('patch-notes-title');
	if (body) body.innerHTML = '<p class="pn-loading">Loading…</p>';
	if (title) title.textContent = 'Patch Notes';

	_overlay.setAttribute('aria-hidden', 'false');
	document.body.style.overflow = 'hidden';
	histPushModal('patch-notes-overlay');

	const versions = await getVersions();
	if (!versions || !versions.length) { if (body) body.innerHTML = '<p class="pn-empty">No versions available.</p>'; return; }

	const current = ver || getSelectedVersion() || (versions[0] && versions[0].version);
	const sorted = [...versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

	// Fetch all patch notes in parallel
	const allNotes = await Promise.all(sorted.map(v => fetchPatchNotes(v.version)));

	if (title) title.textContent = 'Patch Notes';

	let html = '';
	for (let i = 0; i < sorted.length; i++)
	{
		const v = sorted[i].version;
		const notes = allNotes[i];
		const isCurrent = v === current;
		const openAttr = isCurrent ? ' open' : '';

		html += `<details class="pn-version-group"${openAttr}>`;
		html += `<summary class="pn-version-header">`;
		html += `<span class="pn-version-label">v${escapeHtml(v)}</span>`;
		if (isCurrent) html += `<span class="pn-version-badge">current</span>`;
		if (notes && notes.changes) html += `<span class="pn-version-count">${notes.changes.length} change${notes.changes.length !== 1 ? 's' : ''}</span>`;
		html += `</summary>`;
		html += `<div class="pn-version-body">`;

		if (!notes)
		{
			html += '<p class="pn-empty">No patch notes available for this version.</p>';
		}
		else if (!notes.changes || !notes.changes.length)
		{
			html += '<p class="pn-empty">No changes detected from the previous version.</p>';
		}
		else
		{
			if (notes.previousVersion)
			{
				html += `<p class="pn-subtitle">Changes from <strong>v${escapeHtml(notes.previousVersion)}</strong> to <strong>v${escapeHtml(notes.version)}</strong></p>`;
			}

			const added = notes.changes.filter(c => c.type === 'added');
			const removed = notes.changes.filter(c => c.type === 'removed');

			if (added.length)
			{
				html += '<div class="pn-group">';
				html += `<div class="pn-group-title pn-added">${CHANGE_ICONS.added}<span>Added (${added.length})</span></div>`;
				html += renderChangeList(added);
				html += '</div>';
			}

			if (removed.length)
			{
				html += '<div class="pn-group">';
				html += `<div class="pn-group-title pn-removed">${CHANGE_ICONS.removed}<span>Removed (${removed.length})</span></div>`;
				html += renderChangeList(removed);
				html += '</div>';
			}
		}

		html += '</div></details>';
	}

	if (body) body.innerHTML = html;
}

export function initPatchNotes()
{
	// Listen for patch-notes triggers (buttons with data-patch-notes)
	document.addEventListener('click', e =>
	{
		const trigger = e.target.closest('[data-patch-notes]');
		if (trigger)
		{
			e.preventDefault();
			showPatchNotes(trigger.dataset.patchNotes || undefined);
		}
	});
}
