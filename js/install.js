(() => {
  let deferredPrompt = null;

  function setupInstallButton() {
    const button = document.getElementById("revexInstallBtn");
    if (!button) return;

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredPrompt = event;
      button.hidden = false;
    });

    button.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      button.hidden = true;
    });

    window.addEventListener("appinstalled", () => {
      button.hidden = true;
      deferredPrompt = null;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupInstallButton);
  } else {
    setupInstallButton();
  }
})();
