/* The scheduled delay recorder (recordDelays in src/index.js), end to end on a fake network: Amtraker answers with
   the recorded feed in e2e/fixtures, every railroad's own feed is down. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordDelays } from '../src/index.js';
import { MemoryStore } from '../src/store/memory.js';
import { RULES } from '../src/delays.js';

const fixtures = new URL('../../e2e/fixtures/', import.meta.url);
const AT = Date.parse(readFileSync(new URL('recorded-at.txt', fixtures), 'utf8').trim());
const AMTRAKER = readFileSync(new URL('amtraker-trains.json', fixtures), 'utf8');

test('each minute reads what is due; a railroad that is down still takes its turn; finished trips are written', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return String(url).startsWith('https://api-v3.amtraker.com/') ? new Response(AMTRAKER) : new Response('down', { status: 503 });
  };
  const errors = console.error;
  console.error = () => {};
  try {
    const store = new MemoryStore();
    const env = { ACCOUNTS_STORE: store };   // no keys: Metrolink, Caltrain, Metra and NJ Transit are left out
    const runs = [];
    for (let m = 0; m < 20; m++) runs.push(await recordDelays(env, AT + m * 60000));

    const reads = await store.getRecorderReads();
    assert.ok(reads.amtraker, 'Amtraker was read');
    for (const id of ['LI', 'MN', 'SE', 'MB', 'MA', 'VR', 'TR', 'SS', 'UT', 'RD']) assert.ok(reads[id], `${id} took a turn`);
    assert.equal(reads.ML, undefined, 'no key, no turn');
    // no run goes over its CPU budget, except a costly source read alone
    const cost = (d) => RULES.cost[d.source] ?? RULES.defaultCost;
    for (const done of runs) assert.ok(done.length <= 1 || done.reduce((n, d) => n + cost(d), 0) <= RULES.runBudget);
    assert.ok(runs.flat().some((d) => d.source === 'SE' && d.error));

    // Amtraker's trains are under way; with Amtraker now silent (empty), the next read writes those past their end
    const trips = Object.keys((await store.getRecorderState('amtraker')).trips).length;
    assert.ok(trips > 50, `${trips} Amtraker trips under way`);
    globalThis.fetch = async (url) => (String(url).startsWith('https://api-v3.amtraker.com/') ? new Response('{}') : new Response('down', { status: 503 }));
    for (let m = 20; m < 60; m++) await recordDelays(env, AT + 2 * 86400000 + m * 60000);
    const written = await store.listRuns('2026-01-01');
    assert.ok(written.length > 50, `${written.length} trips written`);
    assert.ok(written.every((r) => r.stops.length && ['wkd', 'sat', 'sun'].includes(r.dayType)));
    assert.ok(written.some((r) => r.stops.some((s) => s[4] === 'r' && s[3] != null)), 'reported departure delays');
    assert.equal(Object.keys((await store.getRecorderState('amtraker')).trips).length, 0);
  } finally {
    globalThis.fetch = realFetch;
    console.error = errors;
  }
});

test('GET /v1/delays: one train\'s history, or null with too few trips', async () => {
  const { default: worker } = await import('../src/index.js');
  const store = new MemoryStore();
  const today = new Date().toISOString().slice(0, 10);
  const day = new Date().getUTCDay(), dt = day === 6 ? 'sat' : day === 0 ? 'sun' : 'wkd';
  await store.saveRecorderRead('LI', { at: 1, idle: false, state: { trips: {} } },
    [{ provider: 'LIRR', num: '2034', date: today, dayType: dt, cancelled: false, stops: [['A', 0, null, 4, 'r'], ['B', 1, 6, null, 'r']] }]);
  const env = { ACCOUNTS_STORE: store, ALLOWED_ORIGINS: 'https://example.org' };
  const ask = (q, e = env) => worker.fetch(new Request('https://w.example/v1/delays?' + q), e, { waitUntil() {} });
  let r = await ask(`provider=LIRR&num=2034&day=${dt}`);
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.trips, 1);
  assert.equal(body.stats, null);   // 1 trip, 8 needed
  body = await (await ask(`provider=LIRR&num=2034&day=${dt}`, { ...env, DELAYS_MIN_TRIPS: '1' })).json();
  assert.deepEqual(body.stats.stops.B, { median: 6, p90: 6, onTime: 0, n: 1, estimated: false });
  assert.equal((await ask('provider=LIRR&num=2034&day=mon')).status, 400);
});
