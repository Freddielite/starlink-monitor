import { useRef, useState } from "react";

const THRESHOLD = 64;
const MAX_PULL = 96;
const RESISTANCE = 0.45;

// No preventDefault here on purpose: overscroll-behavior-y: contain
// (set globally in App.css) already stops the browser's own bounce/
// native pull-to-refresh from firing, so there's nothing left to
// suppress - this only needs to read the gesture, not fight the page
// for control of it.
export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef(null);
  const pullingRef = useRef(false);

  function handleTouchStart(e) {
    if (refreshing || window.scrollY > 0) {
      startYRef.current = null;
      return;
    }
    startYRef.current = e.touches[0].clientY;
    pullingRef.current = false;
  }

  function handleTouchMove(e) {
    if (startYRef.current == null) return;
    const dy = e.touches[0].clientY - startYRef.current;
    if (dy <= 0 || window.scrollY > 0) {
      pullingRef.current = false;
      setPull(0);
      return;
    }
    pullingRef.current = true;
    setPull(Math.min(MAX_PULL, dy * RESISTANCE));
  }

  async function handleTouchEnd() {
    if (pullingRef.current && pull > THRESHOLD) {
      setRefreshing(true);
      setPull(THRESHOLD);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
    startYRef.current = null;
    pullingRef.current = false;
  }

  const progress = Math.min(1, pull / THRESHOLD);

  return (
    <div onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      <div
        className="sl-ptr-indicator"
        style={{ height: pull, transition: pullingRef.current ? "none" : "height 0.2s ease" }}
      >
        <div
          className={`sl-ptr-spinner ${refreshing ? "sl-ptr-spinner--spin" : ""}`}
          style={{ opacity: progress, transform: refreshing ? undefined : `rotate(${progress * 220}deg)` }}
        />
      </div>
      <div style={{ transform: `translateY(${pull}px)`, transition: pullingRef.current ? "none" : "transform 0.2s ease" }}>
        {children}
      </div>
    </div>
  );
}
