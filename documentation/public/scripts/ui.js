/**
 * ui.js
 * Shell UI behaviours — bento grid glow, TOC sidebar toggle, and smooth-scroll
 * anchor navigation.  Runs on DOMContentLoaded alongside the other scripts.
 *
 * No external dependencies — pure DOM.
 */

document.addEventListener('DOMContentLoaded', () =>
{
    initThemeToggle();
    initBentoGrid();
    initTocSidebar();
    initTocNavigation();
    initTocToolbar();
    initTocCollapsible();
    initScrollSpy();
    initScrollProgress();
    initFabTop();
});

/* -- Theme Toggle (dark / light) --------------------------------------------- */

function initThemeToggle()
{
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    function getTheme()
    {
        return document.documentElement.getAttribute('data-theme') || 'dark';
    }

    function setTheme(theme)
    {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('zero-theme', theme);
    }

    btn.addEventListener('click', () =>
    {
        setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });

    /* Listen for OS theme changes (only if user hasn't manually chosen) */
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) =>
    {
        if (!localStorage.getItem('zero-theme'))
        {
            document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
        }
    });
}

/* -- Bento Grid — Win11 border glow ----------------------------------------- */

/**
 * Track mouse position on the bento section and update CSS custom
 * properties on ALL nearby cards so the radial-gradient border glow bleeds
 * across adjacent cards seamlessly (Windows 11 "Mica reveal" style).
 * Uses requestAnimationFrame + lerp for smooth, slightly delayed movement.
 */
function initBentoGrid()
{
    const section = document.querySelector('.bento-section');
    if (!section) return;
    const RADIUS = 300;
    const LERP   = 0.08; /* 0 = frozen, 1 = instant tracking */

    /* Lerped cursor state per card */
    const cardStates = new Map();
    const cards = section.querySelectorAll('.bento-card');
    const toggle = document.getElementById('bento-toggle');
    /* Combine cards + toggle into one tracked set */
    const glowTargets = toggle ? [...cards, toggle] : [...cards];

    let mouseX = 0, mouseY = 0, rafId = null;

    function tick()
    {
        glowTargets.forEach(card =>
        {
            let st = cardStates.get(card);
            if (!st) { st = { x: 0, y: 0, lit: false }; cardStates.set(card, st); }

            const rect = card.getBoundingClientRect();
            const tx = mouseX - rect.left;
            const ty = mouseY - rect.top;

            /* distance from cursor to nearest edge of card */
            const closestX = Math.max(rect.left, Math.min(mouseX, rect.right));
            const closestY = Math.max(rect.top, Math.min(mouseY, rect.bottom));
            const dist = Math.hypot(mouseX - closestX, mouseY - closestY);

            if (dist < RADIUS)
            {
                st.x += (tx - st.x) * LERP;
                st.y += (ty - st.y) * LERP;
                card.style.setProperty('--glow-x', st.x + 'px');
                card.style.setProperty('--glow-y', st.y + 'px');
                if (!st.lit) { card.classList.add('bento-lit'); st.lit = true; }
            }
            else if (st.lit)
            {
                card.classList.remove('bento-lit');
                st.lit = false;
            }
        });
        rafId = requestAnimationFrame(tick);
    }

    section.addEventListener('mouseenter', () =>
    {
        if (!rafId) rafId = requestAnimationFrame(tick);
    });

    section.addEventListener('mousemove', (e) =>
    {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    section.addEventListener('mouseleave', () =>
    {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        glowTargets.forEach(card =>
        {
            card.classList.remove('bento-lit');
            const st = cardStates.get(card);
            if (st) st.lit = false;
        });
    });

    /* Scroll-triggered stagger reveal */
    if ('IntersectionObserver' in window)
    {
        const observer = new IntersectionObserver((entries) =>
        {
            entries.forEach(entry =>
            {
                if (entry.isIntersecting)
                {
                    entry.target.style.animationPlayState = 'running';
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.1 });

        cards.forEach(card =>
        {
            card.style.animationPlayState = 'paused';
            observer.observe(card);
        });
    }

    /* Mobile "Show all features" toggle */
    if (toggle)
    {
        toggle.addEventListener('click', () =>
        {
            const expanded = section.classList.toggle('bento-expanded');
            toggle.textContent = expanded ? 'Show fewer' : 'Show all features';

            /* Re-query cards after toggling so newly visible ones get tracked */
            glowTargets.length = 0;
            section.querySelectorAll('.bento-card').forEach(c => glowTargets.push(c));
            glowTargets.push(toggle);
        });
    }
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
     * Expand the sidebar TOC category that contains a link to the given id.
     * @param {string} id - The hash id to find in the sidebar.
     */
    function expandTocForId(id)
    {
        const link = nav.querySelector('a[href="#' + id + '"]');
        if (link)
        {
            const parentLi = link.closest('.toc-collapsible');
            if (parentLi) parentLi.classList.remove('toc-collapsed');
        }
        else
        {
            /* If the id is a sub-item, find the parent section and expand that */
            const target = document.getElementById(id);
            if (!target) return;
            const section = target.closest('.doc-section');
            if (section && section.id)
            {
                const sectionLink = nav.querySelector('a[href="#' + section.id + '"]');
                if (sectionLink)
                {
                    const parentLi = sectionLink.closest('.toc-collapsible');
                    if (parentLi) parentLi.classList.remove('toc-collapsed');
                }
            }
        }
    }

    /* Expose globally so other scripts (data-sections, search) can use it */
    window.expandTocForId = expandTocForId;

    /**
     * Scroll to an element by id, opening any accordion parents first.
     * @param {string} id - Target element id.
     */
    function scrollToId(id)
    {
        const target = document.getElementById(id);
        if (!target) return;
        openAncestors(target);
        expandTocForId(id);

        /* Force all content-visibility:auto sections to render so layout is accurate */
        const lazySections = document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card');
        lazySections.forEach(s => s.style.contentVisibility = 'visible');

        /* Allow layout to settle, then scroll, then restore lazy rendering */
        requestAnimationFrame(() => {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            /* Re-verify position after scroll completes in case layout shifted */
            setTimeout(() => {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                /* Restore content-visibility after scroll settles */
                setTimeout(() => lazySections.forEach(s => s.style.contentVisibility = ''), 800);
            }, 350);
        });
    }

    nav.addEventListener('click', (e) =>
    {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const hash = a.getAttribute('href');
        if (!hash || hash.charAt(0) !== '#') return;

        e.preventDefault();
        history.pushState(null, '', hash);
        scrollToId(hash.slice(1));
        document.body.classList.remove('toc-open');

        /* Auto-expand the parent sidebar category when clicking its link */
        const parentLi = a.closest('.toc-collapsible');
        if (parentLi) parentLi.classList.remove('toc-collapsed');

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
            history.pushState(null, '', window.location.pathname);
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

/* -- Scroll-Spy Active TOC Highlighting -------------------------------------- */

/**
 * Track which doc section / sub-item is currently visible and apply
 * a `toc-active` class to the corresponding sidebar link.
 * Uses IntersectionObserver for efficient scroll tracking.
 */
function initScrollSpy()
{
    /* Re-run after docs load since sections are dynamic */
    const origLoadDocs = window.loadDocs;
    if (typeof origLoadDocs === 'function' && !window._scrollSpyPatched)
    {
        window._scrollSpyPatched = true;
        /* Hook into loadDocs to re-init observer after sections render */
        const _origLoadDocs = loadDocs;
        window.loadDocs = async function ()
        {
            const result = await _origLoadDocs.apply(this, arguments);
            setupScrollObserver();
            return result;
        };
    }

    /* Also set up immediately for any static sections */
    setupScrollObserver();

    function setupScrollObserver()
    {
        const nav = document.querySelector('.toc-sidebar nav');
        if (!nav) return;

        /* Gather all observable targets: doc-sections and doc-items */
        const targets = document.querySelectorAll('.doc-section, .doc-item, [id="features"], [id="playground"]');
        if (!targets.length) return;

        /* Clear any existing observer */
        if (window._scrollSpyObserver) window._scrollSpyObserver.disconnect();

        const visibleSet = new Set();

        const observer = new IntersectionObserver((entries) =>
        {
            for (const entry of entries)
            {
                if (entry.isIntersecting) visibleSet.add(entry.target.id);
                else visibleSet.delete(entry.target.id);
            }
            updateActiveLink();
        }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });

        window._scrollSpyObserver = observer;
        targets.forEach(t => { if (t.id) observer.observe(t); });

        function updateActiveLink()
        {
            /* Remove all active classes */
            nav.querySelectorAll('.toc-active').forEach(el => el.classList.remove('toc-active'));

            if (!visibleSet.size) return;

            /* Pick the first visible one in DOM order */
            let activeId = null;
            for (const t of targets)
            {
                if (visibleSet.has(t.id)) { activeId = t.id; break; }
            }
            if (!activeId) return;

            /* Find matching sidebar link */
            const link = nav.querySelector(`a[href="#${activeId}"]`);
            if (link)
            {
                link.classList.add('toc-active');
                /* Also mark parent category if it's a sub-item */
                const parentLi = link.closest('li.toc-collapsible');
                if (parentLi)
                {
                    const parentLink = parentLi.querySelector(':scope > a');
                    if (parentLink) parentLink.classList.add('toc-active');
                }
            }
        }
    }
}

/* -- Scroll Progress Bar ----------------------------------------------------- */

/**
 * Thin progress bar at the very top of the viewport indicating how far the
 * user has scrolled through the page.
 */
function initScrollProgress()
{
    const bar = document.getElementById('scroll-progress');
    if (!bar) return;

    function update()
    {
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
        bar.style.width = pct + '%';
    }

    window.addEventListener('scroll', update, { passive: true });
    update();
}

/* -- Floating Back-to-Top FAB ------------------------------------------------ */

/**
 * Floating button in the bottom-right corner that appears after scrolling
 * past a threshold and smooth-scrolls to the top when clicked.
 */
function initFabTop()
{
    const fab = document.getElementById('fab-top');
    if (!fab) return;

    function update()
    {
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        fab.classList.toggle('visible', scrollTop > 300);
    }

    window.addEventListener('scroll', update, { passive: true });
    update();

    fab.addEventListener('click', () =>
    {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        history.pushState(null, '', window.location.pathname);
    });
}
