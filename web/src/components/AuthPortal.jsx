import { useState } from "react";

// Comnexus login happens before a user can see or create Snapchat accounts.
// API keys here are per-user revocable credentials, NEVER the service API_TOKEN.
export default function AuthPortal({ backend, onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [key, setKey] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pendingSession, setPendingSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changeMode = value => { setMode(value); setError(""); setConfirmation(""); setPendingSession(null); };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!backend) throw new Error("Frontend VITE_API_URL is missing. Configure the Railway backend in Vercel.");
      const paths = { login: "login", signup: "signup", recovery: "recover", key: "key-login" };
      const body = mode === "key" ? { apiKey: key.trim() } :
        mode === "recovery" ? { phone, recoveryCode, newPassword: password } : { phone, password };
      const res = await fetch(backend + "/api/auth/" + paths[mode], {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not sign in.");
      const credentials = { apiKey: data.apiKey, user: data.user };
      setPassword("");
      setKey("");
      setRecoveryCode("");
      if (data.recoveryCode) {
        setPendingSession(credentials);
        setConfirmation(data.recoveryCode);
      } else {
        onSignedIn(credentials);
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return <div className="setup comnexus-auth">
    <div className="card setup-card">
      <div className="brand"><span className="logo">👻</span> SnapBot <span className="muted small">by Comnexus</span></div>
      {pendingSession ? <>
        <h2>Save your recovery code</h2>
        <p className="muted">This one-time code is required to reset your password. Store it privately; it is not shown again.</p>
        <output className="recovery-output">{confirmation}</output>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(confirmation)}>Copy recovery code</button>
        <p className="muted small">Your personal Comnexus API key is separate from the server's master token. Treat it like a password; you can use it to sign in again.</p>
        <output className="recovery-output">{pendingSession.apiKey}</output>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(pendingSession.apiKey)}>Copy personal API key</button>
        <button type="button" className="btn primary" onClick={() => onSignedIn(pendingSession)}>
          I've saved my recovery code
        </button>
      </> : <>
        <p className="muted">Sign in to Comnexus to manage only your own Snapchat sessions.</p>
        <div className="segmented auth-tabs" role="group" aria-label="Account access">
          {[["login", "Log in"], ["signup", "Sign up"], ["key", "API key"]].map(([id, title]) =>
            <button type="button" className={mode === id ? "on" : ""} key={id} onClick={() => changeMode(id)}>{title}</button>)}
        </div>
        <form className="stack" onSubmit={submit}>
          {mode !== "key" && <label className="field"><span>Phone number</span><input
            placeholder="Country code + number" type="tel" autoComplete="tel" value={phone}
            onChange={e => setPhone(e.target.value)} required /></label>}
          {mode === "key" ? <label className="field"><span>Your personal account API key</span>
            <input type="password" autoComplete="off" value={key}
              onChange={e => setKey(e.target.value)} required /></label> :
            <label className="field"><span>{mode === "recovery" ? "New password" : "Password"}</span>
              <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? 1 : 12} value={password}
                onChange={e => setPassword(e.target.value)} required /></label>}
          {mode === "recovery" && <label className="field"><span>Recovery code</span>
            <input autoComplete="off" value={recoveryCode}
              onChange={e => setRecoveryCode(e.target.value)} required /></label>}
          {error && <div className="alert" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Log in" : mode === "signup" ? "Create account" : mode === "key" ? "Use account key" : "Reset password"}
          </button>
        </form>
        <div className="row wrap">
          {(mode === "login" || mode === "recovery") && <button type="button"
            className="link" onClick={() => changeMode(mode === "recovery" ? "login" : "recovery")}>
              {mode === "login" ? "Forgot password?" : "Back to login"}</button>}
        </div>
      </>}
    </div>
  </div>;
}
