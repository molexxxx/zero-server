/**
 * playground/websocket.js – WebSocket chat client.
 */

import { $, on, escapeHtml } from '../core/helpers.js';

export function initWsChat()
{
    let ws = null;
    const connectBtn = $('#wsConnectBtn');
    const disconnectBtn = $('#wsDisconnectBtn');
    const nameInput = $('#wsName');
    const msgInput = $('#wsMsgInput');
    const sendBtn = $('#wsSendBtn');
    const messages = $('#wsMessages');

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
        msgInput.disabled = !connected;
        sendBtn.disabled = !connected;
        nameInput.disabled = connected;
    }

    on(connectBtn, 'click', () =>
    {
        const name = encodeURIComponent(nameInput.value || 'anon');
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = location.port ? location.host : location.hostname + ':7273';
        ws = new WebSocket(`${proto}//${wsHost}/ws/chat?name=${name}`);

        ws.onopen = () =>
        {
            setConnected(true);
            appendMsg('<span class="pg-success">● Connected</span>');
        };

        ws.onmessage = (e) =>
        {
            try
            {
                const msg = JSON.parse(e.data);
                if (msg.type === 'system')
                {
                    appendMsg(`<span class="pg-muted">» ${escapeHtml(msg.text)}</span>`);
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
            appendMsg('<span class="pg-danger">● Disconnected</span>');
            ws = null;
        };

        ws.onerror = () =>
        {
            appendMsg('<span class="pg-danger">● Connection error</span>');
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
