/**
 * boot.js – Application entry point.
 * Imports all ESM modules, wires late bindings, and boots the app.
 */

/* -- Core -------------------------------------------------- */

import { $$, dedentAllPre, highlightAllPre } from './core/helpers.js';
import { registerScrollHandler, histPushAccordion } from './core/history.js';

/* -- UI ---------------------------------------------------- */

import { initUI, scrollToId } from './ui/shell.js';
import { initCustomSelects } from './ui/select.js';
import { initSearch } from './ui/search.js';
import { initBadges } from './ui/badges.js';
import { initVersionSelector, registerVersionLoadDocs } from './ui/version-selector.js';

/* -- Canvas ------------------------------------------------ */

import { initWaves } from './ui/canvas/waves.js';
import { initHeroCanvas } from './ui/canvas/hero.js';
import { initNetworkCanvas } from './ui/canvas/network.js';
import { initSignalsCanvas } from './ui/canvas/signals.js';

/* -- Docs -------------------------------------------------- */

import { loadDocs } from './docs/sections.js';

/* -- Playground -------------------------------------------- */

import { initEcho } from './playground/echo.js';
import { initWsChat } from './playground/websocket.js';
import { initSseViewer } from './playground/sse.js';
import { initTasks } from './playground/tasks.js';
import { initBlog } from './playground/blog.js';
import { initCookies } from './playground/cookies.js';
import { initUploads } from './playground/uploads.js';
import { initProxy } from './playground/proxy.js';

/* -- Late Bindings ----------------------------------------- */

registerScrollHandler(scrollToId);
registerVersionLoadDocs(loadDocs);

/* -- Boot -------------------------------------------------- */

function boot()
{
    // UI shell (theme, bento, TOC, scroll-spy, progress, FAB)
    initUI();
    initCustomSelects();

    // De-indent and highlight static <pre> blocks
    try { dedentAllPre(); } catch (e) { }
    try { highlightAllPre(); } catch (e) { }

    // Reveal the page
    document.documentElement.classList.add('app-revealed');

    // Accordion click handling
    $$('details.acc summary').forEach(summary =>
    {
        if (summary.dataset.miniExpressSummary === '1') return;
        summary.dataset.miniExpressSummary = '1';
        summary.addEventListener('click', (ev) =>
        {
            ev.preventDefault();
            const details = summary.parentElement;
            if (details)
            {
                details.open = !details.open;
                if (details.id) histPushAccordion(details.id, details.open);
            }
        });
    });

    // Playground modules
    initEcho();
    initWsChat();
    initSseViewer();
    initTasks();
    initBlog();
    initCookies();
    initUploads();
    initProxy();

    // Mark app ready after a short delay
    setTimeout(() => { window._appReady = true; }, 2000);

    // Copy-to-clipboard for info banner
    const copyBtn = document.getElementById('cloneCopyBtn');
    const copySource = document.getElementById('cloneCmd');
    if (copyBtn && copySource)
    {
        copyBtn.addEventListener('click', () =>
        {
            navigator.clipboard.writeText(copySource.textContent).then(() =>
            {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            }).catch(() =>
            {
                copyBtn.textContent = 'Failed';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            });
        });
    }

    // Documentation sections + search + badges + version selector
    initVersionSelector().then(ver =>
    {
        window._docsVersion = ver;
        loadDocs(ver).catch(() => {});
        initBadges();
    }).catch(() => { loadDocs().catch(() => {}); initBadges(); });
    initSearch();

    // Canvas animations
    initWaves();
    initHeroCanvas();
    initNetworkCanvas();
    initSignalsCanvas();
}

if (document.readyState === 'loading')
{
    document.addEventListener('DOMContentLoaded', boot);
}
else
{
    boot();
}
