import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import VerifyEmail from "./components/VerifyEmail.jsx";
import "./App.css";

// Belt-and-braces for the "no copying UI text" behavior set up in
// App.css: CSS user-select handles most browsers, but Android/Chrome can
// still pop the long-press context menu on a non-selectable element.
// Blocked globally, except on actual form fields and anything explicitly
// marked selectable (agent tokens, API tokens - things people genuinely
// need to copy).
window.addEventListener(
  "contextmenu",
  (e) => {
    const el = e.target;
    const isEditable = el.closest && el.closest('input, textarea, [contenteditable="true"], .sl-selectable');
    if (!isEditable) e.preventDefault();
  },
  { passive: false }
);

// Registered unconditionally at boot (not just when someone opens
// Settings and usePush.js runs) so the offline fallback page in sw.js
// gets cached on the first visit for everyone, not only people who turn
// push notifications on.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Installed PWAs can sit backgrounded for a long time without
        // the browser re-checking sw.js on its own. Force a check
        // whenever the app comes back to the foreground.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch(() => {
        // Offline fallback just won't be available this session (e.g.
        // private browsing) - not worth surfacing.
      });

    let refreshedOnce = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshedOnce) return;
      refreshedOnce = true;
      window.location.reload();
    });
  });
}

// An account-confirmation link is #/verify-email?token=<token>, checked
// here before App (and its getMe() session check) ever mounts, so
// opening one never triggers a login prompt.
const verifyMatch = window.location.hash.match(/^#\/verify-email\?token=(.+)$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{verifyMatch ? <VerifyEmail token={decodeURIComponent(verifyMatch[1])} /> : <App />}</React.StrictMode>
);

// Splash lives in index.html so it's visible before this file finishes
// loading. Waits for BOTH React having painted AND the animation having
// had its full runtime - whichever finishes last - so the sequence is
// never cut short, and a slow load is never held past when the app is
// actually ready.
const MIN_SPLASH_MS = 1700;
const splashStart = window.__slSplashStart || performance.now();

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const elapsed = performance.now() - splashStart;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      const splash = document.getElementById("sl-splash");
      if (!splash) return;
      splash.classList.add("sl-splash-hidden");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    }, remaining);
  });
});
