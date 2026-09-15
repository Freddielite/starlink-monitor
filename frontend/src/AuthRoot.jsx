import { useState } from "react";
import { login, signup, verifyLoginTotp } from "./api.js";
import BrandMark from "./components/BrandMark.jsx";

export default function AuthRoot({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set once password auth succeeds but the account has 2FA on - the
  // form below swaps to asking for a code instead of starting over.
  const [awaitingTotp, setAwaitingTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  // Set once signup succeeds - there's no session yet (see api.js's
  // verifyEmail/routes/auth.js: nothing is created until the
  // confirmation link is clicked), so this replaces the form with
  // "check your email" instead of calling onAuthed.
  const [signupMessage, setSignupMessage] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const result = await login({ email, password });
        if (result.requires_totp) setAwaitingTotp(true);
        else onAuthed(result);
      } else {
        const result = await signup({ email, password, signup_code: signupCode });
        setSignupMessage(result.message);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyTotp(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await verifyLoginTotp(
        useBackupCode ? { backup_code: totpCode } : { code: totpCode }
      );
      onAuthed(user);
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
        <div className="sl-auth__tagline">Payment, hardware and usage tracking for every Starlink kit you're responsible for.</div>

        {signupMessage ? (
          <>
            <div className="sl-auth__tagline">{signupMessage}</div>
            <button
              className="sl-btn"
              type="button"
              style={{ width: "100%" }}
              onClick={() => {
                setSignupMessage(null);
                setMode("login");
                setPassword("");
                setSignupCode("");
              }}
            >
              Back to log in
            </button>
          </>
        ) : awaitingTotp ? (
          <form onSubmit={handleVerifyTotp}>
            <div className="sl-field">
              <label>{useBackupCode ? "Backup code" : "6-digit code from your authenticator app"}</label>
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode={useBackupCode ? "text" : "numeric"}
                autoFocus
                required
              />
            </div>
            {error && <div className="sl-error">{error}</div>}
            <button className="sl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Verifying..." : "Verify"}
            </button>
            <div className="sl-auth__switch">
              <button type="button" onClick={() => { setUseBackupCode((v) => !v); setTotpCode(""); setError(null); }}>
                {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit}>
              <div className="sl-field">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className="sl-field">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </div>
              {mode === "signup" && (
                <div className="sl-field">
                  <label>Signup code</label>
                  <input type="text" value={signupCode} onChange={(e) => setSignupCode(e.target.value)} />
                </div>
              )}
              {error && <div className="sl-error">{error}</div>}
              <button className="sl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Working..." : mode === "login" ? "Log in" : "Create account"}
              </button>
            </form>

            <div className="sl-auth__switch">
              {mode === "login" ? (
                <>No account yet? <button onClick={() => setMode("signup")}>Sign up</button></>
              ) : (
                <>Already have an account? <button onClick={() => setMode("login")}>Log in</button></>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
