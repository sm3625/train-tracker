/* The accounts-store contract. Every adapter must pass the same checks; a new adapter gets added to ADAPTERS.
   Cloudflare D1 can't run here, but it shares SqlStore and its SQL with the SQLite adapters below. Turso runs its
   real client against a local stand-in for Turso's HTTP API (local/fake-turso.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { SqlStore } from '../src/store/sql.js';
import { StoreError } from '../src/store/errors.js';
import { tursoClient } from '../src/store/turso.js';
import { sqliteClient } from '../local/sqlite-client.mjs';
import { fakeTursoFetch } from '../local/fake-turso.mjs';

/* turso.js calls the global fetch; each Turso store gets its own fake database, chosen by URL. */
const tursoDbs = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const db = tursoDbs.get(new URL(url).host);
  return db ? db(url, init) : realFetch(url, init);
};
function fakeTurso() {
  const host = `db${tursoDbs.size}-test.turso.io`;
  tursoDbs.set(host, fakeTursoFetch('tok'));
  return new SqlStore(tursoClient(`libsql://${host}`, 'tok'));
}

const ADAPTERS = {
  memory: () => new MemoryStore(),
  'sql on node:sqlite': () => new SqlStore(sqliteClient(':memory:')),
  'sql on turso (local stand-in)': fakeTurso,
};

test('turso: a failing statement rolls back the whole batch', async () => {
  const s = fakeTurso();
  await s.createUser({ id: 'u1', email: 'a@example.com', passwordHash: 'h', createdAt: 1 });
  await assert.rejects(s.db.batch([
    { sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', params: ['u2', 'b@example.com', 'h', 2] },
    { sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', params: ['u3', 'a@example.com', 'h', 3] },
  ]), /UNIQUE/);
  assert.equal(await s.getUserById('u2'), null);
});

for (const [name, make] of Object.entries(ADAPTERS)) {
  const user = (n = 1) => ({ id: 'u' + n, email: `p${n}@example.com`, username: null, phone: null, passwordHash: 'hash' + n, createdAt: 1000 + n });

  test(`${name}: users`, async () => {
    const s = make();
    await s.createUser(user(1));
    assert.deepEqual(await s.getUserByEmail('p1@example.com'), user(1));
    assert.deepEqual(await s.getUserById('u1'), user(1));
    assert.equal(await s.getUserByEmail('nobody@example.com'), null);
    assert.equal(await s.getUserById('nope'), null);
    await assert.rejects(s.createUser({ ...user(2), email: 'p1@example.com' }), (e) => e instanceof StoreError && e.code === 'email_taken');
    await s.setPasswordHash('u1', 'newhash');
    assert.equal((await s.getUserById('u1')).passwordHash, 'newhash');
  });

  test(`${name}: usernames`, async () => {
    const s = make();
    await s.createUser({ ...user(1), username: 'zephyr_fan' });
    await s.createUser(user(2));
    assert.equal((await s.getUserById('u1')).username, 'zephyr_fan');
    assert.equal((await s.getUserByEmail('p1@example.com')).username, 'zephyr_fan');
    assert.deepEqual(await s.getUserByUsername('zephyr_fan'), { ...user(1), username: 'zephyr_fan' });
    assert.equal(await s.getUserByUsername('nobody'), null);
    await assert.rejects(s.createUser({ ...user(3), username: 'zephyr_fan' }), (e) => e instanceof StoreError && e.code === 'username_taken');
    assert.equal(await s.getUserById('u3'), null);   // nothing half-made
    await assert.rejects(s.setProfile('u2', { username: 'zephyr_fan' }), (e) => e instanceof StoreError && e.code === 'username_taken');
    await s.setProfile('u2', { username: 'coast_starlight' });
    await s.setProfile('u1', { username: 'zephyr_fan' });   // keeping your own is fine
    await s.setProfile('u1', { username: 'cardinal' });
    assert.equal(await s.getUserByUsername('zephyr_fan'), null);
    assert.equal((await s.getUserByUsername('coast_starlight')).id, 'u2');
    await s.deleteUser('u1');
    await s.createUser({ ...user(4), username: 'cardinal' });   // the name is free again
  });

  test(`${name}: phone numbers`, async () => {
    const s = make();
    await s.createUser({ ...user(1), username: 'ann' });
    await s.createUser({ ...user(2), username: 'ben' });
    await s.createUser(user(3));   // no username: can't be found
    const num = (n) => ({ number: '+1555000000' + n, hash: 'h' + n });
    await s.setProfile('u1', { phone: num(1) });
    await s.setProfile('u3', { phone: num(3) });
    assert.equal((await s.getUserById('u1')).phone, '+15550000001');
    assert.equal((await s.getUserByUsername('ann')).username, 'ann');   // a phone change leaves the username alone
    await assert.rejects(s.setProfile('u2', { username: 'bennett', phone: num(1) }), (e) => e instanceof StoreError && e.code === 'phone_taken');
    assert.equal((await s.getUserById('u2')).username, 'ben');   // all or nothing
    await assert.rejects(s.setProfile('u2', { username: 'ann', phone: num(2) }), (e) => e instanceof StoreError && e.code === 'username_taken');
    assert.equal((await s.getUserById('u2')).phone, null);
    await s.setProfile('u2', { username: 'bennett', phone: num(2) });
    assert.deepEqual(await s.getUserById('u2'), { ...user(2), username: 'bennett', phone: '+15550000002' });
    const found = await s.findByPhoneHashes(['h1', 'h2', 'h3', 'nope']);
    assert.deepEqual(found.sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'u1', username: 'ann', phoneHash: 'h1' }, { id: 'u2', username: 'bennett', phoneHash: 'h2' }]);
    assert.deepEqual(await s.findByPhoneHashes([]), []);
    await s.setProfile('u1', { phone: null });
    assert.equal((await s.getUserById('u1')).phone, null);
    assert.deepEqual(await s.findByPhoneHashes(['h1']), []);
    await s.setProfile('u3', { phone: num(1) });   // a removed number is free again
    await s.deleteUser('u2');
    await s.createUser({ ...user(4), username: 'dee' });
    await s.setProfile('u4', { phone: num(2) });   // and so is a deleted account's
  });

  test(`${name}: friendships`, async () => {
    const s = make();
    for (const [n, u] of [[1, 'ann'], [2, 'ben'], [3, 'cat']]) await s.createUser({ ...user(n), username: u });
    await s.addFriendRequest({ requesterId: 'u1', addresseeId: 'u2', createdAt: 10 });
    await s.addFriendRequest({ requesterId: 'u3', addresseeId: 'u1', createdAt: 20 });
    await assert.rejects(s.addFriendRequest({ requesterId: 'u1', addresseeId: 'u2', createdAt: 30 }), (e) => e instanceof StoreError && e.code === 'friendship_exists');
    assert.deepEqual(await s.getFriendship('u2', 'u1'), { requesterId: 'u1', addresseeId: 'u2', status: 'pending', createdAt: 10, acceptedAt: null });
    assert.equal(await s.getFriendship('u2', 'u3'), null);
    assert.equal(await s.acceptFriendRequest('u2', 'u1', 40), false);   // only the one asked can accept
    assert.equal(await s.acceptFriendRequest('u1', 'u2', 40), true);
    assert.equal(await s.acceptFriendRequest('u1', 'u2', 50), false);   // already accepted
    const list = await s.listFriendships('u1');
    assert.deepEqual(list.map((f) => [f.otherId, f.otherUsername, f.status]), [['u2', 'ben', 'accepted'], ['u3', 'cat', 'pending']]);
    assert.equal(list[0].acceptedAt, 40);
    assert.deepEqual((await s.listFriendships('u2')).map((f) => f.otherUsername), ['ann']);

    const trip = (id, userId, departAt) => ({ id, userId, provider: 'Amtrak', num: id, date: '2026-10-20', departAt, data: { route: 'R', from: { code: 'CHI' }, to: { code: 'DEN', at: departAt + 1 } }, createdAt: 1 });
    await s.addTrip(trip('5', 'u2', 2000));
    await s.addTrip(trip('7', 'u2', 1000));
    await s.addTrip(trip('9', 'u2', 100));    // too long ago
    await s.addTrip(trip('3', 'u3', 1500));   // a request, not a friend yet
    await s.addTrip(trip('1', 'u1', 1500));   // your own
    const seen = await s.listFriendTrips('u1', 500);
    assert.deepEqual(seen.map((t) => [t.num, t.username]), [['7', 'ben'], ['5', 'ben']]);
    assert.deepEqual(seen[0].data.to, { code: 'DEN', at: 1001 });
    assert.deepEqual((await s.listFriendTrips('u2', 0)).map((t) => t.num), ['1']);   // it works both ways
    assert.deepEqual(await s.listFriendTrips('u3', 0), []);

    assert.equal(await s.deleteFriendship('u2', 'u1'), true);   // either side can end it
    assert.equal(await s.deleteFriendship('u1', 'u2'), false);
    assert.deepEqual(await s.listFriendTrips('u1', 0), []);
    await s.deleteUser('u3');
    assert.deepEqual(await s.listFriendships('u1'), []);
  });

  test(`${name}: sessions`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    await s.createSession({ tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createSession({ tokenHash: 'b', userId: 'u1', createdAt: 1, expiresAt: 300 });
    await s.createSession({ tokenHash: 'c', userId: 'u2', createdAt: 1, expiresAt: 300 });
    assert.deepEqual(await s.getSession('a'), { tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.deleteSessionsBefore(200);
    assert.equal(await s.getSession('a'), null);
    assert.ok(await s.getSession('b'));
    await s.deleteSessionsForUser('u1');
    assert.equal(await s.getSession('b'), null);
    assert.ok(await s.getSession('c'));
    await s.deleteSession('c');
    assert.equal(await s.getSession('c'), null);
  });

  test(`${name}: data keeps the newer copy of each key`, async () => {
    const s = make();
    await s.createUser(user(1));
    assert.deepEqual(await s.getData('u1'), {});
    await s.putData('u1', { favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 10 }, theme: { value: 'dark', updatedAt: 10 } });
    await s.putData('u1', { favTrains: { value: [], updatedAt: 5 }, theme: { value: 'light', updatedAt: 20 } });
    assert.deepEqual(await s.getData('u1'), {
      favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 10 },
      theme: { value: 'light', updatedAt: 20 },
    });
    await s.putData('u1', {});
    // values round-trip as JSON: numbers, booleans, null, nesting
    await s.putData('u1', { misc: { value: { a: 1, b: true, c: null, d: [1.5, 'x'] }, updatedAt: 1 } });
    assert.deepEqual((await s.getData('u1')).misc.value, { a: 1, b: true, c: null, d: [1.5, 'x'] });
  });

  test(`${name}: deleting a user deletes their sessions and data`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    await s.createSession({ tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createSession({ tokenHash: 'c', userId: 'u2', createdAt: 1, expiresAt: 100 });
    await s.putData('u1', { theme: { value: 'dark', updatedAt: 1 } });
    await s.putData('u2', { theme: { value: 'light', updatedAt: 1 } });
    await s.deleteUser('u1');
    assert.equal(await s.getUserById('u1'), null);
    assert.equal(await s.getSession('a'), null);
    assert.deepEqual(await s.getData('u1'), {});
    assert.ok(await s.getUserById('u2'));
    assert.ok(await s.getSession('c'));
    assert.equal((await s.getData('u2')).theme.value, 'light');
    await s.createUser({ ...user(3), email: 'p1@example.com' });   // the email is free again
  });

  test(`${name}: trips`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    const trip = (id, userId, num, date, departAt) => ({ id, userId, provider: 'Amtrak', num, date, departAt, data: { route: 'R', from: { code: 'CHI' }, to: { code: 'DEN' } }, createdAt: 1 });
    await s.addTrip(trip('t2', 'u1', '5', '2026-10-20', 2000));
    await s.addTrip(trip('t1', 'u1', '6', '2026-10-18', 1000));
    await s.addTrip(trip('t3', 'u2', '5', '2026-10-20', 2000));   // someone else can take the same train
    await assert.rejects(s.addTrip(trip('t4', 'u1', '5', '2026-10-20', 2000)), (e) => e instanceof StoreError && e.code === 'trip_exists');
    const mine = await s.listTrips('u1');
    assert.deepEqual(mine.map((t) => t.id), ['t1', 't2']);   // soonest first
    assert.deepEqual(mine[1], trip('t2', 'u1', '5', '2026-10-20', 2000));
    assert.equal(await s.deleteTrip('u2', 't1'), false);   // not theirs
    assert.equal(await s.deleteTrip('u1', 't1'), true);
    assert.equal(await s.deleteTrip('u1', 't1'), false);
    await s.deleteUser('u1');
    assert.deepEqual(await s.listTrips('u1'), []);
    assert.equal((await s.listTrips('u2')).length, 1);
  });

  test(`${name}: pending sign-ups`, async () => {
    const s = make();
    const p = { email: 'a@example.com', username: 'ann', passwordHash: 'h', codeHash: 'c1', createdAt: 1, expiresAt: 100 };
    await s.putPendingSignup(p);
    assert.deepEqual(await s.getPendingSignup('a@example.com'), { ...p, attempts: 0 });
    await s.addPendingAttempt('a@example.com');
    await s.addPendingAttempt('a@example.com');
    assert.equal((await s.getPendingSignup('a@example.com')).attempts, 2);
    await s.putPendingSignup({ ...p, codeHash: 'c2', expiresAt: 300 });   // a new request replaces it, tries and all
    assert.deepEqual(await s.getPendingSignup('a@example.com'), { ...p, codeHash: 'c2', expiresAt: 300, attempts: 0 });
    await s.putPendingSignup({ ...p, email: 'b@example.com', username: null, expiresAt: 50 });
    await s.deletePendingSignupsBefore(200);
    assert.equal(await s.getPendingSignup('b@example.com'), null);
    assert.ok(await s.getPendingSignup('a@example.com'));
    await s.deletePendingSignup('a@example.com');
    assert.equal(await s.getPendingSignup('a@example.com'), null);
  });

  test(`${name}: reset tokens`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createResetToken({ tokenHash: 'r1', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createResetToken({ tokenHash: 'r2', userId: 'u1', createdAt: 2, expiresAt: 300 });
    assert.deepEqual(await s.getResetToken('r1'), { tokenHash: 'r1', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.deleteResetTokensBefore(200);
    assert.equal(await s.getResetToken('r1'), null);
    assert.ok(await s.getResetToken('r2'));
    await s.deleteResetTokensForUser('u1');
    assert.equal(await s.getResetToken('r2'), null);
  });

  test(`${name}: feedback`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.addFeedback({ id: 'f1', userId: 'u1', kind: 'idea', message: 'More maps', contact: 'a@example.com', page: 'web', createdAt: 1 });
    await s.addFeedback({ id: 'f2', userId: null, kind: 'problem', message: 'Late', createdAt: 2 });
    assert.deepEqual(await s.listFeedback(10), [
      { id: 'f2', userId: null, kind: 'problem', message: 'Late', contact: null, page: null, createdAt: 2 },
      { id: 'f1', userId: 'u1', kind: 'idea', message: 'More maps', contact: 'a@example.com', page: 'web', createdAt: 1 },
    ]);
    await s.deleteUser('u1');
    assert.deepEqual((await s.listFeedback(10)).map((f) => f.id), ['f2']);
  });

  test(`${name}: attempts`, async () => {
    const s = make();
    for (const at of [10, 20, 30]) await s.addAttempt('login-email:p1@example.com', at);
    await s.addAttempt('login-ip:1.2.3.4', 30);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 0), 3);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 20), 2);
    assert.equal(await s.countAttempts('other', 0), 0);
    await s.deleteAttemptsBefore(25);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 0), 1);
    assert.equal(await s.countAttempts('login-ip:1.2.3.4', 0), 1);
  });
}
