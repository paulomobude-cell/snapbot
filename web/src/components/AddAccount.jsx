import { useState } from "react";
import Modal from "./Modal.jsx";

export default function AddAccount({ first, onClose, onCreate }) {
  const [mode, setMode] = useState("password"); // password | screen
  const [form, setForm] = useState({ label: "", username: "", password: "", remember: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <Modal title={first ? "Add your Snapchat account" : "Add account"} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const data = mode === "password" ? form : { label: form.label || form.username, username: form.username };
          await onCreate(data);
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}>
        <div className="segmented">
          <button type="button" className={mode === "password" ? "on" : ""} onClick={() => setMode("password")}>Username & password</button>
          <button type="button" className={mode === "screen" ? "on" : ""} onClick={() => setMode("screen")}>Log in on live screen</button>
        </div>
        <label className="field">
          <span>Name in dashboard</span>
          <input value={form.label} onChange={set("label")} placeholder="e.g. Personal" />
        </label>
        <label className="field">
          <span>Snapchat username or email</span>
          <input value={form.username} onChange={set("username")} autoComplete="username" required={mode === "password"} autoFocus />
        </label>
        {mode === "password" ? (
          <>
            <label className="field">
              <span>Password</span>
              <input type="password" value={form.password} onChange={set("password")} autoComplete="current-password" required />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.remember} onChange={set("remember")} />
              <span>
                Remember password
                <small className="muted">Stored encrypted on your server, so the bot can log back in on its own. Leave off to use it for this login only.</small>
              </span>
            </label>
          </>
        ) : (
          <p className="muted small">A browser opens on the server and you log in by clicking and typing on its live screen. Your password never goes through the dashboard.</p>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Adding…" : "Add account"}</button>
        </div>
      </form>
    </Modal>
  );
}
