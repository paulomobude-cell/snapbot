import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Icon, STATUS_LABEL } from "../util.jsx";

export default function ChatList({ account, status, error, chats, messages, unread, activeId, now, onSelect, toolbar }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const searchRef = useRef(null);

  // Ctrl/Cmd+K or "/" focuses search
  useEffect(() => {
    const onKey = (e) => {
      const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats
      .map((chat) => {
        // prefer what this browser holds, else the server's preview
        const local = messages[chat.id];
        const last = local?.length ? local[local.length - 1] : chat.preview?.last;
        const count = local?.length ?? chat.preview?.count ?? 0;
        return { chat, last, count, unread: unread[chat.id]?.length || 0 };
      })
      .filter((r) => !q || r.chat.name.toLowerCase().includes(q) || (r.last?.text || "").toLowerCase().includes(q))
      .filter((r) => filter === "all" || (filter === "unread" ? r.unread > 0 : r.count > 0));
  }, [chats, messages, unread, query, filter]);

  const unreadChats = chats.filter((c) => unread[c.id]?.length).length;

  return (
    <section className="chatlist">
      <header className="chatlist-head">
        <div className="account-title">
          <strong>{account?.label || "No account"}</strong>
          {account && <span className={`pill ${status}`}>{STATUS_LABEL[status] || status}</span>}
        </div>
        <div className="toolbar">{toolbar}</div>
      </header>
      {error && <div className="alert slim">{error}</div>}
      <div className="search">
        <Icon name="search" size={16} />
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats  (Ctrl K)" />
        {query && <button className="icon-btn small" onClick={() => setQuery("")} aria-label="Clear"><Icon name="close" size={14} /></button>}
      </div>
      <div className="tabs" role="tablist">
        {[["all", "All"], ["unread", `Unread${unreadChats ? ` · ${unreadChats}` : ""}`], ["active", "With messages"]].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      <div className="chatlist-items">
        {!account && <Empty icon="plug" title="No account yet" text="Tap + to add Snapchat, or use Admin Core (shield icon) to claim an existing account." />}
        {account && status !== "connected" && chats.length === 0 && (
          <Empty icon="lock" title={STATUS_LABEL[status] || "Not connected"} text="Chats show up once the session is logged in. Use the live screen to log in." />
        )}
        {account && status === "connected" && rows.length === 0 && (
          <Empty icon="message" title={query ? "No matches" : "Nothing here"} text={query ? "Try another name." : "No chats match this filter."} />
        )}
        {rows.map(({ chat, last, count, unread: n }) => {
          const preview = last ? (last.display || last.text) : null;
          return (
            <button key={chat.id} className={`chatrow ${chat.id === activeId ? "active" : ""} ${n ? "unread" : ""}`} onClick={() => onSelect(chat.id)}>
              <Avatar name={chat.name} size={42} />
              <span className="chatrow-body">
                <span className="chatrow-top">
                  <span className="chatrow-name">{chat.name}</span>
                  {chat.status?.streak && <span className="streak">{chat.status.streak}</span>}
                </span>
                <span className="chatrow-preview">
                  {preview ? <>{last.isMe ? "You: " : ""}{last.kind === "media" ? "📷 Photo/Video" : last.kind === "snap" ? "👻 Snap" : preview}</>
                    : <span className="muted">{[chat.status?.type, chat.status?.time].filter(Boolean).join(" · ") || "No messages"}</span>}
                </span>
              </span>
              <span className="chatrow-side">
                {n > 0 ? <span className="badge">{n}</span> : count > 0 && <span className="count">{count}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function Empty({ icon, title, text, children }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p className="muted">{text}</p>
      {children}
    </div>
  );
}
