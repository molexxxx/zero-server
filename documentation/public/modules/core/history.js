/**
 * core/history.js
 * Browser history substates for modals, sections, and hash routes.
 */

// Disable browser scroll restoration — we manage it in popstate
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

let _stack = [];
let _cursor = 0;
let _lastHash = location.hash;

// Late-bound scroll handler (set by boot.js to avoid circular imports)
let _scrollToIdFn = null;
export function registerScrollHandler(fn) { _scrollToIdFn = fn; }

// Tag the initial page state
history.replaceState({ _ui: 0 }, '');

// Internal helpers

function _openModal(id) {
    const el = document.getElementById(id);
    if (!el || el.getAttribute('aria-hidden') === 'false') return;
    el.setAttribute('aria-hidden', 'false');
    if (id === 'search-modal') {
        const si = document.getElementById('search-modal-input');
        if (si) setTimeout(function () { si.focus(); }, 50);
    }
    const onKey = function (ev) {
        if (ev.key === 'Escape') {
            histCloseModal(id);
            document.removeEventListener('keydown', onKey);
        }
    };
    document.addEventListener('keydown', onKey);
}

function _closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('aria-hidden', 'true');
}

// Public API

export function histPushModal(id) {
    _stack.length = _cursor;
    _stack.push({ t: 'm', id: id });
    _cursor = _stack.length;
    history.pushState({ _ui: _cursor }, '');
}

export function histCloseModal(id) {
    const top = _cursor > 0 ? _stack[_cursor - 1] : null;
    if (top && top.t === 'm' && top.id === id) {
        history.back();
        return;
    }
    _closeModal(id);
    for (let i = _cursor - 1; i >= 0; i--) {
        if (_stack[i] && _stack[i].t === 'm' && _stack[i].id === id && !_stack[i].dead) {
            _stack[i].dead = true;
            break;
        }
    }
}

export function histDismissModal(id) {
    _closeModal(id);
    for (let i = _cursor - 1; i >= 0; i--) {
        if (_stack[i] && _stack[i].t === 'm' && _stack[i].id === id && !_stack[i].dead) {
            _stack[i].dead = true;
            break;
        }
    }
}

export function histPushAccordion(detailsId, nowOpen) {
    _stack.length = _cursor;
    _stack.push({ t: 'a', id: detailsId, undo: !nowOpen });
    _cursor = _stack.length;
    history.pushState({ _ui: _cursor }, '');
}

export function histPushHash(hash) {
    if (hash.charAt(0) === '#' && hash === location.hash) return;
    if (hash.indexOf('#') === -1 && !location.hash) return;

    _stack.length = _cursor;
    _stack.push({ t: 'h' });
    _cursor = _stack.length;
    history.pushState({ _ui: _cursor }, '', hash);
    _lastHash = location.hash;
}

export function histReplaceHash(url) {
    history.replaceState({ _ui: _cursor }, '', url);
    _lastHash = location.hash;
}

// popstate handler

window.addEventListener('popstate', function (e) {
    const target = (e.state && typeof e.state._ui === 'number') ? e.state._ui : 0;
    const originalCursor = _cursor;

    window._histPopstateHandled = true;
    setTimeout(function () { window._histPopstateHandled = false; }, 0);

    const hashChanged = (location.hash !== _lastHash);
    _lastHash = location.hash;

    let anyLiveAction = false;

    if (target < _cursor) {
        while (_cursor > target && _cursor > 0) {
            _cursor--;
            const entry = _stack[_cursor];
            if (!entry || entry.dead) continue;
            anyLiveAction = true;
            if (entry.t === 'm') _closeModal(entry.id);
            if (entry.t === 'a') {
                const det = document.getElementById(entry.id);
                if (det) det.open = entry.undo;
            }
        }
    } else if (target > _cursor) {
        while (_cursor < target && _cursor < _stack.length) {
            const fwd = _stack[_cursor];
            _cursor++;
            if (!fwd || fwd.dead) continue;
            anyLiveAction = true;
            if (fwd.t === 'm') _openModal(fwd.id);
            if (fwd.t === 'a') {
                const det2 = document.getElementById(fwd.id);
                if (det2) det2.open = !fwd.undo;
            }
        }
    }

    if (hashChanged) anyLiveAction = true;

    if (!anyLiveAction && _cursor !== originalCursor) {
        const dir = target < originalCursor ? -1 : 1;
        if ((dir === -1 && _cursor > 0) || (dir === 1 && _cursor < _stack.length)) {
            setTimeout(function () { history.go(dir); }, 0);
            return;
        }
    }

    if (hashChanged) {
        if (location.hash && _scrollToIdFn) {
            _scrollToIdFn(location.hash.slice(1));
        } else if (!location.hash) {
            window.scrollTo({ top: 0, behavior: 'instant' });
        }
    }
});
