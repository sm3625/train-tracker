/* Trackside feeds: a Cloudflare Worker that polls the commuter railroads' GTFS-Realtime feeds (holding the API
   keys some of them need) and serves their trains as JSON shaped like the Amtraker API, so the site can treat
   them like any other operator. The railroads are listed in agencies.js. Keys live only in this worker's
   secrets; nothing it returns contains them.

   GET /v1/trains    { Metrolink: [train…], LIRR: [train…], … }   (feed health in the X-Feed-Status header)
   GET /v1/stations  { code: { code, name, label, city, state, lat, lon } }

   It also serves Trackside accounts (/v1/auth/…, /v1/me…): see accounts.js.
*/
import { decodeFeed } from './gtfsrt.js';
import { corsHeaders, json } from './http.js';
import { isAccountsPath, handleAccounts } from './accounts.js';
import { AGENCIES, SECRET_KEYS } from './agencies.js';
import { buildTrains, railFilter, feedSilence, GONE_MS } from './trains.js';
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
    const got = await Promise.all(sources.map(([kind, f]) => feed(a.provider + ' ' + kind, f, a.auth, env, budget)));
    const keep = a.mixed ? railFilter(sched) : undefined;
    const feeds = got.map((g) => decodeFeed(g.bytes, keep));
    const trains = buildTrains(a, sched, feeds, now);
    const err = got.find((g) => g.error);
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
    // per address, per Cloudflare location (wrangler.toml [[ratelimits]]). It spares the railroads' feeds and the
    // worker's CPU from one script hammering; the blocked request still counts toward the worker's daily requests.
    if (env.FEEDS_LIMIT && (url.pathname === '/v1/trains' || url.pathname === '/v1/stations')) {
      const { success } = await env.FEEDS_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, req, env, { 'Retry-After': '60', 'Cache-Control': 'no-store' }, 429);
    }

    if (url.pathname === '/v1/stations') {
      return json(stationList(), req, env, { 'Cache-Control': 'public, max-age=86400' });
    }
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
};
