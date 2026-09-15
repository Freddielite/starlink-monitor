import { useEffect, useMemo, useState } from "react";
import KitCard from "./KitCard.jsx";
import KitCardSkeleton from "./KitCardSkeleton.jsx";
import SwipeableRow from "./SwipeableRow.jsx";
import PullToRefresh from "./PullToRefresh.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import Dropdown from "./Dropdown.jsx";
import { FleetMap } from "./FleetMap.jsx";
import { refreshKits, snoozeKit, unsnoozeKit, markSeen, deleteKit, listOrganizations } from "../api.js";
import { isIdle, isSnoozed, urgencyRank } from "../lib/kitDisplay.js";

const ANY = "__any__";

export default function Dashboard({ kits, loading, onSelect, onAdd, onChanged, currentUser, toast }) {
  const [view, setView] = useState("list");
  const [colorBy, setColorBy] = useState("billing");
  const [client, setClient] = useState(ANY);
  const [place, setPlace] = useState(ANY);
  const [state, setState] = useState(ANY);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [orgRoles, setOrgRoles] = useState({});

  useEffect(() => {
    listOrganizations()
      .then((orgs) => setOrgRoles(Object.fromEntries(orgs.map((o) => [o.id, o.role]))))
      .catch(() => {}); // failing closed (canManage below defaults to false) is the safe direction
  }, []);

  function canManage(kit) {
    if (!currentUser) return false;
    if (kit.user_id === currentUser.id) return true;
    if (!kit.organization_id) return false;
    return orgRoles[kit.organization_id] === "admin" || orgRoles[kit.organization_id] === "owner";
  }

  const clients = useMemo(() => [...new Set(kits.map((k) => k.client_name).filter(Boolean))].sort(), [kits]);
  // City and region share one filter rather than being two dropdowns.
  // In practice people think "show me Lagos" without caring whether
  // that's the city or the state field, and two filters that mostly
  // duplicate each other is more UI for a worse answer.
  const places = useMemo(
    () => [...new Set(kits.flatMap((k) => [k.city, k.region]).filter(Boolean))].sort(),
    [kits]
  );

  const filtered = useMemo(() => {
    return kits
      .filter((k) => (client === ANY ? true : k.client_name === client))
      .filter((k) => (place === ANY ? true : k.city === place || k.region === place))
      .filter((k) => {
        if (state === ANY) return true;
        if (state === "offline") return k.hardware_state === "offline";
        if (state === "idle") return isIdle(k);
        if (state === "overdue") return k.billing_state === "grace" || k.billing_state === "suspended";
        return k.billing_state === state;
      })
      .slice()
      .sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.name.localeCompare(b.name));
  }, [kits, client, place, state]);

  // Counted across the whole fleet, not the filtered view: these are the
  // numbers someone opens the app to check, and having them silently
  // change when a filter is applied would make them untrustworthy.
  const overdue = kits.filter((k) => k.billing_state === "grace" || k.billing_state === "suspended").length;
  const offline = kits.filter((k) => k.hardware_state === "offline").length;
  const idleCount = kits.filter(isIdle).length;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshKits();
      await onChanged();
      toast("Billing states recalculated.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setRefreshing(false);
    }
  }

  async function act(fn, message) {
    try {
      await fn();
      toast(message);
      await onChanged();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function renderCard(kit) {
    // A member with view-only access gets no swipe actions at all -
    // rather than actions that 403 on tap.
    const actions = canManage(kit)
      ? [
          {
            label: isSnoozed(kit) ? "Unmute" : "Mute 1d",
            tone: "snooze",
            onClick: () =>
              isSnoozed(kit)
                ? act(() => unsnoozeKit(kit.id), `${kit.name} unmuted.`)
                : act(() => snoozeKit(kit.id, 1440), `${kit.name} muted for a day.`),
          },
          { label: "Seen", tone: "snooze", onClick: () => act(() => markSeen(kit.id), `${kit.name} marked as in use.`) },
          { label: "Delete", tone: "delete", onClick: () => setConfirmingDeleteId(kit.id) },
        ]
      : [];
    return (
      <SwipeableRow key={kit.id} actions={actions}>
        <KitCard kit={kit} onClick={() => onSelect(kit)} />
      </SwipeableRow>
    );
  }

  return (
    <>
      <PullToRefresh onRefresh={onChanged}>
        <div className="sl-panel sl-dashboard-toolbar">
          <div className="sl-dashboard-stats">
            {loading ? (
              <>
                <div className="sl-skeleton" style={{ width: 60, height: 34 }} />
                <div className="sl-skeleton" style={{ width: 60, height: 34 }} />
                <div className="sl-skeleton" style={{ width: 60, height: 34 }} />
              </>
            ) : (
              <>
                <Stat value={kits.length} label="Kits" />
                <Stat value={overdue} label="Overdue" color={overdue > 0 ? "var(--alert)" : undefined} />
                <Stat value={offline} label="Offline" color={offline > 0 ? "var(--alert)" : undefined} />
                <Stat value={idleCount} label="Idle" color={idleCount > 0 ? "var(--amber)" : undefined} />
              </>
            )}
          </div>
          <div className="sl-dashboard-actions">
            <button className="sl-btn sl-btn--ghost" onClick={handleRefresh} disabled={refreshing || kits.length === 0}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button className="sl-btn" onClick={onAdd}>
              Add kit
            </button>
          </div>
        </div>

        <div className="sl-panel sl-filters">
          <div className="sl-toggle-group">
            <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
              List
            </button>
            <button className={view === "map" ? "active" : ""} onClick={() => setView("map")}>
              Map
            </button>
          </div>
          <div className="sl-filters__selects">
            {clients.length > 0 && (
              <Dropdown
                value={client}
                onChange={setClient}
                options={[{ value: ANY, label: "All clients" }, ...clients.map((c) => ({ value: c, label: c }))]}
              />
            )}
            {places.length > 0 && (
              <Dropdown
                value={place}
                onChange={setPlace}
                options={[{ value: ANY, label: "Everywhere" }, ...places.map((p) => ({ value: p, label: p }))]}
              />
            )}
            <Dropdown
              value={state}
              onChange={setState}
              options={[
                { value: ANY, label: "Any status" },
                { value: "overdue", label: "Overdue" },
                { value: "expiring_soon", label: "Expiring soon" },
                { value: "suspended", label: "Suspended" },
                { value: "offline", label: "Hardware offline" },
                { value: "idle", label: "Idle" },
                { value: "cancelled", label: "Cancelled" },
              ]}
            />
            {view === "map" && (
              <Dropdown
                value={colorBy}
                onChange={setColorBy}
                options={[
                  { value: "billing", label: "Colour by billing" },
                  { value: "hardware", label: "Colour by hardware" },
                ]}
              />
            )}
          </div>
        </div>

        {kits.length === 0 ? (
          loading ? (
            <div className="sl-kit-grid">
              <KitCardSkeleton />
              <KitCardSkeleton />
              <KitCardSkeleton />
            </div>
          ) : (
            <div className="sl-panel sl-empty">
              <div className="sl-empty__title">No kits yet</div>
              <div>Add the first kit you're tracking - who it's for, what it costs, and when the next payment is due.</div>
            </div>
          )
        ) : view === "map" ? (
          <div className="sl-panel">
            <FleetMap kits={filtered} colorBy={colorBy} onSelect={onSelect} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="sl-panel sl-empty">
            <div className="sl-empty__title">Nothing matches those filters</div>
            <div>{kits.length} kits total - try widening the selection.</div>
          </div>
        ) : (
          <div className="sl-kit-grid">{filtered.map(renderCard)}</div>
        )}
      </PullToRefresh>

      <ConfirmDialog
        open={!!confirmingDeleteId}
        title="Delete this kit?"
        body="Its payment log, history and heartbeats go with it. This can't be undone."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          const id = confirmingDeleteId;
          setConfirmingDeleteId(null);
          await act(() => deleteKit(id), "Kit deleted.");
        }}
        onCancel={() => setConfirmingDeleteId(null)}
      />
    </>
  );
}

function Stat({ value, label, color }) {
  return (
    <div>
      <div className="sl-stat__value" style={{ fontSize: 20, color }}>
        {value}
      </div>
      <div className="sl-stat__label">{label}</div>
    </div>
  );
}
