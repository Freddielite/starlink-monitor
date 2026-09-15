// Membership and role helpers for organizations - the shared-ownership
// layer that sits alongside (not instead of) the single-user model. A
// kit with organization_id NULL is purely personal; these helpers only
// come into play once something has an organization_id set.
//
// Role model, deliberately just three: 'owner' (can delete the org and
// change anyone's role, always at least one per org), 'admin' (can
// invite/remove members, rename/brand the org, set the org's default
// thresholds, add kits under it, and manage - edit/delete/snooze/record
// payments on - any kit the org owns), 'member' (can see every kit the
// org owns and gets alerted for all of them, and can manage only the
// ones they created themselves).
//
// The read/write split matters more here than it did in Pulse, because
// the mutations in this app include recording money changing hands. A
// member seeing that a client is two weeks overdue is the point of being
// on the team; a member being able to mark that client as paid is not.

import { pool } from "../db.js";

const ROLE_RANK = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(role, minimum) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minimum] ?? 99);
}

export async function getUserOrgRole(userId, organizationId) {
  const { rows } = await pool.query(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId]
  );
  return rows[0]?.role || null;
}

export async function requireOrgRole(userId, organizationId, minimum) {
  const role = await getUserOrgRole(userId, organizationId);
  return role !== null && roleAtLeast(role, minimum);
}

export async function logOrgAction(organizationId, actorUserId, action, detail = null) {
  await pool.query(
    `INSERT INTO org_audit_log (organization_id, actor_user_id, action, detail) VALUES ($1, $2, $3, $4)`,
    [organizationId, actorUserId, action, detail]
  );
}

// Every account a given kit should notify: just the creator for a
// personal kit, or every accepted member of the owning org. Every alert
// call site in lib/sweeps.js and lib/digest.js goes through this rather
// than `SELECT * FROM users WHERE id = kit.user_id`, so "the whole team
// hears about the suspension, not just whoever typed the kit in" only
// had to be taught to this one function.
export async function getNotifiableUsers(kit) {
  if (kit.organization_id) {
    const { rows } = await pool.query(
      `SELECT u.* FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 AND om.user_id IS NOT NULL`,
      [kit.organization_id]
    );
    // A kit moved into an org that currently has no accepted members
    // shouldn't happen (creating an org seeds the owner as a member),
    // but falling back to the creator rather than silently notifying
    // nobody is the safer failure mode.
    if (rows.length > 0) return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [kit.user_id]);
  return rows;
}

export async function claimPendingInvites(userId, email) {
  await pool.query(
    `UPDATE organization_members SET user_id = $1, invited_email = NULL
     WHERE invited_email = $2 AND user_id IS NULL`,
    [userId, email]
  );
}
