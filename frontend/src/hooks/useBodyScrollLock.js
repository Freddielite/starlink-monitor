import { useEffect } from "react";

// Without this, the modal's own overlay scrolls fine, but the body behind
// it is still a live scroll container. On mobile that surfaces two ways:
// focusing a form field makes the browser auto-scroll to bring it above
// the keyboard, and since it doesn't know the field is inside a
// position:fixed overlay, it scrolls the *document* instead - which
// visibly moves the page behind the overlay while the modal itself stays
// put. And once the body has scrolled, its own overscroll-behavior:contain
// no longer stops that motion from feeling like it's coming from the
// modal. Locking the body's scroll for as long as the modal is mounted
// closes both holes: nothing behind the overlay can move, so any scroll
// gesture that starts over the modal has nowhere to go but the overlay's
// own overflow-y:auto.
//
// Plain `overflow: hidden` on body is enough on desktop, but iOS Safari
// ignores that for touch scrolling - it still allows the page to scroll.
// `position: fixed` on body is the actual fix there, but it drops the
// scroll position, so the current scrollY is saved and restored around
// it rather than just toggling a class.
export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return;

    const { body } = document;
    const scrollY = window.scrollY;

    const prevOverflow = body.style.overflow;
    const prevPosition = body.style.position;
    const prevTop = body.style.top;
    const prevWidth = body.style.width;

    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    return () => {
      body.style.overflow = prevOverflow;
      body.style.position = prevPosition;
      body.style.top = prevTop;
      body.style.width = prevWidth;
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
