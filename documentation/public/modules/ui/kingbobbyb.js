/**
 * kingbobbyb.js — A hidden tribute to John Hart (kingbobbyb).
 *
 * Konami code: ↑ ↑ ↓ ↓ ← → ← → B A
 * "The king is gone but not forgotten."
 */

const SEQ = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
let pos = 0;

const QUOTES = [
    'Gods, I was strong then.',
    'Start the damn joust before I piss myself.',
    'I swear to you, I was never so alive as when I was winning this throne.',
    'Surrounded by Lannisters. Every time I close my eyes, I see their blond hair and smug faces.',
    'You got fat.',
    'Bow, ya shits!',
    'More wine!',
    'Thank the gods for Bessie. And her tits.',
    'In my dreams I kill him every night.',
    'I should have been the one to write to you. I should have come to see you.'
];

export function initKingBobbyB()
{
    document.addEventListener('keydown', (e) =>
    {
        if (e.keyCode === SEQ[pos]) { pos++; } else { pos = e.keyCode === SEQ[0] ? 1 : 0; }
        if (pos === SEQ.length) { pos = 0; showTribute(); }
    });
}

function showTribute()
{
    if (document.getElementById('kingbobbyb-tribute')) return;

    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];

    const overlay = document.createElement('div');
    overlay.id = 'kingbobbyb-tribute';
    overlay.innerHTML = `
        <div class="kb-backdrop"></div>
        <div class="kb-card">
            <div class="kb-crown">♚</div>
            <h2 class="kb-name">kingbobbyb</h2>
            <p class="kb-real">John Hart</p>
            <p class="kb-dates">July 17, 1994 – December 17, 2023</p>
            <p class="kb-quote">"${quote}"</p>
            <div class="kb-divider"></div>
            <p class="kb-memorial">Gone but never forgotten.<br>The king lives on in the code.</p>
            <a class="kb-yt" href="https://www.youtube.com/@kingbobbyb6026/videos" target="_blank" rel="noopener noreferrer">&#9654; kingbobbyb on YouTube</a>
            <button class="kb-close" aria-label="Close tribute">&times;</button>
        </div>
    `;

    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('kb-visible'));

    const close = () =>
    {
        overlay.classList.remove('kb-visible');
        overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
        setTimeout(() => overlay.remove(), 600);
    };

    overlay.querySelector('.kb-close').addEventListener('click', close);
    overlay.querySelector('.kb-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e)
    {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
}
