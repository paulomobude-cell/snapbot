import { useEffect, useRef, useState } from "react";
import { Icon, STATUS_LABEL } from "../util.jsx";

// Interactive remote browser: clicking the image focuses an element in
// Chromium; mobile users type via the explicit input beneath the viewport.
export default function LiveScreen({ account, status, statusError, socket, call, onClose, toast }) {
  const [screen, setScreen] = useState({ frame: null, pages: [], pageId: null });
  const [focused, setFocused] = useState(false);
  const [zoom, setZoom] = useState(() => window.innerWidth < 760 ? 2.2 : 1.3);
  const [expanded, setExpanded] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const fullscreenRef = useRef(null);
  const [remoteText, setRemoteText] = useState("");
  const [privateText, setPrivateText] = useState(false);
  const [sendingText, setSendingText] = useState(false);
  const [creds, setCreds] = useState({
    username: account.username || "", password: "", remember: account.remembered,
  });
  const [busy, setBusy] = useState(false);
  const viewportRef = useRef(null);

  useEffect(() => {
    const update = () => setNativeFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggleFullscreen = async () => {
    const element = fullscreenRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      await document.exitFullscreen().catch(() => {});
      setExpanded(false);
      return;
    }
    // iOS Safari may not expose requestFullscreen on ordinary elements.
    // The fixed-position expanded view stays available as a fallback.
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setZoom(1);
    if (element.requestFullscreen) {
      try { await element.requestFullscreen(); }
      catch { /* fallback: expanded fixed-position view */ }
    }
  };
  const accountId = account.id;

  useEffect(() => {
    setScreen({ frame: null, pages: [], pageId: null, width: null, height: null, quality: null });
    if (!socket) return;
    const onFrame = (data) => {
      if (data.accountId !== accountId) return;
      setScreen({
        frame: data.frame,
        pages: data.pages || [],
        pageId: data.pageId || null,
        width: data.width || null,
        height: data.height || null,
        quality: data.quality || null,
      });
    };
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

  const send = (event, payload = {}) =>
    call(event, { accountId, ...payload }).catch((error) => {
      toast(error.message, "error");
      throw error;
    });

  const clickImage = async (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    await send("screen:click", {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    }).catch(() => {});
  };

  const onKeyDown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void send("screen:type", { text: event.key }).catch(() => {});
    } else if (["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown",
      "ArrowLeft", "ArrowRight", "Delete"].includes(event.key)) {
      event.preventDefault();
      void send("screen:key", { key: event.key }).catch(() => {});
    }
  };

  const sendText = async (event) => {
    event.preventDefault();
    if (!remoteText || sendingText) return;
    setSendingText(true);
    try {
      await send("screen:type", { text: remoteText });
      setRemoteText("");
      if (privateText) setPrivateText(false);
    } catch {
      // Keep typed text when transmission fails, so users can retry.
    } finally {
      setSendingText(false);
    }
  };

  const chooseTab = async (id) => {
    await send("screen:select-page", { pageId: id }).catch(() => {});
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const needsLogin = ["needs_login", "error", "stopped"].includes(status);
  return (
    <div ref={fullscreenRef} className={`panel-inner live-browser ${expanded ? "live-browser-expanded" : ""}`}>
      <header className="panel-head">
        <strong>Interactive browser</strong>
        <span className={`pill ${status}`}>{STATUS_LABEL[status] || status}</span>
        <div className="spacer" />
        <button className="icon-btn" title={expanded ? "Exit fullscreen" : "Fullscreen browser"}
          onClick={() => void toggleFullscreen()}
          aria-label={expanded ? "Exit fullscreen" : "Fullscreen browser"}>
          {expanded ? "↙" : "⛶"}
        </button>
        <button className="icon-btn" title="Restart Chromium" onClick={() => void send("account:restart").catch(() => {})}>
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" title="Close live screen" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      {statusError && (status === "needs_login" || status === "error") && (
        <div className="alert" role="alert" style={{ margin: "2px 16px" }}>
          {statusError} You can also sign in manually below.
        </div>
      )}

      {screen.pages.length > 1 && (
        <nav className="screen-tabs" aria-label="Remote browser tabs">
          {screen.pages.map((page) => (
            <button type="button" key={page.id} title={page.label}
              className={`btn small ${page.id === screen.pageId ? "screen-tab-selected" : ""}`}
              aria-current={page.id === screen.pageId ? "page" : undefined}
              onClick={() => void chooseTab(page.id)}>
              {page.site || page.label}
            </button>
          ))}
        </nav>
      )}

      <div className="screen-toolbar" role="group" aria-label="Remote screen zoom controls">
        <button className="btn small" type="button" disabled={zoom <= 1} onClick={() => setZoom((v) => Math.max(1, +(v - 0.4).toFixed(1)))}>−</button>
        <span className="muted small">{Math.round(zoom * 100)}% zoom</span>
        {screen.width && screen.height && <span className="muted small" aria-label="Remote browser capture resolution">{screen.width}×{screen.height} · HD JPEG</span>}
        <button className="btn small" type="button" disabled={zoom >= 4} onClick={() => setZoom((v) => Math.min(4, +(v + 0.4).toFixed(1)))}>+</button>
        <button className="btn small" type="button" onClick={() => setZoom(1)}>Fit</button>
        <button className="btn small" type="button" onClick={() => void toggleFullscreen()}>{nativeFullscreen ? "Exit fullscreen" : expanded ? "Return to panel" : "Fullscreen"}</button>
        <span className="muted small">Click a field on the screen, then type below.</span>
      </div>

      <div ref={viewportRef} className="screen-viewport" aria-label="Scroll and zoom the remote browser">
        <div className={`screen ${focused ? "focused" : ""}`}
          tabIndex={0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          style={{ width: `${Math.round(zoom * 100)}%` }}>
          {screen.frame ? (
            <img src={`data:image/jpeg;base64,${screen.frame}`} alt="Remote browser — click to interact"
              draggable={false} onClick={(event) => void clickImage(event)} />
          ) : (
            <div className="screen-wait"><span className="spinner" /> Waiting for the remote browser…</div>
          )}
        </div>
      </div>

      <form className="screen-type-form" onSubmit={sendText}>
        <label className="muted small" htmlFor={`remote-type-${accountId}`}>
          Type into the selected field in the remote browser
        </label>
        <div className="row">
          <input id={`remote-type-${accountId}`} aria-label="Remote browser text"
            type={privateText ? "password" : "text"}
            autoComplete="off" spellCheck={false}
            value={remoteText} onChange={(event) => setRemoteText(event.target.value)}
            placeholder="Tap a field in the browser first" />
          <button className="btn primary" disabled={!remoteText || sendingText} type="submit">
            {sendingText ? "Typing…" : "Type"}
          </button>
        </div>
        <label className="check"><input type="checkbox" checked={privateText}
          onChange={(event) => setPrivateText(event.target.checked)} />
          <span>Hide text (for passwords and verification codes)</span>
        </label>
      </form>

      <div className="screen-keys" role="group" aria-label="Remote browser keyboard and scrolling">
        {["Enter", "Tab", "Backspace", "Escape"].map((key) => (
          <button type="button" key={key} className="btn small"
            onClick={() => void send("screen:key", { key }).catch(() => {})}>{key}</button>
        ))}
        <button type="button" className="btn small" onClick={() => void send("screen:scroll", { deltaY: -520 }).catch(() => {})}>↑ Scroll</button>
        <button type="button" className="btn small" onClick={() => void send("screen:scroll", { deltaY: 520 }).catch(() => {})}>↓ Scroll</button>
      </div>

      {needsLogin && (
        <details className="login-form">
          <summary>Optional: automatic username/password login</summary>
          <p className="muted small">You can instead click a sign-in option such as Google in the live browser above. Some providers restrict automated browsers.</p>
          <form className="stack" onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await call("account:login", { accountId, ...creds });
              toast("Login started. Complete any verification in the live browser.", "info");
              setCreds((current) => ({ ...current, password: "" }));
            } catch (error) {
              toast(error.message, "error");
            } finally {
              setBusy(false);
            }
          }}>
            <input aria-label="Snapchat username" autoComplete="username"
              placeholder="Username or email" value={creds.username}
              onChange={(event) => setCreds({ ...creds, username: event.target.value })} required />
            <input type="password" aria-label="Snapchat password" autoComplete="current-password"
              placeholder="Password" value={creds.password}
              onChange={(event) => setCreds({ ...creds, password: event.target.value })} required />
            <label className="check">
              <input type="checkbox" checked={creds.remember} onChange={(event) => setCreds({ ...creds, remember: event.target.checked })} />
              <span>Remember password encrypted on the server</span>
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Logging in…" : "Log in automatically"}
            </button>
          </form>
        </details>
      )}
      <p className="muted small pad-x">
        The remote browser is stored on Railway. When you finish logging in, its profile persists across restarts.
      </p>
    </div>
  );
}
