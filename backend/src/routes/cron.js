import { Router } from "express";
import { pool } from "../db.js";
import { runBillingSweep, runHardwareSweep, runIdleSweep, pruneHeartbeats } from "../lib/sweeps.js";
import { runDigestSweep } from "../lib/digest.js";

const router = Router();

// Postgres advisory lock key for the tick endpoint. Arbitrary constant -
// its only job is to be a number nothing else in this app uses.
const TICK_LOCK_KEY = 814402;

function requireCronSecret(req, res, next) {
  const provided = req.query.secret || req.headers["x-cron-secret"];
  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "invalid cron secret" });
  }
  next();
}

// Everything scheduled in this app happens here, hit by an external free
// scheduler (cron-job.org, a GitHub Actions schedule, whatever) - there
// is no background job runner, for the same reason Pulse had none: a
// free-tier web service is asleep most of the time and can't be trusted
// to run an in-process timer.
//
// Unlike Pulse this doesn't need to run every few minutes to be correct:
// billing state moves on a scale of days. Every 15 minutes is plenty,
// and the only thing that argues for going faster is heartbeat staleness
// detection - offline_after_min can't meaningfully be tighter than the
// tick interval, since nothing notices a missing heartbeat between
// ticks.
router.all("/tick", requireCronSecret, async (req, res) => {
  // A tick still running when the next one fires would let two passes
  // read the same pre-update rows and each independently decide a kit
  // just crossed into grace - two alerts for one transition. A
  // session-scoped advisory lock on one held connection makes that
  // impossible across process restarts and multiple instances, not just
  // within one process, and Postgres drops it automatically if the
  // connection dies mid-request so a crashed tick can't wedge it.
  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [TICK_LOCK_KEY]);
    if (!lockRows[0].locked) {
      return res.json({ skipped: true, reason: "a previous tick is still running" });
    }

    const billing = await runBillingSweep();
    const hardware = await runHardwareSweep();
    const idle = await runIdleSweep();
    const digestsSent = await runDigestSweep();
    const heartbeatsPruned = await pruneHeartbeats();

    res.json({ ...billing, ...hardware, ...idle, digestsSent, heartbeatsPruned });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [TICK_LOCK_KEY]).catch(() => {});
    client.release();
  }
});

export default router;
