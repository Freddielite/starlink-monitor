import ModalOverlay from "./ModalOverlay.jsx";

// See ModalOverlay.jsx for why this takes an `open` prop instead of
// being conditionally rendered by its caller ({open && <ConfirmDialog
// .../>}) - that pattern can't animate an exit at all, since React
// unmounts the instant the parent stops rendering it. Every caller
// should render this unconditionally and just flip `open`.
export default function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", danger, busy = false, onConfirm, onCancel }) {
  return (
    <ModalOverlay open={open} onCancel={busy ? undefined : onCancel} closeOnBackdrop={!busy}>
      <div className="sl-panel sl-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="sl-modal__title">{title}</div>
        <div style={{ fontSize: 13.5, color: "var(--ink-dim)" }}>{body}</div>
        <div className="sl-modal__actions">
          <button className="sl-btn sl-btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`sl-btn ${danger ? "sl-btn--danger" : ""}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
