import { useEffect, useMemo, useRef, useState } from "react";
import KitCard from "./KitCard.jsx";
import KitCardSkeleton from "./KitCardSkeleton.jsx";
import SwipeableRow from "./SwipeableRow.jsx";
import PullToRefresh from "./PullToRefresh.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import Dropdown from "./Dropdown.jsx";
import { FleetMap } from "./FleetMap.jsx";
import { refreshKits, snoozeKit, unsnoozeKit, markSeen, deleteKit, listOrganizations } from "../api.js";
import { isIdle, isSnoozed, urgencyRank, needsChecking } from "../lib/kitDisplay.js";

const ANY = "__any__";

export default function Dashboard({ kits, loading, onSelect, onAdd, onImport, onChanged, currentUser, toast }) {
  const [view, setView] = useState("list");
  const [colorBy, setColorBy] = useState("billing");
  const [client, setClient] = useState(ANY);
  const [place, setPlace] = useState(ANY);
  const [state, setState] = useState(ANY);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [orgRoles, setOrgRoles] = useState({});
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const searchRef = useRef(null);

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

  // Searched across every field that identifies a kit, not just the
  // name. Imported kits get their display name derived from an account
  // email, so someone looking for a specific line will often type part
  // of the address, or the client, or the town - and a search that only
  // covered names would come back empty for all three.
  const matchesQuery = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return () => true;
    return (kit) => {
      const haystack = [
        kit.name, kit.client_name, kit.account_email, kit.service_line,
        kit.kit_serial, kit.city, kit.region, kit.country, kit.address,
        kit.plan_name, kit.account_condition, kit.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      // Every term has to appear somewhere, in any order - so "ajayi
      // lekki" finds the kit whether the client or the town comes
      // first in the record.
      return terms.every((t) => haystack.includes(t));
    };
  }, [query]);

  const filtered = useMemo(() => {
    return kits
      .filter(matchesQuery)
      .filter((k) => (client === ANY ? true : k.client_name === client))
      .filter((k) => (place === ANY ? true : k.city === place || k.region === place))
      .filter((k) => {
        if (state === ANY) return true;
        if (state === "offline") return k.hardware_state === "offline";
        if (state === "idle") return isIdle(k);
        if (state === "checking") return needsChecking(k);
        if (state === "overdue") return k.billing_state === "grace" || k.billing_state === "suspended";
        return k.billing_state === state;
      })
      .slice()
      .sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.name.localeCompare(b.name));
  }, [kits, client, place, state, matchesQuery]);

  // Any change to what's being filtered puts you back on page 1.
  // Without this, narrowing a search while on page 4 leaves you staring
  // at an empty list that looks like "no results" when there are
  // plenty - just not that far down.
  useEffect(() => {
    setPage(1);
  }, [query, client, place, state, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const paged = filtered.slice(pageStart, pageStart + pageSize);

  // "/" focuses the search, the way it does in most tools people already
  // use. Ignored while typing in a field, so it doesn't hijack a slash
  // in an address.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Counted across the whole fleet, not the filtered view: these are the
  // numbers someone opens the app to check, and having them silently
  // change when a filter is applied would make them untrustworthy.
  const overdue = kits.filter((k) => k.billing_state === "grace" || k.billing_state === "suspended").length;
  const offline = kits.filter((k) => k.hardware_state === "offline").length;
  const idleCount = kits.filter(isIdle).length;
  const checkCount = kits.filter(needsChecking).length;

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
                {checkCount > 0 && <Stat value={checkCount} label="Check" color="var(--orange)" />}
              </>
            )}
          </div>
          <div className="sl-dashboard-actions">
            <button className="sl-btn sl-btn--ghost" onClick={handleRefresh} disabled={refreshing || kits.length === 0}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button className="sl-btn sl-btn--ghost" onClick={onImport}>
              Import
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
                { value: "checking", label: "Needs checking" },
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
          <div className="sl-search">
            <svg className="sl-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              className="sl-search__input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search kits, clients, accounts, places…"
              aria-label="Search kits"
            />
            {query && (
              <button className="sl-search__clear" onClick={() => setQuery("")} aria-label="Clear search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
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
              <div style={{ marginTop: 10 }}>
                <button className="sl-linkbtn" onClick={onImport}>
                  Or import a spreadsheet you already keep
                </button>
              </div>
            </div>
          )
        ) : view === "map" ? (
          <div className="sl-panel">
            <FleetMap kits={filtered} colorBy={colorBy} onSelect={onSelect} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="sl-panel sl-empty">
            <div className="sl-empty__title">
              {query ? `Nothing matches "${query}"` : "Nothing matches those filters"}
            </div>
            <div>
              {kits.length} kit{kits.length === 1 ? "" : "s"} total — try widening the selection.
            </div>
            {query && (
              <div style={{ marginTop: 10 }}>
                <button className="sl-linkbtn" onClick={() => setQuery("")}>
                  Clear the search
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="sl-kit-grid">{paged.map(renderCard)}</div>
            {filtered.length > pageSize && (
              <div className="sl-pager">
                <span className="sl-pager__count">
                  {pageStart + 1}–{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length}
                </span>
                <div className="sl-pager__controls">
                  <button
                    className="sl-btn sl-btn--ghost sl-btn--sm"
                    onClick={() => setPage((n) => Math.max(1, n - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </button>
                  <span className="sl-pager__page">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    className="sl-btn sl-btn--ghost sl-btn--sm"
                    onClick={() => setPage((n) => Math.min(totalPages, n + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </button>
                </div>
                <Dropdown
                  value={String(pageSize)}
                  onChange={(v) => setPageSize(Number(v))}
                  options={[
                    { value: "20", label: "20 per page" },
                    { value: "50", label: "50 per page" },
                    { value: "100", label: "100 per page" },
                  ]}
                />
              </div>
            )}
          </>
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
