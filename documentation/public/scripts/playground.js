/**
 * playground.js
 * Echo playground forms — JSON, URL-encoded, and plain-text body parsers.
 * WebSocket chat client and SSE event viewer.
 *
 * Depends on: helpers.js (provides $, on, escapeHtml, showJsonResult,
 *             highlightAllPre)
 */

/**
 * Wire the three echo playground forms so submissions hit the server and
 * display the response.  Called once from the DOMContentLoaded handler in
 * app.js.
 */
function initPlayground()
{
    /* JSON echo */
    on($('#jsonPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const raw = e.target.json.value || '';
        const playResult = $('#playResult');

        try { JSON.parse(raw); }
        catch (err)
        {
            playResult.innerHTML = `<pre class="code"><code>${escapeHtml('Invalid JSON: ' + err.message)}</code></pre>`;
            return;
        }

        const r = await fetch('/echo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: raw,
        });
        const j = await r.json();
        showJsonResult(playResult, j);
    });

    /* URL-encoded echo */
    on($('#urlPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const body = e.target.url.value || '';
        const playResult = $('#playResult');

        const r = await fetch('/echo-urlencoded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const j = await r.json();
        showJsonResult(playResult, j);
    });

    /* Plain-text echo */
    on($('#textPlay'), 'submit', async (e) =>
    {
        e.preventDefault();
        const txt = e.target.txt.value || '';
        const playResult = $('#playResult');

        const r = await fetch('/echo-text', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: txt,
        });
        const text = await r.text();
        playResult.innerHTML = `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
        try { highlightAllPre(); } catch (e) { }
    });

    /* --- WebSocket Chat --- */
    initWsChat();

    /* --- SSE Viewer --- */
    initSseViewer();
}

/* ------------------------------------------------------------------ */
/*  WebSocket Chat                                                     */
/* ------------------------------------------------------------------ */
function initWsChat()
{
    let ws = null;
    const connectBtn = $('#wsConnectBtn');
    const disconnectBtn = $('#wsDisconnectBtn');
    const nameInput = $('#wsName');
    const msgInput = $('#wsMsgInput');
    const sendBtn = $('#wsSendBtn');
    const messages = $('#wsMessages');

    if (!connectBtn) return; // guard if elements not in DOM

    function appendMsg(html)
    {
        const div = document.createElement('div');
        div.innerHTML = html;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function setConnected(connected)
    {
        connectBtn.disabled = connected;
        disconnectBtn.disabled = !connected;
        msgInput.disabled = !connected;
        sendBtn.disabled = !connected;
        nameInput.disabled = connected;
    }

    on(connectBtn, 'click', () =>
    {
        const name = encodeURIComponent(nameInput.value || 'anon');
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Use the direct HTTPS host+port when behind a reverse proxy that
        // doesn't forward WebSocket upgrades.
        const wsHost = location.port ? location.host : (location.hostname + ':7273');
        ws = new WebSocket(`${proto}//${wsHost}/ws/chat?name=${name}`);

        ws.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span style="color:#6f6">● Connected</span>');
        };

        ws.onmessage = (e) =>
        {
            try
            {
                const msg = JSON.parse(e.data);
                if (msg.type === 'system')
                {
                    appendMsg(`<span style="color:#aaa">» ${escapeHtml(msg.text)}</span>`);
                } else
                {
                    appendMsg(`<strong>${escapeHtml(msg.name)}</strong>: ${escapeHtml(msg.text)}`);
                }
            } catch (_)
            {
                appendMsg(escapeHtml(e.data));
            }
        };

        ws.onclose = () =>
        {
            setConnected(false);
            appendMsg('<span style="color:#f66">● Disconnected</span>');
            ws = null;
        };

        ws.onerror = () =>
        {
            appendMsg('<span style="color:#f66">● Connection error</span>');
        };
    });

    on(disconnectBtn, 'click', () =>
    {
        if (ws) ws.close();
    });

    on(sendBtn, 'click', () =>
    {
        if (ws && ws.readyState === WebSocket.OPEN && msgInput.value.trim())
        {
            ws.send(msgInput.value.trim());
            msgInput.value = '';
        }
    });

    on(msgInput, 'keydown', (e) =>
    {
        if (e.key === 'Enter')
        {
            e.preventDefault();
            sendBtn.click();
        }
    });
}

/* ------------------------------------------------------------------ */
/*  SSE Event Viewer                                                   */
/* ------------------------------------------------------------------ */
function initSseViewer()
{
    let es = null;
    const connectBtn = $('#sseConnectBtn');
    const disconnectBtn = $('#sseDisconnectBtn');
    const status = $('#sseStatus');
    const messages = $('#sseMessages');
    const broadcastBtn = $('#sseBroadcastBtn');
    const broadcastInput = $('#sseBroadcastInput');

    if (!connectBtn) return; // guard

    function appendMsg(html)
    {
        const div = document.createElement('div');
        div.innerHTML = html;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    function setConnected(connected)
    {
        connectBtn.disabled = connected;
        disconnectBtn.disabled = !connected;
        status.textContent = connected ? 'Connected' : 'Disconnected';
        status.style.color = connected ? '#6f6' : '';
    }

    on(connectBtn, 'click', () =>
    {
        es = new EventSource('/sse/events');

        es.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span style="color:#6f6">● SSE connected</span>');
        };

        es.onmessage = (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span style="color:#aaa">[${ts}]</span> ${escapeHtml(e.data)}`);
        };

        es.addEventListener('broadcast', (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span style="color:#ff0">[${ts} broadcast]</span> ${escapeHtml(e.data)}`);
        });

        es.onerror = () =>
        {
            if (es.readyState === EventSource.CLOSED)
            {
                setConnected(false);
                appendMsg('<span style="color:#f66">● SSE closed</span>');
                es = null;
            } else
            {
                appendMsg('<span style="color:#fa0">● SSE reconnecting…</span>');
            }
        };
    });

    on(disconnectBtn, 'click', () =>
    {
        if (es) { es.close(); es = null; }
        setConnected(false);
        appendMsg('<span style="color:#f66">● Disconnected</span>');
    });

    on(broadcastBtn, 'click', async () =>
    {
        const raw = broadcastInput.value || '{}';
        let body;
        try { body = JSON.parse(raw); }
        catch (err)
        {
            appendMsg(`<span style="color:#f66">Invalid JSON: ${escapeHtml(err.message)}</span>`);
            return;
        }

        const r = await fetch('/sse/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const j = await r.json();
        appendMsg(`<span style="color:#aaa">» Broadcast sent to ${j.sent} client(s)</span>`);
    });
}
