import { useEffect, useRef, useState } from "react";
import { Icon, STATUS_LABEL } from "../util.jsx";

// Mirrors the account's Chrome so you can log in, solve captcha or enter a 2FA code.
export default function LiveScreen({ account, status, socket, call, onClose, toast }) {
  const [frame, setFrame] = useState(null);
  const [focused, setFocused] = useState(false);
  const [creds, setCreds] = useState({ username: account.username || "", password: "", remember: account.remembered });
  const [busy, setBusy] = useState(false);
  const imgRef = useRef(null);
  const accountId = account.id;

  useEffect(() => {
    if (!socket) return;
    const onFrame = (d) => d.accountId === accountId && setFrame(d.frame);
    const start = () => socket.emit("screen:start", { accountId });
    socket.on("screen:frame", onFrame);
    socket.on("connect", start);
    start();
    return () => {
      socket.off("screen:frame", onFrame);
      socket.off("connect", start);
      socket.emit("screen:stop", { accountId });
    };
  }, [socket, accountId]);

  const send = (event, payload) => call(event, { accountId, ...payload }).catch((e) => toast(e.message, "error"));

  // with the screen focused, keystrokes go straight to the remote page
  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (e.key.length === 1) send("screen:type", { text: e.key });
    else if (["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete"].includes(e.key)) {
      send("screen:key", { key: e.key });
    }
  };
  const onPaste = (e) => {
    const text = e.clipboardData.getData("text");
    if (text) send("screen:type", { text });
  };

  const needsLogin = status === "needs_login" || status === "error" || status === "stopped";

  return (
    <div className="panel-inner">
      <header className="panel-head">
        <strong>Live screen</strong>
        <span className={`pill ${status}`}>{STATUS_LABEL[status] || status}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Restart browser" onClick={() => send("account:restart")}><Icon name="refresh" /></button>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>

      <div
        className={`screen ${focused ? "focused" : ""}`}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="Remote browser"
            draggable={false}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              send("screen:click", { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            }}
            onWheel={(e) => send("screen:scroll", { deltaY: e.deltaY })}
          />
        ) : (
          <div className="screen-wait"><span className="spinner" /> Waiting for the browser…</div>
        )}
        <span className="screen-hint">{focused ? "Typing goes to Snapchat · click outside to stop" : "Click the screen to control it"}</span>
      </div>

      {needsLogin && (
        <form className="login-form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await call("account:login", { accountId, ...creds });
            toast("Logging in… finish any captcha or code on the screen", "info");
            setCreds((c) => ({ ...c, password: "" }));
          } catch (err) {
            toast(err.message, "error");
          } finally {
            setBusy(false);
          }
        }}>
          <strong>Log in to Snapchat</strong>
          <input placeholder="Username or email" autoComplete="username" value={creds.username}
            onChange={(e) => setCreds({ ...creds, username: e.target.value })} required />
          <input type="password" placeholder="Password" autoComplete="current-password" value={creds.password}
            onChange={(e) => setCreds({ ...creds, password: e.target.value })} required />
          <label className="check">
            <input type="checkbox" checked={creds.remember} onChange={(e) => setCreds({ ...creds, remember: e.target.checked })} />
            <span>Remember password (encrypted) to log back in automatically</span>
          </label>
          <button className="btn primary" disabled={busy}>{busy ? "Starting…" : "Log in"}</button>
        </form>
      )}

      <div className="screen-keys">
        {["Enter", "Tab", "Backspace", "Escape"].map((key) => (
          <button key={key} className="btn small" onClick={() => send("screen:key", { key })}>{key}</button>
        ))}
      </div>
      <p className="muted small pad-x">
        The login stays saved in this account's browser profile on the server, so you normally only do this once.
      </p>
    </div>
  );
}
