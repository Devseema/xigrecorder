// renderer/src/Modal.jsx
import React, { useEffect } from "react";
import ReactDOM from "react-dom";
import "./app.css"; // ensure modal styles are available

export default function Modal({ open, onClose, title, children, footer, closeOnBackdrop = true }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return ReactDOM.createPortal(
    <div className="xr-modal-backdrop" onMouseDown={e => { if (closeOnBackdrop && e.target.classList.contains('xr-modal-backdrop')) onClose && onClose(); }}>
      <div className="xr-modal" role="dialog" aria-modal="true" aria-label={title || "modal"}>
        <div className="xr-modal-header">
          <strong>{title || ""}</strong>
          <button className="xr-modal-close" onClick={() => onClose && onClose()}>Close</button>
        </div>
        <div className="xr-modal-body">{children}</div>
        {footer ? <div className="xr-modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}
