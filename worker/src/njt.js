/* NJ Transit's GTFS-Realtime API: a token from the account's username and password, then POSTed feed requests.
   The realtime feeds are unlimited, but getToken is capped at 10 a day for the whole account, so the token is kept
   (in D1 when the worker has it, and in memory) and only fetched again when NJ says it's invalid or it's a day old.
   Test and production have separate credentials; NJT_HOST picks the host, and the test host is the default. */
const DEFAULT_HOST = 'https://testraildata.njtransit.com';
const TOKEN_MS = 23 * 3600000;
const TIMEOUT_MS = 8000;
const JSON_START = 0x7b;   // NJ answers errors as JSON, which starts with "{"; a feed never does

let memo = null;   // { token, at }, for this isolate

const hostOf = (env) => (env.NJT_HOST || DEFAULT_HOST).replace(/\/+$/, '');
const formOf = (fields) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const jsonOf = (bytes) => { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; } };

export async function njtLogin(host, username, password) {
  const res = await fetch(`${host}/api/GTFSRT/getToken`, {
    method: 'POST', headers: { accept: 'text/plain' }, body: formOf({ username, password }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NJ Transit sign-in: HTTP ${res.status}`);
  const r = await res.json().catch(() => null);
  if (!r) throw new Error('NJ Transit sign-in: no answer. Check the username and password in ../.env.');
  if (r.errorMessage) throw new Error('NJ Transit: ' + r.errorMessage);
  if (r.Authenticated !== 'True' || !r.UserToken) throw new Error('NJ Transit refused the username or password.');
  return r.UserToken;
}

/* The worker's token: memory, then D1 (table feed_tokens), then a fresh sign-in. fresh skips the first two. */
export async function njtToken(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && memo && now - memo.at < TOKEN_MS) return memo.token;
  if (!fresh && env.DB) {
    const row = await env.DB.prepare('SELECT token, fetched_at FROM feed_tokens WHERE name = ?').bind('NJT').first();
    if (row && now - Number(row.fetched_at) < TOKEN_MS) { memo = { token: row.token, at: Number(row.fetched_at) }; return memo.token; }
  }
  const token = await njtLogin(hostOf(env), env.NJT_USERNAME, env.NJT_PASSWORD);
  memo = { token, at: now };
  if (env.DB) {
    await env.DB.prepare(`INSERT INTO feed_tokens (name, token, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET token = excluded.token, fetched_at = excluded.fetched_at`).bind('NJT', token, now).run();
  }
  return token;
}

/* One realtime feed (getVehiclePositions or getTripUpdates) as protobuf bytes. An invalid token gets one fresh sign-in. */
export async function njtFeed(env, endpoint, signal) {
  for (let attempt = 0; ; attempt++) {
    const token = await njtToken(env, { fresh: attempt > 0 });
    const res = await fetch(`${hostOf(env)}/api/GTFSRT/${endpoint}`, {
      method: 'POST', headers: { accept: '*/*' }, body: formOf({ token }), signal,
    });
    // NJ sends its errors, "Invalid token." among them, as JSON with HTTP 500: read the body before the status
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== JSON_START) {
      if (!res.ok) throw new Error(`NJ Transit ${endpoint}: HTTP ${res.status}`);
      return bytes;
    }
    const err = jsonOf(bytes).errorMessage || (res.ok ? 'no feed' : `HTTP ${res.status}`);
    if (attempt === 0 && /invalid token/i.test(err)) continue;
    throw new Error(`NJ Transit ${endpoint}: ${err}`);
  }
}

/* The schedule ZIP, for build-schedules.mjs (which runs on your computer, with the credentials from ../.env). */
export async function njtGtfs({ NJT_USERNAME, NJT_PASSWORD, NJT_HOST }) {
  const host = (NJT_HOST || DEFAULT_HOST).replace(/\/+$/, '');
  const token = await njtLogin(host, NJT_USERNAME, NJT_PASSWORD);
  const res = await fetch(`${host}/api/GTFSRT/getGTFS`, { method: 'POST', headers: { accept: '*/*' }, body: formOf({ token }) });
  if (!res.ok) throw new Error(`NJ Transit schedule: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes[0] === JSON_START) throw new Error('NJ Transit schedule: ' + (jsonOf(bytes).errorMessage || 'no schedule'));
  return bytes;
}
