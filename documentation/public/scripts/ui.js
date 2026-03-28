/**
 * ui.js
 * Shell UI behaviours — feature tabs, TOC sidebar toggle, and smooth-scroll
 * anchor navigation.  Runs on DOMContentLoaded alongside the other scripts.
 *
 * No external dependencies — pure DOM.
 */

document.addEventListener('DOMContentLoaded', () =>
{
    initFeatureTabs();
    initTocSidebar();
    initTocNavigation();
    initTocToolbar();
    initTocCollapsible();
    initTocSearch();
});

/* -- Feature Tabs ------------------------------------------------------------ */

/**
 * Wire the feature / server-model tab buttons so clicking one activates
 * its panel and deactivates the rest.
 */
function initFeatureTabs()
{
    const tabs = document.querySelectorAll('.feature-tabs .tab');
    tabs.forEach(tab =>
    {
        tab.addEventListener('click', () =>
        {
            const target = tab.dataset.target;
            if (!target) return;

            tabs.forEach(t =>
            {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });

            document.querySelectorAll('.feature-tabs .tab-panel').forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');

            const panel = document.getElementById(target);
            if (panel) panel.classList.add('active');
        });
    });
}

/* -- TOC Sidebar Toggle ------------------------------------------------------ */

/**
 * Wire the hamburger button to toggle the sidebar on both desktop (persistent)
 * and mobile (overlay).  Escape key and outside clicks close the mobile overlay.
 */
function initTocSidebar()
{
    const btn = document.querySelector('.toc-toggle');
    const sidebar = document.querySelector('.toc-sidebar');
    if (!btn || !sidebar) return;

    const isDesktop = () => window.matchMedia('(min-width:900px)').matches;

    const syncAria = () =>
    {
        const expanded = isDesktop()
            ? !document.body.classList.contains('toc-hidden')
            : document.body.classList.contains('toc-open');
        btn.setAttribute('aria-expanded', String(expanded));
    };

    syncAria();

    btn.addEventListener('click', () =>
    {
        if (isDesktop())
        {
            document.body.classList.toggle('toc-hidden');
            document.body.classList.remove('toc-open');
        }
        else
        {
            document.body.classList.toggle('toc-open');
        }
        syncAria();
    });

    document.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Escape')
        {
            document.body.classList.remove('toc-open');
            document.body.classList.remove('toc-hidden');
            syncAria();
        }
    });

    document.addEventListener('click', (e) =>
    {
        if (!document.body.classList.contains('toc-open')) return;
        if (e.target.closest('.toc-sidebar') || e.target.closest('.toc-toggle')) return;
        document.body.classList.remove('toc-open');
        syncAria();
    });

    window.addEventListener('resize', syncAria);
}

/* -- TOC Smooth-Scroll Navigation -------------------------------------------- */

/**
 * When clicking a TOC link that points to a `#hash`, auto-open any ancestor
 * `<details>` accordions so the target is visible, then smooth-scroll to it.
 * Also handles the browser `hashchange` event for direct URL navigation.
 */
function initTocNavigation()
{
    const nav = document.querySelector('.toc-sidebar nav');
    if (!nav) return;

    /**
     * Recursively open every `<details class="acc">` ancestor of the given
     * element so it becomes visible.
     * @param {Element} el - Starting element.
     */
    function openAncestors(el)
    {
        let d = el.closest('details');
        while (d)
        {
            d.open = true;
            d = d.parentElement ? d.parentElement.closest('details') : null;
        }
    }

    /**
     * Scroll to an element by id, opening any accordion parents first.
     * @param {string} id - Target element id.
     */
    function scrollToId(id)
    {
        const target = document.getElementById(id);
        if (!target) return;
        openAncestors(target);
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }

    nav.addEventListener('click', (e) =>
    {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const hash = a.getAttribute('href');
        if (!hash || hash.charAt(0) !== '#') return;

        scrollToId(hash.slice(1));
        document.body.classList.remove('toc-open');

        const btn = document.querySelector('.toc-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    });

    window.addEventListener('hashchange', () =>
    {
        const id = location.hash ? location.hash.slice(1) : '';
        if (id) scrollToId(id);
    });
}

/* -- TOC Toolbar (scroll-to-top & expand/collapse all) ----------------------- */

/**
 * Wire the icon-bar buttons at the top of the sidebar:
 *  - Scroll to top
 *  - Expand / collapse every `<details class="acc">` on the page
 */
function initTocToolbar()
{
    const topBtn = document.getElementById('toc-top-btn');
    const toggleBtn = document.getElementById('toc-toggle-acc');
    if (!topBtn && !toggleBtn) return;

    /* -- Scroll to top -------------------------------------------------- */
    const brandBtn = document.getElementById('brand-top');

    [topBtn, brandBtn].forEach(el =>
    {
        if (!el) return;
        el.addEventListener('click', (e) =>
        {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });

    /* -- Expand / Collapse sidebar categories only ---------------------- */
    if (toggleBtn)
    {
        let expanded = true;   /* Start expanded */
        toggleBtn.classList.add('acc-expanded');

        toggleBtn.addEventListener('click', () =>
        {
            expanded = !expanded;

            /* Toggle only collapsible TOC categories in the sidebar */
            document.querySelectorAll('.toc-collapsible').forEach(li =>
            {
                li.classList.toggle('toc-collapsed', !expanded);
            });

            toggleBtn.classList.toggle('acc-expanded', expanded);
            toggleBtn.title = expanded ? 'Collapse all' : 'Expand all';
            toggleBtn.setAttribute('aria-label', expanded ? 'Collapse all sections' : 'Expand all sections');
        });
    }
}

/* -- TOC Collapsible Categories ---------------------------------------------- */

/**
 * Make sidebar categories that have (or will have) nested sub-items
 * collapsible via a toggle chevron. Clicking the chevron expands/collapses
 * the sub-list. Clicking the link itself still navigates.
 */
function initTocCollapsible()
{
    const items = document.querySelectorAll('.toc-collapsible');
    items.forEach(li =>
    {
        /* Skip if already has a toggle button */
        if (li.querySelector('.toc-collapse-btn')) return;

        /* Create toggle button */
        const toggle = document.createElement('button');
        toggle.className = 'toc-collapse-btn';
        toggle.setAttribute('aria-label', 'Toggle section');
        toggle.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        toggle.addEventListener('click', (e) =>
        {
            e.preventDefault();
            e.stopPropagation();
            li.classList.toggle('toc-collapsed');
        });

        li.insertBefore(toggle, li.firstChild);
    });
}

/* -- TOC Search Filter ------------------------------------------------------- */

/**
 * Wire the sidebar search input to filter TOC items by matching against
 * the display name (link text) of each item in the sidebar.
 */
function initTocSearch()
{
    const input = document.getElementById('toc-search');
    if (!input) return;

    const nav = document.querySelector('.toc-sidebar nav ul');
    if (!nav) return;

    /**
     * Get the visible display name for a TOC list item.
     */
    function getDisplayName(li)
    {
        const a = li.querySelector(':scope > a');
        return a ? a.textContent.trim().toLowerCase() : '';
    }

    /**
     * Check whether any sub-items match the query by display name.
     */
    function hasSubMatch(li, q)
    {
        const subItems = li.querySelectorAll('.toc-sub-item');
        for (const sub of subItems)
        {
            if (getDisplayName(sub).includes(q)) return true;
        }
        return false;
    }

    let debounceTimer = null;

    input.addEventListener('input', () =>
    {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() =>
        {
            const q = input.value.trim().toLowerCase();

            const topItems = nav.querySelectorAll(':scope > li');

            if (!q)
            {
                /* Reset: show everything, restore collapsed state */
                topItems.forEach(li =>
                {
                    li.style.display = '';
                    const subItems = li.querySelectorAll('.toc-sub-item');
                    subItems.forEach(s => s.style.display = '');
                });
                return;
            }

            topItems.forEach(li =>
            {
                const titleMatch = getDisplayName(li).includes(q);
                const subMatch = hasSubMatch(li, q);

                if (titleMatch || subMatch)
                {
                    li.style.display = '';
                    /* Auto-expand when searching */
                    if (li.classList.contains('toc-collapsible'))
                    {
                        li.classList.remove('toc-collapsed');
                    }

                    /* Filter sub-items if only some match */
                    const subItems = li.querySelectorAll('.toc-sub-item');
                    if (subItems.length)
                    {
                        subItems.forEach(sub =>
                        {
                            /* If parent title matched, show all children; otherwise filter by sub-item name */
                            sub.style.display = (titleMatch || getDisplayName(sub).includes(q)) ? '' : 'none';
                        });
                    }
                }
                else
                {
                    li.style.display = 'none';
                }
            });
        }, 120);
    });
}
