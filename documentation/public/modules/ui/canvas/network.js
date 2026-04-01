/**
 * canvas/network.js
 * Animated canvas inside the "ORM & Database" bento card.
 * A network of nodes connected by edges, with data
 * pulses constantly traveling between them.
 */

export function initNetworkCanvas()
{
    const card = document.querySelector('.bento-data');
    if (!card) return;

    const cvs = card.querySelector('canvas.data-canvas');
    if (!cvs) return;

    const ctx = cvs.getContext('2d');
    let w, h, dpr, animId = null;
    let paused = localStorage.getItem('zero-waves-paused') === '1';

    let nodes = [];
    let edges = [];
    const pulses = [];

    function isDark() {
        return document.documentElement.getAttribute('data-theme') !== 'light';
    }

    function resize() {
        const rect = card.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width;
        h = rect.height;
        cvs.width = w * dpr;
        cvs.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function dist(a, b) {
        const dx = a.x - b.x, dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function seed() {
        nodes = [];
        edges = [];
        pulses.length = 0;

        const count = Math.max(5, Math.round((w * h) / 5500));
        const pad = 14;
        for (let i = 0; i < count; i++) {
            let x, y, ok, tries = 0;
            do {
                x = pad + Math.random() * (w - pad * 2);
                y = pad + Math.random() * (h - pad * 2);
                ok = nodes.every(n => dist(n, { x, y }) > 38);
                tries++;
            } while (!ok && tries < 40);

            nodes.push({
                x, y,
                r: 2 + Math.random() * 1.5,
                hue: 215 + Math.random() * 45,
                edges: []
            });
        }

        const maxD = Math.min(w, h) * 0.5;
        for (let i = 0; i < nodes.length; i++) {
            const byDist = nodes
                .map((n, j) => ({ j, d: dist(nodes[i], n) }))
                .filter(o => o.j !== i && o.d < maxD)
                .sort((a, b) => a.d - b.d)
                .slice(0, 2 + Math.floor(Math.random() * 2));

            for (const { j } of byDist) {
                if (!edges.some(e => (e.a === i && e.b === j) || (e.a === j && e.b === i))) {
                    const idx = edges.length;
                    edges.push({ a: i, b: j });
                    nodes[i].edges.push(idx);
                    nodes[j].edges.push(idx);
                }
            }
        }

        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].edges.length === 0) {
                let best = -1, bestD = Infinity;
                for (let j = 0; j < nodes.length; j++) {
                    if (j === i) continue;
                    const d = dist(nodes[i], nodes[j]);
                    if (d < bestD) { bestD = d; best = j; }
                }
                if (best >= 0) {
                    const idx = edges.length;
                    edges.push({ a: i, b: best });
                    nodes[i].edges.push(idx);
                    nodes[best].edges.push(idx);
                }
            }
        }
    }

    function spawnPulse(edgeIdx) {
        const e = edgeIdx != null ? edges[edgeIdx] : edges[Math.floor(Math.random() * edges.length)];
        if (!e) return;
        pulses.push({
            edge: e,
            t: 0,
            speed: 0.0015 + Math.random() * 0.005,
            forward: Math.random() > 0.5,
            hue: 220 + Math.random() * 40
        });
    }

    function ensureActivity() {
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const hasActive = n.edges.some(eIdx => {
                const e = edges[eIdx];
                return pulses.some(p => p.edge === e);
            });
            if (!hasActive && n.edges.length > 0) {
                spawnPulse(n.edges[Math.floor(Math.random() * n.edges.length)]);
            }
        }
    }

    let tick = 0;

    function draw() {
        ctx.clearRect(0, 0, w, h);
        const dark = isDark();
        tick++;

        if (tick % 30 === 0) {
            if (pulses.length < edges.length) spawnPulse();
            ensureActivity();
        }

        for (const e of edges) {
            const a = nodes[e.a], b = nodes[e.b];
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = dark ? 'rgba(88,101,242,0.12)' : 'rgba(79,91,213,0.22)';
            ctx.lineWidth = 0.8;
            ctx.stroke();
        }

        for (let i = pulses.length - 1; i >= 0; i--) {
            const p = pulses[i];
            p.t += p.speed;
            if (p.t > 1) { pulses.splice(i, 1); continue; }

            const a = nodes[p.forward ? p.edge.a : p.edge.b];
            const b = nodes[p.forward ? p.edge.b : p.edge.a];
            const x = a.x + (b.x - a.x) * p.t;
            const y = a.y + (b.y - a.y) * p.t;
            const alpha = Math.sin(p.t * Math.PI) * (dark ? 0.85 : 0.8);
            const r = 1.8;

            const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
            grad.addColorStop(0, 'hsla(' + p.hue + ',' + (dark ? '70%' : '85%') + ',' + (dark ? '75%' : '40%') + ',' + alpha + ')');
            grad.addColorStop(1, 'hsla(' + p.hue + ',60%,50%,0)');
            ctx.beginPath();
            ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + p.hue + ',85%,' + (dark ? '90%' : '45%') + ',' + (alpha * 1.3) + ')';
            ctx.fill();
        }

        for (const n of nodes) {
            const a = dark ? 0.35 : 0.4;

            const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3.5);
            grad.addColorStop(0, 'hsla(' + n.hue + ',' + (dark ? '60%' : '75%') + ',' + (dark ? '65%' : '38%') + ',' + (a * 0.6) + ')');
            grad.addColorStop(1, 'hsla(' + n.hue + ',50%,50%,0)');
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r * 3.5, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + n.hue + ',' + (dark ? '65%' : '80%') + ',' + (dark ? '70%' : '40%') + ',' + a + ')';
            ctx.fill();
        }

        if (!paused) animId = requestAnimationFrame(draw);
        else animId = null;
    }

    function start() {
        if (animId) return;
        paused = false;
        ensureActivity();
        animId = requestAnimationFrame(draw);
    }

    function stop() {
        paused = true;
        if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    window.addEventListener('waves-pause', () => { stop(); });
    window.addEventListener('waves-resume', () => { start(); });
    window.addEventListener('storage', (e) => {
        if (e.key === 'zero-waves-paused') {
            if (e.newValue === '1') stop(); else start();
        }
    });

    resize();
    seed();
    window.addEventListener('resize', () => { resize(); seed(); });

    if (!paused) start();
}
