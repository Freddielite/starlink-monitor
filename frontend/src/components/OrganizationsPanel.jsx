import { useEffect, useState } from "react";
import {
  listOrganizations,
  createOrganization,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  inviteOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
} from "../api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import Dropdown from "./Dropdown.jsx";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" };

// There's no file-storage backend for this app (no S3/Cloudinary, and
// Render's own disk isn't persistent across deploys anyway) - so rather
// than build one just for org logos, the image is downscaled and
// re-encoded client-side into a small data: URL, which is stored
// directly in the same organizations.brand_logo_url TEXT column a
// pasted hosted URL would have gone into. Nothing downstream (the
// public status page, the share view) needed to change to support this
// - an <img src> doesn't care whether the URL scheme is https: or
// data:. Capped at 200px on the long side, which keeps a typical logo's
// encoded size in the tens of KB - small enough that it isn't a
// meaningful hit to the public pages that load it on every view.
const MAX_LOGO_DIMENSION = 200;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // guards against hanging the canvas on something absurd, not a real quality bar

function resizeImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      reject(new Error("That image is too large - try one under 8MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That doesn't look like a valid image."));
      img.onload = () => {
        const scale = Math.min(1, MAX_LOGO_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // PNG rather than JPEG - logos are usually flat graphics (often
        // with transparency), where PNG stays small and JPEG's
        // artifacting actually looks worse than on a photo.
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// One org's expanded management view - members, pending invites,
// branding, and a recent audit log slice. Fetched lazily (only once
// this org is expanded) since the list view alone doesn't need any of
// this detail.
function OrgDetail({ orgId, myRole, onChanged, toast }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [brandLogoUrl, setBrandLogoUrl] = useState("");
  const [brandAccentColor, setBrandAccentColor] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [savingBrand, setSavingBrand] = useState(false);
  // Org-level defaults for the three tracking axes. Held as strings so
  // the inputs stay controlled while someone is mid-edit (a bare "" is
  // not a valid number and would otherwise bounce back to the saved
  // value on every keystroke).
  const [defaults, setDefaults] = useState({ grace: "", expiring: "", idle: "", offline: "" });
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);

  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  async function load() {
    setLoading(true);
    try {
      const result = await getOrganization(orgId);
      setDetail(result);
      setBrandName(result.brand_name || "");
      setBrandLogoUrl(result.brand_logo_url || "");
      setBrandAccentColor(result.brand_accent_color || "");
      setCustomDomain(result.custom_domain || "");
      setDefaults({
        grace: String(result.default_grace_days ?? ""),
        expiring: String(result.default_expiring_soon_days ?? ""),
        idle: String(result.default_idle_alert_days ?? ""),
        offline: String(result.default_offline_after_min ?? ""),
      });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function handleInvite(e) {
    e.preventDefault();
    setInviteBusy(true);
    try {
      await inviteOrgMember(orgId, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      toast("Invite sent.");
      await load();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(memberId, role) {
    try {
      await updateOrgMemberRole(orgId, memberId, role);
      await load();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const [removingId, setRemovingId] = useState(null);

  async function handleRemove(memberId) {
    setRemovingId(memberId);
    try {
      await removeOrgMember(orgId, memberId);
      toast("Removed.");
      await load();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setRemovingId(null);
    }
  }

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allows re-selecting the same file later (e.g. after cropping it) without a no-op change event
    if (!file) return;
    setLogoBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setBrandLogoUrl(dataUrl);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLogoBusy(false);
    }
  }

  async function handleSaveBranding(e) {
    e.preventDefault();
    setSavingBrand(true);
    try {
      await updateOrganization(orgId, {
        brand_name: brandName.trim(),
        brand_logo_url: brandLogoUrl.trim(),
        brand_accent_color: brandAccentColor.trim(),
        custom_domain: customDomain.trim(),
      });
      toast("Branding saved.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingBrand(false);
    }
  }

  async function handleSaveDefaults(e) {
    e.preventDefault();
    setSavingDefaults(true);
    try {
      await updateOrganization(orgId, {
        default_grace_days: Number(defaults.grace),
        default_expiring_soon_days: Number(defaults.expiring),
        default_idle_alert_days: Number(defaults.idle),
        default_offline_after_min: Number(defaults.offline),
      });
      toast("Defaults saved. Kits without their own override pick these up on the next sweep.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingDefaults(false);
    }
  }

  async function handleDelete() {
    setDeletingOrg(true);
    try {
      await deleteOrganization(orgId);
      toast("Organization deleted. Its kits are now personal again.");
      onChanged();
    } catch (err) {
      setDeletingOrg(false);
      toast(err.message, "error");
    }
  }

  if (loading) return <div style={{ padding: 12, fontSize: 12.5, color: "var(--ink-dim)" }}>Loading...</div>;
  if (!detail) return null;

  return (
    <div style={{ paddingTop: 12, borderTop: "1px solid var(--panel-border)", marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="sl-settings-row__title" style={{ marginBottom: 8 }}>Members</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {detail.members.map((m) => (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                {isOwner && m.role !== "owner" ? (
                  <div style={{ width: 116 }}>
                    <Dropdown
                      value={m.role}
                      onChange={(role) => handleRoleChange(m.id, role)}
                      options={[
                        { value: "member", label: "Member" },
                        { value: "admin", label: "Admin" },
                        { value: "owner", label: "Owner" },
                      ]}
                    />
                  </div>
                ) : (
                  <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>{ROLE_LABEL[m.role]}</span>
                )}
                {canManage && (
                  <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => handleRemove(m.id)} disabled={removingId === m.id}>
                    {removingId === m.id ? "Removing..." : "Remove"}
                  </button>
                )}
              </div>
            </div>
          ))}
          {detail.pending_invites.map((inv) => (
            <div key={inv.id} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--ink-dim)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.invited_email} (invited, not yet joined)</span>
              {canManage && (
                <button className="sl-btn sl-btn--ghost sl-btn--sm" style={{ alignSelf: "flex-end" }} onClick={() => handleRemove(inv.id)} disabled={removingId === inv.id}>
                  {removingId === inv.id ? "Canceling..." : "Cancel"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {canManage && (
        <form onSubmit={handleInvite} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div className="sl-field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Invite by email</label>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
          </div>
          <div style={{ width: 130 }}>
            <Dropdown
              value={inviteRole}
              onChange={setInviteRole}
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </div>
          <button className="sl-btn sl-btn--sm" type="submit" disabled={inviteBusy}>
            {inviteBusy ? "Sending..." : "Invite"}
          </button>
        </form>
      )}

      {canManage && (
        <form onSubmit={handleSaveDefaults} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="sl-settings-row__title">Default thresholds</div>
          <div className="sl-settings-row__desc" style={{ marginTop: -4 }}>
            Applied to every kit this org owns that doesn't set its own. Grace in particular is yours to decide -
            Starlink doesn't publish one, so it's whatever leeway you actually give a client before you treat the
            service as suspended.
          </div>
          <div className="sl-form-row">
            <label className="sl-field" style={{ marginBottom: 0 }}>
              <span className="sl-field__label">Expiring soon (days before due)</span>
              <input type="number" value={defaults.expiring} onChange={(e) => setDefaults((d) => ({ ...d, expiring: e.target.value }))} />
            </label>
            <label className="sl-field" style={{ marginBottom: 0 }}>
              <span className="sl-field__label">Grace period (days after due)</span>
              <input type="number" value={defaults.grace} onChange={(e) => setDefaults((d) => ({ ...d, grace: e.target.value }))} />
            </label>
            <label className="sl-field" style={{ marginBottom: 0 }}>
              <span className="sl-field__label">Idle alert after (days)</span>
              <input type="number" value={defaults.idle} onChange={(e) => setDefaults((d) => ({ ...d, idle: e.target.value }))} />
            </label>
            <label className="sl-field" style={{ marginBottom: 0 }}>
              <span className="sl-field__label">Offline after (minutes)</span>
              <input type="number" value={defaults.offline} onChange={(e) => setDefaults((d) => ({ ...d, offline: e.target.value }))} />
            </label>
          </div>
          <button className="sl-btn sl-btn--sm" type="submit" disabled={savingDefaults} style={{ alignSelf: "flex-start" }}>
            {savingDefaults ? "Saving..." : "Save defaults"}
          </button>
        </form>
      )}

      {canManage && (
        <form onSubmit={handleSaveBranding} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="sl-settings-row__title">White-label branding</div>
          <div className="sl-settings-row__desc" style={{ marginTop: -4 }}>
            Kept for client-facing reports. A custom domain still needs a CNAME pointed at this app on your end - this
            field is a reminder of what to set up, not an automatic redirect.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div className="sl-field" style={{ marginBottom: 0 }}>
              <label>Brand name</label>
              <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Acme Client Reports" />
            </div>
            <div className="sl-field" style={{ marginBottom: 0 }}>
              <label>Accent color</label>
              <input value={brandAccentColor} onChange={(e) => setBrandAccentColor(e.target.value)} placeholder="#3ddc84" />
            </div>
            <div className="sl-field" style={{ marginBottom: 0 }}>
              <label>Logo</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {brandLogoUrl && (
                  <img
                    src={brandLogoUrl}
                    alt=""
                    width={32}
                    height={32}
                    style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0, background: "#fff" }}
                  />
                )}
                <input
                  value={brandLogoUrl}
                  onChange={(e) => setBrandLogoUrl(e.target.value)}
                  placeholder="https://... or upload below"
                  style={{ flex: 1 }}
                />
              </div>
              <label className="sl-btn sl-btn--ghost sl-btn--sm" style={{ marginTop: 6, display: "inline-block", cursor: "pointer" }}>
                {logoBusy ? "Processing..." : "Upload image"}
                <input type="file" accept="image/*" onChange={handleLogoFile} disabled={logoBusy} style={{ display: "none" }} />
              </label>
            </div>
            <div className="sl-field" style={{ marginBottom: 0 }}>
              <label>Custom domain</label>
              <input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="status.acme.com" />
            </div>
          </div>
          <button className="sl-btn sl-btn--sm" type="submit" disabled={savingBrand} style={{ alignSelf: "flex-start" }}>
            {savingBrand ? "Saving..." : "Save branding"}
          </button>
        </form>
      )}

      <div>
        <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => setShowAuditLog((v) => !v)}>
          {showAuditLog ? "Hide" : "Show"} audit log
        </button>
        {showAuditLog && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--ink-dim)" }}>
            {detail.audit_log.length === 0 && <div>Nothing logged yet.</div>}
            {detail.audit_log.map((entry) => (
              <div key={entry.id}>
                {new Date(entry.created_at).toLocaleString()} - {entry.actor_email || "someone"} {entry.action.replace(/_/g, " ")}
                {entry.detail ? ` (${entry.detail})` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {isOwner && (
        <div>
          <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => setConfirmingDelete(true)}>
            Delete organization
          </button>
          <ConfirmDialog
            open={confirmingDelete}
            title="Delete this organization?"
            body="Its kits aren't deleted - they become personal to whoever created each one. Membership and the audit log are gone for good."
            confirmLabel={deletingOrg ? "Deleting..." : "Delete organization"}
            busy={deletingOrg}
            onConfirm={handleDelete}
            onCancel={() => setConfirmingDelete(false)}
          />
        </div>
      )}
    </div>
  );
}

export default function OrganizationsPanel({ toast }) {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const result = await listOrganizations();
      setOrgs(result);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const org = await createOrganization(newOrgName.trim());
      setNewOrgName("");
      await load();
      setExpandedId(org.id);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="sl-panel">
      <div className="sl-settings-row__desc" style={{ marginBottom: 12 }}>
        Share kits with a team. Everyone in an organization is alerted for its kits, not
        just whoever created them.
      </div>

      {!loading && orgs.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--ink-dim)", marginBottom: 12 }}>No organizations yet.</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
        {orgs.map((org) => (
          <div key={org.id} style={{ borderRadius: 8, background: "var(--bg)", padding: 10 }}>
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => setExpandedId((id) => (id === org.id ? null : org.id))}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{org.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
                  {ROLE_LABEL[org.role]} - {org.member_count} member{Number(org.member_count) === 1 ? "" : "s"}
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>{expandedId === org.id ? "Hide" : "Manage"}</span>
            </div>
            {expandedId === org.id && <OrgDetail orgId={org.id} myRole={org.role} onChanged={load} toast={toast} />}
          </div>
        ))}
      </div>

      <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div className="sl-field" style={{ flex: 1, marginBottom: 0 }}>
          <label>New organization name</label>
          <input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Acme Agency" required />
        </div>
        <button className="sl-btn sl-btn--sm" type="submit" disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </button>
      </form>
    </div>
  );
}
