# Trackside feeds worker

This Cloudflare Worker polls the commuter railroads' GTFS-Realtime feeds, matches each train to its published
timetable, and serves the trains to the site as plain JSON, shaped like the Amtraker API the site already reads.
Some railroads (Metrolink, Caltrain via 511, Metra) need API keys, which can't go in `index.html`: GitHub Pages
serves that file to everyone. The worker holds them as secrets. It also runs Trackside accounts: see
[Accounts](#accounts) below.

```text
13 railroads' GTFS-RT ─ this worker (keys as secrets, shared cache) ─ /v1/trains, /v1/stations ─ index.html
```

## Railroads

All of them are listed in `src/agencies.js`, one entry each: the live feeds, the key if one is needed, and how
to read the timetable. Adding a railroad is a new entry there, then `npm run schedules`, `npm run timetables`
and a deploy.

| Railroad | Live feed | Key | Notes |
|---|---|---|---|
| Metrolink | Metrolink GTFS-RT | `METROLINK_API_KEY` | Metrolink's terms limit the feed to internal use; see below |
| Caltrain | 511.org | `CALTRAIN_511_KEY` | 60 requests an hour per token |
| LIRR | MTA | none | |
| Metro-North | MTA | none | Matched by train number: its trip ids aren't the timetable's |
| SEPTA Regional Rail | SEPTA | none | Predictions are delays only |
| MBTA Commuter Rail | MBTA | none | Shared feed with buses and subway; only commuter rail is kept |
| MARC | MDOT MTA | none | |
| VRE | VRE | none | Weekdays only |
| Tri-Rail | Tri-Rail | none | Its HTTPS server offers one old cipher; plain HTTP is the fallback |
| South Shore Line | ETA SPOT | none | |
| FrontRunner | UTA | none | Shared feed with buses and TRAX. No train numbers: trains are named FR + departure time (FR0657) |
| RTD commuter rail | RTD | none | Shared feed with buses. No train numbers: line + departure time (A1415) |
| Metra | Metra | `METRA_API_KEY` | Free key from metra.com/developers; left out without it |
| NJ Transit rail | NJ Transit | `NJT_USERNAME`, `NJT_PASSWORD` | Developer account from developer.njtransit.com. The feeds need a token from a sign-in, kept in D1 (`feed_tokens`), since the sign-in is limited to 10 a day. Test host by default: set `NJT_HOST` to `https://raildata.njtransit.com` with production credentials |

Not added: the 511 regional feed for ACE and SMART (it would share Caltrain's 60-an-hour quota), and subway and metro
systems, which report stop-to-stop progress rather than positions and need their own map treatment.

Before going public with Metrolink positions, note that Metrolink's license describes internal business use and
asks each app user to have their own key; ask Metrolink for written permission first. The other feeds are
published for public use; check each railroad's terms before building anything commercial.

## Where the keys live

| Place | Keys? | Committed? |
|---|---|---|
| `../.env` | Yes, on your computer | No (git-ignored, and blocked by the pre-commit hook) |
| Cloudflare Worker secrets | Yes | No (stored by Cloudflare) |
| `index.html`, `worker/src/*` | No, only the worker's URL | Yes |

Two checks stop a key from being published by mistake:

- `../deploy.mjs` refuses to upload any file that contains a key.
- `../.githooks/pre-commit` refuses commits that contain a key or a `.env` file. Turn it on in each clone with `git config core.hooksPath .githooks`.

## Deploy

```bash
cd worker
npm install
npx wrangler login   # once; opens a browser to sign in to Cloudflare (the free plan is enough)
npm run deploy       # sets up the accounts database, deploys, stores both keys as secrets,
                     # and writes the worker URL into ../index.html
```

Then publish the site as usual. Each railroad shows up as a filter chip under Explore, switched on alongside
Amtrak, and Settings gains an Account section.

To change a key later, update `../.env` and run `npm run deploy` again.

## Try it locally

```bash
npm run dev          # serves the worker and the site on http://localhost:8787 using the keys in ../.env
```

A copy of `index.html` opened from disk or `localhost` uses this local server automatically until
`FEEDS_WORKER` is set.

## Timetables

The live feeds carry only trip and stop IDs. `src/schedules.json` maps them to line names, stations and
scheduled times. It's built from each railroad's static GTFS (rail routes only, each distinct run once) and holds
only public timetable data: about 2.8 MB, 600 KB compressed, bundled into the worker. Railroads publish new
timetables every few weeks to months, so rebuild it now and then, then redeploy:

```bash
npm run schedules && npm run deploy
```

A train the bundle doesn't know is matched by its train number instead, then by the run whose times fit. If
nothing fits, a train from a rail-only feed still appears at its reported position, without its stops, as long as
that position is fresh (see [Dead trains](#dead-trains)); one from a shared feed (MBTA, FrontRunner, RTD) is left
out, since it may be a bus.

## Dead trains

Feeds don't always drop a train that has stopped running. SEPTA's has served parked consists, named by their car
numbers ("2406,2556,2502,…") and matching no timetabled trip, for a day and a half after their last report, and
Amtraker has kept a train "active" eighteen hours after its last. So a train is shown only while it's plausibly
running, whatever its feed says. These are rules, not settings:

| Rule | Worker (`src/trains.js`) | Site (`index.html`) |
|---|---|---|
| Nothing heard (no position, no prediction) for 2 hours: left out | `GONE_MS` | `GONE_MIN`, for every source, Amtraker's too |
| Only a position (no timetable match), and it's over 20 minutes old: left out | `GHOST_MS` | ghost: no estimate ahead and no report for `STALE_MIN` |
| No estimate ahead, and parked at one spot for 30 minutes: hidden | | ghost: `GHOST_MIN` |
| A report's time is the vehicle's or the prediction's, else the feed's; never the time of the request | `buildTrains` | |
| A feed whose newest report is over 2 hours old has stopped updating: its status says so | `feedSilence` | |

The status is in each `/v1/trains` response's `X-Feed-Status` header, one entry per railroad:

```bash
curl -sI https://trackside-feeds.trackside-feeds.workers.dev/v1/trains -H 'Origin: https://sm3625.github.io' | grep -i x-feed-status
```

`ok`, or `stale: …` with the reason (an upstream error, or `the feed hasn't updated in 34 h`), or `error: …`.
`npm test` here and the browser tests in `../e2e` (`dead-trains.spec.mjs`) check each rule against the cases above.

## Limits

- 511 allows 60 requests an hour per token. The worker reuses Caltrain vehicle positions for 2 minutes and
  trip updates for 4 minutes, which comes to about 45 requests an hour per Cloudflare location. If 511 refuses
  a request, the last good copy is served for up to 30 minutes.
- The other railroads are reused for 30 seconds, about their update rate.
- Workers limit the CPU time of each request (10 ms on the free plan). Decoding and matching all 13 railroads
  takes roughly 15 ms, so each railroad's built trains are cached too, and one request rebuilds at most four;
  the others are served from their last build (under 5 minutes old) until a later request gets to them.
- `ALLOWED_ORIGINS` in `wrangler.toml` lists the pages that may read the worker from a browser.

## Accounts

People can create an account with an email and password. While signed in, their saved trains, saved stations,
recently viewed trains and display settings (theme, motion, map style, list style, train labels) sync between
their devices, and they can keep trips: trains they're taking today or months ahead (see [Trips](#trips)).
Accounts are optional: signed out, the site works exactly as before, saving to the browser.

```text
index.html ──HTTPS + bearer token──▶ src/accounts.js ──▶ src/store (one interface) ──▶ a database adapter
                                       sign-up, sign-in,       │
                                       sessions, sync,         ├─ sql.js on d1.js     Cloudflare D1  (default)
                                       rate limits             ├─ sql.js on turso.js  Turso / libSQL
                                                               ├─ sql.js on local/sqlite-client.mjs  (dev, tests)
                                                               └─ memory.js           (tests only)
```

The page never talks to a database. It only knows the worker's API, so the database can change without touching
`index.html`. Inside the worker, `accounts.js` only calls the store interface documented at the top of
`src/store/index.js` (about fifteen methods: users, sessions, synced data, rate-limit attempts). All SQL lives in
`src/store/sql.js` and `migrations/`.

### API

| Request | Body | Answer |
|---|---|---|
| `POST /v1/auth/signup` | `{ email, password }` | `201 { token, user }` |
| `POST /v1/auth/login` | `{ email, password }` | `{ token, user }` |
| `POST /v1/auth/logout` | | `204` |
| `GET /v1/me` | | `{ user }` |
| `POST /v1/me/password` | `{ password, newPassword }` | `{ token, user }`, and every other device is signed out |
| `DELETE /v1/me` | `{ password }` | `204`, and the account and its synced data are deleted |
| `GET /v1/me/data` | | `{ data }` |
| `PUT /v1/me/data` | `{ data }` | `{ data }`, merged |
| `POST /v1/auth/reset` | `{ email }` | `202`, and a reset link is emailed if there's an account |
| `POST /v1/auth/reset/confirm` | `{ token, password }` | `{ token, user }`, and every other device is signed out |
| `GET /v1/me/trips` | | `{ trips }`, soonest first |
| `POST /v1/me/trips` | `{ provider, num, date, route, from, to }` | `201 { trip }` |
| `DELETE /v1/me/trips/:id` | | `204` |

Signed-in requests send `Authorization: Bearer <token>`. `data` is `{ key: { value, updatedAt } }`; for each
key the copy with the later `updatedAt` wins, so two devices can't overwrite each other's newer changes.
Errors are `{ error: { code, message } }`, and `message` is written to be shown to people.

### Database: Cloudflare D1 (default)

D1 is Cloudflare's SQLite database, free for 5 GB and 5 million reads a day. `npm run deploy` sets it up:
the first run creates a database called `trackside-accounts` and adds its binding to `wrangler.toml`, and every
run applies new files in `migrations/` before deploying.

### Switching database provider

The provider is one setting, `ACCOUNTS_DB` in `wrangler.toml`.

**To Turso** (libSQL; free tier, runs outside Cloudflare):

1. Create a database and token: `turso db create trackside` and `turso db tokens create trackside`.
2. Create the tables: `turso db shell trackside < migrations/0001_accounts.sql`.
3. Store the connection as secrets: `npx wrangler secret put TURSO_DATABASE_URL` (the `libsql://…` URL), then
   `npx wrangler secret put TURSO_AUTH_TOKEN`.
4. Set `ACCOUNTS_DB = "turso"` in `wrangler.toml` and deploy.

**To anything else** (Postgres, MongoDB, Firestore, DynamoDB…), write an adapter: a class with the methods
listed in `src/store/index.js`, or, for an SQL database, a three-method client (`all`, `run`, `batch`) for the
existing `SqlStore`, as `d1.js` and `turso.js` are. Add a case to `storeFor()` and add the adapter to the list
at the top of `test/store.test.js`; `npm test` then runs the same contract checks against it.

Existing accounts don't move by themselves: to change provider without losing them, copy the four tables
across (for D1, `npx wrangler d1 export trackside-accounts --remote --output accounts.sql` gives you SQL).

### Security

- Passwords are hashed with PBKDF2-SHA256, 100,000 iterations and a random salt. That's the most Cloudflare's
  Web Crypto allows; OWASP suggests more for PBKDF2, so the iteration count is stored with each hash and
  `PASSWORD_ITERATIONS` can raise or lower it later. Hashes are upgraded when people next sign in.
- A hash takes about 7–9 ms. The free Workers plan allows 10 ms of CPU per request, so sign-in fits, but
  narrowly. If Cloudflare reports "exceeded CPU" errors on sign-in, either move to the paid plan (30 s) or set
  `PASSWORD_ITERATIONS` lower, which weakens the hashes.
- Session tokens are 32 random bytes; only their SHA-256 is stored. They last 30 days.
- Sign-in is rate limited to 10 failed attempts per email and 50 per IP address every 15 minutes, and sign-up to
  10 accounts per IP address an hour.
- The token is kept in the browser's `localStorage`, because the site and the worker are on different domains
  and browsers block cross-site cookies. A script injected into the page could read it, so the page loads only
  pinned library versions from cdnjs and jsDelivr.
- Reset links are 32 random bytes, stored only as a SHA-256, valid once for 30 minutes, and sent in the URL
  fragment (`#reset=…`), which browsers don't send to servers. The page removes it from the address bar and
  history as soon as it loads. Asking for a link answers the same way whether or not the email has an account,
  and is limited to 3 emails per account and 10 requests per IP address an hour.

### Password reset email

Reset links need an email service. Like the database, it sits behind one small interface (`src/mail.js`: a
mailer is anything with `send({ to, subject, text, html })`), and these are built in:

| `MAIL_PROVIDER` | Free tier | Key (Worker secret) | Notes |
|---|---|---|---|
| `resend` | 3,000 emails a month | `RESEND_API_KEY` | Needs a domain you own, verified with Resend |
| `brevo` | 300 emails a day | `BREVO_API_KEY` | Can send from one verified address, so no domain is needed |
| `log` | | | Prints the email to the worker log instead: for testing only |

To switch it on: create an account with the provider, put the key in `../.env` (`RESEND_API_KEY=…` or
`BREVO_API_KEY=…`), set `MAIL_PROVIDER` and `MAIL_FROM` in `wrangler.toml` (the sender address must be one the
provider has verified), and run `npm run deploy`, which stores the key as a secret. Until then, "Forgot your
password?" explains that reset isn't set up. Another provider (Postmark, SES, MailerSend…) is a few lines in
`src/mail.js`.

## Trips

A trip is one train on one day, between the stations where someone gets on and off. People add one from a
running train's page ("Add to trips") or plan one ahead from Track a train > Plan a trip, by station or by train
number. Once the train is running, the trip shows its live times at their own stations.

Trips are stored in the accounts database (the `trips` table, `migrations/0002_trips_and_resets.sql`) through the
same store interface as everything else, so they move with it. Each is matched to the live train by railroad,
train number and the date the train leaves its first station.

Trips stay in the account after they're over: they're the person's record of rides, and the site's passport is
built from them. So only upcoming trips count toward the limit of 200, with up to 5,000 kept in all.

## Friends

People add each other by username or phone number (the Friends button at the top), and in the iOS and Android apps
from their phone's contacts. A request becomes a friendship once the other person accepts, or as soon as they ask
back. Friends see each other's upcoming trips, in Friends' trips and on the train's own page ("@ann is on this
train"); they never see each other's emails or numbers. Either side can end it at any time.

Usernames and friendships live in the `profiles` and `friendships` tables (`migrations/0003_friends.sql`), numbers
in `phones` (`migrations/0004_phones.sql`). The username is optional when signing up through the API, so older
copies of the app keep working; the site asks for one on sign-up. After signing up or in, and once per device for an
account already signed in, it asks for whatever is missing of username and number, which people can skip.

Numbers are looked up by the SHA-256 of their E.164 form (`+15551234567`), so the app sends a phone's contacts only as
hashes, and the worker answers who matches without storing what was sent. That keeps contacts out of requests and
logs, though a hash of a phone number can be reversed by trying every number, so lookups by number are rate limited
per account. Numbers are not verified: like emails, the first account to add one has it.

### Timetables

Planning ahead uses the railroads' published timetables (static GTFS), all public:

| Railroad | Source |
|---|---|
| Amtrak | https://content.amtrak.com/content/gtfs/GTFS.zip |
| VIA Rail | https://www.viarail.ca/sites/all/files/gtfs/viarail.zip |
| Brightline | https://feed.gobrightline.com/bl_gtfs.zip |
| Every railroad in `src/agencies.js` | its `gtfs.url` (Caltrain's from 511.org, with `CALTRAIN_511_KEY`) |

`npm run timetables` boils them down to `../data/timetables.json` (about 2.4 MB, 580 KB compressed), which
GitHub Pages serves next to the site and the page loads when someone opens the planner. Amtrak republishes its
feed weekly and only guarantees about a week ahead, so `../.github/workflows/timetables.yml` rebuilds the file
every Monday and commits it when it changes. It needs the repository secret `CALTRAIN_511_KEY`. The planner says
when a date is past a railroad's published range. If a railroad's feed fails, its previous timetable is kept.

### Local development and tests

```bash
npm test      # the API end to end, the store contract against memory, SQLite and a local Turso stand-in,
              # and matching live feeds to timetables
npm run dev   # serves the worker on http://localhost:8787; accounts go in .accounts-dev.sqlite (git-ignored),
              # and reset emails are printed instead of sent
```

`index.html` only uses the local server while `FEEDS_WORKER` is empty, so to try accounts locally against
`npm run dev`, blank that line in a copy of the page. The tests can't reach D1 itself; it shares `SqlStore` and
its SQL with the SQLite adapter they do run. To try D1 locally, use `npx wrangler dev` with a `[[d1_databases]]`
binding and `npx wrangler d1 migrations apply trackside-accounts --local`.

