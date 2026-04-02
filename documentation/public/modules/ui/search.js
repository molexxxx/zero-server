/**
 * ui/search.js
 * Full-text search modal for documentation.
 */

import { escapeHtml, slugify } from '../core/helpers.js';
import { histPushModal, histCloseModal, histDismissModal, histPushHash } from '../core/history.js';
import { expandTocForId } from './shell.js';
import { getSelectedVersion, initSearchVersionBadge } from './version-selector.js';

const RECENT_KEY = 'zero-http-search-recent';
const MAX_RECENT = 8;

let overlay, input, resultsContainer;
let searchIndex = [];
let searchIndexVersion = null;
let _indexedSections = null;
let activeIndex = -1;
let currentResults = [];

function _searchBoot()
{
    overlay = document.getElementById('search-modal');
    input = document.getElementById('search-modal-input');
    resultsContainer = document.getElementById('search-modal-results');

    if (!overlay || !input || !resultsContainer) return;

    document.querySelectorAll('.search-trigger').forEach(btn =>
        btn.addEventListener('click', openSearch)
    );

    document.addEventListener('keydown', (e) =>
    {
        if ((e.ctrlKey || e.metaKey) && e.key === '.')
        {
            e.preventDefault();
            openSearch();
        }
        if (e.key === '/' && !isInputFocused())
        {
            e.preventDefault();
            openSearch();
        }
    });

    overlay.addEventListener('click', (e) =>
    {
        if (e.target === overlay) closeSearch();
    });

    overlay.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
        if (e.key === 'Enter') { e.preventDefault(); selectActive(); }
    });

    let debounce = null;
    input.addEventListener('input', () =>
    {
        clearTimeout(debounce);
        debounce = setTimeout(() => runSearch(input.value.trim()), 80);
    });
}

function isInputFocused()
{
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

let _searchBadgeReady = false;

function openSearch()
{
    buildIndex();
    overlay.setAttribute('aria-hidden', 'false');
    histPushModal('search-modal');
    input.value = '';
    activeIndex = -1;
    currentResults = [];

    if (!_searchBadgeReady)
    {
        initSearchVersionBadge();
        _searchBadgeReady = true;
    }

    showRecent();
    setTimeout(() => input.focus(), 50);
}

function closeSearch()
{
    histCloseModal('search-modal');
}

/* -- Index builder ----------------------------------------- */

function _stripHtml(s) { return s.replace(/<[^>]+>/g, ''); }
function sectionSlug(name) { return 'section-' + slugify(name); }
function itemSlug(section, item) { return slugify(section) + '-' + slugify(item); }

function buildIndex()
{
    const sections = window._docSections;
    const ver = getSelectedVersion() || null;
    if (!sections) return;
    if (searchIndex.length && searchIndexVersion === ver && _indexedSections === sections) return;

    searchIndex = [];
    searchIndexVersion = ver;
    _indexedSections = sections;

    for (const section of sections)
    {
        if (!Array.isArray(section.items)) continue;

        for (const item of section.items)
        {
            const slug = itemSlug(section.section, item.name);

            searchIndex.push({
                type: 'item',
                section: section.section,
                sectionIcon: section.icon,
                name: item.name,
                slug,
                text: item.name,
                context: item.description || '',
            });

            if (Array.isArray(item.params))
            {
                for (const p of item.params)
                {
                    searchIndex.push({
                        type: 'option',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: p.param || '',
                        slug,
                        text: p.param || '',
                        context: p.notes || '',
                        parent: item.name + ' › Parameters',
                    });
                }
            }

            if (Array.isArray(item.methods))
            {
                for (const m of item.methods)
                {
                    _indexMethod(m, section, slug, item.name, '');
                }
            }

            if (Array.isArray(item.methodGroups))
            {
                for (const group of item.methodGroups)
                {
                    const groupName = group.group || group.category || 'Methods';
                    const groupSlug = slug + '--' + slugify(groupName);

                    searchIndex.push({
                        type: 'group',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: groupName,
                        slug: groupSlug,
                        text: groupName,
                        context: item.name,
                        parent: item.name,
                    });

                    if (!Array.isArray(group.methods)) continue;
                    for (const m of group.methods)
                    {
                        _indexMethod(m, section, slug, item.name, groupName);
                    }
                }
            }

            if (Array.isArray(item.options))
            {
                for (const o of item.options)
                {
                    searchIndex.push({
                        type: 'option',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: o.option || '',
                        slug,
                        text: o.option || '',
                        context: o.notes || '',
                        parent: item.name,
                    });
                }
            }

            if (Array.isArray(item.optionGroups))
            {
                for (const group of item.optionGroups)
                {
                    const catName = group.category || 'Options';
                    if (Array.isArray(group.options))
                    {
                        for (const o of group.options)
                        {
                            searchIndex.push({
                                type: 'option',
                                section: section.section,
                                sectionIcon: section.icon,
                                name: o.option || '',
                                slug,
                                text: o.option || '',
                                context: o.notes || '',
                                parent: item.name + ' › ' + catName,
                            });
                        }
                    }
                }
            }

            if (Array.isArray(item.tips))
            {
                for (const tip of item.tips)
                {
                    searchIndex.push({
                        type: 'tip',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: item.name,
                        slug,
                        text: tip,
                        context: tip,
                        parent: item.name,
                    });
                }
            }

            /* -- CLI structured content ----------------------------- */

            if (Array.isArray(item.commandGroups))
            {
                for (const group of item.commandGroups)
                {
                    if (Array.isArray(group.commands))
                    {
                        for (const c of group.commands)
                        {
                            const cmd = (c.cmd || '').replace(/<[^>]+>/g, '');
                            const desc = _stripHtml(c.desc || '');
                            const args = c.args || '';
                            searchIndex.push({
                                type: 'option',
                                section: section.section,
                                sectionIcon: section.icon,
                                name: cmd,
                                slug,
                                text: cmd + ' ' + args,
                                context: desc,
                                parent: item.name + ' › ' + (group.label || 'Commands'),
                            });
                        }
                    }
                }
            }

            if (Array.isArray(item.cliOptions))
            {
                for (const o of item.cliOptions)
                {
                    searchIndex.push({
                        type: 'option',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: o.flag || '',
                        slug,
                        text: o.flag || '',
                        context: _stripHtml(o.desc || ''),
                        parent: item.name + ' › Options',
                    });
                }
            }

            if (Array.isArray(item.workflows))
            {
                for (const wf of item.workflows)
                {
                    const wfName = wf.tab || 'Workflow';
                    if (Array.isArray(wf.steps))
                    {
                        for (const step of wf.steps)
                        {
                            const label = step.label || '';
                            const code = step.code || '';
                            const note = _stripHtml(step.note || '');
                            searchIndex.push({
                                type: 'tip',
                                section: section.section,
                                sectionIcon: section.icon,
                                name: label,
                                slug,
                                text: label + ' ' + code + ' ' + note,
                                context: wfName + ' workflow',
                                parent: item.name + ' › ' + wfName,
                            });
                        }
                    }
                }
            }

            if (Array.isArray(item.configExamples))
            {
                for (const cfg of item.configExamples)
                {
                    searchIndex.push({
                        type: 'tip',
                        section: section.section,
                        sectionIcon: section.icon,
                        name: (cfg.adapter || 'Config') + ' config',
                        slug,
                        text: (cfg.adapter || '') + ' ' + (cfg.code || ''),
                        context: item.name + ' configuration example',
                        parent: item.name + ' › Config',
                    });
                }
            }
        }
    }
}

function _indexMethod(m, section, slug, itemName, groupName)
{
    const parent = groupName ? itemName + ' › ' + groupName : itemName;
    const methodName = m.method || m.signature || '';
    const methodSlug = methodName ? slug + '--' + slugify(methodName) : slug;

    searchIndex.push({
        type: 'method',
        section: section.section,
        sectionIcon: section.icon,
        name: methodName,
        slug: methodSlug,
        text: (m.method || '') + ' ' + (m.signature || ''),
        context: m.description || '',
        parent,
    });

    if (Array.isArray(m.methodOptions))
    {
        for (const o of m.methodOptions)
        {
            searchIndex.push({
                type: 'option',
                section: section.section,
                sectionIcon: section.icon,
                name: o.option || '',
                slug,
                text: o.option || '',
                context: o.notes || '',
                parent: itemName + ' › ' + (m.method || ''),
            });
        }
    }

    if (Array.isArray(m.methodParams))
    {
        for (const p of m.methodParams)
        {
            searchIndex.push({
                type: 'option',
                section: section.section,
                sectionIcon: section.icon,
                name: p.param || '',
                slug,
                text: p.param || '',
                context: p.notes || '',
                parent: itemName + ' › ' + (m.method || ''),
            });
        }
    }
}

/* -- Recent selections ------------------------------------- */

function getRecent()
{
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch { return []; }
}

function saveRecent(entry)
{
    const recents = getRecent().filter(r => r.slug !== entry.slug || r.name !== entry.name);
    recents.unshift({ type: entry.type, name: entry.name, slug: entry.slug, section: entry.section, context: entry.context || '', parent: entry.parent || '' });
    if (recents.length > MAX_RECENT) recents.length = MAX_RECENT;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch { }
}

function clearRecent()
{
    try { localStorage.removeItem(RECENT_KEY); } catch { }
}

function showRecent()
{
    const recents = getRecent();

    // Filter recents to only items available in the current version's index
    const available = searchIndex.length
        ? recents.filter(r => searchIndex.some(e => e.slug === r.slug && e.name === r.name))
        : recents;

    if (!available.length)
    {
        resultsContainer.innerHTML = '<div class="search-modal-empty">Start typing to search…</div>';
        return;
    }

    currentResults = available;
    activeIndex = 0;

    let html = '<div class="search-group">' +
        '<div class="search-group-title"><span>Recent</span>' +
        '<button class="search-clear-recent" type="button">Clear</button></div>';

    available.forEach((item, i) =>
    {
        const icon = TYPE_ICONS[item.type] || TYPE_ICONS.item;
        const isActive = i === 0 ? ' search-active' : '';
        const parent = item.parent ? `<span class="search-result-section">${escapeHtml(item.parent)}</span>` : '';
        const ctx = item.context ? escapeHtml(item.context.length > 60 ? item.context.slice(0, 60) + '…' : item.context) : '';

        html += `<a class="search-result${isActive}" href="#${item.slug}" data-idx="${i}">` +
            `<div class="search-result-icon search-result-icon-recent"><svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.5l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
            `<div class="search-result-body">` +
            `<div class="search-result-title">${escapeHtml(item.name)}</div>` +
            (ctx ? `<div class="search-result-context">${ctx}</div>` : '') +
            `</div>` +
            parent +
            `<svg class="search-result-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
            `</a>`;
    });

    html += '</div>';
    resultsContainer.innerHTML = html;

    resultsContainer.querySelectorAll('.search-result').forEach(el =>
    {
        el.addEventListener('click', (e) =>
        {
            e.preventDefault();
            const href = el.getAttribute('href');
            if (href) { dismissAndNavigate(href.slice(1)); }
        });
    });

    const clearBtn = resultsContainer.querySelector('.search-clear-recent');
    if (clearBtn) clearBtn.addEventListener('click', () =>
    {
        clearRecent();
        resultsContainer.innerHTML = '<div class="search-modal-empty">Start typing to search…</div>';
        currentResults = [];
        activeIndex = -1;
    });
}

/* -- Search logic ------------------------------------------ */

function runSearch(query)
{
    if (!query)
    {
        showRecent();
        return;
    }

    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);

    const scored = [];
    for (const entry of searchIndex)
    {
        const nameL = entry.name.toLowerCase();
        const textL = entry.text.toLowerCase();
        const ctxL = entry.context.toLowerCase();

        let score = 0;
        let matched = true;

        for (const w of words)
        {
            const inName = nameL.includes(w);
            const inText = textL.includes(w);
            const inCtx = ctxL.includes(w);

            if (!inName && !inText && !inCtx) { matched = false; break; }

            if (nameL === w) score += 100;
            else if (nameL.startsWith(w)) score += 60;
            else if (inName) score += 40;
            if (inText && !inName) score += 20;
            if (inCtx) score += 10;
        }

        if (!matched) continue;

        if (entry.type === 'item') score += 15;
        else if (entry.type === 'group') score += 12;
        else if (entry.type === 'method') score += 8;

        scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const limited = scored.slice(0, 50);
    currentResults = limited.map(s => s.entry);
    activeIndex = limited.length ? 0 : -1;

    renderResults(currentResults, words);
}

/* -- Rendering --------------------------------------------- */

const TYPE_ICONS = {
    item: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 3h12M2 8h12M2 13h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    method: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 12l4-4-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    group: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 4h5l2 2h5v7H2V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    option: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="2"/><path d="M12.9 5A7 7 0 1 1 3 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    tip: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="6" r="4" stroke="currentColor" stroke-width="2"/><path d="M6 10v2a2 2 0 0 0 4 0v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

function highlightText(text, words)
{
    let result = escapeHtml(text);
    for (const w of words)
    {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
    }
    return result;
}

function renderResults(results, words)
{
    if (!results.length)
    {
        resultsContainer.innerHTML = '<div class="search-modal-empty">No results found.</div>';
        return;
    }

    const groups = {};
    for (const r of results)
    {
        if (!groups[r.section]) groups[r.section] = [];
        groups[r.section].push(r);
    }

    let html = '';
    let globalIdx = 0;

    for (const [section, items] of Object.entries(groups))
    {
        html += `<div class="search-group"><div class="search-group-title">${escapeHtml(section)}</div>`;

        for (const item of items)
        {
            const icon = TYPE_ICONS[item.type] || TYPE_ICONS.item;
            const title = highlightText(item.name, words);
            const ctx = item.context ? highlightText(
                item.context.length > 80 ? item.context.slice(0, 80) + '…' : item.context,
                words
            ) : '';
            const parent = item.parent ? `<span class="search-result-section">${escapeHtml(item.parent)}</span>` : '';
            const isActive = globalIdx === activeIndex ? ' search-active' : '';

            html += `<a class="search-result${isActive}" href="#${item.slug}" data-idx="${globalIdx}">` +
                `<div class="search-result-icon">${icon}</div>` +
                `<div class="search-result-body">` +
                `<div class="search-result-title">${title}</div>` +
                (ctx ? `<div class="search-result-context">${ctx}</div>` : '') +
                `</div>` +
                parent +
                `<svg class="search-result-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
                `</a>`;
            globalIdx++;
        }

        html += '</div>';
    }

    resultsContainer.innerHTML = html;

    resultsContainer.querySelectorAll('.search-result').forEach(el =>
    {
        el.addEventListener('click', (e) =>
        {
            e.preventDefault();
            const idx = parseInt(el.dataset.idx, 10);
            if (!isNaN(idx) && currentResults[idx]) saveRecent(currentResults[idx]);
            const href = el.getAttribute('href');
            if (href)
            {
                dismissAndNavigate(href.slice(1));
            }
        });
    });
}

/* -- Keyboard navigation ----------------------------------- */

function moveActive(delta)
{
    if (!currentResults.length) return;

    const prev = activeIndex;
    activeIndex = Math.max(0, Math.min(currentResults.length - 1, activeIndex + delta));

    const items = resultsContainer.querySelectorAll('.search-result');
    if (items[prev]) items[prev].classList.remove('search-active');
    if (items[activeIndex])
    {
        items[activeIndex].classList.add('search-active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
}

function selectActive()
{
    if (activeIndex < 0 || activeIndex >= currentResults.length) return;
    const entry = currentResults[activeIndex];
    saveRecent(entry);
    dismissAndNavigate(entry.slug);
}

function dismissAndNavigate(id)
{
    histDismissModal('search-modal');
    histPushHash('#' + id);
    navigateToHash(id);
}

function navigateToHash(id)
{
    let target = document.getElementById(id);

    /* For sub-anchors (item--group or item--method), open the parent item first */
    if (!target && id.includes('--'))
    {
        const parentId = id.split('--')[0];
        const parentEl = document.getElementById(parentId);
        if (parentEl)
        {
            let d = parentEl.closest('details');
            while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }
            if (parentEl.tagName === 'DETAILS') parentEl.open = true;

            void document.documentElement.offsetHeight;
            target = document.getElementById(id);
        }
    }

    if (!target) return;

    let d = target.closest('details');
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }

    const tocId = id.includes('--') ? id.split('--')[0] : id;
    expandTocForId(tocId);

    document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card')
        .forEach(s => s.style.contentVisibility = 'visible');

    void document.documentElement.offsetHeight;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
}

/* -- Export ------------------------------------------------- */

export function initSearch()
{
    _searchBoot();
}

/**
 * Rebuild the search index and refresh the visible results/recents.
 * Called after a version switch inside the search modal.
 */
export function refreshSearchResults()
{
    // Force index rebuild on next query
    searchIndex = [];
    searchIndexVersion = null;
    _indexedSections = null;
    buildIndex();

    // If the input has a query, re-run it; otherwise refresh recents
    if (input && input.value.trim())
    {
        runSearch(input.value.trim());
    }
    else
    {
        showRecent();
    }
}
