/**
 * background.js
 * Vibrant abstract ocean wave background with blue/purple gradient.
 * Renders 3 slow, varied liquid waves over the page background.
 * Adapts colors and contrast to light/dark theme.
 */

(function ()
{
    const canvas = document.createElement('canvas');
    canvas.id = 'bg-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let width, height, time = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let animId = null;
    let paused = localStorage.getItem('zero-waves-paused') === '1';

    function isDark()
    {
        return document.documentElement.getAttribute('data-theme') !== 'light';
    }

    function resize()
    {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* 3 waves — each with unique character */
    const waves = [
        /* Wide, tall, slow — the big rolling swell */
        { yBase: 0.52, amp: 70, amp2: 35, amp3: 18,
          freq: 0.0012, freq2: 0.0025, freq3: 0.0055,
          speed: 0.0025, speed2: 0.004, speed3: 0.002,
          phase: 0 },
        /* Medium, quicker secondary chop */
        { yBase: 0.64, amp: 45, amp2: 22, amp3: 12,
          freq: 0.0020, freq2: 0.0040, freq3: 0.0080,
          speed: 0.004, speed2: 0.0025, speed3: 0.005,
          phase: 2.1 },
        /* Shallow, fast ripple on top */
        { yBase: 0.78, amp: 30, amp2: 15, amp3: 8,
          freq: 0.0028, freq2: 0.0060, freq3: 0.0100,
          speed: 0.005, speed2: 0.003, speed3: 0.006,
          phase: 4.5 },
    ];

    function waveY(w, x, t)
    {
        return w.yBase * height
            + Math.sin(x * w.freq + t * w.speed + w.phase) * w.amp
            + Math.sin(x * w.freq2 + t * w.speed2 + w.phase * 1.7) * w.amp2
            + Math.sin(x * w.freq3 + t * w.speed3 + w.phase * 0.6) * w.amp3;
    }

    function draw()
    {
        const dark = isDark();

        /* Solid base canvas fill */
        ctx.fillStyle = dark ? '#0e1114' : '#f0f2f5';
        ctx.fillRect(0, 0, width, height);

        /* Color palette for each wave layer (back to front) */
        const palette = dark
            ? [
                { r: 55,  g: 40,  b: 180, a: 0.28 },   /* deep indigo swell */
                { r: 88,  g: 101, b: 242, a: 0.22 },   /* primary accent chop */
                { r: 100, g: 60,  b: 220, a: 0.16 },   /* purple ripple */
            ]
            : [
                { r: 79,  g: 91,  b: 213, a: 0.15 },   /* accent blue swell */
                { r: 100, g: 120, b: 230, a: 0.12 },   /* periwinkle chop */
                { r: 120, g: 90,  b: 210, a: 0.09 },   /* lavender ripple */
            ];

        for (let i = 0; i < waves.length; i++)
        {
            const w = waves[i];
            const c = palette[i];

            /* Build wave path */
            ctx.beginPath();
            ctx.moveTo(0, height);

            for (let x = 0; x <= width; x += 2)
            {
                ctx.lineTo(x, waveY(w, x, time));
            }

            ctx.lineTo(width, height);
            ctx.closePath();

            /* Gradient fill from crest color to deeper shade below */
            const crestY = w.yBase * height - w.amp;
            const bottomY = height;
            const grad = ctx.createLinearGradient(0, crestY, 0, bottomY);
            grad.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a + ')');
            grad.addColorStop(0.4, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (c.a * 0.7) + ')');
            grad.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (c.a * 0.3) + ')');
            ctx.fillStyle = grad;
            ctx.fill();

            /* Crest highlight stroke */
            ctx.beginPath();
            for (let x = 0; x <= width; x += 2)
            {
                const y = waveY(w, x, time);
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (dark ? 0.35 : 0.18) + ')';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            /* Foam/highlight along the very top of the wave */
            ctx.beginPath();
            for (let x = 0; x <= width; x += 2)
            {
                const y = waveY(w, x, time);
                if (x === 0) ctx.moveTo(x, y - 1);
                else ctx.lineTo(x, y - 1);
            }
            ctx.strokeStyle = 'rgba(255,255,255,' + (dark ? 0.06 : 0.12) + ')';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        time++;
        if (!paused) animId = requestAnimationFrame(draw);
        else animId = null;
    }

    function drawStatic()
    {
        /* Render a single still frame (no rAF loop) */
        const prevPaused = paused;
        paused = true;
        draw();
        paused = prevPaused;
    }

    function init()
    {
        resize();
        if (paused) drawStatic();
        else draw();
    }

    /* Pause / Resume toggle */
    function initPauseButton()
    {
        const btn = document.getElementById('fab-pause');
        if (!btn) return;

        const pauseIcon = btn.querySelector('.pause-icon');
        const playIcon = btn.querySelector('.play-icon');

        function updateIcon()
        {
            if (pauseIcon) pauseIcon.style.display = paused ? 'none' : '';
            if (playIcon) playIcon.style.display = paused ? '' : 'none';
            btn.title = paused ? 'Resume animation' : 'Pause animation';
            btn.setAttribute('aria-label', paused ? 'Resume background animation' : 'Pause background animation');
        }

        updateIcon();
        btn.classList.add('visible');

        btn.addEventListener('click', () =>
        {
            paused = !paused;
            localStorage.setItem('zero-waves-paused', paused ? '1' : '0');
            updateIcon();

            if (paused)
            {
                if (animId) { cancelAnimationFrame(animId); animId = null; }
            }
            else
            {
                if (!animId) draw();
            }
        });
    }

    document.addEventListener('DOMContentLoaded', initPauseButton);

    /* Redraw static frame when theme changes while paused */
    new MutationObserver(() => { if (paused) drawStatic(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let resizeTimer;
    window.addEventListener('resize', () =>
    {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resize(); if (paused) drawStatic(); }, 150);
    });

    if (document.readyState === 'loading')
    {
        document.addEventListener('DOMContentLoaded', init);
    }
    else
    {
        init();
    }
})();
