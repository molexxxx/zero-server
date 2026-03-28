/**
 * app.js  (entry point)
 * Single DOMContentLoaded handler that bootstraps every documentation feature.
 * Each section is initialised by calling into the module that owns it:
 *
 *   helpers.js        → DOM selectors, formatters, Prism helpers
 *   uploads.js        → initUploads()
 *   playground.js     → initPlayground()
 *   proxy.js          → initProxy()
 *   data-sections.js  → loadApiReference(), loadOptions(), loadExamples()
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

    /* Data-driven documentation sections */
    loadDocs().catch(() => {});

    /* Fetch and display package version */
    fetch('/api/version').then(r => r.json()).then(d =>
    {
        const badge = document.getElementById('version-badge');
        if (badge && d.version) badge.textContent = 'v' + d.version;
    }).catch(() => {});
});
