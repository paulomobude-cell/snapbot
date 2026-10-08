import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Icon } from "../util.jsx";
import { Empty } from "./ChatList.jsx";

export default function Conversation({ chat, status, messages, now, onBack, onSend, onCopy, onOpenScreen, onPreserve, onRevoke, toast }) {
  const [pending, setPending] = useState([]); // optimistic sends
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
        <Empty icon="message" title="Pick a chat" text="This mirrors Snapchat live. Turn on preservation for a chat to keep its messages — including deleted and disappearing ones — instead of losing them." />
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

  const groups = group(messages);
  const offline = status !== "connected";
  const preserved = chat.preservation?.status === "authorized";

  return (
    <main className="conversation">
      <header className="convo-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to chats"><Icon name="back" /></button>
        <Avatar name={chat.name} size={36} />
        <div className="convo-title">
          <strong>{chat.name} {chat.status?.streak && <span className="streak">{chat.status.streak}</span>}</strong>
          <span className="muted small">
            {messages.length} message{messages.length === 1 ? "" : "s"} · {preserved ? "preserved" : "live mirror"}
          </span>
        </div>
      </header>

      <Preservation chat={chat} onPreserve={onPreserve} onRevoke={onRevoke} onCopy={onCopy} toast={toast} />

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
            <div className={`group ${g.isMe ? "me" : "them"}`}>
              {!g.isMe && <div className="group-from">{g.from}</div>}
              {g.messages.map((m) => (
                <Bubble key={m.uid} m={m} onCopy={onCopy} />
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
        {m.kind === "snap" && !media && <span className="snap-tag">👻 Snap{m.state === "live" ? " (not preserved)" : ""}</span>}
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

function Preservation({ chat, onPreserve, onRevoke, onCopy }) {
  const p = chat.preservation || { status: "none" };
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  // reset local code when switching chats
  useEffect(() => setCode(null), [chat.id]);

  if (p.status === "authorized") {
    return (
      <div className="preserve on">
        <Icon name="lock" size={14} />
        <span>Preserving this chat{p.method === "linked" ? " (your linked account)" : ""} — deleted and disappearing messages are kept.</span>
        <button className="link" onClick={() => { if (confirm("Turn off preservation? The kept copies of deleted/expired messages for this chat will be erased.")) onRevoke(); }}>Turn off</button>
      </div>
    );
  }
  const shownCode = code || (p.status === "pending" ? p.code : null);
  if (shownCode) {
    return (
      <div className="preserve pending">
        <Icon name="clock" size={14} />
        <span>Ask the other account to send this code in the chat to confirm it's OK to keep messages:</span>
        <code className="handcode" title="Copy" onClick={() => onCopy(shownCode)}>{shownCode}</code>
        <button className="link" onClick={() => { onRevoke(); setCode(null); }}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="preserve off">
      <Icon name="shield" size={14} />
      <span>Live mirror only — nothing here is kept once Snapchat removes it.</span>
      <button className="btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const pair = await onPreserve();
          if (pair?.status === "pending") setCode(pair.code);
        } catch {
          // toast handled upstream
        } finally {
          setBusy(false);
        }
      }}>Preserve this chat</button>
    </div>
  );
}

function Composer({ onSend }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  useEffect(() => ref.current?.focus(), []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    onSend(t);
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
        placeholder="Send a chat  (Shift+Enter for a new line)"
        aria-label="Message"
      />
      <button className="btn primary send" disabled={!text.trim()} aria-label="Send"><Icon name="send" /></button>
    </form>
  );
}

// consecutive messages from the same sender under the same time label
function group(messages) {
  const out = [];
  let lastTime = null;
  for (const m of messages) {
    const prev = out[out.length - 1];
    const newTime = m.time && m.time !== lastTime;
    if (!prev || prev.from !== m.from || newTime) {
      out.push({ key: m.uid, from: m.from, isMe: m.isMe, time: newTime ? m.time : null, messages: [m] });
    } else {
      prev.messages.push(m);
    }
    if (m.time) lastTime = m.time;
  }
  return out;
}
