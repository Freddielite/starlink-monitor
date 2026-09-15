// Rate limiting for the authentication endpoints.
//
// Starlink Monitor hands clients a report scoring their security posture. It should
// pass its own scan, and until now the login endpoint would happily
// accept unlimited password guesses at whatever rate the network allowed.
// bcrypt with a cost of 12 makes that slow, which is real mitigation, but
// "slow" is not "limited" - and it also means an attacker can pin the
// backend's single free-tier CPU by doing nothing but hammering login.
//
// Deliberately written rather than pulled from express-rate-limit, for
// the same reason lib/telegram.js is a plain fetch instead of a Telegram
// SDK: it's a small amount of obvious code, and the dependency's real
// value is the store adapters, which don't apply here.
//
// Backed by Postgres rather than process memory on purpose. Render's free
// tier stops and restarts the service constantly (it's the whole reason
// this app has a keep-alive feature at all), and an in-memory counter
// resets to zero every time that happens - which is a lockout an attacker
// can simply wait out, and a limiter that's strictest against the honest
// user who just got unlucky with a redeploy.

import { pool } from "../db.js";

// Opportunistic cleanup. There's no background job runner in this app by
// design, so old attempt rows are swept during a normal request instead -
// roughly one request in fifty, so it costs nothing amortized and the
// table can't grow without bound.
const SWEEP_PROBABILITY = 0.02;
const SWEEP_OLDER_THAN_HOURS = 24;

async function sweepOldAttempts() {
  try {
    await pool.query(`DELETE FROM auth_attempts WHERE attempted_at < now() - interval '${SWEEP_OLDER_THAN_HOURS} hours'`);
  } catch {
    // Cleanup failing is not worth failing a request over.
  }
}

function clientIp(req) {
  // trust proxy is set in index.js, so req.ip is the real client address
  // from X-Forwarded-For rather than Render's proxy.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Limits by two independent buckets at once:
 *
 *  - the client IP, which stops one source spraying many accounts
 *  - the submitted identifier (email), which stops a distributed attempt
 *    at one specific account
 *
 * Either bucket hitting its limit refuses the request. Attempts are only
 * recorded when the route says so (see `req.recordAuthFailure`), so a
 * legitimate user logging in successfully ten times in a row is never
 * penalized - only failures count toward the limit.
 */
export function authRateLimit({ max = 8, windowMinutes = 15, identifierField = "email" } = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    if (Math.random() < SWEEP_PROBABILITY) sweepOldAttempts();

    const identifier = String(req.body?.[identifierField] || "").trim().toLowerCase();
    const buckets = [`ip:${clientIp(req)}`];
    if (identifier) buckets.push(`id:${identifier}`);

    try {
      const { rows } = await pool.query(
        `SELECT bucket, COUNT(*)::int AS attempts
         FROM auth_attempts
         WHERE bucket = ANY($1) AND attempted_at > now() - ($2 || ' minutes')::interval
         GROUP BY bucket`,
        [buckets, windowMinutes]
      );

      const blocked = rows.find((row) => row.attempts >= max);
      if (blocked) {
        res.setHeader("Retry-After", String(windowMinutes * 60));
        return res.status(429).json({
          error: `Too many failed attempts. Try again in ${windowMinutes} minutes.`,
        });
      }

      // Handed to the route so only genuine failures are counted. The
      // route calls this; the middleware never assumes an outcome.
      req.recordAuthFailure = async () => {
        try {
          await pool.query(
            `INSERT INTO auth_attempts (bucket, attempted_at)
             SELECT unnest($1::text[]), now()`,
            [buckets]
          );
        } catch (err) {
          console.error("Failed to record auth attempt:", err.message);
        }
      };

      next();
    } catch (err) {
      // A limiter that fails closed would lock everyone out of their own
      // monitoring the moment the database hiccups. Failing open is the
      // right trade here: the limiter is defence in depth on top of
      // bcrypt, not the only thing standing between an attacker and an
      // account.
      console.error("Rate limiter unavailable, allowing request:", err.message);
      req.recordAuthFailure = async () => {};
      next();
    }
  };
}
