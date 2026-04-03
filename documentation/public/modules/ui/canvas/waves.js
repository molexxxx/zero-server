/**
 * canvas/waves.js
 * Vibrant abstract ocean wave background with blue/purple gradient.
 * Renders 3 slow, varied liquid waves over the page background.
 * Adapts colors and contrast to light/dark theme.
 */

const mql = window.matchMedia('(min-width: 641px)');
let canvas, ctx;
let width, height, time = 0;
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let animId = null;
let paused = localStorage.getItem('zero-waves-paused') === '1';
let active = false;

function isDark()
{
    return document.documentElement.getAttribute('data-theme') !== 'light';
}

function resize()
{
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const waves = [
    { yBase: 0.52, amp: 70, amp2: 35, amp3: 18,
      freq: 0.0012, freq2: 0.0025, freq3: 0.0055,
      speed: 0.0025, speed2: 0.004, speed3: 0.002,
      phase: 0 },
    { yBase: 0.64, amp: 45, amp2: 22, amp3: 12,
      freq: 0.0020, freq2: 0.0040, freq3: 0.0080,
      speed: 0.004, speed2: 0.0025, speed3: 0.005,
      phase: 2.1 },
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

    ctx.fillStyle = dark ? '#12161e' : '#edeef4';
    ctx.fillRect(0, 0, width, height);

    const palette = dark
        ? [
            { r: 55,  g: 40,  b: 180, a: 0.28 },
            { r: 88,  g: 101, b: 242, a: 0.22 },
            { r: 100, g: 60,  b: 220, a: 0.16 },
        ]
        : [
            { r: 79,  g: 91,  b: 213, a: 0.10 },
            { r: 100, g: 120, b: 230, a: 0.08 },
            { r: 120, g: 90,  b: 210, a: 0.06 },
        ];

    for (let i = 0; i < waves.length; i++)
    {
        const w = waves[i];
        const c = palette[i];

        ctx.beginPath();
        ctx.moveTo(0, height);
        for (let x = 0; x <= width; x += 2) ctx.lineTo(x, waveY(w, x, time));
        ctx.lineTo(width, height);
        ctx.closePath();

        const crestY = w.yBase * height - w.amp;
        const bottomY = height;
        const grad = ctx.createLinearGradient(0, crestY, 0, bottomY);
        grad.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a + ')');
        grad.addColorStop(0.4, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (c.a * 0.7) + ')');
        grad.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (c.a * 0.3) + ')');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let x = 0; x <= width; x += 2)
        {
            const y = waveY(w, x, time);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (dark ? 0.35 : 0.25) + ')';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        for (let x = 0; x <= width; x += 2)
        {
            const y = waveY(w, x, time);
            if (x === 0) ctx.moveTo(x, y - 1); else ctx.lineTo(x, y - 1);
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

    btn.addEventListener('click', () =>
    {
        paused = !paused;
        localStorage.setItem('zero-waves-paused', paused ? '1' : '0');
        updateIcon();

        window.dispatchEvent(new Event(paused ? 'waves-pause' : 'waves-resume'));

        if (paused)
        {
            if (animId) { cancelAnimationFrame(animId); animId = null; }
        }
        else
        {
            if (!animId && active) draw();
        }
    });
}

function activate()
{
    if (active) return;
    active = true;

    canvas = document.createElement('canvas');
    canvas.id = 'bg-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    ctx = canvas.getContext('2d');

    const btn = document.getElementById('fab-pause');
    if (btn) btn.classList.add('visible');

    init();
}

function deactivate()
{
    if (!active) return;
    active = false;

    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    ctx = null;

    const btn = document.getElementById('fab-pause');
    if (btn) btn.classList.remove('visible');
}

function onBreakpoint(e)
{
    if (e.matches) activate();
    else deactivate();
}

mql.addEventListener('change', onBreakpoint);

new MutationObserver(() => { if (active && paused) drawStatic(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

let resizeTimer;
window.addEventListener('resize', () =>
{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active) { resize(); if (paused) drawStatic(); } }, 150);
});

export function initWaves()
{
    initPauseButton();
    if (mql.matches) activate();
}
