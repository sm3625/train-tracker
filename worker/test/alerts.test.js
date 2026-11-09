/* Trip alert rules (src/alerts.js): which changes make a notification, and that repeating an update makes none. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, evaluate, reminders, RULES } from '../src/alerts.js';

const T0 = Date.parse('2026-11-09T22:00:00Z');   // 5:00 PM in New York
const min = 60000;
const iso = (t) => new Date(t).toISOString();
const TZ = 'America/New_York';

const trip = {
  id: 'trip1', provider: 'Amtrak', num: '171', date: '2026-11-09', route: 'Northeast Regional',
  from: { code: 'BOS', name: 'Boston', at: T0 + 30 * min, tz: TZ },
  to: { code: 'NYP', name: 'New York', at: T0 + 270 * min, tz: TZ },
};
/* A train on trip's timetable, `late` minutes late everywhere, having left `lastIdx` stops. */
function train({ late = 0, lastIdx = -1, cancelled = false, reportedAt = T0 } = {}) {
  const stop = (code, name, sch) => ({ code, name, tz: TZ, schArr: iso(sch), arr: iso(sch + late * min), schDep: iso(sch), dep: iso(sch + late * min) });
  return { stops: [stop('WAS', 'Washington', T0 - 200 * min), stop('BOS', 'Boston', T0 + 30 * min), stop('NHV', 'New Haven', T0 + 150 * min), stop('NYP', 'New York', T0 + 270 * min)],
    lastIdx, cancelled, reportedAt };
}
const run = (snaps) => {
  let state, all = [];
  for (const [snap, now] of snaps) { const r = evaluate(trip, state, snap, now); state = r.state; all = all.concat(r.events); }
  return all;
};

test('snapshot reads times and delays at the rider\'s own stops', () => {
  const s = snapshot(train({ late: 12, lastIdx: 1 }), trip);
  assert.equal(s.departAt, T0 + 42 * min);
  assert.equal(s.departDelay, 12);
  assert.equal(s.arriveAt, T0 + 282 * min);
  assert.equal(s.arriveDelay, 12);
  assert.equal(s.departed, true);
  assert.equal(s.arrived, false);
  assert.equal(s.found, true);
});

test('snapshot falls back to the trip\'s times when the train skips its stops', () => {
  const s = snapshot({ stops: [{ code: 'XYZ' }], lastIdx: -1 }, trip);
  assert.equal(s.found, false);
  assert.equal(s.departAt, trip.from.at);
  assert.equal(s.departDelay, null);
  assert.equal(snapshot(null, trip), null);
});

test('an on-time train makes no alerts, however often it is checked', () => {
  const s = snapshot(train({ late: 3 }), trip);
  assert.deepEqual(run([[s, T0], [s, T0 + min], [s, T0 + 2 * min]]), []);
});

test('a late train makes one alert, and repeating the update makes no more', () => {
  const s = snapshot(train({ late: 15 }), trip);
  const events = run([[s, T0], [s, T0 + 6 * min], [s, T0 + 12 * min]]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'delay');
  assert.equal(events[0].title, 'Train 171 Northeast Regional is 15 min late');
  assert.match(events[0].body, /^Now leaves Boston at 5:45\sPM\.$/);
});

test('the delay alerts again only after changing by the step, and says when it has caught up', () => {
  const at = (late) => snapshot(train({ late }), trip);
  const events = run([[at(12), T0], [at(18), T0 + 6 * min], [at(25), T0 + 12 * min], [at(2), T0 + 18 * min]]);
  assert.deepEqual(events.map((e) => e.title), [
    'Train 171 Northeast Regional is 12 min late',
    'Train 171 Northeast Regional is 25 min late',
    'Train 171 Northeast Regional is back on time',
  ]);
});

test('delay alerts wait out the cooldown, then catch up', () => {
  const at = (late) => snapshot(train({ late }), trip);
  const events = run([[at(10), T0], [at(30), T0 + min], [at(30), T0 + RULES.delayCooldownMs + 1]]);
  assert.deepEqual(events.map((e) => e.title), ['Train 171 Northeast Regional is 10 min late', 'Train 171 Northeast Regional is 30 min late']);
});

test('after boarding, the delay is the one at the rider\'s stop', () => {
  const s = snapshot(train({ late: 20, lastIdx: 2, reportedAt: T0 + 159 * min }), trip);
  const [e] = run([[s, T0 + 160 * min]]);
  assert.match(e.body, /^Now due at New York at 9:50\sPM\.$/);
});

test('a stale report says nothing about delays', () => {
  const s = snapshot(train({ late: 40, reportedAt: T0 }), trip);
  assert.deepEqual(run([[s, T0 + RULES.staleMs + min]]), []);
});

test('a cancellation alerts once, and silences the delays', () => {
  const s = snapshot(train({ late: 30, cancelled: true }), trip);
  const events = run([[s, T0], [s, T0 + 10 * min]]);
  assert.deepEqual(events.map((e) => e.kind), ['cancelled']);
  assert.match(events[0].body, /^Your trip from Boston to New York today at 5:30\sPM\.$/);
});

test('reminders: the train approaching the rider\'s station, then nearing their stop, at the latest times', () => {
  const r = reminders(trip, snapshot(train({ late: 7 }), trip), T0);
  assert.deepEqual(r.map((x) => [x.kind, x.at]), [['board', T0 + 27 * min], ['arrive', T0 + 272 * min]]);
  assert.match(r[0].title, /^Train 171 Northeast Regional leaves Boston in 10 min$/);
  assert.match(r[0].body, /, 7 min late\./);
  assert.equal(r[1].title, 'Arriving at New York in 5 min');
});

test('reminders use the timetable before the train is running, and stop once they are past', () => {
  assert.deepEqual(reminders(trip, null, T0).map((x) => x.at), [T0 + 20 * min, T0 + 265 * min]);
  const aboard = snapshot(train({ lastIdx: 1 }), trip);
  assert.deepEqual(reminders(trip, aboard, T0 + 60 * min).map((x) => x.kind), ['arrive']);
  assert.deepEqual(reminders(trip, snapshot(train({ lastIdx: 3 }), trip), T0 + 280 * min), []);
  assert.deepEqual(reminders(trip, snapshot(train({ cancelled: true }), trip), T0), []);
});

test('no reminders for trips more than a day and a half away', () => {
  const later = { ...trip, from: { ...trip.from, at: T0 + 3 * 86400000 }, to: { ...trip.to, at: T0 + 3 * 86400000 + 4 * 3600000 } };
  assert.deepEqual(reminders(later, null, T0), []);
});

test('a stop with no times shows a dash instead of stopping every alert', () => {
  const s = { ...snapshot(train({ late: 15 }), trip), departAt: NaN };
  const [e] = run([[s, T0]]);
  assert.equal(e.body, 'Now leaves Boston at —.');
});
