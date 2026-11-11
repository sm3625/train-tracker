# Typical delays: a plan

Show how late a regularly scheduled train usually runs, at the rider's own stops. For example: "Train 171 usually
reaches New York 6 min late. On time 7 trips in 10, based on 34 trips in the last 45 days." It would appear on the
train's page, on trip cards and in the trip planner's results, where it helps pick between two trains.

Everything here runs on **Workers Free**. The free plan's limit is 10 ms of CPU per run, so the work is spread over
many small runs.

Written 2026-11-09. Read with [implementation-plan.md](implementation-plan.md); its Phase 2 alert engine can share
the same scheduled job later.

## What exists today

- **Live delays only.** `/v1/trains` and Amtraker report each train's current times. Nothing is kept once a train
  finishes.
- **The page's own record** (`hist` in `index.html`) keeps positions and delays for six hours, in one browser. That
  isn't enough history, and every visitor sees a different slice.
- **The worker** builds each railroad's trains when a page asks (`railroad()` in `worker/src/index.js`) and keeps
  the builds in Cloudflare's Cache API. It has no scheduled job. D1 holds accounts only.
- **Train identity** is already stable enough: provider + train number. FrontRunner and RTD have no numbers, so
  their names come from the line and departure time (FR0657, A1415), which stay the same until the timetable
  changes.

So the history has to be recorded on the server, starting from launch day. There's nothing to backfill from.

## The key fact: some feeds keep passed stops, some don't

Measured on the recorded feeds in `e2e/fixtures/`. That's one moment (2026-10-15 19:32 UTC), with about 6 trains
per commuter railroad, so the split should be confirmed over a full day before relying on it (Phase 1).

| Kind | Times for stops already passed | Railroads |
|---|---|---|
| **Keeps them** | 100% | Amtrak, VIA, LIRR, Metro-North, NJ Transit, MARC, VRE |
| **Drops them** | 0–5% | MBTA, Metra, SEPTA, Caltrain, Tri-Rail, RTD, South Shore Line |
| **Partly** | 35% | Metrolink |
| Not in the sample | — | FrontRunner; Brightline (never marks stops as passed, so treated as "drops them") |

- **Railroads that keep them:** the last copy of a trip before it leaves the feed has the real time at every stop.
  Reading it occasionally is enough, and the result is exact.
- **Railroads that drop them:** each stop's time disappears once the train passes it, so the recorder has to catch
  the stop's last estimate beforehand. Reading every few minutes, the recorded time is the train's own estimate a
  few minutes before it left, which is usually within a minute or so. These delays are labelled as estimates.
- **Metrolink and anything uncertain:** treated as "drops them", using a real time wherever one is present.

## What a "typical delay" is

| Choice | Recommendation | Why |
|---|---|---|
| Which number to lead with | The **median** delay, with the **on-time share** next to it (decided) | One 3-hour breakdown drags a mean far from what riders see. The site already calls 5 min or less on time (`sig()`), so the share uses the same rule |
| Mean | Kept in the data, not shown | Can be shown later if wanted |
| Bad days | "1 trip in 10 is 25+ min late" (the 90th percentile), shown when it's 15 min or more | Says how bad it gets without one outlier speaking for the train |
| Where it's measured | At **each stop**: departure at the rider's station, arrival at their stop | A train can leave on time and arrive 20 min late. A single per-train number would mislead |
| What counts as the same train | Provider + train number + **day type** (weekday, Saturday, Sunday) (decided) | Commuter numbers repeat every weekday. Weekend trains often run a different pattern under the same number |
| Window | The last **45 days** (decided) | Enough trips for a fair sample, even for a weekend-only train (about 12 Saturdays or Sundays). Long-running track work still shows, which riders should know about |
| Minimum sample | **8 trips** in the window, else show nothing | Fewer than that is an anecdote |
| Timetable changes | Use only trips whose scheduled time at that stop is within 5 min of today's timetable | A retimed train's old delays describe a different schedule |
| Cancellations | Left out of the delay, counted separately ("cancelled 2 of the last 45 days") | A cancelled train has no delay |

Wording follows the existing ground rules: a typical delay is history, never a prediction. It always says how many
trips it's based on, and that Trackside recorded them.

## How it works

```text
every minute (cron), what fits in ~6 ms              once a night (cron)               page
┌─────────────────────────────────────┐             ┌────────────────────────┐        ┌────────────────────────┐
│ recorder                            │  finished   │ rollup                 │ stats  │ GET /v1/delays?keys=…  │
│ - pick the railroads most due       │  trips      │ - last 45 days of runs │ ─────▶ │ train page, trip card, │
│ - use visitors' cached build if     │ ──────────▶ │ - median, p90, on-time │  D1:   │ planner results        │
│   fresh, else a light decode        │  D1: runs   │   per train, day type, │  delay │                        │
│ - update each trip's working copy   │             │   stop                 │  _stats│                        │
│ - write a trip once it leaves feed  │             └────────────────────────┘        └────────────────────────┘
└─────────────────────────────────────┘
```

### 1. The recorder: one small run a minute

A scheduled worker job (`[triggers] crons = ["* * * * *"]`, `scheduled()` in `worker/src/index.js`) runs every
minute. The 10 ms CPU limit applies to each run, not to the day, so each run does only a small piece:

1. **Picks the most overdue sources that fit in the run's CPU budget** (`due()`). Each source has a measured cost
   (see below); a run takes up to about 6 ms of them, so the heaviest (Amtraker, LIRR, Metro-North, NJ Transit) are
   read alone and the light ones share a run. Railroads that drop passed stops are read about every 5 minutes,
   railroads that keep them every 15, and a source whose last read had nothing running every 15.
2. **Reuses visitors' work where it can.** If a page request built that railroad's trains in the last 90 s and the
   build is in this data centre's cache, the recorder reads it instead of decoding the feed. Scheduled runs don't
   always land in the same data centre as visitors, so this saves CPU only some of the time.
3. **Otherwise decodes lightly.** The recorder only needs predicted times, so it fetches only the trip-updates feed
   and skips the vehicle-position feed and position matching.
4. **Updates a working copy of each trip**, kept in D1 (`recorder_state`, one row per source, rewritten on each
   read). The Cache API was the first idea, but it's separate in each data centre, and scheduled runs move between
   them, so the trips in progress would often be lost. Each stop keeps its real time if the feed gave one, else the
   last estimate seen before the train passed it.
5. **Writes a trip once.** When a trip has left the feed past its timetabled end, or been gone 30 min, it becomes
   one row in `runs`, written together with the new working copy. A railroad whose feed is down is marked read
   anyway, so it doesn't take every turn from the others.

New migration `0008_delay_history.sql`:

```sql
CREATE TABLE runs (               -- one finished trip (as built: see the migration for every column)
  provider, train_num, service_date, day_type, cancelled, recorded_at,
  stops TEXT NOT NULL,            -- JSON: [[code, scheduled departure ms, arrival delay, departure delay, 'r' | 'e'], …]
  PRIMARY KEY (provider, train_num, service_date)
);
CREATE TABLE recorder_state (     -- the recorder's working copies, one row per source
  source TEXT PRIMARY KEY, read_at INTEGER, idle INTEGER, state TEXT
);
CREATE TABLE delay_stats (        -- rebuilt nightly
  provider TEXT NOT NULL, num TEXT NOT NULL, day_type TEXT NOT NULL,
  stats TEXT NOT NULL,            -- JSON: { n, cancelled, stops: { code: [sched minute of day, median, p90, onTimeShare, n, estimated] } }
  built INTEGER NOT NULL,
  PRIMARY KEY (provider, num, day_type)
);
```

The rules go in one pure module, `worker/src/delays.js`, as `src/alerts.js` does: `due(sources, reads, now)` →
which sources to read, `observe(state, trains, now)` → `{ state, finished, running }`, and (Phase 2)
`summarize(runs, today)` → stats. It has no I/O, so it's tested on fixtures alone.

**If one railroad is still too heavy for one run** on Cloudflare's machines, the scheduled run can call the worker itself through a service binding, once per heavy railroad, so
each gets its own 10 ms. That's about 1,500 extra requests a day. **To check first:** that Cloudflare counts each of
those calls as a separate invocation with its own CPU limit.

### 2. The rollup: nightly statistics

A second cron (`"17 9 * * *"`, 4–5 AM in the eastern US, when the fewest trains run) works in pieces too. A run that
can't finish in 10 ms saves where it got to and carries on in the next one:

- reads the last 45 days of `runs`, one railroad at a time;
- groups them by provider, number and day type, and computes each stop's median, 90th percentile, on-time share and
  sample size, keeping only trips that match today's timetable;
- replaces that railroad's `delay_stats` rows;
- deletes `runs` older than 90 days. The extra 45 days are there so the window or rules can change later without
  starting over.

With a cron every minute already running, the rollup can be a mode of it ("between 09:17 and 10:00 UTC, also do one
rollup step") rather than a second trigger.

### 3. The API

`GET /v1/delays?keys=Amtrak:171,LIRR:2034` (up to 50 keys) answers `{ "Amtrak:171": { wkd: {…}, sat: {…} }, … }`,
with `Cache-Control: public, max-age=3600`. The stats only change nightly, so most requests are answered from
Cloudflare's cache. It's public data: no account needed.

### 4. On the page

| Where | What it says |
|---|---|
| Train page, under the stop list | "Usually 6 min late at New York · on time 7 in 10 · 34 trips, last 45 days" |
| Each stop on the train page | A small "usually +6" beside the scheduled time, for stops with enough trips |
| Trip card and Home's hero | The rider's two stops only: "Usually leaves Boston on time, reaches New York ~6 min late" |
| Trip planner results | One short tag per train ("usually on time", "usually ~12 late") plus a "Most reliable" sort, which is where it most helps someone choose |
| Estimated stops (railroads that drop passed stops) | "About" before the number ("usually about 4 min late") |
| Not enough history | Nothing. No "no data" label, which would only add clutter |

The page fetches stats only for trains it's about to show, in one batched request, and keeps them for the session.

## Volume and cost (Workers Free)

Rough counts from the feeds today: about 5,000 scheduled trips a day across all railroads (LIRR, Metro-North,
NJ Transit, SEPTA and Metra about 600–700 each; Amtrak about 300), averaging about 15 stops.

| | Per day | Free limit |
|---|---|---|
| Worker requests | 1,440 recorder runs (+ up to about 1,500 self-calls, if needed) + site traffic | 100,000 |
| CPU per recorder run | **Up to about 6 ms measured on a Mac; to confirm on Cloudflare** | 10 ms |
| Subrequests per run | about 3–8 (feeds or cache, D1) | 50 |
| D1 rows written | about 5,000 runs + about 5,000 stats rows + up to about 3,000 working copies = **about 13,000** | 100,000 |
| D1 rows read | about 225,000 (the rollup: 45 days × about 5,000 trips) + API misses | 5,000,000 |
| D1 storage | 90 days of runs at about 400 bytes ≈ **180 MB** | 5 GB |
| Cost | **$0** | |

CPU per read, measured 2026-11-09 against the live feeds: decode, light build, and loading and saving the working
copies, warm, on an Apple M-series Mac (`RULES.cost` in `delays.js`):

| Source | Trains | CPU |
|---|---:|---:|
| Amtraker (Amtrak, VIA, Brightline) | 208 | 6.0 ms |
| LIRR | 149 | 5.5 ms |
| Metro-North | 136 | 5.3 ms |
| NJ Transit | — | about 5.5 ms (its feed was down; estimated from LIRR) |
| MBTA (1 MB feed, shared with buses) | 55 | 3.7 ms |
| Metra | 72 | 3.5 ms |
| SEPTA | 65 | 2.3 ms |
| The other seven | 4–22 | 0.5–1.4 ms each |

**Measured on Cloudflare after the first deploy (2026-11-10, 01:31–01:37 UTC):** each recorder run took **43–118 ms
of CPU**, not the 1–6 ms measured on the Mac, and every run still finished `ok`. The site's own `/v1/trains` request
took 77 ms in the same window, also `ok`. So far Cloudflare isn't stopping runs at 10 ms. The likely cause, not yet
confirmed, is that each scheduled run starts a fresh copy of the worker, which first loads the 2.8 MB timetable
bundle (`schedules.json`). If Cloudflare ever does enforce the limit, runs will show the outcome `exceededCpu` in
`npx wrangler tail`. The first thing to try then is loading each railroad's timetable only when that railroad is
read.

**The main risk, as first estimated.** The heaviest sources are about 6 ms on a fast Mac with the code warmed up. Cloudflare's machines
may be slower, and a run on a freshly started copy of the worker is slower still, so a run reading LIRR or Amtraker
could go over 10 ms. If it does, Cloudflare fails that run. The deployed worker has to show its real CPU time
(Cloudflare's logs report it per run) before relying on this. If the heavy sources go over, the ways down are, in
order:
- a smaller working copy: about a third of each heavy read is loading and saving it;
- reading Amtraker per train number group, or only the trains under way;
- the self-call fallback above, which gives a source its own run and its own 10 ms.

Two design choices keep this within the free plan:
- **One D1 row per finished trip.** One row per stop per update would be about 75,000 a day, close to the write
  limit on its own.
- **Small runs every minute, each sized by measured cost, not big runs every five.**

## Phases

1. **Recorder** (about 3–4 days).
   - First, a day-long check (`worker/local/survey-feeds.mjs`, started 2026-11-09): poll the deployed feeds for 24
     hours and count, for each finished trip, how many passed stops kept a time. Adjust `RULES.keepsPassed` and the
     table above.
     Result (236 polls, 2026-11-09 22:26Z to 2026-11-10 22:26Z), the share of passed stops with a time: Amtrak and
     VIA 100%, VRE 100%, MARC 99.9%, Metro-North 99.8%, LIRR 94.9%; Metrolink 36.7% (some trips keep every time,
     none keep none); Metra 2.1%, South Shore 3.4%, SEPTA 0.7%, MBTA 0.5%, Tri-Rail 0.5%, Caltrain 0.2%, RTD 0%.
     NJ Transit was down all day (token bug, since fixed), so it stays in `keepsPassed` on its feed's shape. The
     list needed no change; Metrolink stays on 5-minute reads, which keep its reported times where it has them.
   - Then the cron job, `delays.js` `due()` and `observe()`, the light decode, and migration 0008. Unit tests with
     recorded feeds: a stop's real time is kept once passed, an estimate is frozen once passed, a finished trip is
     written exactly once, a trip that vanishes is written after 30 min, a cancelled one is marked, the rota reads
     each railroad as often as intended.
   - Deploy and read CPU per run from the logs. Add the self-call fallback only for a railroad that needs it.
   - **Exit:** a week of `runs` rows that match what the page showed on the day, with every run under 10 ms.
2. **Rollup and API** (about 2 days). `summarize()` with tests: median and p90 on known samples, the 8-trip
   minimum, the timetable-change filter, day types, a train that changes number, a rollup split across runs.
   **Exit:** `/v1/delays` answers for trains with 8+ recorded trips.
3. **Page** (about 3 days). Train page, trip card and hero, planner tag and sort, "about" for estimated stops.
   Browser tests with a fixture stats file (in `e2e/fixtures/`, served by `e2e/server.mjs`), as the live feeds are
   now. **Exit:** shipped behind a switch until two weeks of data exist.
4. **Line level** (optional, later). Combine trains to say how a whole line or station pair usually runs ("Boston
   to New York: on time 6 in 10 this month"). It uses the same `runs`, so it can be added without recording
   anything new.

The recorder should ship first and as soon as possible, because the feature can only show history recorded after
that day. The page can wait until there's data to show.

## Decisions

Made on 2026-11-09:

| Decision | Choice |
|---|---|
| The headline number | **The median**, shown with the on-time share. The mean stays in the data |
| Railroads that drop passed stops | **Estimate every stop** from the last estimate before the train passed it, shown with "about" |
| Window | **The last 45 days** |
| Who sees it | **Everyone**, signed in or not |
| Grouping | **Separate averages** for weekdays, Saturdays and Sundays under each train number |

Nothing is left to decide before Phase 1.

Workers Paid isn't needed. If the Phase 2 alert engine goes ahead, it can run inside the same per-minute job; check
its CPU then.

## Not included

- Delay reasons. The feeds don't give them, and the ground rules forbid guessing.
- Predicting today's delay from history. That's a different and riskier feature. This one only says what happened.
- Anything about riders. Every number comes from public feeds; no trips or accounts are involved.
