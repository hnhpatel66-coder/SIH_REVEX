(() => {
  let deferredPrompt = null;
  const installButtons = () => [...document.querySelectorAll('[data-revex-install]')];

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    installButtons().forEach(btn => btn.classList.add('is-visible'));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installButtons().forEach(btn => btn.classList.remove('is-visible'));
  });

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-revex-install]');
    if (!btn || !deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    installButtons().forEach(item => item.classList.remove('is-visible'));
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !['localhost','127.0.0.1'].includes(location.hostname)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
