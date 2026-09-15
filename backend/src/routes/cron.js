import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { runBillingSweep, runHardwareSweep, runIdleSweep, pruneHeartbeats } from "../lib/sweeps.js";
import { runDigestSweep } from "../lib/digest.js";

const router = Router();

const TICK_LOCK_NAME = "tick";
// How long a run's claim on the lock stays valid. Comfortably longer
// than any realistic tick (the sweeps are a handful of queries over a
// few hundred rows) and short enough that a process killed mid-tick -
// Render restarting the service, an OOM - frees things again within one
// cron interval rather than needing a human.
const LEASE_SECONDS = 600;

function requireCronSecret(req, res, next) {
  const provided = req.query.secret || req.headers["x-cron-secret"];
  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "invalid cron secret" });
  }
  next();
}

// One atomic statement. The WHERE on the DO UPDATE is what makes this a
// lock rather than a last-writer-wins upsert: the row is only taken over
// if the existing lease has already expired, so a live holder is never
// displaced. rowCount says which happened - 1 means this run owns the
// lock, 0 means someone else still does.
//
// Nothing here depends on which backend connection runs it, which is the
// entire point - see the cron_locks comment in db.js for what this
// replaced and why.
async function acquireLock(holder) {
  const { rowCount } = await pool.query(
    `INSERT INTO cron_locks (name, held_until, holder)
     VALUES ($1, now() + ($2 || ' seconds')::interval, $3)
     ON CONFLICT (name) DO UPDATE
       SET held_until = EXCLUDED.held_until, holder = EXCLUDED.holder
       WHERE cron_locks.held_until < now()
     RETURNING name`,
    [TICK_LOCK_NAME, LEASE_SECONDS, holder]
  );
  return rowCount === 1;
}

// The holder guard matters: if this run overran its lease and another
// instance has since taken the lock, this must not release theirs.
// Expiring the lease rather than deleting the row keeps the table at
// exactly one row per lock forever.
async function releaseLock(holder) {
  await pool
    .query(`UPDATE cron_locks SET held_until = now() WHERE name = $1 AND holder = $2`, [TICK_LOCK_NAME, holder])
    .catch((err) => console.error("Failed to release the tick lock (it will expire on its own):", err.message));
}

// Everything scheduled in this app happens here, hit by a free external
// scheduler (cron-job.org, a GitHub Actions schedule). There is no
// background job runner, for the same reason Pulse had none: a free-tier
// web service is asleep most of the time and can't be trusted to run an
// in-process timer.
//
// Unlike Pulse this doesn't need to run every few minutes to be correct:
// billing state moves on a scale of days. Every 15 minutes is plenty,
// and the only thing arguing for going faster is heartbeat staleness -
// a kit's offline_after_min can't meaningfully be tighter than the tick
// interval, since nothing notices a missing heartbeat between ticks.
router.all("/tick", requireCronSecret, async (req, res) => {
  // Two ticks overlapping - a slow run meeting the scheduler's next
  // call, or the scheduler retrying because the last response was slow -
  // is the actual cause behind most duplicate alerts. Both runs read the
  // same rows before either has written, so both can independently
  // decide a kit just crossed into grace: two alerts for one transition.
  const holder = crypto.randomUUID();
  const locked = await acquireLock(holder);
  if (!locked) {
    return res.json({ skipped: true, reason: "a previous tick is still running" });
  }

  try {
    const billing = await runBillingSweep();
    const hardware = await runHardwareSweep();
    const idle = await runIdleSweep();
    const digestsSent = await runDigestSweep();
    const heartbeatsPruned = await pruneHeartbeats();

    res.json({ ...billing, ...hardware, ...idle, digestsSent, heartbeatsPruned });
  } finally {
    await releaseLock(holder);
  }
});

export default router;
