import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import Dropdown from "./Dropdown.jsx";
import KitForm from "./KitForm.jsx";
import { FleetMap } from "./FleetMap.jsx";
import {
  getKitEvents,
  listPayments,
  recordPayment,
  deletePayment,
  setBillingState,
  setHardwareState,
  markSeen,
  snoozeKit,
  unsnoozeKit,
  deleteKit,
  issueAgentToken,
  disableAgent,
  listOrganizations,
  getKitHeartbeats,
} from "../api.js";
import {
  BILLING_LABELS,
  BILLING_COLORS,
  HARDWARE_LABELS,
  HARDWARE_COLORS,
  dueLabel,
  idleLabel,
  idleDays,
  isIdle,
  isSnoozed,
  timeAgo,
  timeUntil,
  money,
  dateOnly,
} from "../lib/kitDisplay.js";

const SNOOZE_OPTIONS = [
  { label: "1 day", minutes: 1440 },
  { label: "3 days", minutes: 4320 },
  { label: "1 week", minutes: 10080 },
];

export default function KitDetail({ kit, currentUser, onBack, onChanged, toast }) {
  const [payments, setPayments] = useState([]);
  const [events, setEvents] = useState([]);
  const [heartbeats, setHeartbeats] = useState([]);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentToken, setAgentToken] = useState(null);
  const [canManage, setCanManage] = useState(kit.user_id === currentUser?.id);

  useEffect(() => {
    listPayments(kit.id).then(setPayments).catch(() => {});
    getKitEvents(kit.id).then(setEvents).catch(() => {});
    if (kit.agent_enabled) getKitHeartbeats(kit.id, 50).then(setHeartbeats).catch(() => {});
  }, [kit.id, kit.updated_at, kit.agent_enabled]);

  useEffect(() => {
    // Mirrors the backend's loadKitForMutation exactly: creator always,
    // otherwise admin+ on the owning org. Failing closed (staying false)
    // is the safe direction to be wrong in - a hidden button is a much
    // smaller problem than a visible one that 403s.
    if (kit.user_id === currentUser?.id) {
      setCanManage(true);
      return;
    }
    if (!kit.organization_id) {
      setCanManage(false);
      return;
    }
    listOrganizations()
      .then((orgs) => {
        const role = orgs.find((o) => o.id === kit.organization_id)?.role;
        setCanManage(role === "admin" || role === "owner");
      })
      .catch(() => setCanManage(false));
  }, [kit.id, kit.organization_id, kit.user_id, currentUser?.id]);

  async function run(fn, successMessage) {
    setBusy(true);
    try {
      await fn();
      if (successMessage) toast(successMessage);
      await onChanged();
      const [p, e] = await Promise.all([listPayments(kit.id).catch(() => payments), getKitEvents(kit.id).catch(() => events)]);
      setPayments(p);
      setEvents(e);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const snoozed = isSnoozed(kit);
  const idle = isIdle(kit);
  const days = idleDays(kit);

  return (
    <div>
      <div className="sl-detail-head">
        <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={onBack}>
          ← Back
        </button>
        {canManage && (
          <div className="sl-detail-head__actions">
            <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="sl-btn sl-btn--danger sl-btn--sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="sl-panel">
        <div className="sl-detail-title">{kit.name}</div>
        {kit.client_name && <div className="sl-detail-sub">{kit.client_name}</div>}
        <div className="sl-detail-meta">
          {[kit.city, kit.region, kit.country].filter(Boolean).join(", ") || "No location set"}
          {kit.service_line && <> · {kit.service_line}</>}
          {kit.organization_name && <> · {kit.organization_name}</>}
        </div>
        {snoozed && (
          <div className="sl-notice">
            Alerts muted for another {timeUntil(kit.snoozed_until)}. State is still being tracked and shown - only the
            notifications are paused.
          </div>
        )}
      </div>

      {/* Three panels, one per axis, in the same order everywhere in the
          app. Each one carries its own state, its own explanation of how
          that state was reached, and its own actions - so there's never
          a question of which button affects which axis. */}
      <div className="sl-section-label">Billing</div>
      <div className="sl-panel">
        <div className="sl-axis-head">
          <div className="sl-axis-head__value" style={{ color: BILLING_COLORS[kit.billing_state] }}>
            {BILLING_LABELS[kit.billing_state]}
          </div>
          <div className="sl-axis-head__sub">{kit.billing_state === "cancelled" ? "Service cancelled" : dueLabel(kit)}</div>
        </div>
        <dl className="sl-kv">
          <Row label="Next due" value={dateOnly(kit.next_due_at)} />
          <Row label="Last paid" value={kit.last_paid_at ? dateOnly(kit.last_paid_at) : "No payment recorded"} />
          <Row label="Amount" value={money(kit.plan_amount, kit.plan_currency) || "—"} />
          <Row
            label="Thresholds"
            value={`warns ${kit.thresholds?.expiring_soon_days}d before · ${kit.thresholds?.grace_days}d grace after`}
          />
        </dl>
        {canManage && (
          <div className="sl-actions">
            <button className="sl-btn sl-btn--sm" onClick={() => setPaying(true)} disabled={busy}>
              Record payment
            </button>
            {kit.billing_state === "cancelled" ? (
              <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => setBillingState(kit.id, "active"), "Service reinstated.")} disabled={busy}>
                Reinstate
              </button>
            ) : (
              <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => setBillingState(kit.id, "cancelled"), "Marked cancelled.")} disabled={busy}>
                Mark cancelled
              </button>
            )}
          </div>
        )}
      </div>

      <div className="sl-section-label">Hardware</div>
      <div className="sl-panel">
        <div className="sl-axis-head">
          <div className="sl-axis-head__value" style={{ color: HARDWARE_COLORS[kit.hardware_state] }}>
            {HARDWARE_LABELS[kit.hardware_state]}
          </div>
          <div className="sl-axis-head__sub">
            {kit.hardware_state === "unknown"
              ? "Nothing on this kit's network is reporting in - this is the honest default, not a fault."
              : kit.hardware_source === "manual"
              ? `Set by hand ${timeAgo(kit.hardware_state_changed_at)}`
              : `Last heartbeat ${timeAgo(kit.last_heartbeat_at)}`}
          </div>
        </div>
        {kit.hardware_note && <div className="sl-detail-meta">{kit.hardware_note}</div>}
        {kit.agent_enabled && (
          <dl className="sl-kv">
            <Row label="Obstruction" value={kit.last_obstruction_pct != null ? `${Number(kit.last_obstruction_pct).toFixed(2)}%` : "—"} />
            <Row label="Down / up" value={kit.last_downlink_mbps != null ? `${kit.last_downlink_mbps} / ${kit.last_uplink_mbps ?? "—"} Mbps` : "—"} />
            <Row label="Ping" value={kit.last_ping_ms != null ? `${kit.last_ping_ms} ms` : "—"} />
            <Row label="Heartbeats kept" value={`${heartbeats.length} recent`} />
          </dl>
        )}
        {canManage && (
          <div className="sl-actions">
            <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => setHardwareState(kit.id, "online"), "Marked online.")} disabled={busy}>
              Mark online
            </button>
            <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => setHardwareState(kit.id, "offline"), "Marked offline.")} disabled={busy}>
              Mark down
            </button>
            <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => setHardwareState(kit.id, "unknown"), "Set back to unknown.")} disabled={busy}>
              Unknown
            </button>
          </div>
        )}
      </div>

      <div className="sl-section-label">Usage</div>
      <div className="sl-panel">
        <div className="sl-axis-head">
          <div className="sl-axis-head__value" style={{ color: idle ? "var(--amber)" : "var(--ink)" }}>
            {idleLabel(kit)}
          </div>
          <div className="sl-axis-head__sub">
            {days === null
              ? "Nobody has recorded this kit as in use yet, so the idle countdown hasn't started."
              : `Last seen ${dateOnly(kit.last_active_at)} · flagged at ${kit.thresholds?.idle_alert_days} days`}
          </div>
        </div>
        {canManage && (
          <div className="sl-actions">
            <button className="sl-btn sl-btn--sm" onClick={() => run(() => markSeen(kit.id), "Marked as in use.")} disabled={busy}>
              Mark as seen now
            </button>
          </div>
        )}
      </div>

      {canManage && (
        <>
          <div className="sl-section-label">Alerts</div>
          <div className="sl-panel sl-snooze-panel">
            {snoozed ? (
              <>
                <span className="sl-hint">Muted for another {timeUntil(kit.snoozed_until)}.</span>
                <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => unsnoozeKit(kit.id), "Alerts back on.")} disabled={busy}>
                  Unmute
                </button>
              </>
            ) : (
              <>
                <span className="sl-hint">Mute alerts for this kit</span>
                <div className="sl-actions">
                  {SNOOZE_OPTIONS.map((o) => (
                    <button key={o.minutes} className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => snoozeKit(kit.id, o.minutes), `Muted for ${o.label}.`)} disabled={busy}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {kit.latitude != null && kit.longitude != null && (
        <>
          <div className="sl-section-label">Location</div>
          <div className="sl-panel">
            <FleetMap kits={[kit]} height={220} />
            <div className="sl-hint" style={{ marginTop: 8 }}>
              {kit.geocode_source === "nominatim"
                ? "Pin was derived from the address automatically - worth confirming against reality."
                : "Pin was set by hand."}
            </div>
          </div>
        </>
      )}

      <div className="sl-section-label">Payments</div>
      <div className="sl-panel">
        {payments.length === 0 ? (
          <div className="sl-empty__title">No payments recorded yet.</div>
        ) : (
          <div className="sl-list">
            {payments.map((p) => (
              <div className="sl-list-row" key={p.id}>
                <div>
                  <div className="sl-list-row__title">{money(p.amount, p.currency) || "Payment"}</div>
                  <div className="sl-list-row__sub">
                    {dateOnly(p.paid_at)}
                    {p.method && <> · {p.method}</>}
                    {p.covers_until && <> · covers to {dateOnly(p.covers_until)}</>}
                    {p.recorded_by_email && <> · {p.recorded_by_email}</>}
                  </div>
                  {p.note && <div className="sl-list-row__sub">{p.note}</div>}
                </div>
                {canManage && (
                  <button className="sl-linkbtn" onClick={() => run(() => deletePayment(kit.id, p.id), "Entry removed.")} disabled={busy}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <>
          <div className="sl-section-label">Kit agent</div>
          <div className="sl-panel">
            <div className="sl-hint" style={{ marginBottom: 10 }}>
              Optional. A small script on the kit's own network reads Starlink's local diagnostic endpoint
              (192.168.100.1) and posts status here on a timer. Only possible where you can reach that network - without
              it, hardware state stays whatever someone sets by hand.
            </div>
            {kit.agent_enabled ? (
              <>
                <dl className="sl-kv">
                  <Row label="Token" value={kit.agent_token_prefix ? `${kit.agent_token_prefix}…` : "issued"} />
                  <Row label="Last heartbeat" value={timeAgo(kit.last_heartbeat_at)} />
                  <Row label="Goes offline after" value={`${kit.thresholds?.offline_after_min}m silent × ${kit.alert_after_misses} windows`} />
                </dl>
                <div className="sl-actions">
                  <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => issueAgentToken(kit.id).then((r) => setAgentToken(r.token)).catch((e) => toast(e.message, "error"))} disabled={busy}>
                    Regenerate token
                  </button>
                  <button className="sl-btn sl-btn--ghost sl-btn--sm" onClick={() => run(() => disableAgent(kit.id), "Agent turned off.")} disabled={busy}>
                    Turn off agent
                  </button>
                </div>
              </>
            ) : (
              <button className="sl-btn sl-btn--sm" onClick={() => issueAgentToken(kit.id).then((r) => { setAgentToken(r.token); onChanged(); }).catch((e) => toast(e.message, "error"))} disabled={busy}>
                Issue an agent token
              </button>
            )}
          </div>
        </>
      )}

      <div className="sl-section-label">History</div>
      <div className="sl-panel">
        {events.length === 0 ? (
          <div className="sl-empty__title">Nothing recorded yet.</div>
        ) : (
          <div className="sl-list">
            {events.map((e) => (
              <div className="sl-list-row" key={e.id}>
                <div>
                  <div className="sl-list-row__title">{e.title}</div>
                  <div className="sl-list-row__sub">
                    {new Date(e.created_at).toLocaleString()}
                    {/* No actor means a sweep did it rather than a
                        person - the distinction people actually ask
                        about when reviewing a disputed change. */}
                    {e.actor_email ? <> · {e.actor_email}</> : <> · automatic</>}
                  </div>
                  {e.detail && <div className="sl-list-row__sub">{e.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {paying && (
        <PaymentModal
          kit={kit}
          onClose={() => setPaying(false)}
          onSaved={async () => {
            setPaying(false);
            await run(async () => {}, "Payment recorded.");
          }}
          toast={toast}
        />
      )}

      {editing && <KitForm kit={kit} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onChanged(); }} toast={toast} />}

      {agentToken && (
        <ModalOverlay open onCancel={() => setAgentToken(null)}>
          <div className="sl-panel sl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sl-modal__title">Agent token</div>
            <div className="sl-hint">
              Copy it now - it's stored hashed and can't be shown again. Have the agent send it as a bearer token.
            </div>
            <code className="sl-token sl-selectable">{agentToken}</code>
            <div className="sl-hint" style={{ marginTop: 10 }}>
              The agent posts to <code className="sl-selectable">/api/agent/heartbeat</code> with a JSON body of
              whatever it read locally - obstruction_pct, downlink_mbps, uplink_mbps, ping_ms are recognised, anything
              else is kept as-is.
            </div>
            <div className="sl-modal__actions">
              <button className="sl-btn" onClick={() => setAgentToken(null)}>
                Done
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this kit?"
        body="Its payment log, history and heartbeats go with it. This can't be undone."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          try {
            await deleteKit(kit.id);
            toast("Kit deleted.");
            setConfirmDelete(false);
            await onChanged();
            onBack();
          } catch (err) {
            toast(err.message, "error");
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function Row({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

const METHOD_OPTIONS = [
  { value: "transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "starlink_portal", label: "Starlink portal" },
  { value: "other", label: "Other" },
];

function PaymentModal({ kit, onClose, onSaved, toast }) {
  const [amount, setAmount] = useState(kit.plan_amount ?? "");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  // Blank means "advance by the kit's cycle", which is the common case.
  // Filled in means a part-payment or a client who paid three months
  // up front - both normal enough that the field is offered rather than
  // requiring an edit to the due date afterwards.
  const [coversUntil, setCoversUntil] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await recordPayment(kit.id, {
        amount: amount === "" ? null : Number(amount),
        paid_at: new Date(`${paidAt}T12:00:00`).toISOString(),
        method,
        reference: reference || null,
        note: note || null,
        covers_until: coversUntil ? new Date(`${coversUntil}T12:00:00`).toISOString() : null,
      });
      onSaved();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay open onCancel={saving ? undefined : onClose} closeOnBackdrop={false}>
      <div className="sl-panel sl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal__title">Record a payment</div>
        <form onSubmit={submit} className="sl-form">
          <label className="sl-field">
            <span className="sl-field__label">Amount</span>
            <input className="sl-input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Paid on</span>
            <input className="sl-input" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Method</span>
            <Dropdown value={method} onChange={setMethod} options={METHOD_OPTIONS} />
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Reference</span>
            <input className="sl-input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transfer ref, receipt no." />
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Covers until</span>
            <input className="sl-input" type="date" value={coversUntil} onChange={(e) => setCoversUntil(e.target.value)} />
            <span className="sl-hint">
              Leave blank to advance by this kit's cycle. Paying early keeps the days already paid for rather than
              restarting from today.
            </span>
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Note</span>
            <input className="sl-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="sl-modal__actions">
            <button type="button" className="sl-btn sl-btn--ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="sl-btn" disabled={saving}>
              {saving ? "Saving..." : "Record payment"}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  );
}
