# Feed reliability methodology

How Trackside keeps every railroad's live trains on the map, and finds out quickly when it doesn't. It was written
after MBTA vanished in October 2026, but applies to every entry in `worker/src/agencies.js`.

**The goal:** a railroad that is running trains is never missing from the map without an alert within 30 minutes.

**The rules everything below follows from:**

1. **Timetables will go stale.** Railroads change trip IDs without notice, sometimes mid-week. Staleness is normal
   operation, so it must cost some detail, never the train.
2. **`ok` has to be earned.** A feed that answered is not a healthy railroad. Status has to describe the trains that
   came out, not the HTTP call that went in.
3. **Show less rather than nothing.** Train with times, then train with no times, then an honest status. One failed
   input never empties a railroad.
4. **A failure nobody hears about didn't get handled.** Every automated job and check ends in an alert someone sees.
5. **Production comes from `main`, through one path.** What's deployed must be identifiable and reproducible.

## What went wrong

The MBTA outage was not one bug. Five separate layers failed, and any one of them working would have prevented or
exposed it.

| # | Failure | Evidence | Layer |
|---|---------|----------|-------|
| 1 | MBTA published new trip IDs mid-week (`FBTieJobPhase17006patch-…`) | Absent from the Oct 26 build, present by Oct 28 | Weekly is too slow |
| 2 | The matcher only knew exact trip IDs, so 0 of 21 live trains matched | `candidates()` for `mixed` feeds | Matching |
| 3 | Unmatched trains on a mixed feed are dropped, not shown grey | `buildTrains()`: `!fit && agency.mixed` | Degradation |
| 4 | Status stayed `ok` with zero trains | `railroad()` only looks at fetch errors and feed age | Observability |
| 5 | The weekly refresh failed three weeks running, unnoticed | All 3 recorded runs concluded `failure`; on Oct 26 the deploy step failed | Pipeline and alerting |

Layer 5 means the timetables committed on Oct 26 never reached production at all. The `Tests` workflow's last three
runs also concluded `failure`. So CI is not currently a gate, and it needs fixing before it can be relied on.

### Exposure by railroad, measured Oct 30 2026, 14:28 UTC

| Railroad | Live trains | Matched | How it matches | Exposure |
|---|---:|---:|---|---|
| MBTA | 49 | 49 | Trip ID, then number at the end of the ID | Fixed Oct 28. Depends on that ID format |
| **FrontRunner** | **0** | **0** | Trip ID only | **Down now.** See below |
| **RTD** | 15 | 15 | Trip ID only | **Same outage as MBTA is possible.** Its numbers are invented (`B2243`), so the fallback can't apply |
| **NJ Transit** | 36 | **23** | Trip ID, then number | **13 grey now.** 12 of the 13 numbers aren't in any timetable we hold |
| LIRR, Metro-North, SEPTA, Metra, Metrolink, Caltrain, MARC, Tri-Rail | 4–95 each | All | Trip ID or number | Degrades to grey rather than vanishing |
| South Shore Line | 12 | 11 | Trip ID or number | Degrades to grey |
| VRE | 0 | 0 | Trip ID or number | Probably off-peak, but today nothing can tell that apart from a failure |

**FrontRunner's outage:** on Oct 30 the worker got `FrontRunner trips: HTTP 403`, and `railroad()` used `Promise.all`,
so losing that one feed lost every train. That's fixed, but by Oct 31 the vehicle feed returned 403 as well. Both URLs
still return 200 from a laptop. From Cloudflare they return 403 whatever the User-Agent, with a "requested URL was
rejected" page from the web firewall in front of UTA's site (`server: volt-adc`). So the block is on where the request
comes from, not how it's written. It's the same class of failure as MBTA, from a different cause, which is why fixes
have to work by layer rather than by railroad.

## The defences

### 1. Matching: never depend on one identifier

Every live train goes down the same ladder, and each railroad declares how it gets through it.

| Rung | Matched by | Result |
|---|---|---|
| 1 | Exact trip ID | Full stops and times |
| 2 | Stable public key: the train number from the ID, entity ID or label | Full stops and times, if the time fits (`MATCH_MS`) |
| 3 | Route, direction and time fit against the timetable | Full stops and times, marked as an inferred match |
| 4 | Rail route but no timetable fit | Grey train at its live position |
| 5 | Can't be shown to be rail | Dropped, and counted |

- Add an optional `liveNum(tripDesc, entity)` to each agency, replacing the generic trailing-digits rule, so format
  assumptions are explicit and tested.
- Rung 3 is what FrontRunner and RTD need, since neither has a usable public number.
- Rung 4 replaces the current drop for mixed feeds. Only rung 5 may discard anything, and it's counted.

### 2. Degradation: one input never takes out a railroad

- Use `Promise.allSettled` in `railroad()`. Vehicles without trip updates still give trains, and the status says
  `degraded: trip updates unavailable`.
- Keep the last good build for each railroad for a bounded time if a rebuild yields zero trains while the previous
  one had many, and report it as `stale`.
- If a host blocks the worker, add a fallback URL or a relay. `url` already accepts a list.

### 3. Health: status from outcomes

Each build records counts as well as a status, and `GET /v1/health` publishes them per railroad:

```json
{
  "MBTA": {
    "status": "ok",
    "builtAt": "2026-10-30T14:28:00Z",
    "feedAgeSec": 12,
    "vehiclesSeen": 39,
    "shown": 39,
    "matched": { "trip": 39, "number": 0, "fit": 0 },
    "grey": 0,
    "dropped": 0,
    "scheduledNow": 41,
    "timetable": { "built": "2026-10-28", "expires": "2026-12-14" }
  }
}
```

**The key check is `scheduledNow`,** the number of timetable runs that should be moving at this moment. It's the only
signal that catches a railroad going silent, and it needs service calendars added to `schedules.json`, which are
dropped today. That's also what separates VRE being off-peak from VRE being broken.

| Status | Condition (starting values, tune after two weeks of data) |
|---|---|
| `ok` | Trains flowing and at least 90% matched |
| `degraded` | Matched share under 90%, or a feed down while another still works |
| `failing` | `scheduledNow` ≥ 3 and `shown` = 0, or shown under 30% of scheduled |
| `stale` | Feed quiet for over 2 hours, or a last-good build being served |
| `idle` | `scheduledNow` = 0 and `shown` = 0. A legitimate zero |

### 4. Freshness: refresh on change, not on Monday

- **Check daily** rather than weekly, using `ETag` / `Last-Modified` or a hash of each zip, so nothing is rebuilt
  unless a railroad published something.
- **Treat "timetable behind live" as a refresh trigger.** If matches by exact trip ID drop under 80%, the health check
  dispatches the refresh workflow. MBTA's mid-week change would then have fixed itself.
- **Store each timetable's expiry** from `feed_info.txt` / `calendar.txt` and warn 7 days before it runs out.
- **Fix `continue-on-error` reporting** so that a railroad keeping its old timetable because its download failed is
  visible in the run, and in `/v1/health`, as a dated timetable.

GitHub's schedule isn't reliable for timing: the 10:23 cron has started hours late (16:49 on Oct 26). It's fine for
daily refreshes, but not for monitoring.

### 5. Deployment: one path, with a gate

- **Production deploys come from CI on `main`.** `npm run deploy` refuses to run unless the tree is clean and matches
  `origin/main`.
- **Stamp each build** with its git commit and expose it in `/v1/health`, so what's live can always be identified.
- **Gate timetable deploys on live data.** Before deploying, replay the current live feeds through the new timetable.
  Refuse if any railroad's matched share falls by more than 10 points against the old one.
- **Roll back** with `wrangler rollback`, then investigate. A failed deploy step must alert the same as a failed check.
- **`schedules.json` is one line,** so any two refreshes conflict in git. Regenerate it after a rebase instead of
  merging it, or split it into one file per railroad.

### 6. Monitoring: something outside watches

- A **Cloudflare cron trigger every 10 minutes** evaluates `/v1/health` and stores the result. It runs inside the
  platform and doesn't depend on anyone opening the app.
- Alert after **2 consecutive `failing` checks**, about 20 minutes, to stop one bad poll paging anyone. Send one alert
  per incident and one on recovery. Include the railroad, the counts and a link to the runbook.
- **Weekly digest:** match rates, grey counts, timetable ages and any failed workflow. This catches slow decline such
  as NJ Transit's 13 grey trains, which never trips an alarm.
- **Watch the watcher:** an independent daily job fails loudly if the last health check is over an hour old.
- **Alert on every failed workflow.** Workflow failures must notify the same channel as railroad failures.

### 7. Testing: make the past failures impossible to repeat

| Test | Runs | Catches |
|---|---|---|
| Stale-timetable replay: rewrite all trip IDs in a fixture, assert each railroad still shows trains | Every push | Any railroad with a single point of matching failure |
| One recorded feed sample per railroad, with its expected ladder rung | Every push | ID format changes, `liveNum` regressions |
| Partial-failure: fail each feed in turn, assert trains survive | Every push | `Promise.all`-style regressions |
| Status truth: 0 trains with runs scheduled must not be `ok` | Every push | Silent zeros |
| Live contract: fetch real feeds, check decoding and field presence | Daily, not gating pushes | Upstream format changes |
| Config: every agency declares a ladder and a rail filter | Every push | New railroads skipping this document |

The stale-timetable replay is the highest-value test here. It would have failed for MBTA, and by the code as it stands
it would fail for FrontRunner and RTD today.

### 8. Adding a railroad

An agency isn't done until:

- [ ] Its identifiers are classified: are trip IDs stable, is there a public number, does the feed have route IDs?
- [ ] It declares `liveNum` or a rung 3 fit, and `mixed` if it shares a feed with buses.
- [ ] A recorded feed sample and its stale-timetable test exist.
- [ ] Vehicle and trip feeds are verified **from the worker**, not just from a laptop.
- [ ] `scheduledNow` has been checked against reality at peak and off-peak.
- [ ] It appears in `/v1/health` and the digest.

## Runbook: a railroad is missing or grey

1. **Check health.** `/v1/health`, or until that exists:

   ```bash
   curl -sI https://trackside-feeds.trackside-feeds.workers.dev/v1/trains -H 'Origin: https://trackside-pearl.vercel.app' | grep -i x-feed-status
   ```

2. **Is it actually running?** Compare with the railroad's own data before changing anything.
3. **Classify it:**

| Symptom | Likely cause | Action |
|---|---|---|
| `error` / `HTTP 4xx` | Key expired, blocked, URL moved | Rotate the key, or update the URL. Check from the worker as well as a laptop |
| `ok`, zero trains, railroad running | Stale timetable on a mixed feed | Run the refresh. Add a ladder rung if one was missing |
| Trains present but grey | New timetable, or numbers changed | Run the refresh, then check whether those numbers are in it |
| `stale`: feed not updating | Upstream outage | Nothing to fix. Confirm, and wait |
| All railroads affected | Worker, rate limits, or a bad deploy | `wrangler rollback`, then look at the last deploy |

4. **Refresh only through the workflow** (Actions tab, Refresh timetables). If it must be done by hand, first run:

   ```bash
   git pull --rebase origin main
   ```

5. **Confirm from the live endpoint,** not locally. Compare train counts with the railroad's own data.
6. **Write it up.** One paragraph: what broke, how it was found, which layer should have caught it, and what test now
   covers it. Add a row to the failure table above. An incident found by a user rather than an alert also counts as
   a monitoring bug.

## Rollout

| Phase | Work | Effort |
|---|---|---|
| **0. Stop the bleeding** | Fix FrontRunner with `allSettled`. Fix the `CLOUDFLARE_*` deploy failure. Fix the `Tests` workflow. Rebase onto `origin/main`, push, redeploy with the newest timetables. Look into NJ's 13 grey trains | Half a day |
| **1. See it** | Outcome counts, `/v1/health`, truthful statuses, alerts on failed workflows | 1–2 days |
| **2. Survive it** | Ladder with `liveNum` and rung 3, grey instead of drop on mixed feeds, last-good builds, the stale-replay test | 2–3 days |
| **3. Catch it early** | Service calendars and `scheduledNow`, cron monitor and alerts, digest | 2–3 days |
| **4. Fix it automatically** | Daily change-detected refresh, live-replay deploy gate, health-triggered refresh, deploy lock | 2–3 days |

Phases 0 and 1 give most of the protection. Phase 3 is what would have caught MBTA within 30 minutes.

**Phase 0 findings, Oct 30 2026:**

- **The `Tests` failures** were the test server using the real date while the page's clock stayed at the fixtures'
  recording, so trips were refused as over a week old once the recording was. `e2e/server.mjs` now keeps the same
  clock. Playwright reuses a server already on its ports locally, so stop any old one before trusting a local run.
- **The deploy failure's** logs can't be read without signing in to GitHub. The step now names missing secrets.
- **NJ Transit's** grey trains are a stale timetable that can't currently be refreshed: `getToken` returns HTTP 500.
  Grey trains rose from 13 to 22 of 36 during the day. The worker's live feed still works on its stored token, so
  it's at risk too if that token has to be replaced before sign-in recovers.

## Open decisions

- **Alert channel.** Email isn't configured (`MAIL_PROVIDER` is empty), so this needs Resend or Brevo set up, or a
  push service such as ntfy, or GitHub issues opened automatically.
- **Should grey trains appear for mixed feeds if rail can't be proven?** Rung 4 only applies where the route is known.
  FrontRunner's vehicle feed sent no route IDs in the Oct 30 sample, so its rung 3 has to work from the timetable's
  stops and positions.
- **Should the app say when a railroad is degraded?** The status is available, and a small "MBTA data is limited right
  now" note would be more honest than a quiet gap.
