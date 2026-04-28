/**
 * ui/shell.js
 * Shell UI behaviours — theme toggle, bento grid glow, TOC sidebar,
 * smooth-scroll, scroll-spy, progress bar, FAB.
 */

import { histPushHash, histPushAccordion, histPushSidebar, histCloseSidebar } from '../core/history.js';

function _resolveTopOffset()
{
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;visibility:hidden;height:var(--top-offset)';
    document.body.appendChild(el);
    const px = el.offsetHeight + 5;
    el.remove();
    return px;
}

/* -- Theme Toggle (dark / light) --------------------------- */

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
        document.documentElement.classList.add('no-transitions');
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('zero-theme', theme);
        requestAnimationFrame(() => { requestAnimationFrame(() => { document.documentElement.classList.remove('no-transitions'); }); });
    }

    btn.addEventListener('click', () =>
    {
        setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) =>
    {
        if (!localStorage.getItem('zero-theme'))
        {
            document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
        }
    });
}

/* -- Bento Grid — Win11 border glow ------------------------ */

function initBentoGrid()
{
    const section = document.querySelector('.bento-section');
    if (!section) return;
    const RADIUS = 300;
    const LERP   = 0.08;

    const cardStates = new Map();
    const cards = section.querySelectorAll('.bento-card');
    const toggle = document.getElementById('bento-toggle');
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

    if (toggle)
    {
        toggle.addEventListener('click', () =>
        {
            const expanded = section.classList.toggle('bento-expanded');
            toggle.textContent = expanded ? 'Show fewer' : 'Show all features';

            glowTargets.length = 0;
            section.querySelectorAll('.bento-card').forEach(c =>
            {
                glowTargets.push(c);
                if (expanded && c.classList.contains('bento-extra'))
                {
                    c.style.animationPlayState = '';
                }
            });
            glowTargets.push(toggle);
        });
    }

    /* Intercept bento card anchor clicks so scrollToId applies the correct offset */
    section.addEventListener('click', (e) =>
    {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const hash = a.getAttribute('href');
        if (!hash || hash.charAt(0) !== '#') return;
        e.preventDefault();
        histPushHash(hash);
        scrollToId(hash.slice(1));
    });
}

/* -- TOC Sidebar Toggle ------------------------------------ */

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

    /* Close button in toolbar (visible on mobile/tablet only) */
    const closeBtn = sidebar.querySelector('.toc-close-btn');
    if (closeBtn)
    {
        closeBtn.addEventListener('click', () => histCloseSidebar());
    }

    btn.addEventListener('click', () =>
    {
        if (isDesktop())
        {
            document.body.classList.toggle('toc-hidden');
            document.body.classList.remove('toc-open');
        }
        else
        {
            const opening = !document.body.classList.contains('toc-open');
            document.body.classList.toggle('toc-open');
            if (opening) histPushSidebar();
            else histCloseSidebar();
        }
        syncAria();
    });

    document.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Escape')
        {
            if (document.body.classList.contains('toc-open')) histCloseSidebar();
            document.body.classList.remove('toc-hidden');
            syncAria();
        }
    });

    document.addEventListener('click', (e) =>
    {
        if (!document.body.classList.contains('toc-open')) return;
        if (e.target.closest('.toc-sidebar') || e.target.closest('.toc-toggle')) return;
        histCloseSidebar();
        syncAria();
    });

    window.addEventListener('resize', syncAria);
}

/* -- TOC Smooth-Scroll Navigation -------------------------- */

function initTocNavigation()
{
    const nav = document.querySelector('.toc-sidebar nav');
    if (!nav) return;

    function openAncestors(el)
    {
        let d = el.closest('details');
        while (d)
        {
            d.open = true;
            d = d.parentElement ? d.parentElement.closest('details') : null;
        }
    }

    nav.addEventListener('click', (e) =>
    {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const hash = a.getAttribute('href');
        if (!hash || hash.charAt(0) !== '#') return;

        e.preventDefault();
        histPushHash(hash);
        histCloseSidebar();

        const parentLi = a.closest('.toc-collapsible');
        if (parentLi) parentLi.classList.remove('toc-collapsed');

        const btn = document.querySelector('.toc-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'false');

        if (hash === '#features') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            scrollToId(hash.slice(1));
        }
    });

    window.addEventListener('hashchange', () =>
    {
        if (window._histPopstateHandled) return;
        const id = location.hash ? location.hash.slice(1) : '';
        if (id) scrollToId(id);
    });
}

/* -- TOC Toolbar ------------------------------------------- */

function initTocToolbar()
{
    const brandBtn = document.getElementById('brand-top');
    if (brandBtn)
    {
        brandBtn.addEventListener('click', (e) =>
        {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            histPushHash(window.location.pathname);
        });
    }
}

/* -- TOC Collapsible Categories ---------------------------- */

export function initTocCollapsible()
{
    /* Handle static collapsible items (e.g. Playground) that aren't created by populateToc.
       Dynamic sections already wire their own chevron click handlers. */
    document.querySelectorAll('.toc-collapsible[data-static]').forEach(li =>
    {
        const a = li.querySelector(':scope > a');
        if (!a) return;
        li.classList.add('toc-collapsed');
        a.addEventListener('click', (e) =>
        {
            const t = e.target.closest('.toc-chevron, .toc-item-count');
            if (t)
            {
                e.preventDefault();
                e.stopPropagation();
                li.classList.toggle('toc-collapsed');
            }
        });
    });
}

/* -- Scroll-Spy Active TOC Highlighting -------------------- */

let _scrollSpySetup = null;

function initScrollSpy()
{
    _scrollSpySetup = setupScrollObserver;
    setupScrollObserver();

    function setupScrollObserver()
    {
        const nav = document.querySelector('.toc-sidebar nav');
        if (!nav) return;

        /* Derive all observable IDs from sidebar links */
        const sidebarLinks = nav.querySelectorAll('a[href^="#"]');
        const idMap = new Map();
        const targets = [];

        for (const link of sidebarLinks)
        {
            const id = link.getAttribute('href').slice(1);
            if (!id) continue;
            const el = document.getElementById(id);
            if (el)
            {
                idMap.set(id, link);
                targets.push(el);
            }
        }

        if (!targets.length) return;

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
        }, { rootMargin: `-${_resolveTopOffset()}px 0px -60% 0px`, threshold: 0 });

        window._scrollSpyObserver = observer;
        targets.forEach(t => observer.observe(t));

        function updateActiveLink()
        {
            nav.querySelectorAll('.toc-active,.toc-parent-active').forEach(el => el.classList.remove('toc-active', 'toc-parent-active'));

            if (!visibleSet.size) return;

            /* Prefer sub-items over parent sections for accurate tracking */
            let activeId = null;
            for (const t of targets)
            {
                if (!visibleSet.has(t.id)) continue;
                const link = idMap.get(t.id);
                if (link && link.closest('.toc-sub-item')) { activeId = t.id; break; }
            }
            /* Fall back to any visible target (section or static) */
            if (!activeId)
            {
                for (const t of targets) { if (visibleSet.has(t.id)) { activeId = t.id; break; } }
            }
            if (!activeId) return;

            const link = idMap.get(activeId);
            if (!link) return;

            link.classList.add('toc-active');

            /* Find which collapsible section contains this link */
            const parentLi = link.closest('li.toc-collapsible');

            /* Mark parent section link with softer parent-active (when a sub-item is active) */
            if (parentLi)
            {
                const parentLink = parentLi.querySelector(':scope > a');
                if (parentLink && parentLink !== link) parentLink.classList.add('toc-parent-active');
            }

            /* Auto-collapse/expand: only the active section stays open.
               When Features is active, also keep Getting Started expanded
               since its items are auto-expanded and visually contiguous. */
            const featuresActive = activeId === 'features';
            const gettingStartedLi = featuresActive
                ? nav.querySelector('a[href="#section-getting-started"]')?.closest('li.toc-collapsible')
                : null;

            nav.querySelectorAll('li.toc-collapsible').forEach(li =>
            {
                if (li === parentLi || li === gettingStartedLi) li.classList.remove('toc-collapsed');
                else li.classList.add('toc-collapsed');
            });

            /* Keep active link visible in sidebar scroll */
            const navEl = link.closest('nav');
            if (navEl && navEl.scrollHeight > navEl.clientHeight)
            {
                const linkRect = link.getBoundingClientRect();
                const navRect = navEl.getBoundingClientRect();
                if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom)
                {
                    link.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            }
        }
    }
}

/* -- Scroll Progress Bar ----------------------------------- */

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

/* -- Floating Back-to-Top FAB ------------------------------ */

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
        histPushHash(window.location.pathname);
    });
}

/* -- Exported helpers -------------------------------------- */

export function refreshScrollSpy()
{
    if (_scrollSpySetup) _scrollSpySetup();
}

export function expandTocForId(id)
{
    const nav = document.querySelector('.toc-sidebar nav');
    if (!nav) return;

    const link = nav.querySelector('a[href="#' + id + '"]');
    if (link)
    {
        const parentLi = link.closest('.toc-collapsible');
        if (parentLi) parentLi.classList.remove('toc-collapsed');
    }
    else
    {
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

export function scrollToId(id)
{
    if (id === 'features') { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    const target = document.getElementById(id);
    if (!target) return;

    /* Expand the target's doc-item card */
    const docItem = target.closest('.doc-item') || (target.classList.contains('doc-item') ? target : null);
    if (docItem) docItem.classList.add('doc-item-expanded');

    let d = target.closest('details');
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }

    expandTocForId(id);

    document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card')
        .forEach(s => s.style.contentVisibility = 'visible');

    void document.documentElement.offsetHeight;
    const y = target.getBoundingClientRect().top + window.scrollY - _resolveTopOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
}

/* -- Boot --------------------------------------------------- */

export function initUI()
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
}
