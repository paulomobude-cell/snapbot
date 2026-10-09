import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Icon } from "../util.jsx";
import { Empty } from "./ChatList.jsx";
import { group } from "../message-groups.js";

export default function Conversation({ chat, status, messages, now, onBack, onSend, onCopy, onOpenScreen, onInteractiveSync, onBackfill, clickMode, toast }) {
  const [pending, setPending] = useState([]);
  const [syncing, setSyncing] = useState(false); // optimistic sends
  const listRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const lastCount = useRef(0);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;

  // Images/videos change height once they load. Stay pinned to the latest
  // message only if the user was already there. Otherwise keep what they are
  // reading in place; Safari has no native scroll anchoring, so media growing
  // above the viewport would push the text down.
  const mediaObserver = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const nativeAnchoring = window.CSS?.supports?.("overflow-anchor", "auto");
    const heights = new WeakMap();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.target.offsetHeight;
        const previous = heights.get(entry.target);
        heights.set(entry.target, height);
        if (previous === undefined || previous === height) continue;
        if (atBottomRef.current) el.scrollTop = el.scrollHeight;
        else if (!nativeAnchoring && entry.target.getBoundingClientRect().bottom <= el.getBoundingClientRect().top)
          el.scrollTop += height - previous;
      }
    });
    mediaObserver.current = observer;
    return () => { observer.disconnect(); mediaObserver.current = null; };
  }, [Boolean(chat)]);
  const observeMedia = useRef((node) => { if (node) mediaObserver.current?.observe(node); }).current;

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
  // Render one flat, uid-keyed list. Nesting bubbles inside per-group
  // wrappers keyed by their first message remounted every bubble (reloading
  // videos) whenever a message landed at the start or middle of a group.
  const rows = group(messages, chat.name).flatMap((g) => g.messages.map((m, i) => ({
    g, m, first: i === 0, last: i === g.messages.length - 1,
  })));
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
        <span className="muted small">{clickMode === "open"
          ? "Click-to-sync on · selecting a chat opens Snapchat and may mark it read."
          : clickMode === "ask"
            ? "Chat click mode unset · first chat click will ask whether to open Snapchat."
            : "Passive mode · selecting a chat doesn't open it in Snapchat."}</span>
        <button className="btn small" disabled={syncing || offline} onClick={async () => {
          if (!window.confirm("Open this conversation in Snapchat to sync? Snapchat may mark messages as read. Continue?")) return;
          setSyncing(true);
          try {
            const result = await onInteractiveSync();
            if (!result?.captured) toast(result?.reason || "Conversation was not available", "error");
            else if (result.history?.truncated) toast("Saved what Snapchat rendered; older history could still be incomplete.", "error");
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
          <Empty icon="message" title="No archived messages yet"
            text="Passive mode only saves conversations already visible in Snapchat Web. A fresh account has no history until you open a chat in Live Screen or explicitly archive selected chats."
          ><button className="btn small" onClick={onBackfill}>Choose chats to archive</button></Empty>
        )}
        {rows.map(({ g, m, first, last }) => (
          <div key={m.uid} className={`group ${g.isStatus ? "statuses" : g.isMe ? "me" : "them"}${first ? "" : " cont"}${last ? "" : " more"}`}>
            {first && !g.isMe && g.messages.some(x => x.kind !== "status") && <div className="group-from">{g.from}</div>}
            {m.kind === "status" || m.kind === "notice"
              ? <div className="chat-status-event">{m.text}</div>
              : <Bubble m={m} onCopy={onCopy} mediaRef={observeMedia} />}
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

function Bubble({ m, onCopy, mediaRef }) {
  const deleted = m.state === "deleted";
  const gone = m.state === "gone";
  const media = m.media?.[0];
  return (
    <div className={`bubble-row ${deleted ? "deleted" : ""} ${gone ? "gone" : ""}`}>
      <div className="bubble" title={`Seen ${new Date(m.firstSeenAt).toLocaleString()}`}>
        {m.replyTo && (
          <div className="reply-preview" aria-label="Quoted message">
            <span className="reply-preview-from">{m.replyTo.from || "Original message"}</span>
            {m.replyTo.text && <span className="reply-preview-text">{m.replyTo.text}</span>}
            {m.replyTo.mediaType && <span className="reply-preview-media">Quoted {m.replyTo.mediaType}</span>}
          </div>
        )}
        {media && <MediaView media={media} mediaRef={mediaRef} />}
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

function MediaView({ media, mediaRef }) {
  const [open, setOpen] = useState(false);
  // Keep the first working link: chat snapshots can carry a freshly signed URL
  // for the same file, and swapping src would reload the video and shift the
  // chat. Only switch when the current link fails (e.g. it expired).
  const [src, setSrc] = useState(media.url);
  const latest = useRef(media.url);
  latest.current = media.url;
  useEffect(() => { if (!src && media.url) setSrc(media.url); }, [src, media.url]);
  const retry = () => { if (latest.current && latest.current !== src) setSrc(latest.current); };
  if (media.status === "pending") return <span className="media-chip">Saving {media.viewOnce ? "snap" : "media"}…</span>;
  if (media.status === "failed" || !media.url) return <span className="media-chip failed">Couldn't save {media.viewOnce ? "snap" : "media"}</span>;
  const el = media.kind === "video"
    ? <video ref={mediaRef} src={src} controls preload="metadata" playsInline className="media" onError={retry} />
    : <img ref={mediaRef} src={src} className="media" alt="" loading="lazy" onClick={() => setOpen(true)} onError={retry} />;
  return (
    <div className={`media-wrap ${media.viewOnce ? "once" : ""}`}>
      {media.viewOnce && <span className="once-badge">👻 view-once</span>}
      {el}
      {open && media.kind !== "video" && (
        <div className="lightbox" onClick={() => setOpen(false)}><img src={src} alt="" /></div>
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
