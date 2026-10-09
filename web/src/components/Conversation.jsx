import { useLayoutEffect, useRef, useState } from "react";
import { Avatar, Icon } from "../util.jsx";
import { Empty } from "./ChatList.jsx";
import { stableMessageRows } from "../message-groups.js";
import { chooseScrollTop } from "../scroll-behavior.js";

export default function Conversation({ chat, status, messages, now, onBack, onSend, onCopy, onOpenScreen, onInteractiveSync, onBackfill, clickMode, toast }) {
  const [pending, setPending] = useState([]);
  const [syncing, setSyncing] = useState(false); // optimistic sends
  const listRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const beforeRenderRef = useRef(null);
  const previousIdsRef = useRef([]);
  const forceLatestRef = useRef(false);
  const previousLengthRef = useRef(0);

  // Take a picture of what the user was actually looking at before React
  // commits a changing chat history. Server backfill can insert items ABOVE
  // that point, while media may be finishing at the same time.
  const captureViewport = (el) => {
    const top = el.getBoundingClientRect().top;
    let anchor = null;
    for (const candidate of el.querySelectorAll("[data-message-uid]")) {
      if (candidate.getBoundingClientRect().bottom > top + 2) {
        anchor = candidate;
        break;
      }
    }
    return {
      anchorUid: anchor?.dataset.messageUid || null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : null,
      scrollTop: el.scrollTop,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 48,
    };
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ids = messages.map(m => m.uid || m.id);
    const previous = beforeRenderRef.current;
    const anchor = previous?.anchorUid
      ? [...el.querySelectorAll("[data-message-uid]")].find(
          node => node.dataset.messageUid === previous.anchorUid
        )
      : null;
    const offset = anchor ? anchor.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
    const desired = chooseScrollTop({
      previous, currentAnchorOffset: offset, newScrollHeight: el.scrollHeight,
      afterIds: ids, beforeIds: previousIdsRef.current,
      forceLatest: forceLatestRef.current,
    });
    if (Math.abs(desired - el.scrollTop) > 1) el.scrollTop = desired;
    const newMessageCount = Math.max(0, messages.length - previousLengthRef.current);
    if (previous && !previous.atBottom && newMessageCount && !forceLatestRef.current)
      setMissed(n => n + newMessageCount);
    previousIdsRef.current = ids;
    previousLengthRef.current = messages.length;
    forceLatestRef.current = false;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom(nearBottom);
    if (nearBottom) setMissed(0);
    // React's layout-effect cleanup runs before the DOM is replaced, allowing
    // us to anchor the same visible bubble when old history is inserted.
    return () => { beforeRenderRef.current = captureViewport(el); };
  }, [messages, pending.length]);

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
    forceLatestRef.current = true; // the user deliberately sent a message
    setAtBottom(true);
    try {
      await onSend(text);
      setPending((p) => p.filter((x) => x.tempId !== tempId));
    } catch (e) {
      setPending((p) => p.map((x) => (x.tempId === tempId ? { ...x, state: "failed", error: e.message } : x)));
    }
  };

  const actualMessages = messages.filter(message => message.kind !== "status" && message.kind !== "notice");
  const rows = stableMessageRows(messages);
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
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          beforeRenderRef.current = captureViewport(el);
          setAtBottom(bottom);
          if (bottom) setMissed(0);
        }}
      >
        {messages.length === 0 && pending.length === 0 && (
          <Empty icon="message" title="No archived messages yet"
            text="Passive mode only saves conversations already visible in Snapchat Web. A fresh account has no history until you open a chat in Live Screen or explicitly archive selected chats."
          ><button className="btn small" onClick={onBackfill}>Choose chats to archive</button></Empty>
        )}
        {rows.map(({ key, message: m, isStatus, isMe, from, startsGroup }) => (
          // Key every physical message by its immutable UID. Inserting older
          // messages must never unmount the playing videos lower in the chat.
          <div key={key} data-message-uid={key}
            className={`group message-entry ${startsGroup ? "first-in-run" : ""} ${isStatus ? "statuses" : isMe ? "me" : "them"}`}>
            {startsGroup && !isMe && !isStatus && <div className="group-from">{from}</div>}
            {isStatus ? <div className="chat-status-event">{m.text}</div>
              : <Bubble m={m} onCopy={onCopy} />}
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
          <Icon name="down" size={16} /> {missed > 0 ? `${missed} added` : "Latest"}
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
        {m.replyTo && (
          <div className="reply-preview" aria-label="Quoted message">
            <span className="reply-preview-from">{m.replyTo.from || "Original message"}</span>
            {m.replyTo.text && <span className="reply-preview-text">{m.replyTo.text}</span>}
            {m.replyTo.mediaType && <span className="reply-preview-media">Quoted {m.replyTo.mediaType}</span>}
          </div>
        )}
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
    ? <video src={media.url} controls preload="metadata" playsInline className="media" />
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
