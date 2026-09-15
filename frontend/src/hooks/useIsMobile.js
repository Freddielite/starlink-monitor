import { useEffect, useState } from "react";

// 560px matches the breakpoint already used elsewhere in App.css for
// stacking layouts down to a single column, so "mobile" here means the
// same thing it means everywhere else in the app, not a separate cutoff.
const QUERY = "(max-width: 560px)";

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
