// Turning a spreadsheet someone actually keeps into kit rows.
//
// The whole design assumption here is that real sheets are messy: columns
// named whatever the person felt like, money written as "₦38,000.00",
// dates in three formats in the same column, blank rows in the middle,
// and a header row that may or may not be the first row. So this parses
// leniently and reports precisely, rather than validating strictly and
// failing the whole file on row 47.

// Header aliases, lowercased and stripped of punctuation before
// matching. Deliberately generous - the cost of a wrong guess is low
// (the user sees the mapping and can correct it before importing) while
// the cost of not guessing is that they hand-map eleven columns every
// time.
const COLUMN_ALIASES = {
  name: ["name", "kit", "kit name", "site", "site name", "location name", "label", "description"],
  client_name: ["client", "client name", "customer", "customer name", "company", "account", "tenant", "business"],
  service_line: ["service line", "service line number", "serviceline", "sl number", "starlink account", "account number"],
  kit_serial: ["serial", "kit serial", "serial number", "sn", "terminal id", "terminal serial", "dish serial"],
  hardware_model: ["model", "hardware", "hardware model", "kit type", "dish type"],
  plan_amount: ["amount", "price", "cost", "plan amount", "monthly", "monthly amount", "monthly cost", "subscription", "fee", "charge", "rate"],
  plan_currency: ["currency", "ccy"],
  next_due_at: ["due", "due date", "next due", "next due date", "next payment", "next payment date", "expiry", "expires", "renewal", "renewal date", "payment due"],
  last_paid_at: ["last paid", "last payment", "paid on", "date paid", "last paid date"],
  last_active_at: ["last active", "last seen", "last used", "last activity"],
  address: ["address", "street", "street address", "address line", "location"],
  city: ["city", "town", "lga", "area"],
  region: ["region", "state", "province"],
  country: ["country"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon", "long"],
  notes: ["notes", "note", "comment", "comments", "remarks"],
};

function normalizeHeader(header) {
  return String(header || "")
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-guess mapping from the sheet's headers to kit fields. Returns
// { field: headerName }, with each header used at most once - two
// columns both matching "amount" shouldn't silently both write to
// plan_amount, so the first (leftmost) wins and the second is left
// unmapped for the user to assign or ignore.
export function guessColumnMapping(headers) {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  const used = new Set();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // Exact alias match first, across all headers, before falling back to
    // substring matching - otherwise a column called "Client Address"
    // can claim `client_name` ahead of the column actually called
    // "Client", purely because it appears first.
    let hit = normalized.find((h) => !used.has(h.raw) && aliases.includes(h.norm));
    if (!hit) {
      hit = normalized.find(
        (h) => !used.has(h.raw) && aliases.some((a) => h.norm === a || h.norm.startsWith(`${a} `) || h.norm.endsWith(` ${a}`))
      );
    }
    if (hit) {
      mapping[field] = hit.raw;
      used.add(hit.raw);
    }
  }
  return mapping;
}

export const IMPORTABLE_FIELDS = Object.keys(COLUMN_ALIASES);

// ---------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------

// "₦38,000.00" / "NGN 38,000" / "38 000" / "(38,000)" -> 38000
// Returns { value } or { error }. The currency symbol is discarded here
// rather than inferred, because a symbol in an amount column tells you
// nothing reliable about the currency of a fleet that might be billed in
// two of them - the currency column (or the kit default) decides that.
export function parseMoney(raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : { error: "not a number" };

  let text = String(raw).trim();
  // Accounting-style negatives, which appear when a sheet has been
  // exported from software rather than typed.
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "");
  // Strip anything that isn't a digit, separator or sign. If the cell had
  // content but nothing numeric survives, that's junk in an amount column
  // and has to be reported - returning null here would silently import
  // the kit with no price, which is a much harder mistake to notice than
  // a rejected row.
  const hadContent = text.length > 0;
  text = text.replace(/[^\d.,\-]/g, "").trim();
  if (!text || !/\d/.test(text)) {
    return hadContent ? { error: `couldn't read "${raw}" as an amount` } : { value: null };
  }

  // Decide which separator is the decimal point. If both appear, the
  // rightmost one is the decimal (works for both 1,234.56 and
  // 1.234,56). If only commas appear and they're not in thousands
  // positions, treat the comma as a decimal point.
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (lastComma > -1) {
    const after = text.length - lastComma - 1;
    text = after === 3 ? text.replace(/,/g, "") : text.replace(",", ".");
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `couldn't read "${raw}" as an amount` };
  return { value: negative ? -n : n };
}

// Excel stores dates as days since 1899-12-30. A sheet exported without
// formatting hands over the raw serial, so a "due date" column can
// arrive as 46012 rather than a date string. Bounds-checked so a genuine
// number that happens to sit in a date column (an amount, a row ID)
// isn't silently turned into a date in 2043.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
// Deliberately narrow: 2009 to 2050. A wider window looks more tolerant
// but is actively harmful here, because a bare number in a date column is
// at least as likely to be an amount that landed in the wrong column as
// it is to be a real serial - and 38000 (a perfectly ordinary monthly
// price in naira) sits inside any generous range. Bounded to dates that
// could plausibly belong to a Starlink kit, a stray amount falls outside
// and gets reported instead of silently becoming a date in 2004.
const EXCEL_SERIAL_MIN = 40000; // ~2009
const EXCEL_SERIAL_MAX = 55000; // ~2050

// Returns { value: Date, assumed?: string } or { error }.
//
// `assumed` is the important part: dd/mm vs mm/dd is genuinely ambiguous
// for any day <= 12, and silently picking one is how an import quietly
// sets a fleet's due dates two months wrong. When the format can't be
// determined from the value itself, this says so, and the UI surfaces it
// before anything is written.
export function parseDate(raw, { dayFirst = true } = {}) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? { error: "invalid date" } : { value: raw };

  if (typeof raw === "number" || /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    const n = Number(raw);
    if (n >= EXCEL_SERIAL_MIN && n <= EXCEL_SERIAL_MAX) {
      return { value: new Date(EXCEL_EPOCH_MS + n * 86400000) };
    }
    return { error: `"${raw}" doesn't look like a date` };
  }

  const text = String(raw).trim();

  // ISO first - unambiguous, and what a well-behaved export produces.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12));
    return Number.isNaN(d.getTime()) ? { error: `invalid date "${raw}"` } : { value: d };
  }

  // Textual months are also unambiguous - "5 Jan 2026" / "Jan 5, 2026".
  const textual = Date.parse(text);
  if (/[a-z]{3}/i.test(text) && !Number.isNaN(textual)) {
    return { value: new Date(textual) };
  }

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (slash) {
    let [, a, b, y] = slash;
    a = +a;
    b = +b;
    y = +y;
    if (y < 100) y += y < 70 ? 2000 : 1900;

    let day;
    let month;
    let assumed;
    if (a > 12 && b <= 12) {
      day = a;
      month = b; // unambiguous: 25/03 can only be day-first
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a; // unambiguous: 03/25 can only be month-first
    } else if (a > 12 && b > 12) {
      return { error: `"${raw}" isn't a valid date either way round` };
    } else {
      // Genuinely ambiguous - both parts are <= 12.
      day = dayFirst ? a : b;
      month = dayFirst ? b : a;
      assumed = dayFirst ? "day/month" : "month/day";
    }

    const d = new Date(Date.UTC(y, month - 1, day, 12));
    if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== month - 1) {
      return { error: `invalid date "${raw}"` };
    }
    return { value: d, assumed };
  }

  const fallback = Date.parse(text);
  if (!Number.isNaN(fallback)) return { value: new Date(fallback) };
  return { error: `couldn't read "${raw}" as a date` };
}

function parseCoord(raw, kind) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  const n = Number(String(raw).replace(/[^\d.\-]/g, ""));
  if (!Number.isFinite(n)) return { error: `couldn't read "${raw}" as a ${kind}` };
  return { value: n };
}

function text(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  return t === "" ? null : t;
}

// ---------------------------------------------------------------------
// Row -> kit
// ---------------------------------------------------------------------

// Validates and normalises one sheet row against a column mapping.
// Always returns a result rather than throwing: the caller wants a
// report covering every row, not to stop at the first bad one.
export function parseRow(row, mapping, { dayFirst = true, rowNumber } = {}) {
  const get = (field) => (mapping[field] ? row[mapping[field]] : undefined);
  const errors = [];
  const warnings = [];
  const kit = {};

  kit.name = text(get("name"));
  if (!kit.name) errors.push("no kit name");

  for (const field of ["client_name", "service_line", "kit_serial", "hardware_model", "address", "city", "region", "country", "notes"]) {
    kit[field] = text(get(field));
  }

  kit.plan_currency = text(get("plan_currency")) || null;

  const amount = parseMoney(get("plan_amount"));
  if (amount.error) errors.push(amount.error);
  else kit.plan_amount = amount.value;

  for (const field of ["next_due_at", "last_paid_at", "last_active_at"]) {
    const parsed = parseDate(get(field), { dayFirst });
    if (parsed.error) errors.push(parsed.error);
    else {
      kit[field] = parsed.value ? parsed.value.toISOString() : null;
      if (parsed.assumed) warnings.push(`date "${get(field)}" read as ${parsed.assumed}`);
    }
  }

  const lat = parseCoord(get("latitude"), "latitude");
  const lng = parseCoord(get("longitude"), "longitude");
  if (lat.error) errors.push(lat.error);
  if (lng.error) errors.push(lng.error);
  kit.latitude = lat.value ?? null;
  kit.longitude = lng.value ?? null;
  if ((kit.latitude === null) !== (kit.longitude === null)) {
    errors.push("latitude and longitude have to both be set, or both be blank");
    kit.latitude = null;
    kit.longitude = null;
  }
  if (kit.latitude !== null && (Math.abs(kit.latitude) > 90 || Math.abs(kit.longitude) > 180)) {
    errors.push("coordinates are out of range - latitude must be within ±90, longitude within ±180");
  }

  // A kit with no due date is legitimate (it just reads as Active with
  // nothing to count down to), but on an import it's much more often a
  // column that didn't get mapped than a deliberate choice, so it's
  // called out.
  if (!kit.next_due_at) warnings.push("no due date - this kit will import as Active with no countdown");

  return { rowNumber, kit, errors, warnings, ok: errors.length === 0 };
}

// Rows that would collide with each other within the same file. Worth
// catching before the database does, because the natural key here
// (name + client) isn't enforced by a constraint - duplicates are legal,
// they're just almost never intended.
export function findInternalDuplicates(parsed) {
  const seen = new Map();
  const duplicates = [];
  for (const entry of parsed) {
    if (!entry.ok) continue;
    const key = `${(entry.kit.name || "").toLowerCase()}::${(entry.kit.client_name || "").toLowerCase()}`;
    if (seen.has(key)) duplicates.push({ rowNumber: entry.rowNumber, firstSeenAt: seen.get(key) });
    else seen.set(key, entry.rowNumber);
  }
  return duplicates;
}

// =====================================================================
// Operator account-sheet support
//
// Everything above handles a generic "one row per kit" sheet. This part
// handles the shape a Starlink operator's own records actually take,
// which is different in ways that matter:
//
//   - The row's identity is the ACCOUNT EMAIL, not a kit name. Nobody
//     names these; the login is the identifier, and it's the only value
//     stable enough to re-import against.
//   - Status is Starlink's vocabulary ("Suspended (Billing)"), mixed in
//     with conditions that aren't billing states at all ("Email Not
//     Found", "No Device", "Transferred").
//   - Amounts are outstanding balances, in several currencies at once,
//     with the symbol attached to the value.
//   - Usage lives in prose in the notes column ("Last used in March").
//   - There is a PASSWORD column. It is dropped, always.
// =====================================================================

// Account emails aren't kit names, but showing 153 rows of
// "chief_hills_tare_robis@dextercyberlab.com" on a dashboard is
// unreadable. The local part is almost always a description of the site
// or person, so it's turned into a usable display name - while
// account_email stays on the record as the real identifier.
export function nameFromAccountEmail(email) {
  if (!email) return null;
  const raw = String(email).trim();
  // Some cells carry a leading annotation, e.g.
  // "(Chief Soso Office) chief_soso@...". That parenthetical is a
  // better name than anything derivable from the address, so it wins.
  const annotated = /^\(([^)]+)\)/.exec(raw);
  if (annotated) return annotated[1].trim();

  const local = raw.split("@")[0].replace(/^[^a-z0-9]+/i, "");
  if (!local) return raw;
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractAccountEmail(raw) {
  if (!raw) return null;
  const match = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(String(raw));
  return match ? match[0].toLowerCase() : null;
}

// Currency travels with the value in these sheets ("€95", "₦49,000",
// "34,000 HUF"), so it's read per cell rather than assumed per kit or
// per org - a fleet billed in three currencies is the normal case here,
// and defaulting them all to one would silently misstate what's owed.
const CURRENCY_SYMBOLS = { "₦": "NGN", "€": "EUR", "£": "GBP", $: "USD" };
const CURRENCY_CODES = ["NGN", "EUR", "GBP", "USD", "HUF", "ZAR", "KES", "GHS"];

export function parseAmountWithCurrency(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { amount: null, currency: null };
  const text = String(raw).trim();

  let currency = null;
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) {
      currency = code;
      break;
    }
  }
  if (!currency) {
    const code = CURRENCY_CODES.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
    if (code) currency = code.toUpperCase();
  }

  const money = parseMoney(text);
  if (money.error) return { amount: null, currency, error: money.error };
  return { amount: money.value, currency };
}

// Starlink's status vocabulary, split into the two things it's actually
// conflating. `billing` is a real billing state this app understands;
// `condition` is everything else - a problem with the record or the
// account rather than a statement about payment.
//
// Returning null billing for those is the point: a row saying "Email Not
// Found" tells you nothing about whether that client has paid, and
// guessing 'active' from it would put a broken record on the dashboard
// looking healthy.
const STATUS_MAP = {
  active: { billing: "active" },
  overdue: { billing: "grace" },
  "suspended (billing)": { billing: "suspended" },
  suspended: { billing: "suspended" },
  cancelled: { billing: "cancelled" },
  canceled: { billing: "cancelled" },
  "no subscription": { billing: "cancelled", condition: "No subscription on this account" },
  "email not found": { condition: "Email not found - needs verifying" },
  "account not found": { condition: "Account not found - needs verifying" },
  "no device": { condition: "No device on this account" },
  "access issue": { condition: "Can't access this account" },
  transferred: { condition: "Transferred to another account" },
  "restricted (location)": { condition: "Restricted by location" },
};

export function parseAccountStatus(raw) {
  if (!raw) return { billing: null, condition: null };
  const key = String(raw).trim().toLowerCase();
  const hit = STATUS_MAP[key];
  if (hit) return { billing: hit.billing || null, condition: hit.condition || null };
  // Unrecognised statuses are preserved verbatim as a condition rather
  // than dropped. A new value appearing in the sheet is information;
  // silently discarding it would make the import look complete while
  // losing whatever the operator was recording.
  return { billing: null, condition: String(raw).trim() };
}

// "Roam international - not cancelled" / "International Roam" /
// "Residential" - the same handful of plans typed a dozen ways. Folded
// so the dashboard can group by plan, with any qualifier kept.
export function normalizePlan(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const lower = text.toLowerCase();
  const qualifier = /-\s*(.+)$/.exec(text)?.[1]?.trim();
  let base = null;
  if (lower.includes("roam")) base = "Roam (international)";
  else if (lower.includes("residential")) base = "Residential";
  if (!base) return text;
  if (lower.includes("fieldbase")) base = `Fieldbase ${base.toLowerCase()}`;
  return qualifier ? `${base} - ${qualifier}` : base;
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

// Pulls usage out of prose: "Last used in March", "Not in use since
// January". This is the only usage signal these sheets carry, and
// without it every imported kit would read as "never seen" and the idle
// axis would sit empty on a fleet that is demonstrably full of idle
// kits.
//
// A bare month has no year, so it resolves to the most recent one
// already past - "January" read in September means this January, not
// next. Returns the date plus the phrase it came from, so the UI can be
// honest that this was inferred from a note rather than observed.
export function inferLastActiveFromNotes(notes, now = new Date()) {
  if (!notes) return null;
  const text = String(notes).toLowerCase();
  if (!/(last used|not in use since|in use since|last active)/.test(text)) return null;

  const monthIndex = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(text));
  if (monthIndex === -1) return null;

  const explicitYear = /\b(20\d{2})\b/.exec(text);
  let year = explicitYear ? Number(explicitYear[1]) : now.getUTCFullYear();
  if (!explicitYear && monthIndex > now.getUTCMonth()) year -= 1;

  return {
    date: new Date(Date.UTC(year, monthIndex, 1, 12)),
    phrase: MONTHS[monthIndex][0].toUpperCase() + MONTHS[monthIndex].slice(1) + (explicitYear ? ` ${year}` : ""),
    approximate: true,
  };
}

// Header aliases specific to this sheet shape, merged over the generic
// ones so an operator sheet maps itself with no manual work.
export const ACCOUNT_SHEET_ALIASES = {
  account_email: ["account email", "email", "account", "login", "starlink email"],
  account_status: ["account status", "status", "state"],
  outstanding_amount: ["overdue amount", "outstanding", "balance", "amount due", "owing"],
  overdue_since: ["overdue suspended date", "overdue date", "suspended date", "overdue suspended"],
  next_due_at: ["next bill date", "next bill", "next billing date"],
  last_payment_amount: ["last payment amount", "last paid amount"],
  last_paid_at: ["last payment date", "last paid date", "last payment"],
  plan_name: ["roam plan", "plan", "plan type", "subscription type"],
  notes: ["notes", "note", "comments", "remarks"],
  password: ["password", "pass", "pwd"],
};

// True when a sheet looks like an operator account export rather than a
// generic kit list. Requires an email-ish column AND a status column,
// because either alone is common in unrelated sheets.
export function looksLikeAccountSheet(headers) {
  const norm = headers.map((h) => normalizeHeader(h));
  const hasEmail = norm.some((h) => ACCOUNT_SHEET_ALIASES.account_email.includes(h));
  const hasStatus = norm.some((h) => ACCOUNT_SHEET_ALIASES.account_status.includes(h));
  return hasEmail && hasStatus;
}

export function guessAccountSheetMapping(headers) {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(ACCOUNT_SHEET_ALIASES)) {
    const hit = normalized.find((h) => !used.has(h.raw) && aliases.includes(h.norm));
    if (hit) {
      mapping[field] = hit.raw;
      used.add(hit.raw);
    }
  }
  return { ...guessColumnMapping(headers.filter((h) => !used.has(h))), ...mapping };
}

// One account-sheet row -> kit. Same contract as parseRow: never throws,
// always reports.
export function parseAccountRow(row, mapping, { dayFirst = true, rowNumber, now = new Date() } = {}) {
  const get = (field) => (mapping[field] ? row[mapping[field]] : undefined);
  const errors = [];
  const warnings = [];
  const kit = {};

  const email = extractAccountEmail(get("account_email"));
  const rawEmail = text(get("account_email"));
  if (!email) {
    // A row with no usable email can't be identified or re-matched on a
    // later import, so it's rejected rather than imported as an
    // orphan that would duplicate itself every time the sheet is
    // re-uploaded.
    errors.push(rawEmail ? `"${rawEmail}" isn't a usable account email` : "no account email");
  }
  kit.account_email = email;
  kit.name = nameFromAccountEmail(rawEmail || email) || email;

  const status = parseAccountStatus(get("account_status"));
  kit.account_condition = status.condition;
  kit._statusBilling = status.billing;
  if (status.condition) warnings.push(`account condition: ${status.condition}`);

  const outstanding = parseAmountWithCurrency(get("outstanding_amount"));
  if (outstanding.error) warnings.push(outstanding.error);
  kit.outstanding_amount = outstanding.amount;
  kit.outstanding_currency = outstanding.currency;

  const lastPay = parseAmountWithCurrency(get("last_payment_amount"));
  kit.last_payment_amount = lastPay.amount;
  kit.last_payment_currency = lastPay.currency;

  for (const [field, target] of [["next_due_at", "next_due_at"], ["overdue_since", "overdue_since"], ["last_paid_at", "last_paid_at"]]) {
    const parsed = parseDate(get(field), { dayFirst });
    if (parsed.error) errors.push(parsed.error);
    else {
      kit[target] = parsed.value ? parsed.value.toISOString() : null;
      if (parsed.assumed) warnings.push(`date "${get(field)}" read as ${parsed.assumed}`);
    }
  }

  kit.plan_name = normalizePlan(get("plan_name"));
  kit.notes = text(get("notes"));

  const inferred = inferLastActiveFromNotes(kit.notes, now);
  if (inferred) {
    kit.last_active_at = inferred.date.toISOString();
    warnings.push(`last used read as ${inferred.phrase} from the notes - approximate`);
  }

  if (mapping.password && text(get("password"))) {
    // Reported, not silently dropped: the operator should know the
    // column was seen and deliberately not stored.
    warnings.push("password column ignored - credentials are never stored");
  }

  return { rowNumber, kit, errors, warnings, ok: errors.length === 0 };
}
