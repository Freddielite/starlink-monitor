import { Router } from "express";
import { pool } from "../db.js";
import { hashToken } from "../lib/apiTokens.js";
import { recordHeartbeat } from "../lib/sweeps.js";

const router = Router();

// Phase 2: the endpoint a kit-side agent posts to.
//
// This sits outside requireAuth on purpose - the caller is a small script
// on a client's network, not a browser session, and it authenticates with
// its own per-kit token rather than a user account. That token maps to
// exactly one kit and can do exactly one thing: report that kit's status.
// It can't read the kit, can't read anything else, and can't be used
// against the rest of the API. That containment is the whole reason it's
// a separate credential rather than an api_token with a user's full
// permissions sitting on a machine in someone else's office.
//
// What the agent is expected to do on its side (not implemented here -
// it's a separate ~50-line script that ships to the kit's network):
// read Starlink's local diagnostic endpoint on 192.168.100.1, pull
// obstruction / throughput / ping / uptime out of it, and POST them here
// on a timer. That local API is undocumented and unstable across
// firmware versions, which is why the payload below is almost entirely
// optional and anything unrecognised is kept verbatim in heartbeats.raw
// rather than being validated against a schema that would break on the
// next update.

function bearer(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  // Some minimal agent setups (a cron + curl one-liner) find a header
  // awkward; a query parameter is accepted as a fallback for the same
  // reason the cron tick accepts ?secret=.
  return req.query.token || null;
}

router.post("/heartbeat", async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "missing agent token" });

  const { rows } = await pool.query(
    `SELECT * FROM kits WHERE agent_token_hash = $1 AND agent_enabled = true`,
    [hashToken(token)]
  );
  const kit = rows[0];
  // Same response for "no such token" and "agent disabled" - there's
  // nothing useful for the agent to do differently, and distinguishing
  // them would confirm to anyone probing that a given token was once
  // real.
  if (!kit) return res.status(401).json({ error: "invalid agent token" });

  try {
    const result = await recordHeartbeat(kit, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Heartbeat failed:", err.message);
    res.status(500).json({ error: "failed to record heartbeat" });
  }
});

export default router;
