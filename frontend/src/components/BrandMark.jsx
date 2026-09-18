// The header/auth-screen mark. Same dish-and-arcs geometry as the splash
// in index.html, at rest - one shape for the whole app rather than a
// logo that changes between the loading screen and the interface.
export default function BrandMark({ className = "sl-brand__mark" }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="20" fill="#0a0e14" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6">
        <g stroke="#e7eef7" opacity="0.9">
          <path d="M22 70 Q34 46 54 54" />
          <path d="M35 60 L38 80" />
          <path d="M29 82 H47" />
        </g>
        <g stroke="#4db5ff">
          <path d="M58 57 Q56 44 45 42" />
          <path d="M68 55 Q64 38 48 33" opacity="0.75" />
          <path d="M78 53 Q72 31 50 24" opacity="0.5" />
        </g>
      </g>
    </svg>
  );
}
