#!/usr/bin/env node
// Starlink Monitor - kit-side agent (phase 2, optional)
//
// Runs on a machine on the SAME network as the Starlink router, reads the
// dish's local diagnostic endpoint, and posts what it finds to the
// backend as a heartbeat. Nothing else in this app depends on it: a kit
// with no agent simply keeps its hardware state at whatever a human last
// set, which is the normal case.
//
// Usage:
//   SLM_API=https://your-backend.onrender.com/api \
//   SLM_TOKEN=slkit_xxxxxxxxxxxx \
//   node starlink-agent.js
//
// Run it under whatever keeps things alive on that box - systemd, pm2,
// a cron entry every few minutes, Task Scheduler. Set the interval
// shorter than the kit's "offline after" threshold in the dashboard,
// or it will report itself down between runs.
//
// ---------------------------------------------------------------------
// About the local API, stated plainly because it matters for whoever
// maintains this:
//
// The dish exposes a gRPC service on 192.168.100.1:9200. It is
// UNDOCUMENTED and SpaceX changes it between firmware releases without
// notice - field names move, the reflection API gets restricted, whole
// methods disappear. Nothing here should be treated as a stable
// contract.
//
// So this script is deliberately built to degrade rather than break:
// - Every field it reports is optional. A heartbeat that arrives with
//   NO metrics at all is still a useful heartbeat - it proves something
//   on that network is alive and talking, which is most of what the
//   hardware axis is asking.
// - Anything it can't parse is dropped, not guessed at.
// - If the dish is unreachable but the agent itself is fine, it sends
//   nothing rather than sending a fabricated "all good". Silence is
//   what the backend's staleness sweep is for, and a lie here would
//   defeat the entire point of the axis.
//
// The reachability probe below (a plain TCP connect to the gRPC port)
// is the portable part - it needs no dependencies and no knowledge of
// the wire format. Pulling real throughput/obstruction numbers needs a
// gRPC client; see readDishStats() for where to add one.
// ---------------------------------------------------------------------

import net from "node:net";

const API = (process.env.SLM_API || "").replace(/\/$/, "");
const TOKEN = process.env.SLM_TOKEN;
const DISH_HOST = process.env.SLM_DISH_HOST || "192.168.100.1";
const DISH_PORT = Number(process.env.SLM_DISH_PORT || 9200);
const PROBE_TIMEOUT_MS = 5000;

if (!API || !TOKEN) {
  console.error("Set SLM_API and SLM_TOKEN. Get the token from the kit's page in the dashboard.");
  process.exit(1);
}

// Plain TCP connect. Answers exactly one question - "is the dish
// reachable from here right now" - with no dependency on the gRPC
// schema, so this keeps working across firmware changes that break
// everything else.
function probeDish() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(DISH_PORT, DISH_HOST);
  });
}

// Where richer metrics go. Left as a stub on purpose rather than shipped
// half-working: it needs a gRPC client (@grpc/grpc-js plus reflection,
// or one of the community-maintained protobuf definitions), and which
// of those works depends on the firmware on the dish in front of you.
//
// Return any subset of { obstruction_pct, downlink_mbps, uplink_mbps,
// ping_ms, uptime_sec }; anything else in the object is stored verbatim
// on the heartbeat for later reference. Returning {} is fine and is the
// default.
//
// Note the backend only advances a kit's "last active" timestamp when a
// heartbeat reports real throughput - so until this is filled in, the
// usage axis stays driven by the manual "mark as seen" button. That's a
// deliberate trade: inferring use from mere reachability would mark
// every powered-on dish in a locked office as actively used, which is
// the exact situation the idle alert exists to catch.
async function readDishStats() {
  return {};
}

async function sendHeartbeat(payload) {
  const response = await fetch(`${API}/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`heartbeat rejected (${response.status}) ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function main() {
  const reachable = await probeDish();
  if (!reachable) {
    // No heartbeat sent. The backend's staleness sweep will notice the
    // gap and - after the kit's configured number of missed windows -
    // mark it offline. Reporting "down" from here instead would mean
    // this script's own view of the network became the source of
    // truth, which it shouldn't be: this agent can't tell "the dish is
    // dead" apart from "the switch between me and the dish is dead".
    console.error(`Dish not reachable at ${DISH_HOST}:${DISH_PORT} - sending nothing.`);
    process.exit(2);
  }

  let stats = {};
  try {
    stats = (await readDishStats()) || {};
  } catch (err) {
    // A failed metrics read must not cost the heartbeat itself. The
    // reachability fact is the valuable part and it's already known.
    console.error("Couldn't read dish stats, sending a bare heartbeat:", err.message);
  }

  const result = await sendHeartbeat({ ...stats, agent_version: "1.0", probed_at: new Date().toISOString() });
  console.log(`Heartbeat accepted${result.recovered ? " (kit was marked offline, now recovered)" : ""}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
