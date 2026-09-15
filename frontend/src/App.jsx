import { useEffect, useState } from "react";
import { getMe, listKits } from "./api.js";
import { useToast } from "./hooks/useToast.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import AuthRoot from "./AuthRoot.jsx";
import BrandMark from "./components/BrandMark.jsx";
import SignalLine from "./components/SignalLine.jsx";
import Dashboard from "./components/Dashboard.jsx";
import KitDetail from "./components/KitDetail.jsx";
import KitForm from "./components/KitForm.jsx";
import SettingsView from "./components/SettingsView.jsx";
import InstallPrompt from "./components/InstallPrompt.jsx";
import LogoutTransition from "./components/LogoutTransition.jsx";
import { isIdle } from "./lib/kitDisplay.js";

// Bottom tab bar icons, hand-drawn rather than pulling in an icon
// library for two glyphs.
const ICONS = {
  kits: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17 Q7 10 12 12" />
      <path d="M8 14 L9 21" />
      <path d="M6 21 H13" />
      <path d="M15 14 Q14 10 11 9" />
      <path d="M19 13 Q18 7 12 5" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="15" cy="6" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="9" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="17" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [kits, setKits] = useState([]);
  const [kitsLoading, setKitsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("kits");
  const [adding, setAdding] = useState(false);
  const [navAction, setNavAction] = useState("tab");
  const [logoutPhase, setLogoutPhase] = useState(null);
  const { toasts, push: toast } = useToast();
  const isMobile = useIsMobile();

  useEffect(() => {
    getMe().then(setUser).catch(() => setUser(null));
  }, []);

  async function loadKits() {
    try {
      setKits(await listKits());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setKitsLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    loadKits();
    // Far less aggressive than Pulse's 30s poll, on purpose: nothing
    // here changes on a scale shorter than minutes (billing moves in
    // days, heartbeats in tens of minutes), so a fast poll would be
    // battery spent to re-render identical data.
    const id = window.setInterval(loadKits, 120000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // App icon badge: the count of kits that need a human to do something
  // - overdue or offline. Idle is deliberately excluded: it's a
  // standing condition worth reviewing, not something to act on today,
  // and a badge that never clears is a badge people stop seeing.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const needsAttention = kits.filter(
      (k) => k.billing_state === "grace" || k.billing_state === "suspended" || k.hardware_state === "offline"
    ).length;
    try {
      if (needsAttention > 0) navigator.setAppBadge(needsAttention);
      else navigator.clearAppBadge();
    } catch {
      // Badging just won't reflect this update - not worth surfacing.
    }
  }, [kits]);

  if (user === undefined) return null;
  if (!user) return <AuthRoot onAuthed={setUser} />;

  const selected = kits.find((k) => k.id === selectedId);

  function goToTab(t) {
    setNavAction("tab");
    setTab(t);
    setSelectedId(null);
  }

  function handleLoggedOut() {
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
    setLogoutPhase("playing");
    setTimeout(() => setLogoutPhase("fading"), 1700);
    setTimeout(() => {
      setUser(null);
      setTab("kits");
      setSelectedId(null);
      setAdding(false);
      // Cleared rather than left stale: the next login refetches
      // anyway, but not clearing would flash the previous account's
      // data on a shared device.
      setKits([]);
      setKitsLoading(true);
      setLogoutPhase(null);
    }, 2100);
  }

  const pageKey = `${tab}:${selected ? "detail" : "list"}`;

  return (
    <div className={`sl-shell${isMobile ? " sl-shell--with-tabbar" : ""}`}>
      {logoutPhase && <LogoutTransition fading={logoutPhase === "fading"} />}
      <div className="sl-header">
        <div className="sl-brand">
          <BrandMark />
          Starlink Monitor
        </div>
        <div className="sl-nav">
          <button className={tab === "kits" ? "active" : ""} onClick={() => goToTab("kits")}>
            Kits
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => goToTab("settings")}>
            Settings
          </button>
        </div>
      </div>
      <SignalLine />
      <InstallPrompt />

      <div key={pageKey} className={`sl-page sl-page--${navAction}`}>
        {tab === "kits" && !selected && (
          <Dashboard
            kits={kits}
            loading={kitsLoading}
            onSelect={(k) => {
              setNavAction("push");
              setSelectedId(k.id);
            }}
            onAdd={() => setAdding(true)}
            onChanged={loadKits}
            currentUser={user}
            toast={toast}
          />
        )}

        {tab === "kits" && selected && (
          <KitDetail
            kit={selected}
            currentUser={user}
            onBack={() => {
              setNavAction("pop");
              setSelectedId(null);
            }}
            onChanged={loadKits}
            toast={toast}
          />
        )}

        {tab === "settings" && <SettingsView user={user} onUserUpdated={setUser} onLoggedOut={handleLoggedOut} toast={toast} />}
      </div>

      {adding && (
        <KitForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            loadKits();
          }}
          toast={toast}
        />
      )}

      {isMobile && (
        <nav className="sl-tabbar">
          <button className={tab === "kits" ? "active" : ""} onClick={() => goToTab("kits")}>
            {ICONS.kits}
            Kits
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => goToTab("settings")}>
            {ICONS.settings}
            Settings
          </button>
        </nav>
      )}

      <div className="sl-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`sl-toast ${t.type === "error" ? "sl-toast--error" : ""} ${t.leaving ? "sl-toast--leaving" : ""}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
