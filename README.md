# Starlink Monitor

Tracks Starlink kits across clients: whether each one is **paid for**,
whether it's **working**, and whether anyone is actually **using it** -
as three separate answers, not one status.

Built on [Pulse](../pulse)'s codebase. The multi-tenant account/org
model, alert channels, cron-tick architecture, retry-before-down logic,
swipe actions and design system came across largely unchanged; the HTTP
/TCP/synthetic monitoring, security scanner, DNS/CT/TLS posture, status
pages and share links were stripped out.

## Why three axes

A kit's billing state, hardware state and usage state genuinely disagree
in practice, and each disagreement is a real situation someone needs to
act on:

- Paid up and **physically dead** - client is being billed for nothing.
- Online and working and **three weeks overdue** - you're funding it.
- Paid, online, and **unused since March** - the site office closed and
  nobody cancelled.

Collapsing those into one "status" forces a lie in at least one case, so
each axis has its own column, its own threshold, and its own alert.

### 1. Billing

`Active → Expiring soon → Grace → Suspended`, plus `Cancelled`.

Everything except `Cancelled` is **derived** from the kit's due date on
every sweep - the stored state is a cache of that computation, never an
independent source of truth. Correcting a wrong due date instantly
corrects the state, with no "recalculate" step for anyone to forget.

Both thresholds are configurable at three levels (kit override → org
default → app default). Grace is editable at every level because
**Starlink doesn't publish a grace period** - it's a countdown you decide
on and this app tracks, not a fact read from anywhere.

Each kit has a payment log. Recording a payment appends to the log,
advances the due date, and recomputes the state. The new date is anchored
to the *existing* due date when that's still ahead, so a client who pays
four days early keeps those four days instead of silently donating them.

### 2. Hardware

`Online / Offline / Unknown`, defaulting to **Unknown** and staying there
until something actually observes otherwise. Without an agent on the
kit's network there is no way to see hardware at all, and "Unknown" is
the honest answer - defaulting to "Online" would be a fabricated one.

Two ways it changes:

- **Manually** - someone phones in to say the dish is dead. This is the
  path most kits will only ever use.
- **By agent** (phase 2, optional) - a script on the kit's own network
  heartbeats in. Missing heartbeats past a threshold flip the kit to
  offline, but only after N consecutive missed windows (Pulse's
  retry-before-down pattern), because a satellite handover or a router
  reboot drops a heartbeat without the kit being down in any sense the
  client would recognise.

### 3. Usage / idle

`last_active_at` per kit, set by a human pressing "mark as seen" or by an
agent heartbeat that reports **real throughput** - reachability alone
doesn't count, because an idle dish in a locked office heartbeats
perfectly happily. The dashboard shows "idle 34d" and alerts past a
configurable threshold.

A kit nobody has ever marked as seen reads as "never seen", not as
infinitely idle - so switching this on for an existing fleet doesn't
flood the alert channel.

## Importing an existing fleet

Kits can be imported from CSV or Excel. The flow is deliberately three
steps - pick a file, confirm the column mapping, preview - because an
import writes to every kit at once and a silent mistake is expensive.

- **Columns are matched by name**, generously ("Monthly Cost", "Next
  Payment Date", "Town" all land correctly), and anything it gets wrong
  you remap by hand before anything is written.
- **Messy values are handled**: `NGN 38,000` / `38 000` / `1.234,56` all
  parse, as do ISO dates, `25/03/2026`, `5 Jan 2026`, and raw Excel date
  serials.
- **Ambiguous dates are reported, not guessed.** `05/03/2026` could be
  either order; you choose which, and every row that relied on that
  choice is flagged in the preview.
- **Re-importing the same sheet is safe.** Kits are matched on service
  line, or on name + client, and duplicates are skipped by default. You
  can also choose to have the sheet fill in blanks on existing kits -
  which never overwrites data you already have, since an empty cell
  means "not filled in", not "clear this".
- **All or nothing.** The whole file imports in one transaction. A
  half-finished import is worse than none, because you can't tell which
  rows landed without reading every kit.
- Imported kits get their billing state derived immediately, so anything
  already past due shows as Grace or Suspended right away rather than
  waiting for the next sweep.

Addresses without coordinates import unlocated, and there's a one-at-a-
time backfill afterwards - bulk geocoding is precisely what Nominatim's
rate limit forbids, so it runs at about a second each, can be stopped,
and can be resumed later.

### Operator account sheets

The importer recognises the shape an operator's own Starlink records
actually take - one row per **account login**, Starlink's own status
wording, balances in mixed currencies - and switches to a different
mapping automatically when it sees an email column and a status column
together.

What it does with that shape:

- **Identity is the account email.** Nobody names these kits; the login
  is the identifier, and it's the only value stable enough that
  re-uploading next month's copy updates the fleet instead of doubling
  it. A display name is derived from the local part (or from a
  `(Chief Soso Office)` style prefix where one exists).
- **Passwords are never stored.** Operator sheets routinely carry them.
  The column is read, ignored, and reported as ignored. A tracking tool
  has no use for a credential that grants full control of the service,
  and holding it would turn a database leak into a fleet takeover.
- **Status is split in two.** `Overdue` and `Suspended (Billing)` are
  billing states. `Email Not Found`, `No Device`, `Transferred`,
  `Restricted (Location)` are not - they're problems with the record,
  and they go in a separate `account_condition` field with its own
  count and filter on the dashboard. Collapsing them would make an
  unverifiable account look healthy.
- **Currency is read per row.** `€95`, `₦49,000` and `34,000 HUF` in one
  column is normal, and what's owed travels with its own currency
  rather than being assumed from the kit.
- **Usage is mined from the notes.** "Last used in March" / "Not in use
  since January" is the only usage signal these sheets carry, so it's
  parsed into `last_active_at` and marked approximate. Without it the
  idle axis would sit empty on a fleet that is visibly full of idle kits.
- **Re-importing reflects good news.** A cleared balance or a resolved
  condition goes back to empty on update, rather than being pinned at its
  old value the way a blank-means-ignore rule would.

## Location and the map

Structured location per kit (address / city / region / country / lat /
lng), so the dashboard can filter by place. Map view is Leaflet +
OpenStreetMap tiles with pins coloured by billing or hardware state,
list/map toggle, and filters for client, place and status.

**The whole map stack is free and keyless** - no API key to rotate, no
billing account to accumulate a surprise. The cost of that is stated
rather than discovered:

- OSM tiles look plainer than Google's.
- Nominatim geocoding is capped at ~1 request/second (enforced
  server-side) and is noticeably weaker on informal or non-standard
  addresses. For something like *"opposite the filling station, Ago
  Palace Way"* it will often return nothing, or the centroid of the
  wider area with high confidence.

So geocoding returns **suggestions you confirm**, never something written
silently to the kit, and manual lat/lng entry is a first-class path: the
form has a draggable/tappable pin and editable coordinate fields, and the
detail view says whether a pin was auto-derived or set by hand.

## Alerts

Reuses Pulse's channels - email (Brevo), web push, Telegram, and generic
webhook (Slack/Discord/PagerDuty/anything that takes a JSON POST). Five
event kinds, each independently switchable per channel: expiring soon,
grace, suspended, hardware down/back, idle.

Alerts fire on **transitions**, tracked separately from the state itself,
so a kit sitting in grace for four days alerts once rather than once per
sweep. Muting a kit pauses its notifications without pausing its
tracking - the dashboard still shows the truth.

There's also an opt-in weekly digest: a summary of what's *outstanding
now* (overdue, offline, idle) rather than a replay of alerts you already
received.

## Teams

Personal kits work with no org at all. Create one and it's the same three
roles as Pulse: **owner** (delete the org, change roles), **admin**
(invite/remove members, set the org's default thresholds, add kits,
manage any kit the org owns), **member** (see every kit and get alerted
for all of them, manage only ones they created).

The read/write split matters more here than it did in Pulse, because the
mutations include recording money changing hands. A member seeing that a
client is two weeks overdue is the point of being on the team; a member
marking that client as paid is not.

## Stack

- **Backend**: Node/Express on Render.
- **Database**: Supabase Postgres, reached through their connection
  pooler (Render's egress is IPv4; Supabase's direct host is IPv6-only).
- **Frontend**: React + Vite + Leaflet, deploys to Vercel. Installable
  PWA with offline fallback, push, and an app-icon badge.
- **No background job runner** - everything scheduled happens through one
  endpoint, `POST /api/cron/tick`, hit by a free external scheduler. See
  `HANDOVER.md`.

```
backend/
  src/
    routes/    auth, kits, agent, organizations, push, telegram, tokens, cron
    lib/       kitStatus (the state rules), sweeps (the engine), geocode,
               digest, mailer, telegram, webPush, webhook, orgAccess
    db.js      schema + migrations, run automatically on boot
frontend/
  src/
    components/  Dashboard, KitCard, KitDetail, KitForm, FleetMap, Settings
    lib/         kitDisplay.js (labels/colours only - no rules)
    api.js       all backend calls
agent/
  starlink-agent.js   optional kit-side heartbeat script
HANDOVER.md      deployment, env vars, known limitations
```

## Running it locally

```bash
# Backend
cd backend
npm install
# create backend/.env with:
#   DATABASE_URL=postgresql://user:pass@localhost:5432/slm_dev
#   (or a Supabase pooler string - see backend/.env.example)
#   SESSION_SECRET=any-random-string
#   NODE_ENV=development
#   PORT=4000
npm run dev

# Frontend, second terminal
cd frontend
npm install
npm run dev
```

The frontend dev server proxies `/api` to `localhost:4000`. Tables are
created on the backend's first boot.

No cron runs locally, so nothing sweeps on its own - hit
`http://localhost:4000/api/cron/tick` yourself whenever you want to force
a pass.
