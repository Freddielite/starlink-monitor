// Reuses .sl-splash-glow/.sl-splash-icon/.sl-splash-dish/.sl-splash-arc
// directly - those are defined as plain (non-scoped) classes in
// index.html's inline <style>, which loads into every page this app
// renders, so this replays the exact same sequence the app opens with
// rather than a separately-maintained copy of it. The outer wrapper is
// this component's own (.sl-logout-transition in App.css), since
// index.html's positioning/background is on an ID (#sl-splash) tied to
// that one static element and isn't reusable as-is.
export default function LogoutTransition({ fading = false }) {
  return (
    <div className={`sl-logout-transition${fading ? " sl-logout-transition--hidden" : ""}`}>
      <div className="sl-splash-glow" />
      <svg className="sl-splash-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <path className="sl-splash-dish" d="M22 70 Q34 46 54 54" />
        <path className="sl-splash-dish" d="M35 60 L38 80" />
        <path className="sl-splash-dish" d="M29 82 H47" />
        <path className="sl-splash-arc sl-splash-arc--1" d="M58 57 Q56 44 45 42" />
        <path className="sl-splash-arc sl-splash-arc--2" d="M68 55 Q64 38 48 33" />
        <path className="sl-splash-arc sl-splash-arc--3" d="M78 53 Q72 31 50 24" />
      </svg>
    </div>
  );
}
