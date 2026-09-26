import { useMemo, useRef, useState } from "react";
import ModalOverlay from "./ModalOverlay.jsx";
import Dropdown from "./Dropdown.jsx";
import { importKits, listOrganizations, geocodeKit } from "../api.js";
import { looksLikeAccountSheet, guessAccountMapping } from "../lib/sheetProfile.js";

// Kept in the order they appear on a kit, so the mapping screen reads
// top-to-bottom like the form does.
const KIT_FIELDS = [
  { key: "name", label: "Kit name", required: true },
  { key: "client_name", label: "Client" },
  { key: "service_line", label: "Service line" },
  { key: "kit_serial", label: "Kit serial" },
  { key: "hardware_model", label: "Hardware model" },
  { key: "plan_amount", label: "Amount per cycle" },
  { key: "plan_currency", label: "Currency" },
  { key: "next_due_at", label: "Next due date" },
  { key: "last_paid_at", label: "Last paid" },
  { key: "last_active_at", label: "Last active / seen" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "region", label: "State / region" },
  { key: "country", label: "Country" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
  { key: "notes", label: "Notes" },
];

// The operator account-sheet shape, offered when the file looks like
// one. Different identity (the login), different columns, and a
// password column that gets deliberately ignored.
const ACCOUNT_FIELDS = [
  { key: "account_email", label: "Account email", required: true },
  { key: "account_status", label: "Account status" },
  { key: "outstanding_amount", label: "Overdue amount" },
  { key: "overdue_since", label: "Overdue / suspended date" },
  { key: "next_due_at", label: "Next bill date" },
  { key: "last_payment_amount", label: "Last payment amount" },
  { key: "last_paid_at", label: "Last payment date" },
  { key: "plan_name", label: "Plan" },
  { key: "notes", label: "Notes" },
  { key: "client_name", label: "Client" },
  { key: "city", label: "City" },
  { key: "region", label: "State / region" },
];

const NONE = "__none__";

export default function ImportKits({ onClose, onDone, toast }) {
  // file -> map -> preview -> done. Explicit rather than derived, because
  // "we have rows but no preview yet" and "we have a preview" need to
  // look different and the user can step back.
  const [stage, setStage] = useState("file");
  const [fileName, setFileName] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [dayFirst, setDayFirst] = useState(true);
  const [orgId, setOrgId] = useState("");
  const [orgs, setOrgs] = useState([]);
  const [onDuplicate, setOnDuplicate] = useState("skip");
  const [preview, setPreview] = useState(null);
  const [profile, setProfile] = useState("kits");
  const [busy, setBusy] = useState(false);
  const [geocoding, setGeocoding] = useState(null);
  const fileRef = useRef(null);

  // papaparse and SheetJS are loaded only when a file is actually
  // chosen. Together they outweigh the rest of the app, and the
  // overwhelming majority of sessions never open this modal, let alone
  // pick a file - bundling them into the main chunk would slow the
  // dashboard's first paint for everyone to save a moment for the few
  // people importing. Vite splits these into their own chunks.
  async function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";

    const finish = (parsedRows, parsedHeaders) => {
      // Rows that are entirely blank are dropped rather than reported as
      // errors - a trailing blank line, or a spacer row in the middle of
      // a sheet, is formatting, not a mistake worth telling anyone about.
      const clean = parsedRows.filter((r) => Object.values(r).some((v) => v !== null && v !== undefined && String(v).trim() !== ""));
      if (clean.length === 0) {
        toast("That file has no data rows in it.", "error");
        return;
      }
      setRows(clean);
      setHeaders(parsedHeaders);
      const isAccountSheet = looksLikeAccountSheet(parsedHeaders);
      setProfile(isAccountSheet ? "account_sheet" : "kits");
      setMapping(isAccountSheet ? guessAccountMapping(parsedHeaders) : guessMapping(parsedHeaders));
      setStage("map");
      listOrganizations()
        .then((list) => setOrgs(list.filter((o) => o.role === "admin" || o.role === "owner")))
        .catch(() => {});
    };

    if (isCsv) {
      const { default: Papa } = await import("papaparse");
      Papa.parse(file, {
        header: true,
        skipEmptyLines: "greedy",
        complete: (result) => finish(result.data, result.meta.fields || []),
        error: (err) => toast(`Couldn't read that CSV: ${err.message}`, "error"),
      });
    } else {
      const XLSX = await import("xlsx");
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          // cellDates makes SheetJS hand back real Date objects for
          // date-formatted cells, which sidesteps the Excel serial
          // guessing entirely for any sheet that was formatted properly.
          // The serial handling on the server is the fallback for ones
          // that weren't.
          const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" });
          const cols = json.length ? Object.keys(json[0]) : [];
          finish(json, cols);
        } catch (err) {
          toast(`Couldn't read that spreadsheet: ${err.message}`, "error");
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  async function runPreview() {
    setBusy(true);
    try {
      const result = await importKits({
        rows,
        mapping: cleanMapping(mapping),
        profile,
        day_first: dayFirst,
        organization_id: orgId || null,
        on_duplicate: onDuplicate,
        dry_run: true,
      });
      setPreview(result);
      setStage("preview");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await importKits({
        rows,
        mapping: cleanMapping(mapping),
        profile,
        day_first: dayFirst,
        organization_id: orgId || null,
        on_duplicate: onDuplicate,
        skip_invalid: true,
        dry_run: false,
      });
      toast(`Imported ${result.imported} kit${result.imported === 1 ? "" : "s"}${result.updated ? `, updated ${result.updated}` : ""}.`);
      setPreview(result);
      setStage("done");
      onDone();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  // Geocoding is done one kit at a time, from the client, on purpose:
  // Nominatim's policy is about one request a second, so a 200-kit
  // backfill is a three-minute job no matter how it's issued. Doing it
  // here means it can be watched, stopped, and picked up again later
  // instead of being one request that dies on a timeout halfway.
  async function geocodeMissing(kits) {
    const targets = kits.filter((k) => k.latitude === null && (k.address || k.city));
    if (targets.length === 0) {
      toast("Nothing to locate - no imported kits have an address without coordinates.");
      return;
    }
    setGeocoding({ done: 0, total: targets.length, located: 0, stop: false });
    let located = 0;
    for (let i = 0; i < targets.length; i++) {
      if (geocodingStopped.current) break;
      try {
        const result = await geocodeKit(targets[i].id);
        if (result.located) located++;
      } catch {
        // One address failing shouldn't end the run - the rest are
        // still worth locating, and anything missed stays editable by
        // hand.
      }
      setGeocoding({ done: i + 1, total: targets.length, located, stop: false });
    }
    toast(`Located ${located} of ${targets.length}. Check the pins - automatic matches on informal addresses are often approximate.`);
    setGeocoding(null);
    onDone();
  }
  const geocodingStopped = useRef(false);

  const mappedCount = useMemo(() => Object.values(cleanMapping(mapping)).filter(Boolean).length, [mapping]);

  return (
    <ModalOverlay open onCancel={busy ? undefined : onClose} closeOnBackdrop={false}>
      <div className="sl-panel sl-modal sl-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal__title">Import kits from a spreadsheet</div>

        {stage === "file" && (
          <>
            <div className="sl-hint" style={{ marginBottom: 14 }}>
              A CSV or Excel file with one row per kit and a header row at the top. Column names don't have to match
              anything - you'll map them on the next screen, and nothing is written until you've seen exactly what
              will happen.
            </div>
            <button className="sl-btn" onClick={() => fileRef.current?.click()}>
              Choose a file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv"
              style={{ display: "none" }}
              onChange={(e) => handleFile(e.target.files?.[0]).catch((err) => toast(String(err.message), "error"))}
            />
            <button className="sl-linkbtn" style={{ marginTop: 14 }} onClick={downloadTemplate}>
              Download a template CSV
            </button>
          </>
        )}

        {stage === "map" && (
          <>
            <div className="sl-hint" style={{ marginBottom: 12 }}>
              {fileName} · {rows.length} row{rows.length === 1 ? "" : "s"} · {mappedCount} column
              {mappedCount === 1 ? "" : "s"} matched automatically. Check them, then fix any that are wrong.
            </div>
            {profile === "account_sheet" && (
              <div className="sl-notice sl-notice--warn" style={{ marginBottom: 14 }}>
                This looks like a Starlink account sheet, so each row is matched on its account email — re-uploading an
                updated copy will update these kits rather than duplicate them.
                {headers.some((h) => /password/i.test(h)) && (
                  <>
                    {" "}
                    <strong>The password column will be ignored.</strong> Credentials are never stored — this app only
                    needs to know what a kit costs and whether it's been paid, and holding logins would turn a database
                    leak into a fleet takeover.
                  </>
                )}
              </div>
            )}

            <div className="sl-map-fields">
              {(profile === "account_sheet" ? ACCOUNT_FIELDS : KIT_FIELDS).map((field) => (
                <div className="sl-map-field" key={field.key}>
                  <span className="sl-map-field__label">
                    {field.label}
                    {field.required && <span style={{ color: "var(--alert)" }}> *</span>}
                  </span>
                  <Dropdown
                    value={mapping[field.key] || NONE}
                    onChange={(v) => setMapping((m) => ({ ...m, [field.key]: v === NONE ? undefined : v }))}
                    options={[{ value: NONE, label: "— not in this file —" }, ...headers.map((h) => ({ value: h, label: h }))]}
                  />
                </div>
              ))}
            </div>

            <div className="sl-section-label">Options</div>
            <div className="sl-map-fields">
              <div className="sl-map-field">
                <span className="sl-map-field__label">Ambiguous dates</span>
                <Dropdown
                  value={dayFirst ? "day" : "month"}
                  onChange={(v) => setDayFirst(v === "day")}
                  options={[
                    { value: "day", label: "05/03 means 5 March" },
                    { value: "month", label: "05/03 means 3 May" },
                  ]}
                />
              </div>
              <div className="sl-map-field">
                <span className="sl-map-field__label">If a kit already exists</span>
                <Dropdown
                  value={onDuplicate}
                  onChange={setOnDuplicate}
                  options={[
                    { value: "skip", label: "Skip it" },
                    { value: "update", label: "Fill in blanks from the sheet" },
                    { value: "create", label: "Add it anyway" },
                  ]}
                />
              </div>
              {orgs.length > 0 && (
                <div className="sl-map-field">
                  <span className="sl-map-field__label">Import into</span>
                  <Dropdown
                    value={orgId}
                    onChange={setOrgId}
                    options={[{ value: "", label: "Personal (just me)" }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
                  />
                </div>
              )}
            </div>

            <div className="sl-modal__actions">
              <button className="sl-btn sl-btn--ghost" onClick={() => setStage("file")} disabled={busy}>
                Back
              </button>
              <button className="sl-btn" onClick={runPreview} disabled={busy || (profile === "account_sheet" ? !mapping.account_email : !mapping.name)}>
                {busy ? "Checking..." : "Preview"}
              </button>
            </div>
          </>
        )}

        {stage === "preview" && preview && (
          <>
            <PreviewSummary summary={preview.summary} />
            <RowReport rows={preview.rows} />
            <div className="sl-modal__actions">
              <button className="sl-btn sl-btn--ghost" onClick={() => setStage("map")} disabled={busy}>
                Back
              </button>
              <button className="sl-btn" onClick={commit} disabled={busy || preview.summary.create + preview.summary.update === 0}>
                {busy ? "Importing..." : `Import ${preview.summary.create + preview.summary.update} kit(s)`}
              </button>
            </div>
          </>
        )}

        {stage === "done" && preview && (
          <>
            <div className="sl-axis-head">
              <div className="sl-axis-head__value" style={{ color: "var(--signal)" }}>
                {preview.imported} imported{preview.updated ? `, ${preview.updated} updated` : ""}
              </div>
              <div className="sl-axis-head__sub">
                Billing states were recalculated from the due dates, so anything already past due is showing as Grace
                or Suspended right now rather than waiting for the next sweep.
              </div>
            </div>
            {geocoding ? (
              <div className="sl-hint">
                Locating addresses… {geocoding.done} of {geocoding.total} ({geocoding.located} found). This runs at about
                one a second — leave it open, or stop and finish later.
                <button
                  className="sl-linkbtn"
                  style={{ display: "block", marginTop: 8 }}
                  onClick={() => {
                    geocodingStopped.current = true;
                  }}
                >
                  Stop
                </button>
              </div>
            ) : (
              <div className="sl-hint">
                If your sheet had addresses but no coordinates, the kits imported without map pins. You can look them
                up now — it takes about a second each, and the matches are worth checking afterwards.
              </div>
            )}
            <div className="sl-modal__actions">
              <button className="sl-btn" onClick={onClose} disabled={!!geocoding}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}

function PreviewSummary({ summary }) {
  return (
    <div className="sl-dashboard-stats" style={{ marginBottom: 14 }}>
      <Stat value={summary.create} label="New" color="var(--signal)" />
      <Stat value={summary.update} label="Updated" color={summary.update ? "var(--signal)" : undefined} />
      <Stat value={summary.skip} label="Skipped" color={summary.skip ? "var(--ink-dim)" : undefined} />
      <Stat value={summary.error} label="Problems" color={summary.error ? "var(--alert)" : undefined} />
    </div>
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

// Rows with something to say come first. A clean 300-row import should
// show a short list of warnings, not 300 lines of "fine" to scroll past.
function RowReport({ rows }) {
  const notable = rows.filter((r) => r.action !== "create" || r.warnings.length > 0);
  if (notable.length === 0) {
    return <div className="sl-hint" style={{ marginBottom: 14 }}>Every row is clean — nothing to flag.</div>;
  }
  return (
    <div className="sl-import-report">
      {notable.slice(0, 60).map((r) => (
        <div className="sl-import-row" key={r.rowNumber}>
          <span className={`sl-import-row__tag sl-import-row__tag--${r.action}`}>
            {r.action === "error" ? "problem" : r.action}
          </span>
          <div>
            <div className="sl-list-row__title">
              Row {r.rowNumber}
              {r.kit?.name ? ` · ${r.kit.name}` : ""}
            </div>
            {[...r.errors, ...(r.reason ? [r.reason] : []), ...r.warnings].map((m, i) => (
              <div className="sl-list-row__sub" key={i}>
                {m}
              </div>
            ))}
          </div>
        </div>
      ))}
      {notable.length > 60 && <div className="sl-hint">…and {notable.length - 60} more.</div>}
    </div>
  );
}

// Mirrors the server's guesser closely enough to be useful immediately,
// but the server re-does it properly on the request - this is only here
// so the mapping screen opens pre-filled instead of empty.
function guessMapping(headers) {
  const norm = (h) => String(h || "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const aliases = {
    name: ["name", "kit", "kit name", "site", "site name", "label", "description"],
    client_name: ["client", "client name", "customer", "customer name", "company", "account", "business"],
    service_line: ["service line", "service line number", "sl number", "starlink account", "account number"],
    kit_serial: ["serial", "kit serial", "serial number", "sn", "terminal id"],
    hardware_model: ["model", "hardware", "hardware model", "kit type"],
    plan_amount: ["amount", "price", "cost", "plan amount", "monthly", "monthly cost", "subscription", "fee", "rate"],
    plan_currency: ["currency", "ccy"],
    next_due_at: ["due", "due date", "next due", "next payment", "next payment date", "expiry", "renewal", "payment due"],
    last_paid_at: ["last paid", "last payment", "paid on", "date paid"],
    last_active_at: ["last active", "last seen", "last used"],
    address: ["address", "street", "street address", "location"],
    city: ["city", "town", "lga", "area"],
    region: ["region", "state", "province"],
    country: ["country"],
    latitude: ["latitude", "lat"],
    longitude: ["longitude", "lng", "lon", "long"],
    notes: ["notes", "note", "comment", "remarks"],
  };
  const normalized = headers.map((h) => ({ raw: h, norm: norm(h) }));
  const mapping = {};
  const used = new Set();
  for (const [field, list] of Object.entries(aliases)) {
    let hit = normalized.find((h) => !used.has(h.raw) && list.includes(h.norm));
    if (!hit) hit = normalized.find((h) => !used.has(h.raw) && list.some((a) => h.norm.startsWith(`${a} `) || h.norm.endsWith(` ${a}`)));
    if (hit) {
      mapping[field] = hit.raw;
      used.add(hit.raw);
    }
  }
  return mapping;
}

function cleanMapping(mapping) {
  const out = {};
  for (const [k, v] of Object.entries(mapping)) if (v && v !== NONE) out[k] = v;
  return out;
}

function downloadTemplate() {
  const csv =
    "Kit name,Client,Service line,Amount,Currency,Next due date,City,State,Country,Address,Latitude,Longitude,Notes\n" +
    "Lekki office roof,Ajayi Ltd,SL-1234567-89012-34,38000,NGN,2026-10-11,Lekki,Lagos,Nigeria,14 Admiralty Way,6.447400,3.473500,\n" +
    "Ikeja GRA rooftop,Adeyemi Holdings,,45000,NGN,2026-09-30,Ikeja,Lagos,Nigeria,,,,Second kit for this client\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "starlink-monitor-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}
