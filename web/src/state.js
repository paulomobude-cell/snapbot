import { useEffect, useReducer, useRef, useState } from "react";
import { io } from "socket.io-client";

export const LEAVE_MS = 1600; // how long a deleted/expired bubble animates out

const initial = {
  accounts: [],
  status: {}, // accountId -> { status, error }
  chats: {}, // accountId -> Chat[]
  messages: {}, // accountId -> { chatId -> Message[] }  (leavingAt/leaveReason while animating out)
  activity: {}, // accountId -> Event[] newest first
  unread: loadUnread(), // accountId -> { chatId -> messageId[] }
  config: { ttlMs: 24 * 3600 * 1000, maxAccounts: 3 },
};

function loadUnread() {
  try {
    return JSON.parse(localStorage.getItem("snapbot:unread") || "{}");
  } catch {
    return {};
  }
}

const setIn = (obj, acc, value) => ({ ...obj, [acc]: value });

function markLeaving(list, ids, reason, now) {
  let changed = false;
  const next = list.map((m) => {
    if (!ids.has(m.id) || m.leavingAt) return m;
    changed = true;
    return { ...m, leavingAt: now, leaveReason: reason };
  });
  return changed ? next : list;
}

function dropUnread(unread, acc, chatId, ids) {
  const list = unread[acc]?.[chatId];
  if (!list) return unread;
  const kept = list.filter((id) => !ids.has(id));
  if (kept.length === list.length) return unread;
  return setIn(unread, acc, { ...unread[acc], [chatId]: kept });
}

function reducer(state, a) {
  const acc = a.accountId;
  switch (a.type) {
    case "reset":
      // reconnect: forget every message, the server re-sends what still exists
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
      // authoritative list for the chat: anything missing from it was deleted
      const byChat = state.messages[acc] || {};
      const current = byChat[a.chatId] || [];
      const incoming = new Set(a.messages.map((m) => m.id));
      const leaving = current
        .filter((m) => !incoming.has(m.id))
        .map((m) => (m.leavingAt ? m : { ...m, leavingAt: a.now, leaveReason: "deleted" }));
      const merged = [...a.messages];
      // keep leaving bubbles right after whatever preceded them, so they fade out in place
      for (const m of leaving) {
        const before = current.slice(0, current.findIndex((x) => x.id === m.id));
        const anchor = before.reverse().find((x) => merged.some((y) => y.id === x.id));
        const at = anchor ? merged.findIndex((y) => y.id === anchor.id) + 1 : 0;
        merged.splice(at, 0, m);
      }
      const gone = new Set(leaving.map((m) => m.id));
      return {
        ...state,
        messages: setIn(state.messages, acc, { ...byChat, [a.chatId]: merged }),
        unread: dropUnread(state.unread, acc, a.chatId, gone),
      };
    }
    case "new": {
      const byChat = state.messages[acc] || {};
      const list = byChat[a.message.chatId] || [];
      if (list.some((m) => m.id === a.message.id)) return state;
      let unread = state.unread;
      if (a.markUnread) {
        const u = unread[acc] || {};
        unread = setIn(unread, acc, { ...u, [a.message.chatId]: [...(u[a.message.chatId] || []), a.message.id] });
      }
      return {
        ...state,
        messages: setIn(state.messages, acc, { ...byChat, [a.message.chatId]: [...list, a.message] }),
        unread,
      };
    }
    case "leave": {
      const byChat = state.messages[acc] || {};
      const list = byChat[a.chatId];
      const ids = new Set([a.id]);
      const unread = dropUnread(state.unread, acc, a.chatId, ids);
      if (!list) return { ...state, unread };
      return {
        ...state,
        messages: setIn(state.messages, acc, { ...byChat, [a.chatId]: markLeaving(list, ids, a.reason, a.now) }),
        unread,
      };
    }
    case "tick": {
      // client-side expiry + finishing leave animations
      let changed = false;
      let unread = state.unread;
      const messages = {};
      for (const [accId, byChat] of Object.entries(state.messages)) {
        messages[accId] = {};
        for (const [chatId, list] of Object.entries(byChat)) {
          const expired = new Set(list.filter((m) => !m.leavingAt && m.expiresAt <= a.now).map((m) => m.id));
          let next = expired.size ? markLeaving(list, expired, "expired", a.now) : list;
          next = next.filter((m) => !m.leavingAt || a.now - m.leavingAt < LEAVE_MS);
          if (expired.size) unread = dropUnread(unread, accId, chatId, expired);
          if (next !== list) changed = true;
          messages[accId][chatId] = next;
        }
      }
      return changed ? { ...state, messages, unread } : state;
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
export function useBackend(settings, { onMessage, onError }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [socket, setSocket] = useState(null);
  const [conn, setConn] = useState({ connected: false, error: "" });
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const handlers = useRef({ onMessage, onError, view: null });
  handlers.current.onMessage = onMessage;
  handlers.current.onError = onError;

  useEffect(() => {
    const s = io(settings.url, { auth: { token: settings.token } });
    const offsetRef = { current: 0 };
    const serverNow = () => Date.now() + offsetRef.current;
    s.on("connect", () => {
      setConn({ connected: true, error: "" });
      // the app re-opens the current account/chat when `connected` flips
      dispatch({ type: "reset" });
    });
    s.on("disconnect", () => setConn((c) => ({ ...c, connected: false })));
    s.on("connect_error", (err) => setConn({ connected: false, error: err.message }));
    s.on("config", (config) => {
      offsetRef.current = config.now - Date.now();
      setClockOffset(offsetRef.current);
      dispatch({ type: "config", config });
    });
    s.on("accounts", (accounts) => dispatch({ type: "accounts", accounts }));
    s.on("status", (d) => dispatch({ type: "status", ...d }));
    s.on("chats", (d) => dispatch({ type: "chats", ...d }));
    s.on("chat:snapshot", (d) => dispatch({ type: "snapshot", ...d, now: serverNow() }));
    s.on("message:new", ({ accountId, message }) => {
      const view = handlers.current.view;
      const looking = view?.accountId === accountId && view?.chatId === message.chatId && !document.hidden;
      dispatch({ type: "new", accountId, message, markUnread: !message.isMe && !looking });
      if (!message.isMe && !looking) handlers.current.onMessage?.(accountId, message);
    });
    s.on("message:deleted", (d) => dispatch({ type: "leave", ...d, reason: "deleted", now: serverNow() }));
    s.on("message:expired", (d) => dispatch({ type: "leave", ...d, reason: "expired", now: serverNow() }));
    s.on("activity:list", (d) => dispatch({ type: "activity:list", ...d }));
    s.on("activity", (d) => dispatch({ type: "activity", ...d }));
    setSocket(s);
    return () => s.disconnect();
  }, [settings]);

  useEffect(() => {
    const t = setInterval(() => {
      const n = Date.now() + clockOffset;
      setNow(n);
      dispatch({ type: "tick", now: n });
    }, 500);
    return () => clearInterval(t);
  }, [clockOffset]);

  useEffect(() => {
    try {
      localStorage.setItem("snapbot:unread", JSON.stringify(state.unread));
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
