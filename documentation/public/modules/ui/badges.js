/**
 * ui/badges.js
 * Badge strip rendering & badge data fetching.
 */

import { openBadgeModal, renderTestsModal, renderCoverageModal } from './modals.js';
import { getSelectedVersion } from './version-selector.js';

export function initBadges()
{
    const _v = window.__v ? `?v=${window.__v}` : '';
    const ver = getSelectedVersion() || window._docsVersion;
    const badgesUrl = ver
        ? `/data/versions/${encodeURIComponent(ver)}/badges.json${_v}`
        : `/data/badges.json${_v}`;

    const badgesP = fetch(badgesUrl).then(r => r.json()).catch(() => null);

    badgesP.then(badgeData =>
    {

        const strip = document.getElementById('badgeStrip');
        if (!strip) return;
        strip.innerHTML = '';

        const items = [
            { label: 'license',      value: 'MIT',  color: 'blue',  href: 'https://github.com/tonywied17/zero-http/blob/main/LICENSE' },
            { label: 'node',         value: '≥ 18', color: 'green', href: 'https://nodejs.org' },
            { label: 'dependencies', value: '0',    color: 'green', href: 'https://www.npmjs.com/package/zero-http?activeTab=dependencies' },
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
