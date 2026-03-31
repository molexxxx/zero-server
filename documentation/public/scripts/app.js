/**
 * app.js  (boot file)
 * Lean entry point — wires together all documentation modules.
 *
 * Module load order (all <script defer>):
 *   helpers.js        → DOM selectors, formatters, Prism helpers
 *   charts.js         → svgRing, barColor, buildSunburst
 *   badges.js         → initBadges()
 *   modals.js         → openBadgeModal, renderTestsModal, renderCoverageModal
 *   uploads.js        → initUploads()
 *   playground.js     → initPlayground()
 *   proxy.js          → initProxy()
 *   data-sections.js  → loadDocs()
 *   app.js            → this file (boot)
 */

document.addEventListener('DOMContentLoaded', () =>
{
    /* De-indent and highlight static <pre> blocks */
    try { dedentAllPre(); } catch (e) { }
    try { highlightAllPre(); } catch (e) { }

    /* Accordion click handling (open/close <details> manually) */
    try
    {
        document.querySelectorAll('details.acc summary').forEach(summary =>
        {
            if (summary.dataset.miniExpressSummary === '1') return;
            summary.dataset.miniExpressSummary = '1';
            summary.addEventListener('click', (ev) =>
            {
                ev.preventDefault();
                const details = summary.parentElement;
                if (details) details.open = !details.open;
            });
        });
    } catch (e) { }

    /* Feature modules */
    initUploads();
    initPlayground();
    initProxy();

    /* Mark app as ready so scroll-into-view helpers only fire after init */
    setTimeout(() => { window._appReady = true; }, 2000);

    /* Copy-to-clipboard for info banner */
    const copyBtn = document.getElementById('cloneCopyBtn');
    const copySource = document.getElementById('cloneCmd');
    if (copyBtn && copySource) {
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(copySource.textContent).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            }).catch(() => {
                copyBtn.textContent = 'Failed';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            });
        });
    }

    /* Data-driven documentation sections */
    loadDocs().catch(() => {});

    /* Badge strip + version badge + modal wiring */
    initBadges();
});
