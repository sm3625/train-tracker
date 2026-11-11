# Trackside

An unofficial live map of Amtrak, VIA Rail, Brightline and U.S. commuter rail trains, with a trip planner, saved
trains and stations, and optional accounts that sync between devices.

Live at **https://trackside-pearl.vercel.app/**, and packaged as an iOS and Android app.

## How it fits together

```text
Amtraker API (Amtrak, VIA, Brightline) ────────────────────────────────┐
                                                                       ▼
13 commuter railroads' GTFS-RT ─▶ worker/ (Cloudflare Worker) ─▶ index.html ◀─ data/timetables.json
                                   feeds, accounts, friends          │
                                   D1 database, keys as secrets      └─▶ app/ (Capacitor: iOS, Android)
```

| Part | What it is | Docs |
|---|---|---|
| `index.html` | The whole site: one file with its CSS, markup and script. No build step. Libraries (MapLibre GL, d3, topojson) come from CDNs with integrity hashes | |
| `data/timetables.json` | Every railroad's timetable, boiled down for the trip planner. Rebuilt weekly | |
| `worker/` | Cloudflare Worker: reads the commuter railroads' live feeds (some need API keys, which can't go in a public page), matches trains to timetables, and runs accounts, trips and friends | [worker/README.md](worker/README.md) |
| `app/` | The same page wrapped as a native app with Capacitor | [app/README.md](app/README.md) |
| `e2e/` | Playwright browser tests on a desktop window and a phone screen, using recorded feed data | |
| `docs/` | Design notes: [architecture audit](docs/app-architecture-audit.md), [feed reliability](docs/feed-reliability.md), [implementation plan](docs/implementation-plan.md) | |

## Running it locally

Needs Node 22 or newer.

```bash
cd worker
npm install
npm run dev        # the worker and the site together on http://localhost:8787, using the keys in ../.env
```

A copy of `index.html` opened from disk or `localhost` uses this local worker automatically. Without any keys, the
railroads that need one (Metrolink, Caltrain, Metra, NJ Transit) are left out and the rest still work.

## Keys and secrets

Copy `.env.example` to `.env` and fill in what you need. `.env` is git-ignored, and it is the only place keys live on
your computer; in production they are Cloudflare Worker secrets. Two checks keep them from being published:

- `.githooks/pre-commit` refuses commits that contain a `.env` file or any key's value. Turn it on once per clone:
  `git config core.hooksPath .githooks`
- `deploy.mjs` refuses to upload a file that contains a key.

See [Where the keys live](worker/README.md#where-the-keys-live) for the full list.

## Tests

```bash
cd worker && npm test              # feeds, matching, accounts, store adapters (node --test)
cd e2e && npm install && npm test  # browser tests; uses the Chrome you have installed
```

Both run on every push and pull request (`.github/workflows/tests.yml`). The browser tests need no keys and no live
trains: they use the fixtures in `e2e/fixtures/` and a local copy of the worker.

## Deploying

1. **Worker first**, so the page never calls routes that don't exist yet:
   `cd worker && npm run deploy`. This sets up the D1 database, applies migrations, uploads the keys from `.env` as
   secrets and deploys. The first time, run `npx wrangler login`.
2. **The site**: push to `main` (GitHub Pages), or run `node deploy.mjs "message"` to upload the files in
   `DEPLOY_FILES` through the GitHub API. `.vercelignore` limits a Vercel deploy to `index.html` and `data/`.
3. **The apps**: `cd app && npm run sync`, then build from Xcode or Android Studio. See
   [app/README.md](app/README.md), including what to do before a store release.

## Timetables

Railroads publish new timetables every few weeks; Amtrak's covers only about a week ahead. Every Monday,
`.github/workflows/timetables.yml` rebuilds `data/timetables.json` and `worker/src/schedules.json`, runs the tests,
commits what changed and redeploys the worker. It needs the repository secrets listed at the top of that file. To
run it by hand after a schedule change:

```bash
cd worker
npm run timetables   # the trip planner's timetables
npm run schedules    # what the worker matches live trains against
npm run deploy
```

## Data sources and terms

Amtrak, VIA Rail and Brightline positions come from the unofficial [Amtraker API](https://api-v3.amtraker.com). The
commuter railroads come from their own GTFS-Realtime feeds, listed in `worker/src/agencies.js` and in
[worker/README.md](worker/README.md#railroads). Metrolink's terms limit its feed to internal use, so get Metrolink's
permission (or hide it with `HIDDEN_PROVIDERS` in `index.html`) before publishing anything public with it. Check each
railroad's terms before building anything commercial.  

Trackside isn't affiliated with any railroad.


## TODO
Fix MBTA   
Make a history section - average delay on a route. 
