/* The accounts store: everything Trackside keeps about people, behind one small interface, so the database
   behind it can be swapped without touching the API or the site.

   An adapter is any object with these async methods. Times are milliseconds since 1970.

     createUser({ id, email, username?, passwordHash, createdAt })
                                                              throws StoreError('email_taken' or 'username_taken')
     getUserByEmail(email) -> user | null                     user: { id, email, username, phone, passwordHash, createdAt }
     getUserById(id) -> user | null                           username and phone (E.164) are null until chosen
     getUserByUsername(username) -> user | null
     setProfile(id, { username?, phone? })                    together or not at all. phone: { number, hash } to set,
                                                              null to remove; a field left out stays as it is.
                                                              throws StoreError('username_taken' or 'phone_taken')
     findByPhoneHashes([hash]) -> [{ id, username, phoneHash }]   accounts with a username whose number matches
     setPasswordHash(id, passwordHash)
     deleteUser(id)                                           also deletes that user's sessions, data, trips, reset links,
                                                              username, phone, friendships and feedback

     createSession({ tokenHash, userId, createdAt, expiresAt })
     getSession(tokenHash) -> { tokenHash, userId, createdAt, expiresAt } | null
     deleteSession(tokenHash)
     deleteSessionsForUser(userId)                            signs a person out everywhere
     deleteSessionsBefore(time)                               housekeeping: drops expired sessions

     getData(userId) -> { [key]: { value, updatedAt } }       value is any JSON
     putData(userId, { [key]: { value, updatedAt } })         per key, keeps whichever copy is newer

     listTrips(userId) -> [trip]                              trip: { id, userId, provider, num, date, departAt, data, createdAt }
     addTrip(trip)                                            throws StoreError('trip_exists') for the same train on the same day
     deleteTrip(userId, id) -> boolean                        false if there was no such trip

     getFriendship(a, b) -> friendship | null                 either direction. friendship: { requesterId, addresseeId,
                                                                status: 'pending' | 'accepted', createdAt, acceptedAt }
     addFriendRequest({ requesterId, addresseeId, createdAt })   throws StoreError('friendship_exists')
     acceptFriendRequest(requesterId, addresseeId, at) -> boolean   false if there was no such pending request
     deleteFriendship(a, b) -> boolean                        either direction
     listFriendships(userId) -> [friendship + { otherId, otherUsername }]   oldest first
     listFriendTrips(userId, since) -> [trip + { username }]  accepted friends' trips leaving at or after since, soonest first

     putPendingSignup({ email, username, passwordHash, codeHash, createdAt, expiresAt })   replaces any for that email
     getPendingSignup(email) -> { …, attempts } | null        a sign-up waiting for its emailed code
     addPendingAttempt(email)                                 counts a wrong code
     deletePendingSignup(email)
     deletePendingSignupsBefore(time)

     createResetToken({ tokenHash, userId, createdAt, expiresAt })
     getResetToken(tokenHash) -> { tokenHash, userId, createdAt, expiresAt } | null
     deleteResetTokensForUser(userId)                         a link works once: using one cancels them all
     deleteResetTokensBefore(time)

     addFeedback({ id, userId, kind, message, contact, page, createdAt })   userId, contact and page may be null
     listFeedback(limit) -> [feedback]                        newest first

     countAttempts(bucket, since) -> number                   rate limiting: sign-in and sign-up attempts
     addAttempt(bucket, at)
     deleteAttemptsBefore(time)

   Adapters here: SQL databases through sql.js (Cloudflare D1, Turso, or Node's built-in SQLite for local
   runs), and an in-memory one. test/store.test.js runs the same checks against each of them. */
import { SqlStore } from './sql.js';
import { d1Client } from './d1.js';
import { tursoClient } from './turso.js';
import { MemoryStore } from './memory.js';

export { StoreError } from './errors.js';

/* Picks the adapter from the worker's settings:
     ACCOUNTS_STORE   an adapter object handed in directly (local dev server, tests)
     ACCOUNTS_DB      "d1" (the DB binding), "turso" (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) or "memory"
   Returns null when accounts aren't configured, and the API answers 503. */
const built = new WeakMap();
export function storeFor(env) {
  if (env.ACCOUNTS_STORE) return env.ACCOUNTS_STORE;
  if (built.has(env)) return built.get(env);
  const kind = String(env.ACCOUNTS_DB || (env.DB ? 'd1' : '')).toLowerCase();
  let store = null;
  if (kind === 'd1' && env.DB) store = new SqlStore(d1Client(env.DB));
  else if (kind === 'turso' && env.TURSO_DATABASE_URL) store = new SqlStore(tursoClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN));
  else if (kind === 'memory') store = memory || (memory = new MemoryStore());   // one per isolate; lost on restart
  built.set(env, store);
  return store;
}
let memory = null;
