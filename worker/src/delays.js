/* The delay recorder's rules: which railroads to read this minute, and how each read updates the trips under way.
   Pure functions with no I/O, so they're tested on recorded feeds alone; recordDelays() in index.js does the
   reading and writing. See docs/delay-history-plan.md.

   Workers Free allows 10 ms of CPU per run, so the recorder runs every minute and reads only as many of the most
   overdue sources as fit in a run's budget. How often each is read depends on its feed:
   - feeds that keep the times of stops a train has passed are read every 15 minutes. The last copy of a trip
     before it leaves the feed has every stop's reported time.
   - feeds that drop them are read every 5. A stop then keeps the last estimate seen before the train passed it,
     marked as an estimate.

   A source is a railroad id from agencies.js, or 'amtraker' (Amtrak, VIA and Brightline in one request). */

export const RULES = {
  // ids in agencies.js; confirmed by a 24-hour run of local/survey-feeds.mjs (2026-11-10), except NJ Transit,
  // which was down that day and is here on its feed's shape
  keepsPassed: new Set(['amtraker', 'LI', 'MN', 'NJ', 'MA', 'VR']),
  keepsEveryMs: 15 * 60000,
  dropsEveryMs: 5 * 60000,
  idleEveryMs: 15 * 60000,   // a source whose last read had no trains running
  // CPU per read, in ms: decode, build and the state's load and save, measured warm on an Apple M-series Mac on
  // 2026-11-09 against the live feeds (NJ Transit's was down: estimated from LIRR's). Unlisted sources took about 1.
  cost: { amtraker: 6, LI: 5.5, MN: 5.3, NJ: 5.5, MB: 3.7, ME: 3.5, SE: 2.3 },
  defaultCost: 1.2,
  runBudget: 6,              // per run, leaving room for slower or cold machines under the 10 ms limit
  goneMs: 30 * 60000,        // a trip missing from its feed this long has finished (or was dropped mid-way)
};

const everyMs = (source, idle, rules) => (idle ? rules.idleEveryMs : rules.keepsPassed.has(source) ? rules.keepsEveryMs : rules.dropsEveryMs);

/* The sources to read now, most overdue first, as many as fit in one run. reads: { source: { at, idle } }. */
export function due(sources, reads, now, rules = RULES) {
  const late = sources
    .map((s) => { const r = reads[s] || { at: 0, idle: false }; return { s, late: now - r.at - everyMs(s, r.idle, rules) }; })
    .filter((x) => x.late >= 0)
    .sort((a, b) => b.late - a.late);
  const out = [];
  let room = rules.runBudget;
  for (const { s } of late) {
    const w = rules.cost[s] ?? rules.defaultCost;
    if (w > room) {
      if (!out.length) { out.push(s); break; }   // the most overdue always goes, alone if it must
      continue;                                  // too big for what's left: a smaller one may fit
    }
    out.push(s);
    room -= w;
  }
  return out;
}

const time = (iso) => (iso ? Date.parse(iso) : NaN);
const minutes = (a, b) => (isNaN(a) || isNaN(b) ? null : Math.round((a - b) / 60000));
const ymdFormats = new Map();
function serviceDate(at, tz) {
  let f = ymdFormats.get(tz || '');
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', tz ? { timeZone: tz } : {}); } catch { f = new Intl.DateTimeFormat('en-CA'); }
    ymdFormats.set(tz || '', f);
  }
  return f.format(at);
}
/* 'wkd', 'sat' or 'sun', for a service date (YYYY-MM-DD). */
export function dayType(date) {
  const d = new Date(date + 'T12:00:00Z').getUTCDay();
  return d === 6 ? 'sat' : d === 0 ? 'sun' : 'wkd';
}

/* One read of a source. state: { trips: { key: trip } } from the last read (or undefined); trains: what the source
   reports now, in Amtraker's shape. Returns the new state, the trips that finished (as rows for the runs table),
   and whether anything was running. A trip:
     { provider, num, date, cancelled, seen, end, stops: [[code, schDep ms, arrDelay, depDelay, 'r' | 'e'], …] }
   'r': the feed reported the train's time at a stop it had passed; 'e': the last estimate before it passed. */
export function observe(state, trains, now, rules = RULES) {
  const trips = { ...((state && state.trips) || {}) };
  const seenNow = new Set();
  for (const t of trains) {
    const stations = Array.isArray(t.stations) ? t.stations : [];
    const first = stations[0];
    if (!first || !t.provider) continue;
    const start = time(first.schDep || first.schArr);
    if (isNaN(start)) continue;
    const num = String(t.trainNum ?? '');
    const date = serviceDate(start, first.tz);
    const key = `${t.provider}|${num}|${date}`;
    seenNow.add(key);
    const prev = trips[key];
    const old = new Map(prev ? prev.stops.map((s) => [s[0] + '@' + s[1], s]) : []);
    const stops = stations.map((s) => {
      const sch = time(s.schDep || s.schArr);
      const was = old.get(s.code + '@' + sch);
      const arr = minutes(time(s.arr), time(s.schArr));
      const dep = minutes(time(s.dep), time(s.schDep));
      if (arr == null && dep == null) return was || [s.code, sch, null, null, 'e'];   // no time now: keep what was seen
      const passed = s.status === 'Departed';
      // a stop already recorded as reported keeps that, unless this read reports it too
      if (was && was[4] === 'r' && !passed) return was;
      return [s.code, sch, arr ?? was?.[2] ?? null, dep ?? was?.[3] ?? null, passed ? 'r' : 'e'];
    });
    const last = stations[stations.length - 1];
    trips[key] = {
      provider: t.provider, num, date,
      cancelled: t.trainState === 'Cancelled' || !!(prev && prev.cancelled),
      seen: now,
      end: time(last.schArr || last.schDep),
      stops,
    };
  }

  const finished = [];
  for (const [key, trip] of Object.entries(trips)) {
    if (seenNow.has(key)) continue;
    // left the feed: done once it's been gone a while, or at once if it was past its timetabled end
    if (now - trip.seen >= rules.goneMs || (trip.end && now > trip.end)) {
      delete trips[key];
      if (trip.cancelled || trip.stops.some((s) => s[2] != null || s[3] != null)) finished.push(toRow(trip));
    }
  }
  return { state: { trips }, finished, running: seenNow.size > 0 };
}

export const toRow = (trip) => ({
  provider: trip.provider, num: trip.num, date: trip.date, dayType: dayType(trip.date),
  cancelled: trip.cancelled, stops: trip.stops,
});

/* ---------------- reading the history back ---------------- */

export const HISTORY = {
  days: 45,        // the window for weekday trains: about 32 trips
  weekendDays: 63, // Saturdays and Sundays: 45 days holds only 6 or 7 of each, short of minTrips; 63 always holds 9
  minTrips: 8,     // fewer timed trips than this is an anecdote, and nothing is shown
  onTimeMin: 5,    // 5 minutes late or less is on time, as on the page (sig())
};

const median = (s) => (s.length % 2 ? s[s.length >> 1] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2));

/* One train's runs (one railroad, number and day type) as the page shows them, or null with too few trips. Each
   stop's delay is its departure, except at the last stop, where it's the arrival. A stop seen in a run under another
   timetable (a stop that run skipped, or added) only counts the runs that had it.
     { n, cancelled, end, stops: { code: { median, p90, onTime, n, estimated } } }   (end: the stop to lead with)
   onTime is a share (0..1); estimated is true when most of the stop's times were the last estimate before the train
   passed it ('e'), which the page words as "about". */
export function summarize(runs, { minTrips = HISTORY.minTrips, onTimeMin = HISTORY.onTimeMin } = {}) {
  const kept = runs.filter((r) => !r.cancelled && r.stops.length);
  const seen = new Map();
  for (const r of kept) {
    r.stops.forEach(([code, , arr, dep, kind], i) => {
      const d = i === r.stops.length - 1 ? (arr ?? dep) : (dep ?? arr);
      if (d == null) return;
      let s = seen.get(code);
      if (!s) seen.set(code, (s = { delays: [], est: 0 }));
      s.delays.push(d);
      if (kind === 'e') s.est++;
    });
  }
  const timed = kept.filter((r) => r.stops.some((s) => s[2] != null || s[3] != null));
  if (timed.length < minTrips) return null;
  const stops = {};
  for (const [code, s] of seen) {
    const d = s.delays.sort((a, b) => a - b);
    stops[code] = {
      median: median(d), p90: d[Math.min(d.length - 1, Math.floor(0.9 * d.length))],
      onTime: Math.round((d.filter((x) => x <= onTimeMin).length / d.length) * 100) / 100,
      n: d.length, estimated: s.est * 2 > d.length,
    };
  }
  // the end the page leads with: the last stop of the latest run that has a time there
  const latest = [...timed].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const end = [...latest.stops].reverse().find((s) => stops[s[0]] && stops[s[0]].n >= minTrips)?.[0] || null;
  return { n: timed.length, cancelled: runs.length - kept.length, end, stops };
}
