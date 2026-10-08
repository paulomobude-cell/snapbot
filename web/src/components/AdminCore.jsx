import { useCallback, useEffect, useState } from "react";

const bytes = n => {
  const size = Number(n || 0);
  return size < 1024 ? size + " B" : size < 1024 ** 2 ? (size / 1024).toFixed(1) + " KB" :
    size < 1024 ** 3 ? (size / 1024 ** 2).toFixed(1) + " MB" : (size / 1024 ** 3).toFixed(2) + " GB";
};

// The ADMIN_API_TOKEN is a separate Railway secret, not the user's login key
// and not the master service API_TOKEN. This page never stores it on disk.
export default function AdminCore({ backend, onClose, toast }) {
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [legacy, setLegacy] = useState([]);
  const [audit, setAudit] = useState([]);
  const [claimFor, setClaimFor] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const request = useCallback(async (path, init = {}) => {
    const res = await fetch(backend + "/api/admin/" + path, {
      ...init,
      headers: { "Content-Type": "application/json", "x-admin-key": secret, ...(init.headers || {}) },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Administrator request failed");
    return data;
  }, [backend, secret]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [status, info, actions] = await Promise.all([request("overview"), request("users"), request("audit")]);
      setOverview(status);
      setUsers(info.users || []);
      setLegacy(info.legacy || []);
      setAudit(actions || []);
      setAuthenticated(true);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [request]);

  const claim = async (account) => {
    const userId = claimFor[account.id];
    if (!userId) return toast("Select an owner first", "error");
    if (!window.confirm(`Assign legacy Snapchat account "${account.label}" to this user? This grants access to its chat archive and saved browser profile.`)) return;
    try {
      await request("claim", { method: "POST", body: JSON.stringify({ accountId: account.id, userId }) });
      toast("Account assigned", "success");
      await refresh();
    } catch (e) { toast(e.message, "error"); }
  };

  const removeUser = async user => {
    const entered = window.prompt(`Permanently remove Comnexus user ${user.phone}, Snapchat profiles, and stored history? Type the full phone number to confirm:`);
    if (!entered || entered.replace(/\D/g, "") !== user.phone) return;
    if (!window.confirm("This action is permanent. Continue?")) return;
    try {
      await request("users/" + encodeURIComponent(user.id), {
        method: "DELETE", body: JSON.stringify({ confirmPhone: entered }),
      });
      toast("User removed", "success");
      await refresh();
    } catch (e) { toast(e.message, "error"); }
  };

  return <div className="admin-core-shell">
    <header className="admin-head">
      <div><strong>Comnexus · Admin Core</strong><p className="muted small">SnapBot users, sessions and archive management</p></div>
      <button className="btn small" onClick={onClose}>Close</button>
    </header>
    {!authenticated ? <form className="card admin-login stack" onSubmit={e => { e.preventDefault(); void refresh(); }}>
      <strong>Administrator authorization</strong>
      <p className="muted small">Enter the separate ADMIN_API_TOKEN configured on the SnapBot Railway service. It is not stored in your browser.</p>
      <input type="password" autoComplete="off" spellCheck={false} aria-label="Administrator API token"
        minLength={32} value={secret} onChange={e => setSecret(e.target.value)} required />
      {error && <div className="alert" role="alert">{error}</div>}
      <button className="btn primary" disabled={loading}>{loading ? "Verifying…" : "Unlock Admin Core"}</button>
    </form> : <main className="admin-content stack">
      <div className="row wrap">
        <button className="btn small" disabled={loading} onClick={() => void refresh()}>Refresh</button>
        <button className="btn small" onClick={() => { setAuthenticated(false); setSecret(""); setOverview(null); }}>Lock admin</button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {overview && <div className="admin-stats">
        {[
          ["Comnexus users", overview.users],
          ["Snapchat accounts", overview.snapchatAccounts],
          ["Online sessions", overview.connected],
          ["Unassigned legacy", overview.unassigned],
          ["Archived messages", overview.archive],
          ["Stored media", bytes(overview.mediaBytes)],
          ["Media storage", overview.mediaStorage === "r2" ? "R2" : "Railway volume"],
        ].map(([label, value]) => <div className="card admin-stat" key={label}>
          <span className="muted small">{label}</span><strong>{value}</strong>
        </div>)}
      </div>}
      {legacy.length > 0 && <section className="card admin-section stack">
        <h2>Unassigned legacy Snapchat accounts</h2>
        <p className="muted small">These accounts were present before user authentication. Claiming grants access to their saved messages, login profiles, and media. Nothing is automatically assigned.</p>
        {legacy.map(a => <div className="admin-line" key={a.id}>
          <div><strong>{a.label}</strong><span className="muted small"> · {a.username || "No username"} · {a.status}</span></div>
          <select aria-label={`Owner for ${a.label}`} value={claimFor[a.id] || ""}
            onChange={e => setClaimFor(p => ({ ...p, [a.id]: e.target.value }))}>
            <option value="">Select Comnexus user</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.phone}</option>)}
          </select>
          <button className="btn small" disabled={!claimFor[a.id]} onClick={() => void claim(a)}>Assign</button>
        </div>)}
      </section>}
      <section className="card admin-section stack">
        <h2>Registered users</h2>
        {users.length === 0 ? <p className="muted">No users yet.</p> : users.map(u =>
          <div className="admin-user" key={u.id}>
            <div className="row wrap"><strong>{u.phone}</strong><span className="muted small">Joined {new Date(u.created_at).toLocaleDateString()}</span></div>
            <p className="muted small">{u.accounts.length} Snapchat account(s) · {u.usage?.archived || 0} archived messages · {bytes(u.usage?.mediaBytes)} stored media</p>
            {u.accounts.map(a => <p className="small" key={a.id}>{a.label} · {a.status} · {a.username || "No username"}</p>)}
            <button className="btn danger small" onClick={() => void removeUser(u)}>Delete user and all their accounts</button>
          </div>)}
      </section>
      <section className="card admin-section stack">
        <h2>Recent admin operations</h2>
        {audit.length === 0 ? <p className="muted small">No administrative changes recorded.</p> : audit.map((item, i) =>
          <div className="admin-line" key={i}><strong>{item.action}</strong>
            <span className="muted small">{item.target || "—"}</span>
            <span className="muted small">{new Date(item.at).toLocaleString()}</span>
          </div>)}
      </section>
    </main>}
  </div>;
}
