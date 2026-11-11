/* NJ Transit's sign-in, token reuse, and feed fetches, against a fake NJ server. Each test loads a fresh copy of
   njt.js, so the token kept in memory doesn't carry from one test to the next. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;
const fresh = () => import(`../src/njt.js?t=${++n}`);
const OK_FEED = new Uint8Array([0x0a, 0x03, 0x32, 0x2e, 0x30]);   // a protobuf message, starting with a field, not "{"

function fakeNj({ logins = [], feed = () => OK_FEED, gtfs = () => new Uint8Array([0x50, 0x4b]) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const form = init && init.body;
    if (path.endsWith('/getToken')) {
      const user = form.get('username');
      logins.push(user);
      const ok = user === 'me@example.com' && form.get('password') === 'secret';
      return Response.json(ok ? { Authenticated: 'True', UserToken: 'tok' + logins.length } : { Authenticated: 'False', UserToken: '' });
    }
    if (path.endsWith('/getGTFS')) return new Response(gtfs(form.get('token')));
    return new Response(feed(path.split('/').pop(), form.get('token')));
  };
  return { calls, logins };
}

const env = { NJT_USERNAME: 'me@example.com', NJT_PASSWORD: 'secret', NJT_HOST: 'https://nj.example' };
const realFetch = globalThis.fetch;

test('a feed signs in once and reuses the token', async () => {
  const fake = fakeNj();
  const { njtFeed } = await fresh();
  const a = await njtFeed(env, 'getVehiclePositions');
  const b = await njtFeed(env, 'getTripUpdates');
  assert.deepEqual([...a], [...OK_FEED]);
  assert.deepEqual([...b], [...OK_FEED]);
  assert.equal(fake.logins.length, 1);
  assert.deepEqual(fake.calls, ['/api/GTFSRT/getToken', '/api/GTFSRT/getVehiclePositions', '/api/GTFSRT/getTripUpdates']);
  globalThis.fetch = realFetch;
});

test('an invalid token is replaced once, then the feed is read', async () => {
  let rejected = false;
  const fake = fakeNj({ feed: (endpoint, token) => {
    if (token === 'tok1' && !rejected) { rejected = true; return JSON.stringify({ errorMessage: 'Invalid token.' }); }
    return OK_FEED;
  } });
  const { njtFeed } = await fresh();
  assert.deepEqual([...(await njtFeed(env, 'getTripUpdates'))], [...OK_FEED]);
  assert.equal(fake.logins.length, 2);
  globalThis.fetch = realFetch;
});

test('an invalid token answered as HTTP 500, as NJ does, is replaced too', async () => {
  const fake = fakeNj();
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (init.body.get('token') === 'stale'
    ? Response.json({ errorMessage: 'Invalid token.' }, { status: 500 })
    : fakeFetch(url, init));
  const rows = [{ token: 'stale', fetched_at: Date.now() - 3600000 }];
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (sql.startsWith('SELECT') ? rows[0] : null),
        run: async () => { rows[0] = { token: args[1], fetched_at: args[2] }; return {}; },
      }),
    }),
  };
  const { njtFeed } = await fresh();
  assert.deepEqual([...(await njtFeed({ ...env, DB: db }, 'getVehiclePositions'))], [...OK_FEED]);
  assert.equal(fake.logins.length, 1);
  assert.equal(rows[0].token, 'tok1', 'the new token is saved for the next read');
  globalThis.fetch = realFetch;
});

test('a server error that is not JSON is reported with its status', async () => {
  fakeNj();
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (url.endsWith('/getTripUpdates') ? new Response('<html>down</html>', { status: 502 }) : fakeFetch(url, init));
  const { njtFeed } = await fresh();
  await assert.rejects(njtFeed(env, 'getTripUpdates'), /HTTP 502/);
  globalThis.fetch = realFetch;
});

test('a feed that stays invalid gives up after one replacement', async () => {
  const fake = fakeNj({ feed: () => JSON.stringify({ errorMessage: 'Invalid token.' }) });
  const { njtFeed } = await fresh();
  await assert.rejects(njtFeed(env, 'getTripUpdates'), /Invalid token/);
  assert.equal(fake.logins.length, 2);
  globalThis.fetch = realFetch;
});

test('the daily sign-in limit is reported as it is', async () => {
  globalThis.fetch = async () => Response.json({ errorMessage: 'Daily usage limit:10. Your current daily usage: 11' });
  const { njtToken } = await fresh();
  await assert.rejects(njtToken(env), /Daily usage limit/);
  globalThis.fetch = realFetch;
});

test('a wrong password is refused without a token', async () => {
  fakeNj();
  const { njtToken } = await fresh();
  await assert.rejects(njtToken({ ...env, NJT_PASSWORD: 'nope' }), /refused the username or password/);
  globalThis.fetch = realFetch;
});

test('a token kept in D1 is used without signing in', async () => {
  const fake = fakeNj();
  const rows = [{ token: 'stored', fetched_at: Date.now() - 3600000 }];
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (sql.startsWith('SELECT') ? rows[0] || null : null),
        run: async () => { rows[0] = { token: args[1], fetched_at: args[2] }; return {}; },
      }),
    }),
  };
  const { njtToken } = await fresh();
  assert.equal(await njtToken({ ...env, DB: db }), 'stored');
  assert.equal(fake.logins.length, 0);
  globalThis.fetch = realFetch;
});

test('a token kept in D1 for more than 23 hours is replaced and saved', async () => {
  const fake = fakeNj();
  const rows = [{ token: 'old', fetched_at: Date.now() - 24 * 3600000 }];
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (sql.startsWith('SELECT') ? rows[0] : null),
        run: async () => { rows[0] = { token: args[1], fetched_at: args[2] }; return {}; },
      }),
    }),
  };
  const { njtToken } = await fresh();
  assert.equal(await njtToken({ ...env, DB: db }), 'tok1');
  assert.equal(rows[0].token, 'tok1');
  assert.equal(fake.logins.length, 1);
  globalThis.fetch = realFetch;
});

test('the schedule download signs in and posts getGTFS', async () => {
  const fake = fakeNj({ gtfs: (token) => (token === 'tok1' ? 'PK-zip' : 'no') });
  const { njtGtfs } = await fresh();
  const zip = await njtGtfs({ NJT_USERNAME: 'me@example.com', NJT_PASSWORD: 'secret', NJT_HOST: 'https://nj.example' });
  assert.equal(zip.toString(), 'PK-zip');
  assert.equal(fake.calls.at(-1), '/api/GTFSRT/getGTFS');
  globalThis.fetch = realFetch;
});
