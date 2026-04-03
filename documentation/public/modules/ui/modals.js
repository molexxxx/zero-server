/**
 * ui/modals.js
 * Badge detail modals (tests + coverage).
 */

import { histPushModal, histCloseModal } from '../core/history.js';
import { barColor, buildSunburst } from './charts.js';

export function openBadgeModal(id)
{
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.setAttribute('aria-hidden', 'false');
    histPushModal(id);

    const close = () => histCloseModal(id);
    overlay.querySelector('.badge-modal-close').onclick = close;

    if (overlay._modalClickHandler)
        overlay.removeEventListener('click', overlay._modalClickHandler);
    overlay._modalClickHandler = (e) => { if (e.target === overlay) close(); };
    overlay.addEventListener('click', overlay._modalClickHandler);

    if (overlay._modalKeyHandler)
        document.removeEventListener('keydown', overlay._modalKeyHandler);
    overlay._modalKeyHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', overlay._modalKeyHandler); } };
    document.addEventListener('keydown', overlay._modalKeyHandler);
}

export function renderTestsModal(data)
{
    const body = document.getElementById('tests-modal-body');
    if (!body) return;

    const t = data.raw.tests;
    const suites = data.raw.testSuites || [];
    const passRate = t.total ? Math.round(t.passed / t.total * 100) : 0;
    const totalDur = suites.reduce((s, x) => s + x.duration, 0);

    let html = `<div class="tm-body">`;

    html += `<div class="sb-stats tm-stats">
        <div class="sb-stat sb-stat-green"><div class="sb-stat-val">${t.passed.toLocaleString()}</div><div class="sb-stat-lbl">passed</div></div>
        <div class="sb-stat sb-stat-red"><div class="sb-stat-val">${t.failed}</div><div class="sb-stat-lbl">failed</div></div>
        <div class="sb-stat sb-stat-blue"><div class="sb-stat-val">${suites.length}</div><div class="sb-stat-lbl">suites</div></div>
        <div class="sb-stat sb-stat-dim"><div class="sb-stat-val">${(totalDur / 1000).toFixed(1)}s</div><div class="sb-stat-lbl">duration</div></div>
    </div>`;

    html += `<div class="tm-rate">
        <div class="tm-rate-header"><span class="tm-rate-pct">${passRate}%</span> <span class="tm-rate-label">pass rate</span></div>
        <div class="tm-rate-track"><div class="tm-rate-fill" style="width:${passRate}%"></div></div>
    </div>`;

    if (suites.length)
    {
        const groups = new Map();
        for (const s of suites) {
            const dir = s.file.split('/')[0];
            if (!groups.has(dir)) groups.set(dir, []);
            groups.get(dir).push(s);
        }

        const sorted = [...groups.entries()].sort((a, b) => {
            const aFail = a[1].some(x => x.status !== 'passed') ? 1 : 0;
            const bFail = b[1].some(x => x.status !== 'passed') ? 1 : 0;
            if (bFail !== aFail) return bFail - aFail;
            return b[1].reduce((s, x) => s + x.tests, 0) - a[1].reduce((s, x) => s + x.tests, 0);
        });

        html += `<div class="tm-sections">`;
        sorted.forEach(([dir, group], gi) => {
            const groupTotal  = group.reduce((s, x) => s + x.tests, 0);
            const groupFailed = group.filter(x => x.status !== 'passed').length;
            const statusCls   = groupFailed > 0 ? 'fail' : 'pass';
            const delay       = Math.min(gi * 0.045, 0.45).toFixed(2);
            const safeDir     = dir.replace(/&/g, '&amp;');

            html += `<div class="tm-section" style="animation-delay:${delay}s">
                <div class="tm-section-head">
                    <span class="tm-section-dot tm-section-dot-${statusCls}"></span>
                    <span class="tm-section-name">${safeDir}</span>
                    <span class="tm-section-meta">${group.length} suite${group.length !== 1 ? 's' : ''}</span>
                    <span class="tm-section-count">${groupTotal.toLocaleString()} tests</span>
                </div>`;

            group.forEach(s => {
                const fileName = s.file.replace(dir + '/', '').replace(/\.test\.js$/, '');
                const safeName = fileName.replace(/&/g, '&amp;').replace(/</g, '&lt;');
                const dot = s.status === 'passed' ? '#3fb950' : '#f85149';
                const durSec = (s.duration / 1000).toFixed(2);

                html += `<div class="tm-suite-row">
                    <span class="tm-suite-dot" style="background:${dot}"></span>
                    <span class="tm-suite-name" title="${s.file}">${safeName}</span>
                    <span class="tm-suite-dur">${durSec}s</span>
                    <span class="tm-suite-count">${s.tests}</span>
                </div>`;
            });

            html += `</div>`;
        });
        html += `</div>`;
    }

    html += `</div>`;
    body.innerHTML = html;
}

export function renderCoverageModal(data)
{
    const body = document.getElementById('coverage-modal-body');
    if (!body) return;

    const c = data.raw.coverage;
    const files = data.raw.coverageFiles || [];
    const fmtPct = (v) => Number(v).toFixed(2);

    const metrics = [
        { label: 'Statements', pct: c.statements, color: barColor(c.statements) },
        { label: 'Branches',   pct: c.branches,   color: barColor(c.branches) },
        { label: 'Functions',  pct: c.functions,   color: barColor(c.functions) },
        { label: 'Lines',      pct: c.lines,       color: barColor(c.lines) },
    ];

    const overallPct = c.statements;

    const segs = [];
    const innerGap = 6;
    metrics.forEach((m, i) => {
        const a0 = i * 90 + innerGap / 2;
        const span = (m.pct / 100) * (90 - innerGap);
        segs.push({
            r: 55, a0, a1: a0 + span, color: m.color, w: 14, cap: 'butt',
            cls: 'sb-arc-inner',
            dataLabel: m.label, dataPct: fmtPct(m.pct),
            title: `${m.label}: ${fmtPct(m.pct)}%`,
        });
    });
    if (files.length) {
        const sorted = [...files].sort((a, b) => b.statements - a.statements);
        const totalW = files.length;
        const segW = 360 / totalW;
        const segGap = files.length > 20 ? 0.5 : 1;
        sorted.forEach((f, i) => {
            const a0 = i * segW + segGap / 2, a1 = (i + 1) * segW - segGap / 2;
            const safe = f.file.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            segs.push({
                r: 100, a0, a1, color: barColor(f.statements), w: 28,
                opacity: (0.3 + 0.7 * f.statements / 100).toFixed(2),
                cls: 'sb-arc-outer',
                dataLabel: f.file, dataPct: fmtPct(f.statements),
                title: `${safe} — ${fmtPct(f.statements)}%`,
            });
        });
    }

    const legendId = 'sb-legend-' + Date.now();
    const pinTrayId = 'sb-pin-tray-' + Date.now();
    const chartSize = 380;
    let html = `<div class="tm-body"><div class="sb-wrap-outer"><div class="sb-wrap">${buildSunburst(segs, fmtPct(overallPct) + '%', 'overall coverage', chartSize)}</div><div class="sb-legend" id="${legendId}"><span class="sb-legend-hint">Hover chart for details</span></div></div><div class="sb-pin-tray" id="${pinTrayId}"></div>`;

    setTimeout(() => {
        const legend = document.getElementById(legendId);
        const pinTray = document.getElementById(pinTrayId);
        const svg = body.querySelector('.sb-sunburst');
        const groupsEl = body.querySelector('.cf-groups');
        if (!svg || !legend) return;

        const hint = '<span class="sb-legend-hint">Hover chart for details</span>';
        const pinnedArcs = new Set();
        const metricClass = {
            Statements: 'cf-metric-statements',
            Branches: 'cf-metric-branches',
            Functions: 'cf-metric-functions',
            Lines: 'cf-metric-lines',
        };

        const esc = (v) => String(v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const arcHTML = (arc) => {
            const lbl   = arc.getAttribute('data-label') || '';
            const pct   = arc.getAttribute('data-pct')   || '';
            const color = arc.getAttribute('stroke')      || 'var(--text)';
            return `<span class="sb-legend-dot" style="background:${color}"></span><span class="sb-legend-name">${esc(lbl)}</span><span class="sb-legend-pct">${pct}%</span>`;
        };

        const applyPinnedHighlights = () => {
            const rows = body.querySelectorAll('.cf-file-row');
            rows.forEach(r => r.classList.remove('is-pinned-file'));
            if (groupsEl) groupsEl.classList.remove('cf-metric-statements', 'cf-metric-branches', 'cf-metric-functions', 'cf-metric-lines');

            pinnedArcs.forEach(arc => {
                if (arc.classList.contains('sb-arc-outer')) {
                    const filePath = arc.getAttribute('data-label') || '';
                    rows.forEach(row => {
                        if (row.getAttribute('data-file-path') === filePath) row.classList.add('is-pinned-file');
                    });
                }
                if (groupsEl && arc.classList.contains('sb-arc-inner')) {
                    const lbl = arc.getAttribute('data-label') || '';
                    const cls = metricClass[lbl];
                    if (cls) groupsEl.classList.add(cls);
                }
            });
        };

        const renderPinTray = () => {
            if (!pinTray) return;
            if (!pinnedArcs.size) { pinTray.innerHTML = ''; return; }
            const chips = [...pinnedArcs].map(arc => {
                const lbl = arc.getAttribute('data-label') || '';
                const color = arc.getAttribute('stroke') || 'var(--text)';
                const kind = arc.classList.contains('sb-arc-inner') ? 'inner' : 'outer';
                return `<button class="sb-pin-chip" data-kind="${kind}" data-label="${esc(lbl)}" title="Unpin ${esc(lbl)}"><span class="sb-pin-chip-dot" style="background:${color}"></span><span class="sb-pin-chip-name">${esc(lbl)}</span><span class="sb-pin-chip-x">x</span></button>`;
            }).join('');
            pinTray.innerHTML = `<span class="sb-pin-tray-label">Pinned</span>${chips}<button class="sb-pin-clear" data-clear-pins="1">Clear</button>`;
        };

        svg.querySelectorAll('.sb-arc-inner, .sb-arc-outer').forEach(arc => {
            arc.addEventListener('mouseenter', () => { legend.innerHTML = arcHTML(arc); });
            arc.addEventListener('mouseleave', () => { legend.innerHTML = hint; });
            arc.addEventListener('click', (e) => {
                e.stopPropagation();
                if (pinnedArcs.has(arc)) { pinnedArcs.delete(arc); arc.removeAttribute('data-pinned'); }
                else { pinnedArcs.add(arc); arc.setAttribute('data-pinned', 'true'); }
                applyPinnedHighlights();
                renderPinTray();
                legend.innerHTML = hint;
            });
        });

        if (pinTray) {
            pinTray.addEventListener('click', (e) => {
                const clearBtn = e.target.closest('[data-clear-pins="1"]');
                if (clearBtn) {
                    pinnedArcs.forEach(a => a.removeAttribute('data-pinned'));
                    pinnedArcs.clear();
                    applyPinnedHighlights();
                    renderPinTray();
                    legend.innerHTML = hint;
                    return;
                }
                const chip = e.target.closest('.sb-pin-chip');
                if (!chip) return;
                const lbl = chip.getAttribute('data-label') || '';
                const kind = chip.getAttribute('data-kind') || '';
                const match = [...pinnedArcs].find(a => {
                    const sameLabel = (a.getAttribute('data-label') || '') === lbl;
                    const sameKind = kind === 'inner' ? a.classList.contains('sb-arc-inner') : a.classList.contains('sb-arc-outer');
                    return sameLabel && sameKind;
                });
                if (match) {
                    pinnedArcs.delete(match);
                    match.removeAttribute('data-pinned');
                    applyPinnedHighlights();
                    renderPinTray();
                    legend.innerHTML = hint;
                }
            });
        }
    }, 0);

    html += `<div class="sb-stats">`;
    metrics.forEach(m => {
        const cls = m.pct >= 90 ? 'sb-stat-green' : m.pct >= 75 ? 'sb-stat-blue' : m.pct >= 60 ? 'sb-stat-yellow' : 'sb-stat-red';
        html += `<div class="sb-stat ${cls}"><div class="sb-stat-val">${fmtPct(m.pct)}%</div><div class="sb-stat-lbl">${m.label}</div></div>`;
    });
    html += `</div>`;

    if (files.length)
    {
        const groups = {};
        files.forEach(f => {
            const parts = f.file.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            (groups[dir] = groups[dir] || []).push(f);
        });

        html += `<div class="cf-groups">`;
        Object.keys(groups).sort().forEach(dir => {
            const grpFiles = groups[dir];
            const grpAvg = grpFiles.reduce((s, f) => s + (f.statements + f.branches + f.functions) / 3, 0) / grpFiles.length;
            html += `<div class="cf-group">
                <div class="cf-group-head">
                    <span class="cf-dir">${dir}/</span>
                    <span class="cf-group-avg" style="color:${barColor(grpAvg)}">${fmtPct(grpAvg)}%</span>
                </div>`;
            grpFiles.forEach(f => {
                const name = f.file.split('/').pop();
                const safeFilePath = String(f.file).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const safeName = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const avg = (f.statements + f.branches + f.functions) / 3;
                const dot = barColor(avg);
                html += `<div class="cf-file-row" data-file-path="${safeFilePath}" title="${safeFilePath}">
                    <span class="cf-health-dot" style="background:${dot}"></span>
                    <span class="cf-filename">${safeName}</span>
                    <div class="cf-chips">
                        <span class="cf-chip cf-chip-stmts"><span class="cf-chip-lbl">S</span><span class="cf-chip-val" style="color:${barColor(f.statements)}">${fmtPct(f.statements)}%</span></span>
                        <span class="cf-chip cf-chip-branches"><span class="cf-chip-lbl">B</span><span class="cf-chip-val" style="color:${barColor(f.branches)}">${fmtPct(f.branches)}%</span></span>
                        <span class="cf-chip cf-chip-functions"><span class="cf-chip-lbl">F</span><span class="cf-chip-val" style="color:${barColor(f.functions)}">${fmtPct(f.functions)}%</span></span>
                    </div>
                    <div class="cf-bar-wrap"><div class="cf-bar-fill" style="width:${avg.toFixed(2)}%;background:${dot}"></div></div>
                </div>`;
            });
            html += `</div>`;
        });
        html += `</div>`;
    }

    html += `</div>`;
    body.innerHTML = html;
}
