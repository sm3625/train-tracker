/* Trackside feeds: a Cloudflare Worker that polls the commuter railroads' GTFS-Realtime feeds (holding the API
   keys some of them need) and serves their trains as JSON shaped like the Amtraker API, so the site can treat
   them like any other operator. The railroads are listed in agencies.js. Keys live only in this worker's
   secrets; nothing it returns contains them.

   GET /v1/trains    { Metrolink: [train…], LIRR: [train…], … }   (feed health in the X-Feed-Status header)
   GET /v1/stations  { code: { code, name, label, city, state, lat, lon } }

   It also serves Trackside accounts (/v1/auth/…, /v1/me…): see accounts.js.

   Every minute (wrangler.toml [triggers]) it records how late trains ran, for typical delays: see recordDelays()
   below, delays.js and docs/delay-history-plan.md.
*/
import { decodeFeed } from './gtfsrt.js';
import { corsHeaders, json } from './http.js';
import { isAccountsPath, handleAccounts } from './accounts.js';
import { AGENCIES, SECRET_KEYS } from './agencies.js';
import { buildTrains, railFilter, feedSilence, GONE_MS } from './trains.js';
import { due, observe, summarize, HISTORY } from './delays.js';
import { storeFor } from './store/index.js';
import { sharePage, appleAssociation, androidAssociation } from './share.js';
import SCHEDULES from './schedules.json' with { type: 'json' };

const KEEP_STALE = 30 * 60;   // after an upstream error, keep serving the last good copy this long (seconds)
const FETCH_TIMEOUT = 8000;   // one slow railroad mustn't hold up the rest
const REBUILDS_PER_REQUEST = 4;   // railroads one request may rebuild when older builds are on hand (see railroad())
// Workers Free allows 50 subrequests per request, and Cache API calls count toward that too. Stay under it.
const SUBREQUEST_BUDGET = 45;

/* ---------------- caches ----------------
   Each isolate keeps feed bytes and builds in memory. Built trains are also in Cloudflare's Cache API so every
   isolate can share them (local dev has no Cache API, so memory alone is used there). Feed bytes stay in memory:
   they're only needed to rebuild, and sharing them would spend the request budget on cache calls. */
/* Memory holds plain values ({ body, at }), never Response objects: a Response's body stream can only be read once
   and cloning one after a read throws, which failed every request once a build had been read from memory. */
const memo = new Map();
const cacheKey = (name) => new Request('https://trackside-feeds.internal/' + encodeURIComponent(name));
const ageOf = (at) => (Date.now() - at) / 1000;
const hasCacheApi = () => typeof caches !== 'undefined';
/* Takes subrequests from this request's budget. Returns false when there aren't enough left. No budget, no limit. */
function spend(budget, n = 1) {
  if (!budget) return true;
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}
function memoGet(name) {
  const r = memo.get(name);
  return r ? { body: r.body, age: ageOf(r.at) } : null;
}
function memoPut(name, body) {
  memo.set(name, { body, at: Date.now() });
}
/* A shared build, as its JSON text, with its age. */
async function sharedGet(name, budget) {
  const mem = memoGet(name);
  if (mem || !hasCacheApi() || !spend(budget)) return mem;
  const hit = await caches.default.match(cacheKey(name));
  if (!hit) return null;
  const body = await hit.text(), at = Number(hit.headers.get('x-fetched-at'));
  memo.set(name, { body, at });
  return { body, age: ageOf(at) };
}
function sharedPut(name, body, ctx, budget) {
  memo.set(name, { body, at: Date.now() });
  if (hasCacheApi() && spend(budget)) {
    const res = new Response(body, { headers: { 'x-fetched-at': String(Date.now()), 'cache-control': `max-age=${KEEP_STALE}` } });
    ctx.waitUntil(caches.default.put(cacheKey(name), res).catch(() => { /* the next request fetches again */ }));
  }
}

/* One upstream feed. The cache key is the URL without the key, so the key is never stored or logged.
   url may list fallbacks, tried in order (Tri-Rail's HTTPS server offers only a cipher some clients refuse). */
async function fetchFeed(name, url, auth, env, budget) {
  if (!spend(budget)) throw new Error(`${name}: over this request's limit, retrying on the next one`);
  const a = auth ? auth(env, url) : {};
  let bytes;
  if (a.load) bytes = await a.load(AbortSignal.timeout(FETCH_TIMEOUT));   // for feeds that need a token or a POST
  else {
    const res = await fetch(a.url || url, { headers: a.headers || {}, cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  decodeFeed(bytes, () => false);   // don't cache something that isn't a feed (an HTML error page, say)
  return bytes;
}
async function feed(name, { url, fresh }, auth, env, budget) {
  const urls = [].concat(url);
  const hit = memoGet(name + ' ' + urls[0]);
  if (hit && hit.age < fresh) return { bytes: new Uint8Array(hit.body), age: hit.age };
  try {
    let bytes, first;
    for (const u of urls) {
      try { bytes = await fetchFeed(name, u, auth, env, budget); break; } catch (err) { first ||= err; }
    }
    if (!bytes) throw first;
    memoPut(name + ' ' + urls[0], bytes);
    return { bytes, age: 0 };
  } catch (err) {
    if (hit && hit.age < KEEP_STALE) return { bytes: new Uint8Array(hit.body), age: hit.age, error: err.message };
    throw err;
  }
}

/* One railroad's trains, rebuilt at most as often as its feeds refresh. Returns { trains, status }.
   mayRebuild() says whether this request still has room to rebuild; if not, a recent build is served as is.
   That spreads the decoding over requests, since Workers limit the CPU time of each one. */
async function railroad(a, env, ctx, now, mayRebuild, budget) {
  const sched = SCHEDULES[a.id];
  if (!sched) return { trains: [], status: 'no timetable (run npm run schedules)' };
  const keys = [].concat(a.key || []);
  if (keys.some((k) => !env[k])) return { trains: [], status: 'no key configured' };
  const sources = [['vehicles', a.vehicles], ['trips', a.trips]].filter(([, f]) => f);
  const fresh = Math.min(...sources.map(([, f]) => f.fresh));
  const built = await sharedGet('built ' + a.id, budget);
  if (built && (built.age < fresh || (built.age < KEEP_STALE / 6 && !mayRebuild()))) return JSON.parse(built.body);
  // a rebuild needs one fetch per feed and one cache write; without that much left this request, serve what there is
  if (budget && budget.left < sources.length + 1) {
    if (built && built.age < KEEP_STALE) { const old = JSON.parse(built.body); return { trains: old.trains, status: 'waiting: showing the last build' }; }
    return { trains: [], status: 'waiting: request limit, will retry' };
  }
  try {
    // one feed lost costs what it adds, not the railroad: trains still come from the other (FrontRunner's trip updates)
    const settled = await Promise.allSettled(sources.map(([kind, f]) => feed(a.provider + ' ' + kind, f, a.auth, env, budget)));
    const lost = settled.find((r) => r.status === 'rejected');
    const got = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!got.length) throw lost.reason;
    const keep = a.mixed ? railFilter(sched) : undefined;
    const feeds = got.map((g) => decodeFeed(g.bytes, keep));
    const trains = buildTrains(a, sched, feeds, now);
    const err = (lost && { error: lost.reason.message }) || got.find((g) => g.error);
    const quiet = feedSilence(feeds, now);   // a feed that answers but has stopped updating (see GONE_MS)
    const status = err ? 'stale: ' + scrub(err.error, env)
      : quiet > GONE_MS ? `stale: the feed hasn't updated in ${Math.round(quiet / 3600000)} h; its trains are left out` : 'ok';
    const result = { trains, status };
    sharedPut('built ' + a.id, JSON.stringify(result), ctx, budget);
    return result;
  } catch (err) {
    if (built && built.age < KEEP_STALE) { const old = JSON.parse(built.body); return { trains: old.trains, status: 'stale: ' + scrub(err.message, env) }; }
    return { trains: [], status: 'error: ' + scrub(err.message, env) };
  }
}

function stationList() {
  const out = {};
  for (const a of AGENCIES) {
    const sched = SCHEDULES[a.id];
    if (!sched) continue;
    for (const [code, [name, lat, lon]] of Object.entries(sched.stations)) {
      out[code] = { code, name, label: a.provider, city: '', state: a.state, lat, lon };
    }
  }
  return out;
}

/* ---------------- delay recorder (scheduled) ----------------
   Each run reads the one or two sources most due (delays.js due()) and keeps their trips under way in D1, which,
   unlike the Cache API, every data centre sees. Workers Free allows 10 ms of CPU per run, so a railroad is read
   from a build a visitor's request made in the last 90 s if there is one, and otherwise from its trip updates
   alone: positions aren't needed to know how late a train is. */
const AMTRAKER = 'https://api-v3.amtraker.com/v3/trains';
const REUSE_BUILD_S = 90;

async function recorderTrains(source, env, now, budget) {
  if (source === 'amtraker') {
    if (!spend(budget)) throw new Error('over this run\'s request limit');
    const res = await fetch(AMTRAKER, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`Amtraker: HTTP ${res.status}`);
    return Object.values(await res.json()).flat();
  }
  const a = AGENCIES.find((x) => x.id === source), sched = SCHEDULES[source];
  const built = await sharedGet('built ' + a.id, budget);
  if (built && built.age < REUSE_BUILD_S) return JSON.parse(built.body).trains;
  const [kind, f] = a.trips ? ['trips', a.trips] : ['vehicles', a.vehicles];
  const { bytes } = await feed(a.provider + ' ' + kind, f, a.auth, env, budget);
  return buildTrains(a, sched, [decodeFeed(bytes, a.mixed ? railFilter(sched) : undefined)], now);
}

/* The sources the recorder can read: Amtraker, and every railroad with a timetable and its keys. */
const recorderSources = (env) => ['amtraker', ...AGENCIES
  .filter((a) => SCHEDULES[a.id] && [].concat(a.key || []).every((k) => env[k])).map((a) => a.id)];

export async function recordDelays(env, now = Date.now()) {
  const store = storeFor(env);
  if (!store) return [];
  const budget = { left: SUBREQUEST_BUDGET };
  const done = [];
  for (const source of due(recorderSources(env), await store.getRecorderReads(), now)) {
    const state = await store.getRecorderState(source);
    let trains;
    try {
      trains = await recorderTrains(source, env, now, budget);
    } catch (err) {
      // marked read all the same, so one railroad that's down doesn't take every turn from the others
      console.error('recorder:', source, scrub(err.message, env));
      await store.saveRecorderRead(source, { at: now, idle: false, state: state || { trips: {} } }, []);
      done.push({ source, error: scrub(err.message, env) });
      continue;
    }
    const r = observe(state, trains, now);
    await store.saveRecorderRead(source, { at: now, idle: !r.running, state: r.state }, r.finished);
    done.push({ source, trains: trains.length, finished: r.finished.length });
  }
  return done;
}

/* ---------------- delay history ---------------- */
/* GET /v1/delays?provider=LIRR&num=2034&day=wkd: how late that train usually is, stop by stop, over the last 45 days
   (63 for Saturdays and Sundays, so they can reach 8 trips)
   (summarize() in delays.js). null when it has too few trips. One indexed read of at most 45 rows. DELAYS_MIN_TRIPS
   lowers the 8-trip minimum, for trying it locally on a few days' history. */
async function delays(url, req, env) {
  const provider = url.searchParams.get('provider') || '', num = url.searchParams.get('num') || '', day = url.searchParams.get('day');
  if (!provider || provider.length > 40 || !num || num.length > 16 || !['wkd', 'sat', 'sun'].includes(day)) {
    return json({ error: { code: 'bad_request', message: 'Needs provider, num and day (wkd, sat or sun).' } }, req, env, { 'Cache-Control': 'no-store' }, 400);
  }
  const store = storeFor(env);
  if (!store) return json({ error: { code: 'unavailable', message: 'No delay history here.' } }, req, env, { 'Cache-Control': 'no-store' }, 503);
  const days = day === 'wkd' ? HISTORY.days : HISTORY.weekendDays;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const runs = await store.listTrainRuns(provider, num, day, since);
  const minTrips = Number(env.DELAYS_MIN_TRIPS) || HISTORY.minTrips;
  const stats = summarize(runs, { minTrips });
  return json({ provider, num, day, since, days, minTrips, onTimeMin: HISTORY.onTimeMin, trips: runs.length, stats },
    req, env, { 'Cache-Control': 'public, max-age=3600' });
}

/* ---------------- HTTP ---------------- */
/* Error text is passed to the page, so blank out the keys in case an error message ever echoes a URL. */
function scrub(msg, env) {
  let s = String(msg || 'error');
  for (const k of SECRET_KEYS) if (env[k]) s = s.split(env[k]).join('…');
  return s.replace(/(api_key|api_token)=[^&\s]+/gi, '$1=…');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: {
        ...corsHeaders(req, env), 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400',
      } });
    }
    if (isAccountsPath(url.pathname)) return handleAccounts(req, env, ctx, url);
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    // trip share links (share.js): the page a browser sees, and the files that let the apps open them instead
    const s = /^\/s\/([\w-]{1,64})$/.exec(url.pathname);
    if (s) return sharePage(storeFor(env), env, s[1]);
    if (url.pathname === '/.well-known/apple-app-site-association') return appleAssociation(env);
    if (url.pathname === '/.well-known/assetlinks.json') return androidAssociation(env);
    // per address, per Cloudflare location (wrangler.toml [[ratelimits]]). It spares the railroads' feeds and the
    // worker's CPU from one script hammering; the blocked request still counts toward the worker's daily requests.
    if (env.FEEDS_LIMIT && (url.pathname === '/v1/trains' || url.pathname === '/v1/stations' || url.pathname === '/v1/delays')) {
      const { success } = await env.FEEDS_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, req, env, { 'Retry-After': '60', 'Cache-Control': 'no-store' }, 429);
    }

    if (url.pathname === '/v1/stations') {
      return json(stationList(), req, env, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (url.pathname === '/v1/delays') return delays(url, req, env);
    if (url.pathname === '/v1/trains') {
      const now = Date.now();
      const result = {}, status = {};
      let rebuilds = REBUILDS_PER_REQUEST;
      const budget = { left: SUBREQUEST_BUDGET };
      await Promise.all(AGENCIES.map(async (a) => {
        const r = await railroad(a, env, ctx, now, () => rebuilds-- > 0, budget);
        result[a.provider] = r.trains;
        status[a.provider] = r.status;
      }));
      // feed health goes in a header so the body stays shaped like Amtraker's (an object of train arrays)
      return json(result, req, env, { 'Cache-Control': 'public, max-age=15', 'X-Feed-Status': JSON.stringify(status), 'Access-Control-Expose-Headers': 'X-Feed-Status' });
    }
    if (url.pathname === '/') return new Response('Trackside feeds. See /v1/trains and /v1/stations.', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(recordDelays(env, event.scheduledTime || Date.now()));
  },
};
