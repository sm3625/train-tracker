/* The accounts API end to end, through the worker's fetch handler, on an in-memory SQLite database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { SqlStore } from '../src/store/sql.js';
import { sqliteClient } from '../local/sqlite-client.mjs';
import { hashPassword, verifyPassword } from '../src/accounts.js';

function server() {
  const sent = [];
  const env = {
    ALLOWED_ORIGINS: 'https://shamit2008.github.io', ACCOUNTS_STORE: new SqlStore(sqliteClient(':memory:')), PASSWORD_ITERATIONS: '1000',
    SITE_URL: 'https://shamit2008.github.io/train-tracker/', MAILER: { send: async (m) => { sent.push(m); } }, EMAIL_VERIFY: 'off',
    SMS: { texted: [], async start(phone) { this.texted.push(phone); }, async check(phone, code) { return code === '246810' && this.texted.includes(phone); } },
  };
  const pending = [];
  const call = async (method, path, { body, token, ip = '1.1.1.1' } = {}) => {
    const headers = { Origin: 'https://shamit2008.github.io', 'CF-Connecting-IP': ip };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://w.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  // adds a number the way the site does: a text, then the code from it
  const setPhone = async (token, phone) => {
    const sent = await call('POST', '/v1/me/phone', { token, body: { phone } });
    if (sent.status !== 202) return sent;
    return call('POST', '/v1/me/phone/verify', { token, body: { phone, code: '246810' } });
  };
  return { env, call, sent, setPhone };
}
const creds = { email: '  Rider@Example.com ', password: 'zephyr-to-emeryville' };

test('passwords hash and verify', async () => {
  const h = await hashPassword('correct horse', 1000);
  assert.match(h, /^pbkdf2-sha256\$1000\$[\w-]{22}\$[\w-]{43}$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('correct horsf', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('sign up, sign in, sync data, sign out', async () => {
  const { call } = server();
  const up = await call('POST', '/v1/auth/signup', { body: creds });
  assert.equal(up.status, 201);
  assert.equal(up.body.user.email, 'rider@example.com');
  assert.equal(up.headers.get('Access-Control-Allow-Origin'), 'https://shamit2008.github.io');
  assert.equal(up.headers.get('Cache-Control'), 'no-store');
  assert.equal(up.body.user.passwordHash, undefined);

  assert.equal((await call('POST', '/v1/auth/signup', { body: creds })).body.error.code, 'email_taken');
  assert.equal((await call('POST', '/v1/auth/login', { body: { ...creds, password: 'wrong-password' } })).status, 401);

  const login = await call('POST', '/v1/auth/login', { body: { email: 'RIDER@example.com', password: creds.password } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await call('GET', '/v1/me', { token })).body.user.email, 'rider@example.com');

  const put = await call('PUT', '/v1/me/data', { token, body: { data: { favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 100 } } } });
  assert.deepEqual(put.body.data.favTrains.value, [{ num: '5', route: 'California Zephyr' }]);
  // an older copy from another device doesn't overwrite it, and the reply carries the newer one back
  const stale = await call('PUT', '/v1/me/data', { token: up.body.token, body: { data: { favTrains: { value: [], updatedAt: 50 } } } });
  assert.equal(stale.body.data.favTrains.value.length, 1);
  assert.equal((await call('GET', '/v1/me/data', { token })).body.data.favTrains.updatedAt, 100);

  assert.equal((await call('POST', '/v1/auth/logout', { token })).status, 204);
  assert.equal((await call('GET', '/v1/me', { token })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: up.body.token })).status, 200);   // the other device stays signed in
});

test('input is checked', async () => {
  const { call } = server();
  assert.equal((await call('POST', '/v1/auth/signup', { body: { email: 'not-an-email', password: 'long enough pw' } })).body.error.code, 'bad_email');
  assert.equal((await call('POST', '/v1/auth/signup', { body: { email: 'a@b.co', password: 'short' } })).body.error.code, 'weak_password');
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: 'made-up' })).status, 401);
  const { token } = (await call('POST', '/v1/auth/signup', { body: creds })).body;
  assert.equal((await call('PUT', '/v1/me/data', { token, body: { data: { 'bad key!': { value: 1, updatedAt: 1 } } } })).status, 400);
  assert.equal((await call('PUT', '/v1/me/data', { token, body: { data: { theme: { value: 'x'.repeat(20000), updatedAt: 1 } } } })).status, 413);
  // a far-future time is pulled back to about now, so it can't block later changes forever
  const far = await call('PUT', '/v1/me/data', { token, body: { data: { theme: { value: 'dark', updatedAt: Date.now() + 1e12 } } } });
  assert.ok(far.body.data.theme.updatedAt < Date.now() + 120000);
  const pre = await worker.fetch(new Request('https://w.example/v1/me/data', { method: 'OPTIONS', headers: { Origin: 'https://shamit2008.github.io' } }), {}, {});
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /PUT/);
});

test('repeated wrong passwords are rate limited', async () => {
  const { call } = server();
  await call('POST', '/v1/auth/signup', { body: creds });
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/v1/auth/login', { body: { ...creds, password: 'guess-' + i } })).status, 401);
  const blocked = await call('POST', '/v1/auth/login', { body: creds });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('Retry-After'));
});

test('changing the password signs out everywhere; deleting the account removes it', async () => {
  const { call } = server();
  const a = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const b = (await call('POST', '/v1/auth/login', { body: creds })).body.token;
  assert.equal((await call('POST', '/v1/me/password', { token: a, body: { password: 'nope-nope-nope', newPassword: 'new-password-1' } })).status, 403);
  const changed = await call('POST', '/v1/me/password', { token: a, body: { password: creds.password, newPassword: 'new-password-1' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/v1/me', { token: a })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: b })).status, 401);
  const c = changed.body.token;
  assert.equal((await call('GET', '/v1/me', { token: c })).status, 200);

  await call('PUT', '/v1/me/data', { token: c, body: { data: { theme: { value: 'dark', updatedAt: 1 } } } });
  assert.equal((await call('DELETE', '/v1/me', { token: c, body: { password: 'wrong-wrong' } })).status, 403);
  assert.equal((await call('DELETE', '/v1/me', { token: c, body: { password: 'new-password-1' } })).status, 204);
  assert.equal((await call('GET', '/v1/me', { token: c })).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: creds.email, password: 'new-password-1' } })).status, 401);
  assert.equal((await call('POST', '/v1/auth/signup', { body: creds })).status, 201);   // the email can sign up again
});

test('without a database configured, accounts answer 503 and the feeds still work', async () => {
  const res = await worker.fetch(new Request('https://w.example/v1/me'), {}, { waitUntil() {} });
  assert.equal(res.status, 503);
  assert.equal((await worker.fetch(new Request('https://w.example/v1/stations'), {}, { waitUntil() {} })).status, 200);
});

test('password reset by email', async () => {
  const { call, sent } = server();
  const old = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;

  // the answer doesn't reveal whether an account exists
  const none = await call('POST', '/v1/auth/reset', { body: { email: 'nobody@example.com' } });
  assert.equal(none.status, 202);
  assert.equal(sent.length, 0);
  const asked = await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal(asked.status, 202);
  assert.deepEqual(asked.body, none.body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rider@example.com');
  const link = /https:\/\/shamit2008\.github\.io\/train-tracker\/#reset=([\w-]+)/.exec(sent[0].text);
  assert.ok(link, 'the email carries a link to the site');
  assert.ok(sent[0].html.includes(link[0]));

  // asking again replaces the link
  await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  const token = /#reset=([\w-]+)/.exec(sent[1].text)[1];
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token: link[1], password: 'brand-new-password' } })).body.error.code, 'bad_token');
  // a short password doesn't use up the link
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'short' } })).body.error.code, 'weak_password');
  const done = await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'brand-new-password' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.email, 'rider@example.com');
  assert.equal((await call('GET', '/v1/me', { token: done.body.token })).status, 200);
  assert.equal((await call('GET', '/v1/me', { token: old })).status, 401);   // signed out everywhere else
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'another-password' } })).status, 400);   // works once
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: creds.email, password: 'brand-new-password' } })).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', { body: creds })).status, 401);

  // a few requests an hour per email at most
  await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal((await call('POST', '/v1/auth/reset', { body: { email: creds.email } })).status, 429);
});

test('password reset without email set up answers 503', async () => {
  const { env, call } = server();
  delete env.MAILER;
  const r = await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal(r.status, 503);
});

test('trips', async () => {
  const { call } = server();
  const token = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const at = Date.parse(day + 'T19:00:00Z');
  const zephyr = { provider: 'Amtrak', num: '5', date: day, route: 'California Zephyr',
    from: { code: 'CHI', name: 'Chicago Union Station', at, tz: 'America/Chicago' },
    to: { code: 'DEN', name: 'Denver', at: at + 18 * 3600000, tz: 'America/Denver' } };

  assert.equal((await call('POST', '/v1/me/trips', { body: zephyr })).status, 401);
  const added = await call('POST', '/v1/me/trips', { token, body: zephyr });
  assert.equal(added.status, 201);
  assert.equal(added.body.trip.route, 'California Zephyr');
  assert.equal(added.body.trip.to.code, 'DEN');
  assert.equal((await call('POST', '/v1/me/trips', { token, body: zephyr })).body.error.code, 'trip_exists');
  const earlier = await call('POST', '/v1/me/trips', { token, body: { ...zephyr, num: '7', from: { ...zephyr.from, at: at - 3600000 } } });
  assert.equal(earlier.status, 201);

  const list = await call('GET', '/v1/me/trips', { token });
  assert.deepEqual(list.body.trips.map((t) => t.num), ['7', '5']);

  const bad = (b) => call('POST', '/v1/me/trips', { token, body: { ...zephyr, num: '9', ...b } });
  assert.equal((await bad({ provider: 'Hogwarts Express' })).status, 400);
  assert.equal((await bad({ date: '2020-01-01' })).status, 400);
  assert.equal((await bad({ to: { ...zephyr.to, at: at - 1 } })).status, 400);
  assert.equal((await bad({ num: '<script>' })).status, 400);

  assert.equal((await call('DELETE', '/v1/me/trips/' + added.body.trip.id, { token })).status, 204);
  assert.equal((await call('DELETE', '/v1/me/trips/' + added.body.trip.id, { token })).status, 404);
  assert.deepEqual((await call('GET', '/v1/me/trips', { token })).body.trips.map((t) => t.num), ['7']);
});

test('past trips are kept and don’t count toward the limit', async () => {
  const { call } = server();
  const token = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const trip = (num, daysAhead) => {
    const date = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10), at = Date.parse(date + 'T12:00:00Z');
    return { provider: 'Amtrak', num, date, route: 'Northeast Regional',
      from: { code: 'NYP', name: 'New York', at, tz: 'America/New_York' }, to: { code: 'WAS', name: 'Washington', at: at + 3 * 3600000, tz: 'America/New_York' } };
  };
  for (let i = 1; i <= 200; i++) assert.equal((await call('POST', '/v1/me/trips', { token, body: trip(String(i), 3) })).status, 201);
  const full = await call('POST', '/v1/me/trips', { token, body: trip('201', 3) });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'too_many');
  assert.equal((await call('POST', '/v1/me/trips', { token, body: trip('201', -3) })).status, 201);   // one already taken
  assert.equal((await call('GET', '/v1/me/trips', { token })).body.trips.length, 201);
});

test('usernames', async () => {
  const { call } = server();
  const up = await call('POST', '/v1/auth/signup', { body: { ...creds, username: ' @Zephyr_Fan ' } });
  assert.equal(up.status, 201);
  assert.equal(up.body.user.username, 'zephyr_fan');
  const taken = await call('POST', '/v1/auth/signup', { body: { email: 'other@example.com', password: creds.password, username: 'zephyr_fan' } });
  assert.equal(taken.body.error.code, 'username_taken');
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'other@example.com', password: creds.password } })).status, 401);   // not half-made
  for (const bad of ['ab', '1train', 'has space', 'x'.repeat(21), 'émile']) {
    assert.equal((await call('POST', '/v1/auth/signup', { body: { email: 'b@example.com', password: creds.password, username: bad } })).body.error.code, 'bad_username', bad);
  }
  // accounts made without one (older apps) choose one later
  const later = await call('POST', '/v1/auth/signup', { body: { email: 'later@example.com', password: creds.password } });
  assert.equal(later.body.user.username, null);
  const token = later.body.token;
  assert.equal((await call('PUT', '/v1/me/profile', { token, body: { username: 'zephyr_fan' } })).status, 409);
  assert.equal((await call('PUT', '/v1/me/profile', { token, body: { username: 'Cardinal' } })).body.user.username, 'cardinal');
  assert.equal((await call('GET', '/v1/me', { token })).body.user.username, 'cardinal');
});

test('friends and their trips', async () => {
  const { call } = server();
  const sign = async (name, ip) => (await call('POST', '/v1/auth/signup', { ip, body: { email: name + '@example.com', password: creds.password, username: name } })).body.token;
  const ann = await sign('ann', '1.1.1.1'), ben = await sign('ben', '2.2.2.2'), cat = await sign('cat', '3.3.3.3');
  const nobody = (await call('POST', '/v1/auth/signup', { body: { email: 'nobody@example.com', password: creds.password } })).body.token;
  const friends = async (token) => (await call('GET', '/v1/me/friends', { token })).body;

  assert.equal((await call('POST', '/v1/me/friends', { body: { username: 'ben' } })).status, 401);
  assert.equal((await call('POST', '/v1/me/friends', { token: nobody, body: { username: 'ben' } })).body.error.code, 'no_username');
  assert.equal((await call('POST', '/v1/me/friends', { token: ann, body: { username: 'ghost' } })).status, 404);
  assert.equal((await call('POST', '/v1/me/friends', { token: ann, body: { username: 'ann' } })).body.error.code, 'self');

  const asked = await call('POST', '/v1/me/friends', { token: ann, body: { username: '@Ben' } });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.status, 'pending');
  assert.equal((await call('POST', '/v1/me/friends', { token: ann, body: { username: 'ben' } })).body.status, 'pending');   // asking twice is fine
  assert.deepEqual((await friends(ann)).outgoing.map((f) => f.username), ['ben']);
  assert.deepEqual((await friends(ben)).incoming.map((f) => f.username), ['ann']);

  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const at = Date.parse(day + 'T19:00:00Z');
  const trip = (num) => ({ provider: 'Amtrak', num, date: day, route: 'California Zephyr',
    from: { code: 'CHI', name: 'Chicago Union Station', at, tz: 'America/Chicago' },
    to: { code: 'DEN', name: 'Denver', at: at + 18 * 3600000, tz: 'America/Denver' } });
  await call('POST', '/v1/me/trips', { token: ben, body: trip('5') });
  await call('POST', '/v1/me/trips', { token: cat, body: trip('7') });
  assert.deepEqual((await call('GET', '/v1/me/friends/trips', { token: ann })).body.trips, []);   // not friends until ben says yes

  const accepted = await call('POST', '/v1/me/friends', { token: ben, body: { username: 'ann' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'accepted');
  const a = await friends(ann);
  assert.deepEqual(a.friends.map((f) => f.username), ['ben']);
  assert.deepEqual([a.incoming, a.outgoing], [[], []]);
  const seen = (await call('GET', '/v1/me/friends/trips', { token: ann })).body.trips;
  assert.deepEqual(seen.map((t) => [t.username, t.num, t.to.code]), [['ben', '5', 'DEN']]);
  assert.equal(seen[0].email, undefined);
  assert.deepEqual((await call('GET', '/v1/me/friends/trips', { token: ben })).body.trips, []);   // ann has no trips

  // declining, cancelling and unfriending are all one DELETE, from either side
  await call('POST', '/v1/me/friends', { token: cat, body: { username: 'ann' } });
  assert.equal((await call('DELETE', '/v1/me/friends/cat', { token: ann })).status, 204);
  assert.deepEqual((await friends(cat)).outgoing, []);
  assert.equal((await call('DELETE', '/v1/me/friends/cat', { token: ann })).status, 404);
  assert.equal((await call('DELETE', '/v1/me/friends/ann', { token: ben })).status, 204);
  assert.deepEqual((await friends(ann)).friends, []);
  assert.deepEqual((await call('GET', '/v1/me/friends/trips', { token: ann })).body.trips, []);

  // a deleted account leaves no friendships behind
  await call('POST', '/v1/me/friends', { token: ann, body: { username: 'ben' } });
  await call('DELETE', '/v1/me', { token: ben, body: { password: creds.password } });
  assert.deepEqual(await friends(ann), { friends: [], incoming: [], outgoing: [] });
});

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

test('phone numbers: set, find by number, match contacts', async () => {
  const { call, setPhone } = server();
  const sign = async (name, ip) => (await call('POST', '/v1/auth/signup', { ip, body: { email: name + '@example.com', password: creds.password, username: name } })).body.token;
  const ann = await sign('ann', '1.1.1.1'), ben = await sign('ben', '2.2.2.2'), cat = await sign('cat', '3.3.3.3');

  for (const bad of ['5551234567', '+0123456789', '+1 555 123 4567', '+1555', 'x'.repeat(20)]) {
    assert.equal((await call('POST', '/v1/me/phone', { token: ben, body: { phone: bad } })).body.error.code, 'bad_phone', bad);
  }
  const set = await setPhone(ben, '+15551230002');
  assert.equal(set.body.user.phone, '+15551230002');
  assert.equal(set.body.user.username, 'ben');
  assert.equal((await call('GET', '/v1/me', { token: ben })).body.user.phone, '+15551230002');
  assert.equal((await setPhone(cat, '+15551230002')).body.error.code, 'phone_taken');
  await call('PUT', '/v1/me/profile', { token: cat, body: { username: 'catherine' } });
  await setPhone(cat, '+15551230003');

  // adding by number: the app sends the number's hash
  const asked = await call('POST', '/v1/me/friends', { token: ann, body: { phoneHash: await sha('+15551230002') } });
  assert.equal(asked.status, 201);
  assert.deepEqual(asked.body, { status: 'pending', username: 'ben' });
  assert.equal((await call('POST', '/v1/me/friends', { token: ann, body: { phoneHash: await sha('+15559999999') } })).status, 404);
  assert.equal((await call('POST', '/v1/me/friends', { token: ann, body: { phoneHash: '+15551230002' } })).body.error.code, 'bad_phone');
  assert.equal((await call('POST', '/v1/me/friends', { token: ben, body: { username: 'ann' } })).body.status, 'accepted');

  // contacts: who's on Trackside, and how they relate to you; nothing for numbers without an account
  await call('POST', '/v1/me/friends', { token: cat, body: { username: 'ann' } });
  await setPhone(ann, '+15551230001');
  const book = await Promise.all(['+15551230001', '+15551230002', '+15551230003', '+15550000000'].map(sha));
  const m = await call('POST', '/v1/me/friends/match', { token: ann, body: { phoneHashes: book } });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.matches.map((x) => [x.username, x.status]).sort(), [['ben', 'friends'], ['catherine', 'incoming']]);
  assert.ok(m.body.matches.every((x) => book.includes(x.phoneHash)));
  assert.deepEqual((await call('POST', '/v1/me/friends/match', { token: cat, body: { phoneHashes: book } })).body.matches.map((x) => [x.username, x.status]).sort(),
    [['ann', 'requested'], ['ben', null]]);
  assert.equal((await call('POST', '/v1/me/friends/match', { token: ann, body: { phoneHashes: ['nope'] } })).status, 400);
  assert.equal((await call('POST', '/v1/me/friends/match', { token: ann, body: { phoneHashes: Array(2001).fill(book[0]) } })).status, 400);
  assert.equal((await call('POST', '/v1/me/friends/match', { token: ann, body: { phoneHashes: Array(2000).fill(book[0]) } })).status, 200);

  // friends never see each other's numbers or emails
  const list = JSON.stringify((await call('GET', '/v1/me/friends', { token: ben })).body);
  assert.ok(!list.includes('+1555') && !list.includes('@example.com'));

  // removing the number makes it unfindable; lookups by number are rate limited
  await call('PUT', '/v1/me/profile', { token: ben, body: { phone: null } });
  assert.equal((await call('GET', '/v1/me', { token: ben })).body.user.phone, null);
  assert.deepEqual((await call('POST', '/v1/me/friends/match', { token: cat, body: { phoneHashes: [book[1]] } })).body.matches, []);
  let last;
  for (let i = 0; i < 30; i++) last = await call('POST', '/v1/me/friends/match', { token: cat, body: { phoneHashes: [book[0]] } });
  assert.equal(last.status, 429);
});

test('a number is only added with the code texted to it', async () => {
  const { env, call } = server();
  const token = (await call('POST', '/v1/auth/signup', { body: { ...creds, username: 'ann' } })).body.token;
  const phone = '+15551230009';
  // a number can't be set directly any more, only removed
  assert.equal((await call('PUT', '/v1/me/profile', { token, body: { phone } })).body.error.code, 'verify_phone');
  // no code was sent yet: the right digits still don't work
  assert.equal((await call('POST', '/v1/me/phone/verify', { token, body: { phone, code: '246810' } })).body.error.code, 'bad_code');
  assert.equal((await call('POST', '/v1/me/phone', { token, body: { phone } })).status, 202);
  assert.deepEqual(env.SMS.texted, [phone]);
  assert.equal((await call('POST', '/v1/me/phone/verify', { token, body: { phone, code: '111111' } })).body.error.code, 'bad_code');
  assert.equal((await call('POST', '/v1/me/phone/verify', { token, body: { phone, code: 'abc' } })).body.error.code, 'bad_code');
  assert.equal((await call('GET', '/v1/me', { token })).body.user.phone, null);
  const ok = await call('POST', '/v1/me/phone/verify', { token, body: { phone, code: '246 810' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.phone, phone);
  assert.equal((await call('PUT', '/v1/me/profile', { token, body: { phone: null } })).body.user.phone, null);

  // texts are limited per account and per number
  for (let i = 0; i < 4; i++) await call('POST', '/v1/me/phone', { token, body: { phone } });
  assert.equal((await call('POST', '/v1/me/phone', { token, body: { phone } })).status, 429);

  // a number someone else verified isn't texted at all
  const other = (await call('POST', '/v1/auth/signup', { ip: '9.9.9.9', body: { email: 'b@example.com', password: creds.password, username: 'ben' } })).body.token;
  await call('POST', '/v1/me/phone', { token: other, body: { phone: '+15551230008' } });
  await call('POST', '/v1/me/phone/verify', { token: other, body: { phone: '+15551230008', code: '246810' } });
  const texted = env.SMS.texted.length;
  assert.equal((await call('POST', '/v1/me/phone', { token, body: { phone: '+15551230008' } })).body.error.code, 'phone_taken');
  assert.equal(env.SMS.texted.length, texted);
});

test('without a texting service, a number is saved without a code', async () => {
  const { env, call } = server();
  delete env.SMS;
  const token = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const saved = await call('POST', '/v1/me/phone', { token, body: { phone: '+15551230009' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.user.phone, '+15551230009');
  const other = (await call('POST', '/v1/auth/signup', { ip: '9.9.9.9', body: { email: 'b@example.com', password: creds.password } })).body.token;
  assert.equal((await call('POST', '/v1/me/phone', { token: other, body: { phone: '+15551230009' } })).body.error.code, 'phone_taken');
  assert.equal((await call('POST', '/v1/me/phone', { token, body: { phone: '+447700900003' } })).body.error.code, 'bad_phone');
});

test('sign-up bot check', async () => {
  const { env, call } = server();
  env.TURNSTILE = async (token) => token === 'human';
  const up = (n, turnstileToken) => call('POST', '/v1/auth/signup', { ip: '7.7.7.7', body: { email: `p${n}@example.com`, password: creds.password, turnstileToken } });
  assert.equal((await up(0)).body.error.code, 'not_human');
  assert.equal((await up(0, 'bot')).body.error.code, 'not_human');
  // with the check passed, one address can make far more than 10 accounts in an hour
  for (let i = 1; i <= 15; i++) assert.equal((await up(i, 'human')).status, 201, String(i));
  // without the check configured, the tighter limit applies
  delete env.TURNSTILE;
  for (let i = 0; i < 10; i++) await call('POST', '/v1/auth/signup', { ip: '8.8.8.8', body: { email: `q${i}@example.com`, password: creds.password } });
  assert.equal((await call('POST', '/v1/auth/signup', { ip: '8.8.8.8', body: { email: 'q99@example.com', password: creds.password } })).status, 429);
});

test('only US and Canada numbers, and a daily cap on contacts lookups', async () => {
  const { call } = server();
  const token = (await call('POST', '/v1/auth/signup', { body: { ...creds, username: 'ann' } })).body.token;
  for (const far of ['+447700900003', '+8823450000000', '+52155512300']) {
    assert.equal((await call('POST', '/v1/me/phone', { token, body: { phone: far } })).body.error.code, 'bad_phone', far);
  }
  const hashes = { phoneHashes: ['0'.repeat(64)] };
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/v1/me/friends/match', { token, body: hashes })).status, 200);
  assert.equal((await call('POST', '/v1/me/friends/match', { token, body: hashes })).status, 429);
});

test('a page on localhost is allowed only by the dev server', async () => {
  const ask = (env) => worker.fetch(new Request('https://w.example/v1/stations', { headers: { Origin: 'http://localhost:5173' } }), env, { waitUntil() {} });
  const live = { ALLOWED_ORIGINS: 'https://sm3625.github.io,capacitor://localhost,https://localhost' };
  assert.equal((await ask(live)).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await ask({ ...live, ALLOW_LOCALHOST: 'true' })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
});

test('email verification: the code makes the account, and sign-up never reveals an existing email', async () => {
  const { env, call, sent } = server();
  env.EMAIL_VERIFY = 'on';
  const codeIn = (m) => /\b(\d{6})\b/.exec(m.text)[1];

  const asked = await call('POST', '/v1/auth/signup', { body: { ...creds, username: 'ann' } });
  assert.equal(asked.status, 202);
  assert.deepEqual(asked.body, { pending: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rider@example.com');
  const code = codeIn(sent[0]);
  // nothing exists until the code comes back
  assert.equal((await call('POST', '/v1/auth/login', { body: creds })).status, 401);
  const wrongCode = code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/v1/auth/signup/confirm', { body: { email: creds.email, code: wrongCode } })).body.error.code, 'bad_code');
  const made = await call('POST', '/v1/auth/signup/confirm', { body: { email: ' RIDER@example.com', code } });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.username, 'ann');
  assert.equal((await call('GET', '/v1/me', { token: made.body.token })).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', { body: creds })).status, 200);   // the password chosen at sign-up
  assert.equal((await call('POST', '/v1/auth/signup/confirm', { body: { email: creds.email, code } })).status, 400);   // works once

  // the same email again: the same answer, and an email saying there's already an account, with no code
  const again = await call('POST', '/v1/auth/signup', { ip: '2.2.2.2', body: { ...creds, password: 'another-password' } });
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, asked.body);
  assert.match(sent[1].subject, /already have/);
  assert.doesNotMatch(sent[1].text, /\b\d{6}\b/);
  assert.equal((await call('POST', '/v1/auth/login', { body: { ...creds, password: 'another-password' } })).status, 401);

  // a username is checked up front, since usernames are public
  assert.equal((await call('POST', '/v1/auth/signup', { ip: '3.3.3.3', body: { email: 'x@example.com', password: creds.password, username: 'ann' } })).body.error.code, 'username_taken');
});

test('email verification: wrong codes run out, and codes expire', async () => {
  const { env, call, sent } = server();
  env.EMAIL_VERIFY = 'on';
  await call('POST', '/v1/auth/signup', { body: creds });
  const code = /\b(\d{6})\b/.exec(sent[0].text)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/signup/confirm', { body: { email: creds.email, code: wrong } });
  assert.equal((await call('POST', '/v1/auth/signup/confirm', { body: { email: creds.email, code } })).status, 400);   // even the right one, now

  await call('POST', '/v1/auth/signup', { body: creds });
  const fresh = /\b(\d{6})\b/.exec(sent[1].text)[1];
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60000;
  try { assert.equal((await call('POST', '/v1/auth/signup/confirm', { body: { email: creds.email, code: fresh } })).status, 400); }
  finally { Date.now = realNow; }
});

test('email verification is off when email can\'t be sent', async () => {
  const { env, call } = server();
  env.EMAIL_VERIFY = 'on';
  delete env.MAILER;
  const up = await call('POST', '/v1/auth/signup', { body: creds });
  assert.equal(up.status, 201);
  assert.ok(up.body.token);
});

test('the feeds are rate limited per address', async () => {
  const seen = new Map();
  const env = { FEEDS_LIMIT: { limit: async ({ key }) => { seen.set(key, (seen.get(key) || 0) + 1); return { success: seen.get(key) <= 3 }; } } };
  const ask = (ip) => worker.fetch(new Request('https://w.example/v1/stations', { headers: { 'CF-Connecting-IP': ip } }), env, { waitUntil() {} });
  for (let i = 0; i < 3; i++) assert.equal((await ask('1.1.1.1')).status, 200);
  const blocked = await ask('1.1.1.1');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal((await ask('2.2.2.2')).status, 200);   // someone else isn't affected
});

test('feedback, signed in or not', async () => {
  const { env, call } = server();
  assert.equal((await call('POST', '/v1/feedback', { body: { kind: 'idea', message: '  More maps  ', page: 'web' } })).status, 201);
  const { body: { token } } = await call('POST', '/v1/auth/signup', { body: creds });
  assert.equal((await call('POST', '/v1/feedback', { token, body: { kind: 'problem', message: 'Late train', contact: 'Me@Example.com' } })).status, 201);
  assert.equal((await call('POST', '/v1/feedback', { token: 'stale', body: { kind: 'nonsense', message: 'Hi' } })).status, 201);
  const [stale, mine, anon] = await env.ACCOUNTS_STORE.listFeedback(10);
  assert.equal(anon.message, 'More maps');
  assert.equal(anon.userId, null);
  assert.equal(anon.page, 'web');
  assert.ok(mine.userId);
  assert.equal(mine.contact, 'me@example.com');
  assert.equal(stale.kind, 'other');
  assert.equal(stale.userId, null);
  assert.equal((await call('POST', '/v1/feedback', { body: { message: '   ' } })).status, 400);
  assert.equal((await call('POST', '/v1/feedback', { body: { message: 'x', contact: 'nope' } })).status, 400);
  assert.equal((await call('POST', '/v1/feedback', { body: { message: 'x'.repeat(4001) } })).status, 400);
  for (let i = 0; i < 7; i++) await call('POST', '/v1/feedback', { body: { message: 'again' } });
  assert.equal((await call('POST', '/v1/feedback', { body: { message: 'one too many' } })).status, 429);
});
