/* ============================================================================
 * REVEX ASSISTANT WIDGET  (js/chat.js)
 *
 * MARKUP AND BEHAVIOUR
 *
 * The visual design is the reference widget from better_UI.zip: a green-gradient
 * pill launcher with a chat-bubble icon, a panel that opens ABOVE the launcher
 * with a fade-and-scale animation, a green header carrying an "RX" avatar, white
 * assistant bubbles against solid green user bubbles, a scrolling row of
 * suggestion chips, and a permanent "never share your OTP" reminder.
 *
 * WHAT WAS CHANGED FROM THE REFERENCE, AND WHY
 *
 * The reference kept the transcript in localStorage and posted to an anonymous
 * endpoint. Nothing loaded on a new device, and any hand-edited storage key
 * could read another account's messages. Here the server owns the conversation
 * and scopes it to the signed-in account, so this file only renders what the
 * API returns. The markup, classes and interaction model match the reference;
 * the storage does not.
 *
 * The previous version of this file drifted from the reference in three ways
 * that made it look broken: the panel was positioned at bottom:18px so it sat
 * ON TOP of the launcher instead of above it, opening toggled the `hidden`
 * attribute so there was no animation, and the launcher was a bare dot with the
 * word "Assistant" instead of the pill and icon.
 *
 * THEME
 *
 * Colours live entirely in css/chat.css as `--revex-chat-*` custom properties,
 * and the dark block there redefines only those properties. This file contains
 * no colours at all, so the widget follows the app's light/dark switch.
 *
 * Mounted automatically for every signed-in account (rider, owner, admin) by
 * js/main.js. chat.html uses the same widget for its full-page view.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX || {};
  const api = R.api;
  const escapeHtml = R.escapeHtml || (value => String(value ?? ''));

  /** Short, task-shaped prompts. Kept short so the chip row stays readable. */
  const SUGGESTIONS = [
    { label: 'Book a ride', prompt: 'How do I find and book a ride?' },
    { label: 'Rent a vehicle', prompt: 'How do I rent a vehicle for a few days?' },
    { label: 'Payment help', prompt: 'My payment failed. What should I do?' },
    { label: 'Refunds', prompt: 'How do cancellations and refunds work?' },
    { label: 'Offer a ride', prompt: 'How do I list my vehicle and offer a ride?' }
  ];

  const GREETING = 'Hi 👋 I’m REVEX Assistant. I can help with rides, rentals, bookings, owner features and Razorpay payments.';

  /* Icons are inlined so the widget needs no extra network request. */
  const ICON_BUBBLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5.1A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7Z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
  const ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const SAFETY_NOTE = 'Never share OTP, CVV, PIN, passwords or secret keys in chat.';

  let panel = null;
  let log = null;
  let input = null;
  let sendButton = null;
  let statusBox = null;
  let subLine = null;
  let launcher = null;
  let conversationId = '';
  let sending = false;
  let mounted = false;

  function stamp(value) {
    try { return new Date(value || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  /** Both `bot` (reference name) and `assistant` (our stored role) are accepted. */
  function roleClass(role) {
    return role === 'user' ? 'user' : 'assistant';
  }

  function addMessage(role, text, at) {
    if (!log) return null;
    const kind = roleClass(role);
    const bubble = document.createElement('div');
    bubble.className = `rvx-chat-msg rvx-chat-msg--${kind}`;
    // textContent, never innerHTML: assistant output is untrusted text.
    const body = document.createElement('span');
    body.textContent = String(text || '');
    const time = document.createElement('span');
    time.className = 'rvx-chat-msg__time';
    time.textContent = stamp(at);
    bubble.append(body, time);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function showTyping() {
    if (!log) return null;
    const node = document.createElement('div');
    node.className = 'rvx-chat-msg rvx-chat-msg--assistant rvx-chat-typing';
    node.innerHTML = '<span></span><span></span><span></span>';
    node.setAttribute('aria-label', 'The assistant is typing');
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function setStatus(message) {
    if (!statusBox) return;
    statusBox.textContent = message || '';
    statusBox.hidden = !message;
  }

  function setSubLine(text) {
    if (subLine) subLine.textContent = text;
  }

  function setBusy(busy) {
    sending = busy;
    if (sendButton) {
      sendButton.disabled = busy;
      // The icon stays put and only the accessible name changes, so the button
      // does not resize mid-send.
      sendButton.setAttribute('aria-label', busy ? 'Sending' : 'Send message');
      sendButton.dataset.busy = busy ? 'true' : 'false';
    }
    if (input) input.disabled = busy;
  }

  async function send(text) {
    const message = String(text || '').trim();
    if (!message || sending) return null;
    setBusy(true);
    addMessage('user', message, new Date());
    const typing = showTyping();
    try {
      const result = await api('/chat', { method: 'POST', body: { message, conversationId: conversationId || undefined } });
      typing?.remove();
      conversationId = result.conversation?.id || conversationId;
      addMessage('assistant', result.reply, new Date());
      setStatus('');
    } catch (error) {
      typing?.remove();
      addMessage('error', error.message, new Date());
      if (error.status === 503 || /not configured/i.test(error.message)) {
        setStatus(error.message);
        setSubLine('Setup required');
      }
    } finally {
      setBusy(false);
      // Only steal focus when the panel is actually on screen.
      if (isOpen()) input?.focus();
    }
    return null;
  }

  function buildPanel() {
    panel = document.createElement('section');
    panel.className = 'rvx-chat-panel';
    // Starts closed. `is-open` (not `hidden`) drives the animation, so the
    // panel can transition instead of appearing instantly.
    panel.id = 'revexChatPanel';
    panel.setAttribute('aria-label', 'REVEX Assistant');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header class="rvx-chat-head">
        <div class="rvx-chat-head__brand">
          <div class="rvx-chat-head__avatar" aria-hidden="true">RX</div>
          <div class="rvx-chat-head__text">
            <h2 class="rvx-chat-head__title">REVEX Assistant</h2>
            <p class="rvx-chat-head__sub" data-role>Online · Platform help</p>
          </div>
        </div>
        <div class="rvx-chat-head__actions">
          <button type="button" class="rvx-chat-head__btn" data-new title="Start a new conversation" aria-label="Start a new conversation">${ICON_NEW}</button>
          <button type="button" class="rvx-chat-head__btn" data-close title="Close" aria-label="Close the assistant">${ICON_CLOSE}</button>
        </div>
      </header>
      <div class="rvx-chat-log" data-log role="log" aria-live="polite" aria-relevant="additions text"></div>
      <p class="rvx-chat-status" data-status role="status" hidden></p>
      <div class="rvx-chat-suggest" data-suggest aria-label="Suggested questions"></div>
      <form class="rvx-chat-form" data-form>
        <label class="sr-only" for="revexChatInput">Message the REVEX Assistant</label>
        <textarea id="revexChatInput" data-input rows="1" placeholder="Ask about rides, rentals or refunds…" maxlength="2000"></textarea>
        <button type="submit" data-send aria-label="Send message">${ICON_SEND}</button>
      </form>
      <p class="rvx-chat-note">${SAFETY_NOTE}</p>`;
    document.body.appendChild(panel);

    log = panel.querySelector('[data-log]');
    input = panel.querySelector('[data-input]');
    sendButton = panel.querySelector('[data-send]');
    statusBox = panel.querySelector('[data-status]');
    subLine = panel.querySelector('[data-role]');
    sendButton.dataset.busy = 'false';

    const suggest = panel.querySelector('[data-suggest]');
    SUGGESTIONS.forEach(({ label, prompt }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.chatPrompt = prompt;
      button.addEventListener('click', () => { if (input) input.value = prompt; send(prompt); });
      suggest.appendChild(button);
    });

    panel.querySelector('[data-close]').addEventListener('click', hide);
    panel.querySelector('[data-new]').addEventListener('click', newConversation);
    panel.querySelector('[data-form]').addEventListener('submit', event => {
      event.preventDefault();
      const text = input.value;
      input.value = '';
      input.style.height = 'auto';
      send(text);
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    });
    input.addEventListener('keydown', event => {
      // Enter sends, Shift+Enter makes a new line.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        panel.querySelector('[data-form]').requestSubmit();
      }
    });

    // Esc closes, matching the reference's keyboard affordance.
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') hide();
    });
    return panel;
  }

  function greet() {
    if (!log) return;
    const user = R.getStoredUser?.() || {};
    const name = String(user.name || '').split(' ')[0];
    addMessage('assistant', name ? `${GREETING.replace('Hi 👋', `Hi ${name} 👋`)}` : GREETING, new Date());
  }

  /** Renders a server-stored conversation, e.g. after switching history. */
  function renderConversation(conversation) {
    if (!log || !conversation) return;
    log.replaceChildren();
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!messages.length) return greet();
    messages.forEach(message => addMessage(message.role, message.text, message.at));
  }

  function newConversation() {
    conversationId = '';
    log?.replaceChildren();
    setStatus('');
    greet();
    if (isOpen()) input?.focus();
  }

  function buildLauncher() {
    launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'rvx-chat-launcher';
    launcher.id = 'revexChatLauncher';
    launcher.setAttribute('aria-label', 'Open the REVEX Assistant');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'revexChatPanel');
    launcher.innerHTML = `${ICON_BUBBLE}<span>Ask REVEX</span>`;
    launcher.addEventListener('click', () => (isOpen() ? hide() : show()));
    document.body.appendChild(launcher);
    return launcher;
  }

  function isOpen() {
    return Boolean(panel && panel.classList.contains('is-open'));
  }

  function show() {
    if (!panel) return;
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    // The launcher deliberately STAYS visible: the panel is positioned above it
    // (bottom: 88px vs the 52px launcher at bottom: 24px), so it reads as a
    // second, smaller target rather than a stray pill under the panel's shadow.
    launcher?.setAttribute('aria-expanded', 'true');
    input?.focus();
  }

  function hide() {
    if (!panel) return;
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    launcher?.setAttribute('aria-expanded', 'false');
  }

  async function checkStatus() {
    try {
      const status = await api('/chat/status');
      setSubLine(status.configured
        ? (status.model || 'Online · Platform help')
        : 'Setup required');
      if (!status.configured) setStatus(status.message);
      return status;
    } catch {
      // /chat/status needs a session. If it fails the first message will say so,
      // so this is deliberately non-fatal.
      setSubLine('Offline');
      return { configured: false, message: '' };
    }
  }

  /**
   * Mounts the launcher + panel. Safe to call more than once.
   *
   * @param {object}  [options]
   * @param {boolean} [options.launcher=true] false for an in-page host.
   * @param {Element} [options.host]         move the panel into this element.
   * @param {boolean} [options.chrome]       keep the header close button (default
   *                                        false for a host, which has its own).
   */
  function mount(options = {}) {
    if (!R.getToken?.()) return null;
    if (!panel) buildPanel();
    if (options.launcher !== false && !launcher && !document.body.dataset.noChatLauncher) buildLauncher();
    if (!mounted) {
      mounted = true;
      if (!log.childElementCount) greet();
      checkStatus();
    }

    if (options.host) {
      // A page host takes over layout entirely. Doing it with one attribute plus
      // a CSS rule, rather than the inline-style surgery both page hosts
      // previously did, means the widget's own `is-open` animation and
      // pointer-events rules cannot be left half-overridden.
      panel.dataset.host = 'page';
      options.host.replaceChildren(panel);
      if (!options.chrome) panel.querySelector('[data-close]')?.setAttribute('hidden', '');
      panel.setAttribute('aria-hidden', 'false');
      panel.classList.add('is-open');
      log?.classList.add('rvx-chat-log--tall');
    } else if (options.open === true) {
      show();
    }
    return panel;
  }

  global.RevexChat = {
    mount,
    send,
    show,
    hide,
    isOpen,
    checkStatus,
    addMessage,
    showTyping,
    setStatus,
    greet,
    newConversation,
    renderConversation,
    get conversationId() { return conversationId; },
    set conversationId(value) { conversationId = value; },
    get element() { return panel; },
    clearLog() { log?.replaceChildren(); }
  };
})(window);
