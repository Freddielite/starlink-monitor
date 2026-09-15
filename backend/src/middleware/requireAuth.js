import { pool } from "../db.js";
import { hashToken } from "../lib/apiTokens.js";

// Two ways in: the browser's session cookie (the original, and still the
// only path the frontend itself uses), or an `Authorization: Bearer
// pulse_...` API token for scripting against Starlink Monitor directly. Session is
// checked first since it's free (already on req, no DB round trip) and is
// what every browser request actually has.
export async function requireAuth(req, res, next) {
  if (req.session?.userId) {
    req.userId = req.session.userId;
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (token) {
    try {
      // Updating last_used_at in the same query as the lookup, rather
      // than a separate write after, so a valid-but-unused-in-months
      // token doesn't need a second round trip just to record that it
      // was used.
      const { rows } = await pool.query(
        `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING user_id`,
        [hashToken(token)]
      );
      if (rows[0]) {
        req.userId = rows[0].user_id;
        return next();
      }
    } catch (err) {
      console.error("Token auth lookup failed:", err.message);
    }
  }

  return res.status(401).json({ error: "not authenticated" });
}
