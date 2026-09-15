import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getUserOrgRole, requireOrgRole, logOrgAction } from "../lib/orgAccess.js";
import { sendAlertEmail } from "../lib/mailer.js";
import { sendTelegramMessage, resolveChatId } from "../lib/telegram.js";
import { sendWebhookAlert } from "../lib/webhook.js";

const router = Router();
router.use(requireAuth);

const VALID_ROLES = ["member", "admin"]; // 'owner' is never assigned through the invite/role-change routes - see PATCH /:id/members/:memberId

async function countOwners(organizationId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = $1 AND role = 'owner'`,
    [organizationId]
  );
  return Number(rows[0].n);
}

// Every org the user belongs to (an accepted membership, not a pending
// invite), with their role and a member count so the settings list
// doesn't need a second round-trip per org.
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, om.role,
       (SELECT COUNT(*) FROM organization_members WHERE organization_id = o.id AND user_id IS NOT NULL) AS member_count
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE om.user_id = $1
     ORDER BY o.created_at ASC`,
    [req.userId]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO organizations (name, owner_user_id) VALUES ($1, $2) RETURNING *`,
      [name.trim(), req.userId]
    );
    // The creator is always seeded as the first owner - an org with no
    // members would be unreachable through every other route below,
    // all of which gate on membership.
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [rows[0].id, req.userId]
    );
    await client.query("COMMIT");
    res.status(201).json({ ...rows[0], role: "owner", member_count: 1 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to create organization" });
  } finally {
    client.release();
  }
});

// Full detail: the org row, its members (with email, for display),
// pending invites, and a recent slice of the audit log. Any accepted
// member can view this - it's the "who's on this team and what
// happened" screen, not a management-only one.
router.get("/:id", async (req, res) => {
  const role = await getUserOrgRole(req.userId, req.params.id);
  if (!role) return res.status(404).json({ error: "organization not found" });

  const { rows: orgRows } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [req.params.id]);
  if (orgRows.length === 0) return res.status(404).json({ error: "organization not found" });

  const { rows: members } = await pool.query(
    `SELECT om.id, om.role, om.created_at, u.id AS user_id, u.email
     FROM organization_members om JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = $1 ORDER BY om.created_at ASC`,
    [req.params.id]
  );
  const { rows: pendingInvites } = await pool.query(
    `SELECT id, invited_email, role, created_at FROM organization_members
     WHERE organization_id = $1 AND user_id IS NULL ORDER BY created_at ASC`,
    [req.params.id]
  );
  const { rows: auditLog } = await pool.query(
    `SELECT a.id, a.action, a.detail, a.created_at, u.email AS actor_email
     FROM org_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.organization_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
    [req.params.id]
  );

  res.json({ ...orgRows[0], role, members, pending_invites: pendingInvites, audit_log: auditLog });
});

router.patch("/:id", async (req, res) => {
  const allowed = await requireOrgRole(req.userId, req.params.id, "admin");
  if (!allowed) return res.status(403).json({ error: "admin access required" });
  const {
    name, brand_name, brand_logo_url, brand_accent_color, custom_domain,
    default_grace_days, default_expiring_soon_days, default_idle_alert_days, default_offline_after_min,
  } = req.body;

  // The four org-level defaults for the tracking thresholds (see the
  // column comments in db.js and resolveThresholds in lib/kitStatus.js).
  // Validated rather than trusted: a negative grace period would put
  // every kit permanently in 'suspended' the moment its due date
  // passed, and a zero idle threshold would flag the entire fleet as
  // idle on the next tick. Both are the kind of mistake that's easy to
  // make in a number field and very loud once a sweep runs on it.
  const THRESHOLD_BOUNDS = {
    default_grace_days: [0, 365],
    default_expiring_soon_days: [0, 90],
    default_idle_alert_days: [1, 365],
    default_offline_after_min: [5, 1440],
  };
  const thresholdInput = { default_grace_days, default_expiring_soon_days, default_idle_alert_days, default_offline_after_min };
  for (const [field, [min, max]] of Object.entries(THRESHOLD_BOUNDS)) {
    const value = thresholdInput[field];
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      return res.status(400).json({ error: `${field.replace("default_", "").replace(/_/g, " ")} has to be a whole number between ${min} and ${max}` });
    }
  }
  const { rows } = await pool.query(
    `UPDATE organizations SET
       name = COALESCE($2, name),
       -- Branding fields use the same "explicit clear is valid" CASE
       -- pattern as users.webhook_url in routes/auth.js: unsetting a
       -- logo or custom domain is a real request, not an absent field.
       brand_name = CASE WHEN $3 THEN $4 ELSE brand_name END,
       brand_logo_url = CASE WHEN $5 THEN $6 ELSE brand_logo_url END,
       brand_accent_color = CASE WHEN $7 THEN $8 ELSE brand_accent_color END,
       custom_domain = CASE WHEN $9 THEN $10 ELSE custom_domain END,
       default_grace_days = COALESCE($11, default_grace_days),
       default_expiring_soon_days = COALESCE($12, default_expiring_soon_days),
       default_idle_alert_days = COALESCE($13, default_idle_alert_days),
       default_offline_after_min = COALESCE($14, default_offline_after_min)
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      name?.trim() || null,
      brand_name !== undefined, brand_name?.trim() || null,
      brand_logo_url !== undefined, brand_logo_url?.trim() || null,
      brand_accent_color !== undefined, brand_accent_color?.trim() || null,
      custom_domain !== undefined, custom_domain?.trim() || null,
      default_grace_days === undefined ? null : Number(default_grace_days),
      default_expiring_soon_days === undefined ? null : Number(default_expiring_soon_days),
      default_idle_alert_days === undefined ? null : Number(default_idle_alert_days),
      default_offline_after_min === undefined ? null : Number(default_offline_after_min),
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: "organization not found" });
  await logOrgAction(req.params.id, req.userId, "org_updated", "updated organization settings");
  res.json(rows[0]);
});

// Owner only - deleting the org, not just leaving it. The kits it
// owned aren't destroyed: the ON DELETE SET NULL on
// their organization_id column (see db.js) turns them back into
// ordinary personal items belonging to whoever created each one, rather
// than disappearing.
router.delete("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM organizations WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "organization not found, or you're not its owner" });
  res.json({ ok: true });
});

// Invites by email. If that email already belongs to an account, the
// membership is created immediately; otherwise it's held as a pending
// row (see claimPendingInvites) until someone signs up with that email.
// Either way this never reveals whether the address has an account -
// same response shape for both.
router.post("/:id/invite", async (req, res) => {
  const allowed = await requireOrgRole(req.userId, req.params.id, "admin");
  if (!allowed) return res.status(403).json({ error: "admin access required" });
  const email = req.body.email?.trim().toLowerCase();
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : "member";
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const [{ rows: existingUser }, { rows: orgRows }, { rows: inviterRows }] = await Promise.all([
      pool.query(`SELECT id, telegram_chat_id, webhook_url FROM users WHERE email = $1`, [email]),
      pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT email FROM users WHERE id = $1`, [req.userId]),
    ]);
    const orgName = orgRows[0]?.name || "an organization";
    const inviterEmail = inviterRows[0]?.email || "someone";
    const hasAccount = existingUser.length > 0;

    if (hasAccount) {
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`,
        [req.params.id, existingUser[0].id, role]
      );
    } else {
      await pool.query(
        `INSERT INTO organization_members (organization_id, invited_email, role) VALUES ($1, $2, $3)`,
        [req.params.id, email, role]
      );
    }

    // Membership itself never depended on this succeeding - the row
    // above is already committed either way. Deliberately NOT awaited:
    // this request already timed out once with the email send in the
    // critical path (nodemailer can hang well past the frontend's own
    // 15s request timeout on a slow or misconfigured SMTP server), so
    // the response goes back the moment membership is written and the
    // email fires in the background - a slow or failed send no longer
    // has any way to affect the invite itself. FRONTEND_URL is
    // optional: without it the email just tells the invitee to log into
    // (or sign up for) Starlink Monitor rather than linking a specific URL this
    // backend has no way to know.
    const appUrl = process.env.FRONTEND_URL?.trim();
    const action = hasAccount
      ? `Log in to Starlink Monitor${appUrl ? ` at ${appUrl}` : ""} to see it under Settings > Organizations.`
      : `Sign up at${appUrl ? ` ${appUrl}` : " Starlink Monitor"} with this same email address (${email}) to accept - the invite is waiting for that address specifically.`;
    const title = `${inviterEmail} invited you to ${orgName} on Starlink Monitor`;
    const body = `You've been added as a${role === "admin" ? "n" : ""} ${role}. ${action}`;
    sendAlertEmail({
      to: email,
      subject: title,
      text: `${inviterEmail} added you to "${orgName}" as a${role === "admin" ? "n" : ""} ${role} on Starlink Monitor, a Starlink kit tracking tool. ${action}`,
      // A real button rather than a bare pasted URL - only possible
      // once FRONTEND_URL is set; without it there's no URL to point a
      // button at, so the email falls back to the plain-text
      // instruction above with no link at all, not a broken one.
      actionUrl: appUrl || undefined,
      actionLabel: hasAccount ? "Open Starlink Monitor" : "Sign up to join",
    }).catch((err) => console.error("invite email failed:", err.message));

    // Only possible for someone who already has a Starlink Monitor account - a
    // brand-new invitee has no telegram_chat_id or webhook_url to send
    // to yet, since those are things a person sets up themselves after
    // signing in. Not gated behind wantsNotification(): none of the
    // existing event kinds (down/degraded/contentChanged/expiring/
    // security) actually describes "you were added to a team", and
    // forcing it under one - "security" being the closest fit - would
    // mean someone who muted idle alerts on their kits also
    // never hears about being invited to one, for an unrelated reason.
    // This fires once per invite, not on a recurring cadence, so it
    // isn't the kind of noise those toggles exist to control.
    if (hasAccount) {
      const invitedUser = existingUser[0];
      // Same as every other call site in this app - sendTelegramMessage
      // and sendWebhookAlert already no-op safely on their own (no bot
      // token, no chat id, no saved URL), so this doesn't gate on those
      // being present first; doing so here would also incorrectly skip
      // a deployment-wide TELEGRAM_CHAT_ID (see resolveChatId) just
      // because this particular user never set their own.
      sendTelegramMessage({ chatId: resolveChatId(invitedUser), text: `👋 ${title}\n${body}` }).catch((err) =>
        console.error("invite telegram notify failed:", err.message)
      );
      sendWebhookAlert(invitedUser.webhook_url, { event: "org_invite", severity: "info", title, body }).catch((err) =>
        console.error("invite webhook notify failed:", err.message)
      );
    }

    await logOrgAction(req.params.id, req.userId, "member_invited", `invited ${email} as ${role}`);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "already a member or already invited" });
    console.error(err);
    res.status(500).json({ error: "failed to send invite" });
  }
});

// Role changes are owner-only, and can't strand an org without one -
// the same guard DELETE below uses.
router.patch("/:id/members/:memberId", async (req, res) => {
  const allowed = await requireOrgRole(req.userId, req.params.id, "owner");
  if (!allowed) return res.status(403).json({ error: "only an owner can change roles" });
  const role = req.body.role;
  if (!["member", "admin", "owner"].includes(role)) return res.status(400).json({ error: "invalid role" });

  const { rows: target } = await pool.query(
    `SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2`,
    [req.params.memberId, req.params.id]
  );
  if (target.length === 0) return res.status(404).json({ error: "member not found" });
  if (target[0].role === "owner" && role !== "owner" && (await countOwners(req.params.id)) <= 1) {
    return res.status(400).json({ error: "an organization needs at least one owner - promote someone else first" });
  }

  const { rows } = await pool.query(
    `UPDATE organization_members SET role = $2 WHERE id = $1 RETURNING *`,
    [req.params.memberId, role]
  );
  await logOrgAction(req.params.id, req.userId, "role_changed", `changed a member's role to ${role}`);
  res.json(rows[0]);
});

// Removes a member (admin+ acting on someone else) or lets a member
// remove themselves regardless of role - either way, blocked if it
// would leave the org with zero owners.
router.delete("/:id/members/:memberId", async (req, res) => {
  const { rows: target } = await pool.query(
    `SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2`,
    [req.params.memberId, req.params.id]
  );
  if (target.length === 0) return res.status(404).json({ error: "member not found" });

  const isSelf = target[0].user_id === req.userId;
  if (!isSelf) {
    // Removing an owner is at least as sensitive as changing anyone's
    // role to/from owner (see PATCH above, which requires owner for
    // that) - "admin" here would otherwise let a lower-ranked admin
    // unilaterally kick out a higher-ranked owner as long as a second
    // owner exists to dodge the zero-owner guard below. The required
    // rank scales with the target's own rank instead of being a flat
    // "admin+" check.
    const required = target[0].role === "owner" ? "owner" : "admin";
    const allowed = await requireOrgRole(req.userId, req.params.id, required);
    if (!allowed) return res.status(403).json({ error: `${required} access required` });
  }
  if (target[0].role === "owner" && (await countOwners(req.params.id)) <= 1) {
    return res.status(400).json({ error: "an organization needs at least one owner - promote someone else first" });
  }

  await pool.query(`DELETE FROM organization_members WHERE id = $1`, [req.params.memberId]);
  await logOrgAction(req.params.id, req.userId, isSelf ? "member_left" : "member_removed", target[0].invited_email || undefined);
  res.json({ ok: true });
});

export default router;
