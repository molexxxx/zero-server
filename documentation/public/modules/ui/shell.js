/**
 * ui/shell.js
 * Shell UI behaviours — theme toggle, bento grid glow, TOC sidebar,
 * smooth-scroll, scroll-spy, progress bar, FAB.
 */

import { histPushHash, histPushAccordion } from '../core/history.js';

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
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('zero-theme', theme);
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
            section.querySelectorAll('.bento-card').forEach(c => glowTargets.push(c));
            glowTargets.push(toggle);
        });
    }
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
        scrollToId(hash.slice(1));
        document.body.classList.remove('toc-open');

        const parentLi = a.closest('.toc-collapsible');
        if (parentLi) parentLi.classList.remove('toc-collapsed');

        const btn = document.querySelector('.toc-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'false');
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
    const topBtn = document.getElementById('toc-top-btn');
    const toggleBtn = document.getElementById('toc-toggle-acc');
    if (!topBtn && !toggleBtn) return;

    const brandBtn = document.getElementById('brand-top');

    [topBtn, brandBtn].forEach(el =>
    {
        if (!el) return;
        el.addEventListener('click', (e) =>
        {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            histPushHash(window.location.pathname);
        });
    });

    if (toggleBtn)
    {
        let expanded = true;
        toggleBtn.classList.add('acc-expanded');

        toggleBtn.addEventListener('click', () =>
        {
            expanded = !expanded;

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

/* -- TOC Collapsible Categories ---------------------------- */

export function initTocCollapsible()
{
    const items = document.querySelectorAll('.toc-collapsible');
    items.forEach(li =>
    {
        if (li.querySelector('.toc-collapse-btn')) return;

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

        const targets = document.querySelectorAll('.doc-section, .doc-item, [id="features"], [id="playground"]');
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
        }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });

        window._scrollSpyObserver = observer;
        targets.forEach(t => { if (t.id) observer.observe(t); });

        function updateActiveLink()
        {
            nav.querySelectorAll('.toc-active').forEach(el => el.classList.remove('toc-active'));

            if (!visibleSet.size) return;

            let activeId = null;
            for (const t of targets)
            {
                if (visibleSet.has(t.id)) { activeId = t.id; break; }
            }
            if (!activeId) return;

            const link = nav.querySelector(`a[href="#${activeId}"]`);
            if (link)
            {
                link.classList.add('toc-active');
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
    const target = document.getElementById(id);
    if (!target) return;

    let d = target.closest('details');
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }

    expandTocForId(id);

    document.querySelectorAll('.doc-section,.card.play-card,.card.upload-card,.card.proxy-card')
        .forEach(s => s.style.contentVisibility = 'visible');

    void document.documentElement.offsetHeight;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
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
