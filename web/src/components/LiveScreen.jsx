import { useEffect, useRef, useState } from "react";
import { Icon, STATUS_LABEL } from "../util.jsx";
import { mirrorPoint } from "../mirror.js";

// Fullscreen mirrors only the browser. All controls are in an optional floating
// drawer reached by the small up-chevron; never cover the page with toolbars.
export default function LiveScreen({ account, status, statusError, socket, call, onClose, toast }) {
  const accountId = account.id;
  const [screen, setScreen] = useState({ frame: null, pages: [], pageId: null, width: 1920, height: 1080 });
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [input, setInput] = useState("");
  const [hiddenInput, setHiddenInput] = useState(false);
  const [typing, setTyping] = useState(false);
  const [credentials, setCredentials] = useState({
    username: account.username || "", password: "", remember: !!account.remembered,
  });
  const [authBusy, setAuthBusy] = useState(false);
  const rootRef = useRef(null);
  const imageRef = useRef(null);
  const viewportRef = useRef(null);

  useEffect(() => {
    const sync = () => {
      // Native Escape must restore the normal panel layout.
      if (!document.fullscreenElement && rootRef.current?.dataset.nativeMode === "true") {
        rootRef.current.dataset.nativeMode = "";
        setFullscreen(false);
        setControlsOpen(false);
        setZoom(1);
      }
    };
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      if (controlsOpen) {
        setControlsOpen(false);
      } else if (fullscreen && !document.fullscreenElement) {
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", onEscape);
    };
  }, [fullscreen, controlsOpen]);

  useEffect(() => {
    if (!socket) return;
    const onFrame = data => {
      if (data.accountId !== accountId) return;
      setScreen({
        frame: data.frame,
        pages: data.pages || [],
        pageId: data.pageId || null,
        width: data.width || 1920,
        height: data.height || 1080,
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
    call(event, { accountId, ...payload }).catch(error => {
      toast(error.message, "error");
      throw error;
    });

  const enterFullscreen = async () => {
    setZoom(1);
    setControlsOpen(false);
    setFullscreen(true);
    const root = rootRef.current;
    if (root?.requestFullscreen) {
      try {
        root.dataset.nativeMode = "true";
        await root.requestFullscreen({ navigationUI: "hide" });
      } catch {
        // iOS Safari and some PWA contexts can't fullscreen arbitrary elements.
        // Keep a viewport-filling fixed layout as fallback.
        root.dataset.nativeMode = "";
      }
    }
  };

  const exitFullscreen = async () => {
    if (document.fullscreenElement === rootRef.current) {
      await document.exitFullscreen().catch(() => {});
    }
    if (rootRef.current) rootRef.current.dataset.nativeMode = "";
    setFullscreen(false);
    setControlsOpen(false);
    setZoom(1);
  };

  // Desktop keyboards work directly when the viewport is focused; mobile
  // keyboards always use the dedicated text field in the floating drawer.
  const onKey = event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void send("screen:type", { text: event.key }).catch(() => {});
    } else if (["Enter", "Tab", "Backspace", "Escape", "Delete",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      void send("screen:key", { key: event.key }).catch(() => {});
    }
  };

  const onImageClick = async event => {
    const image = imageRef.current;
    if (!image) return;
    const point = mirrorPoint(event.clientX, event.clientY, image.getBoundingClientRect(),
      screen.width, screen.height);
    if (!point) return;
    event.currentTarget.parentElement?.focus({ preventScroll: true });
    await send("screen:click", point).catch(() => {});
  };

  const submitText = async event => {
    event.preventDefault();
    if (!input || typing) return;
    setTyping(true);
    try {
      await send("screen:type", { text: input });
      setInput("");
    } catch { /* Preserve text if remote typing failed. */ }
    finally { setTyping(false); }
  };

  const selectTab = async id => {
    await send("screen:select-page", { pageId: id }).catch(() => {});
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  };

  return (
    <div ref={rootRef} className={`panel-inner mirror-root ${fullscreen ? "mirror-fullscreen" : ""}`}>
      {!fullscreen && (
        <header className="panel-head mirror-header">
          <strong>Live browser</strong>
          <span className={`pill ${status}`}>{STATUS_LABEL[status] || status}</span>
          <div className="spacer" />
          <button className="icon-btn" type="button" onClick={() => void enterFullscreen()}
            title="Show only the browser fullscreen" aria-label="Fullscreen browser">⛶</button>
          <button className="icon-btn" type="button" onClick={onClose}
            title="Close browser" aria-label="Close browser"><Icon name="close" /></button>
        </header>
      )}

      <div className="mirror-viewport" ref={viewportRef} aria-label="Interactive Snapchat browser mirror">
        <div className="mirror-canvas"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          tabIndex={0} onKeyDown={onKey}
          aria-label="Remote browser image; click to focus remote fields">
          {screen.frame ? <img
            ref={imageRef} draggable={false} onClick={onImageClick}
            alt="Interactive screenshot of the remote browser"
            src={`data:image/jpeg;base64,${screen.frame}`} />
          : <div className="mirror-wait"><span className="spinner" /> Waiting for browser…</div>}
        </div>
      </div>

      {/* The closed state in fullscreen is exactly the mirror + this handle. */}
      {!controlsOpen && <button className="mirror-handle" type="button"
        onClick={() => setControlsOpen(true)} title="Show remote browser controls"
        aria-label="Open browser controls" aria-expanded={false}
        aria-controls="snapbot-mirror-controls">
        <span aria-hidden="true">⌃</span>
      </button>}

      {controlsOpen && (
        <>
          <button className="mirror-dismiss" aria-label="Dismiss remote controls"
            type="button" onClick={() => setControlsOpen(false)} />
          <section id="snapbot-mirror-controls" className="mirror-drawer" role="dialog"
            aria-modal="false" aria-label="Remote browser controls">
            <div className="mirror-drawer-grip">
              <button type="button" onClick={() => setControlsOpen(false)}
                title="Hide browser controls" aria-label="Hide browser controls">
                <span aria-hidden="true">⌄</span>
              </button>
            </div>
            <div className="mirror-drawer-scroll">
              {statusError && (
                <details className="mirror-status" role="status">
                  <summary>{STATUS_LABEL[status] || "Login status"} · View details</summary>
                  <p>{statusError}</p>
                </details>
              )}

              {screen.pages.length > 1 && (
                <nav className="mirror-tabs" aria-label="Remote browser tabs">
                  {screen.pages.map(page =>
                    <button className={`btn small ${screen.pageId === page.id ? "screen-tab-selected" : ""}`}
                      type="button" key={page.id}
                      aria-current={screen.pageId === page.id ? "page" : undefined}
                      onClick={() => void selectTab(page.id)} title={page.label}>
                      {page.site || page.label}
                    </button>)}
                </nav>
              )}

              <form className="mirror-entry" onSubmit={submitText}>
                <label htmlFor={`mirror-type-${accountId}`}>Type into the selected field</label>
                <div className="row">
                  <input id={`mirror-type-${accountId}`} aria-label="Text for remote browser"
                    type={hiddenInput ? "password" : "text"}
                    autoComplete="off" spellCheck={false}
                    placeholder="Tap a field in the browser, then type here"
                    value={input} onChange={event => setInput(event.target.value)} />
                  <button type="submit" className="btn primary" disabled={!input || typing}>
                    {typing ? "Sending…" : "Type"}
                  </button>
                </div>
                <label className="check"><input type="checkbox" checked={hiddenInput}
                  onChange={event => setHiddenInput(event.target.checked)} />
                  <span>Hide password or verification code</span>
                </label>
              </form>

              <div className="mirror-actions" role="group" aria-label="Remote keyboard and scroll controls">
                {["Enter", "Tab", "Backspace", "Escape"].map(key => (
                  <button key={key} type="button" className="btn small"
                    onClick={() => void send("screen:key", { key }).catch(() => {})}>{key}</button>
                ))}
                <button type="button" className="btn small"
                  onClick={() => void send("screen:scroll", { deltaY: -520 }).catch(() => {})}>↑ Scroll</button>
                <button type="button" className="btn small"
                  onClick={() => void send("screen:scroll", { deltaY: 520 }).catch(() => {})}>↓ Scroll</button>
              </div>
              <div className="mirror-actions">
                <button type="button" className="btn small" disabled={zoom <= 1}
                  onClick={() => setZoom(v => Math.max(1, +(v - 0.5).toFixed(1)))}>− Zoom</button>
                <span className="muted small">{Math.round(zoom * 100)}%</span>
                <button type="button" className="btn small" disabled={zoom >= 4}
                  onClick={() => setZoom(v => Math.min(4, +(v + 0.5).toFixed(1)))}>+ Zoom</button>
                <button type="button" className="btn small"
                  onClick={() => setZoom(1)}>Fit</button>
                <button type="button" className="btn small"
                  onClick={() => void send("account:restart").catch(() => {})}>Restart</button>
                {fullscreen ? <button type="button" className="btn small" onClick={() => void exitFullscreen()}>
                  Exit fullscreen</button>
                  : <button type="button" className="btn small" onClick={() => void enterFullscreen()}>
                    Fullscreen</button>}
              </div>

              {["needs_login", "error", "stopped"].includes(status) && (
                <details className="mirror-automatic">
                  <summary>Optional automatic username/password login</summary>
                  <form className="stack" onSubmit={async event => {
                    event.preventDefault();
                    setAuthBusy(true);
                    try {
                      await call("account:login", { accountId, ...credentials });
                      toast("Complete any additional login step in the browser.", "info");
                      setCredentials(old => ({ ...old, password: "" }));
                    } catch (error) { toast(error.message, "error"); }
                    finally { setAuthBusy(false); }
                  }}>
                    <input value={credentials.username} aria-label="Snapchat username"
                      onChange={e => setCredentials(old => ({ ...old, username: e.target.value }))}
                      placeholder="Username/email" autoComplete="username" required />
                    <input type="password" value={credentials.password}
                      onChange={e => setCredentials(old => ({ ...old, password: e.target.value }))}
                      aria-label="Snapchat password" placeholder="Password" autoComplete="current-password" required />
                    <label className="check"><input type="checkbox" checked={credentials.remember}
                      onChange={e => setCredentials(old => ({ ...old, remember: e.target.checked }))} />
                      Remember password encrypted on server</label>
                    <button type="submit" className="btn primary" disabled={authBusy}>
                      {authBusy ? "Logging in…" : "Log in"}
                    </button>
                  </form>
                </details>
              )}
              <p className="muted small mirror-footnote">
                {screen.width}×{screen.height} remote browser · Sign-in options and verification remain available in the mirror.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
