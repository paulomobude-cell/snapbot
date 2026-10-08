import { useEffect, useReducer, useRef, useState } from "react";
import { io } from "socket.io-client";

// Messages are keyed by stable `uid`; deletion state does not erase archived content.
const initial = {
  accounts: [],
  status: {}, // accountId -> { status, error }
  chats: {}, // accountId -> Chat[] (each carries .preservation)
  messages: {}, // accountId -> { chatId -> Message[] }
  activity: {}, // accountId -> Event[] newest first
  unread: loadUnread(), // accountId -> { chatId -> uid[] }
  config: { maxAccounts: 3 },
};

function loadUnread() {
  // Privacy: do not restore unread markers from another Comnexus user.
  try {
    const tenant = JSON.parse(localStorage.getItem("snapbot:session") || "null")?.user?.id;
    if (!tenant) return {};
    return JSON.parse(localStorage.getItem("snapbot:unread:" + tenant) || "{}");
  } catch { return {}; }
}

const setIn = (obj, acc, value) => ({ ...obj, [acc]: value });
const byOrd = (a, b) => a.ord - b.ord;

function dropUnread(unread, acc, chatId, uids) {
  const list = unread[acc]?.[chatId];
  if (!list) return unread;
  const kept = list.filter((u) => !uids.has(u));
  if (kept.length === list.length) return unread;
  return setIn(unread, acc, { ...unread[acc], [chatId]: kept });
}

function reducer(state, a) {
  const acc = a.accountId;
  switch (a.type) {
    case "reset":
      // reconnect: forget cached messages, the server re-sends current state
      return { ...state, messages: {}, chats: {} };
    case "config":
      return { ...state, config: { ...state.config, ...a.config } };
    case "accounts": {
      const ids = new Set(a.accounts.map((x) => x.id));
      const keep = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => ids.has(k)));
      const status = { ...state.status };
      for (const x of a.accounts) status[x.id] = { status: x.status, error: x.error };
      return {
        ...state,
        accounts: a.accounts,
        status: keep(status),
        chats: keep(state.chats),
        messages: keep(state.messages),
        activity: keep(state.activity),
        unread: keep(state.unread),
      };
    }
    case "status":
      return { ...state, status: setIn(state.status, acc, { status: a.status, error: a.error }) };
    case "chats":
      return { ...state, chats: setIn(state.chats, acc, a.chats) };
    case "snapshot": {
      const byChat = state.messages[acc] || {};
      return { ...state, messages: setIn(state.messages, acc, { ...byChat, [a.chatId]: [...a.messages].sort(byOrd) }) };
    }
    case "new": {
      const byChat = state.messages[acc] || {};
      const list = byChat[a.message.chatId] || [];
      if (list.some((m) => m.uid === a.message.uid)) return state;
      let unread = state.unread;
      if (a.markUnread) {
        const u = unread[acc] || {};
        unread = setIn(unread, acc, { ...u, [a.message.chatId]: [...(u[a.message.chatId] || []), a.message.uid] });
      }
      return {
        ...state,
        messages: setIn(state.messages, acc, { ...byChat, [a.message.chatId]: [...list, a.message].sort(byOrd) }),
        unread,
      };
    }
    case "updated": {
      // same uid, new state/display/media (archived, or media finished uploading)
      const byChat = state.messages[acc] || {};
      const list = byChat[a.message.chatId];
      if (!list) return state;
      const next = list.map((m) => (m.uid === a.message.uid ? a.message : m));
      return { ...state, messages: setIn(state.messages, acc, { ...byChat, [a.message.chatId]: next }) };
    }
    case "removed": {
      const byChat = state.messages[acc] || {};
      const list = byChat[a.chatId];
      const unread = dropUnread(state.unread, acc, a.chatId, new Set([a.uid]));
      if (!list) return { ...state, unread };
      return {
        ...state,
        messages: setIn(state.messages, acc, { ...byChat, [a.chatId]: list.filter((m) => m.uid !== a.uid) }),
        unread,
      };
    }
    case "read": {
      if (!state.unread[acc]?.[a.chatId]?.length) return state;
      return { ...state, unread: setIn(state.unread, acc, { ...state.unread[acc], [a.chatId]: [] }) };
    }
    case "activity:list":
      return { ...state, activity: setIn(state.activity, acc, a.events) };
    case "activity": {
      const list = state.activity[acc] || [];
      return { ...state, activity: setIn(state.activity, acc, [a.event, ...list].slice(0, 200)) };
    }
    default:
      return state;
  }
}

// One socket to the backend; everything it pushes lands in a single reducer.
export function useBackend(settings, { onMessage }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [socket, setSocket] = useState(null);
  const [conn, setConn] = useState({ connected: false, error: "" });
  const [now, setNow] = useState(Date.now());
  const handlers = useRef({ onMessage, view: null });
  handlers.current.onMessage = onMessage;

  useEffect(() => {
    const s = io(settings.url, { auth: { token: settings.token } });
    s.on("connect", () => {
      setConn({ connected: true, error: "" });
      dispatch({ type: "reset" }); // the app re-opens the current account/chat
    });
    s.on("disconnect", () => setConn((c) => ({ ...c, connected: false })));
    s.on("connect_error", (err) => setConn({ connected: false, error: err.message }));
    s.on("config", (config) => dispatch({ type: "config", config }));
    s.on("accounts", (accounts) => dispatch({ type: "accounts", accounts }));
    s.on("status", (d) => dispatch({ type: "status", ...d }));
    s.on("chats", (d) => dispatch({ type: "chats", ...d }));
    s.on("chat:snapshot", (d) => dispatch({ type: "snapshot", ...d }));
    s.on("message:new", ({ accountId, message }) => {
      const view = handlers.current.view;
      const looking = view?.accountId === accountId && view?.chatId === message.chatId && !document.hidden;
      dispatch({ type: "new", accountId, message, markUnread: !message.isMe && !looking });
      if (!message.isMe && !looking) handlers.current.onMessage?.(accountId, message);
    });
    s.on("message:updated", ({ accountId, message }) => dispatch({ type: "updated", accountId, message }));
    s.on("message:removed", (d) => dispatch({ type: "removed", ...d }));
    s.on("activity:list", (d) => dispatch({ type: "activity:list", ...d }));
    s.on("activity", (d) => dispatch({ type: "activity", ...d }));
    setSocket(s);
    return () => s.disconnect();
  }, [settings]);

  // light ticker for relative timestamps
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const tenant = JSON.parse(localStorage.getItem("snapbot:session") || "null")?.user?.id;
      if (tenant) localStorage.setItem("snapbot:unread:" + tenant, JSON.stringify(state.unread));
    } catch {
      // storage unavailable
    }
  }, [state.unread]);

  // emit with ack -> Promise; rejects with the server's error message
  const call = (event, payload) =>
    new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error("Not connected to backend"));
      socket.timeout(60000).emit(event, payload, (err, res) => {
        if (err) return reject(new Error("Backend did not respond"));
        if (!res?.ok) return reject(new Error(res?.error || "Request failed"));
        resolve(res.result);
      });
    });

  const setView = (view) => {
    handlers.current.view = view;
  };

  return { state, dispatch, socket, conn, now, call, setView };
}
