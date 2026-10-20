#!/usr/bin/env node
// Downloads the public timetables (static GTFS) of every railroad Trackside shows and boils them down to
// ../data/timetables.json, which the site loads to find trains on any date, for planning trips ahead.
//
//   node build-timetables.mjs        (or: npm run timetables)
//   node build-timetables.mjs NJ     only the railroads named (by id, or provider as "Amtrak"), keeping the others' as they are
//
// Sources: Amtrak, VIA Rail and Brightline below, then every commuter railroad in src/agencies.js (with the same
// station codes and train numbers as the live feeds). Caltrain's comes from 511.org, which needs CALTRAIN_511_KEY, and
// NJ Transit's from its signed-in API, which needs NJT_USERNAME and NJT_PASSWORD (and NJT_HOST for the production
// host), all from ../.env or the environment. If a source fails, its previous timetable is kept.
// Amtrak's feed covers about a week ahead and is republished weekly, so .github/workflows/timetables.yml reruns
// this every Monday.
//
// Output (times are minutes after "noon minus 12 hours" on the train's service day, in the route's time zone,
// which is how GTFS counts them; service days follow the calendar rules below):
//   { v, built, agencies: [{ provider, valid: [from, to],
//       stations: [[code, name, tz, lat, lon]], routes: [[name, tz]],   lat/lon: where it is, for finding one station
//                                                                     listed by two railroads (null if the feed doesn't say)
//       services: [[weekdays, start, end, [added dates], [removed dates]]],   weekdays: bit 0 Monday … bit 6 Sunday
//       trains: [[number, route, service, [station, arrive, depart, station, arrive, depart, …]]] }] }
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { secs, downloadFirst, readGtfs, envKey, onlyRoutes } from './local/gtfs.mjs';
import { AGENCIES } from './src/agencies.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(dir, '..', 'data', 'timetables.json');
// a day back from UTC's date: it's still yesterday in North America for hours after midnight UTC, and that day's
// trains are still being planned and ridden
const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
const isRail = (r) => r.route_type === '2';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/* provider: the name the live feeds use, so a planned trip can be matched to the running train. */
const SOURCES = [
  {
    id: 'Amtrak', provider: 'Amtrak',
    url: 'https://content.amtrak.com/content/gtfs/GTFS.zip',
    keepRoute: isRail,   // trains only; Amtrak's feed also carries Thruway buses
    code: (s) => s.stop_id,
  },
  {
    id: 'Via', provider: 'Via',
    url: 'https://www.viarail.ca/sites/all/files/gtfs/viarail.zip',
    code: (s) => s.stop_code || s.stop_id,   // VIA's four-letter codes, as in the live feed (TRTO, VCVR)
  },
  {
    id: 'Brightline', provider: 'Brightline',
    url: 'https://feed.gobrightline.com/bl_gtfs.zip',
    code: (s) => s.stop_id,
    routeName: () => 'Brightline',
  },
  ...AGENCIES.map((a) => ({
    id: a.id, provider: a.provider,
    // a timetable behind a sign-in (NJ Transit's) is fetched with the railroad's own download, as build-schedules does
    load: a.gtfs.download && (async () => {
      const keys = [].concat(a.key || []);
      const creds = Object.fromEntries(await Promise.all([...keys, 'NJT_HOST'].map(async (k) => [k, await envKey(k, dir)])));
      if (keys.some((k) => !creds[k])) throw new Error(`no ${keys.join(' and ')} in ../.env or the environment`);
      return a.gtfs.download(creds);
    }),
    url: typeof a.gtfs.url === 'function'
      ? async () => {
        const k = await envKey(a.key, dir);
        if (!k) throw new Error(`no ${a.key} in ../.env or the environment`);
        return a.gtfs.url(k);
      }
      : a.gtfs.url,
    inner: a.gtfs.inner,
    keepRoute: a.gtfs.keepRoute || isRail,
    // platforms are shown at their station, as the feeds worker does
    station: (s, byId) => (s.parent_station && byId.has(s.parent_station) ? byId.get(s.parent_station) : s),
    code: (s) => a.id + '-' + s.stop_id,
    stationName: a.gtfs.stationName,
    routeName: a.gtfs.routeName,
    num: a.gtfs.num,
  })),
];

/* Every date from today on that a service runs: [weekdays, start, end, added, removed] as in the output. */
function datesOf([mask, start, end, added, removed]) {
  const out = new Set(added.filter((d) => d >= today));
  if (mask && end) {
    const d = new Date(Date.UTC(+(start > today ? start : today).slice(0, 4), +(start > today ? start : today).slice(4, 6) - 1, +(start > today ? start : today).slice(6, 8)));
    for (let n = 0; n < 400; n++, d.setUTCDate(d.getUTCDate() + 1)) {
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
      if (ymd > end) break;
      if (mask & (1 << ((d.getUTCDay() + 6) % 7))) out.add(ymd);
    }
  }
  for (const r of removed) out.delete(r);
  return out;
}

function build(g, src) {
  const agencyTz = new Map(g.agency.map((a) => [a.agency_id || '', a.agency_timezone]));
  const defaultTz = g.agency[0] && g.agency[0].agency_timezone;
  const byStopId = new Map(g.stops.map((s) => [s.stop_id, s]));

  const routes = [], routeIdx = new Map(), routeRow = new Map(g.routes.map((r) => [r.route_id, r]));
  for (const r of g.routes) {
    if (src.keepRoute && !src.keepRoute(r)) continue;
    routeIdx.set(r.route_id, routes.length);
    routes.push([(src.routeName ? src.routeName(r) : r.route_long_name || r.route_short_name || r.route_id).trim(), agencyTz.get(r.agency_id || '') || defaultTz]);
  }

  // services that still run today or later
  const services = [], serviceIdx = new Map();
  const exceptions = new Map();
  for (const d of g.calendar_dates) {
    if (!exceptions.has(d.service_id)) exceptions.set(d.service_id, [[], []]);
    if (d.date >= today) exceptions.get(d.service_id)[d.exception_type === '1' ? 0 : 1].push(d.date);
  }
  const serviceIds = new Set([...g.calendar.map((c) => c.service_id), ...exceptions.keys()]);
  for (const id of serviceIds) {
    const c = g.calendar.find((x) => x.service_id === id);
    const [adds, removes] = exceptions.get(id) || [[], []];
    const mask = c ? DAYS.reduce((m, d, i) => m | (c[d] === '1' ? 1 << i : 0), 0) : 0;
    const live = (c && mask && c.end_date >= today) || adds.length;
    if (!live) continue;
    serviceIdx.set(id, services.length);
    services.push([mask, c ? c.start_date : '', c ? c.end_date : '', adds.sort(), removes.sort()]);
  }

  // stop times, grouped by trip and in order
  const timesByTrip = new Map();
  for (const st of g.stop_times) {
    if (!timesByTrip.has(st.trip_id)) timesByTrip.set(st.trip_id, []);
    timesByTrip.get(st.trip_id).push(st);
  }

  const stations = [], stationIdx = new Map();
  const stationFor = (stopId) => {
    const raw = byStopId.get(stopId);
    if (!raw) return -1;
    const s = src.station ? src.station(raw, byStopId) : raw;
    const code = src.code(s);
    if (!stationIdx.has(code)) {
      stationIdx.set(code, stations.length);
      const at = (v) => (v === '' || !isFinite(+v) ? null : Math.round(+v * 1e5) / 1e5);
      stations.push([code, (src.stationName ? src.stationName(s.stop_name) : s.stop_name).trim(), s.stop_timezone || raw.stop_timezone || '',
        at(s.stop_lat ?? raw.stop_lat), at(s.stop_lon ?? raw.stop_lon)]);
    }
    return stationIdx.get(code);
  };

  /* One service index for a set of them: itself if there's one, else a new service listing every date any of
     them runs, from today to the end of the feed. */
  const merged = new Map();
  function mergedService(set) {
    if (set.size === 1) return [...set][0];
    const ids = [...set].sort((x, y) => x - y), key = ids.join(',');
    if (!merged.has(key)) {
      const dates = new Set();
      for (const i of ids) for (const d of datesOf(services[i])) dates.add(d);
      merged.set(key, services.length);
      services.push([0, '', '', [...dates].sort(), []]);
    }
    return merged.get(key);
  }

  const trains = [], byRun = new Map();
  for (const t of g.trips) {
    if (!routeIdx.has(t.route_id) || !serviceIdx.has(t.service_id)) continue;
    const times = (timesByTrip.get(t.trip_id) || []).sort((a, b) => a.stop_sequence - b.stop_sequence);
    const flat = [];
    for (const st of times) {
      const i = stationFor(st.stop_id);
      if (i < 0) continue;
      const arr = Math.round(secs(st.arrival_time || st.departure_time) / 60), dep = Math.round(secs(st.departure_time || st.arrival_time) / 60);
      if (flat.length && flat[flat.length - 3] === i) { flat[flat.length - 1] = dep; continue; }   // two platforms of one station in a row
      flat.push(i, arr, dep);
    }
    if (flat.length < 6) continue;
    const num = String(src.num ? src.num(t, { route: routeRow.get(t.route_id), dep: flat[2] * 60 }) : t.trip_short_name || t.trip_id).trim();
    // the same train on several calendars (Metro-North lists one trip per date) is kept once, its days merged
    const key = JSON.stringify([num, routeIdx.get(t.route_id), flat]);
    const same = byRun.get(key);
    if (same) { same[2].add(serviceIdx.get(t.service_id)); continue; }
    const train = [num, routeIdx.get(t.route_id), new Set([serviceIdx.get(t.service_id)]), flat];
    byRun.set(key, train);
    trains.push(train);
  }
  for (const t of trains) t[2] = mergedService(t[2]);
  // fill in time zones the feed left to the agency
  for (const s of stations) if (!s[2]) s[2] = defaultTz;

  const info = g.feed_info[0] || {};
  const starts = services.map((s) => s[1] || s[3][0]).filter(Boolean).sort();
  const ends = services.map((s) => [s[2], ...s[3]].filter(Boolean).sort().pop()).filter(Boolean).sort();
  return {
    provider: src.provider,
    valid: [info.feed_start_date || starts[0] || today, info.feed_end_date || ends[ends.length - 1] || today],
    stations, routes, services, trains,
  };
}

let previous = null;
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

const only = process.argv.slice(2).map((x) => x.toLowerCase());
const unknown = only.filter((x) => !SOURCES.some((s) => s.id.toLowerCase() === x || s.provider.toLowerCase() === x));
if (unknown.length) { console.error(`No railroad called ${unknown.join(', ')}. Use: ${SOURCES.map((s) => s.id).join(', ')}`); process.exit(1); }
const agencies = [];
let failures = 0;
for (const src of SOURCES) {
  if (only.length && !only.includes(src.id.toLowerCase()) && !only.includes(src.provider.toLowerCase())) {
    const old = previous && previous.agencies.find((a) => a.provider === src.provider);
    if (old) agencies.push(old);
    continue;
  }
  try {
    const zip = src.load ? await src.load() : await downloadFirst(typeof src.url === 'function' ? await src.url() : src.url);
    const a = build(await readGtfs(zip, { inner: src.inner, keep: src.keepRoute && onlyRoutes(src.keepRoute) }), src);
    if (!a.trains.length) throw new Error('the feed had no current trains');
    agencies.push(a);
    console.log(`${src.provider}: ${a.trains.length} train runs, ${a.stations.length} stations, valid ${a.valid[0]}–${a.valid[1]}`);
  } catch (err) {
    failures++;
    const old = previous && previous.agencies.find((a) => a.provider === src.provider);
    if (old) { agencies.push(old); console.warn(`${src.provider}: ${err.message}. Kept the previous timetable.`); }
    else console.warn(`${src.provider}: ${err.message}. Left out.`);
  }
}
if (!agencies.length) { console.error('No timetables could be built.'); process.exit(1); }

const out = { v: 1, built: new Date().toISOString().slice(0, 10), agencies };   // the app keeps whichever copy is newer
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(JSON.stringify(out).length / 1024)} KB)`);
if (failures) process.exitCode = 2;   // written, but something needs a look
