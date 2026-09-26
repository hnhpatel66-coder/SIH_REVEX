(() => {
  if (window.__REVEX_CHATBOT_LOADED__) return;
  window.__REVEX_CHATBOT_LOADED__ = true;

  const markup = `
    <button class="revex-chat-launcher" id="revexChatLauncher" type="button" aria-label="Open REVEX Assistant" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5.1A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7Z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>
      <span>Ask REVEX</span>
    </button>
    <section class="revex-chat-panel" id="revexChatPanel" aria-label="REVEX Assistant" aria-hidden="true">
      <header class="revex-chat-header">
        <div class="revex-chat-brand">
          <div class="revex-chat-avatar" aria-hidden="true">RX</div>
          <div><h2 class="revex-chat-title">REVEX Assistant</h2><p class="revex-chat-status">Online · Platform help</p></div>
        </div>
        <button class="revex-chat-close" id="revexChatClose" type="button" aria-label="Close REVEX Assistant">×</button>
      </header>
      <div class="revex-chat-messages" id="revexChatMessages" aria-live="polite">
        <div class="revex-chat-message bot">Hi 👋 I’m REVEX Assistant. I can help with rides, rentals, bookings, owner features and Razorpay payments.</div>
      </div>
      <div class="revex-chat-suggestions" id="revexChatSuggestions">
        <button class="revex-chat-chip" type="button" data-chat-prompt="How do I book a ride?">Book a ride</button>
        <button class="revex-chat-chip" type="button" data-chat-prompt="How do I rent a vehicle?">Rent a vehicle</button>
        <button class="revex-chat-chip" type="button" data-chat-prompt="Help me with a payment problem">Payment help</button>
        <button class="revex-chat-chip" type="button" data-chat-prompt="How do owner features work?">Owner help</button>
      </div>
      <form class="revex-chat-compose" id="revexChatForm">
        <textarea class="revex-chat-input" id="revexChatInput" rows="1" maxlength="2000" placeholder="Ask about REVEX..." aria-label="Message REVEX Assistant"></textarea>
        <button class="revex-chat-send" id="revexChatSend" type="submit" aria-label="Send message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
        </button>
      </form>
      <div class="revex-chat-note">Never share OTP, CVV, PIN, passwords or secret keys in chat.</div>
    </section>`;

  const host = document.createElement('div');
  host.id = 'revexChatRoot';
  host.innerHTML = markup;
  document.body.appendChild(host);

  const launcher = document.getElementById('revexChatLauncher');
  const panel = document.getElementById('revexChatPanel');
  const closeBtn = document.getElementById('revexChatClose');
  const form = document.getElementById('revexChatForm');
  const input = document.getElementById('revexChatInput');
  const sendBtn = document.getElementById('revexChatSend');
  const messages = document.getElementById('revexChatMessages');
  const suggestions = document.getElementById('revexChatSuggestions');

  const apiBase = () => String(window.REVEX_API_BASE || '/api').replace(/\/$/, '');

  function setOpen(open) {
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    launcher.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => input.focus(), 60);
  }

  function addMessage(text, type = 'bot') {
    const element = document.createElement('div');
    element.className = `revex-chat-message ${type}`;
    element.textContent = text;
    messages.appendChild(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  }

  function showTyping() {
    const element = document.createElement('div');
    element.className = 'revex-chat-message bot';
    element.innerHTML = '<span class="revex-chat-typing" aria-label="REVEX Assistant is typing"><span></span><span></span><span></span></span>';
    messages.appendChild(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  }

  async function ask(message) {
    const clean = String(message || '').trim();
    if (!clean || sendBtn.disabled) return;

    addMessage(clean, 'user');
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    const typing = showTyping();

    try {
      const response = await fetch(`${apiBase()}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: clean })
      });
      const data = await response.json().catch(() => ({}));
      typing.remove();
      if (!response.ok) throw new Error(data.message || 'REVEX Assistant is unavailable.');
      addMessage(data.reply || 'I could not generate a response. Please try again.', 'bot');
    } catch (error) {
      typing.remove();
      addMessage(error.message || 'REVEX Assistant is unavailable. Please try again.', 'bot error');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  launcher.addEventListener('click', () => setOpen(!panel.classList.contains('is-open')));
  closeBtn.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', event => { event.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 105)}px`;
  });
  suggestions.addEventListener('click', event => {
    const button = event.target.closest('[data-chat-prompt]');
    if (button) ask(button.dataset.chatPrompt);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
  });
})();
