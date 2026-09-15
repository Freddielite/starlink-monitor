import { useRef, useState } from "react";

const ACTION_WIDTH = 76;
const OVERSCROLL = 20; // small rubber-band past full reveal

export default function SwipeableRow({ actions, children }) {
  // Sized to however many actions this row actually has - a viewer with
  // no permitted actions (see Dashboard's canManageMonitor) gets an
  // empty array here, and REVEAL_WIDTH of 0 means there's nothing to
  // swipe open: no blank gap, no drag range, just the card.
  const REVEAL_WIDTH = actions.length * ACTION_WIDTH;
  const [dragX, setDragX] = useState(0);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef(null);
  const axisRef = useRef(null);

  if (REVEAL_WIDTH === 0) {
    return <div className="sl-swipe-row__content">{children}</div>;
  }

  function handleTouchStart(e) {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, base: open ? -REVEAL_WIDTH : 0 };
    axisRef.current = null;
    setDragging(true);
  }

  function handleTouchMove(e) {
    if (!startRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - startRef.current.x;
    const dy = t.clientY - startRef.current.y;
    if (!axisRef.current) {
      // Wait for a clear enough movement to tell a horizontal swipe
      // apart from the start of a vertical scroll, so a slightly
      // diagonal scroll gesture doesn't accidentally open this.
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axisRef.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (axisRef.current !== "x") return; // vertical scroll wins, leave it alone
    let next = startRef.current.base + dx;
    next = Math.min(OVERSCROLL, Math.max(-REVEAL_WIDTH - OVERSCROLL, next));
    setDragX(next);
  }

  function handleTouchEnd() {
    setDragging(false);
    if (axisRef.current === "x") {
      const shouldOpen = dragX < -REVEAL_WIDTH / 2;
      setOpen(shouldOpen);
      setDragX(shouldOpen ? -REVEAL_WIDTH : 0);
    }
    startRef.current = null;
    axisRef.current = null;
  }

  function handleContentClickCapture(e) {
    // While the actions are revealed, the first tap on the card just
    // closes it again instead of also navigating into the monitor -
    // matching how native swipe-actions lists behave.
    if (open) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setDragX(0);
    }
  }

  function runAction(fn) {
    setOpen(false);
    setDragX(0);
    fn();
  }

  return (
    <div className="sl-swipe-row">
      <div className="sl-swipe-row__actions" style={{ width: REVEAL_WIDTH }}>
        {actions.map((a) => (
          <button
            key={a.label}
            className={`sl-swipe-action sl-swipe-action--${a.tone || "snooze"}`}
            onClick={(e) => {
              e.stopPropagation();
              runAction(a.onClick);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="sl-swipe-row__content"
        style={{ transform: `translateX(${dragX}px)`, transition: dragging ? "none" : "transform 0.22s cubic-bezier(0.22,0.8,0.28,1)" }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
