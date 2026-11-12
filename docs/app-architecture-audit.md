# Trackside architecture audit

Written 2026-10-15 from the repository at commit `9e0bf05` plus uncommitted work in progress. Answers section 2 of
the Flighty-inspired plan. Secrets are named, never valued.

## Frontend

- **One file.** The whole site is `index.html` (6,728 lines): CSS, markup and one inline script, wrapped in a closure.
  Large datasets are embedded inline (`BASEMAP`, `RAIL_DATA`, `SPRITES`, `RIVERS`, `PLACES`).
- **Libraries** from CDNs with integrity hashes: d3 7.9, MapLibre GL 4.7, topojson-client 3.1. A Content Security
  Policy `<meta>` limits where the page can load from and send to.
- **Layout.** Desktop: a sidebar beside a full-height map. Phones: the sidebar becomes a three-position bottom sheet
  over the map. Three tabs: **Explore**, **Track a train**, **Stations**. Header buttons: Friends, Account, refresh,
  settings.
- **Hosting.** Vercel at `https://trackside-pearl.vercel.app/`, built from each push to `main` (or a `deploy.mjs`
  upload through the GitHub contents API, files listed in `DEPLOY_FILES`). `turnstile.html` is the bot-check page the apps frame.
- **No frontend build, tests or linter.** Changes are checked by hand in a browser.

## Mobile apps (`app/`)

- Capacitor 8 wrapping the same `index.html` (`app/build.mjs` copies it into `www/` and injects the Capacitor runtime
  and `TRACKSIDE_SITE_URL`). `IN_APP` switches the few app-only behaviours.
- Native projects: `app/ios` (Swift Package Manager) and `app/android`.
- Plugins: `@capacitor/app` (Android back button), `@capacitor/geolocation`, `@capacitor-community/contacts`.
  **No push, local-notification, widget or ActivityKit code.**
- **`app/` is git-ignored** (`.gitignore` line 15). The native projects have no version control or backup in this repo.

## Accounts and social

All in the Cloudflare Worker (`worker/src/accounts.js`), stored through `worker/src/store/` (D1 in production;
SQLite and memory adapters for tests).

| Capability | State |
|---|---|
| Sign-up / sign-in | Email + password (PBKDF2), bearer-token sessions (30 days, hashed in D1) |
| Bot check | Cloudflare Turnstile on sign-up (`TURNSTILE_SECRET_KEY`); apps use the framed `turnstile.html` |
| Email | Off (`MAIL_PROVIDER = ""`): no password reset, no sign-up codes |
| Settings sync | `user_data` key/value, newest wins |
| Saved trips | `trips` table: provider, train number, **service date**, departure time, JSON with route and from/to stops |
| Friends | Usernames, requests, accept/decline; friends see each other's trips (`/v1/me/friends/trips`) |
| Phone numbers | US/Canada only; saved without a code while `SMS_PROVIDER = ""`; contacts matched by SHA-256 hash |
| Sharing | Public deep links to a train (`#t-<id>`) or station (`#s-<code>`); no per-trip share links |

## Backend

- **Worker** `trackside-feeds` on `workers.dev`. Bindings: D1 `DB` (`trackside-accounts`), rate limiter
  `FEEDS_LIMIT` (120/min per address on `/v1/trains` and `/v1/stations`).
- **No cron triggers, queues, KV or Durable Objects.** Nothing runs except in response to a request.
- **Secrets (names only):** `METROLINK_API_KEY`, `CALTRAIN_511_KEY`, `METRA_API_KEY`, `NJT_USERNAME`, `NJT_PASSWORD`,
  `TURNSTILE_SECRET_KEY`; optional `TWILIO_*`, `BREVO_API_KEY`, `RESEND_API_KEY`, `TURSO_*`.
- **Migrations** `worker/migrations/0001`–`0006`, applied by `npm run deploy` (`publish.mjs`).
- **Free plan** limits that matter here: 100k worker requests/day, 50 subrequests per invocation, D1 daily read/write
  quotas, 10 ms CPU per request.

## Data sources

| Source | Fetched by | Positions | Trip updates | Alerts | Notes |
|---|---|---|---|---|---|
| Amtrak, VIA, Brightline (Amtraker API) | **the browser**, directly | Yes (Amtrak's own) | Per-stop times and estimates | Free-text `alerts` per train | Unofficial; worker never sees it |
| 14 commuter railroads (`worker/src/agencies.js`) | worker, GTFS-RT | Yes, varies by agency | Most | **Not decoded** (`gtfsrt.js` reads vehicles and trip updates only) | Caltrain via 511 is 60 req/hour; Metrolink licence is internal use only |
| NJ Transit | worker, token sign-in (10/day) | Yes | Yes | Available (`getAlerts`), not used | Test host by default (`NJT_HOST`) |
| Station metadata | `/v1/stations` + Amtraker | | | | |
| Timetables | `data/timetables.json`, rebuilt weekly by `.github/workflows/timetables.yml` | | | | For the trip planner, any date |

Positions between reports are **interpolated in the browser** along the rail network ("Positions are estimated").
Nothing records which positions were reported versus interpolated beyond that label.

## Trip identity

Trips already carry an immutable **service date**. A saved trip matches a live train by provider + plain train number
+ the service date of the train's first stop (`liveForTrip` in `index.html`). Agency `trip_id` is not stored. That
identity is unique for every railroad in the feed, including the synthesized numbers for FrontRunner (`FR0657`) and
RTD (`A1415`), so no migration is needed for Phase 1.

## Reusable pieces in `index.html`

- Trip cards with live status (`tripCard`, `liveLeg`), trip planner (`#plan` dialog), saved-trip storage
  (`saveTrip`, `tripsCache` in local storage).
- Train detail: status summary, route progress bar, full stop timetable with passed/next stops, notices
  (`classifyAlert`, `noticesHTML`), delay chart (`delayChart`), compare, follow.
- Station boards with arrivals/departures (`renderBoard`).
- Position history in IndexedDB (`hist`, this browser only) and replay.
- Friends' trips (`renderFriendTrips`), "@friend is on this train".

## Builds, tests, releases

| Part | Test | Release |
|---|---|---|
| Worker | `cd worker && npm test` (76 tests: API, stores, feeds, NJT) | `npm run deploy` (migrations, secrets, deploy) |
| Site | none automated | `node deploy.mjs` |
| Apps | none | `cd app && npm run sync`, then Xcode / Android Studio |

## Gaps the plan has to close

1. No scheduled job, so nothing can notice a delay while no one has the page open.
2. Amtrak data never reaches the worker, so any server-side alerting needs the worker to fetch Amtraker too.
3. No push infrastructure on either platform.
4. `app/` is not version-controlled.
5. No frontend tests, so a large UI restructure has no safety net.
