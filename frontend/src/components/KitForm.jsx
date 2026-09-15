import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay.jsx";
import Dropdown from "./Dropdown.jsx";
import { LocationPicker } from "./FleetMap.jsx";
import { createKit, updateKit, geocode, listOrganizations } from "../api.js";

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "30_day", label: "Every 30 days" },
  { value: "custom", label: "Custom interval" },
];

// An <input type="date"> wants YYYY-MM-DD and the API speaks ISO
// timestamps, so the conversion happens once at each boundary rather
// than being re-derived at every use.
function toDateInput(iso) {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

const EMPTY = {
  name: "",
  client_name: "",
  organization_id: "",
  service_line: "",
  kit_serial: "",
  hardware_model: "",
  plan_name: "",
  plan_amount: "",
  plan_currency: "NGN",
  billing_cycle: "monthly",
  billing_cycle_days: "",
  next_due_at: "",
  grace_days: "",
  expiring_soon_days: "",
  idle_alert_days: "",
  offline_after_min: "",
  alert_after_misses: 2,
  address: "",
  city: "",
  region: "",
  country: "",
  latitude: "",
  longitude: "",
  notes: "",
};

export default function KitForm({ kit, onClose, onSaved, toast }) {
  const editing = !!kit;
  const [form, setForm] = useState(() => (kit ? hydrate(kit) : EMPTY));
  const [saving, setSaving] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [geocoding, setGeocoding] = useState(false);
  const [candidates, setCandidates] = useState(null);
  // Tracks whether the current coordinates came from the geocoder or
  // from a person. Sent to the API so geocode_source is accurate, which
  // is what lets the detail view say "auto-located" on a pin nobody has
  // actually verified.
  const [coordSource, setCoordSource] = useState(kit?.geocode_source || null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    listOrganizations()
      // Only orgs where this user can actually create kits. Listing one
      // they'd get a 403 from is worse than not offering it.
      .then((rows) => setOrgs(rows.filter((o) => o.role === "admin" || o.role === "owner")))
      .catch(() => {});
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleGeocode() {
    if (!form.address && !form.city) {
      toast("Add at least an address or a city to look up.", "error");
      return;
    }
    setGeocoding(true);
    setCandidates(null);
    try {
      const { results, reason } = await geocode({
        address: form.address,
        city: form.city,
        region: form.region,
        country: form.country,
      });
      if (results.length === 0) {
        // The backend distinguishes "the lookup failed" from "nothing
        // matched" for a reason - they call for completely different
        // reactions from whoever's typing - so the message does too.
        toast(reason ? `Couldn't look that up: ${reason}` : "No match for that address. Drop a pin on the map instead.", "error");
      } else {
        setCandidates(results);
      }
    } finally {
      setGeocoding(false);
    }
  }

  function applyCandidate(candidate) {
    setForm((f) => ({
      ...f,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      // Only filled in where the form is currently blank - someone who
      // typed "Ikeja GRA" shouldn't have it overwritten by the
      // geocoder's idea of the city name.
      city: f.city || candidate.city || "",
      region: f.region || candidate.region || "",
      country: f.country || candidate.country || "",
    }));
    setCoordSource("nominatim");
    setCandidates(null);
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!form.name.trim()) {
      toast("The kit needs a name.", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        organization_id: form.organization_id || null,
        plan_amount: form.plan_amount === "" ? null : Number(form.plan_amount),
        latitude: form.latitude === "" ? null : Number(form.latitude),
        longitude: form.longitude === "" ? null : Number(form.longitude),
        next_due_at: form.next_due_at ? new Date(`${form.next_due_at}T12:00:00`).toISOString() : null,
        geocode_source: coordSource === "nominatim" ? "nominatim" : "manual",
      };
      for (const key of ["billing_cycle_days", "grace_days", "expiring_soon_days", "idle_alert_days", "offline_after_min"]) {
        payload[key] = form[key] === "" ? null : Number(form[key]);
      }
      const saved = editing ? await updateKit(kit.id, payload) : await createKit(payload);
      toast(editing ? "Kit updated." : "Kit added.");
      onSaved(saved);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  const hasCoords = form.latitude !== "" && form.longitude !== "";

  return (
    <ModalOverlay open onCancel={saving ? undefined : onClose} closeOnBackdrop={false}>
      <div className="sl-panel sl-modal sl-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal__title">{editing ? "Edit kit" : "Add a kit"}</div>
        <form onSubmit={handleSubmit} className="sl-form">
          <Field label="Name" hint="How you refer to this kit day to day.">
            <input className="sl-input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Lekki office roof" />
          </Field>

          <div className="sl-form-row">
            <Field label="Client" hint="Groups and filters the dashboard.">
              <input className="sl-input" value={form.client_name} onChange={(e) => set("client_name", e.target.value)} placeholder="Ajayi Ltd" />
            </Field>
            {orgs.length > 0 && (
              <Field label="Organization" hint="Everyone in it gets alerted for this kit.">
                <Dropdown
                  value={form.organization_id}
                  onChange={(v) => set("organization_id", v)}
                  options={[{ value: "", label: "Personal (just me)" }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
                />
              </Field>
            )}
          </div>

          <div className="sl-form-row">
            <Field label="Service line" hint="From your Starlink account.">
              <input className="sl-input" value={form.service_line} onChange={(e) => set("service_line", e.target.value)} placeholder="SL-1234567-89012-34" />
            </Field>
            <Field label="Kit serial">
              <input className="sl-input" value={form.kit_serial} onChange={(e) => set("kit_serial", e.target.value)} />
            </Field>
          </div>

          <div className="sl-section-label">Billing</div>
          <div className="sl-form-row">
            <Field label="Amount per cycle">
              <input className="sl-input" type="number" step="0.01" value={form.plan_amount} onChange={(e) => set("plan_amount", e.target.value)} placeholder="38000" />
            </Field>
            <Field label="Currency">
              <input className="sl-input" value={form.plan_currency} onChange={(e) => set("plan_currency", e.target.value)} />
            </Field>
          </div>
          <div className="sl-form-row">
            <Field label="Cycle">
              <Dropdown value={form.billing_cycle} onChange={(v) => set("billing_cycle", v)} options={CYCLE_OPTIONS} />
            </Field>
            {form.billing_cycle === "custom" ? (
              <Field label="Days per cycle">
                <input className="sl-input" type="number" value={form.billing_cycle_days} onChange={(e) => set("billing_cycle_days", e.target.value)} placeholder="30" />
              </Field>
            ) : (
              <Field label="Next payment due" hint="Everything about billing status is derived from this date.">
                <input className="sl-input" type="date" value={form.next_due_at} onChange={(e) => set("next_due_at", e.target.value)} />
              </Field>
            )}
          </div>
          {form.billing_cycle === "custom" && (
            <Field label="Next payment due" hint="Everything about billing status is derived from this date.">
              <input className="sl-input" type="date" value={form.next_due_at} onChange={(e) => set("next_due_at", e.target.value)} />
            </Field>
          )}

          <div className="sl-section-label">Location</div>
          <Field label="Address">
            <input className="sl-input" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="14 Admiralty Way" />
          </Field>
          <div className="sl-form-row">
            <Field label="City">
              <input className="sl-input" value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="Lekki" />
            </Field>
            <Field label="State / region">
              <input className="sl-input" value={form.region} onChange={(e) => set("region", e.target.value)} placeholder="Lagos" />
            </Field>
          </div>
          <Field label="Country">
            <input className="sl-input" value={form.country} onChange={(e) => set("country", e.target.value)} placeholder="Nigeria" />
          </Field>

          <div className="sl-geocode">
            <button type="button" className="sl-btn sl-btn--ghost sl-btn--sm" onClick={handleGeocode} disabled={geocoding}>
              {geocoding ? "Looking up..." : "Find on map"}
            </button>
            <span className="sl-hint">
              Uses OpenStreetMap's free geocoder. It's weaker on informal addresses - always check the pin, and move
              it if it's wrong.
            </span>
          </div>

          {candidates && (
            <div className="sl-candidates">
              {candidates.map((c, i) => (
                <button type="button" key={i} className="sl-candidate" onClick={() => applyCandidate(c)}>
                  <span className="sl-candidate__label">{c.label}</span>
                  <span className="sl-candidate__coords">
                    {c.latitude.toFixed(4)}, {c.longitude.toFixed(4)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <LocationPicker
            latitude={form.latitude === "" ? null : form.latitude}
            longitude={form.longitude === "" ? null : form.longitude}
            onChange={(lat, lng) => {
              set("latitude", lat);
              set("longitude", lng);
              setCoordSource("manual");
            }}
          />
          <div className="sl-form-row">
            <Field label="Latitude">
              <input
                className="sl-input"
                value={form.latitude}
                onChange={(e) => {
                  set("latitude", e.target.value);
                  setCoordSource("manual");
                }}
                placeholder="6.447400"
              />
            </Field>
            <Field label="Longitude">
              <input
                className="sl-input"
                value={form.longitude}
                onChange={(e) => {
                  set("longitude", e.target.value);
                  setCoordSource("manual");
                }}
                placeholder="3.473500"
              />
            </Field>
          </div>
          {hasCoords && (
            <div className="sl-hint">
              {coordSource === "nominatim" ? "Auto-located from the address - worth confirming." : "Set by hand."}{" "}
              <button
                type="button"
                className="sl-linkbtn"
                onClick={() => {
                  set("latitude", "");
                  set("longitude", "");
                  setCoordSource(null);
                }}
              >
                Clear pin
              </button>
            </div>
          )}

          <button type="button" className="sl-linkbtn sl-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide" : "Show"} per-kit thresholds
          </button>
          {showAdvanced && (
            <div className="sl-advanced">
              <div className="sl-hint" style={{ marginBottom: 10 }}>
                Leave any of these blank to use your organization's default (or the app default if this kit is
                personal). Starlink doesn't publish a grace period - it's whatever you decide to give.
              </div>
              <div className="sl-form-row">
                <Field label="Expiring soon (days before due)">
                  <input className="sl-input" type="number" value={form.expiring_soon_days} onChange={(e) => set("expiring_soon_days", e.target.value)} placeholder="3" />
                </Field>
                <Field label="Grace period (days after due)">
                  <input className="sl-input" type="number" value={form.grace_days} onChange={(e) => set("grace_days", e.target.value)} placeholder="7" />
                </Field>
              </div>
              <div className="sl-form-row">
                <Field label="Idle alert after (days)">
                  <input className="sl-input" type="number" value={form.idle_alert_days} onChange={(e) => set("idle_alert_days", e.target.value)} placeholder="30" />
                </Field>
                <Field label="Offline after (minutes, agent only)">
                  <input className="sl-input" type="number" value={form.offline_after_min} onChange={(e) => set("offline_after_min", e.target.value)} placeholder="20" />
                </Field>
              </div>
              <Field label="Missed heartbeats before offline" hint="Stops a brief satellite handover from reading as an outage.">
                <input className="sl-input" type="number" min="1" value={form.alert_after_misses} onChange={(e) => set("alert_after_misses", e.target.value)} />
              </Field>
            </div>
          )}

          <Field label="Notes">
            <textarea className="sl-input" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>

          <div className="sl-modal__actions">
            <button type="button" className="sl-btn sl-btn--ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="sl-btn" disabled={saving}>
              {saving ? "Saving..." : editing ? "Save changes" : "Add kit"}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="sl-field">
      <span className="sl-field__label">{label}</span>
      {children}
      {hint && <span className="sl-hint">{hint}</span>}
    </label>
  );
}

function hydrate(kit) {
  const out = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) {
    const value = kit[key];
    out[key] = value === null || value === undefined ? EMPTY[key] : value;
  }
  out.next_due_at = toDateInput(kit.next_due_at);
  out.organization_id = kit.organization_id || "";
  return out;
}
