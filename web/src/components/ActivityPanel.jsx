import { useState } from "react";
import { Icon, ago } from "../util.jsx";

const KIND = {
  new: { icon: "message", label: "New" },
  deleted: { icon: "trash", label: "Deleted" },
  status: { icon: "plug", label: "Session" },
};

export default function ActivityPanel({ events, chats, now, onOpenChat, onClose }) {
  const [filter, setFilter] = useState("all");
  const shown = events.filter((e) => filter === "all" || e.type === filter);
  return (
    <div className="panel-inner">
      <header className="panel-head">
        <strong>Activity</strong>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      <div className="tabs">
        {[["all", "All"], ["new", "New"], ["deleted", "Deleted"], ["status", "Session"]].map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <ul className="activity">
        {shown.length === 0 && <li className="muted pad">Nothing yet.</li>}
        {shown.map((e) => {
          const kind = KIND[e.type] || KIND.status;
          const chat = chats.find((c) => c.id === e.chatId);
          return (
            <li key={e.seq} className={`act ${e.type}`}>
              <span className="act-icon"><Icon name={kind.icon} size={14} /></span>
              <span className="act-body">
                {chat ? <button className="link" onClick={() => onOpenChat(chat.id)}>{e.detail}</button> : <span>{e.detail}</span>}
                <span className="muted small">{ago(e.at, now)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small pad-x">Deleted messages are logged without their text.</p>
    </div>
  );
}
