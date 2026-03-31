/**
 * modals.js — Badge detail modals (tests + coverage).
 *
 * Depends on: charts.js (svgRing, barColor, buildSunburst)
 *
 * Exposes:
 *   window.openBadgeModal(id)
 *   window.renderTestsModal(data)
 *   window.renderCoverageModal(data)
 */

/* -- Generic modal open/close ---------------------------------- */

function openBadgeModal(id)
{
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.setAttribute('aria-hidden', 'false');

    const close = () => { overlay.setAttribute('aria-hidden', 'true'); };
    overlay.querySelector('.badge-modal-close').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

/* -- Tests modal ----------------------------------------------- */

function renderTestsModal(data)
{
    const body = document.getElementById('tests-modal-body');
    if (!body) return;

    const t = data.raw.tests;
    const suites = data.raw.testSuites || [];
    const passRate = t.total ? Math.round(t.passed / t.total * 100) : 0;
    const totalDur = suites.reduce((s, x) => s + x.duration, 0);

    /* Stat cards */
    let html = `<div class="sb-stats tm-stats">
        <div class="sb-stat sb-stat-green"><div class="sb-stat-val">${t.passed.toLocaleString()}</div><div class="sb-stat-lbl">passed</div></div>
        <div class="sb-stat sb-stat-red"><div class="sb-stat-val">${t.failed}</div><div class="sb-stat-lbl">failed</div></div>
        <div class="sb-stat sb-stat-blue"><div class="sb-stat-val">${suites.length}</div><div class="sb-stat-lbl">suites</div></div>
        <div class="sb-stat sb-stat-dim"><div class="sb-stat-val">${(totalDur / 1000).toFixed(1)}s</div><div class="sb-stat-lbl">duration</div></div>
    </div>`;

    /* Pass rate bar */
    html += `<div class="tm-rate">
        <div class="tm-rate-header"><span class="tm-rate-pct">${passRate}%</span> <span class="tm-rate-label">pass rate</span></div>
        <div class="tm-rate-track"><div class="tm-rate-fill" style="width:${passRate}%"></div></div>
    </div>`;

    /* Horizontal bar chart: tests per suite */
    if (suites.length)
    {
        const sorted = [...suites].sort((a, b) => b.tests - a.tests);
        const maxT = sorted[0].tests || 1;

        html += `<div class="tm-bars">`;
        sorted.forEach((s, i) => {
            const pct = (s.tests / maxT * 100).toFixed(1);
            const col = s.status === 'passed' ? '#3fb950' : '#f85149';
            const label = s.file.replace(/\.test\.js$/, '').replace(/^test[/\\]/, '');
            const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const delay = Math.min(i * 0.02, 0.6).toFixed(2);
            html += `<div class="tm-bar-row" style="animation-delay:${delay}s">
                <span class="tm-bar-label" title="${s.file}">${safe}</span>
                <div class="tm-bar-track"><div class="tm-bar-fill" style="width:${pct}%;background:${col}"></div></div>
                <span class="tm-bar-val">${s.tests}</span>
            </div>`;
        });
        html += `</div>`;
    }

    body.innerHTML = html;
}

/* -- Coverage modal -------------------------------------------- */

function renderCoverageModal(data)
{
    const body = document.getElementById('coverage-modal-body');
    if (!body) return;

    const c = data.raw.coverage;
    const files = data.raw.coverageFiles || [];

    const metrics = [
        { label: 'Statements', pct: c.statements, color: barColor(c.statements) },
        { label: 'Branches',   pct: c.branches,   color: barColor(c.branches) },
        { label: 'Functions',  pct: c.functions,   color: barColor(c.functions) },
        { label: 'Lines',      pct: c.lines,       color: barColor(c.lines) },
    ];

    /* Compute overall average for center label */
    const overallPct = Math.round((c.statements + c.branches + c.functions + c.lines) / 4 * 100) / 100;

    /* Sunburst segments */
    const segs = [];
    // Inner ring: 4 metric arcs — each occupies its own 90° quadrant with a
    // symmetric gap on both sides, so all 4 gaps appear as clean separators.
    const innerGap = 6;
    metrics.forEach((m, i) => {
        const a0 = i * 90 + innerGap / 2;
        const span = (m.pct / 100) * (90 - innerGap);
        segs.push({
            r: 55, a0, a1: a0 + span, color: m.color, w: 14, cap: 'butt',
            cls: 'sb-arc-inner',
            dataLabel: m.label, dataPct: m.pct.toFixed(2),
            title: `${m.label}: ${m.pct}%`,
        });
    });
    // Outer ring: per-file segments
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
                dataLabel: f.file, dataPct: f.statements,
                title: `${safe} — ${f.statements}%`,
            });
        });
    }

    /* Legend box (top-right of chart, updates on hover) */
    const legendId = 'sb-legend-' + Date.now();
    let html = `<div class="sb-wrap-outer"><div class="sb-wrap">${buildSunburst(segs, overallPct + '%', 'overall coverage', 300)}</div><div class="sb-legend" id="${legendId}"><span class="sb-legend-hint">Hover chart for details</span></div></div>`;

    /* Wire hover → legend update after insert */
    setTimeout(() => {
        const legend = document.getElementById(legendId);
        const svg = body.querySelector('.sb-sunburst');
        if (!svg || !legend) return;
        const hint = '<span class="sb-legend-hint">Hover chart for details</span>';

        svg.querySelectorAll('.sb-arc-inner, .sb-arc-outer').forEach(arc => {
            arc.addEventListener('mouseenter', () => {
                const lbl = arc.getAttribute('data-label') || '';
                const pct = arc.getAttribute('data-pct') || '';
                const color = arc.getAttribute('stroke') || 'var(--text)';
                legend.innerHTML = `<span class="sb-legend-dot" style="background:${color}"></span><span class="sb-legend-name">${lbl}</span><span class="sb-legend-pct">${pct}%</span>`;
            });
            arc.addEventListener('mouseleave', () => {
                legend.innerHTML = hint;
            });
        });
    }, 0);

    /* Stat cards */
    html += `<div class="sb-stats">`;
    metrics.forEach(m => {
        const cls = m.pct >= 90 ? 'sb-stat-green' : m.pct >= 75 ? 'sb-stat-blue' : m.pct >= 60 ? 'sb-stat-yellow' : 'sb-stat-red';
        html += `<div class="sb-stat ${cls}"><div class="sb-stat-val">${m.pct}%</div><div class="sb-stat-lbl">${m.label}</div></div>`;
    });
    html += `</div>`;

    /* File table */
    if (files.length)
    {
        const groups = {};
        files.forEach(f => {
            const parts = f.file.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            (groups[dir] = groups[dir] || []).push(f);
        });

        html += `<table class="bm-table"><thead><tr><th>File</th><th style="text-align:right">Stmts</th><th style="text-align:right">Branch</th><th style="text-align:right">Funcs</th><th></th></tr></thead><tbody>`;
        Object.keys(groups).sort().forEach(dir => {
            html += `<tr class="bm-group-head"><td colspan="5">${dir}/</td></tr>`;
            groups[dir].forEach(f => {
                const name = f.file.split('/').pop();
                const color = barColor(f.statements);
                html += `<tr>
                    <td class="bm-file">${name}</td>
                    <td class="bm-pct" style="color:${barColor(f.statements)}">${f.statements}%</td>
                    <td class="bm-pct" style="color:${barColor(f.branches)}">${f.branches}%</td>
                    <td class="bm-pct" style="color:${barColor(f.functions)}">${f.functions}%</td>
                    <td class="bm-bar-cell"><div class="bm-bar"><div class="bm-bar-fill" style="width:${f.statements}%;background:${color}"></div></div></td>
                </tr>`;
            });
        });
        html += `</tbody></table>`;
    }

    body.innerHTML = html;
}

/* Expose globally */
window.openBadgeModal      = openBadgeModal;
window.renderTestsModal    = renderTestsModal;
window.renderCoverageModal = renderCoverageModal;
