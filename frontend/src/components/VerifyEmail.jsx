import { useState } from "react";
import { verifyEmail } from "../api.js";

// Rendered from main.jsx in place of the whole app when the URL is a
// confirmation link (#/verify-email?token=...) - same reasoning as
// SharedMonitorView/SharedStatusPageView being routed before App ever
// mounts, just for the opposite direction: this one is *establishing* a
// session rather than deliberately avoiding one.
//
// Deliberately does NOT call verifyEmail() the moment this mounts. A
// link that consumes itself just by being loaded is a well-known trap
// for exactly this kind of one-time-token flow: Gmail and plenty of
// other mail clients (and some phones' link-preview features) fetch a
// link's destination automatically to scan or preview it, before a
// person ever taps it themselves - if that fetch runs this component's
// side effect, it silently burns the token, and the actual human who
// clicks the link next gets a confusing "invalid or already used"
// error for a link they never got to use. Requiring an explicit button
// tap means only a real person looking at a real screen can consume it.
//
// On success, this doesn't try to hand a user object to App via props -
// there's no clean way to do that from outside App's own tree. Instead
// it clears the URL back to plain "/" and reloads: the confirmation
// POST already set the session cookie server-side, so App's own
// getMe() on that fresh mount picks it up and shows the authed app
// directly, the same as a normal login would have.
export default function VerifyEmail({ token }) {
  const [status, setStatus] = useState("ready"); // ready | verifying | error
  const [error, setError] = useState(null);

  function handleConfirm() {
    setStatus("verifying");
    setError(null);
    verifyEmail(token)
      .then(() => {
        window.location.href = window.location.pathname;
      })
      .catch((err) => {
        setError(err.message);
        setStatus("error");
      });
  }

  return (
    <div className="sl-auth">
      <div className="sl-panel sl-auth__card">
        <div className="sl-auth__brand">
          <svg width="24" height="24" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="20" fill="#0a0e14" />
            <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#4db5ff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Starlink Monitor
        </div>
        {status === "error" ? (
          <>
            <div className="sl-error">{error}</div>
            <a className="sl-btn" href={window.location.pathname} style={{ width: "100%", textAlign: "center", display: "block", textDecoration: "none", boxSizing: "border-box" }}>
              Back to sign up
            </a>
          </>
        ) : (
          <>
            <div className="sl-auth__tagline">Tap below to finish creating your account.</div>
            <button className="sl-btn" type="button" style={{ width: "100%" }} onClick={handleConfirm} disabled={status === "verifying"}>
              {status === "verifying" ? "Confirming..." : "Confirm my account"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
