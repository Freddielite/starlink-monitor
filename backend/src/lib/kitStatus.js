// The rules that turn dates into the three states a kit is described by.
// Deliberately pure functions with no database access: every sweep, every
// route, and the "what would this look like if I changed the grace
// period" preview all run the same code over the same inputs, so there's
// exactly one definition of what "grace" means in this app.

// Level 3 of threshold resolution - the values used when neither the kit
// nor its organization has an opinion. A personal kit (organization_id
// NULL) always lands here, which is why these have to be sensible
// defaults rather than placeholders.
export const APP_DEFAULTS = {
  // Days before next_due_at that a kit starts reading as "expiring
  // soon". Three days is enough warning to chase a client without the
  // badge being on half the fleet at any given moment.
  expiring_soon_days: 3,
  // Days past next_due_at before a kit moves from grace to suspended.
  // Starlink does not expose a grace period - this is a countdown the
  // operator decides on and this app tracks, not a fact read from
  // anywhere, which is why it's editable at every level.
  grace_days: 7,
  // Days without use before the idle alert fires.
  idle_alert_days: 30,
  // Minutes without an agent heartbeat before a missed window is
  // counted. Meaningless for kits with no agent - those stay 'unknown'.
  offline_after_min: 20,
};

const THRESHOLD_KEYS = Object.keys(APP_DEFAULTS);

// Kit override -> org default -> app default, per key independently, so
// a kit that only overrides grace_days still picks up its org's idle
// threshold rather than silently falling all the way back to the app
// default for everything else.
//
// `org` may be null (personal kit) - that's the normal case for a
// single-operator deployment, not an edge case.
export function resolveThresholds(kit, org) {
  const out = {};
  for (const key of THRESHOLD_KEYS) {
    const fromKit = kit?.[key];
    const fromOrg = org?.[`default_${key}`];
    out[key] = numberOr(fromKit, numberOr(fromOrg, APP_DEFAULTS[key]));
  }
  return out;
}

function numberOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const BILLING_STATES = ["active", "expiring_soon", "grace", "suspended", "cancelled"];
export const HARDWARE_STATES = ["online", "offline", "unknown"];

export const BILLING_LABELS = {
  active: "Active",
  expiring_soon: "Expiring soon",
  grace: "Grace",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

// Which billing states are worth waking someone up for, and how loudly.
// 'active' isn't here because arriving at active is a recovery, handled
// separately in the sweep so it can be phrased as good news.
export const BILLING_SEVERITY = {
  expiring_soon: "low",
  grace: "medium",
  suspended: "high",
  cancelled: "info",
};

// The whole billing state machine, in one place.
//
// 'cancelled' is terminal and manual: a cancelled kit has no meaningful
// due date, so it's returned unchanged rather than being recomputed into
// something else the moment a stale next_due_at passes. Every other
// state is a pure function of (now, next_due_at, thresholds) - which
// means correcting a wrong due date instantly corrects the state, with
// no separate "recalculate" action for anyone to forget.
export function deriveBillingState(kit, thresholds, now = new Date()) {
  if (kit.billing_state === "cancelled") return "cancelled";
  // No due date recorded yet. Not an error - a kit can be added before
  // anyone knows its billing date - so it reads as active rather than
  // being guessed into a warning state that would be noise.
  if (!kit.next_due_at) return "active";

  const due = new Date(kit.next_due_at).getTime();
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (nowMs < due) {
    const daysUntil = (due - nowMs) / dayMs;
    return daysUntil <= thresholds.expiring_soon_days ? "expiring_soon" : "active";
  }

  const daysOver = (nowMs - due) / dayMs;
  // A grace period of 0 is legitimate ("no grace, suspend on the due
  // date") and falls straight through to suspended here rather than
  // needing its own branch.
  return daysOver <= thresholds.grace_days ? "grace" : "suspended";
}

// Whole days, signed: positive = still has time, negative = overdue.
// Returned separately from the state because the UI wants both ("Grace",
// "4 days over") and deriving one from the other in the frontend would
// be a second copy of these rules.
export function daysUntilDue(kit, now = new Date()) {
  if (!kit.next_due_at) return null;
  return Math.ceil((new Date(kit.next_due_at).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

// How long a kit has gone unused. NULL last_active_at returns null
// ("never seen"), NOT a huge number - a kit nobody has ever marked as
// seen is an unknown, and treating it as 9999 days idle would flood the
// alert channel the moment idle tracking is switched on for an existing
// fleet.
export function idleDays(kit, now = new Date()) {
  if (!kit.last_active_at) return null;
  return Math.floor((now.getTime() - new Date(kit.last_active_at).getTime()) / (24 * 60 * 60 * 1000));
}

export function isIdle(kit, thresholds, now = new Date()) {
  const days = idleDays(kit, now);
  return days !== null && days >= thresholds.idle_alert_days;
}

// True while a kit is deliberately muted. Checked before every alert in
// the sweeps, but NOT before state derivation - a snoozed kit still
// moves through its states correctly and shows the truth on the
// dashboard, it just doesn't page anyone about it. Snoozing something to
// stop it lying about its own state would be the wrong trade.
export function isSnoozed(kit, now = new Date()) {
  return !!kit.snoozed_until && new Date(kit.snoozed_until).getTime() > now.getTime();
}

// Days a billing cycle advances the due date by when a payment is
// recorded. 'custom' falls back to billing_cycle_days, and anything
// unparseable falls back to 30 rather than throwing - a payment being
// recorded with a slightly wrong next date is recoverable (the date is
// editable), a 500 that loses the payment entirely is not.
export function cycleDays(kit) {
  if (kit.billing_cycle === "custom") {
    const n = Number(kit.billing_cycle_days);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    return 30;
  }
  // 'monthly' and '30_day' both advance 30 days here. They're kept as
  // separate values because they mean different things to the person
  // reading the kit ("billed on the 5th" vs "30 days from activation"),
  // and a real calendar-month advance is a change to this function, not
  // to every call site.
  return 30;
}

// The next due date after a payment. Anchored to the CURRENT due date
// rather than to today when that date is in the future or only recently
// past, so a client who pays three days early doesn't silently lose
// three days of what they paid for. Once a kit is far enough past due
// that anchoring would hand out a date still in the past, it anchors to
// today instead.
export function nextDueAfterPayment(kit, paidAt = new Date()) {
  const days = cycleDays(kit);
  const dayMs = 24 * 60 * 60 * 1000;
  const anchor = kit.next_due_at ? new Date(kit.next_due_at) : new Date(paidAt);
  const candidate = new Date(anchor.getTime() + days * dayMs);
  if (candidate.getTime() > paidAt.getTime()) return candidate;
  return new Date(new Date(paidAt).getTime() + days * dayMs);
}
