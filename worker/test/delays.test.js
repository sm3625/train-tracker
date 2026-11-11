/* The delay recorder's rules (src/delays.js): which railroads it reads when, and what one read does to the trips
   under way. Trains are in the shape /v1/trains and Amtraker serve. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { due, observe, dayType, summarize, RULES } from '../src/delays.js';

const T0 = Date.parse('2026-11-09T14:00:00Z');   // a Monday, 9:00 AM in New York
const min = 60000;
const iso = (t) => new Date(t).toISOString();
const TZ = 'America/New_York';

/* A train three stops long, leaving at T0. passed: how many stops it has left. late: minutes, at every stop.
   times: which stops carry a time ('all', 'ahead' for feeds that drop passed stops, or 'none'). */
function train({ num = '2034', provider = 'LIRR', passed = 0, late = 0, times = 'all', state = 'Active' } = {}) {
  const stop = (code, sch, i) => {
    const has = times === 'all' || (times === 'ahead' && i >= passed);
    return { code, name: code, tz: TZ, schArr: iso(sch), schDep: iso(sch), arr: has ? iso(sch + late * min) : '', dep: has ? iso(sch + late * min) : '',
      status: i < passed ? 'Departed' : 'Enroute' };
  };
  return { provider, trainNum: num, trainState: state, stations: [stop('A', T0, 0), stop('B', T0 + 30 * min, 1), stop('C', T0 + 60 * min, 2)] };
}
/* Reads in order: [[trains, now], …]. Returns every finished row and the last state. */
function reads(list) {
  let state, finished = [];
  for (const [trains, now] of list) { const r = observe(state, trains, now); state = r.state; finished = finished.concat(r.finished); }
  return { state, finished };
}

test('due: the most overdue sources first, as many as fit in a run, each at its own pace', () => {
  const sources = ['LI', 'ME', 'SE', 'amtraker'];
  // never read: all due, but only what fits in one run's budget (Metra and SEPTA together; LIRR or Amtraker alone)
  assert.deepEqual(due(sources, {}, T0), ['ME', 'SE']);
  const reads = { LI: { at: T0 - 6 * min }, ME: { at: T0 - 6 * min }, SE: { at: T0 - 20 * min }, amtraker: { at: T0 - 16 * min } };
  // LIRR keeps passed stops: not due after 6 min. Metra and SEPTA drop them: due after 5. SEPTA is the most overdue.
  assert.deepEqual(due(sources, reads, T0), ['SE', 'ME']);
  assert.deepEqual(due(['amtraker', 'LI'], reads, T0), ['amtraker']);
  // a costly source, most overdue, is read alone; otherwise it waits for a run with room
  assert.deepEqual(due(['amtraker', 'SE', 'ME'], { ...reads, amtraker: { at: T0 - 60 * min } }, T0), ['amtraker']);
  assert.deepEqual(due(['amtraker', 'SE', 'ME'], reads, T0), ['SE', 'ME']);
  // two heavy railroads never share a run
  assert.deepEqual(due(['LI', 'MN'], {}, T0), ['LI']);
  // nothing running at the last read: read only every 15 min
  assert.deepEqual(due(['ME'], { ME: { at: T0 - 6 * min, idle: true } }, T0), []);
});

test('dayType: weekday, Saturday, Sunday', () => {
  assert.deepEqual(['2026-11-09', '2026-11-13', '2026-11-14', '2026-11-15'].map(dayType), ['wkd', 'wkd', 'sat', 'sun']);
});

test('a feed that keeps passed stops: the last copy is written once, with reported times', () => {
  const { finished, state } = reads([
    [[train({ passed: 0, late: 2 })], T0 - 10 * min],
    [[train({ passed: 2, late: 6 })], T0 + 45 * min],
    [[train({ passed: 3, late: 7 })], T0 + 70 * min],
    [[], T0 + 75 * min],   // left the feed after its timetabled end: finished at once
    [[], T0 + 80 * min],
  ]);
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0], { provider: 'LIRR', num: '2034', date: '2026-11-09', dayType: 'wkd', cancelled: false,
    stops: [['A', T0, 7, 7, 'r'], ['B', T0 + 30 * min, 7, 7, 'r'], ['C', T0 + 60 * min, 7, 7, 'r']] });
  assert.deepEqual(state.trips, {});
});

test('a feed that drops passed stops: each stop keeps the last estimate before it was passed', () => {
  const { finished } = reads([
    [[train({ passed: 0, late: 3, times: 'ahead' })], T0 - 5 * min],
    [[train({ passed: 1, late: 8, times: 'ahead' })], T0 + 25 * min],   // A passed: its 3 stays; B and C now 8
    [[train({ passed: 2, late: 9, times: 'ahead' })], T0 + 55 * min],   // B passed at 8; C now 9
    [[], T0 + 65 * min],
  ]);
  assert.deepEqual(finished[0].stops, [['A', T0, 3, 3, 'e'], ['B', T0 + 30 * min, 8, 8, 'e'], ['C', T0 + 60 * min, 9, 9, 'e']]);
});

test('a reported time is not replaced by a later estimate', () => {
  const t = train({ passed: 1, late: 4 });
  const later = train({ passed: 1, late: 10 });
  later.stations[0].status = 'Enroute';   // a feed that briefly shows A as not yet left
  const { state } = reads([[[t], T0 + 5 * min], [[later], T0 + 10 * min]]);
  assert.deepEqual(Object.values(state.trips)[0].stops[0], ['A', T0, 4, 4, 'r']);
});

test('a trip that vanishes mid-way is written only after it has been gone half an hour', () => {
  const t = train({ passed: 1, late: 5 });
  let r = reads([[[t], T0 + 5 * min], [[], T0 + 20 * min]]);
  assert.equal(r.finished.length, 0);
  r = reads([[[t], T0 + 5 * min], [[], T0 + 20 * min], [[], T0 + 5 * min + RULES.goneMs]]);
  assert.equal(r.finished.length, 1);
});

test('a trip back in the feed after a gap carries on where it was', () => {
  const { finished } = reads([
    [[train({ passed: 1, late: 5, times: 'ahead' })], T0 + 5 * min],
    [[], T0 + 15 * min],
    [[train({ passed: 2, late: 6, times: 'ahead' })], T0 + 40 * min],
    [[], T0 + 70 * min],
  ]);
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0].stops.map((s) => s[2]), [null, 5, 6]);
});

test('a cancelled trip is written, marked, even with no times', () => {
  const { finished } = reads([[[train({ times: 'none', state: 'Cancelled' })], T0 - 30 * min], [[], T0 + 70 * min]]);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].cancelled, true);
});

test('a trip with no times at all is not written', () => {
  const { finished } = reads([[[train({ times: 'none' })], T0 - 30 * min], [[], T0 + 70 * min]]);
  assert.deepEqual(finished, []);
});

test('the same train number on two service dates is two trips', () => {
  const today = train(), tomorrow = train();
  for (const s of tomorrow.stations) { s.schArr = s.schDep = iso(Date.parse(s.schArr) + 86400000); }
  const r = observe(undefined, [today, tomorrow], T0);
  assert.deepEqual(Object.keys(r.state.trips).sort(), ['LIRR|2034|2026-11-09', 'LIRR|2034|2026-11-10']);
});

test('the recorded feeds: every train becomes a trip, and nothing is written while they are all running', () => {
  const fixtures = new URL('../../e2e/fixtures/', import.meta.url);
  const at = Date.parse(readFileSync(new URL('recorded-at.txt', fixtures), 'utf8').trim());
  for (const file of ['feeds-trains.json', 'amtraker-trains.json']) {
    const trains = Object.values(JSON.parse(readFileSync(new URL(file, fixtures), 'utf8'))).flat().filter((t) => t && t.stations && t.stations.length);
    const r = observe(undefined, trains, at);
    assert.ok(Object.keys(r.state.trips).length >= trains.length * 0.95, file);
    assert.deepEqual(r.finished, []);
    assert.equal(r.running, true);
    // a later read without them: the ones past their timetabled end are written straight away
    const done = observe(r.state, [], at + 1);
    assert.ok(done.finished.every((x) => x.stops.length && x.date && ['wkd', 'sat', 'sun'].includes(x.dayType)), file);
  }
});

test('summarize: each stop\'s median, 90th percentile and on-time share; departures, then arrival at the last stop', () => {
  // ten weekday runs, A → B → C: departures from B 0..9 late, arrivals at C 2 more
  const runs = Array.from({ length: 10 }, (_, i) => ({ provider: 'LIRR', num: '2034', date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    dayType: 'wkd', cancelled: false, stops: [['A', T0, null, 0, 'r'], ['B', T0 + 30 * min, i, i, 'r'], ['C', T0 + 60 * min, i + 2, null, 'e']] }));
  runs.push({ provider: 'LIRR', num: '2034', date: '2026-11-20', dayType: 'wkd', cancelled: true, stops: [] });
  const s = summarize(runs);
  assert.equal(s.n, 10);
  assert.equal(s.cancelled, 1);
  assert.equal(s.end, 'C');
  assert.deepEqual(s.stops.A, { median: 0, p90: 0, onTime: 1, n: 10, estimated: false });
  assert.deepEqual(s.stops.B, { median: 5, p90: 9, onTime: 0.6, n: 10, estimated: false });   // 4.5 rounds up
  assert.deepEqual(s.stops.C, { median: 7, p90: 11, onTime: 0.4, n: 10, estimated: true });
});

test('summarize: fewer than 8 timed trips is nothing, unless asked for fewer', () => {
  const run = (d) => ({ provider: 'MBTA', num: '101', date: d, dayType: 'sat', cancelled: false, stops: [['X', T0, 3, 3, 'e']] });
  const runs = ['2026-11-07', '2026-11-14', '2026-11-21'].map(run);
  runs.push({ ...run('2026-11-28'), stops: [['X', T0, null, null, 'e']] });   // no times: doesn't count
  assert.equal(summarize(runs), null);
  assert.equal(summarize(runs, { minTrips: 3 }).n, 3);
});
