/* The accounts store in memory. For tests, and for trying the API with ACCOUNTS_DB = "memory";
   everything is lost when the worker restarts, so never use it for real accounts. */
import { StoreError } from './errors.js';

const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export class MemoryStore {
  constructor() {
    this.users = new Map();      // id -> user
    this.sessions = new Map();   // tokenHash -> session
    this.data = new Map();       // userId -> Map(key -> { value, updatedAt })
    this.attempts = [];          // [{ bucket, at }]
    this.trips = new Map();      // id -> trip
    this.resets = new Map();     // tokenHash -> reset token
    this.friendships = [];       // [{ requesterId, addresseeId, status, createdAt, acceptedAt }]
    this.pending = new Map();    // email -> pending sign-up
    this.feedback = [];          // [feedback], oldest first
  }

  async createUser(u) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw new StoreError('email_taken');
    if (u.username && [...this.users.values()].some((x) => x.username === u.username)) throw new StoreError('username_taken');
    this.users.set(u.id, { id: u.id, email: u.email, username: u.username || null, phone: null, passwordHash: u.passwordHash, createdAt: u.createdAt });
  }
  async getUserByEmail(email) { return this.#public([...this.users.values()].find((u) => u.email === email)); }
  async getUserById(id) { return this.#public(this.users.get(id)); }
  async getUserByUsername(username) { return this.#public([...this.users.values()].find((u) => u.username === username)); }
  #public(u) { return u ? copy({ ...u, phone: u.phone ? u.phone.number : null }) : null; }
  async setProfile(id, { username, phone }) {
    const others = [...this.users.values()].filter((x) => x.id !== id);
    if (username !== undefined && others.some((x) => x.username === username)) throw new StoreError('username_taken');
    if (phone && others.some((x) => x.phone && x.phone.hash === phone.hash)) throw new StoreError('phone_taken');
    const u = this.users.get(id);
    if (!u) return;
    if (username !== undefined) u.username = username;
    if (phone !== undefined) u.phone = phone && { number: phone.number, hash: phone.hash };
  }
  async findByPhoneHashes(hashes) {
    const want = new Set(hashes);
    return [...this.users.values()].filter((u) => u.username && u.phone && want.has(u.phone.hash))
      .map((u) => ({ id: u.id, username: u.username, phoneHash: u.phone.hash }));
  }
  async setPasswordHash(id, passwordHash) { const u = this.users.get(id); if (u) u.passwordHash = passwordHash; }
  async deleteUser(id) {
    this.users.delete(id);
    this.friendships = this.friendships.filter((f) => f.requesterId !== id && f.addresseeId !== id);
    this.data.delete(id);
    for (const [k, s] of this.sessions) if (s.userId === id) this.sessions.delete(k);
    for (const [k, t] of this.trips) if (t.userId === id) this.trips.delete(k);
    for (const [k, r] of this.resets) if (r.userId === id) this.resets.delete(k);
    this.feedback = this.feedback.filter((f) => f.userId !== id);
  }

  async createSession(s) { this.sessions.set(s.tokenHash, { ...s }); }
  async getSession(tokenHash) { return copy(this.sessions.get(tokenHash) || null); }
  async deleteSession(tokenHash) { this.sessions.delete(tokenHash); }
  async deleteSessionsForUser(userId) { for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k); }
  async deleteSessionsBefore(time) { for (const [k, s] of this.sessions) if (s.expiresAt < time) this.sessions.delete(k); }

  async getData(userId) { return copy(Object.fromEntries(this.data.get(userId) || [])); }
  async putData(userId, entries) {
    if (!this.data.has(userId)) this.data.set(userId, new Map());
    const m = this.data.get(userId);
    for (const [key, e] of Object.entries(entries)) {
      const cur = m.get(key);
      if (!cur || e.updatedAt >= cur.updatedAt) m.set(key, { value: copy(e.value), updatedAt: e.updatedAt });
    }
  }

  async listTrips(userId) {
    return copy([...this.trips.values()].filter((t) => t.userId === userId).sort((a, b) => a.departAt - b.departAt));
  }
  async addTrip(t) {
    if ([...this.trips.values()].some((x) => x.userId === t.userId && x.provider === t.provider && x.num === t.num && x.date === t.date)) throw new StoreError('trip_exists');
    this.trips.set(t.id, copy(t));
  }
  async deleteTrip(userId, id) {
    const t = this.trips.get(id);
    if (!t || t.userId !== userId) return false;
    return this.trips.delete(id);
  }

  async getFriendship(a, b) {
    return copy(this.friendships.find((f) => (f.requesterId === a && f.addresseeId === b) || (f.requesterId === b && f.addresseeId === a)) || null);
  }
  async addFriendRequest({ requesterId, addresseeId, createdAt }) {
    if (this.friendships.some((f) => f.requesterId === requesterId && f.addresseeId === addresseeId)) throw new StoreError('friendship_exists');
    this.friendships.push({ requesterId, addresseeId, status: 'pending', createdAt, acceptedAt: null });
  }
  async acceptFriendRequest(requesterId, addresseeId, at) {
    const f = this.friendships.find((x) => x.requesterId === requesterId && x.addresseeId === addresseeId && x.status === 'pending');
    if (!f) return false;
    f.status = 'accepted';
    f.acceptedAt = at;
    return true;
  }
  async deleteFriendship(a, b) {
    const before = this.friendships.length;
    this.friendships = this.friendships.filter((f) => !((f.requesterId === a && f.addresseeId === b) || (f.requesterId === b && f.addresseeId === a)));
    return this.friendships.length < before;
  }
  async listFriendships(userId) {
    return copy(this.friendships.filter((f) => f.requesterId === userId || f.addresseeId === userId)
      .sort((x, y) => x.createdAt - y.createdAt)
      .map((f) => {
        const otherId = f.requesterId === userId ? f.addresseeId : f.requesterId;
        return { ...f, otherId, otherUsername: (this.users.get(otherId) || {}).username || null };
      }));
  }
  async listFriendTrips(userId, since) {
    const friends = new Set(this.friendships.filter((f) => f.status === 'accepted' && (f.requesterId === userId || f.addresseeId === userId))
      .map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId)));
    return copy([...this.trips.values()].filter((t) => friends.has(t.userId) && t.departAt >= since)
      .sort((a, b) => a.departAt - b.departAt)
      .map((t) => ({ ...t, username: (this.users.get(t.userId) || {}).username || null })));
  }

  async putPendingSignup(p) { this.pending.set(p.email, { ...copy(p), username: p.username || null, attempts: 0 }); }
  async getPendingSignup(email) { return copy(this.pending.get(email) || null); }
  async addPendingAttempt(email) { const p = this.pending.get(email); if (p) p.attempts++; }
  async deletePendingSignup(email) { this.pending.delete(email); }
  async deletePendingSignupsBefore(time) { for (const [k, p] of this.pending) if (p.expiresAt < time) this.pending.delete(k); }

  async createResetToken(r) { this.resets.set(r.tokenHash, { ...r }); }
  async getResetToken(tokenHash) { return copy(this.resets.get(tokenHash) || null); }
  async deleteResetTokensForUser(userId) { for (const [k, r] of this.resets) if (r.userId === userId) this.resets.delete(k); }
  async deleteResetTokensBefore(time) { for (const [k, r] of this.resets) if (r.expiresAt < time) this.resets.delete(k); }

  async addFeedback(f) { this.feedback.push({ ...copy(f), userId: f.userId || null, contact: f.contact || null, page: f.page || null }); }
  async listFeedback(limit) { return copy(this.feedback.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)); }

  async countAttempts(bucket, since) { return this.attempts.filter((a) => a.bucket === bucket && a.at >= since).length; }
  async addAttempt(bucket, at) { this.attempts.push({ bucket, at }); }
  async deleteAttemptsBefore(time) { this.attempts = this.attempts.filter((a) => a.at >= time); }
}
