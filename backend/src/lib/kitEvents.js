import { pool } from "../db.js";

// One writer for the kit_events timeline, used by both the routes (a
// person did something) and the sweeps (the clock did something). Kept
// separate from the sweeps so that importing "record what happened"
// doesn't drag in the whole alerting stack - routes/kits.js records
// plenty of events that don't alert anyone.
//
// actorUserId is NULL for anything a sweep decided on its own, which is
// exactly how the UI tells "Ade marked this suspended" apart from "this
// went suspended because the grace period ran out".
export async function recordKitEvent(kitId, { kind, severity = "info", title, detail = null, data = null, actorUserId = null }) {
  try {
    await pool.query(
      `INSERT INTO kit_events (kit_id, kind, severity, title, detail, data, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [kitId, kind, severity, title, detail, data ? JSON.stringify(data) : null, actorUserId]
    );
  } catch (err) {
    // A timeline write failing should never take down the action it was
    // describing - losing the audit line for a payment is bad, losing
    // the payment is worse.
    console.error("Failed to record kit event:", err.message);
  }
}
