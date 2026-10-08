import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Icon, timeLeft } from "../util.jsx";
import { Empty } from "./ChatList.jsx";

export default function Conversation({ chat, status, messages, ttlMs, now, onBack, onSend, onCopy, onOpenScreen }) {
  const [pending, setPending] = useState([]); // optimistic sends
  const listRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const lastCount = useRef(0);

  const visible = messages.filter((m) => !m.leavingAt).length;

  // stick to the bottom unless the user scrolled up; count what they missed
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const grew = visible + pending.length > lastCount.current;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (grew) setMissed((n) => n + (visible + pending.length - lastCount.current));
    lastCount.current = visible + pending.length;
  }, [visible, pending.length]);

  if (!chat) {
    return (
      <main className="conversation empty-state">
        <Empty icon="message" title="Pick a chat" text="Messages here mirror Snapchat: deleted chats vanish and everything disappears after 24h." />
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
  const live = messages.filter((m) => !m.leavingAt);
  const offline = status !== "connected";

  return (
    <main className="conversation">
      <header className="convo-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to chats"><Icon name="back" /></button>
        <Avatar name={chat.name} size={36} />
        <div className="convo-title">
          <strong>{chat.name} {chat.status?.streak && <span className="streak">{chat.status.streak}</span>}</strong>
          <span className="muted small">
            {live.length} message{live.length === 1 ? "" : "s"} · disappear {ttlMs >= 3600000 ? `${Math.round(ttlMs / 3600000)}h` : `${Math.round(ttlMs / 60000)}m`} after arriving
          </span>
        </div>
      </header>

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
          <Empty icon="clock" title="No messages" text="Nothing here right now. Deleted and expired messages are removed automatically." />
        )}
        {groups.map((g) => (
          <div key={g.key}>
            {g.time && <div className="day-sep"><span>{g.time}</span></div>}
            <div className={`group ${g.isMe ? "me" : "them"}`}>
              {!g.isMe && <div className="group-from">{g.from}</div>}
              {g.messages.map((m) => (
                <Bubble key={m.id} m={m} now={now} ttlMs={ttlMs} onCopy={onCopy} />
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
                      <button className="link" onClick={() => {
                        setPending((list) => list.filter((x) => x.tempId !== p.tempId));
                        send(p.text);
                      }}>Retry</button>
                      <button className="link" onClick={() => setPending((list) => list.filter((x) => x.tempId !== p.tempId))}>Discard</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!atBottom && (
        <button className="jump" onClick={() => {
          listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
          setMissed(0);
        }}>
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

function Bubble({ m, now, ttlMs, onCopy }) {
  const left = m.expiresAt - now;
  const fraction = Math.max(0, Math.min(1, left / ttlMs));
  const leaving = m.leavingAt ? `leaving ${m.leaveReason}` : "";
  return (
    <div className={`bubble-row ${leaving} ${left < 3600 * 1000 ? "soon" : ""}`}>
      <div className="bubble" title={`Seen ${new Date(m.firstSeenAt).toLocaleString()}`}>
        {m.text}
        {m.leavingAt && <span className="gone-tag">{m.leaveReason === "deleted" ? "Deleted" : "Expired"}</span>}
      </div>
      <div className="bubble-meta">
        <span className="ttl" style={{ "--f": fraction }} aria-hidden="true" />
        <span>{m.leavingAt ? (m.leaveReason === "deleted" ? "Deleted on Snapchat" : "Disappeared") : `Disappears in ${timeLeft(left)}`}</span>
        {!m.leavingAt && (
          <button className="icon-btn tiny hover-only" title="Copy" onClick={() => onCopy(m.text)}><Icon name="copy" size={13} /></button>
        )}
      </div>
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
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
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
      out.push({ key: m.id, from: m.from, isMe: m.isMe, time: newTime ? m.time : null, messages: [m] });
    } else {
      prev.messages.push(m);
    }
    if (m.time) lastTime = m.time;
  }
  return out;
}
