import { useEffect, useState } from "react";

const DISMISS_KEY = "slm-install-dismissed";

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own flag - it doesn't support the display-mode
    // media query the same way.
    window.navigator.standalone === true
  );
}

function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;
}

// Android/Chrome can prompt to install programmatically via
// beforeinstallprompt. iOS Safari has no such API at all - the only
// way to install there is the manual Share > Add to Home Screen flow,
// so that path gets its own instructional banner instead of a button.
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [iosVisible, setIosVisible] = useState(false);

  useEffect(() => {
    if (isStandalone() || dismissed) return;

    function onBeforeInstallPrompt(e) {
      e.preventDefault();
      setDeferredPrompt(e);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);

    if (isIos()) setIosVisible(true);

    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, [dismissed]);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  async function handleInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    dismiss();
  }

  if (dismissed || isStandalone()) return null;
  if (!deferredPrompt && !iosVisible) return null;

  return (
    <div className="sl-install-banner sl-panel">
      <svg className="sl-install-banner__icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" rx="20" fill="#0a0f0d" />
        <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#3ddc84" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="sl-install-banner__text">
        <div className="sl-install-banner__title">Install Starlink Monitor</div>
        <div className="sl-install-banner__desc">
          {deferredPrompt
            ? "Add it to your home screen for the full app experience."
            : "Tap the Share icon, then \u201cAdd to Home Screen.\u201d"}
        </div>
      </div>
      {deferredPrompt ? (
        <button className="sl-btn sl-btn--sm" onClick={handleInstall}>Install</button>
      ) : (
        <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={dismiss}>Got it</button>
      )}
      <button className="sl-install-banner__close" onClick={dismiss} aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="5" x2="19" y2="19" />
          <line x1="19" y1="5" x2="5" y2="19" />
        </svg>
      </button>
    </div>
  );
}
