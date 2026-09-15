import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { normalizeNotificationPrefs } from "../lib/notificationPrefs.js";
import { generateSecret, otpauthUrl, verifyTotp, generateBackupCodes } from "../lib/totp.js";
import { sendWebhookAlert } from "../lib/webhook.js";
import { sendAlertEmail } from "../lib/mailer.js";
import { hashToken } from "../lib/apiTokens.js";
import { claimPendingInvites } from "../lib/orgAccess.js";
import { assertPublicHttpUrl } from "../lib/urlSafety.js";

const router = Router();

const ME_COLUMNS = `id, email, alert_email, telegram_chat_id, webhook_url, digest_enabled, digest_sent_at, digest_day_of_week,
  notification_prefs, totp_enabled`;

// The exact field list ME_COLUMNS selects, as plain JS keys - used to
// pick the same public shape out of a row that was already fetched with
// SELECT * (login and 2FA verification both need the full row
// internally, for password_hash/totp_secret/totp_backup_codes), rather
// than either running a second query or hand-listing a few fields and
// forgetting to update that list later. That's exactly what happened
// before this existed: login and 2fa/verify-login each returned a
// hand-picked `{ id, email, alert_email }`, so a fresh login (or a
// fresh signup confirmation) showed 2FA as "not enabled" and every
// toggle as off in Settings - not because they actually were, but
// because the response just never included those fields. GET /me
// happened to be correct the whole time (it already used ME_COLUMNS),
// which is why closing and reopening the app "fixed" it: that's the
// only one of the three that was ever right.
const PUBLIC_USER_FIELDS = [
  "id",
  "email",
  "alert_email",
  "telegram_chat_id",
  "webhook_url",
  "digest_enabled",
  "digest_sent_at",
  "digest_day_of_week",
  "notification_prefs",
  "totp_enabled",
];

function toPublicUser(user) {
  return Object.fromEntries(PUBLIC_USER_FIELDS.map((key) => [key, user[key]]));
}

// Optional lightweight gate so a publicly-deployed instance can't be
// signed up for by strangers. Leave SIGNUP_CODE unset in dev; set it in
// production if the backend URL could plausibly be found by anyone else.
// Signup gets a looser limit than login: it's already gated by
// SIGNUP_CODE on any instance that needs it, and the thing being
// prevented here is bulk account creation rather than password guessing.
//
// Email-verified rather than immediate: nothing is written to the users
// table until the confirmation link is clicked (see pending_signups in
// db.js), specifically so this response can be identical whether or not
// the email already has an account - the old version's 409 "an account
// with that email already exists" directly confirmed which emails were
// registered to anyone willing to try one.
router.post("/signup", authRateLimit({ max: 5, windowMinutes: 60 }), async (req, res) => {
  const { email, password, signup_code, alert_email } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "email and an 8+ character password are required" });
  }
  const normalizedEmail = email.trim().toLowerCase();
  // A pending org invite for this exact email is its own proof of
  // authorization to sign up - someone with admin+ access on an org
  // already vouched for this address specifically, which is a stronger
  // signal than the shared SIGNUP_CODE was ever standing in for. Without
  // this, an invited person has no way to know the site-wide code at
  // all (it's never included in the invite itself, deliberately - see
  // the "why's there no action link" thread), so they'd be stuck at
  // "invalid signup code" despite having a legitimate invite waiting.
  const { rows: pendingInvite } = await pool.query(
    `SELECT 1 FROM organization_members WHERE invited_email = $1 AND user_id IS NULL LIMIT 1`,
    [normalizedEmail]
  );
  const hasInvite = pendingInvite.length > 0;
  if (process.env.SIGNUP_CODE && !hasInvite && signup_code !== process.env.SIGNUP_CODE) {
    // A wrong signup code counts as a failed attempt, otherwise the code
    // itself is brute-forceable at whatever rate the network allows.
    // This check happening before the email-existence branch below is
    // deliberate and safe: the signup code gates *attempting* signup at
    // all, it isn't itself information about any specific email address,
    // so a distinct error here doesn't reintroduce enumeration.
    await req.recordAuthFailure();
    return res.status(403).json({ error: "invalid signup code" });
  }

  // Opportunistic cleanup, same pattern as rateLimit.js's auth_attempts
  // sweep - no background job runner in this app by design, so an old,
  // never-clicked pending signup gets swept during a normal request
  // instead of needing one.
  if (Math.random() < 0.02) {
    pool.query(`DELETE FROM pending_signups WHERE expires_at < now()`).catch(() => {});
  }

  const GENERIC_MESSAGE = "If that email can be used to sign up, a confirmation link is on its way to it. Check your inbox (and spam folder) over the next few minutes.";
  const appUrl = process.env.FRONTEND_URL?.trim();

  const { rows: existingUser } = await pool.query(`SELECT id FROM users WHERE email = $1`, [normalizedEmail]);
  if (existingUser.length > 0) {
    // Never confirms anything to whoever's making this request, but does
    // let the actual account holder know someone tried - the same
    // trade-off a real password-reset flow makes. Awaited (not
    // fire-and-forget) so this branch's latency matches the new-signup
    // branch below rather than responding conspicuously faster, which
    // would itself be a timing side-channel for the exact same
    // enumeration this whole flow exists to close.
    await sendAlertEmail({
      to: normalizedEmail,
      subject: "Someone tried to sign up with your email on Starlink Monitor",
      text: `Someone just tried to create a new Starlink Monitor account using this email address, which already has one. If that was you, log in instead${appUrl ? ` at ${appUrl}` : ""}. If it wasn't you, no action is needed - nothing about your account changed.`,
    }).catch((err) => console.error("signup-collision notice failed:", err.message));
    return res.json({ message: GENERIC_MESSAGE });
  }

  const hash = await bcrypt.hash(password, 12);
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO pending_signups (email, password_hash, alert_email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '24 hours')
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       alert_email = EXCLUDED.alert_email,
       token_hash = EXCLUDED.token_hash,
       expires_at = EXCLUDED.expires_at,
       created_at = now()`,
    [normalizedEmail, hash, alert_email?.trim() || normalizedEmail, hashToken(token)]
  );

  // FRONTEND_URL is required for this to actually work, not optional the
  // way it is for an invite email - there's no other channel to hand the
  // token to whoever's signing up. index.js warns loudly at boot if it's
  // missing, same as SESSION_SECRET/CRON_SECRET.
  const verifyUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/#/verify-email?token=${token}` : null;
  const emailResult = await sendAlertEmail({
    to: normalizedEmail,
    subject: "Confirm your Starlink Monitor account",
    text: verifyUrl
      ? `Confirm your new Starlink Monitor account by opening this link within the next 24 hours: ${verifyUrl}`
      : `Confirm your new Starlink Monitor account with this code (valid 24 hours): ${token}`,
    actionUrl: verifyUrl || undefined,
    actionLabel: "Confirm account",
  });
  // Unlike every other email in this app, this one being sent IS the
  // point of the request - there's no other way for a brand-new signup
  // to get their token, and the response above is deliberately generic
  // either way. A genuine send failure here (Brevo not configured, API
  // error) has nothing to do with whether the email was already
  // registered, so surfacing it honestly instead of the generic message
  // doesn't reopen the enumeration this flow exists to close.
  if (!emailResult.sent) {
    console.error("verification email failed:", emailResult.reason);
    return res.status(502).json({ error: "couldn't send the confirmation email right now - please try again shortly" });
  }
  res.json({ message: GENERIC_MESSAGE });
});

// The other half of the flow above: exchanges a confirmation token for
// the actual account. Nothing meaningfully guessable here (the token is
// 32 random bytes), so this rate limit is about abuse/DoS, not brute
// force.
router.post("/verify-email", authRateLimit({ max: 20, windowMinutes: 60, identifierField: "__none__" }), async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "confirmation token is required" });

  const { rows } = await pool.query(`SELECT * FROM pending_signups WHERE token_hash = $1`, [hashToken(token)]);
  const pending = rows[0];
  if (!pending) return res.status(400).json({ error: "this confirmation link is invalid or has already been used" });
  if (new Date(pending.expires_at) < new Date()) {
    await pool.query(`DELETE FROM pending_signups WHERE id = $1`, [pending.id]);
    return res.status(400).json({ error: "this confirmation link has expired - please sign up again" });
  }

  try {
    const { rows: created } = await pool.query(
      `INSERT INTO users (email, password_hash, alert_email) VALUES ($1, $2, $3)
       RETURNING ${ME_COLUMNS}`,
      [pending.email, pending.password_hash, pending.alert_email]
    );
    await pool.query(`DELETE FROM pending_signups WHERE id = $1`, [pending.id]);
    req.session.userId = created[0].id;
    // Claims any invite sent to this address before the account existed
    // - see claimPendingInvites for why this has to happen exactly here.
    await claimPendingInvites(created[0].id, created[0].email);
    res.status(201).json(created[0]);
  } catch (err) {
    if (err.code === "23505") {
      // The email got a real account through some other path (a race
      // between two confirmations, an admin-created account) in the gap
      // between this pending row being created and confirmed - already
      // extremely unlikely given signup's own email-existence check, but
      // handled honestly rather than surfacing a raw 500.
      await pool.query(`DELETE FROM pending_signups WHERE id = $1`, [pending.id]);
      return res.status(409).json({ error: "an account with that email already exists - try logging in instead" });
    }
    console.error(err);
    res.status(500).json({ error: "failed to confirm account" });
  }
});

router.post("/login", authRateLimit({ max: 8, windowMinutes: 15 }), async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email?.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      // Only failures are counted, so someone logging in successfully all
      // day never trips the limiter (see middleware/rateLimit.js).
      await req.recordAuthFailure();
      // The unauthenticated response is deliberately identical whether
      // the email exists or not - "invalid email or password" rather than
      // "no such account" - so this endpoint can't be used to enumerate
      // which addresses have accounts.
      return res.status(401).json({ error: "invalid email or password" });
    }
    if (user.totp_enabled) {
      // Password is correct but the session isn't authenticated yet - a
      // second, narrower field (pendingTotpUserId) rather than userId,
      // so nothing that checks req.session.userId (i.e. requireAuth)
      // treats this half-logged-in state as an authenticated session.
      req.session.pendingTotpUserId = user.id;
      return res.json({ requires_totp: true });
    }

    req.session.userId = user.id;
    res.json(toPublicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to log in" });
  }
});

// Second step of login for accounts with 2FA enabled. Rate-limited on
// IP alone (there's no email in this request to key a second bucket
// off, the way login's identifierField does) since guessing a 6-digit
// TOTP code is exactly the kind of thing worth throttling.
router.post("/2fa/verify-login", authRateLimit({ max: 8, windowMinutes: 15, identifierField: "__none__" }), async (req, res) => {
  const pendingUserId = req.session.pendingTotpUserId;
  if (!pendingUserId) return res.status(400).json({ error: "no pending login" });

  const { code, backup_code } = req.body;
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [pendingUserId]);
  const user = rows[0];
  if (!user) return res.status(400).json({ error: "no pending login" });

  if (code && verifyTotp(user.totp_secret, code)) {
    req.session.userId = user.id;
    delete req.session.pendingTotpUserId;
    return res.json(toPublicUser(user));
  }

  if (backup_code) {
    const codes = user.totp_backup_codes || [];
    for (let i = 0; i < codes.length; i++) {
      if (await bcrypt.compare(String(backup_code).trim(), codes[i])) {
        // One-time - consumed on use, same as any recovery code.
        const remaining = codes.slice(0, i).concat(codes.slice(i + 1));
        await pool.query(`UPDATE users SET totp_backup_codes = $2 WHERE id = $1`, [user.id, JSON.stringify(remaining)]);
        req.session.userId = user.id;
        delete req.session.pendingTotpUserId;
        return res.json(toPublicUser(user));
      }
    }
  }

  await req.recordAuthFailure();
  res.status(401).json({ error: "invalid code" });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Same rate-limit shape as login (IP bucket, since there's no email in
// the body to key a second bucket off of) - the current-password check
// below is exactly the kind of thing brute-forcing would target.
router.post("/change-password", requireAuth, authRateLimit({ max: 5, windowMinutes: 15 }), async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: "current password and a new 8+ character password are required" });
  }
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
    await req.recordAuthFailure();
    return res.status(401).json({ error: "current password is incorrect" });
  }
  const hash = await bcrypt.hash(new_password, 12);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.userId, hash]);
  // Kicks out every other session for this account - the actual point
  // of changing a password after a suspected compromise is to end
  // whatever session an attacker might be holding, and a session store
  // that doesn't already track user_id per row (connect-pg-simple's
  // default schema doesn't) still has the data to do this: sess is
  // stored as JSON with whatever requireAuth.js put there, and
  // req.session.userId is already the field it checks on every request.
  // The current session (this request's own) is deliberately kept
  // alive - changing your password shouldn't also log out the browser
  // tab you just changed it from.
  await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid != $2`, [req.userId, req.sessionID]);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${ME_COLUMNS} FROM users WHERE id = $1`, [req.userId]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// --- Two-factor auth (TOTP) ---

// Step 1: generate a secret and hand back the otpauth URI + bare secret
// for the user's authenticator app, without touching totp_enabled yet -
// see the totp_pending_secret column comment in db.js for why.
router.post("/2fa/setup", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.userId]);
  const secret = generateSecret();
  await pool.query(`UPDATE users SET totp_pending_secret = $2 WHERE id = $1`, [req.userId, secret]);
  res.json({ secret, otpauth_url: otpauthUrl({ secret, email: rows[0].email }) });
});

// Step 2: confirm setup with a code from the app, which is also proof
// the user actually saved the secret correctly before it becomes the
// thing guarding their login. Returns backup codes once, plaintext -
// same "shown once, unrecoverable after" treatment as an API token.
router.post("/2fa/confirm", requireAuth, async (req, res) => {
  const { code } = req.body;
  const { rows } = await pool.query(`SELECT totp_pending_secret FROM users WHERE id = $1`, [req.userId]);
  const pendingSecret = rows[0]?.totp_pending_secret;
  if (!pendingSecret) return res.status(400).json({ error: "no 2FA setup in progress" });
  if (!verifyTotp(pendingSecret, code)) return res.status(400).json({ error: "invalid code" });

  const backupCodes = generateBackupCodes();
  const hashedCodes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
  await pool.query(
    `UPDATE users SET totp_secret = $2, totp_enabled = true, totp_pending_secret = NULL, totp_backup_codes = $3 WHERE id = $1`,
    [req.userId, pendingSecret, JSON.stringify(hashedCodes)]
  );
  res.json({ ok: true, backup_codes: backupCodes });
});

// Password confirmation required to turn 2FA off, same reasoning as
// requiring the current password to change it - this is exactly the
// kind of downgrade an attacker with a hijacked session would want.
// Password-gated like change-password, and exactly as brute-forceable if
// left unlimited - same rate-limit shape as that route, for the same
// reason. This one matters even more for a hijacked-session attacker
// specifically: if they have a live session but not the actual password
// (stolen cookie rather than stolen credentials), this endpoint is an
// unlimited password oracle unless it's capped the same way login is.
router.post("/2fa/disable", requireAuth, authRateLimit({ max: 5, windowMinutes: 15, identifierField: "__none__" }), async (req, res) => {
  const { password } = req.body;
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
  if (!rows[0] || !(await bcrypt.compare(password || "", rows[0].password_hash))) {
    await req.recordAuthFailure();
    return res.status(401).json({ error: "incorrect password" });
  }
  await pool.query(
    `UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending_secret = NULL, totp_backup_codes = NULL WHERE id = $1`,
    [req.userId]
  );
  res.json({ ok: true });
});

// Fires the same payload shape a real alert would, so a user can
// confirm their URL and receiving side actually work before relying on
// it - matters more here than for push/Telegram, since a webhook is
// user-typed and has no other "ready" signal the way Telegram's
// bot-configured check does.
router.post("/webhook-test", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT webhook_url FROM users WHERE id = $1`, [req.userId]);
  const url = rows[0]?.webhook_url;
  if (!url) return res.status(400).json({ error: "no webhook URL saved" });
  const result = await sendWebhookAlert(url, {
    event: "test",
    severity: "info",
    title: "Starlink Monitor test webhook",
    body: "If you're seeing this, your webhook URL is working.",
  });
  if (!result.sent) return res.status(502).json({ error: result.reason || "webhook send failed" });
  res.json({ ok: true });
});

router.patch("/me", requireAuth, async (req, res) => {
  const { alert_email, telegram_chat_id, webhook_url, digest_enabled, digest_day_of_week, notification_prefs } = req.body;
  if (digest_day_of_week !== undefined && (!Number.isInteger(digest_day_of_week) || digest_day_of_week < 0 || digest_day_of_week > 6)) {
    return res.status(400).json({ error: "digest_day_of_week must be an integer 0 (Sunday) through 6 (Saturday)" });
  }
  // A webhook URL
  // is another way to make this server issue a request wherever it's
  // pointed. sendWebhookAlert() re-checks at send time regardless (DNS
  // can change after this passes), so this is purely for fast feedback
  // on the obvious case rather than the actual enforcement boundary.
  if (webhook_url) {
    try {
      await assertPublicHttpUrl(webhook_url);
    } catch (err) {
      return res.status(400).json({ error: `webhook URL ${err.message}` });
    }
  }
  // Merged against the current row (not just the default shape) so a
  // PATCH that only touches, say, push.down doesn't clobber telegram or
  // webhook prefs the user set in an earlier request.
  let mergedPrefs = undefined;
  if (notification_prefs !== undefined) {
    const { rows: currentRows } = await pool.query(`SELECT notification_prefs FROM users WHERE id = $1`, [req.userId]);
    mergedPrefs = normalizeNotificationPrefs({
      push: { ...currentRows[0]?.notification_prefs?.push, ...notification_prefs?.push },
      telegram: { ...currentRows[0]?.notification_prefs?.telegram, ...notification_prefs?.telegram },
      webhook: { ...currentRows[0]?.notification_prefs?.webhook, ...notification_prefs?.webhook },
    });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
       alert_email = COALESCE($2, alert_email),
       -- Unlike the other fields, an explicit clear (empty string, to
       -- disconnect Telegram) is a real, valid request here - so this
       -- can't just be COALESCE($3, telegram_chat_id), which would be
       -- unable to tell "clear it" apart from "field wasn't in this
       -- request" (both arrive as NULL). $6 carries that distinction
       -- separately instead.
       telegram_chat_id = CASE WHEN $6 THEN $3 ELSE telegram_chat_id END,
       digest_enabled = COALESCE($4, digest_enabled),
       notification_prefs = COALESCE($5, notification_prefs),
       -- webhook_url gets the same "explicit clear is valid" treatment
       -- as telegram_chat_id above, for the same reason - disconnecting
       -- a webhook is a real request, not an absent field.
       webhook_url = CASE WHEN $7 THEN $8 ELSE webhook_url END,
       digest_day_of_week = COALESCE($9, digest_day_of_week)
     WHERE id = $1 RETURNING ${ME_COLUMNS}`,
    [
      req.userId,
      alert_email?.trim() || null,
      telegram_chat_id?.trim() || null,
      digest_enabled === undefined ? null : !!digest_enabled,
      mergedPrefs ? JSON.stringify(mergedPrefs) : null,
      telegram_chat_id !== undefined,
      webhook_url !== undefined,
      webhook_url?.trim() || null,
      digest_day_of_week === undefined ? null : digest_day_of_week,
    ]
  );
  res.json(rows[0]);
});

export default router;
