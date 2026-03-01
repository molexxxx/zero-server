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
});

/* ── Feature Tabs ──────────────────────────────────────────────────────────── */

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

/* ── TOC Sidebar Toggle ────────────────────────────────────────────────────── */

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

/* ── TOC Smooth-Scroll Navigation ──────────────────────────────────────────── */

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
        let d = el.closest('details.acc');
        while (d)
        {
            d.open = true;
            d = d.parentElement ? d.parentElement.closest('details.acc') : null;
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

/* ── TOC Toolbar (scroll-to-top & expand/collapse all) ─────────────────────── */

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

    /* ── Scroll to top ────────────────────────────────────────────────── */
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

    /* ── Expand / Collapse all accordions ─────────────────────────────── */
    if (toggleBtn)
    {
        let expanded = false;

        toggleBtn.addEventListener('click', () =>
        {
            expanded = !expanded;
            document.querySelectorAll('details.acc').forEach(d => d.open = expanded);

            toggleBtn.classList.toggle('acc-expanded', expanded);
            toggleBtn.title = expanded ? 'Collapse all' : 'Expand all';
            toggleBtn.setAttribute('aria-label', expanded ? 'Collapse all sections' : 'Expand all sections');
        });
    }
}
