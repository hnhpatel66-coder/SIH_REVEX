/* ============================================================================
 * REVEX ASSISTANT - FULL PAGE  (js/chat-page.js)
 *
 * chat.html is the same widget as a page, plus the conversation list. All the
 * rendering lives in js/chat.js; this file only wires the page to it and owns
 * the per-user conversation history.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;
  if (!R.requireLogin()) return;

  // `api` is NOT a global. Without this destructure the two calls below threw
  // `ReferenceError: api is not defined`, which the surrounding try/catch turned
  // into a chat bubble reading "api is not defined" and left the history sidebar
  // permanently empty.
  const { api, escapeHtml } = R;

  const chat = global.RevexChat;
  if (!chat) return;

  const historyBox = document.getElementById('chatHistory');
  const hostBox = document.getElementById('chatHost');
  const newButton = document.getElementById('chatNew');
  const statusBox = document.getElementById('chatPageStatus');

  /* The page is the same widget, moved into the page's own grid. The widget
     owns the layout from here via `data-host="page"`, so no inline styles. */
  const panel = hostBox ? chat.mount({ launcher: false, host: hostBox }) : null;
  if (!panel) return;

  function renderStatus(status) {
    if (!statusBox) return;
    statusBox.className = `rvx-notice rvx-notice--${status.configured ? 'ok' : 'warn'}`;
    statusBox.innerHTML = status.configured
      ? `<div><strong>Connected.</strong>${escapeHtml(status.model || '')} ${escapeHtml(status.provider === 'openai-compatible' ? 'OpenAI-compatible endpoint' : 'Gemini endpoint')}. Conversations are stored against your account.</div>`
      : `<div><strong>Not configured yet.</strong>${escapeHtml(status.message || 'Add your assistant API key to the backend .env file and restart the server.')}</div>`;
  }

  async function loadHistory() {
    if (!historyBox) return;
    try {
      const rows = await api('/chat/conversations');
      if (!rows.length) {
        historyBox.innerHTML = '<p class="rvx-card__meta">No previous conversations yet.</p>';
        return;
      }
      historyBox.replaceChildren();
      rows.forEach(row => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.title || 'REVEX Assistant';
        if (row.id === chat.conversationId) button.setAttribute('aria-current', 'true');
        button.title = new Date(row.lastMessageAt || row.createdAt).toLocaleString('en-IN');
        button.addEventListener('click', () => openConversation(row));
        historyBox.appendChild(button);
      });
    } catch (error) {
      historyBox.innerHTML = `<p class="rvx-card__meta">${escapeHtml(error.message)}</p>`;
    }
  }

  async function openConversation(row) {
    chat.conversationId = row.id;
    chat.renderConversation(row);
    await loadHistory();
  }

  newButton?.addEventListener('click', async () => {
    chat.newConversation();
    await loadHistory();
    panel.querySelector('[data-input]')?.focus();
  });

  (async () => {
    renderStatus(await chat.checkStatus());
    try {
      const [latest] = await api('/chat/conversations');
      if (latest) {
        chat.conversationId = latest.id;
        chat.renderConversation(latest);
      } else {
        // chat.mount() already rendered the single welcome greeting. Keeping it
        // avoids the duplicated two-message first-open experience.
      }
    } catch (error) {
      chat.addMessage('error', error.message, new Date());
    }
    await loadHistory();
  })();
})(window);
