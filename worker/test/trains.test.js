/* Turning railroads' GTFS-Realtime feeds into trains: matching them to the timetable, reading their predictions,
   and the decoder itself. Feeds here are built by hand, so nothing touches the network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrains, railFilter, clock, feedSilence } from '../src/trains.js';
import { decodeFeed, STATUS } from '../src/gtfsrt.js';

const TZ = 'America/New_York';
const c = clock(TZ);
const H = 3600;
/* A small timetable: train 101 runs A -> B -> C, 8:00 to 9:00, on route R; train 102 is a later run. */
const SCHED = {
  tz: TZ,
  stations: { 'X-A': ['Alpha', 40.0, -74.0], 'X-B': ['Bravo', 40.1, -74.0], 'X-C': ['Charlie', 40.2, -74.0] },
  stops: { a: 'X-A', b: 'X-B', b2: 'X-B', c: 'X-C' },
  routes: { R: 'Red Line' },
  runs: [
    ['R', 'Charlie', '101', [['a', 8 * H], ['b', 8.5 * H, 8.5 * H + 60], ['c', 9 * H]]],
    ['R', 'Charlie', '102', [['a', 10 * H], ['b', 10.5 * H], ['c', 11 * H]], [4, 7, 9]],
  ],
  trips: { 't-101': 0, 't-102': 1 },
  nums: { 101: [0], 102: [1] },
};
const AGENCY = { id: 'X', provider: 'Example' };
const day = '20261012';   // a Monday
const at = (sec) => c.serviceBase(day) + sec * 1000;
const feed = (...entities) => ({ entities });
const vehicle = (id, tripId, extra = {}) => ({ id, vehicle: { trip: { tripId, startDate: day }, position: { lat: 40.05, lon: -74.0 }, timestamp: at(8.2 * H) / 1000, ...extra } });

test('a trip id is matched to its timetable run, and its stops get times and statuses', () => {
  const [t] = buildTrains(AGENCY, SCHED, [feed(vehicle('v1', 't-101'))], at(8.2 * H));
  assert.equal(t.trainID, '101-X');
  assert.equal(t.routeName, 'Red Line');
  assert.equal(t.destName, 'Charlie');
  assert.equal(t.trainState, 'Active');
  assert.deepEqual(t.stations.map((s) => s.status), ['Departed', 'Enroute', 'Enroute']);
  assert.equal(t.stations[1].schDep, c.iso(at(8.5 * H + 60)));
  assert.match(t.stations[0].schDep, /^2026-10-12T08:00:00-04:00$/);
});

test('a train number stands in for a trip id the timetable does not have (Metro-North)', () => {
  const agency = { ...AGENCY, joinBy: 'entity' };
  const tu = { id: '101', tripUpdate: { trip: { tripId: 'internal-9', startDate: day }, stops: [{ stopId: 'b', arrival: { time: at(8.5 * H + 300) / 1000 } }] } };
  const veh = { id: '101', vehicle: { trip: { tripId: '101' }, position: { lat: 40.05, lon: -74 }, timestamp: at(8.3 * H) / 1000 } };
  const [t] = buildTrains(agency, SCHED, [feed(tu, veh)], at(8.3 * H));
  assert.equal(t.trainNum, '101');
  assert.equal(t.lat, 40.05);
  // five minutes late at Bravo, carried on to Charlie
  assert.equal(t.stations[1].arr, c.iso(at(8.5 * H + 300)));
  assert.equal(t.stations[2].arr, c.iso(at(9 * H + 300 - 60)));
});

test('a train number that fits no run of that number within hours is another train: shown with no times', () => {
  // LIRR 2: the live train runs at 10 pm, the timetable's 2 at 1 am; matching them made it 21 hours late
  const agency = { ...AGENCY, joinBy: 'entity' };
  const tu = { id: '101', tripUpdate: { trip: { tripId: 'new-schedule-7', startDate: day }, stops: [{ stopId: 'b', arrival: { time: at(20.5 * H) / 1000 } }] } };
  const veh = { id: '101', vehicle: { trip: { tripId: 'new-schedule-7' }, position: { lat: 40.05, lon: -74 }, timestamp: at(20.3 * H) / 1000 } };
  const [t] = buildTrains(agency, SCHED, [feed(tu, veh)], at(20.3 * H));
  assert.equal(t.lat, 40.05);              // still on the map
  assert.deepEqual(t.stations, []);        // with no invented schedule or delay
  // without a position there's nothing true to show
  assert.deepEqual(buildTrains(agency, SCHED, [feed(tu)], at(20.3 * H)), []);
});

test('a trip id hours off its run is another train too (NJ Transit reuses trip ids); two hours late is kept', () => {
  const tu = (sec) => ({ id: 'u', tripUpdate: { trip: { tripId: 't-101', startDate: day }, stops: [{ stopId: 'b', arrival: { time: at(sec) / 1000 } }] } });
  const veh = vehicle('v1', 't-101', { timestamp: at(10.2 * H) / 1000 });
  assert.deepEqual(buildTrains(AGENCY, SCHED, [feed(tu(14.5 * H), veh)], at(10.2 * H))[0].stations, []);   // six hours off
  const [t] = buildTrains(AGENCY, SCHED, [feed(tu(10.5 * H), veh)], at(10.2 * H));
  assert.equal(t.stations[1].arr, c.iso(at(10.5 * H)));   // two hours late: real, kept
});

test('a delay alone, against a stop_sequence, is applied to the timetable (SEPTA, Tri-Rail)', () => {
  const tu = { id: 'u', tripUpdate: { trip: { tripId: 't-102', startDate: day }, stops: [{ stopSeq: 7, arrival: { delay: 420 } }] } };
  const [t] = buildTrains(AGENCY, SCHED, [feed(tu)], at(10.2 * H));
  assert.equal(t.stations[1].arr, c.iso(at(10.5 * H + 420)));
  assert.equal(t.stations[2].arr, c.iso(at(11 * H + 420)));
  assert.equal(t.stations[0].status, 'Departed');   // stops before the first prediction have been served
});

test('without a start date, the service day that fits the predictions is chosen', () => {
  const tu = { id: 'u', tripUpdate: { trip: { tripId: 't-101' }, stops: [{ stopId: 'c', arrival: { time: at(9 * H + 120) / 1000 } }] } };
  const [t] = buildTrains(AGENCY, SCHED, [feed(tu)], at(8.9 * H));
  assert.match(t.stations[2].schArr, /^2026-10-12T09:00/);
});

test('a vehicle stopped at a station marks the stops before it departed', () => {
  const v = vehicle('v', 't-101', { stopId: 'b2', status: STATUS.STOPPED_AT });
  const [t] = buildTrains(AGENCY, SCHED, [feed(v)], at(8.4 * H));
  assert.deepEqual(t.stations.map((s) => s.status), ['Departed', 'Enroute', 'Enroute']);
});

test('mixed feeds keep only trains; pure rail feeds keep an unknown train that has a position', () => {
  const bus = vehicle('bus', 'bus-trip-7');
  assert.equal(buildTrains({ ...AGENCY, mixed: true }, SCHED, [feed(bus)], at(8.2 * H)).length, 0);
  const [t] = buildTrains(AGENCY, SCHED, [feed(bus)], at(8.2 * H));
  assert.equal(t.stations.length, 0);
  assert.equal(t.lat, 40.05);
});

/* ---------------- dead trains (GONE_MS, GHOST_MS) ---------------- */
test('a parked consist the feed still lists a day and a half on is left out (SEPTA); the same vehicle reporting now is kept', () => {
  // SEPTA served these: no trip the timetable knows, named by the cars, last reported 34 hours earlier
  const consist = (ts) => ({ id: 'c1', vehicle: { trip: { tripId: 'CHW-yesterday', routeId: 'R' }, vehicle: { label: '400,432,431,287' }, position: { lat: 40.05, lon: -74 }, timestamp: ts / 1000 } });
  const now = at(20 * H);
  assert.deepEqual(buildTrains(AGENCY, SCHED, [feed(consist(now - 34 * 3600000))], now), []);
  assert.deepEqual(buildTrains(AGENCY, SCHED, [feed(consist(now - 25 * 60000))], now), []);   // a position alone goes stale in 20 min
  assert.equal(buildTrains(AGENCY, SCHED, [feed(consist(now - 60000))], now).length, 1);
});

test('a timetabled train heard from in neither position nor prediction for two hours is left out', () => {
  const now = at(8.2 * H);
  const quiet = (ago) => vehicle('v1', 't-101', { timestamp: (now - ago) / 1000 });
  assert.deepEqual(buildTrains(AGENCY, SCHED, [feed(quiet(3 * 3600000))], now), []);
  const [t] = buildTrains(AGENCY, SCHED, [feed(quiet(50 * 60000))], now);   // stale, not gone: kept, its age shown
  assert.equal(t.lastValTS, c.iso(now - 50 * 60000));
});

test('fresh predictions keep a train whose position has gone quiet, and its report time stays the position\'s', () => {
  const now = at(8.2 * H);
  const veh = vehicle('v1', 't-101', { timestamp: (now - 3 * 3600000) / 1000 });
  const tu = { id: 'u', tripUpdate: { trip: { tripId: 't-101', startDate: day }, timestamp: (now - 60000) / 1000, stops: [{ stopId: 'b', arrival: { time: at(8.5 * H + 120) / 1000 } }] } };
  const [t] = buildTrains(AGENCY, SCHED, [feed(tu, veh)], now);
  assert.equal(t.lastValTS, c.iso(now - 3 * 3600000));   // the site shows the position as old, not as current
});

test('a report with no time of its own takes the feed\'s, never the request\'s', () => {
  const now = at(20 * H);
  const bare = { id: 'b1', vehicle: { trip: { tripId: 'unknown-7' }, position: { lat: 40.05, lon: -74 } } };
  const withHeader = (ts) => ({ header: { timestamp: ts / 1000 }, entities: [bare] });
  assert.deepEqual(buildTrains(AGENCY, SCHED, [withHeader(now - 3600000)], now), []);   // the feed itself is an hour old
  const [t] = buildTrains(AGENCY, SCHED, [withHeader(now - 30000)], now);
  assert.equal(t.lastValTS, c.iso(now - 30000));
  assert.deepEqual(buildTrains(AGENCY, SCHED, [feed(bare)], now), []);   // no time anywhere: a bare dot nobody vouches for
});

test('timetabled trains far off, with no position, are left out', () => {
  const tu = { id: 'u', tripUpdate: { trip: { tripId: 't-102', startDate: day }, stops: [] } };
  assert.equal(buildTrains(AGENCY, SCHED, [feed(tu)], at(7 * H)).length, 0);
});

test('two live trains with one number get distinct ids', () => {
  const ids = buildTrains(AGENCY, SCHED, [feed(vehicle('v1', 't-101'), vehicle('v2', '101'))], at(8.2 * H)).map((t) => t.trainID);
  assert.deepEqual(ids.sort(), ['101-X', '101-X2']);
});

/* ---------------- the decoder ---------------- */
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
/* int32 negatives go on the wire as 10-byte two's-complement varints */
const int32 = (n) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v);
  return out;
};
const field = (f, wt, bytes) => [...varint(f * 8 + wt), ...bytes];
const lenField = (f, bytes) => field(f, 2, [...varint(bytes.length), ...bytes]);
const str = (f, s) => lenField(f, [...new TextEncoder().encode(s)]);
const float = (f, x) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return field(f, 5, [...b]); };

function sampleFeed() {
  const trip = (id, route) => [...str(1, id), ...(route ? str(5, route) : [])];
  const train = lenField(2, [...str(1, 'e1'), ...lenField(4, [...lenField(1, trip('rail-1', 'CR-X')), ...lenField(2, [...float(1, 42.5), ...float(2, -71.1)])])]);
  const bus = lenField(2, [...str(1, 'e2'), ...lenField(4, [...lenField(1, trip('bus-1', '39')), ...lenField(2, [...float(1, 42.3), ...float(2, -71.0)])])]);
  const update = lenField(2, [...str(1, 'e3'), ...lenField(3, [...lenField(1, trip('rail-1', 'CR-X')), ...lenField(2, [...str(4, 'b'), ...lenField(2, field(1, 0, int32(-90)))])])]);
  return new Uint8Array([...lenField(1, field(3, 0, varint(1791741420))), ...train, ...bus, ...update]);
}

test('decoder: positions, trip ids, and negative delays', () => {
  const f = decodeFeed(sampleFeed());
  assert.equal(f.header.timestamp, 1791741420);
  assert.equal(f.entities.length, 3);
  assert.equal(f.entities[0].vehicle.trip.tripId, 'rail-1');
  assert.ok(Math.abs(f.entities[0].vehicle.position.lat - 42.5) < 1e-5);
  assert.equal(f.entities[2].tripUpdate.stops[0].arrival.delay, -90);
});

test('decoder: a filter skips entities that are not trains', () => {
  const f = decodeFeed(sampleFeed(), railFilter({ routes: { 'CR-X': 'X Line' }, trips: {} }));
  assert.deepEqual(f.entities.map((e) => e.id), ['e1', 'e3']);
  assert.equal(f.entities[1].tripUpdate.stops[0].stopId, 'b');
});

test('decoder: refuses something that is not a feed', () => {
  assert.throws(() => decodeFeed(new TextEncoder().encode('<html>Service unavailable</html>'), () => false));
});

test('a feed\'s silence is the age of its newest dated report, else of its header; none dated, none known', () => {
  const now = at(20 * H);
  const v = (ago) => ({ id: 'v', vehicle: { trip: { tripId: 'x' }, timestamp: (now - ago) / 1000 } });
  // SEPTA's frozen snapshot: every report a day and a half old, though the header is today's
  assert.equal(feedSilence([{ header: { timestamp: now / 1000 }, entities: [v(36 * 3600000), v(34 * 3600000)] }], now), 34 * 3600000);
  assert.equal(feedSilence([{ header: { timestamp: (now - 60000) / 1000 }, entities: [{ id: 'u', tripUpdate: { trip: {} } }] }], now), 60000);
  assert.equal(feedSilence([feed()], now), null);
});
