/* Trip alerts: what to tell someone about a train they've saved as a trip. Its departure from their station is
   coming up, it's running late (or has caught up), it's cancelled, or it's nearly at their stop.

   Pure functions with no I/O and no imports, so the same rules run in two places:
   - on the phone, today: app/build.mjs copies this file into the app, and index.html shows the results as local
     notifications (`tripAlerts` in index.html).
   - in this worker, later: a scheduled job that loads trips, builds the same snapshots from the feeds, keeps each
     trip's `state` in the database and sends the events as push notifications (Phase 2 of
     docs/implementation-plan.md). Nothing in the worker imports this file yet.

   The flow, wherever it runs:
     snap = snapshot(train, trip)                  what the live train means for this trip (null: not found in it)
     { events, state } = evaluate(trip, state, snap, now)   send each event now; keep state for the next run
     reminders(trip, snap, now)                    notifications for set times; replace the earlier set with these

   A trip is { id, provider, num, date, route, from: { code, name, at, tz }, to: { … } }, as /v1/me/trips gives it,
   with `at` in milliseconds. A train has the stops of /v1/trains (Amtraker's shape: { code, name, tz, arr, schArr,
   dep, schDep } with ISO times) and lastIdx: the index of the last stop it has left, -1 before it starts. */

export const RULES = {
  delayAlertMin: 10,          // a train this late (at the rider's stop) gets an alert …
  delayStepMin: 10,           // … and another each time the delay changes by this much, either way
  delayCooldownMs: 5 * 60000, // no two delay alerts for one trip closer together than this
  staleMs: 20 * 60000,        // a report older than this says nothing new about delays (the freshness contract)
  boardLeadMs: 10 * 60000,    // "leaves your station in 10 min"
  arriveLeadMs: 5 * 60000,    // "arriving at your stop in 5 min"
  horizonMs: 36 * 3600000,    // reminders are set for trips leaving within this long
};

const time = (iso) => (iso ? Date.parse(iso) : NaN);
const first = (a, b) => (isNaN(a) ? b : a);
const minutesBetween = (a, b) => (isNaN(a) || isNaN(b) ? null : Math.round((a - b) / 60000));

/* The live train, seen from the rider's two stops. Times are milliseconds; delays are minutes (negative: early). */
export function snapshot(train, trip) {
  if (!train || !Array.isArray(train.stops)) return null;
  const stops = train.stops;
  const i = stops.findIndex((s) => s.code === trip.from.code);
  const j = stops.findIndex((s, k) => k > i && s.code === trip.to.code);
  const lastIdx = Number.isInteger(train.lastIdx) ? train.lastIdx : -1;
  // a stop with no departure time (the last) or no arrival (the first) has the other
  const at = (s, dep) => {
    if (!s) return { at: NaN, delay: null };
    const act = dep ? first(time(s.dep), time(s.arr)) : first(time(s.arr), time(s.dep));
    const sch = dep ? first(time(s.schDep), time(s.schArr)) : first(time(s.schArr), time(s.schDep));
    return { at: first(act, sch), delay: minutesBetween(act, sch) };
  };
  const dep = at(stops[i], true), arr = at(stops[j], false);
  return {
    cancelled: !!train.cancelled,
    found: i >= 0 && j >= 0,
    departAt: i >= 0 ? dep.at : trip.from.at,
    departDelay: i >= 0 ? dep.delay : null,
    arriveAt: j >= 0 ? arr.at : trip.to.at,
    arriveDelay: j >= 0 ? arr.delay : null,
    departed: i >= 0 && lastIdx >= i,
    arrived: j >= 0 && lastIdx >= j,
    reportedAt: Number(train.reportedAt) || null,
  };
}

/* What's changed since the last run. `state` is what the previous call returned (undefined the first time). The
   first look at a train sets the baseline, except that a train already late or cancelled is worth saying so. */
export function evaluate(trip, state, snap, now = Date.now(), rules = RULES) {
  const prev = state || { delay: 0, cancelled: false, delayAt: 0 };
  const next = { ...prev };
  const events = [];
  if (!snap) return { events, state: next };
  const name = trainName(trip);

  if (snap.cancelled && !prev.cancelled) {
    events.push({ kind: 'cancelled', key: `${trip.id}:cancelled`, trip: trip.id,
      title: `${name} is cancelled`, body: `Your trip from ${trip.from.name} to ${trip.to.name} ${dayPart(trip.from.at, trip.from.tz, now)}.` });
  }
  next.cancelled = snap.cancelled;
  if (snap.cancelled || snap.arrived) return { events, state: next };

  const fresh = snap.reportedAt == null || now - snap.reportedAt <= rules.staleMs;
  const onBoardLeg = snap.departed;
  const delay = onBoardLeg ? snap.arriveDelay ?? snap.departDelay : snap.departDelay ?? snap.arriveDelay;
  if (fresh && delay != null) {
    const was = prev.delay || 0;
    const late = Math.max(delay, 0);
    const big = late >= rules.delayAlertMin || was >= rules.delayAlertMin;
    const moved = Math.abs(late - was) >= rules.delayStepMin;
    const cooled = now - (prev.delayAt || 0) >= rules.delayCooldownMs;
    if (big && moved && cooled) {
      const stop = onBoardLeg ? trip.to : trip.from;
      const when = onBoardLeg ? snap.arriveAt : snap.departAt;
      const verb = onBoardLeg ? 'Now due at' : 'Now leaves';
      events.push({ kind: 'delay', key: `${trip.id}:delay:${late}`, trip: trip.id,
        title: late >= rules.delayAlertMin ? `${name} is ${late} min late` : `${name} is back on time`,
        body: `${verb} ${stop.name} at ${clock(when, stop.tz)}${late > 0 && late < rules.delayAlertMin ? `, ${late} min late` : ''}.` });
      next.delay = late;
      next.delayAt = now;
    }
  }
  return { events, state: next };
}

/* Notifications for set times: the train approaching the rider's station, and nearing their stop. Recompute on
   every update and replace the earlier ones (each has a stable key), so they follow the latest times. snap may
   be null for a train not running yet: the timetable's times are used. */
export function reminders(trip, snap, now = Date.now(), rules = RULES) {
  const out = [];
  if (snap && (snap.cancelled || snap.arrived)) return out;
  const departAt = snap ? snap.departAt : trip.from.at;
  const arriveAt = snap ? snap.arriveAt : trip.to.at;
  if (isNaN(departAt) || departAt - now > rules.horizonMs) return out;
  const name = trainName(trip);
  const late = (d) => (d != null && d >= 5 ? `, ${d} min late` : '');

  const board = departAt - rules.boardLeadMs;
  if (!(snap && snap.departed) && board > now) {
    out.push({ kind: 'board', key: `${trip.id}:board`, trip: trip.id, at: board,
      title: `${name} leaves ${trip.from.name} in ${Math.round(rules.boardLeadMs / 60000)} min`,
      body: `Due at ${clock(departAt, trip.from.tz)}${late(snap && snap.departDelay)}. Arrives ${trip.to.name} ${clock(arriveAt, trip.to.tz)}.` });
  }
  const arrive = arriveAt - rules.arriveLeadMs;
  if (!isNaN(arriveAt) && arrive > now) {
    out.push({ kind: 'arrive', key: `${trip.id}:arrive`, trip: trip.id, at: arrive,
      title: `Arriving at ${trip.to.name} in ${Math.round(rules.arriveLeadMs / 60000)} min`,
      body: `${name}, due at ${clock(arriveAt, trip.to.tz)}${late(snap && snap.arriveDelay)}. Time to get ready.` });
  }
  return out;
}

export const trainName = (trip) => `${/^\d/.test(trip.num) ? 'Train ' : ''}${trip.num}${trip.route ? ' ' + trip.route : ''}`;

/* Formatters are slow to make, so each is made once. A time zone the feed got wrong falls back to the local one. */
const formats = new Map();
function fmt(locale, tz, opts) {
  const key = locale + '|' + tz + '|' + JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat(locale, tz ? { ...opts, timeZone: tz } : opts); } catch { f = new Intl.DateTimeFormat(locale, opts); }
    formats.set(key, f);
  }
  return f;
}
export const clock = (at, tz) => (isNaN(at) ? '—' : fmt('en-US', tz, { hour: 'numeric', minute: '2-digit' }).format(at));

/* "today at 5:42 PM", "tomorrow at 7:10 AM", "on Fri, Nov 13 at 9:00 AM", in the station's time zone. */
function dayPart(at, tz, now) {
  const ymd = (t) => fmt('en-CA', tz, {}).format(t);
  const days = Math.round((Date.parse(ymd(at)) - Date.parse(ymd(now))) / 86400000);
  const word = days === 0 ? 'today' : days === 1 ? 'tomorrow'
    : 'on ' + fmt('en-US', tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  return `${word} at ${clock(at, tz)}`;
}
