// Install prompts and safe, opt-in updates for the frontend shell.
// Never caches API responses, messages, credentials, or socket events.
export function setupPWA(appName) {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  const dismissed = () => {
    try { return sessionStorage.getItem("pwa-install-dismissed") === "1"; }
    catch { return false; }
  };
  let installEvent = null;
  let registration = null;
  let refreshRequested = false;
  let notice = null;
  let currentKind = "";

  const style = document.createElement("style");
  style.textContent = \`
    .comnexus-pwa-notice{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));right:16px;z-index:2147483000;display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:min(380px,calc(100vw - 32px));padding:12px 14px;background:#171923;color:#f8fafc;border:1px solid #404354;border-radius:14px;box-shadow:0 12px 36px #0005;font:500 13px/1.5 system-ui,sans-serif}
    .comnexus-pwa-notice span{flex:1;min-width:150px}
    .comnexus-pwa-notice button{border:0;border-radius:9px;padding:8px 10px;background:#f8fafc;color:#111827;font:700 12px system-ui,sans-serif;cursor:pointer}
    .comnexus-pwa-notice button.pwa-dismiss{background:transparent;color:#cbd5e1;padding:6px}
    .comnexus-pwa-notice button:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}
  \`;
  document.head.appendChild(style);

  function close() {
    notice?.remove();
    notice = null;
    currentKind = "";
  }
  function show(kind, message, action, callback) {
    if (kind === "install" && currentKind === "update") return;
    close();
    currentKind = kind;
    const root = document.createElement("div");
    root.className = "comnexus-pwa-notice";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    const info = document.createElement("span");
    info.textContent = message;
    root.appendChild(info);
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.textContent = action;
    actionButton.addEventListener("click", callback);
    root.appendChild(actionButton);
    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "pwa-dismiss";
    dismissButton.setAttribute("aria-label", "Dismiss " + kind + " notification");
    dismissButton.textContent = "✕";
    dismissButton.addEventListener("click", () => {
      if (kind === "install") {
        try { sessionStorage.setItem("pwa-install-dismissed", "1"); } catch { /* private mode */ }
      }
      close();
    });
    root.appendChild(dismissButton);
    document.body.appendChild(root);
    notice = root;
  }

  function offerInstall() {
    if (standalone() || dismissed() || currentKind === "update") return;
    if (installEvent) {
      show("install", "Install " + appName + " for a full-screen, app-like experience.", "Install", async () => {
        const event = installEvent;
        installEvent = null;
        close();
        try { await event.prompt(); await event.userChoice; } catch { /* browser declined */ }
      });
    } else if (ios) {
      show("install", "Install " + appName + " on your iPhone or iPad.", "How to", () => {
        show("instructions", "Open this site in Safari, tap Share, then Add to Home Screen.", "Got it", close);
      });
    }
  }

  function offerUpdate() {
    if (!registration?.waiting || !navigator.serviceWorker.controller) return;
    show("update", "A new " + appName + " version is ready.", "Update", () => {
      refreshRequested = true;
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
      close();
    });
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installEvent = event;
    offerInstall();
  });
  window.addEventListener("appinstalled", () => { installEvent = null; close(); });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshRequested) window.location.reload();
  });

  // HTTPS is required outside localhost. Development stays free of PWA caching.
  if (!import.meta.env.PROD || !window.isSecureContext) return;
  window.addEventListener("load", async () => {
    try {
      registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      if (registration.waiting) offerUpdate();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed") offerUpdate();
        });
      });
      const update = () => {
        if (navigator.onLine && document.visibilityState === "visible")
          registration.update().catch(() => {});
      };
      const interval = window.setInterval(update, 60 * 60 * 1000);
      window.addEventListener("pagehide", () => window.clearInterval(interval), { once: true });
      document.addEventListener("visibilitychange", update);
      window.addEventListener("online", update);
    } catch (error) {
      console.warn("PWA registration unavailable:", error);
    }
    if (ios) window.setTimeout(offerInstall, 2000);
  }, { once: true });
}
