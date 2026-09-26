import { useEffect, useRef, useState } from "react";

// One dropdown for the whole app instead of native <select>, which
// renders as the OS/browser's own picker - a different look on every
// platform, and visibly foreign against Starlink Monitor's own dark theme - rather
// than anything actually styled to match. Same value/onChange shape as a
// native select (value + a flat options list), so it drops into any
// existing sl-field without changing the surrounding form logic.
export default function Dropdown({ value, onChange, options, placeholder = "Select..." }) {
  const [open, setOpen] = useState(false);
  // Whether the menu opens upward. Measured rather than assumed: a
  // dropdown near the bottom of a phone screen that always opens
  // downward puts its options underneath the fixed tab bar, where they
  // can't be read or tapped. Raising the z-index alone would only mean
  // covering the navigation instead.
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recomputed every time it opens, and again on scroll or resize while
  // it's open, because the same control can be comfortably mid-screen
  // one moment and against the bottom edge the next.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Matches .sl-dropdown__menu's max-height, plus its 6px offset and
      // a little breathing room, so the decision is made against the
      // space the menu will actually want.
      const needed = Math.min(240, options.length * 38 + 8) + 14;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      // Only flips when there genuinely isn't room below AND there's
      // more room above - otherwise a cramped screen would flip it into
      // somewhere equally cramped.
      setDropUp(below < needed && above > below);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="sl-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sl-dropdown__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected ? selected.label : placeholder}</span>
        <svg className="sl-dropdown__chevron" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className={`sl-dropdown__menu${dropUp ? " sl-dropdown__menu--up" : ""}`} role="listbox">
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={`sl-dropdown__option ${opt.value === value ? "is-selected" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
