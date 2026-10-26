/* The accounts store on any SQLite-flavoured database. The SQL lives only here and in ../../migrations;
   the database itself is reached through a client with three methods:

     all(sql, params) -> rows        rows are plain objects keyed by column name
     run(sql, params) -> { changes }
     batch([{ sql, params }])        runs the statements together, all or nothing

   Clients: d1.js (Cloudflare D1), turso.js (Turso / libSQL over HTTP), and ../../local/sqlite-client.mjs
   (Node's built-in SQLite, for the local dev server and tests). The SQL avoids anything SQLite-only beyond
   ON CONFLICT upserts, and deletes child rows itself rather than relying on foreign-key cascades. */
import { StoreError } from './errors.js';

const isUnique = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));
const takenCode = (err) => { const m = String(err && err.message); return /username/i.test(m) ? 'username_taken' : /phone/i.test(m) ? 'phone_taken' : 'email_taken'; };
const userRow = (r) => (r ? { id: r.id, email: r.email, username: r.username || null, phone: r.phone || null, passwordHash: r.password_hash, createdAt: Number(r.created_at) } : null);
const USER = `SELECT users.*, profiles.username, phones.phone FROM users
  LEFT JOIN profiles ON profiles.user_id = users.id LEFT JOIN phones ON phones.user_id = users.id`;
const tripRow = (r) => ({
  id: r.id, userId: r.user_id, provider: r.provider, num: r.train_num, date: r.service_date,
  departAt: Number(r.depart_at), data: JSON.parse(r.data), createdAt: Number(r.created_at),
});

const friendshipRow = (r) => ({
  requesterId: r.requester_id, addresseeId: r.addressee_id, status: r.status,
  createdAt: Number(r.created_at), acceptedAt: r.accepted_at == null ? null : Number(r.accepted_at),
});

export class SqlStore {
  constructor(client) { this.db = client; }

  async createUser({ id, email, username, passwordHash, createdAt }) {
    const stmts = [{ sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', params: [id, email, passwordHash, createdAt] }];
    if (username) stmts.push({ sql: 'INSERT INTO profiles (user_id, username) VALUES (?, ?)', params: [id, username] });
    try {
      await this.db.batch(stmts);
    } catch (err) {
      if (isUnique(err)) throw new StoreError(takenCode(err));
      throw err;
    }
  }
  async getUserByEmail(email) {
    return userRow((await this.db.all(USER + ' WHERE users.email = ?', [email]))[0]);
  }
  async getUserById(id) {
    return userRow((await this.db.all(USER + ' WHERE users.id = ?', [id]))[0]);
  }
  async getUserByUsername(username) {
    return userRow((await this.db.all(USER + ' WHERE profiles.username = ?', [username]))[0]);
  }
  async setProfile(id, { username, phone }) {
    const stmts = [];
    if (username !== undefined) stmts.push({ sql: `INSERT INTO profiles (user_id, username) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET username = excluded.username`, params: [id, username] });
    if (phone === null) stmts.push({ sql: 'DELETE FROM phones WHERE user_id = ?', params: [id] });
    else if (phone !== undefined) stmts.push({ sql: `INSERT INTO phones (user_id, phone, phone_hash) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone, phone_hash = excluded.phone_hash`, params: [id, phone.number, phone.hash] });
    if (!stmts.length) return;
    try {
      await this.db.batch(stmts);
    } catch (err) {
      if (isUnique(err)) throw new StoreError(takenCode(err));
      throw err;
    }
  }
  /* One parameter however many hashes: D1 allows only 100 bound parameters per query. */
  async findByPhoneHashes(hashes) {
    if (!hashes.length) return [];
    const rows = await this.db.all(`SELECT phones.user_id, phones.phone_hash, profiles.username FROM phones
      JOIN profiles ON profiles.user_id = phones.user_id
      WHERE phones.phone_hash IN (SELECT value FROM json_each(?))`, [JSON.stringify(hashes)]);
    return rows.map((r) => ({ id: r.user_id, username: r.username, phoneHash: r.phone_hash }));
  }
  async setPasswordHash(id, passwordHash) {
    await this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  }
  async deleteUser(id) {
    await this.db.batch([
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM user_data WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM trips WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM reset_tokens WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', params: [id, id] },
      { sql: 'DELETE FROM profiles WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM phones WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM feedback WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM users WHERE id = ?', params: [id] },
    ]);
  }

  async createSession({ tokenHash, userId, createdAt, expiresAt }) {
    await this.db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [tokenHash, userId, createdAt, expiresAt]);
  }
  async getSession(tokenHash) {
    const r = (await this.db.all('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]))[0];
    return r ? { tokenHash: r.token_hash, userId: r.user_id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async deleteSession(tokenHash) {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }
  async deleteSessionsForUser(userId) {
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  async deleteSessionsBefore(time) {
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [time]);
  }

  async getData(userId) {
    const out = {};
    for (const r of await this.db.all('SELECT key, value, updated_at FROM user_data WHERE user_id = ?', [userId])) {
      out[r.key] = { value: JSON.parse(r.value), updatedAt: Number(r.updated_at) };
    }
    return out;
  }
  async putData(userId, entries) {
    const stmts = Object.entries(entries).map(([key, e]) => ({
      sql: `INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= user_data.updated_at`,
      params: [userId, key, JSON.stringify(e.value), e.updatedAt],
    }));
    if (stmts.length) await this.db.batch(stmts);
  }

  async listTrips(userId) {
    return (await this.db.all('SELECT * FROM trips WHERE user_id = ? ORDER BY depart_at', [userId])).map(tripRow);
  }
  async addTrip(t) {
    try {
      await this.db.run('INSERT INTO trips (id, user_id, provider, train_num, service_date, depart_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [t.id, t.userId, t.provider, t.num, t.date, t.departAt, JSON.stringify(t.data), t.createdAt]);
    } catch (err) {
      if (isUnique(err)) throw new StoreError('trip_exists');
      throw err;
    }
  }
  async deleteTrip(userId, id) {
    return (await this.db.run('DELETE FROM trips WHERE user_id = ? AND id = ?', [userId, id])).changes > 0;
  }

  async getFriendship(a, b) {
    const r = (await this.db.all(`SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`, [a, b, b, a]))[0];
    return r ? friendshipRow(r) : null;
  }
  async addFriendRequest({ requesterId, addresseeId, createdAt }) {
    try {
      await this.db.run(`INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)`, [requesterId, addresseeId, createdAt]);
    } catch (err) {
      if (isUnique(err)) throw new StoreError('friendship_exists');
      throw err;
    }
  }
  async acceptFriendRequest(requesterId, addresseeId, at) {
    return (await this.db.run(`UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`, [at, requesterId, addresseeId])).changes > 0;
  }
  async deleteFriendship(a, b) {
    return (await this.db.run('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', [a, b, b, a])).changes > 0;
  }
  async listFriendships(userId) {
    const rows = await this.db.all(`SELECT f.*, p.username AS other_username FROM friendships f
      LEFT JOIN profiles p ON p.user_id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY f.created_at`, [userId, userId, userId]);
    return rows.map((r) => ({ ...friendshipRow(r), otherId: r.requester_id === userId ? r.addressee_id : r.requester_id, otherUsername: r.other_username || null }));
  }
  async listFriendTrips(userId, since) {
    const rows = await this.db.all(`SELECT t.*, p.username AS friend_username FROM trips t
      JOIN friendships f ON f.status = 'accepted'
        AND ((f.requester_id = ? AND f.addressee_id = t.user_id) OR (f.addressee_id = ? AND f.requester_id = t.user_id))
      LEFT JOIN profiles p ON p.user_id = t.user_id
      WHERE t.depart_at >= ? ORDER BY t.depart_at`, [userId, userId, since]);
    return rows.map((r) => ({ ...tripRow(r), username: r.friend_username || null }));
  }

  async putPendingSignup(p) {
    await this.db.run(`INSERT INTO pending_signups (email, username, password_hash, code_hash, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT (email) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash,
      code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [p.email, p.username || null, p.passwordHash, p.codeHash, p.createdAt, p.expiresAt]);
  }
  async getPendingSignup(email) {
    const r = (await this.db.all('SELECT * FROM pending_signups WHERE email = ?', [email]))[0];
    return r ? { email: r.email, username: r.username || null, passwordHash: r.password_hash, codeHash: r.code_hash,
      attempts: Number(r.attempts), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async addPendingAttempt(email) {
    await this.db.run('UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?', [email]);
  }
  async deletePendingSignup(email) {
    await this.db.run('DELETE FROM pending_signups WHERE email = ?', [email]);
  }
  async deletePendingSignupsBefore(time) {
    await this.db.run('DELETE FROM pending_signups WHERE expires_at < ?', [time]);
  }

  async createResetToken({ tokenHash, userId, createdAt, expiresAt }) {
    await this.db.run('INSERT INTO reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [tokenHash, userId, createdAt, expiresAt]);
  }
  async getResetToken(tokenHash) {
    const r = (await this.db.all('SELECT * FROM reset_tokens WHERE token_hash = ?', [tokenHash]))[0];
    return r ? { tokenHash: r.token_hash, userId: r.user_id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async deleteResetTokensForUser(userId) {
    await this.db.run('DELETE FROM reset_tokens WHERE user_id = ?', [userId]);
  }
  async deleteResetTokensBefore(time) {
    await this.db.run('DELETE FROM reset_tokens WHERE expires_at < ?', [time]);
  }

  async addFeedback(f) {
    await this.db.run('INSERT INTO feedback (id, user_id, kind, message, contact, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [f.id, f.userId || null, f.kind, f.message, f.contact || null, f.page || null, f.createdAt]);
  }
  async listFeedback(limit) {
    const rows = await this.db.all('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id || null, kind: r.kind, message: r.message, contact: r.contact || null, page: r.page || null, createdAt: Number(r.created_at) }));
  }

  async countAttempts(bucket, since) {
    const r = (await this.db.all('SELECT COUNT(*) AS n FROM attempts WHERE bucket = ? AND at >= ?', [bucket, since]))[0];
    return Number(r ? r.n : 0);
  }
  async addAttempt(bucket, at) {
    await this.db.run('INSERT INTO attempts (bucket, at) VALUES (?, ?)', [bucket, at]);
  }
  async deleteAttemptsBefore(time) {
    await this.db.run('DELETE FROM attempts WHERE at < ?', [time]);
  }
}
