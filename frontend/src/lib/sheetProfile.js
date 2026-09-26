// Client-side sheet-shape detection. Only decides which mapping screen
// to show and how to pre-fill it - the server re-detects and re-parses
// everything on the request, so being wrong here costs the user a
// couple of dropdown changes, not a bad import.

function norm(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ACCOUNT_ALIASES = {
  account_email: ["account email", "email", "account", "login", "starlink email"],
  account_status: ["account status", "status", "state"],
  outstanding_amount: ["overdue amount", "outstanding", "balance", "amount due", "owing"],
  overdue_since: ["overdue suspended date", "overdue date", "suspended date", "overdue suspended"],
  next_due_at: ["next bill date", "next bill", "next billing date"],
  last_payment_amount: ["last payment amount", "last paid amount"],
  last_paid_at: ["last payment date", "last paid date", "last payment"],
  plan_name: ["roam plan", "plan", "plan type", "subscription type"],
  notes: ["notes", "note", "comments", "remarks"],
  client_name: ["client", "customer", "company"],
  city: ["city", "town", "lga"],
  region: ["region", "state", "province"],
  password: ["password", "pass", "pwd"],
};

// Both signals are required. An email column alone appears in all sorts
// of unrelated sheets, and a status column alone is even more common -
// together they're specific enough that a false positive is unlikely,
// and the user sees the result before anything is written anyway.
export function looksLikeAccountSheet(headers) {
  const normalized = headers.map(norm);
  return (
    normalized.some((h) => ACCOUNT_ALIASES.account_email.includes(h)) &&
    normalized.some((h) => ACCOUNT_ALIASES.account_status.includes(h))
  );
}

export function guessAccountMapping(headers) {
  const normalized = headers.map((h) => ({ raw: h, norm: norm(h) }));
  const mapping = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    const hit = normalized.find((h) => !used.has(h.raw) && aliases.includes(h.norm));
    if (hit) {
      mapping[field] = hit.raw;
      used.add(hit.raw);
    }
  }
  return mapping;
}
