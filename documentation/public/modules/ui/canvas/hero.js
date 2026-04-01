/**
 * canvas/hero.js
 * Animated canvas inside the "Zero Dependencies" bento card.
 * Floating orbs with breathing pulse and glow effects.
 */

export function initHeroCanvas()
{
    const card = document.querySelector('.bento-hero');
    if (!card) return;

    const cvs = card.querySelector('canvas.hero-canvas');
    if (!cvs) return;

    const ctx = cvs.getContext('2d');
    let w, h, dpr, animId = null;
    let paused = localStorage.getItem('zero-waves-paused') === '1';

    const COUNT = 10;
    const orbs = [];

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
        orbs.length = 0;
        for (let i = 0; i < COUNT; i++) {
            orbs.push({
                x: Math.random() * w,
                y: Math.random() * h,
                r: 1.8 + Math.random() * 2.5,
                vx: (Math.random() - 0.5) * 0.15,
                vy: (Math.random() - 0.5) * 0.15,
                hue: 230 + Math.random() * 40,
                alpha: 0.15 + Math.random() * 0.2,
                pulse: Math.random() * Math.PI * 2,
                pulseSpeed: 0.004 + Math.random() * 0.006
            });
        }
    }

    function draw() {
        ctx.clearRect(0, 0, w, h);
        const dark = isDark();

        for (const o of orbs) {
            o.x += o.vx;
            o.y += o.vy;

            if (o.x < -10) o.x = w + 10;
            if (o.x > w + 10) o.x = -10;
            if (o.y < -10) o.y = h + 10;
            if (o.y > h + 10) o.y = -10;

            o.pulse += o.pulseSpeed;
            const scale = 1 + Math.sin(o.pulse) * 0.3;
            const r = o.r * scale;
            const a = o.alpha * (dark ? 1.2 : 1.0) * (0.7 + Math.sin(o.pulse) * 0.3);

            const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, r * 5);
            grad.addColorStop(0, 'hsla(' + o.hue + ',' + (dark ? '70%' : '80%') + ',' + (dark ? '70%' : '42%') + ',' + a + ')');
            grad.addColorStop(0.4, 'hsla(' + o.hue + ',' + (dark ? '60%' : '75%') + ',' + (dark ? '60%' : '38%') + ',' + (a * 0.45) + ')');
            grad.addColorStop(1, 'hsla(' + o.hue + ',50%,50%,0)');

            ctx.beginPath();
            ctx.arc(o.x, o.y, r * 5, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(o.x, o.y, r * 0.7, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + o.hue + ',85%,' + (dark ? '82%' : '48%') + ',' + (a * 1.4) + ')';
            ctx.fill();
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

    new MutationObserver(() => {}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    resize();
    seed();
    window.addEventListener('resize', () => { resize(); seed(); });

    if (!paused) start();
}
