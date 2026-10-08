import { useState } from "react";
import Modal from "./Modal.jsx";

export default function BackfillDialog({ chats, progress, online, onStart, onCancel, onClose }) {
  const [selected, setSelected] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = progress?.status === "running";
  const toggle = id => setSelected(ids =>
    ids.includes(id) ? ids.filter(x => x !== id) : ids.length >= 30 ? ids : [...ids, id]
  );
  const start = async () => {
    if (!confirmed || !selected.length || busy || running) return;
    if (!window.confirm("This will OPEN exactly the selected Snapchat conversations. Snapchat may change their read status. Continue?")) return;
    setBusy(true); setError("");
    try { await onStart(selected); }
    catch (e) { setError(e.message || "Could not start archiving"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Archive selected conversations" onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">A fresh session starts with an empty archive. Passive monitoring observes the sidebar, but cannot retrieve chat history that Snapchat hasn't rendered. Archiving selected chats captures content currently rendered in the opened conversation; older scrollback may still require scrolling in Live Screen.</p>
        <p className="backfill-warning"><strong>Read-receipt risk:</strong> This action opens selected conversations in Snapchat Web. It may mark chats read even when mobile currently says Delivered or New Snap. Web statuses can lag mobile, so nothing is selected automatically. The batch never opens an unopened Snap itself.</p>
        {progress && (
          <div className="backfill-progress" role="status" aria-live="polite">
            <strong>{running ? "Archiving…" : progress.status === "completed" ? "Archive batch completed" : "Previous batch " + progress.status}</strong>
            <span>{progress.completed} / {progress.total} visited · {progress.captured} captured · {progress.failed} unavailable</span>
            {running && progress.currentChatId &&
              <span className="muted small">Current: {chats.find(c => c.id === progress.currentChatId)?.name || "Selected chat"}</span>}
            {progress.errors?.length > 0 &&
              <p className="muted small">{progress.errors.length} chat(s) could not be archived. Existing messages were not erased.</p>}
            {running && <button className="btn small" onClick={onCancel}>Stop after current chat</button>}
          </div>
        )}
        <div className="row wrap">
          <strong>Select chats to open</strong>
          <span className="muted small">{selected.length}/30 selected</span>
          <button className="btn small" disabled={running || selected.length === 0} onClick={() => setSelected([])}>Clear selection</button>
        </div>
        <div className="backfill-chat-list" role="group" aria-label="Choose Snapchat conversations">
          {chats.map(chat => (
            <label key={chat.id} className="backfill-chat">
              <input type="checkbox" disabled={running} checked={selected.includes(chat.id)} onChange={() => toggle(chat.id)} />
              <span><strong>{chat.name}</strong>
                <small className="muted">Snapchat Web: {[chat.status?.type, chat.status?.time].filter(Boolean).join(" · ") || "unknown"} · may lag mobile</small>
              </span>
              <span className="muted small">{chat.preview?.count || 0} archived</span>
            </label>
          ))}
        </div>
        <label className="row backfill-confirm">
          <input type="checkbox" checked={confirmed} disabled={running} onChange={e => setConfirmed(e.target.checked)} />
          <span>I understand opening these chats may change their read status in Snapchat. I have deliberately selected them.</span>
        </label>
        {error && <p className="danger" role="alert">{error}</p>}
        <div className="row end wrap">
          <button className="btn" onClick={onClose}>{running ? "Hide progress" : "Close"}</button>
          <button className="btn primary" disabled={!online || !selected.length || !confirmed || busy || running}
            onClick={start}>{busy ? "Starting…" : "Archive " + selected.length + " selected chat" + (selected.length === 1 ? "" : "s")}</button>
        </div>
      </div>
    </Modal>
  );
}
