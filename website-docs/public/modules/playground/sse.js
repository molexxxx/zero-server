/**
 * playground/sse.js – SSE event viewer.
 */

import { $, on, escapeHtml } from '../core/helpers.js';

export function initSseViewer()
{
    let es = null;
    const connectBtn = $('#sseConnectBtn');
    const disconnectBtn = $('#sseDisconnectBtn');
    const status = $('#sseStatus');
    const messages = $('#sseMessages');
    const broadcastBtn = $('#sseBroadcastBtn');
    const broadcastInput = $('#sseBroadcastInput');

    if (!connectBtn) return;

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
        status.style.color = connected ? 'var(--success)' : '';
    }

    on(connectBtn, 'click', () =>
    {
        es = new EventSource('/sse/events');

        es.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span class="pg-success">● SSE connected</span>');
        };

        es.onmessage = (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span class="pg-muted">[${ts}]</span> ${escapeHtml(e.data)}`);
        };

        es.addEventListener('broadcast', (e) =>
        {
            const ts = new Date().toLocaleTimeString();
            appendMsg(`<span class="pg-accent">[${ts} broadcast]</span> ${escapeHtml(e.data)}`);
        });

        es.onerror = () =>
        {
            if (es.readyState === EventSource.CLOSED)
            {
                setConnected(false);
                appendMsg('<span class="pg-danger">● SSE closed</span>');
                es = null;
            } else
            {
                appendMsg('<span class="pg-warn">● SSE reconnecting…</span>');
            }
        };
    });

    on(disconnectBtn, 'click', () =>
    {
        if (es) { es.close(); es = null; }
        setConnected(false);
        appendMsg('<span class="pg-danger">● Disconnected</span>');
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
