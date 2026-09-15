import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock.js";

// Matches App.css's .sl-overlay--closing/.sl-modal--closing animation
// duration - kept as one constant here rather than copied into the CSS
// as a "trust me it's 180ms" comment, since this is the value that
// actually has to match for the unmount timing below to look right.
const EXIT_DURATION_MS = 180;

// React unmounts the instant a parent stops rendering something, which
// leaves no room for an exit animation to actually play - by the time
// CSS would start transitioning opacity/transform back out, the element
// is just gone. Every modal in this app used to work exactly that way
// (instant appear, instant disappear), which is what this fixes: this
// wrapper stays mounted for EXIT_DURATION_MS after the caller flips
// `open` to false, playing the closing animation (via the
// .sl-overlay--closing class - see App.css), and only then actually
// returns null. Callers don't manage any of this timing themselves -
// flip `open` false (backdrop click, Cancel, a successful save/delete
// completing, whatever) and this handles the rest.
export default function ModalOverlay({ open, onCancel, closeOnBackdrop = true, children }) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  useBodyScrollLock(rendered);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, EXIT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  if (!rendered) return null;

  return createPortal(
    <div className={`sl-overlay${closing ? " sl-overlay--closing" : ""}`} onClick={closeOnBackdrop ? onCancel : undefined}>
      {children}
    </div>,
    document.body
  );
}
