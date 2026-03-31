/**
 * charts.js — SVG chart helpers (donut rings, sunburst, bar-color scale)
 *
 * Exposes:
 *   window.svgRing(pct, color, size?, stroke?)   → SVG string
 *   window.barColor(pct)                         → hex color
 *   window.buildSunburst(segments, centerPct, centerLabel, size?) → SVG string
 */

/** Color thresholds for coverage/pass percentages. */
function barColor(pct)
{
    if (pct >= 90) return '#3fb950';
    if (pct >= 75) return '#58a6ff';
    if (pct >= 60) return '#d29922';
    return '#f85149';
}

/** Build an SVG donut/ring chart. Returns an SVG string. */
function svgRing(pct, color, size, stroke)
{
    size = size || 140;
    stroke = stroke || 10;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - pct / 100);
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${stroke}"/>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
            stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"
            transform="rotate(-90 ${size/2} ${size/2})" style="transition:stroke-dashoffset .5s ease"/>
    </svg>`;
}

/**
 * Reusable SVG sunburst builder.
 * @param {Array} segments  – [{r, a0, a1, color, w, cap?, opacity?, title?, cls?}]
 * @param {string} centerPct  – large centre text
 * @param {string} centerLabel – small sub-label
 * @param {number} [size=300]
 * @returns {string} SVG markup
 */
function buildSunburst(segments, centerPct, centerLabel, size)
{
    const S = size || 300, C = S / 2;

    const pt = (r, deg) => {
        const a = (deg - 90) * Math.PI / 180;
        return [C + r * Math.cos(a), C + r * Math.sin(a)];
    };

    const arc = (r, d0, d1, color, w, opts) => {
        opts = opts || {};
        const span = d1 - d0;
        if (span < 0.3) return '';
        let d;
        if (span >= 359.99) {
            const [x1, y1] = pt(r, 0), [x2, y2] = pt(r, 180);
            d = `M${x1} ${y1}A${r} ${r} 0 1 1 ${x2} ${y2}A${r} ${r} 0 1 1 ${x1} ${y1}`;
        } else {
            const [x1, y1] = pt(r, d0), [x2, y2] = pt(r, d1);
            d = `M${x1} ${y1}A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x2} ${y2}`;
        }
        const cap = opts.cap || 'butt';
        const op = opts.opacity != null ? ` opacity="${opts.opacity}"` : '';
        const cls = opts.cls ? ` class="${opts.cls}"` : '';
        const dataAttrs = opts.dataLabel ? ` data-label="${opts.dataLabel}" data-pct="${opts.dataPct || ''}"` : '';
        const title = opts.title ? `<title>${opts.title}</title>` : '';
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="${cap}"${op}${cls}${dataAttrs}>${title}</path>`;
    };

    let paths = '';
    // background tracks
    paths += `<circle cx="${C}" cy="${C}" r="100" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="28"/>`;
    // inner background: 4 quarter-arcs with the same gap as the data arcs so
    // the track itself shows the separator rather than just the page background
    const innerBgGap = 6;
    for (let q = 0; q < 4; q++) {
        const ba0 = q * 90 + innerBgGap / 2, ba1 = (q + 1) * 90 - innerBgGap / 2;
        paths += arc(55, ba0, ba1, 'rgba(255,255,255,0.04)', 14, { cap: 'butt' });
    }
    // tick marks
    for (let d = 0; d < 360; d += 30) {
        const [x1, y1] = pt(120, d), [x2, y2] = pt(126, d);
        paths += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.08)" stroke-width="1.5"/>`;
    }
    // segments
    segments.forEach(s => { paths += arc(s.r, s.a0, s.a1, s.color, s.w, s); });
    // center text
    paths += `<text x="${C}" y="${C}" dy="-2" text-anchor="middle" dominant-baseline="auto" fill="var(--text)" font-size="22" font-weight="500" font-family="system-ui,sans-serif">${centerPct}</text>`;
    paths += `<text x="${C}" y="${C}" dy="14" text-anchor="middle" dominant-baseline="auto" fill="var(--muted)" font-size="10" font-weight="400" font-family="system-ui,sans-serif">${centerLabel}</text>`;
    return `<svg viewBox="0 0 ${S} ${S}" class="sb-sunburst">${paths}</svg>`;
}

/* Expose globally (non-module <script defer> pattern) */
window.svgRing      = svgRing;
window.barColor     = barColor;
window.buildSunburst = buildSunburst;
