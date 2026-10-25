/* One railroad's GTFS-Realtime feeds plus its timetable (schedules.json) -> trains shaped like the Amtraker
   API's, so the site treats them like any other operator. Pure: no network, no clock but `now`. */
import { STATUS, CANCELED, SKIPPED } from './gtfsrt.js';

const MPS_TO_MPH = 2.236936;
const MAX_MPH = 79;   // commuter trains in the US top out around here; caps the speed estimate below
/* A live train whose predictions are this far from the run it matched is a different train: railroads reuse train
   numbers across schedules, and trip ids across timetable versions (NJ Transit's), so an out-of-date timetable pairs
   them with the wrong run. Matching anyway showed LIRR 2 (a 1:05 am run) 21 hours late and NJ Transit 6936 20 hours
   early. Such a train is shown at its position with no times, rather than with made-up ones; no commuter train here
   is that late for real. */
const MATCH_MS = 3 * 3600000;
/* Dead trains. A feed doesn't always drop a train that has stopped running: SEPTA's has served parked consists, named
   by their car numbers ("2406,2556,2502,…") and with no trip the timetable knows, for a day and a half after their
   last report. So a train is served only while it's plausibly running, whatever the feed says:
   - GONE_MS: nothing heard about it (no position, no prediction) for this long, and it's left out. A running train
     reports every few minutes.
   - GHOST_MS: a train with nothing but a position (it matched no timetabled run) is served only while that position
     is this fresh; an old dot with no times says nothing.
   A report's time is the vehicle's or the prediction's own, else the feed's: never the time of this request, which
   would make any old report look current. The site applies the same rules to every source (GONE_MIN in
   index.html). */
export const GONE_MS = 2 * 3600000;
export const GHOST_MS = 20 * 60000;

/* How long since the newest dated report in a railroad's feeds (ms), or null if none is dated. Past GONE_MS the feed
   itself has stopped updating, and every train in it is dropped as gone, so the feed's status says so rather than
   "ok" (SEPTA's sat on one snapshot for a day and a half while answering every request). */
export function feedSilence(feeds, now) {
  let newest = 0;
  for (const f of feeds) {
    for (const e of f.entities) newest = Math.max(newest, (e.vehicle && e.vehicle.timestamp) || 0, (e.tripUpdate && e.tripUpdate.timestamp) || 0);
  }
  if (!newest) for (const f of feeds) newest = Math.max(newest, (f.header && f.header.timestamp) || 0);
  return newest ? now - newest * 1000 : null;
}

/* ---------------- time helpers, per time zone ---------------- */
const clocks = new Map();
const p2 = (n) => (n < 10 ? '0' + n : '' + n);
export function clock(tz) {
  if (clocks.has(tz)) return clocks.get(tz);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = (ms) => {
    const p = Object.fromEntries(dtf.formatToParts(ms).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
  };
  // UTC offsets only change on the hour, and formatting is slow, so remember them per hour
  const offsets = new Map();
  const offsetMin = (ms) => {
    const hour = Math.floor(ms / 3600000);
    let off = offsets.get(hour);
    if (off == null) {
      const p = parts(hour * 3600000);
      off = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - hour * 3600000) / 60000);
      if (offsets.size > 5000) offsets.clear();
      offsets.set(hour, off);
    }
    return off;
  };
  const c = {
    /* GTFS times count from "noon minus 12 hours" on the service day, which handles daylight-saving days correctly. */
    serviceBase(yyyymmdd) {
      const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
      const noonUtc = Date.UTC(y, m - 1, d, 12);
      return noonUtc - offsetMin(noonUtc) * 60000 - 12 * 3600000;
    },
    ymd(ms) { const d = new Date(ms + offsetMin(ms) * 60000); return d.toISOString().slice(0, 10).replace(/-/g, ''); },
    /* Local time with its offset, as Amtraker writes it: 2026-10-11T14:05:00-04:00 */
    iso(ms) {
      if (ms == null || !isFinite(ms)) return '';
      const off = offsetMin(ms), d = new Date(ms + off * 60000), a = Math.abs(off);
      return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds())
        + (off < 0 ? '-' : '+') + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
    },
  };
  clocks.set(tz, c);
  return c;
}

const kmBetween = (a, b) => {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const HEADINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => (deg == null || !isFinite(deg) ? '' : HEADINGS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);
const at = (ev) => (ev && ev.time ? ev.time * 1000 : null);

/* For a mixed feed (buses too), the trips worth decoding: those in the rail timetable. */
export const railFilter = (sched) => (trip) => (trip.tripId && sched.trips && trip.tripId in sched.trips) || (trip.routeId && trip.routeId in sched.routes);

/* Which of a run's stops a stop-time update means: by stop id, else by stop_sequence. */
function stopIndex(run, u, sched, from) {
  const list = run[3];
  if (u.stopId) {
    for (let j = from; j < list.length; j++) if (list[j][0] === u.stopId) return j;
    const code = sched.stops[u.stopId];
    if (code) for (let j = from; j < list.length; j++) if (sched.stops[list[j][0]] === code) return j;
    return -1;
  }
  if (u.stopSeq != null) return run[4] ? run[4].indexOf(u.stopSeq) : u.stopSeq - 1 < list.length ? u.stopSeq - 1 : -1;
  return -1;
}

/* Live predictions for a run on a service day: per stop index, { arr, dep } in ms, or { skipped }.
   An update with only a delay is applied to the scheduled time. */
function predictions(run, base, tu, sched) {
  const pred = new Map();
  let from = 0;
  for (const u of (tu && tu.stops) || []) {
    const j = stopIndex(run, u, sched, from);
    if (j < 0) continue;
    from = j;
    if (u.scheduleRelationship === SKIPPED) { pred.set(j, { skipped: true }); continue; }
    const [, arrS, depS = arrS] = run[3][j];
    const delay = (ev) => (ev && ev.delay != null && !ev.time ? ev.delay * 1000 : null);
    const arr = at(u.arrival) ?? (delay(u.arrival) != null ? base + arrS * 1000 + delay(u.arrival) : null);
    const dep = at(u.departure) ?? (delay(u.departure) != null ? base + depS * 1000 + delay(u.departure) : null);
    if (arr == null && dep == null) continue;
    pred.set(j, { arr: arr ?? dep, dep: dep ?? arr });
  }
  // a delay for the whole trip and nothing per stop
  if (!pred.size && tu && tu.delay != null && tu.delay !== 0) {
    const [, arrS, depS = arrS] = run[3][0];
    pred.set(0, { arr: base + arrS * 1000 + tu.delay * 1000, dep: base + depS * 1000 + tu.delay * 1000 });
  }
  return pred;
}

/* Which timetable run and service day a live train is: the fit closest to its predictions, or with none, to
   the time now (inside the run's hours is a perfect fit). */
function resolve(cands, sched, tu, desc, c, now) {
  const bases = desc.startDate ? [c.serviceBase(desc.startDate)] : [c.serviceBase(c.ymd(now)), c.serviceBase(c.ymd(now - 86400000))];
  let best = null;
  for (const ri of cands) {
    const run = sched.runs[ri];
    for (const base of bases) {
      const pred = predictions(run, base, tu, sched);
      let score;
      if (pred.size) {
        let sum = 0, n = 0;
        for (const [j, p] of pred) {
          if (p.skipped) continue;
          const [, arrS] = run[3][j];
          sum += Math.abs(p.arr - (base + arrS * 1000)); n++;
        }
        score = n ? sum / n : Infinity;
      } else {
        const list = run[3], start = base + list[0][1] * 1000 - 1800000, end = base + list[list.length - 1][1] * 1000 + 1800000;
        score = now < start ? start - now : now > end ? now - end : 0;
      }
      if (!best || score < best.score) best = { run, base, pred, score };
    }
  }
  return best;
}

/* The candidate runs for a live train: by trip id, or by train number (the entity id, or the trip id).
   byTrip says which, since a number can belong to several trains. */
function candidates(sched, key, desc, mixed) {
  if (desc.tripId && sched.trips && desc.tripId in sched.trips) return { runs: [sched.trips[desc.tripId]], byTrip: true };
  if (mixed) return { runs: [], byTrip: false };
  for (const n of [key, desc.tripId, ((desc.tripId || '').match(/\d+/) || [])[0]]) {
    if (n && sched.nums[n]) return { runs: sched.nums[n], byTrip: false };
  }
  return { runs: [], byTrip: false };
}

export function buildTrains(agency, sched, feeds, now) {
  const c = clock(sched.tz), tz = sched.tz;
  const keyOf = (e, trip) => (agency.joinBy === 'entity' ? e.id : trip && trip.tripId);
  const updates = new Map(), vehicles = new Map(), reported = new Map();   // reported: key -> { veh, tu } in ms
  for (const f of feeds) {
    const feedAt = (f.header || {}).timestamp;
    const note = (k, kind, ts) => { const r = reported.get(k) || {}; r[kind] = (ts || feedAt || 0) * 1000 || null; reported.set(k, r); };
    for (const e of f.entities) {
      if (e.tripUpdate) { const k = keyOf(e, e.tripUpdate.trip); if (k) { updates.set(k, e.tripUpdate); note(k, 'tu', e.tripUpdate.timestamp); } }
      if (e.vehicle) { const k = keyOf(e, e.vehicle.trip); if (k) { vehicles.set(k, e.vehicle); note(k, 'veh', e.vehicle.timestamp); } }
    }
  }

  const out = [], ids = new Set();
  for (const key of new Set([...vehicles.keys(), ...updates.keys()])) {
    const veh = vehicles.get(key), tu = updates.get(key);
    const desc = { ...((tu && tu.trip) || {}), ...((veh && veh.trip) || {}) };
    if (tu && tu.trip && tu.trip.startDate) desc.startDate = tu.trip.startDate;
    const cands = candidates(sched, key, desc, agency.mixed);
    let fit = resolve(cands.runs, sched, tu, desc, c, now);
    if (fit && fit.score > MATCH_MS) fit = null;   // the same number or trip id, a different train
    if (!fit && (agency.mixed || !(veh && veh.position))) continue;   // a bus, or nothing to show
    const { veh: posTs = null, tu: tuTs = null } = reported.get(key) || {};
    const heard = Math.max(posTs || 0, tuTs || 0);
    if (heard && now - heard > GONE_MS) continue;   // silent for hours: the feed forgot it
    if (!fit && !(posTs && now - posTs <= GHOST_MS)) continue;   // only a position, and an old one
    // A timetabled train with no position that isn't due for over an hour, or finished two hours ago: nothing
    // useful to show. Checked before the stops are built, since feeds like Metro-North's list the whole day.
    if (fit && !(veh && veh.position)) {
      const list = fit.run[3];
      if (fit.base + list[0][1] * 1000 - now > 3600000 || now - (fit.base + list[list.length - 1][1] * 1000) > 7200000) continue;
    }
    const run = fit && fit.run;
    const routeId = (run && run[0]) || desc.routeId || '';
    const num = run ? run[2] : (veh && veh.vehicle && veh.vehicle.label) || key;

    let stations = [];
    if (run) {
      const { base, pred } = fit;
      // The first stop with a prediction; stops before it have already been served (feeds list only stops ahead)
      const firstPred = pred.size ? Math.min(...pred.keys()) : -1;
      let delay = null;   // carried forward to stops without their own prediction
      stations = run[3].map(([stopId, arrS, depS = arrS], i) => {
        const schArr = base + arrS * 1000, schDep = base + depS * 1000;
        const p = pred.get(i);
        let arr = null, dep = null;
        if (p && !p.skipped) {
          arr = p.arr; dep = p.dep;
          delay = dep != null ? dep - schDep : arr != null ? arr - schArr : delay;
        } else if (delay != null && (firstPred < 0 || i > firstPred)) {
          arr = schArr + delay; dep = schDep + delay;
        }
        const code = sched.stops[stopId];
        const info = sched.stations[code] || [stopId];
        return {
          name: info[0], code, tz, bus: false,
          schArr: c.iso(schArr), schDep: c.iso(schDep), arr: c.iso(arr), dep: c.iso(dep),
          arrCmnt: '', depCmnt: '', platform: '',
          _passed: firstPred > 0 && i < firstPred,
          _arr: arr ?? schArr, _dep: dep ?? schDep, _skipped: !!(p && p.skipped), _stop: stopId,
        };
      });

      // status: Departed for stops behind the train, Station for the stop it's standing at, Enroute for the rest
      let last = -1;
      stations.forEach((s, i) => { if (s._passed || s._dep <= now) last = i; });
      if (veh && (veh.stopId || veh.stopSeq != null) && veh.status != null) {
        const vi = stopIndex(run, { stopId: veh.stopId, stopSeq: veh.stopId ? null : veh.stopSeq }, sched, Math.max(0, last));
        if (vi >= 0) last = veh.status === STATUS.STOPPED_AT ? vi - 1 : Math.max(last, vi - 1);
      }
      stations.forEach((s, i) => {
        s.status = i <= last ? 'Departed' : i === last + 1 && s._arr <= now && !s._skipped ? 'Station' : 'Enroute';
        delete s._passed; delete s._arr; delete s._dep; delete s._skipped; delete s._stop;
      });
      stations = stations.filter((s) => s.code);
    }

    const first = stations[0], lastStop = stations[stations.length - 1];
    const allDeparted = stations.length && stations.every((s) => s.status === 'Departed');
    const notStarted = stations.length && stations.every((s) => s.status === 'Enroute') && Date.parse(first.dep || first.schDep) > now;
    if (allDeparted && !veh) continue;   // finished; the feed hasn't dropped it yet
    if (notStarted && !(veh && veh.position) && Date.parse(first.dep || first.schDep) - now > 3600000) continue;   // see above

    const pos = veh && veh.position && veh.position.lat ? veh.position : null;
    // Many feeds send no speed. Estimate it from the distance to the next stop and the predicted arrival there,
    // so the train keeps moving on the map between updates (the site never runs it past that stop).
    let mph = pos && pos.speed != null && pos.speed > 0 ? pos.speed * MPS_TO_MPH : null;
    const next = stations.find((s) => s.status !== 'Departed');
    if (mph == null && pos && next && next.status === 'Enroute' && stations.some((s) => s.status === 'Departed')) {
      const st = sched.stations[next.code], eta = Date.parse(next.arr || next.schArr), from = posTs ?? now;
      if (st && eta - from > 20000) mph = Math.min(MAX_MPH, kmBetween([pos.lat, pos.lon], [st[1], st[2]]) / ((eta - from) / 3600000) * 0.621371);
    }
    if (pos && pos.speed === 0 && mph == null) mph = 0;

    let id = `${num}-${agency.id}`;
    for (let n = 2; ids.has(id); n++) id = `${num}-${agency.id}${n}`;
    ids.add(id);
    const cancelled = desc.scheduleRelationship === CANCELED;
    out.push({
      dataSource: 'trackside-feeds',
      provider: agency.provider,
      routeName: sched.routes[routeId] || routeId || agency.provider,
      trainNum: String(num),
      trainNumRaw: String(num),
      trainID: id,
      lat: pos ? pos.lat : null,
      lon: pos ? pos.lon : null,
      heading: compass(pos && pos.bearing),
      velocity: mph ?? 0,
      trainState: cancelled ? 'Cancelled' : allDeparted ? 'Completed' : notStarted ? 'Predeparture' : 'Active',
      origCode: first ? first.code : '', origName: first ? first.name : '', originTZ: tz,
      destCode: lastStop ? lastStop.code : '', destName: (run && run[1]) || (lastStop ? lastStop.name : ''), destTZ: tz,
      lastValTS: c.iso(posTs ?? tuTs),
      stations,
      alerts: [],
    });
  }
  return out;
}
