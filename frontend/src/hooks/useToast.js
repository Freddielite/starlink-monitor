import { useCallback, useState } from "react";

let idCounter = 0;
const DISPLAY_MS = 3500;
// Matches .sl-toast--leaving's animation duration in App.css - see
// ModalOverlay.jsx for the same "mark it as leaving, then actually
// remove it once the exit animation has had time to play" reasoning,
// just per-toast here instead of one shared overlay.
const EXIT_MS = 200;

export function useToast() {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, type = "info") => {
    const id = ++idCounter;
    setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, EXIT_MS);
    }, DISPLAY_MS);
  }, []);

  return { toasts, push };
}
