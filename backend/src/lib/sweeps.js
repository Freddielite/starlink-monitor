import { pool } from "../db.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
import { sendWebhookAlert } from "./webhook.js";
import { wantsNotification } from "./notificationPrefs.js";
import { getNotifiableUsers } from "./orgAccess.js";
import { recordKitEvent } from "./kitEvents.js";
import {
  resolveThresholds,
  deriveBillingState,
  daysUntilDue,
  idleDays,
  isSnoozed,
  BILLING_LABELS,
  BILLING_SEVERITY,
} from "./kitStatus.js";

// How long an idle alert stays quiet before re-firing for a kit that's
// still idle. Without this the idle sweep would alert every single tick
// for a kit sitting at 45 days unused, which is the fastest way to teach
// people to ignore the channel. A week is long enough to be a nudge
// rather than a nag.
const IDLE_REALERT_DAYS = 7;
// Heartbeat rows older than this are dropped on each tick. The kit row
// keeps the latest values regardless, so this only trims the chart
// history - 60 days is more than enough to answer "when did this start"
// and small enough that a fleet of kits heartbeating every few minutes
// doesn't quietly become the largest table in the database.
const HEARTBEAT_RETENTION_DAYS = 60;
// Ceiling on deletions per tick, so switching retention on for an
// existing database (or a long outage in the cron) can't turn one tick
// into a multi-minute delete.
const MAX_HEARTBEAT_PRUNE_PER_RUN = 5000;

// Orgs are looked up once per sweep rather than once per kit: a fleet
// usually sits under a handful of orgs, and resolving thresholds needs
// the org row for every single kit.
async function loadOrgDefaults() {
  const { rows } = await pool.query(
    `SELECT id, default_grace_days, default_expiring_soon_days, default_idle_alert_days, default_offline_after_min
     FROM organizations`
  );
  return Object.fromEntries(rows.map((o) => [o.id, o]));
}

async function loadActiveKits() {
  const { rows } = await pool.query(`SELECT * FROM kits WHERE active = true`);
  return rows;
}

// ===================================================================
// Axis 1: billing
// ===================================================================

// Recomputes every active kit's billing state from its due date and
// alerts on transitions only.
//
// The thing this is careful about: the stored billing_state is a cache
// of deriveBillingState(), so it gets rewritten on every sweep whether
// or not anything changed. Alerts key off billing_alerted_state - a
// separate column recording what was last announced - rather than off
// the state write itself. That separation is what lets the state stay
// continuously correct (so the dashboard never shows a stale badge)
// while alerts stay one-per-transition (so nobody gets paged every five
// minutes for the same overdue invoice).
export async function runBillingSweep() {
  const kits = await loadActiveKits();
  const orgs = await loadOrgDefaults();
  const now = new Date();
  let transitioned = 0;
  let alerted = 0;

  for (const kit of kits) {
    const org = kit.organization_id ? orgs[kit.organization_id] : null;
    const thresholds = resolveThresholds(kit, org);
    const next = deriveBillingState(kit, thresholds, now);
    const previous = kit.billing_state;

    if (next !== previous) {
      await pool.query(
        `UPDATE kits SET billing_state = $1, billing_state_changed_at = now(), updated_at = now() WHERE id = $2`,
        [next, kit.id]
      );
      transitioned++;
      await recordKitEvent(kit.id, {
        kind: "billing_state_changed",
        severity: BILLING_SEVERITY[next] || "info",
        title: `Billing: ${BILLING_LABELS[previous] || previous} → ${BILLING_LABELS[next] || next}`,
        detail: describeBilling(kit, next, now),
        data: { from: previous, to: next, next_due_at: kit.next_due_at, thresholds },
      });
    }

    // Alert decision is independent of whether the state column just
    // changed: a kit whose state was already correct in the database but
    // was never announced (added mid-grace, imported, or alerted while
    // snoozed) still gets its one alert once it's no longer snoozed.
    const shouldAlert = next !== kit.billing_alerted_state && next !== "cancelled";
    if (shouldAlert && !isSnoozed(kit, now)) {
      if (next === "active") {
        // Only worth announcing as a recovery if there was something to
        // recover from. A brand-new kit whose alerted_state is NULL
        // shouldn't fire "back in good standing" as its first ever
        // message.
        if (kit.billing_alerted_state && kit.billing_alerted_state !== "active") {
          await alertBillingRecovered(kit);
          alerted++;
        }
      } else {
        await alertBillingState(kit, next, now);
        alerted++;
      }
      await pool.query(`UPDATE kits SET billing_alerted_state = $1 WHERE id = $2`, [next, kit.id]);
    } else if (shouldAlert && isSnoozed(kit, now)) {
      // Deliberately NOT recording the state as alerted here. A snoozed
      // kit that crosses into suspended should still announce that once
      // the snooze expires - swallowing it silently is how a suspension
      // gets missed entirely because someone snoozed the kit for an
      // unrelated reason a week earlier.
    }
  }

  return { billingTransitions: transitioned, billingAlerts: alerted };
}

function describeBilling(kit, state, now) {
  const days = daysUntilDue(kit, now);
  if (days === null) return "No due date recorded for this kit.";
  if (state === "expiring_soon") return `Due in ${days} day${days === 1 ? "" : "s"}.`;
  if (state === "grace" || state === "suspended") {
    const over = Math.abs(days);
    return `${over} day${over === 1 ? "" : "s"} past the due date.`;
  }
  return `Due in ${days} day${days === 1 ? "" : "s"}.`;
}

// ===================================================================
// Axis 2: hardware
// ===================================================================

// Flips kits to offline when their agent stops heartbeating, and back to
// online when it resumes.
//
// Only kits with agent_enabled are touched at all. A kit with no agent
// keeps whatever a human last set - including 'unknown', which is the
// honest default when nothing on the network can be reached. This sweep
// never invents a hardware state for a kit it has no way to observe.
//
// The retry-before-down shape is lifted from Pulse's
// alert_after_failures/consecutive_failures, for the same reason it
// existed there and a stronger one here: a Starlink dish reconnecting
// after an obstruction, a satellite handover, or a router reboot will
// drop a heartbeat window without the kit being down in any sense the
// client would recognise. alert_after_misses consecutive stale windows
// have to pass before the state actually flips.
export async function runHardwareSweep() {
  const { rows: kits } = await pool.query(`SELECT * FROM kits WHERE active = true AND agent_enabled = true`);
  const orgs = await loadOrgDefaults();
  const now = new Date();
  let wentOffline = 0;
  let cameBack = 0;

  for (const kit of kits) {
    const org = kit.organization_id ? orgs[kit.organization_id] : null;
    const thresholds = resolveThresholds(kit, org);
    const staleAfterMs = thresholds.offline_after_min * 60 * 1000;

    // An agent that has been enabled but has never once checked in is
    // left as-is rather than being marked offline. Nothing has failed
    // yet - the agent may simply not be installed - and "offline"
    // would be a claim about hardware based on no observation at all.
    if (!kit.last_heartbeat_at) continue;

    const stale = now.getTime() - new Date(kit.last_heartbeat_at).getTime() > staleAfterMs;

    if (stale) {
      const misses = kit.consecutive_misses + 1;
      const crossed = misses >= kit.alert_after_misses;
      await pool.query(`UPDATE kits SET consecutive_misses = $1 WHERE id = $2`, [misses, kit.id]);

      if (crossed && kit.hardware_state !== "offline") {
        await pool.query(
          `UPDATE kits SET hardware_state = 'offline', hardware_source = 'agent',
             hardware_state_changed_at = now(), updated_at = now() WHERE id = $1`,
          [kit.id]
        );
        wentOffline++;
        const mins = Math.round((now.getTime() - new Date(kit.last_heartbeat_at).getTime()) / 60000);
        await recordKitEvent(kit.id, {
          kind: "hardware_state_changed",
          severity: "high",
          title: "Hardware: offline",
          detail: `No agent heartbeat for ${mins} minutes (threshold ${thresholds.offline_after_min}m, after ${kit.alert_after_misses} missed window${kit.alert_after_misses === 1 ? "" : "s"}).`,
          data: { from: kit.hardware_state, to: "offline", last_heartbeat_at: kit.last_heartbeat_at },
        });
        if (!isSnoozed(kit, now) && kit.hardware_alerted_state !== "offline") {
          await alertHardware(kit, "offline", `No heartbeat from this kit for ${mins} minutes.`);
          await pool.query(`UPDATE kits SET hardware_alerted_state = 'offline' WHERE id = $1`, [kit.id]);
        }
      }
    }
    // The recovery direction isn't handled here - it's handled in
    // recordHeartbeat() below, at the moment a heartbeat actually
    // arrives, so "it's back" lands immediately rather than waiting for
    // the next tick.
  }

  return { kitsOffline: wentOffline, kitsRecovered: cameBack };
}

// Called by the agent route when a heartbeat arrives. Lives here rather
// than in the route so that the "what a heartbeat means" logic - it
// proves the hardware is up, it resets the miss counter, and if it
// carries real throughput it also proves the kit is in USE - is in one
// place next to the sweep that interprets its absence.
export async function recordHeartbeat(kit, payload) {
  const {
    obstruction_pct = null,
    downlink_mbps = null,
    uplink_mbps = null,
    ping_ms = null,
    uptime_sec = null,
    ...rest
  } = payload || {};

  await pool.query(
    `INSERT INTO heartbeats (kit_id, obstruction_pct, downlink_mbps, uplink_mbps, ping_ms, uptime_sec, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [kit.id, obstruction_pct, downlink_mbps, uplink_mbps, ping_ms, uptime_sec, Object.keys(rest).length ? JSON.stringify(rest) : null]
  );

  const wasOffline = kit.hardware_state === "offline";

  // A heartbeat proves the dish is reachable and powered. Whether it
  // proves the kit is being USED is a different question, which is the
  // whole reason usage is its own axis: an idle dish sitting in a locked
  // office heartbeats perfectly happily. So last_active_at only advances
  // when the agent reports throughput above a floor that plain protocol
  // chatter wouldn't reach on its own.
  const inUse = Number(downlink_mbps) > 0.5 || Number(uplink_mbps) > 0.5;

  await pool.query(
    `UPDATE kits SET
       last_heartbeat_at = now(),
       consecutive_misses = 0,
       hardware_state = 'online',
       hardware_source = 'agent',
       hardware_state_changed_at = CASE WHEN hardware_state <> 'online' THEN now() ELSE hardware_state_changed_at END,
       last_obstruction_pct = COALESCE($2, last_obstruction_pct),
       last_downlink_mbps = COALESCE($3, last_downlink_mbps),
       last_uplink_mbps = COALESCE($4, last_uplink_mbps),
       last_ping_ms = COALESCE($5, last_ping_ms),
       last_active_at = CASE WHEN $6 THEN now() ELSE last_active_at END,
       -- Clearing this on recovery is what re-arms the offline alert, so
       -- a kit that flaps down/up/down still reports the second outage.
       hardware_alerted_state = CASE WHEN $7 THEN NULL ELSE hardware_alerted_state END,
       updated_at = now()
     WHERE id = $1`,
    [kit.id, obstruction_pct, downlink_mbps, uplink_mbps, ping_ms, inUse, wasOffline]
  );

  if (wasOffline) {
    await recordKitEvent(kit.id, {
      kind: "hardware_state_changed",
      severity: "info",
      title: "Hardware: back online",
      detail: "An agent heartbeat arrived after the kit had been marked offline.",
      data: { from: "offline", to: "online" },
    });
    if (!isSnoozed(kit)) {
      await alertHardware(kit, "online", "This kit is heartbeating again.");
    }
  }

  return { recorded: true, recovered: wasOffline, countedAsUse: inUse };
}

// ===================================================================
// Axis 3: usage / idle
// ===================================================================

// Flags kits that are paid for and (as far as anyone knows) working, but
// that nobody has actually used in a long time. This is the axis that
// exists purely to save money: it's the one that finds the kit in the
// site office that closed in March and has been billing quietly ever
// since.
export async function runIdleSweep() {
  const kits = await loadActiveKits();
  const orgs = await loadOrgDefaults();
  const now = new Date();
  let flagged = 0;

  for (const kit of kits) {
    const org = kit.organization_id ? orgs[kit.organization_id] : null;
    const thresholds = resolveThresholds(kit, org);
    const days = idleDays(kit, now);
    // NULL means nobody has ever recorded this kit as in use. Treated as
    // "not enough information to call it idle" rather than as maximally
    // idle - see idleDays() in kitStatus.js for why that direction
    // matters when switching this on for an existing fleet.
    if (days === null || days < thresholds.idle_alert_days) continue;
    // A cancelled kit being unused is the expected outcome, not a
    // finding.
    if (kit.billing_state === "cancelled") continue;

    const alertedRecently =
      kit.idle_alerted_at && now.getTime() - new Date(kit.idle_alerted_at).getTime() < IDLE_REALERT_DAYS * 24 * 60 * 60 * 1000;
    if (alertedRecently) continue;

    await recordKitEvent(kit.id, {
      kind: "idle_flagged",
      severity: "medium",
      title: `Idle for ${days} days`,
      detail: `No recorded use since ${new Date(kit.last_active_at).toISOString().slice(0, 10)} (threshold ${thresholds.idle_alert_days} days).`,
      data: { idle_days: days, threshold: thresholds.idle_alert_days },
    });

    if (!isSnoozed(kit, now)) {
      await alertIdle(kit, days, thresholds.idle_alert_days);
      flagged++;
    }
    // The clock is stamped whether or not an alert actually went out, so
    // a snoozed kit doesn't queue up a burst of idle alerts to deliver
    // all at once when the snooze lifts. Unlike a billing transition -
    // which is a discrete event worth delivering late - "still idle" is
    // a standing condition that's just as true next week.
    await pool.query(`UPDATE kits SET idle_alerted_at = now() WHERE id = $1`, [kit.id]);
  }

  return { idleFlagged: flagged };
}

// ===================================================================
// Housekeeping
// ===================================================================

export async function pruneHeartbeats() {
  const { rowCount } = await pool.query(
    `DELETE FROM heartbeats WHERE id IN (
       SELECT id FROM heartbeats
       WHERE received_at < now() - ($1 || ' days')::interval
       LIMIT $2
     )`,
    [HEARTBEAT_RETENTION_DAYS, MAX_HEARTBEAT_PRUNE_PER_RUN]
  );
  return rowCount;
}

// ===================================================================
// Alert fan-out
//
// One helper per event kind, each following the same shape Pulse used:
// resolve everyone who should hear about it, then push/email/telegram/
// webhook each of them subject to their own per-channel preferences.
// Email is deliberately unconditional (an empty alert_email is itself
// the off switch) to match the rest of the app.
// ===================================================================

const CURRENCY_FORMAT = { minimumFractionDigits: 0, maximumFractionDigits: 2 };

function money(kit) {
  if (kit.plan_amount === null || kit.plan_amount === undefined) return null;
  return `${kit.plan_currency || ""} ${Number(kit.plan_amount).toLocaleString(undefined, CURRENCY_FORMAT)}`.trim();
}

function kitLabel(kit) {
  return kit.client_name ? `${kit.name} (${kit.client_name})` : kit.name;
}

function whereLabel(kit) {
  return [kit.city, kit.region].filter(Boolean).join(", ");
}

async function fanOut(kit, { eventKey, emoji, title, body, severity, webhookEvent }) {
  const notifiable = await getNotifiableUsers(kit);
  const where = whereLabel(kit);
  const context = where ? `${body}\n\nLocation: ${where}` : body;
  for (const user of notifiable) {
    if (wantsNotification(user, "push", eventKey)) {
      await sendPushToUser(user.id, { title, body, url: `/kits/${kit.id}` });
    }
    await sendAlertEmail({ to: user.alert_email, subject: `Starlink Monitor: ${title}`, text: context });
    if (wantsNotification(user, "telegram", eventKey)) {
      await sendTelegramMessage({ chatId: resolveChatId(user), text: `${emoji} ${title}\n${context}` });
    }
    if (wantsNotification(user, "webhook", eventKey)) {
      await sendWebhookAlert(user.webhook_url, { event: webhookEvent, severity, title, body: context, kit });
    }
  }
}

async function alertBillingState(kit, state, now) {
  const days = daysUntilDue(kit, now);
  const amount = money(kit);
  const over = days === null ? null : Math.abs(days);

  const copy = {
    expiring_soon: {
      emoji: "⏳",
      title: `${kitLabel(kit)} is due in ${over} day${over === 1 ? "" : "s"}`,
      body: `Payment${amount ? ` of ${amount}` : ""} is due on ${dueDateLabel(kit)}.`,
      eventKey: "expiring",
      webhookEvent: "billing_expiring_soon",
      severity: "low",
    },
    grace: {
      emoji: "🟠",
      title: `${kitLabel(kit)} is overdue`,
      body: `${over} day${over === 1 ? "" : "s"} past the due date of ${dueDateLabel(kit)}${amount ? `, ${amount} outstanding` : ""}. Still inside the grace period you set.`,
      eventKey: "grace",
      webhookEvent: "billing_grace",
      severity: "medium",
    },
    suspended: {
      emoji: "🔴",
      title: `${kitLabel(kit)} is suspended`,
      body: `${over} day${over === 1 ? "" : "s"} past the due date of ${dueDateLabel(kit)} - past the grace period. ${amount ? `${amount} outstanding.` : ""}`.trim(),
      eventKey: "suspended",
      webhookEvent: "billing_suspended",
      severity: "high",
    },
  }[state];

  if (!copy) return;
  await fanOut(kit, copy);
}

async function alertBillingRecovered(kit) {
  await fanOut(kit, {
    eventKey: "expiring",
    emoji: "🟢",
    title: `${kitLabel(kit)} is paid up`,
    body: `Next payment due ${dueDateLabel(kit)}.`,
    severity: "info",
    webhookEvent: "billing_active",
  });
}

async function alertHardware(kit, state, detail) {
  await fanOut(kit, {
    eventKey: "hardware",
    emoji: state === "offline" ? "🔴" : "🟢",
    title: `${kitLabel(kit)} is ${state}`,
    body: detail,
    severity: state === "offline" ? "high" : "info",
    webhookEvent: state === "offline" ? "hardware_offline" : "hardware_online",
  });
}

async function alertIdle(kit, days, threshold) {
  await fanOut(kit, {
    eventKey: "idle",
    emoji: "💤",
    title: `${kitLabel(kit)} has been idle ${days} days`,
    body: `No recorded use in ${days} days (your threshold is ${threshold}). It's still being billed${money(kit) ? ` at ${money(kit)} per cycle` : ""}.`,
    severity: "medium",
    webhookEvent: "kit_idle",
  });
}

function dueDateLabel(kit) {
  if (!kit.next_due_at) return "an unset date";
  return new Date(kit.next_due_at).toISOString().slice(0, 10);
}
