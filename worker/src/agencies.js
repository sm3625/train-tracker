/* Every railroad the feeds worker serves, in one place. Adding one is a new entry here, then
   `npm run schedules` (which reads `gtfs`) and a deploy.

   id is also the prefix of the railroad's station codes (ML-123) and train ids (5321-ML).

   Live feeds (GTFS-Realtime):
     vehicles, trips   { url, fresh }: fresh is how many seconds a fetched copy is reused; url may be a list of
                       fallbacks, tried in order. `trips` is optional:
                       vehicle positions and trip updates are read from whichever feed carries them.
     key               the Worker secret the feeds need, if any; without it the railroad is left out.
     auth(env, url)    how the key is sent: { url } and/or { headers }.
     mixed             the feed also carries buses or light rail: keep only trips found in the rail timetable.
     joinBy            'trip' (default): vehicles and trip updates share a trip_id.
                       'entity': they only share the entity id (Metro-North uses the train number for it).

   Timetable (static GTFS), boiled down by build-schedules.mjs into schedules.json:
     url               the zip, a list of zips to try in order, or (key) => url when the download needs a key
     inner             a zip inside the zip that holds the rail feed (SEPTA ships bus and rail together)
     keepRoute(r)      which routes are trains (default: GTFS route_type 2, rail)
     routeName(r)      the line's display name
     stationName(n)    tidies a station name
     num(t, run)       the public train number (default: trip_short_name, else trip_id). run is { route, dep }: the
                       trip's routes.txt row and its first departure, in seconds after the service day's start
   Platforms are folded into their parent station, so trains are shown at the station. */
import { njtFeed, njtGtfs } from './njt.js';

const route = (r) => (r.route_long_name || r.route_short_name || r.route_id).trim();
const line = (r) => { const n = route(r); return /\b(line|branch|service|corridor)\b/i.test(n) ? n : n + ' Line'; };
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
/* For railroads that don't number their trains: the line and the time it leaves, A1415 for the 2:15 pm A Line */
const hhmm = (sec) => String(Math.floor(sec / 3600) % 24).padStart(2, '0') + String(Math.floor(sec / 60) % 60).padStart(2, '0');

export const AGENCIES = [
  {
    id: 'ML', provider: 'Metrolink', state: 'CA',
    key: 'METROLINK_API_KEY',
    auth: (env) => ({ headers: { 'X-Api-Key': env.METROLINK_API_KEY } }),
    vehicles: { url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-vehicles', fresh: 30 },
    trips: { url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-trips', fresh: 30 },
    gtfs: {
      url: 'https://metrolinktrains.com/globalassets/about/gtfs/gtfs.zip',
      // "Metrolink Inland Empire-Orange County Line" reads better than the route_id "Inland Emp.-Orange Co. Line"
      routeName: (r) => (r.route_long_name || r.route_id).replace(/^Metrolink\s+/, ''),
    },
  },
  {
    // 511 allows 60 requests an hour per token, shared by both feeds, so they're polled gently
    id: 'CT', provider: 'Caltrain', state: 'CA',
    key: 'CALTRAIN_511_KEY',
    auth: (env, url) => ({ url: url + '&api_key=' + encodeURIComponent(env.CALTRAIN_511_KEY) }),
    vehicles: { url: 'https://api.511.org/transit/vehiclepositions?agency=CT', fresh: 120 },
    trips: { url: 'https://api.511.org/transit/tripupdates?agency=CT', fresh: 240 },
    gtfs: {
      url: (key) => `https://api.511.org/transit/datafeeds?api_key=${encodeURIComponent(key)}&operator_id=CT`,
      keepRoute: () => true,
      routeName: (r) => {
        const base = (r.route_short_name || r.route_id).replace(/\s+Week(day|end)$/i, '');
        return /south county/i.test(base) ? 'South County Connector' : 'Caltrain ' + base;
      },
      stationName: (n) => n.replace(/\s+(Caltrain\s+)?Station$/i, ''),
    },
  },
  {
    id: 'LI', provider: 'LIRR', state: 'NY',
    vehicles: { url: MTA + 'lirr%2Fgtfs-lirr', fresh: 30 },
    gtfs: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip' },
  },
  {
    // Vehicles and trip updates are tied together only by the entity id, which is the train number.
    id: 'MN', provider: 'Metro-North', state: 'NY',
    joinBy: 'entity',
    vehicles: { url: MTA + 'mnr%2Fgtfs-mnr', fresh: 30 },
    gtfs: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip', routeName: line },
  },
  {
    id: 'SE', provider: 'SEPTA', state: 'PA',
    vehicles: { url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Vehicle/rtVehiclePosition.pb', fresh: 30 },
    trips: { url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb', fresh: 30 },
    gtfs: {
      url: 'https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip',
      inner: 'google_rail.zip',
      num: (t) => (t.trip_short_name || t.trip_id).replace(/^[A-Z]+/, ''),   // CYN1052 -> 1052
    },
  },
  {
    id: 'MB', provider: 'MBTA', state: 'MA',
    mixed: true,
    vehicles: { url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb', fresh: 30 },
    trips: { url: 'https://cdn.mbta.com/realtime/TripUpdates.pb', fresh: 30 },
    gtfs: { url: 'https://cdn.mbta.com/MBTA_GTFS.zip' },
  },
  {
    id: 'MA', provider: 'MARC', state: 'MD',
    vehicles: { url: 'https://mdotmta-gtfs-rt.s3.amazonaws.com/MARC+RT/marc-vp.pb', fresh: 30 },
    trips: { url: 'https://mdotmta-gtfs-rt.s3.amazonaws.com/MARC+RT/marc-tu.pb', fresh: 30 },
    gtfs: {
      url: 'https://mdotmta-gtfs.s3.amazonaws.com/mdotmta_gtfs_marc.zip',
      routeName: (r) => {   // "PENN - WASHINGTON" -> "Penn Line"
        const n = (r.route_long_name || '').split(/\s+-\s+/)[0];
        return n ? titleCase(n) + ' Line' : 'MARC';
      },
      num: (t) => (t.trip_short_name || t.trip_id).replace(/^Train\s*/i, ''),
    },
  },
  {
    id: 'VR', provider: 'VRE', state: 'VA',
    vehicles: { url: 'https://gtfs.vre.org/containercdngtfsupload/VehiclePositionFeed', fresh: 30 },
    trips: { url: 'https://gtfs.vre.org/containercdngtfsupload/TripUpdateFeed', fresh: 30 },
    gtfs: { url: 'https://gtfs.vre.org/containercdngtfsupload/google_transit.zip' },
  },
  {
    id: 'TR', provider: 'Tri-Rail', state: 'FL',
    // its HTTPS server only offers an old cipher (ECDHE-RSA-AES256-SHA384); plain HTTP is the fallback
    vehicles: { url: ['https://gtfsr.tri-rail.com/download.aspx?file=position_updates.pb', 'http://gtfsr.tri-rail.com/download.aspx?file=position_updates.pb'], fresh: 30 },
    trips: { url: ['https://gtfsr.tri-rail.com/download.aspx?file=trip_updates.pb', 'http://gtfsr.tri-rail.com/download.aspx?file=trip_updates.pb'], fresh: 30 },
    gtfs: {
      url: 'https://gtfs.tri-rail.com/gtfs.zip',
      routeName: (r) => (/mainline/i.test(r.route_long_name) ? 'Tri-Rail' : route(r)),
      num: (t) => t.trip_id.replace(/^P/, ''),   // P601 -> 601
    },
  },
  {
    id: 'SS', provider: 'South Shore Line', state: 'IN',
    vehicles: { url: 'https://s3.amazonaws.com/etatransit.gtfs/southshore.etaspot.net/position_updates.pb', fresh: 30 },
    trips: { url: 'https://s3.amazonaws.com/etatransit.gtfs/southshore.etaspot.net/trip_updates.pb', fresh: 30 },
    gtfs: {
      url: 'https://s3.amazonaws.com/etatransit.gtfs/southshore.etaspot.net/gtfs.zip',
      routeName: (r) => route(r).replace(/\s+/g, ' '),
    },
  },
  {
    // UTA's own link (gtfsfeed.rideuta.com/GTFS.zip) has been returning 404; the Mobility Database keeps a copy
    id: 'UT', provider: 'FrontRunner', state: 'UT',
    mixed: true,
    vehicles: { url: 'https://apps.rideuta.com/tms/gtfs/Vehicle', fresh: 30 },
    trips: { url: 'https://apps.rideuta.com/tms/gtfs/TripUpdate', fresh: 30 },
    gtfs: {
      url: ['https://gtfsfeed.rideuta.com/GTFS.zip', 'https://files.mobilitydatabase.org/mdb-170/latest.zip'],
      num: (t, run) => 'FR' + hhmm(run.dep),
    },
  },
  {
    // RTD's trip updates are a third of a megabyte, mostly buses; vehicles alone, against the timetable, will do
    id: 'RD', provider: 'RTD', state: 'CO',
    mixed: true,
    vehicles: { url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb', fresh: 30 },
    gtfs: {
      url: 'https://www.rtd-denver.com/files/gtfs/google_transit.zip',
      routeName: (r) => `${r.route_short_name} Line`,
      num: (t, run) => run.route.route_short_name + hhmm(run.dep),
    },
  },
  {
    // Feeds are POSTs that take a token, which the username and password buy (see njt.js); the schedule is fetched
    // the same way by build-schedules.mjs. The realtime feeds are unlimited; the token sign-in is capped at 10 a day.
    id: 'NJ', provider: 'NJ Transit', state: 'NJ',
    key: ['NJT_USERNAME', 'NJT_PASSWORD'],
    auth: (env, endpoint) => ({ load: (signal) => njtFeed(env, endpoint, signal) }),
    vehicles: { url: 'getVehiclePositions', fresh: 30 },
    trips: { url: 'getTripUpdates', fresh: 30 },
    gtfs: {
      download: njtGtfs,
      keepRoute: () => true,   // every route in the feed is rail; its route_type is 113 (railway service), not 2
      // NJ names its stations in capitals: "NEWARK PENN STATION" -> "Newark Penn Station", keeping MSU, NJ, NY and PHL
      stationName: (n) => titleCase(n).replace(/\b(Msu|Nj|Ny|Phl)\b/g, (w) => w.toUpperCase()).replace(/\s*\[Rr\]$/, ''),
      num: (t) => (t.trip_short_name || t.trip_id).replace(/^0+/, ''),   // 0057 -> 57
    },
  },
  {
    id: 'ME', provider: 'Metra', state: 'IL',
    key: 'METRA_API_KEY',
    auth: (env, url) => ({ url: url + '?api_token=' + encodeURIComponent(env.METRA_API_KEY) }),
    vehicles: { url: 'https://gtfspublic.metrarr.com/gtfs/public/positions', fresh: 30 },
    trips: { url: 'https://gtfspublic.metrarr.com/gtfs/public/tripupdates', fresh: 30 },
    gtfs: {
      url: 'https://schedules.metrarail.com/gtfs/schedule.zip',
      routeName: (r) => r.route_long_name || r.route_id,
      num: (t) => (/_[A-Z]+(\d+)_/.exec(t.trip_id) || [])[1] || t.trip_id,   // BNSF_BN1200_V4_A -> 1200
    },
  },
];

export const PROVIDERS = AGENCIES.map((a) => a.provider);
export const SECRET_KEYS = [...new Set(AGENCIES.flatMap((a) => [].concat(a.key || [])))];
