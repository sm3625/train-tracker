#!/usr/bin/env node
// Which railroads' feeds keep the times of stops a train has passed? The delay recorder (src/delays.js) reads those
// railroads rarely and the others often, so this decides how it's tuned. See docs/delay-history-plan.md.
//
//   node local/survey-feeds.mjs [hours=24] [out=survey.json]
//
// Polls the deployed worker's /v1/trains and Amtraker every 5 minutes. For each trip it keeps the last copy seen;
// when the trip leaves the feed, it counts how many of that copy's passed stops still carry a reported time. That
// last copy is what the recorder would write. Writes the running totals to `out` after every poll.
import { writeFile } from 'node:fs/promises';

const HOURS = Number(process.argv[2]) || 24;
const OUT = process.argv[3] || 'survey.json';
const EVERY = 5 * 60000;
const SOURCES = [
  ['feeds', 'https://trackside-feeds.trackside-feeds.workers.dev/v1/trains', { Origin: 'https://sm3625.github.io' }],
  ['amtraker', 'https://api-v3.amtraker.com/v3/trains', {}],
];

const live = new Map();     // trip key -> its last copy
const totals = {};          // provider -> { trips, passed, timed, tripsAllTimed, tripsNoneTimed }
const started = Date.now();
let polls = 0, failures = 0;

const keyOf = (t) => `${t.provider}|${t.trainID ?? t.trainNum}`;
function tally(t) {
  const passed = (t.stations || []).filter((s) => s.status === 'Departed');
  if (!passed.length) return;
  const timed = passed.filter((s) => s.arr || s.dep).length;
  const r = totals[t.provider] ||= { trips: 0, passed: 0, timed: 0, tripsAllTimed: 0, tripsNoneTimed: 0 };
  r.trips++; r.passed += passed.length; r.timed += timed;
  if (timed === passed.length) r.tripsAllTimed++;
  if (!timed) r.tripsNoneTimed++;
}

async function poll() {
  const seen = new Set();
  for (const [name, url, headers] of SOURCES) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      for (const list of Object.values(await res.json())) {
        if (!Array.isArray(list)) continue;
        for (const t of list) { const k = keyOf(t); seen.add(k); live.set(k, t); }
      }
    } catch (err) {
      failures++;
      console.error(new Date().toISOString(), name, err.message);
      return;   // a missed source would make every one of its trips look finished
    }
  }
  for (const [k, t] of live) if (!seen.has(k)) { tally(t); live.delete(k); }
  polls++;
  const summary = Object.fromEntries(Object.entries(totals).sort().map(([p, r]) => [p, {
    ...r, timedShare: +(r.timed / r.passed).toFixed(3),
    kind: r.timed / r.passed >= 0.9 ? 'keeps passed stops' : r.timed / r.passed <= 0.1 ? 'drops passed stops' : 'mixed',
  }]));
  await writeFile(OUT, JSON.stringify({ started: new Date(started).toISOString(), polls, failures, inProgress: live.size, summary }, null, 2));
}

await poll();
const timer = setInterval(async () => {
  if (Date.now() - started >= HOURS * 3600000) { clearInterval(timer); console.log(`done: ${polls} polls, written to ${OUT}`); return; }
  await poll();
}, EVERY);
