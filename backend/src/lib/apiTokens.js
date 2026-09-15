import crypto from "node:crypto";

// Prefixed so a leaked token is instantly recognizable as a Starlink Monitor
// credential in a log or a git history scan, the same reasoning GitHub /
// Stripe / etc. prefix theirs.
const TOKEN_PREFIX = "slm_";

export function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
}

// Only this hash is ever stored - see api_tokens.token_hash in db.js.
// sha256 is fine here (unlike a password hash, this doesn't need to be
// slow): the input is already a long, high-entropy random value, not
// something guessable that benefits from a deliberately expensive hash.
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
