/**
 * badges.js — Badge strip rendering & badge data.
 *
 * Depends on: charts.js (barColor)
 *
 * Exposes:
 *   window.initBadges()  – called from app.js boot
 */

function initBadges()
{
    const versionP = fetch('/api/version').then(r => r.json()).then(d =>
    {
        const badge = document.getElementById('version-badge');
        if (badge && d.version) badge.textContent = 'v' + d.version;
        return d.version || '';
    }).catch(() => '');

    const badgesP = fetch('/data/badges.json').then(r => r.json()).catch(() => null);

    Promise.allSettled([versionP, badgesP]).then(([vRes, bRes]) =>
    {
        const badgeData = bRes.status === 'fulfilled' ? bRes.value : null;

        const strip = document.getElementById('badgeStrip');
        if (!strip) return;
        strip.innerHTML = '';

        const items = [
            { label: 'license',      value: 'MIT',  color: 'blue',  href: 'https://opensource.org/licenses/MIT' },
            { label: 'node',         value: '≥ 14', color: 'green', href: 'https://nodejs.org' },
            { label: 'dependencies', value: '0',    color: 'green', href: 'https://github.com/tonywied17/zero-http' },
        ];

        if (badgeData)
        {
            items.push({
                label: 'tests',
                value: badgeData.tests.message,
                color: badgeData.tests.color === 'brightgreen' ? 'green' : 'red',
                modal: 'tests-modal',
            });
            items.push({
                label: 'coverage',
                value: badgeData.coverage.message,
                color: badgeData.coverage.color === 'brightgreen' || badgeData.coverage.color === 'green' ? 'green' : badgeData.coverage.color === 'yellowgreen' ? 'yellow' : 'red',
                modal: 'coverage-modal',
            });
        }

        items.forEach(({ label, value, color, href, modal }) =>
        {
            if (!value) return;
            const el = document.createElement(modal ? 'button' : 'a');
            el.className = 'site-badge';
            if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
            if (modal) { el.type = 'button'; el.dataset.modal = modal; }
            el.innerHTML = `<span class="site-badge-label">${label}</span><span class="site-badge-value site-badge-${color}">${value}</span>`;
            strip.appendChild(el);
        });

        /* Wire modal open for tests/coverage badges */
        strip.addEventListener('click', (e) =>
        {
            const btn = e.target.closest('[data-modal]');
            if (!btn) return;
            e.preventDefault();
            const modalId = btn.dataset.modal;
            if (modalId === 'tests-modal' && badgeData) renderTestsModal(badgeData);
            if (modalId === 'coverage-modal' && badgeData) renderCoverageModal(badgeData);
            openBadgeModal(modalId);
        });
    });
}

window.initBadges = initBadges;
