import {
  BILLING_LABELS,
  BILLING_COLORS,
  HARDWARE_LABELS,
  HARDWARE_COLORS,
  dueLabel,
  idleLabel,
  isIdle,
  isSnoozed,
  timeUntil,
  money,
} from "../lib/kitDisplay.js";

// The card's whole job is to show all three axes at once without letting
// any one of them pass for an overall verdict. Pulse's card could get
// away with a single status dot because a monitor really does have one
// state; a kit doesn't, and a card that showed only the worst of the
// three would hide the case this app exists for - a kit that's paid up,
// online, and hasn't been used since March.
export default function KitCard({ kit, onClick }) {
  const snoozed = isSnoozed(kit);
  const idle = isIdle(kit);

  return (
    <div className="sl-panel sl-kit-card" onClick={onClick}>
      <div className="sl-kit-card__head">
        <div className="sl-kit-card__name">
          {kit.name}
          {snoozed && <span className="sl-badge sl-badge--muted">muted {timeUntil(kit.snoozed_until)}</span>}
        </div>
        {kit.client_name && <div className="sl-kit-card__client">{kit.client_name}</div>}
      </div>

      <div className="sl-axes">
        {/* Each axis gets an identical slot regardless of its value, so
            the eye can read down a column of cards and compare like with
            like instead of hunting for whichever badges happen to be
            present on each one. */}
        <Axis
          label="Billing"
          value={BILLING_LABELS[kit.billing_state] || kit.billing_state}
          color={BILLING_COLORS[kit.billing_state]}
          sub={kit.billing_state === "cancelled" ? null : dueLabel(kit)}
        />
        <Axis
          label="Hardware"
          value={HARDWARE_LABELS[kit.hardware_state] || kit.hardware_state}
          color={HARDWARE_COLORS[kit.hardware_state]}
          sub={kit.hardware_state === "unknown" ? "no agent" : kit.hardware_source === "manual" ? "set by hand" : "from agent"}
        />
        <Axis
          label="Usage"
          value={idleLabel(kit)}
          color={idle ? "var(--amber)" : "var(--ink)"}
          sub={idle ? `over ${kit.thresholds?.idle_alert_days ?? 30}d` : null}
        />
      </div>

      <div className="sl-kit-card__foot">
        <span>{[kit.city, kit.region].filter(Boolean).join(", ") || "No location set"}</span>
        {money(kit.plan_amount, kit.plan_currency) && <span>{money(kit.plan_amount, kit.plan_currency)}</span>}
      </div>
    </div>
  );
}

function Axis({ label, value, color, sub }) {
  return (
    <div className="sl-axis">
      <div className="sl-axis__label">{label}</div>
      <div className="sl-axis__value" style={{ color }}>
        {value}
      </div>
      <div className="sl-axis__sub">{sub || "\u00a0"}</div>
    </div>
  );
}
