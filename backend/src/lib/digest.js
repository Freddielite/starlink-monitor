import { pool } from "../db.js";
import { sendAlertEmail } from "./mailer.js";
import { sendPushToUser } from "./webPush.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
import { resolveThresholds, daysUntilDue, idleDays, BILLING_LABELS } from "./kitStatus.js";

// Weekly summary of the whole fleet, opt-in per user. Deliberately a
// digest of STATE rather than of events: the useful weekly question here
// isn't "what happened" (the per-event alerts already covered that as it
// happened) but "what's outstanding right now" - which kits are overdue,
// which are dark, which are being paid for and not used. That's the list
// someone actually works from on a Monday morning.

const DAY_MS = 24 * 60 * 60 * 1000;

// Every kit a given user can see: their own, plus every kit belonging to
// any org they're an accepted member of. Same visibility rule as the
// dashboard, so the digest can never mention a kit they couldn't open.
async function kitsVisibleTo(userId) {
  const { rows } = await pool.query(
    `SELECT k.*, o.default_grace_days, o.default_expiring_soon_days, o.default_idle_alert_days, o.default_offline_after_min
     FROM kits k
     LEFT JOIN organizations o ON o.id = k.organization_id
     WHERE k.active = true
       AND (k.user_id = $1 OR k.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1))
     ORDER BY k.name ASC`,
    [userId]
  );
  return rows;
}

// Returns null when there's nothing worth sending, which callers treat
// as "skip this user" rather than as an error - a user with no kits yet
// shouldn't get an empty email every week.
export async function buildDigest(userId) {
  const kits = await kitsVisibleTo(userId);
  if (kits.length === 0) return null;

  const now = new Date();
  const overdue = [];
  const dueSoon = [];
  const offline = [];
  const idle = [];
  let unknownHardware = 0;

  for (const kit of kits) {
    // The org defaults come back on the same row via the LEFT JOIN
    // above, so resolveThresholds gets its org-level layer without a
    // second query per kit.
    const thresholds = resolveThresholds(kit, {
      default_grace_days: kit.default_grace_days,
      default_expiring_soon_days: kit.default_expiring_soon_days,
      default_idle_alert_days: kit.default_idle_alert_days,
      default_offline_after_min: kit.default_offline_after_min,
    });

    const days = daysUntilDue(kit, now);
    if (kit.billing_state === "grace" || kit.billing_state === "suspended") {
      overdue.push(`${label(kit)} - ${BILLING_LABELS[kit.billing_state]}, ${Math.abs(days ?? 0)}d over`);
    } else if (kit.billing_state === "expiring_soon") {
      dueSoon.push(`${label(kit)} - due in ${days}d`);
    }

    if (kit.hardware_state === "offline") offline.push(label(kit));
    if (kit.hardware_state === "unknown") unknownHardware++;

    const idleFor = idleDays(kit, now);
    if (idleFor !== null && idleFor >= thresholds.idle_alert_days) {
      idle.push(`${label(kit)} - ${idleFor}d`);
    }
  }

  const lines = [];
  lines.push(`${kits.length} kit${kits.length === 1 ? "" : "s"} tracked.`);
  lines.push(section("Overdue", overdue));
  lines.push(section("Due within the week", dueSoon));
  lines.push(section("Hardware offline", offline));
  lines.push(section("Idle", idle));
  if (unknownHardware > 0) {
    // Called out rather than hidden, because "unknown" is the default
    // state for any kit without an agent - if it's most of the fleet,
    // the hardware column isn't telling anyone anything and it's better
    // that they know that than assume silence means healthy.
    lines.push(`Hardware state unknown (no agent): ${unknownHardware}`);
  }

  const clean = overdue.length === 0 && offline.length === 0 && idle.length === 0;
  const summary = clean
    ? `All ${kits.length} kit${kits.length === 1 ? "" : "s"} are paid up, with nothing offline or idle.`
    : `${overdue.length} overdue, ${offline.length} offline, ${idle.length} idle.`;

  return { summary, body: lines.filter(Boolean).join("\n\n"), kitCount: kits.length };
}

function label(kit) {
  return kit.client_name ? `${kit.name} (${kit.client_name})` : kit.name;
}

function section(title, items) {
  if (items.length === 0) return null;
  return `${title} (${items.length}):\n${items.map((i) => `- ${i}`).join("\n")}`;
}

// Same unscoped, cadence-clocked shape as Pulse's digest sweep: called on
// every cron tick, a no-op on most of them because nobody's schedule is
// due. digest_sent_at is the "already went out this week" guard;
// digest_day_of_week is the actual schedule.
export async function runDigestSweep() {
  const today = new Date().getUTCDay();
  const { rows: users } = await pool.query(
    `SELECT * FROM users
     WHERE digest_enabled = true
       AND digest_day_of_week = $1
       AND (digest_sent_at IS NULL OR digest_sent_at < now() - interval '6 days')`,
    [today]
  );

  let sent = 0;
  for (const user of users) {
    const digest = await buildDigest(user.id);
    // Stamping the clock even when there's nothing to send stops a user
    // with no kits from being re-queried on every tick for the whole day.
    if (!digest) {
      await pool.query(`UPDATE users SET digest_sent_at = now() WHERE id = $1`, [user.id]);
      continue;
    }

    const title = "Weekly fleet summary";
    const text = `${digest.summary}\n\n${digest.body}`;
    await sendAlertEmail({ to: user.alert_email, subject: `Starlink Monitor: ${title}`, text });
    await sendPushToUser(user.id, { title, body: digest.summary, url: "/" });
    await sendTelegramMessage({ chatId: resolveChatId(user), text: `📊 ${title}\n${text}` });
    await pool.query(`UPDATE users SET digest_sent_at = now() WHERE id = $1`, [user.id]);
    sent++;
  }

  return sent;
}

export const DIGEST_WINDOW_MS = 7 * DAY_MS;
