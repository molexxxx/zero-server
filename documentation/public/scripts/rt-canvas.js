/**
 * rt-canvas.js
 * Animated canvas inside the "Real-time" bento card.
 * Expanding signal rings pulse outward from broadcast points,
 * representing WebSocket rooms and SSE broadcasting.
 * Respects the pause FAB and adapts to theme.
 */
(function () {
    const card = document.querySelector('.bento-rt');
    if (!card) return;

    const cvs = card.querySelector('canvas.rt-canvas');
    if (!cvs) return;

    const ctx = cvs.getContext('2d');
    let w, h, dpr, animId = null;
    let paused = localStorage.getItem('zero-waves-paused') === '1';

    const emitters = [];
    const rings = [];

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

    function seed() {
        emitters.length = 0;
        rings.length = 0;

        /* Place 4 broadcast sources randomly across the card
           with varied sizes: 1 big, 1 medium, 2 small */
        const sizes = [
            { r: 3.2, maxR: 32, label: 'big' },
            { r: 2.2, maxR: 24, label: 'med' },
            { r: 1.5, maxR: 18, label: 'sm' },
            { r: 1.5, maxR: 18, label: 'sm' }
        ];
        /* Shuffle so the big one isn't always first */
        for (let i = sizes.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = sizes[i]; sizes[i] = sizes[j]; sizes[j] = tmp;
        }
        const count = sizes.length;
        const pad = 30;
        const minDist = 40; /* minimum distance between emitters */
        const placed = [];
        for (let i = 0; i < count; i++) {
            let x, y, attempts = 0;
            do {
                x = pad + Math.random() * (w - pad * 2);
                y = pad + Math.random() * (h - pad * 2);
                attempts++;
            } while (attempts < 60 && placed.some(p => Math.hypot(p.x - x, p.y - y) < minDist));
            placed.push({ x, y });
            emitters.push({
                x,
                y,
                hue: 230 + Math.random() * 40, /* blue-to-purple like hero orbs */
                timer: Math.floor(Math.random() * 120),
                interval: 180 + Math.floor(Math.random() * 120),
                dotR: sizes[i].r,
                ringMaxR: sizes[i].maxR
            });
        }
    }

    let tick = 0;

    function draw() {
        ctx.clearRect(0, 0, w, h);
        const dark = isDark();
        tick++;

        /* Emit rings from each source — cap total rings */
        for (const em of emitters) {
            em.timer++;
            if (em.timer >= em.interval && rings.length < 6) {
                em.timer = 0;
                rings.push({
                    x: em.x,
                    y: em.y,
                    r: 0,
                    maxR: em.ringMaxR + Math.random() * 8,
                    speed: 0.08 + Math.random() * 0.06,
                    hue: em.hue + (Math.random() - 0.5) * 15,
                    life: 0
                });
            }

            /* Draw emitter dot — solid, minimal glow */
            const pulse = 0.7 + Math.sin(tick * 0.04 + em.hue) * 0.3;
            const ea = (dark ? 0.6 : 0.7) * pulse;
            const er = em.dotR;

            ctx.beginPath();
            ctx.arc(em.x, em.y, er, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + em.hue + ',' + (dark ? '75%' : '90%') + ',' + (dark ? '80%' : '45%') + ',' + ea + ')';
            ctx.fill();
        }

        /* Draw expanding rings */
        for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            ring.r += ring.speed;
            ring.life = ring.r / ring.maxR;

            if (ring.life >= 1) {
                rings.splice(i, 1);
                continue;
            }

            /* Fade out as ring expands */
            const alpha = (1 - ring.life) * (dark ? 0.7 : 0.75);

            ctx.beginPath();
            ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
            ctx.strokeStyle = 'hsla(' + ring.hue + ',' + (dark ? '70%' : '85%') + ',' + (dark ? '75%' : '42%') + ',' + alpha + ')';
            ctx.lineWidth = 1.5 * (1 - ring.life * 0.6);
            ctx.stroke();
        }

        if (!paused) animId = requestAnimationFrame(draw);
        else animId = null;
    }

    function start() {
        if (animId) return;
        paused = false;
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

    /* Card starts hidden (bento-extra → display:none).
       Use IntersectionObserver to init when it becomes visible. */
    let inited = false;
    function initIfVisible() {
        const rect = card.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (inited) return true;
        inited = true;
        resize();
        seed();
        if (!paused) start();
        return true;
    }

    if (!initIfVisible()) {
        const obs = new MutationObserver(() => {
            if (initIfVisible()) obs.disconnect();
        });
        obs.observe(card.closest('.bento-section') || document.body, {
            attributes: true, childList: true, subtree: true
        });
    } else if (!paused) {
        start();
    }
})();
