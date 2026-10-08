import { pool } from "../db.js";
import { recordKitEvent } from "./kitEvents.js";
import { resolveThresholds, deriveBillingState, nextDueAfterPayment, BILLING_LABELS } from "./kitStatus.js";

// The actual verbs - record a payment, mark a kit as seen, snooze it -
// extracted out of the HTTP layer so the same code runs whether the
// instruction arrives from the app, from a bulk selection, or from a
// button tapped inside Telegram.
//
// This matters more than it looks: "mark paid" is three coupled writes
// (append to the log, move the due date, recompute the state) and
// getting them subtly different per entry point is how a payment
// recorded from a notification ends up with a different due date than
// the same payment recorded in the app.

async function orgDefaultsFor(kit) {
  if (!kit.organization_id) return null;
  const { rows } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [kit.organization_id]);
  return rows[0] || null;
}

// Rewrites billing_state from the kit's dates immediately after anything
// that could have changed them, rather than waiting for the next cron
// tick - otherwise recording a payment leaves a kit visibly "Suspended"
// at exactly the moment someone is looking at the screen to confirm it
// landed.
//
// Deliberately does NOT touch billing_alerted_state: the sweep owns
// alerting, and letting it notice the move to 'active' on its own is
// what produces the "paid up" recovery message.
export async function resyncBillingState(kitId, actorUserId = null) {
  const { rows } = await pool.query(`SELECT * FROM kits WHERE id = $1`, [kitId]);
  const kit = rows[0];
  if (!kit) return null;
  const thresholds = resolveThresholds(kit, await orgDefaultsFor(kit));
  const next = deriveBillingState(kit, thresholds);
  if (next === kit.billing_state) return kit;

  const { rows: updated } = await pool.query(
    `UPDATE kits SET billing_state = $1, billing_state_changed_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
    [next, kitId]
  );
  await recordKitEvent(kitId, {
    kind: "billing_state_changed",
    severity: "info",
    title: `Billing: ${BILLING_LABELS[kit.billing_state] || kit.billing_state} → ${BILLING_LABELS[next] || next}`,
    detail: "Recalculated after a change to this kit's billing details.",
    data: { from: kit.billing_state, to: next },
    actorUserId,
  });
  return updated[0];
}

// Records a payment against one kit and moves it forward.
//
// With no explicit amount this falls back to what the kit says is owed,
// then to its recurring price. That fallback is what makes "mark paid"
// work as a single tap from a notification or across a bulk selection,
// where there's no opportunity to type a figure per kit.
export async function applyPayment(kit, input = {}, actorUserId = null) {
  const when = input.paid_at ? new Date(input.paid_at) : new Date();
  const nextDue = input.covers_until ? new Date(input.covers_until) : nextDueAfterPayment(kit, when);
  const amount =
    input.amount !== undefined && input.amount !== null && input.amount !== ""
      ? Number(input.amount)
      : kit.outstanding_amount ?? kit.plan_amount ?? null;
  const currency = input.currency || kit.outstanding_currency || kit.plan_currency || "NGN";

  const { rows } = await pool.query(
    `INSERT INTO payments (kit_id, recorded_by, paid_at, amount, currency, method, reference, covers_until, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [kit.id, actorUserId, when, amount, currency, input.method || null, input.reference || null, nextDue, input.note || null]
  );

  await pool.query(
    `UPDATE kits SET
       last_paid_at = $1,
       next_due_at = $2,
       -- Paying clears what was outstanding. Left stale, the dashboard
       -- would keep reporting money as owed that has just been
       -- received, which is the one number in this app that has to be
       -- trustworthy.
       outstanding_amount = NULL,
       outstanding_currency = NULL,
       overdue_since = NULL,
       last_payment_amount = $3,
       last_payment_currency = $4,
       updated_at = now()
     WHERE id = $5`,
    [when, nextDue, amount, currency, kit.id]
  );

  await recordKitEvent(kit.id, {
    kind: "payment_recorded",
    title: amount ? `Payment recorded: ${currency} ${amount}` : "Payment recorded",
    detail: `Covers until ${nextDue.toISOString().slice(0, 10)}${input.method ? ` · ${input.method}` : ""}${input.via ? ` · via ${input.via}` : ""}.`,
    data: { amount, currency, method: input.method || null, covers_until: nextDue, via: input.via || null },
    actorUserId,
  });

  const synced = await resyncBillingState(kit.id, actorUserId);
  return { payment: rows[0], kit: synced, amount, currency, nextDue };
}

export async function applyMarkSeen(kit, { at = null, note = null, via = null } = {}, actorUserId = null) {
  const when = at ? new Date(at) : new Date();
  const { rows } = await pool.query(
    `UPDATE kits SET last_active_at = $1, idle_alerted_at = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
    [when, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "marked_seen",
    title: "Marked as in use",
    detail: [note, via ? `via ${via}` : null].filter(Boolean).join(" · ") || null,
    actorUserId,
  });
  return rows[0];
}

export async function applySnooze(kit, minutes, actorUserId = null, via = null) {
  const until = new Date(Date.now() + minutes * 60 * 1000);
  const { rows } = await pool.query(
    `UPDATE kits SET snoozed_until = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [until, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "billing_state_changed",
    severity: "info",
    title: `Alerts muted for ${formatMinutes(minutes)}`,
    detail: via ? `Muted via ${via}.` : null,
    actorUserId,
  });
  return rows[0];
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
