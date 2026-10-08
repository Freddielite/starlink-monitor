import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireOrgRole, logOrgAction } from "../lib/orgAccess.js";
import { recordKitEvent } from "../lib/kitEvents.js";
import { runBillingSweep } from "../lib/sweeps.js";
import { geocodeAddress, validateCoords } from "../lib/geocode.js";
import { hashToken } from "../lib/apiTokens.js";
import { parseRow, parseAccountRow, findInternalDuplicates } from "../lib/importKits.js";
import { resyncBillingState, applyPayment, applyMarkSeen, applySnooze } from "../lib/kitActions.js";
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
  "account_email", "account_condition", "outstanding_amount", "outstanding_currency", "overdue_since",
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
  if (["plan_amount", "outstanding_amount", "latitude", "longitude", "grace_days", "expiring_soon_days", "idle_alert_days", "offline_after_min", "billing_cycle_days"].includes(field)) {
    return parseNumberOrNull(value);
  }
  if (field === "alert_after_misses") return Math.max(1, Number(value) || 2);
  if (field === "active") return !!value;
  if (field === "next_due_at" || field === "overdue_since") return parseDate(value, field).value;
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
  const coversUntil = parseDate(b.covers_until, "covers until");
  if (coversUntil.error) return res.status(400).json({ error: coversUntil.error });

  try {
    const result = await applyPayment(
      kit,
      {
        amount: b.amount,
        currency: b.currency,
        method: b.method?.trim() || null,
        reference: b.reference?.trim() || null,
        note: b.note?.trim() || null,
        paid_at: paidAt.value,
        covers_until: coversUntil.value,
      },
      req.userId
    );
    res.status(201).json({ payment: result.payment, kit: publicKit(result.kit) });
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
  const updated = await applyMarkSeen(kit, { at: at.value, note: req.body?.note?.trim() || null }, req.userId);
  res.json(publicKit(updated));
});

router.post("/:id/snooze", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ error: "minutes has to be a positive number" });
  const updated = await applySnooze(kit, minutes, req.userId);
  res.json(publicKit(updated));
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

// Geocode ONE existing kit from its stored address and save the best
// match. Exists for backfilling after an import: bulk geocoding is
// exactly what Nominatim's ~1 req/sec policy forbids, so rather than
// looping server-side inside a single request (which would hold a
// connection open for minutes and die on any timeout), the client walks
// its unlocated kits one at a time and can stop, resume, or skip. The
// throttle in lib/geocode.js still paces it regardless of how fast the
// client asks.
router.post("/:id/geocode", async (req, res) => {
  const kit = await loadKitForMutation(req, res);
  if (!kit) return;
  if (kit.latitude !== null && kit.longitude !== null && !req.body?.overwrite) {
    return res.json({ skipped: true, reason: "this kit already has coordinates" });
  }

  const { results, reason } = await geocodeAddress(kit);
  if (results.length === 0) return res.json({ located: false, reason: reason || "no match for this address" });

  const best = results[0];
  const { rows } = await pool.query(
    `UPDATE kits SET latitude = $1, longitude = $2, geocode_source = 'nominatim', updated_at = now()
     WHERE id = $3 RETURNING *`,
    [best.latitude, best.longitude, kit.id]
  );
  await recordKitEvent(kit.id, {
    kind: "location_updated",
    title: "Located from address",
    // The label is recorded, not just the coordinates, because the whole
    // risk with bulk geocoding informal addresses is a confident match on
    // the wrong place - and "what did it think this was?" is the question
    // you need answered when a pin looks wrong three weeks later.
    detail: `Matched "${best.label}". Worth confirming - this was matched automatically.`,
    data: { label: best.label, latitude: best.latitude, longitude: best.longitude },
    actorUserId: req.userId,
  });
  res.json({ located: true, kit: publicKit(rows[0]), match: best });
});

// ===================================================================
// Spreadsheet import
// ===================================================================

// Rows arrive already parsed into objects by the client (it has the
// file; shipping the raw .xlsx here would mean multipart handling and an
// Excel parser on the server for no gain). Everything that decides what
// actually lands in the database - validation, date interpretation,
// duplicate matching - happens HERE rather than there, because the
// client is not a trustworthy validator and this endpoint is reachable
// without it.
//
// Always runs as a dry run first from the UI: same request with
// dry_run true returns exactly what would happen, row by row, writing
// nothing. The commit then re-parses from scratch rather than trusting
// the preview, so a tampered or stale preview can't smuggle anything in.
router.post("/import", async (req, res) => {
  const {
    rows, mapping, day_first = true, organization_id = null, on_duplicate = "skip",
    skip_invalid = true, dry_run = false,
    // "account_sheet" parses an operator's own Starlink account export
    // (identity is the account email, status is Starlink's vocabulary,
    // amounts carry their own currency); "kits" is the generic
    // one-row-per-kit shape.
    profile = "kits",
  } = req.body || {};
  const accountSheet = profile === "account_sheet";

  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "no rows to import" });
  if (rows.length > 2000) return res.status(400).json({ error: "that's more than 2000 rows - split the file and import in batches" });
  if (accountSheet ? !mapping?.account_email : !mapping?.name) {
    return res.status(400).json({
      error: accountSheet ? "a column has to be mapped to the account email" : "a column has to be mapped to the kit name",
    });
  }
  if (!["skip", "update", "create"].includes(on_duplicate)) return res.status(400).json({ error: "invalid duplicate handling" });

  if (organization_id) {
    const allowed = await requireOrgRole(req.userId, organization_id, "admin");
    if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to import kits into it" });
  }

  const parse = accountSheet ? parseAccountRow : parseRow;
  const parsed = rows.map((row, i) => parse(row, mapping, { dayFirst: day_first, rowNumber: i + 2 }));
  const internalDuplicates = findInternalDuplicates(parsed);

  // Existing kits are matched on service line first (a real identifier,
  // if the sheet has one) and otherwise on name + client, case-
  // insensitively. Scoped to what this user can already see, so an
  // import can never discover or overwrite someone else's kit.
  const { rows: existing } = await pool.query(
    `SELECT id, name, client_name, service_line, account_email FROM kits
     WHERE user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1)`,
    [req.userId]
  );
  const byEmail = new Map();
  const bySer = new Map();
  const byName = new Map();
  for (const k of existing) {
    if (k.account_email) byEmail.set(k.account_email.toLowerCase(), k);
    if (k.service_line) bySer.set(k.service_line.toLowerCase(), k);
    byName.set(`${(k.name || "").toLowerCase()}::${(k.client_name || "").toLowerCase()}`, k);
  }
  // Account email is the strongest identifier available and is checked
  // first: it's what the operator's own records are keyed on, it doesn't
  // change when someone retypes a site name, and it's what makes
  // re-uploading an updated sheet an update rather than 146 duplicates.
  const matchExisting = (kit) =>
    (kit.account_email && byEmail.get(kit.account_email.toLowerCase())) ||
    (kit.service_line && bySer.get(kit.service_line.toLowerCase())) ||
    byName.get(`${(kit.name || "").toLowerCase()}::${(kit.client_name || "").toLowerCase()}`) ||
    null;

  const plan = parsed.map((entry) => {
    if (!entry.ok) return { ...entry, action: "error" };
    const dupeOf = internalDuplicates.find((d) => d.rowNumber === entry.rowNumber);
    if (dupeOf) {
      return { ...entry, action: "skip", reason: `duplicate of row ${dupeOf.firstSeenAt} in this file` };
    }
    const match = matchExisting(entry.kit);
    if (match) {
      if (on_duplicate === "skip") return { ...entry, action: "skip", reason: "a kit with this name/client already exists", existingId: match.id };
      if (on_duplicate === "update") return { ...entry, action: "update", existingId: match.id };
    }
    return { ...entry, action: "create" };
  });

  const summary = {
    total: plan.length,
    create: plan.filter((p) => p.action === "create").length,
    update: plan.filter((p) => p.action === "update").length,
    skip: plan.filter((p) => p.action === "skip").length,
    error: plan.filter((p) => p.action === "error").length,
    warnings: plan.filter((p) => p.warnings.length > 0).length,
  };

  if (dry_run) return res.json({ dry_run: true, summary, rows: plan });
  if (summary.error > 0 && !skip_invalid) {
    return res.status(400).json({ error: `${summary.error} row(s) have problems - fix them or choose to skip invalid rows`, summary, rows: plan });
  }

  // One transaction for the whole file. A half-finished import is worse
  // than none: the user can't tell which rows landed without reading
  // every kit, and re-running would then create duplicates of the half
  // that did.
  const client = await pool.connect();
  const created = [];
  const updated = [];
  try {
    await client.query("BEGIN");
    for (const entry of plan) {
      if (entry.action === "create") {
        const k = entry.kit;
        const { rows: ins } = await client.query(
          `INSERT INTO kits (user_id, organization_id, name, client_name, service_line, kit_serial, hardware_model, notes,
             plan_name, plan_amount, plan_currency, next_due_at, last_paid_at, last_active_at,
             address, city, region, country, latitude, longitude, geocode_source,
             account_email, account_condition, outstanding_amount, outstanding_currency, overdue_since,
             last_payment_amount, last_payment_currency, billing_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
             COALESCE($29,'active')) RETURNING id`,
          [
            req.userId, organization_id, k.name, k.client_name ?? null, k.service_line ?? null, k.kit_serial ?? null,
            k.hardware_model ?? null, k.notes ?? null,
            k.plan_name ?? null, k.plan_amount ?? null, k.plan_currency || k.outstanding_currency || "NGN",
            k.next_due_at ?? null, k.last_paid_at ?? null, k.last_active_at ?? null,
            k.address ?? null, k.city ?? null, k.region ?? null, k.country ?? null, k.latitude ?? null, k.longitude ?? null,
            k.latitude == null ? null : "manual",
            k.account_email ?? null, k.account_condition ?? null,
            k.outstanding_amount ?? null, k.outstanding_currency ?? null, k.overdue_since ?? null,
            k.last_payment_amount ?? null, k.last_payment_currency ?? null,
            k._statusBilling ?? null,
          ]
        );
        created.push(ins[0].id);
      } else if (entry.action === "update") {
        const k = entry.kit;
        // COALESCE on the incoming value, not the stored one: a blank
        // cell in the sheet means "this column wasn't filled in", never
        // "clear what's already there". An import should be able to add
        // information to existing kits without destroying any.
        await client.query(
          `UPDATE kits SET
             client_name = COALESCE($2, client_name), service_line = COALESCE($3, service_line),
             kit_serial = COALESCE($4, kit_serial), hardware_model = COALESCE($5, hardware_model),
             notes = COALESCE($6, notes), plan_amount = COALESCE($7, plan_amount),
             plan_currency = COALESCE($8, plan_currency), next_due_at = COALESCE($9, next_due_at),
             last_paid_at = COALESCE($10, last_paid_at), last_active_at = COALESCE($11, last_active_at),
             address = COALESCE($12, address), city = COALESCE($13, city), region = COALESCE($14, region),
             country = COALESCE($15, country), latitude = COALESCE($16, latitude), longitude = COALESCE($17, longitude),
             plan_name = COALESCE($18, plan_name),
             account_email = COALESCE($19, account_email),
             -- The three below are the moving parts of an operator's
             -- sheet, and they're the reason re-uploading has to be a
             -- real update: a balance that has been cleared, or a
             -- condition that has been resolved, must be able to go back
             -- to empty. COALESCE would pin them at their old value
             -- forever, so a re-import could never record good news.
             account_condition = $20,
             outstanding_amount = $21,
             outstanding_currency = $22,
             overdue_since = COALESCE($23, overdue_since),
             last_payment_amount = COALESCE($24, last_payment_amount),
             last_payment_currency = COALESCE($25, last_payment_currency),
             billing_state = COALESCE($26, billing_state),
             updated_at = now()
           WHERE id = $1`,
          [
            entry.existingId, k.client_name ?? null, k.service_line ?? null, k.kit_serial ?? null, k.hardware_model ?? null,
            k.notes ?? null, k.plan_amount ?? null, k.plan_currency ?? null, k.next_due_at ?? null, k.last_paid_at ?? null,
            k.last_active_at ?? null, k.address ?? null, k.city ?? null, k.region ?? null, k.country ?? null,
            k.latitude ?? null, k.longitude ?? null, k.plan_name ?? null,
            k.account_email ?? null, k.account_condition ?? null,
            k.outstanding_amount ?? null, k.outstanding_currency ?? null, k.overdue_since ?? null,
            k.last_payment_amount ?? null, k.last_payment_currency ?? null, k._statusBilling ?? null,
          ]
        );
        updated.push(entry.existingId);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Import failed:", err.message);
    return res.status(500).json({ error: "the import failed and nothing was changed" });
  } finally {
    client.release();
  }

  // Timeline entries and billing derivation happen after the commit, not
  // inside it. Both are per-kit and non-essential to the import being
  // correct; letting either fail the transaction would mean losing a
  // clean 300-row import over one bad event write. The billing state
  // resync matters because an imported kit with a due date last month
  // should read as Grace or Suspended immediately, not stay Active until
  // the next cron tick.
  // Only kits that actually have a due date get their billing state
  // recomputed. This matters for operator sheets: a suspended account
  // usually has NO next bill date, and deriveBillingState reads a
  // missing due date as 'active' - so resyncing those would quietly
  // flip every suspended kit in the file to Active, which is both wrong
  // and exactly backwards from what the sheet said. Where the sheet
  // asserts a state and gives nothing to derive from, the sheet wins.
  const resyncIfDated = async (id) => {
    const { rows: r } = await pool.query(`SELECT next_due_at FROM kits WHERE id = $1`, [id]);
    if (r[0]?.next_due_at) await resyncBillingState(id, req.userId);
  };
  for (const id of created) {
    await recordKitEvent(id, { kind: "kit_created", title: "Imported from a spreadsheet", actorUserId: req.userId });
    await resyncIfDated(id);
  }
  for (const id of updated) {
    await recordKitEvent(id, { kind: "kit_created", severity: "info", title: "Updated by a spreadsheet import", actorUserId: req.userId });
    await resyncIfDated(id);
  }
  if (organization_id) {
    await logOrgAction(organization_id, req.userId, "kits_imported", `imported ${created.length} kit(s), updated ${updated.length}`);
  }

  res.json({ imported: created.length, updated: updated.length, summary, rows: plan });
});

// ===================================================================
// Bulk actions
// ===================================================================

const BULK_ACTIONS = ["mark_paid", "mark_seen", "snooze", "unsnooze", "set_client", "set_organization", "cancel", "reinstate", "delete"];

// One action across many kits. The alternative - the client looping over
// the single-kit endpoints - would be dozens of round trips, and would
// leave a half-applied selection behind the moment one of them failed
// with no way for the user to tell which.
//
// Permissions are checked per kit rather than once for the batch,
// because a selection can legitimately span personal kits and several
// organizations with different roles in each. Kits the user can't manage
// are reported as refused rather than silently dropped: a bulk action
// that quietly does less than you asked is worse than one that tells you
// it did.
router.post("/bulk", async (req, res) => {
  const { ids, action, payload = {} } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "no kits selected" });
  if (ids.length > 500) return res.status(400).json({ error: "that's more than 500 kits in one go - narrow the selection" });
  if (!BULK_ACTIONS.includes(action)) return res.status(400).json({ error: `action has to be one of ${BULK_ACTIONS.join(", ")}` });

  const { rows: kits } = await pool.query(
    `SELECT * FROM kits WHERE id = ANY($1::uuid[])
       AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
    [ids, req.userId]
  );

  const allowed = [];
  const refused = [];
  for (const kit of kits) {
    const isCreator = kit.user_id === req.userId;
    const isOrgAdmin = kit.organization_id && (await requireOrgRole(req.userId, kit.organization_id, "admin"));
    if (isCreator || isOrgAdmin) allowed.push(kit);
    else refused.push({ id: kit.id, name: kit.name, reason: "you don't have admin access on this kit's organization" });
  }
  // Ids that matched nothing at all - deleted by someone else since the
  // page loaded, or simply not visible to this user.
  const found = new Set(kits.map((k) => k.id));
  for (const id of ids.filter((i) => !found.has(i))) refused.push({ id, reason: "not found" });

  if (action === "set_organization" && payload.organization_id) {
    const ok = await requireOrgRole(req.userId, payload.organization_id, "admin");
    if (!ok) return res.status(403).json({ error: "you need admin access on the organization you're moving kits into" });
  }
  if (action === "snooze") {
    const minutes = Number(payload.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ error: "minutes has to be a positive number" });
  }

  const done = [];
  const failed = [];
  for (const kit of allowed) {
    try {
      switch (action) {
        case "mark_paid": {
          // No amount is passed: applyPayment falls back to each kit's
          // own outstanding balance, then its plan price. A single
          // figure across a mixed selection would be wrong for most of
          // them, and these fleets are billed in several currencies at
          // once.
          const result = await applyPayment(kit, { method: payload.method || null, via: "bulk action" }, req.userId);
          done.push({ id: kit.id, amount: result.amount, currency: result.currency });
          break;
        }
        case "mark_seen":
          await applyMarkSeen(kit, { via: "bulk action" }, req.userId);
          done.push({ id: kit.id });
          break;
        case "snooze":
          await applySnooze(kit, Number(payload.minutes), req.userId, "bulk action");
          done.push({ id: kit.id });
          break;
        case "unsnooze":
          await pool.query(`UPDATE kits SET snoozed_until = NULL, updated_at = now() WHERE id = $1`, [kit.id]);
          done.push({ id: kit.id });
          break;
        case "set_client":
          await pool.query(`UPDATE kits SET client_name = $1, updated_at = now() WHERE id = $2`, [payload.client_name?.trim() || null, kit.id]);
          await recordKitEvent(kit.id, { kind: "kit_created", severity: "info", title: `Client set to ${payload.client_name?.trim() || "none"}`, actorUserId: req.userId });
          done.push({ id: kit.id });
          break;
        case "set_organization":
          await pool.query(`UPDATE kits SET organization_id = $1, updated_at = now() WHERE id = $2`, [payload.organization_id || null, kit.id]);
          done.push({ id: kit.id });
          break;
        case "cancel":
          await pool.query(
            `UPDATE kits SET billing_state = 'cancelled', cancelled_at = now(), billing_state_changed_at = now(), updated_at = now() WHERE id = $1`,
            [kit.id]
          );
          await recordKitEvent(kit.id, { kind: "billing_state_changed", severity: "medium", title: "Service cancelled", actorUserId: req.userId });
          done.push({ id: kit.id });
          break;
        case "reinstate":
          await pool.query(`UPDATE kits SET billing_state = 'active', cancelled_at = NULL, billing_state_changed_at = now(), updated_at = now() WHERE id = $1`, [kit.id]);
          await resyncBillingState(kit.id, req.userId);
          done.push({ id: kit.id });
          break;
        case "delete":
          await pool.query(`DELETE FROM kits WHERE id = $1`, [kit.id]);
          done.push({ id: kit.id });
          break;
      }
    } catch (err) {
      // Per-kit rather than all-or-nothing, unlike the import. An import
      // is one document with one intent; a bulk action is N independent
      // instructions, and rolling back 49 successful payments because
      // the 50th kit hit a problem would be the wrong trade. Every
      // failure is named so the user can retry just those.
      console.error(`Bulk ${action} failed for ${kit.id}:`, err.message);
      failed.push({ id: kit.id, name: kit.name, reason: err.message });
    }
  }

  res.json({ action, done: done.length, results: done, refused, failed });
});

export default router;
