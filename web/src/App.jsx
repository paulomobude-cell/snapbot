import { useCallback, useEffect, useMemo, useState } from "react";
import { useBackend } from "./state.js";
import { Icon } from "./util.jsx";
import AccountRail from "./components/AccountRail.jsx";
import ChatList from "./components/ChatList.jsx";
import Conversation from "./components/Conversation.jsx";
import LiveScreen from "./components/LiveScreen.jsx";
import ActivityPanel from "./components/ActivityPanel.jsx";
import AddAccount from "./components/AddAccount.jsx";
import AccountSettings from "./components/AccountSettings.jsx";
import Toasts, { useToasts } from "./components/Toasts.jsx";

const DEFAULT_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(() => load("snapbot:theme", "system"));
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    save("snapbot:theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [settings, setSettings] = useState(() => load("snapbot", null));
  useTheme();
  if (!settings) {
    return <Setup onSave={(s) => { save("snapbot", s); setSettings(s); }} />;
  }
  return <Dashboard settings={settings} onDisconnect={() => { save("snapbot", null); setSettings(null); }} />;
}

function Setup({ onSave }) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="setup">
      <form className="card setup-card" onSubmit={async (e) => {
        e.preventDefault();
        const clean = url.trim().replace(/\/+$/, "");
        setChecking(true);
        setError("");
        try {
          const res = await fetch(`${clean}/api/accounts`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status === 401) throw new Error("Wrong API token");
          if (!res.ok) throw new Error(`Backend answered ${res.status}`);
          onSave({ url: clean, token });
        } catch (err) {
          setError(err.message === "Failed to fetch" ? "Can't reach the backend (URL or CORS_ORIGIN?)" : err.message);
        } finally {
          setChecking(false);
        }
      }}>
        <div className="brand"><span className="logo">👻</span> SnapBot</div>
        <p className="muted">Connect to your SnapBot backend.</p>
        <label className="field">
          <span>Backend URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-app.up.railway.app" required />
        </label>
        <label className="field">
          <span>API token</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API_TOKEN from Railway" required autoFocus />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary" disabled={checking}>{checking ? "Checking…" : "Connect"}</button>
      </form>
    </div>
  );
}

function Dashboard({ settings, onDisconnect }) {
  const { toasts, toast, dismiss } = useToasts();
  const [notify, setNotify] = useState(() => load("snapbot:notify", false));
  const [view, setViewState] = useState(() => load("snapbot:view", { accountId: null, chatId: null }));
  const [panel, setPanel] = useState(null); // null | "screen" | "activity"
  const [modal, setModal] = useState(null); // null | "add" | "settings"
  const [theme, setTheme] = useTheme();

  const onMessage = useCallback((accountId, message) => {
    if (!notify || !("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(message.from, { body: message.text, tag: message.id });
    n.onclick = () => { window.focus(); n.close(); };
  }, [notify]);

  const { state, dispatch, socket, conn, now, call, setView } = useBackend(settings, { onMessage });
  const { accounts } = state;

  // keep a valid account selected
  const accountId = accounts.some((a) => a.id === view.accountId) ? view.accountId : accounts[0]?.id || null;
  const chatId = accountId === view.accountId ? view.chatId : null;
  const account = accounts.find((a) => a.id === accountId);
  const status = state.status[accountId]?.status || account?.status;

  useEffect(() => {
    setView({ accountId, chatId });
    save("snapbot:view", { accountId, chatId });
  }, [accountId, chatId]);

  // load the account's state whenever it's opened (and after reconnects, via state.js)
  useEffect(() => {
    if (accountId && conn.connected) call("account:open", { accountId }).catch(() => {});
  }, [accountId, conn.connected]);
  useEffect(() => {
    if (accountId && chatId && conn.connected) {
      call("chat:select", { accountId, chatId }).catch((e) => toast(e.message, "error"));
      dispatch({ type: "read", accountId, chatId });
    }
  }, [accountId, chatId, conn.connected]);

  // the live screen is how you log in, so open it when an account needs that
  useEffect(() => {
    if (status === "needs_login") setPanel("screen");
  }, [status, accountId]);

  // first run: nothing to show yet, so go straight to adding an account
  useEffect(() => {
    if (conn.connected && accounts.length === 0) setModal("add");
  }, [conn.connected, accounts.length]);

  const totalUnread = useMemo(() => Object.values(state.unread).reduce(
    (sum, chats) => sum + Object.values(chats).reduce((s, ids) => s + ids.length, 0), 0
  ), [state.unread]);
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) SnapBot` : "SnapBot";
  }, [totalUnread]);

  // reading the open chat while the tab is visible clears its badge
  useEffect(() => {
    const onVisible = () => !document.hidden && accountId && chatId && dispatch({ type: "read", accountId, chatId });
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [accountId, chatId]);

  const selectAccount = (id) => setViewState({ accountId: id, chatId: id === accountId ? chatId : null });
  const selectChat = (id) => setViewState({ accountId, chatId: id });

  const run = (event, payload, success) =>
    call(event, payload).then((r) => { if (success) toast(success, "success"); return r; })
      .catch((e) => { toast(e.message, "error"); throw e; });

  const toggleNotify = async () => {
    if (notify) return setNotify(false), save("snapbot:notify", false);
    if (!("Notification" in window)) return toast("This browser doesn't support notifications", "error");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notifications are blocked for this site", "error");
    setNotify(true);
    save("snapbot:notify", true);
    toast("You'll get a notification for new chats", "success");
  };

  const chats = state.chats[accountId] || [];
  const chat = chats.find((c) => c.id === chatId);

  return (
    <div className={`app ${chat ? "has-chat" : ""} ${panel ? "has-panel" : ""}`}>
      <AccountRail
        accounts={accounts}
        status={state.status}
        unread={state.unread}
        activeId={accountId}
        onSelect={selectAccount}
        onAdd={() => setModal("add")}
        canAdd={accounts.length < state.config.maxAccounts}
      />

      <ChatList
        account={account}
        status={status}
        error={state.status[accountId]?.error}
        chats={chats}
        messages={state.messages[accountId] || {}}
        unread={state.unread[accountId] || {}}
        activeId={chatId}
        now={now}
        onSelect={selectChat}
        toolbar={
          <>
            <button className={`icon-btn ${panel === "screen" ? "on" : ""}`} title="Live screen" onClick={() => setPanel(panel === "screen" ? null : "screen")}><Icon name="screen" /></button>
            <button className={`icon-btn ${panel === "activity" ? "on" : ""}`} title="Activity" onClick={() => setPanel(panel === "activity" ? null : "activity")}><Icon name="activity" /></button>
            <button className={`icon-btn ${notify ? "on" : ""}`} title={notify ? "Notifications on" : "Notifications off"} onClick={toggleNotify}><Icon name="bell" /></button>
            <button className="icon-btn" title="Theme" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
              <Icon name={theme === "dark" ? "moon" : "sun"} />
            </button>
            {account && <button className="icon-btn" title="Account settings" onClick={() => setModal("settings")}><Icon name="settings" /></button>}
          </>
        }
      />

      <Conversation
        key={`${accountId}:${chatId}`}
        chat={chat}
        status={status}
        messages={(state.messages[accountId] || {})[chatId] || []}
        now={now}
        onBack={() => selectChat(null)}
        onSend={(text) => call("message:send", { accountId, chatId, text })}
        onCopy={(text) => navigator.clipboard?.writeText(text).then(() => toast("Copied", "success"))}
        onOpenScreen={() => setPanel("screen")}
        toast={toast}
      />

      {panel && account && (
        <aside className="panel">
          {panel === "screen" && (
            <LiveScreen
              key={accountId}
              account={account}
              status={status} statusError={state.status[accountId]?.error || account?.error || null}
              call={call}
              socket={socket}
              onClose={() => setPanel(null)}
              toast={toast}
            />
          )}
          {panel === "activity" && (
            <ActivityPanel
              events={state.activity[accountId] || []}
              chats={chats}
              now={now}
              onOpenChat={(id) => selectChat(id)}
              onClose={() => setPanel(null)}
            />
          )}
        </aside>
      )}

      {!conn.connected && (
        <div className="conn-banner">
          <span className="spinner" /> {conn.error === "Unauthorized" ? "API token rejected" : conn.error ? `Can't reach backend: ${conn.error}` : "Reconnecting…"}
          <button className="btn small" onClick={onDisconnect}>Change backend</button>
        </div>
      )}

      {modal === "add" && (
        <AddAccount
          first={accounts.length === 0}
          onClose={() => setModal(null)}
          onCreate={async (data) => {
            const created = await run("account:create", data, "Account added");
            setModal(null);
            setViewState({ accountId: created.id, chatId: null });
            if (!data.password) setPanel("screen");
          }}
        />
      )}
      {modal === "settings" && account && (
        <AccountSettings
          account={account}
          status={status}
          onClose={() => setModal(null)}
          onSave={(data) => run("account:update", { accountId, ...data }, "Saved")}
          onRestart={() => run("account:restart", { accountId }, "Restarting session")}
          onLogout={() => run("account:logout", { accountId }, "Logged out")}
          onRemove={async () => {
            await run("account:remove", { accountId }, "Account removed");
            setModal(null);
          }}
          onDisconnect={onDisconnect}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
