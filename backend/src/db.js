import pg from "pg";

const { Pool } = pg;

// Any hosted Postgres requires SSL, but a plain local Postgres during dev
// doesn't speak SSL at all and will hang if you ask for it. Detect
// local-vs-hosted from the connection string itself so one config works
// for both without an extra env var to keep in sync.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

// The backend runs on Render; the database is Supabase. Two things about
// that pairing that aren't obvious and both fail in quiet ways:
//
// 1. Supabase's DIRECT connection host (db.<ref>.supabase.co) resolves
//    to IPv6 only on projects created since early 2024. Render's egress
//    is IPv4, so a direct connection string just times out on connect -
//    with an error that reads like a firewall problem, not an address
//    family problem. The pooler host (aws-0-<region>.pooler.supabase.com)
//    is dual-stack and is what should be used from Render.
//
// 2. The pooler offers two modes on two ports, and the choice is not
//    cosmetic. SESSION mode (5432) hands out a dedicated backend for the
//    life of the connection. TRANSACTION mode (6543) can hand a
//    different backend to every statement, which breaks anything
//    session-scoped. This app deliberately relies on NO session state
//    (see the cron_locks table below for the one place it used to), so
//    either port works - but 5432 is the simpler default.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Supabase's pooler closes idle client connections on its own, and the
  // free tier's connection budget is shared across everything touching
  // the project. Ten is plenty for this workload (the heaviest thing it
  // does is a sweep over a few hundred rows) and leaves headroom for
  // the Supabase dashboard and any SQL console sitting open.
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// An idle pooled client dropped by the far end emits 'error' on the pool.
// Without a listener that's an unhandled error event, which takes the
// whole process down - so a routine, expected disconnect would read in
// the Render logs as a crash. Logged and swallowed: node-postgres
// discards the broken client and the next query gets a fresh one.
pool.on("error", (err) => {
  console.error("Idle Postgres client error (connection was dropped, pool will recover):", err.message);
});

export async function migrate() {
  await pool.query(`
    -- Supabase ships pgcrypto pre-installed (in the 'extensions'
    -- schema), so this is a no-op there rather than a privilege problem:
    -- IF NOT EXISTS matches on the extension name regardless of which
    -- schema it lives in. Kept anyway so a plain self-hosted Postgres
    -- still works from a blank database.
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- ===================================================================
    -- Accounts, orgs, alert channels
    -- Carried over from Pulse essentially unchanged: this app has the
    -- same multi-tenant shape (personal account, optional shared org)
    -- and the same alert channels, and there was nothing monitor-
    -- specific in either.
    -- ===================================================================

    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      alert_email   TEXT,
      telegram_chat_id TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT;

    -- Weekly digest: one summary of every kit's billing/hardware/idle
    -- state. digest_sent_at is the "already went out this week" guard,
    -- digest_day_of_week (0=Sunday..6=Saturday, matching JS's own
    -- Date.getDay() so the frontend needs no lookup table) is the
    -- schedule.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_day_of_week SMALLINT NOT NULL DEFAULT 0;

    -- Per-channel, per-event-kind opt-outs for push, Telegram and
    -- webhook (email stays all-or-nothing via alert_email). The event
    -- keys are this app's, not Pulse's: expiring / grace / suspended /
    -- hardware / idle, which are exactly the five things a sweep can
    -- decide to wake someone up about. Missing keys default to true -
    -- see lib/notificationPrefs.js, the only place that reads this
    -- column, so the default shape only has to be right in one place.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{
      "push": {"expiring": true, "grace": true, "suspended": true, "hardware": true, "idle": true},
      "telegram": {"expiring": true, "grace": true, "suspended": true, "hardware": true, "idle": true},
      "webhook": {"expiring": true, "grace": true, "suspended": true, "hardware": true, "idle": true}
    }'::jsonb;

    -- TOTP two-factor auth. totp_pending_secret holds a freshly
    -- generated secret between "start setup" and "confirm with a code"
    -- so an abandoned setup never leaves 2FA required with no way to
    -- produce a valid code.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB;

    -- express-session's connect-pg-simple store creates/manages its own
    -- table on boot (see index.js), so it isn't defined here.

    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      brand_name TEXT,
      brand_logo_url TEXT,
      brand_accent_color TEXT,
      custom_domain TEXT,
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Org-level defaults for the three tracking axes. These are the
    -- middle layer of a three-level resolution (kit override -> org
    -- default -> hardcoded constant in lib/kitStatus.js); see
    -- resolveThresholds() there, which is the only place that reads
    -- them. Grace in particular has to live somewhere editable because
    -- Starlink doesn't expose a grace period at all - it's a countdown
    -- you decide on and this app tracks, not a fact it reads.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_grace_days INTEGER NOT NULL DEFAULT 7;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_expiring_soon_days INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_idle_alert_days INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_offline_after_min INTEGER NOT NULL DEFAULT 20;

    -- Membership is separate from ownership: owner_user_id above is who
    -- can delete the org outright, this table is who can see/use it and
    -- at what role. A row with user_id NULL and invited_email set is a
    -- pending invite, claimed the moment an account with that email
    -- exists.
    CREATE TABLE IF NOT EXISTS organization_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      invited_email TEXT,
      role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT member_identity_present CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_user ON organization_members(organization_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_invite ON organization_members(organization_id, invited_email) WHERE invited_email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

    CREATE TABLE IF NOT EXISTS org_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_org_audit_log_org_time ON org_audit_log(organization_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint      TEXT NOT NULL UNIQUE,
      p256dh        TEXT NOT NULL,
      auth          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      token_prefix  TEXT NOT NULL,
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);

    CREATE TABLE IF NOT EXISTS auth_attempts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket      TEXT NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket_time ON auth_attempts(bucket, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS pending_signups (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      alert_email    TEXT,
      token_hash     TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
    );
    CREATE INDEX IF NOT EXISTS idx_pending_signups_token_hash ON pending_signups(token_hash);

    -- ===================================================================
    -- Kits: the thing this app actually tracks
    --
    -- One row per physical Starlink kit. The central design decision is
    -- that a kit has THREE independent state machines, not one overall
    -- "status", because in practice they genuinely disagree: a kit can
    -- be fully paid up and physically dead, or online and working and
    -- three weeks past its due date, or paid and online and not used by
    -- anyone in two months. Collapsing those into a single status field
    -- would force a lie in at least one of those cases, so each axis
    -- gets its own column, its own threshold, and its own alert.
    -- ===================================================================

    CREATE TABLE IF NOT EXISTS kits (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Creator. Kept separate from organization_id the same way
      -- monitors.user_id was in Pulse: a kit with organization_id NULL
      -- is personal, and its creator can always manage it regardless of
      -- org role.
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id   UUID REFERENCES organizations(id) ON DELETE SET NULL,

      name              TEXT NOT NULL,
      -- Who this kit is deployed for. A plain string rather than a
      -- clients table, for the same reason Pulse's group_name was a
      -- plain string: the dashboard needs to group and filter by it,
      -- nothing needs to join on it, and a clients table would be a
      -- second thing to keep in sync for no gain at this size. Promote
      -- it later if clients ever need their own attributes.
      client_name       TEXT,
      -- Starlink's own identifiers, free text because they're only ever
      -- displayed and searched, never parsed.
      service_line      TEXT,
      kit_serial        TEXT,
      hardware_model    TEXT,
      notes             TEXT,

      active            BOOLEAN NOT NULL DEFAULT true,
      -- Mutes every alert for this kit until it passes, then resumes on
      -- its own. Same shape and same reasoning as Pulse's
      -- monitors.snoozed_until: silence during a known situation (a
      -- client who's told you they're paying on Friday) shouldn't
      -- require remembering to turn alerts back on afterwards.
      snoozed_until     TIMESTAMPTZ,

      -- ---------------- Axis 1: billing ----------------
      -- active -> expiring_soon -> grace -> suspended, plus cancelled
      -- as a terminal state set by hand. Everything except cancelled
      -- and a manual suspend is DERIVED from next_due_at on each sweep
      -- (see lib/kitStatus.js deriveBillingState), so the stored value
      -- is a cache of a computation, not an independent source of
      -- truth. That's deliberate: it means the state can never drift
      -- from the date it's supposed to describe, and the only thing a
      -- user has to keep accurate is the due date itself.
      billing_state     TEXT NOT NULL DEFAULT 'active',
      next_due_at       TIMESTAMPTZ,
      last_paid_at      TIMESTAMPTZ,
      plan_name         TEXT,
      plan_amount       NUMERIC(12,2),
      plan_currency     TEXT NOT NULL DEFAULT 'NGN',
      -- monthly | 30_day | custom. Drives how far forward "mark paid"
      -- pushes next_due_at by default; the user can always override the
      -- resulting date.
      billing_cycle     TEXT NOT NULL DEFAULT 'monthly',
      billing_cycle_days INTEGER,
      -- Per-kit overrides for the two billing thresholds. NULL means
      -- "use the org default, or the app default if there's no org" -
      -- see resolveThresholds() in lib/kitStatus.js.
      grace_days        INTEGER,
      expiring_soon_days INTEGER,
      billing_state_changed_at TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      -- The billing state the last alert went out for. Alerts fire on
      -- the TRANSITION only - this is what makes a kit sitting in
      -- 'grace' for four days alert once rather than once per sweep.
      -- Same self-quieting shape as Pulse's content_hash.
      billing_alerted_state TEXT,

      -- ---------------- Axis 2: hardware ----------------
      -- online | offline | unknown. Defaults to unknown and STAYS
      -- unknown until something actually says otherwise, because
      -- without an agent on the kit's network this app has no way to
      -- observe hardware at all. "Unknown" is an honest answer;
      -- defaulting to "online" would be a fabricated one.
      hardware_state    TEXT NOT NULL DEFAULT 'unknown',
      -- manual | agent. Which of the two ways below last set the state,
      -- so the UI can say "marked down by Ade 3 days ago" vs "no
      -- heartbeat since 14:02".
      hardware_source   TEXT,
      hardware_note     TEXT,
      hardware_state_changed_at TIMESTAMPTZ,
      hardware_alerted_state TEXT,

      -- Phase 2 agent. agent_token_hash is the credential a kit-side
      -- agent posts heartbeats with - only the hash is stored, same
      -- treatment as api_tokens.token_hash, since a database dump
      -- shouldn't hand out working heartbeat credentials that could be
      -- used to fake a kit being up. agent_enabled is separate from
      -- "has a token" so an agent can be paused without regenerating.
      agent_enabled     BOOLEAN NOT NULL DEFAULT false,
      agent_token_hash  TEXT UNIQUE,
      agent_token_prefix TEXT,
      last_heartbeat_at TIMESTAMPTZ,
      -- Minutes without a heartbeat before the kit is considered
      -- offline. NULL = org default = app default.
      offline_after_min INTEGER,
      -- Retry-before-down, carried over from Pulse's
      -- alert_after_failures/consecutive_failures: N consecutive missed
      -- heartbeat windows before the state actually flips and an alert
      -- fires. A Starlink kit on a rural link drops a heartbeat now and
      -- then without being down, and a monitoring tool that cries wolf
      -- gets muted, which is worse than being slightly late.
      alert_after_misses INTEGER NOT NULL DEFAULT 2,
      consecutive_misses INTEGER NOT NULL DEFAULT 0,
      -- Last values the agent reported, kept on the row for the fast
      -- "what does it look like right now" read. History lives in
      -- heartbeats below.
      last_obstruction_pct NUMERIC(6,3),
      last_downlink_mbps   NUMERIC(8,2),
      last_uplink_mbps     NUMERIC(8,2),
      last_ping_ms         INTEGER,
      agent_meta        JSONB,

      -- ---------------- Axis 3: usage / idle ----------------
      -- The last time this kit was known to be actually in use, as
      -- opposed to merely paid for and powered on. Set by an agent
      -- heartbeat that reports real throughput, or by a human pressing
      -- "mark as seen". NULL means never seen, which the dashboard
      -- reports as "never" rather than as infinitely idle.
      last_active_at    TIMESTAMPTZ,
      idle_alert_days   INTEGER,
      -- When the idle alert last fired. Unlike billing/hardware, idle
      -- isn't a state machine with transitions to key off, so this is
      -- the "don't repeat more than once per threshold window" clock -
      -- see IDLE_REALERT_DAYS in lib/sweeps.js.
      idle_alerted_at   TIMESTAMPTZ,

      -- ---------------- Location ----------------
      -- Structured rather than one address blob, because the dashboard
      -- filters on city/region and those filters are worthless if the
      -- data is a free-text line each person formats differently.
      address           TEXT,
      city              TEXT,
      region            TEXT,
      country           TEXT,
      latitude          NUMERIC(9,6),
      longitude         NUMERIC(9,6),
      -- nominatim | manual | NULL. Worth storing because a Nominatim
      -- result for an informal address can be confidently wrong (it
      -- will happily return the centroid of a city for something it
      -- didn't really understand), and knowing a pin was auto-derived
      -- rather than typed by someone who's been there is the difference
      -- between trusting it and checking it.
      geocode_source    TEXT,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_kits_user_id ON kits(user_id);
    CREATE INDEX IF NOT EXISTS idx_kits_organization ON kits(organization_id);
    CREATE INDEX IF NOT EXISTS idx_kits_next_due ON kits(next_due_at) WHERE active = true;
    -- Partial index for the agent heartbeat lookup, which is by token
    -- and only ever matches a kit that actually has one.
    CREATE INDEX IF NOT EXISTS idx_kits_agent_token ON kits(agent_token_hash) WHERE agent_token_hash IS NOT NULL;

    -- Payment log. One row per payment actually received, which is
    -- separate from kits.next_due_at (the forward-looking date): the
    -- date can be corrected by hand without rewriting history, and the
    -- history survives the date being corrected. covers_until records
    -- what the payment was understood to buy at the time it was
    -- recorded, so a later change to next_due_at doesn't silently
    -- rewrite what someone was told when they paid.
    CREATE TABLE IF NOT EXISTS payments (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id        UUID NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
      recorded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      paid_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      amount        NUMERIC(12,2),
      currency      TEXT NOT NULL DEFAULT 'NGN',
      method        TEXT,
      reference     TEXT,
      covers_until  TIMESTAMPTZ,
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payments_kit_time ON payments(kit_id, paid_at DESC);

    -- One chronological record per kit of everything that changed, on
    -- any of the three axes plus location and ownership. Same reasoning
    -- as Pulse's security_events table: the current state answers "how
    -- is it right now", and the question anyone actually asks during a
    -- dispute is "what changed, when, and who did it". One table rather
    -- than one per axis means the UI has a single thing to render and
    -- any new detector gets the timeline for free.
    CREATE TABLE IF NOT EXISTS kit_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id        UUID NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- kit_created | billing_state_changed | payment_recorded |
      -- due_date_changed | hardware_state_changed | heartbeat_resumed |
      -- marked_seen | idle_flagged | location_updated | agent_token_issued
      kind          TEXT NOT NULL,
      severity      TEXT NOT NULL DEFAULT 'info', -- critical | high | medium | low | info
      title         TEXT NOT NULL,
      detail        TEXT,
      data          JSONB,
      -- NULL for anything a sweep did on its own rather than a person.
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kit_events_kit_time ON kit_events(kit_id, created_at DESC);

    -- Raw agent heartbeats. The kit row holds the latest values for the
    -- fast read; this keeps the trail so the detail view can chart
    -- obstruction and throughput over time, and so "it was fine until
    -- Tuesday" is answerable after the fact. Pruned on a cadence rather
    -- than kept forever - see pruneHeartbeats() in lib/sweeps.js.
    -- Lease-based lock for the cron tick, replacing the session-scoped
    -- pg_advisory_lock this used to hold.
    --
    -- The advisory lock was correct against a directly-connected
    -- Postgres and silently wrong behind a connection pooler in
    -- transaction mode: the acquire and the release are two separate
    -- statements, and transaction pooling is free to run them on
    -- different backend connections. The release would then no-op
    -- against a connection that never held anything, leaving the lock
    -- held forever on the original backend - so every subsequent tick
    -- would answer {"skipped": true} and nothing would ever sweep again,
    -- with no error anywhere to explain it.
    --
    -- A row with an expiry is immune to all of that: acquiring is one
    -- atomic statement (see routes/cron.js), it doesn't care which
    -- backend runs it, and a tick that dies mid-run frees the lock when
    -- its lease runs out rather than wedging the app. The cost versus an
    -- advisory lock is that crash recovery takes until the lease expires
    -- instead of being instant on disconnect - acceptable when ticks run
    -- every few minutes and finish in seconds.
    CREATE TABLE IF NOT EXISTS cron_locks (
      name        TEXT PRIMARY KEY,
      held_until  TIMESTAMPTZ NOT NULL,
      -- Identifies the run holding the lease, so a tick that overran its
      -- lease can't release a lock a different instance has since
      -- legitimately taken.
      holder      TEXT
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id          UUID NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
      received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      obstruction_pct NUMERIC(6,3),
      downlink_mbps   NUMERIC(8,2),
      uplink_mbps     NUMERIC(8,2),
      ping_ms         INTEGER,
      uptime_sec      BIGINT,
      -- Whatever else the agent chose to send (dish state, software
      -- version, alert flags from the local API). Free shape: it's only
      -- ever displayed, and pinning a schema to a local diagnostic API
      -- that isn't a documented contract would break on their next
      -- firmware update.
      raw             JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeats_kit_time ON heartbeats(kit_id, received_at DESC);
  `);
}
