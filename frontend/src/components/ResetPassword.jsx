import { useState } from "react";
import { resetPassword } from "../api.js";
import BrandMark from "./BrandMark.jsx";

// Reached from the link in a reset email: #/reset-password?token=...
// Rendered by main.jsx before App mounts, for the same reason VerifyEmail
// is - there's no session yet and there isn't meant to be, so going
// through the normal app shell would just bounce the user to a login
// screen they can't get past.
export default function ResetPassword({ token }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    // Checked here as well as by length validation because a typo in a
    // password you can't see is the single most common way people lock
    // themselves out a second time immediately after a reset.
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sl-auth">
      <div className="sl-panel sl-auth__card">
        <div className="sl-auth__brand">
          <BrandMark className="sl-auth__mark" />
          Starlink Monitor
        </div>

        {done ? (
          <>
            <div className="sl-auth__tagline">
              Password updated, and any other sessions on this account have been signed out. Log in with the new one.
            </div>
            <button
              className="sl-btn"
              style={{ width: "100%" }}
              onClick={() => {
                // Clearing the hash matters: leaving the (now spent)
                // token in the address bar means a refresh lands back
                // here and reports an already-used link, which looks
                // like a failure right after a success.
                window.location.hash = "";
                window.location.reload();
              }}
            >
              Go to log in
            </button>
          </>
        ) : (
          <>
            <div className="sl-auth__tagline">Choose a new password. The link you used is valid for one hour.</div>
            <form onSubmit={handleSubmit}>
              <div className="sl-field">
                <label>New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
              </div>
              <div className="sl-field">
                <label>Confirm it</label>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
              </div>
              {error && <div className="sl-error">{error}</div>}
              <button className="sl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Saving..." : "Set new password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
