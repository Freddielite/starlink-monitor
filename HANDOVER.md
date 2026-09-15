# Starlink Monitor: Handover

Payment, hardware and usage tracking for Starlink kits across clients.
Backend: Node/Express + Postgres, deploys to Render.
Frontend: React/Vite + Leaflet, deploys to Vercel.

## The one thing that makes this work

There is no background job runner. Everything scheduled - recomputing
billing states, noticing missed heartbeats, flagging idle kits, sending
the weekly digest, pruning old heartbeats - happens when
`POST /api/cron/tick` is hit.

**You need an external, free scheduler calling it.** Recommended:
[cron-job.org](https://cron-job.org) (free, no card). Point it at:

```
https://your-backend.onrender.com/api/cron/tick?secret=YOUR_CRON_SECRET
```

A GitHub Actions `schedule:` workflow curling the same URL works
identically if you'd rather not depend on a third-party cron site.

**Every 15 minutes is plenty.** Unlike Pulse, this app isn't measuring
anything that moves in seconds - billing state changes on a scale of
days. The only thing arguing for a faster tick is heartbeat staleness:
a kit's "offline after N minutes" threshold can't meaningfully be tighter
than your tick interval, because nothing notices a missing heartbeat
between ticks. If you set a kit to 20 minutes, tick at 5-10.

Being an inbound request, the tick also keeps Render's free tier from
spinning the backend down - same side benefit Pulse relied on.

## Environment variables

### Backend (Render)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Render Postgres connection string |
| `SESSION_SECRET` | Yes | Random string, generate your own |
| `CORS_ORIGIN` | Yes | Your Vercel frontend URL, exact match |
| `NODE_ENV` | Yes | `production` |
| `FRONTEND_URL` | Yes | Signup confirmation links have nowhere to point without it - nobody can create an account |
| `CRON_SECRET` | Strongly recommended | Without it, `/api/cron/tick` is unauthenticated and anyone who finds the URL can trigger sweeps and digests |
| `SIGNUP_CODE` | Recommended | Gates signup so strangers can't create accounts on your instance |
| `BREVO_API_KEY` / `EMAIL_FROM` / `EMAIL_FROM_NAME` | For email | Free Brevo key (300/day) plus a sender verified in their dashboard. HTTP API, not SMTP - Render's free tier blocks outbound SMTP ports entirely |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | For push | Generate with `npm run gen-vapid` in `backend/` |
| `TELEGRAM_BOT_TOKEN` | For Telegram | One bot for the instance, from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Optional | Hardcodes one destination chat for the whole deployment - simplest setup for a single operator. Wins over per-user chat IDs if set |
| `NOMINATIM_CONTACT_EMAIL` | Recommended | Goes in the User-Agent on geocoding requests. Nominatim's usage policy asks for it, and an anonymous heavy user is the one most likely to get IP-blocked |

### Frontend (Vercel)

| Variable | Required | Notes |
|---|---|---|
| `VITE_API_URL` | Yes | Backend URL + `/api`, e.g. `https://your-backend.onrender.com/api` |

## Deploying

1. **Backend on Render**: new Web Service from `backend/`, build
   `npm install`, start `npm start`. Add a Render Postgres instance and
   wire `DATABASE_URL`. Set the rest above.
2. **Frontend on Vercel**: import `frontend/`, framework preset Vite. Set
   `VITE_API_URL`.
3. Once both are live, set `CORS_ORIGIN` to the real Vercel URL (not
   `*`) and redeploy.
4. Sign up through the deployed frontend (with `SIGNUP_CODE` if set).
5. Set up the external cron. **The app does nothing scheduled without
   it** - states won't advance and no alert will ever fire.
6. In Settings, turn on push and send yourself a test.

## Decisions made, and why

The spec left two open. Both were decided in the build:

**1. Built from Pulse's actual codebase, not fresh-with-Pulse-as-style-reference.**
Auth, email-verified signup, 2FA, API tokens, rate limiting, security
headers, session handling, the org/role model, and all four alert
channels came over essentially unchanged - that's several thousand lines
of already-debugged infrastructure with nothing monitor-specific in it.
The monitoring engine itself was replaced wholesale rather than adapted.

**2. Leaflet + Nominatim AND manual lat/lng, not one or the other.**
Geocoding produces candidate suggestions; you apply one, see it as a pin,
and drag or type over it. Sources are recorded (`nominatim` vs `manual`)
and surfaced in the UI, so a pin nobody has verified is visibly distinct
from one someone set deliberately. Given how weak Nominatim is on
informal Nigerian addresses, shipping it *without* the manual path would
have produced a map quietly full of city centroids.

## Known limitations, stated plainly

- **There is no Starlink API integration, and there can't easily be
  one.** SpaceX exposes no public API for consumer billing or service
  status. Billing data is entered by hand, by design, not as a stopgap.
  If you manage kits under a Starlink *Enterprise* account, their
  management API may be worth investigating as a later data source for
  the billing axis - nothing in the schema would need to change, since
  `next_due_at` doesn't care who wrote it.
- **The agent is optional and its metrics half are a stub.** The
  reachability probe in `agent/starlink-agent.js` works and is enough to
  drive the hardware axis. Reading obstruction/throughput/ping needs a
  gRPC client against the dish's **undocumented** local service on
  `192.168.100.1:9200`, which SpaceX changes between firmware releases
  without notice. `readDishStats()` is where that goes; it returns `{}`
  today and the agent is built to keep working when it fails.
- **Until the agent reports real throughput, the usage axis is driven
  entirely by the manual "mark as seen" button.** Reachability
  deliberately doesn't count as use - a powered-on dish in a locked
  office is exactly what the idle alert exists to catch.
- **Nominatim's rate limit is enforced in-process.** One backend
  instance is one process, so the ~1 req/sec gate holds. If this is ever
  scaled to multiple instances, that gate needs to become a
  database-backed token bucket or the deployment's IP will eventually be
  blocked - taking the geocoder away from every user at once.
- **Deleting a payment doesn't move the due date back.** It removes the
  log entry and says so in the timeline. Recomputing backwards would be
  guesswork (nothing records what the date was before the payment), and
  silently moving a client's due date earlier is a worse failure than
  leaving a visible date a human can correct.
- **A snoozed kit still alerts late rather than never.** Muting pauses
  notifications, and a billing transition that happens while muted is
  delivered once the mute lifts - swallowing it is how a suspension gets
  missed because someone muted the kit for an unrelated reason a week
  earlier. "Still idle", by contrast, *is* suppressed, because it's a
  standing condition that's just as true next week.
- **`SESSION_SECRET` and `CRON_SECRET` fall back to insecure defaults
  rather than refusing to boot** (inherited from Pulse). `index.js` logs
  a loud warning at boot in production if either is missing, so
  "insecure" and "configured" don't look identical in the logs. Set them.
- **Heartbeat history is pruned to 60 days**, capped at 5,000 deletions
  per tick so switching it on for an existing database can't turn one
  tick into a long-running job. The current values always live on the kit
  row regardless.
- **Org-level custom domain is a note to yourself, not a feature.**
  Carried over from Pulse: the field records what you'd need to set up
  (a CNAME plus host routing/TLS), it doesn't do any of it.

## Data model, briefly

- `kits` - one row per physical kit, with three independent state
  columns plus nullable threshold overrides. `agent_token_hash` never
  leaves the server (stripped in `publicKit()`).
- `payments` - append-only log. Separate from `kits.next_due_at` so the
  date can be corrected without rewriting history.
- `kit_events` - one timeline per kit. `actor_user_id` NULL means a sweep
  did it rather than a person, which is the distinction people actually
  ask about when reviewing a disputed change.
- `heartbeats` - raw agent reports, pruned on a cadence.
- `users` / `organizations` / `organization_members` / `org_audit_log` /
  `api_tokens` / `push_subscriptions` / `pending_signups` /
  `auth_attempts` - carried over from Pulse.

Threshold resolution is **kit override → org default → app default**,
per key independently, implemented once in
`backend/src/lib/kitStatus.js` (`resolveThresholds`). The API sends
resolved thresholds down with every kit so the frontend never
re-implements that chain.

## What was verified

Run against a real Postgres during the build, end to end:

- Due date 10 days past with a 7-day grace → `suspended`; moved to 4 days
  past → `grace`. Derivation follows the date in both directions.
- Payment recorded 4 days late → back to `active`, due date anchored to
  the old due date (not to today), payment logged with `covers_until`.
- Manual "mark down" → `offline`, source `manual`.
- Agent token issued, heartbeat accepted, kit recovered to `online`,
  throughput stored, `last_active_at` advanced. Invalid token → 401.
- `agent_token_hash` absent from every API response.
- Stale heartbeat with `alert_after_misses = 2`: tick 1 counted a miss
  and left the kit online, tick 2 flipped it to offline. Retry-before-down
  behaves as intended.
- `last_active_at` backdated 45 days → idle flagged at the 30-day
  threshold, with a timeline entry.
- Geocoder failure path returns `{ results: [], reason }` rather than an
  empty list that would read as "no such address".
- Unauthenticated `GET /api/kits` → 401.

Not verified here: live email/push/Telegram/webhook delivery (needs real
credentials), and a successful Nominatim lookup (the build sandbox
blocks outbound requests to it - the failure path was exercised instead).
