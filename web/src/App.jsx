import { useEffect, useReducer, useRef, useState } from "react";
import { io } from "socket.io-client";

const DEFAULT_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("snapbot") || "null");
  } catch {
    return null;
  }
}

// messages: { [chatId]: Message[] } — only what still exists on the backend
function messagesReducer(state, action) {
  switch (action.type) {
    case "reset":
      return {};
    case "snapshot":
      // authoritative list for the chat: anything not in it is gone
      return { ...state, [action.chatId]: action.messages };
    case "new": {
      const list = state[action.message.chatId] || [];
      if (list.some((m) => m.id === action.message.id)) return state;
      return { ...state, [action.message.chatId]: [...list, action.message] };
    }
    case "remove": {
      const list = state[action.chatId];
      if (!list) return state;
      return { ...state, [action.chatId]: list.filter((m) => m.id !== action.id) };
    }
    case "expire": {
      let changed = false;
      const next = {};
      for (const [chatId, list] of Object.entries(state)) {
        const kept = list.filter((m) => m.expiresAt > action.now);
        if (kept.length !== list.length) changed = true;
        next[chatId] = kept;
      }
      return changed ? next : state;
    }
    default:
      return state;
  }
}

function timeLeft(ms) {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  if (!settings) return <Setup onSave={(s) => {
    localStorage.setItem("snapbot", JSON.stringify(s));
    setSettings(s);
  }} />;
  return <Dashboard settings={settings} onSignOut={() => {
    localStorage.removeItem("snapbot");
    setSettings(null);
  }} />;
}

function Setup({ onSave }) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState("");
  return (
    <div className="setup">
      <form onSubmit={(e) => {
        e.preventDefault();
        onSave({ url: url.replace(/\/+$/, ""), token });
      }}>
        <h1>SnapBot</h1>
        <label>Backend URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label>API token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
        </label>
        <button type="submit">Connect</button>
      </form>
    </div>
  );
}

function Dashboard({ settings, onSignOut }) {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState("");
  const [status, setStatus] = useState({ status: "stopped" });
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, dispatch] = useReducer(messagesReducer, {});
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [showScreen, setShowScreen] = useState(false);
  const activeRef = useRef(null);
  activeRef.current = activeChat;

  useEffect(() => {
    const s = io(settings.url, { auth: { token: settings.token } });
    s.on("connect", () => {
      setConnected(true);
      setConnError("");
      // drop everything cached: the server re-sends what still exists
      dispatch({ type: "reset" });
      if (activeRef.current) s.emit("chat:select", { chatId: activeRef.current });
    });
    s.on("disconnect", () => setConnected(false));
    s.on("connect_error", (err) => setConnError(err.message));
    s.on("config", (c) => setClockOffset(c.now - Date.now()));
    s.on("status", setStatus);
    s.on("chats", setChats);
    s.on("chat:snapshot", ({ chatId, messages }) => dispatch({ type: "snapshot", chatId, messages }));
    s.on("message:new", (message) => dispatch({ type: "new", message }));
    s.on("message:deleted", ({ id, chatId }) => dispatch({ type: "remove", id, chatId }));
    s.on("message:expired", ({ id, chatId }) => dispatch({ type: "remove", id, chatId }));
    setSocket(s);
    return () => s.disconnect();
  }, [settings]);

  // hide expired messages locally too, even if the socket is down
  useEffect(() => {
    const t = setInterval(() => {
      const serverNow = Date.now() + clockOffset;
      setNow(serverNow);
      dispatch({ type: "expire", now: serverNow });
    }, 1000);
    return () => clearInterval(t);
  }, [clockOffset]);

  useEffect(() => {
    if (status.status === "needs_login") setShowScreen(true);
  }, [status.status]);

  const selectChat = (chatId) => {
    setActiveChat(chatId);
    socket?.emit("chat:select", { chatId });
  };

  const chat = chats.find((c) => c.id === activeChat);
  const list = messages[activeChat] || [];

  return (
    <div className="app">
      <header className="topbar">
        <strong>SnapBot</strong>
        <span className={`pill ${connected ? status.status : "offline"}`}>
          {connected ? status.status.replace("_", " ") : connError || "offline"}
        </span>
        {status.error && <span className="error">{status.error}</span>}
        <div className="spacer" />
        <button onClick={() => setShowScreen((v) => !v)}>{showScreen ? "Hide screen" : "Live screen"}</button>
        <button onClick={() => socket?.emit("session:restart")}>Restart</button>
        <button onClick={() => confirm("Log out of Snapchat?") && socket?.emit("session:logout")}>Log out</button>
        <button onClick={onSignOut}>Disconnect</button>
      </header>

      {showScreen && socket && <LiveScreen socket={socket} status={status.status} />}

      <div className="main">
        <aside className="chats">
          {chats.length === 0 && <p className="muted pad">No chats yet</p>}
          {chats.map((c) => (
            <button key={c.id} className={`chat ${c.id === activeChat ? "active" : ""}`} onClick={() => selectChat(c.id)}>
              <span className="name">{c.name}</span>
              <span className="muted small">
                {[c.status?.type, c.status?.time, c.status?.streak].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </aside>

        <section className="conversation">
          {!chat ? (
            <p className="muted pad">Select a chat</p>
          ) : (
            <>
              <div className="convo-header">{chat.name}</div>
              <MessageList messages={list} now={now} />
              <Composer onSend={(text) => new Promise((resolve) =>
                socket.emit("message:send", { chatId: chat.id, text }, resolve)
              )} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function MessageList({ messages, now }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messages.length]);
  if (messages.length === 0) {
    return <div className="messages"><p className="muted pad">No messages (deleted and expired ones are removed)</p></div>;
  }
  return (
    <div className="messages" ref={ref}>
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.isMe ? "me" : "them"}`}>
          {!m.isMe && <div className="from">{m.from}</div>}
          <div className="bubble">{m.text}</div>
          <div className="meta">{m.time} · disappears in {timeLeft(m.expiresAt - now)}</div>
        </div>
      ))}
    </div>
  );
}

function Composer({ onSend }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="composer" onSubmit={async (e) => {
      e.preventDefault();
      if (!text.trim()) return;
      setSending(true);
      const res = await onSend(text);
      setSending(false);
      if (res?.ok) {
        setText("");
        setError("");
      } else setError(res?.error || "Failed to send");
    }}>
      {error && <span className="error">{error}</span>}
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Send a chat" disabled={sending} />
      <button type="submit" disabled={sending}>Send</button>
    </form>
  );
}

// Mirrors the backend's Chrome so you can log in / solve captcha / 2FA
function LiveScreen({ socket, status }) {
  const [frame, setFrame] = useState(null);
  const [typed, setTyped] = useState("");
  const [creds, setCreds] = useState({ username: "", password: "" });

  useEffect(() => {
    const onFrame = (data) => setFrame(data);
    socket.on("screen:frame", onFrame);
    const start = () => socket.emit("screen:start");
    start();
    socket.on("connect", start);
    return () => {
      socket.off("screen:frame", onFrame);
      socket.off("connect", start);
      socket.emit("screen:stop");
    };
  }, [socket]);

  return (
    <div className="screen">
      <div className="screen-view">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt="Snapchat session"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              socket.emit("screen:click", { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            }}
            onWheel={(e) => socket.emit("screen:scroll", { deltaY: e.deltaY })}
          />
        ) : (
          <p className="muted pad">Waiting for the browser…</p>
        )}
      </div>
      <div className="screen-controls">
        {status === "needs_login" && (
          <form onSubmit={(e) => {
            e.preventDefault();
            socket.emit("session:login", creds);
          }}>
            <strong>Log in to Snapchat</strong>
            <input placeholder="Username or email" value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} />
            <input type="password" placeholder="Password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} />
            <button type="submit">Log in</button>
            <p className="muted small">Or click and type directly on the screen (captcha, 2FA codes).</p>
          </form>
        )}
        <form onSubmit={(e) => {
          e.preventDefault();
          socket.emit("screen:type", { text: typed });
          setTyped("");
        }}>
          <input placeholder="Type into the page" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit">Type</button>
        </form>
        <div className="keys">
          {["Enter", "Tab", "Backspace", "Escape"].map((key) => (
            <button key={key} type="button" onClick={() => socket.emit("screen:key", { key })}>{key}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
