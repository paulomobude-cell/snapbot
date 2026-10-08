import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Icon } from "../util.jsx";
import { Empty } from "./ChatList.jsx";
import { group } from "../message-groups.js";

export default function Conversation({ chat, status, messages, now, onBack, onSend, onCopy, onOpenScreen, onInteractiveSync, toast }) {
  const [pending, setPending] = useState([]);
  const [syncing, setSyncing] = useState(false); // optimistic sends
  const listRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const lastCount = useRef(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const total = messages.length + pending.length;
    const grew = total > lastCount.current;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (grew) setMissed((n) => n + (total - lastCount.current));
    lastCount.current = total;
  }, [messages.length, pending.length]);

  if (!chat) {
    return (
      <main className="conversation empty-state">
        <Empty icon="message" title="Pick a chat" text="Messages visible to this account are archived locally, including copies already captured before deletion." />
      </main>
    );
  }

  const send = async (text) => {
    const tempId = `tmp-${Date.now()}-${Math.random()}`;
    setPending((p) => [...p, { tempId, text, state: "sending" }]);
    setAtBottom(true);
    try {
      await onSend(text);
      setPending((p) => p.filter((x) => x.tempId !== tempId));
    } catch (e) {
      setPending((p) => p.map((x) => (x.tempId === tempId ? { ...x, state: "failed", error: e.message } : x)));
    }
  };

  const actualMessages = messages.filter(message => message.kind !== "status" && message.kind !== "notice");
  const groups = group(messages);
  const offline = status !== "connected";
  const preserved = true;

  return (
    <main className="conversation">
      <header className="convo-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to chats"><Icon name="back" /></button>
        <Avatar name={chat.name} size={36} />
        <div className="convo-title">
          <strong>{chat.name} {chat.status?.streak && <span className="streak">{chat.status.streak}</span>}</strong>
          <span className="muted small">
            {actualMessages.length} message{actualMessages.length === 1 ? "" : "s"} · archived
          </span>
        </div>
      </header>


      <div className="passive-controls">
        <span className="muted small">Passive mode · selecting a chat doesn't open it in Snapchat.</span>
        <button className="btn small" disabled={syncing || offline} onClick={async () => {
          if (!window.confirm("Open this conversation in Snapchat to sync? Snapchat may mark messages as read. Continue?")) return;
          setSyncing(true);
          try {
            const result = await onInteractiveSync();
            if (!result?.captured) toast(result?.reason || "Conversation was not available", "error");
          } catch (error) { toast(error.message, "error"); }
          finally { setSyncing(false); }
        }}>{syncing ? "Syncing…" : "Open & sync (may mark read)"}</button>
      </div>
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          setAtBottom(bottom);
          if (bottom) setMissed(0);
        }}
      >
        {messages.length === 0 && pending.length === 0 && (
          <Empty icon="message" title="No messages" text={preserved ? "Nothing here yet. New messages — and anything the other side deletes — will be kept." : "Nothing here right now."} />
        )}
        {groups.map((g) => (
          <div key={g.key}>
            {g.time && <div className="day-sep"><span>{g.time}</span></div>}
            <div className={`group ${g.isStatus ? "statuses" : g.isMe ? "me" : "them"}`}>
              {!g.isMe && g.messages.some(m => m.kind !== "status") && <div className="group-from">{g.from}</div>}
              {g.messages.map((m) => (
                m.kind === "status" || m.kind === "notice"
                  ? <div className="chat-status-event" key={m.uid}>{m.text}</div>
                  : <Bubble key={m.uid} m={m} onCopy={onCopy} />
              ))}
            </div>
          </div>
        ))}
        {pending.length > 0 && (
          <div className="group me">
            {pending.map((p) => (
              <div key={p.tempId} className={`bubble-row pending ${p.state}`}>
                <div className="bubble">{p.text}</div>
                <div className="bubble-meta">
                  {p.state === "sending" ? "Sending…" : (
                    <>
                      <span className="danger">Failed: {p.error}</span>
                      <button className="link" onClick={() => { setPending((l) => l.filter((x) => x.tempId !== p.tempId)); send(p.text); }}>Retry</button>
                      <button className="link" onClick={() => setPending((l) => l.filter((x) => x.tempId !== p.tempId))}>Discard</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!atBottom && (
        <button className="jump" onClick={() => { listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); setMissed(0); }}>
          <Icon name="down" size={16} /> {missed > 0 ? `${missed} new` : "Latest"}
        </button>
      )}

      {offline ? (
        <div className="composer offline">
          <span className="muted">Session is {status?.replace("_", " ") || "offline"}. Sending is paused.</span>
          <button className="btn small" onClick={onOpenScreen}>Open live screen</button>
        </div>
      ) : (
        <Composer onSend={send} />
      )}
    </main>
  );
}

function Bubble({ m, onCopy }) {
  const deleted = m.state === "deleted";
  const gone = m.state === "gone";
  const media = m.media?.[0];
  return (
    <div className={`bubble-row ${deleted ? "deleted" : ""} ${gone ? "gone" : ""}`}>
      <div className="bubble" title={`Seen ${new Date(m.firstSeenAt).toLocaleString()}`}>
        {media && <MediaView media={media} />}
        {m.kind === "snap" && !media && <span className="snap-tag">👻 Snap</span>}
        {m.text && <span className="bubble-text">{deleted ? m.display : m.text}</span>}
        {deleted && <span className="gone-tag del">Deleted</span>}
        {gone && <span className="gone-tag">No longer on Snapchat</span>}
      </div>
      <div className="bubble-meta">
        <span>{deleted ? "Deleted on Snapchat · kept here" : gone ? "Removed on Snapchat · kept here" : m.time}</span>
        {m.text && <button className="icon-btn tiny hover-only" title="Copy" onClick={() => onCopy(m.text)}><Icon name="copy" size={13} /></button>}
      </div>
    </div>
  );
}

function MediaView({ media }) {
  const [open, setOpen] = useState(false);
  if (media.status === "pending") return <span className="media-chip">Saving {media.viewOnce ? "snap" : "media"}…</span>;
  if (media.status === "failed" || !media.url) return <span className="media-chip failed">Couldn't save {media.viewOnce ? "snap" : "media"}</span>;
  const el = media.kind === "video"
    ? <video src={media.url} controls className="media" />
    : <img src={media.url} className="media" alt="" loading="lazy" onClick={() => setOpen(true)} />;
  return (
    <div className={`media-wrap ${media.viewOnce ? "once" : ""}`}>
      {media.viewOnce && <span className="once-badge">👻 view-once</span>}
      {el}
      {open && media.kind !== "video" && (
        <div className="lightbox" onClick={() => setOpen(false)}><img src={media.url} alt="" /></div>
      )}
    </div>
  );
}


function Composer({ onSend }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async event => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSend(value);
      setText("");
    } finally { setBusy(false); }
  };
  return (
    <form className="composer" onSubmit={send}>
      <textarea aria-label="Message" placeholder="Type a message…"
        rows={1} value={text} onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <button className="btn primary send" type="submit" disabled={!text.trim() || busy}
        aria-label="Send message"><Icon name="send" /></button>
    </form>
  );
}
