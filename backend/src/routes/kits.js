import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireOrgRole, logOrgAction } from "../lib/orgAccess.js";
import { recordKitEvent } from "../lib/kitEvents.js";
import { runBillingSweep } from "../lib/sweeps.js";
import { geocodeAddress, validateCoords } from "../lib/geocode.js";
import { hashToken } from "../lib/apiTokens.js";
import {
  resolveThresholds,
  deriveBillingState,
  nextDueAfterPayment,
  BILLING_STATES,
  HARDWARE_STATES,
  BILLING_LABELS,
} from "../lib/kitStatus.js";

const router = Router();
router.use(requireAuth);

// Columns that must never leave the server. agent_token_hash is a
// credential (see the db.js comment), and while a hash isn't directly
// replayable, there is no reason for it to be in an API response at all
// - so it's stripped in one place rather than relying on every SELECT
// remembering to list columns explicitly.
function publicKit(row) {
  if (!row) return row;
  const { agent_token_hash, ...rest } = row;
  return rest;
}

// Every route that changes a kit goes through this. The kit's creator
// can always manage it; otherwise it takes admin+ on the org that owns
// it. A plain member can see a kit and be alerted about it - that's what
// being on the team means - without being able to edit it, delete it,
// snooze it, or record a payment against it.
//
// Distinct from the broader WHERE clauses on the read routes, which
// grant every member visibility. This is the actual permission check,
// run before the mutation, so someone without access gets a clear 403
// rather than a query that silently matches zero rows and looks like a
// missing record.
async function loadKitForMutation(req, res) {
  const { rows } = await pool.query(`SELECT * FROM kits WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "kit not found" });
    return null;
  }
  const kit = rows[0];
  const isCreator = kit.user_id === req.userId;
  const isOrgAdmin = kit.organization_id && (await requireOrgRole(req.userId, kit.organization_id, "admin"));
  if (!isCreator && !isOrgAdmin) {
    res.status(403).json({ error: "admin access on this kit's organization is required for that" });
    return null;
  }
  return kit;
}

async function loadKitForRead(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM kits WHERE id = $1
       AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "kit not found" });
    return null;
  }
  return rows[0];
}

async function orgDefaultsFor(kit) {
  if (!kit.organization_id) return null;
  const { rows } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [kit.organization_id]);
  return rows[0] || null;
}

// Rewrites billing_state from the kit's dates immediately after anything
// that could have changed them, rather than waiting for the next cron
// tick. Without this, recording a payment would leave a kit visibly
// "Suspended" on the dashboard until the next sweep - which is both
// wrong and the exact moment someone is looking at the screen to confirm
// the payment landed.
//
// Note this deliberately does NOT touch billing_alerted_state: the sweep
// owns alerting, and letting it notice the transition to 'active' on its
// own is what produces the "paid up" recovery message.
async function resyncBillingState(kitId, actorUserId = null) {
  const { rows } = await pool.query(`SELECT * FROM kits WHERE id = $1`, [kitId]);
  const kit = rows[0];
  if (!kit) return null;
  const org = await orgDefaultsFor(kit);
  const thresholds = resolveThresholds(kit, org);
  const next = deriveBillingState(kit, thresholds);
  if (next !== kit.billing_state) {
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
  return kit;
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === "") return { value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: `${field} isn't a valid date` };
  return { value: d };
}

function parseNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ===================================================================
// Reads
// ===================================================================

// The dashboard's single fetch. Returns every kit the requester can see,
// with each kit's RESOLVED thresholds attached rather than its raw
// nullable overrides - the frontend renders "idle for 34 days (flagged
// at 30)" and would otherwise have to re-implement the kit ->
// org -> app fallback chain to know what 30 was. One implementation of
// that chain, on the server.
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT k.*, o.name AS organization_name,
            o.default_grace_days, o.default_expiring_soon_days,
            o.default_idle_alert_days, o.default_offline_after_min
     FROM kits k
     LEFT JOIN organizations o ON o.id = k.organization_id
     WHERE k.user_id = $1 OR k.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1)
     ORDER BY k.created_at ASC`,
    [req.userId]
  );

  res.json(
    rows.map((row) => {
      const org = row.organization_id
        ? {
            default_grace_days: row.default_grace_days,
            default_expiring_soon_days: row.default_expiring_soon_days,
            default_idle_alert_days: row.default_idle_alert_days,
            default_offline_after_min: row.default_offline_after_min,
          }
        : null;
      const {
        default_grace_days, default_expiring_soon_days, default_idle_alert_days, default_offline_after_min, ...kit
      } = row;
      return { ...publicKit(kit), thresholds: resolveThresholds(kit, org) };
    })
  );
});

router.get("/:id", async (req, res) => {
  const kit = await loadKitForRead(req, res);
  if (!kit) return;
  const org = await orgDefaultsFor(kit);
  res.json({ ...publicKit(kit), thresholds: resolveThresholds(kit, org) });
});

router.get("/:id/payments", async (req, res) => {
  const kit = await loadKitForRead(req, res);
  if (!kit) return;
  const { rows } = await pool.query(
    `SELECT p.*, u.email AS recorded_by_email
     FROM payments p LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.kit_id = $1 ORDER BY p.paid_at DESC`,
    [kit.id]
  );
  res.json(rows);
});

router.get("/:id/events", async (req, res) => {
  const kit = await loadKitForRead(req, res);
  if (!kit) return;
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const { rows } = await pool.query(
    `SELECT e.*, u.email AS actor_email
     FROM kit_events e LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.kit_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
    [kit.id, limit]
  );
  res.json(rows);
});

router.get("/:id/heartbeats", async (req, res) => {
  const kit = await loadKitForRead(req, res);
  if (!kit) return;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await pool.query(
    `SELECT received_at, obstruction_pct, downlink_mbps, uplink_mbps, ping_ms, uptime_sec
     FROM heartbeats WHERE kit_id = $1 ORDER BY received_at DESC LIMIT $2`,
    [kit.id, limit]
  );
  res.json(rows);
});

// ===================================================================
// Create / update / delete
// ===================================================================

router.post("/", async (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "the kit needs a name" });

  const due = parseDate(b.next_due_at, "next due date");
  if (due.error) return res.status(400).json({ error: due.error });

  const lat = parseNumberOrNull(b.latitude);
  const lng = parseNumberOrNull(b.longitude);
  const coordError = validateCoords(lat, lng);
  if (coordError) return res.status(400).json({ error: coordError });

  if (b.organization_id) {
    // Assigning a kit to an org takes admin+ there. Member is view-only
    // for creation, matching the role model in lib/orgAccess.js.
    const allowed = await requireOrgRole(req.userId, b.organization_id, "admin");
    if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to add kits to it" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO kits (
         user_id, organization_id, name, client_name, service_line, kit_serial, hardware_model, notes,
         plan_name, plan_amount, plan_currency, billing_cycle, billing_cycle_days,
         next_due_at, grace_days, expiring_soon_days, idle_alert_days, offline_after_min, alert_after_misses,
         address, city, region, country, latitude, longitude, geocode_source, last_active_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        req.userId,
        b.organization_id || null,
        b.name.trim(),
        b.client_name?.trim() || null,
        b.service_line?.trim() || null,
        b.kit_serial?.trim() || null,
        b.hardware_model?.trim() || null,
        b.notes?.trim() || null,
        b.plan_name?.trim() || null,
        parseNumberOrNull(b.plan_amount),
        b.plan_currency?.trim() || "NGN",
        ["monthly", "30_day", "custom"].includes(b.billing_cycle) ? b.billing_cycle : "monthly",
        parseNumberOrNull(b.billing_cycle_days),
        due.value,
        parseNumberOrNull(b.grace_days),
        parseNumberOrNull(b.expiring_soon_days),
        parseNumberOrNull(b.idle_alert_days),
        parseNumberOrNull(b.offline_after_min),
        Math.max(1, Number(b.alert_after_misses) || 2),
        b.address?.trim() || null,
        b.city?.trim() || null,
        b.region?.trim() || null,
        b.country?.trim() || null,
        lat,
        lng,
        lat === null ? null : b.geocode_source === "nominatim" ? "nominatim" : "manual",
        // An operator adding a kit that's already in service can say so
        // up front. Left NULL otherwise, which reads as "never seen"
        // rather than starting an idle countdown from the moment of data
        // entry - a kit typed in today hasn't been idle since today.
        parseDate(b.last_active_at, "last active").value,
      ]
    );

    const kit = rows[0];
    await recordKitEvent(kit.id, {
      kind: "kit_created",
      title: "Kit added",
      detail: kit.client_name ? `Added for ${kit.client_name}.` : null,
      actorUserId: req.userId,
    });
    if (kit.organization_id) await logOrgAction(kit.organization_id, req.userId, "kit_created", `added kit "${kit.name}"`);

    const synced = await resyncBillingState(kit.id, req.userId);
    res.status(201).json(publicKit(synced || kit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create the kit" });
  }
});

// Fields a PATCH is allowed to set directly. billing_state and
// hardware_state are deliberately absent: both have their own endpoints
// below, because changing either is a real event with a timeline entry
// and an alert consequence, not a field edit.
const PATCHABLE = [
  "name", "client_name", "service_line", "kit_serial", "hardware_model", "notes", "active",
  "plan_name", "plan_amount", "plan_currency", "billing_cycle", "billing_cycle_days", "next_due_at",
  "grace_days", "expiring_soon_days", "idle_alert_days", "offline_after_min", "alert_after_misses",
  "address", "city", "region", "country", "latitude", "longitude",
];

router.patch("/:id", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const b = req.body || {};

  if (b.next_due_at !== undefined) {
    const due = parseDate(b.next_due_at, "next due date");
    if (due.error) return res.status(400).json({ error: due.error });
  }

  const latProvided = b.latitude !== undefined || b.longitude !== undefined;
  if (latProvided) {
    const lat = parseNumberOrNull(b.latitude !== undefined ? b.latitude : kit.latitude);
    const lng = parseNumberOrNull(b.longitude !== undefined ? b.longitude : kit.longitude);
    const coordError = validateCoords(lat, lng);
    if (coordError) return res.status(400).json({ error: coordError });
  }

  if (b.organization_id !== undefined && b.organization_id !== kit.organization_id) {
    if (b.organization_id) {
      const allowed = await requireOrgRole(req.userId, b.organization_id, "admin");
      if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to move kits into it" });
    }
  }

  const sets = [];
  const values = [];
  for (const field of PATCHABLE) {
    if (b[field] === undefined) continue;
    values.push(normalizeField(field, b[field]));
    sets.push(`${field} = $${values.length}`);
  }
  if (b.organization_id !== undefined) {
    values.push(b.organization_id || null);
    sets.push(`organization_id = $${values.length}`);
  }
  if (latProvided) {
    values.push(b.geocode_source === "nominatim" ? "nominatim" : "manual");
    sets.push(`geocode_source = $${values.length}`);
  }
  if (sets.length === 0) return res.json(publicKit(kit));

  values.push(kit.id);
  const { rows } = await pool.query(
    `UPDATE kits SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );

  const dueChanged = b.next_due_at !== undefined && String(b.next_due_at) !== String(kit.next_due_at);
  if (dueChanged) {
    await recordKitEvent(kit.id, {
      kind: "due_date_changed",
      title: "Due date changed",
      detail: `${kit.next_due_at ? new Date(kit.next_due_at).toISOString().slice(0, 10) : "unset"} → ${rows[0].next_due_at ? new Date(rows[0].next_due_at).toISOString().slice(0, 10) : "unset"}`,
      actorUserId: req.userId,
    });
  }
  if (latProvided || b.address !== undefined || b.city !== undefined) {
    await recordKitEvent(kit.id, {
      kind: "location_updated",
      title: "Location updated",
      detail: [rows[0].address, rows[0].city, rows[0].region].filter(Boolean).join(", ") || null,
      actorUserId: req.userId,
    });
  }

  const synced = await resyncBillingState(kit.id, req.userId);
  res.json(publicKit(synced || rows[0]));
});

function normalizeField(field, value) {
  if (["plan_amount", "latitude", "longitude", "grace_days", "expiring_soon_days", "idle_alert_days", "offline_after_min", "billing_cycle_days"].includes(field)) {
    return parseNumberOrNull(value);
  }
  if (field === "alert_after_misses") return Math.max(1, Number(value) || 2);
  if (field === "active") return !!value;
  if (field === "next_due_at") return parseDate(value, field).value;
  if (field === "billing_cycle") return ["monthly", "30_day", "custom"].includes(value) ? value : "monthly";
  if (typeof value === "string") return value.trim() || null;
  return value;
}

router.delete("/:id", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  await pool.query(`DELETE FROM kits WHERE id = $1`, [kit.id]);
  if (kit.organization_id) await logOrgAction(kit.organization_id, req.userId, "kit_deleted", `deleted kit "${kit.name}"`);
  res.status(204).end();
});

// ===================================================================
// Billing actions
// ===================================================================

// Record a payment. This is the single most important write in the app,
// so it does three things atomically-ish and in a deliberate order:
// append to the immutable payment log, move the due date forward, then
// recompute the state from that new date.
//
// The due date is advanced by nextDueAfterPayment(), which anchors to
// the EXISTING due date when that's still ahead - so a client who pays
// four days early keeps those four days instead of silently donating
// them. See kitStatus.js.
router.post("/:id/payments", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const b = req.body || {};

  const paidAt = parseDate(b.paid_at, "payment date");
  if (paidAt.error) return res.status(400).json({ error: paidAt.error });
  const when = paidAt.value || new Date();

  // An explicit covers_until wins over the computed one - the cycle
  // length is a default, not a rule, and part-payments or a client who
  // pays for three months at once are both normal.
  const explicitUntil = parseDate(b.covers_until, "covers until");
  if (explicitUntil.error) return res.status(400).json({ error: explicitUntil.error });
  const nextDue = explicitUntil.value || nextDueAfterPayment(kit, when);

  const amount = parseNumberOrNull(b.amount);

  try {
    const { rows } = await pool.query(
      `INSERT INTO payments (kit_id, recorded_by, paid_at, amount, currency, method, reference, covers_until, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        kit.id,
        req.userId,
        when,
        amount,
        b.currency?.trim() || kit.plan_currency || "NGN",
        b.method?.trim() || null,
        b.reference?.trim() || null,
        nextDue,
        b.note?.trim() || null,
      ]
    );

    await pool.query(
      `UPDATE kits SET last_paid_at = $1, next_due_at = $2, updated_at = now() WHERE id = $3`,
      [when, nextDue, kit.id]
    );

    await recordKitEvent(kit.id, {
      kind: "payment_recorded",
      title: amount ? `Payment recorded: ${kit.plan_currency || ""} ${amount}`.trim() : "Payment recorded",
      detail: `Covers until ${nextDue.toISOString().slice(0, 10)}${b.method ? ` · ${b.method}` : ""}.`,
      data: { amount, method: b.method || null, covers_until: nextDue },
      actorUserId: req.userId,
    });

    const synced = await resyncBillingState(kit.id, req.userId);
    res.status(201).json({ payment: rows[0], kit: publicKit(synced) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to record the payment" });
  }
});

// Deleting a payment is a correction, not an undo: it removes the log
// row but deliberately leaves next_due_at alone. Recomputing the date
// backwards from a deleted payment would be guesswork (there's no record
// of what the date was before it), and quietly moving a client's due date
// backwards is a much worse failure than leaving a date that a human can
// see and edit.
router.delete("/:id/payments/:paymentId", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const { rowCount } = await pool.query(`DELETE FROM payments WHERE id = $1 AND kit_id = $2`, [req.params.paymentId, kit.id]);
  if (rowCount === 0) return res.status(404).json({ error: "payment not found" });
  await recordKitEvent(kit.id, {
    kind: "payment_recorded",
    severity: "low",
    title: "Payment entry removed",
    detail: "The due date was left unchanged - adjust it by hand if it needs correcting.",
    actorUserId: req.userId,
  });
  res.status(204).end();
});

// Cancel / reinstate. Cancellation is the one billing state a human sets
// directly, because it's the one that isn't a function of a date - see
// deriveBillingState() in kitStatus.js, which treats it as terminal and
// refuses to recompute over it.
router.post("/:id/billing-state", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const state = req.body?.state;
  if (!BILLING_STATES.includes(state)) {
    return res.status(400).json({ error: `state has to be one of ${BILLING_STATES.join(", ")}` });
  }
  if (state !== "cancelled" && state !== "active") {
    return res.status(400).json({
      error: "only 'cancelled' and 'active' can be set by hand - expiring soon, grace and suspended are derived from the due date",
    });
  }

  const { rows } = await pool.query(
    `UPDATE kits SET billing_state = $1, cancelled_at = $2, billing_state_changed_at = now(), updated_at = now()
     WHERE id = $3 RETURNING *`,
    [state, state === "cancelled" ? new Date() : null, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "billing_state_changed",
    severity: state === "cancelled" ? "medium" : "info",
    title: state === "cancelled" ? "Service cancelled" : "Service reinstated",
    detail: req.body?.note?.trim() || null,
    data: { from: kit.billing_state, to: state },
    actorUserId: req.userId,
  });

  // Reinstating hands the kit straight back to the derivation rules, so
  // a kit reinstated with a due date three weeks in the past correctly
  // lands in suspended rather than in a fictional 'active'.
  const synced = state === "active" ? await resyncBillingState(kit.id, req.userId) : rows[0];
  res.json(publicKit(synced));
});

// ===================================================================
// Hardware + usage actions
// ===================================================================

// The manual half of the hardware axis - the path that exists precisely
// because most kits will never have an agent. Someone phones in to say
// the dish is dead; this is how that gets into the system.
router.post("/:id/hardware-state", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const state = req.body?.state;
  if (!HARDWARE_STATES.includes(state)) {
    return res.status(400).json({ error: `state has to be one of ${HARDWARE_STATES.join(", ")}` });
  }

  const { rows } = await pool.query(
    `UPDATE kits SET hardware_state = $1, hardware_source = 'manual', hardware_note = $2,
       hardware_state_changed_at = now(),
       -- Reset the alert latch so a kit manually marked back up will
       -- alert again if it goes down later, and clear the miss counter
       -- so an agent-backed kit doesn't flip straight back to offline on
       -- the next sweep off a stale count.
       hardware_alerted_state = NULL, consecutive_misses = 0,
       updated_at = now()
     WHERE id = $3 RETURNING *`,
    [state, req.body?.note?.trim() || null, kit.id]
  );

  await recordKitEvent(kit.id, {
    kind: "hardware_state_changed",
    severity: state === "offline" ? "high" : "info",
    title: `Hardware marked ${state}`,
    detail: req.body?.note?.trim() || null,
    data: { from: kit.hardware_state, to: state, source: "manual" },
    actorUserId: req.userId,
  });

  res.json(publicKit(rows[0]));
});

// "Mark as seen / in use" - the manual half of the usage axis, and the
// reset button for the idle countdown. idle_alerted_at is cleared too,
// so a kit that goes idle again later alerts again rather than being
// suppressed by a months-old timestamp.
router.post("/:id/seen", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const at = parseDate(req.body?.at, "date");
  if (at.error) return res.status(400).json({ error: at.error });
  const when = at.value || new Date();

  const { rows } = await pool.query(
    `UPDATE kits SET last_active_at = $1, idle_alerted_at = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
    [when, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "marked_seen",
    title: "Marked as in use",
    detail: req.body?.note?.trim() || null,
    actorUserId: req.userId,
  });
  res.json(publicKit(rows[0]));
});

router.post("/:id/snooze", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ error: "minutes has to be a positive number" });
  const until = new Date(Date.now() + minutes * 60 * 1000);
  const { rows } = await pool.query(`UPDATE kits SET snoozed_until = $1, updated_at = now() WHERE id = $2 RETURNING *`, [until, kit.id]);
  res.json(publicKit(rows[0]));
});

router.post("/:id/unsnooze", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const { rows } = await pool.query(`UPDATE kits SET snoozed_until = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [kit.id]);
  res.json(publicKit(rows[0]));
});

// ===================================================================
// Agent (phase 2)
// ===================================================================

// Issues (or regenerates) the credential a kit-side agent posts
// heartbeats with. Same shape as api_tokens: the raw value is returned
// exactly once and is unrecoverable afterwards, only the hash is stored.
//
// Regenerating immediately invalidates the old token, which is the point
// - a kit that's been handed to a different client shouldn't keep
// reporting into the previous one's dashboard.
router.post("/:id/agent/token", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const token = `slkit_${crypto.randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, 12);
  await pool.query(
    `UPDATE kits SET agent_token_hash = $1, agent_token_prefix = $2, agent_enabled = true, updated_at = now() WHERE id = $3`,
    [hashToken(token), prefix, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "agent_token_issued",
    title: kit.agent_token_prefix ? "Agent token regenerated" : "Agent token issued",
    detail: kit.agent_token_prefix ? "The previous token stopped working immediately." : null,
    actorUserId: req.userId,
  });
  res.json({ token, prefix });
});

// Turning the agent off leaves the hardware state exactly where it is
// rather than resetting it to 'unknown'. If the last thing the agent saw
// was a dead kit, that's still the most recent real observation anyone
// has - discarding it because the reporting mechanism was switched off
// would be throwing away information, not adding honesty.
router.delete("/:id/agent", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const { rows } = await pool.query(
    `UPDATE kits SET agent_enabled = false, agent_token_hash = NULL, agent_token_prefix = NULL,
       consecutive_misses = 0, updated_at = now() WHERE id = $1 RETURNING *`,
    [kit.id]
  );
  res.json(publicKit(rows[0]));
});

// ===================================================================
// Fleet-level actions
// ===================================================================

// The manual equivalent of the cron tick's billing pass, for someone
// sitting in front of the dashboard who wants the numbers refreshed now.
// Only the billing sweep: hardware and idle are both driven by elapsed
// time and heartbeats, so running them on demand would produce exactly
// the same answer a second earlier.
router.post("/refresh", async (req, res) => {
  const result = await runBillingSweep();
  res.json(result);
});

// Address -> coordinates. Not kit-scoped (it's used while filling in a
// kit that doesn't exist yet) but still behind requireAuth, so this
// deployment's Nominatim quota can't be consumed by anonymous traffic -
// the quota is per-IP, and exhausting it takes the map feature away from
// every user of the instance at once.
router.post("/geocode", async (req, res) => {
  const { address, city, region, country } = req.body || {};
  const result = await geocodeAddress({ address, city, region, country });
  res.json(result);
});

export default router;
