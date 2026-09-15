// Display-side helpers for the three axes. Deliberately presentation
// only: no thresholds are decided here and no state is derived here. The
// backend sends both the state and the resolved thresholds it used (see
// the GET /kits route), so this file never has to re-implement the
// kit -> org -> app fallback chain, which is exactly the kind of rule
// that drifts when it exists in two places.

export const BILLING_LABELS = {
  active: "Active",
  expiring_soon: "Expiring soon",
  grace: "Grace",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

// Colors carry meaning here and nowhere else - green/amber/orange/red
// appear only as state, never as decoration, so seeing one always means
// something. Grace gets its own orange rather than sharing amber with
// "expiring soon": those two are adjacent in the state machine and the
// whole point of the distinction is that one is a heads-up and the other
// is money already late.
export const BILLING_COLORS = {
  active: "var(--signal)",
  expiring_soon: "var(--amber)",
  grace: "var(--orange)",
  suspended: "var(--alert)",
  cancelled: "var(--ink-faint)",
};

export const HARDWARE_LABELS = { online: "Online", offline: "Offline", unknown: "Unknown" };

export const HARDWARE_COLORS = {
  online: "var(--signal)",
  offline: "var(--alert)",
  // Deliberately the dim ink, not amber. "Unknown" is the honest default
  // for any kit without an agent, which will be most of them - painting
  // it as a warning colour would make a normal, expected condition look
  // like a problem across the whole dashboard.
  unknown: "var(--ink-faint)",
};

export function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export function idleDays(kit) {
  if (!kit.last_active_at) return null;
  return Math.floor((Date.now() - new Date(kit.last_active_at).getTime()) / (24 * 60 * 60 * 1000));
}

export function isIdle(kit) {
  const days = idleDays(kit);
  return days !== null && days >= (kit.thresholds?.idle_alert_days ?? 30);
}

export function isSnoozed(kit) {
  return !!kit.snoozed_until && new Date(kit.snoozed_until).getTime() > Date.now();
}

// "in 4 days" / "3 days ago" / "today", from a signed day count. Reads
// better than a bare date on a card where the only thing anyone wants to
// know is how urgent it is.
export function dueLabel(kit) {
  const days = daysUntil(kit.next_due_at);
  if (days === null) return "no due date";
  if (days === 0) return "due today";
  if (days > 0) return `due in ${days}d`;
  return `${Math.abs(days)}d over`;
}

export function idleLabel(kit) {
  const days = idleDays(kit);
  if (days === null) return "never seen";
  if (days === 0) return "seen today";
  if (days < 30) return `idle ${days}d`;
  const months = Math.floor(days / 30);
  return `idle ${months}mo`;
}

export function timeAgo(iso) {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function timeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

export function money(amount, currency) {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${currency || ""} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();
}

export function dateOnly(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Sort order for the dashboard: the things that cost money or need a
// phone call first, everything healthy last. Sorting by "most recently
// changed" would be technically defensible and practically useless -
// the list someone opens this app to see is the list of problems.
const BILLING_RANK = { suspended: 0, grace: 1, expiring_soon: 2, active: 4, cancelled: 5 };

export function urgencyRank(kit) {
  if (kit.hardware_state === "offline") return -1;
  const base = BILLING_RANK[kit.billing_state] ?? 4;
  if (base >= 4 && isIdle(kit)) return 3;
  return base;
}
