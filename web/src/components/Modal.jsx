import { useEffect } from "react";
import { Icon } from "../util.jsx";

export default function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`card modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <strong>{title}</strong>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>}
        </header>
        {children}
      </div>
    </div>
  );
}
