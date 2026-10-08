import { useState } from "react";
import Modal from "./Modal.jsx";
import { Icon, STATUS_LABEL } from "../util.jsx";

export default function AccountSettings({ account, status, onClose, onSave, onRestart, onLogout, onRemove, onDisconnect }) {
  const [label, setLabel] = useState(account.label);
  const [confirm, setConfirm] = useState("");
  return (
    <Modal title="Account settings" onClose={onClose}>
      <div className="stack">
        <div className="kv">
          <span className="muted">Snapchat user</span><span>{account.username || "—"}</span>
          <span className="muted">Session</span><span>{STATUS_LABEL[status] || status}</span>
          <span className="muted">Password</span>
          <span>
            {account.remembered ? "Remembered (encrypted)" : "Not stored"}
            {account.remembered && <button className="link" onClick={() => onSave({ remember: false })}>Forget</button>}
          </span>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); onSave({ label }); }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Account name" />
          <button className="btn" disabled={!label.trim() || label === account.label}>Rename</button>
        </form>
        <div className="row wrap">
          <button className="btn" onClick={onRestart}><Icon name="refresh" size={16} /> Restart browser</button>
          <button className="btn" onClick={() => window.confirm("Log this account out of Snapchat?") && onLogout()}><Icon name="logout" size={16} /> Log out</button>
          <button className="btn" onClick={onDisconnect}><Icon name="plug" size={16} /> Sign out of Comnexus</button>
        </div>
        <div className="danger-zone">
          <strong>Remove account</strong>
          <p className="muted small">Closes its browser and deletes its saved login, messages and activity from the server.</p>
          <div className="row">
            <input placeholder={`Type "${account.label}" to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <button className="btn danger" disabled={confirm !== account.label} onClick={onRemove}><Icon name="trash" size={16} /> Remove</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
