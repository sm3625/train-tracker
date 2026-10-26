/* Trackside accounts: sign up with an email and password, then sync saved trains, stations and settings
   between devices. Storage goes through ./store, so this file never knows which database is behind it.

   POST   /v1/auth/signup     { email, password, username?, turnstileToken? } -> 201 { token, user }, or, with email
                                                              verification on, 202 { pending: true } and a code emailed
   POST   /v1/auth/signup/confirm  { email, code }           -> 201 { token, user }  (makes the account)

   Email verification is on whenever email can be sent (mail.js) and EMAIL_VERIFY isn't "off". Then sign-up answers
   the same whether or not the email has an account: a new one gets a code, an existing one a note to sign in.
   POST   /v1/auth/login      { email, password }            -> { token, user }
   POST   /v1/auth/logout                                     -> 204
   POST   /v1/auth/reset      { email }                      -> 202              (emails a reset link if there's an account)
   POST   /v1/auth/reset/confirm  { token, password }        -> { token, user }  (sets the password, signs out everywhere else)
   GET    /v1/me                                              -> { user }
   POST   /v1/me/password     { password, newPassword }      -> { token, user }  (signs out other devices)
   DELETE /v1/me              { password }                   -> 204              (deletes the account and its data)
   GET    /v1/me/data                                         -> { data }
   PUT    /v1/me/data         { data }                       -> { data }         (merged: the newer copy of each key wins)
   GET    /v1/me/trips                                        -> { trips }        (soonest first)
   POST   /v1/me/trips        { provider, num, date, route, from, to }  -> 201 { trip }
   DELETE /v1/me/trips/:id                                    -> 204
   PUT    /v1/me/profile      { username?, phone: null? }    -> { user }         (phone null removes the number)
   POST   /v1/me/phone        { phone }                      -> 202              (texts a code to the number, E.164)
                                                              -> { user }         (no texting service: saved without a code)
   POST   /v1/me/phone/verify { phone, code }                -> { user }         (the code right: the number is the account's)
   GET    /v1/me/friends                                      -> { friends, incoming, outgoing }   ([{ username, at }])
   POST   /v1/me/friends      { username } or { phoneHash }  -> { status, username }   ('pending', or 'accepted' when they'd asked you)
   POST   /v1/me/friends/match  { phoneHashes }              -> { matches }      (who from a phone's contacts is on Trackside)
   DELETE /v1/me/friends/:username                            -> 204              (unfriends, cancels or declines)
   GET    /v1/me/friends/trips                                -> { trips }        (friends' trips not long over, soonest first)
   POST   /v1/feedback        { kind, message, contact?, page? }  -> 201          (signed in or not; kept with the account if signed in)

   A user is { id, email, username, phone, createdAt }; username and phone are null until chosen, and friends need a
   username to find each other. Friends see each other's trips and usernames, never emails or phone numbers.
   Numbers are looked up by phoneHash: the lowercase hex SHA-256 of the E.164 number (+15551234567), so a phone's
   contacts never leave it as plain numbers. Matches are answered and forgotten; nothing uploaded is stored.

   A trip is one train on one day: provider and num as the live feeds name them, date the YYYY-MM-DD it starts its
   run, and from/to { code, name, at, tz }: where the person boards and leaves, with scheduled times in ms. Trips stay
   after they're over, as the record of the person's rides, so only upcoming ones count toward the trip limit.

   Signed-in requests carry "Authorization: Bearer <token>". A bearer token rather than a cookie, because the site
   (github.io) and this worker (workers.dev) are different sites and browsers increasingly block cross-site cookies.
   data is { key: { value, updatedAt } }: any JSON value, and when it last changed in ms since 1970.
   Errors are { error: { code, message } }, with a message fit to show people. */
import { storeFor, StoreError } from './store/index.js';
import { mailerFor } from './mail.js';
import { verifierFor } from './sms.js';
import { checkHuman } from './turnstile.js';
import { json, corsHeaders } from './http.js';
import { PROVIDERS as FEED_PROVIDERS } from './agencies.js';

const SESSION_MS = 30 * 86400000;
const DEFAULT_ITERATIONS = 100000;   // PBKDF2-SHA256; the most Cloudflare's Web Crypto allows
const PASSWORD_MIN = 8, PASSWORD_MAX = 256;
const DATA_KEY = /^[A-Za-z][\w.-]{0,39}$/;
const DATA_MAX_KEYS = 30, DATA_MAX_VALUE = 16 * 1024, BODY_MAX = 64 * 1024;
/* [attempts, window] before answering 429 */
const LIMITS = {
  loginEmail: [10, 15 * 60000],   // failed sign-ins per email: slows password guessing against one account
  loginIp: [50, 15 * 60000],      // failed sign-ins per address: slows guessing across many accounts
  signupIp: [10, 3600000],        // new accounts per address per hour, without a bot check
  signupIpHuman: [200, 3600000],  // with one (turnstile.js): enough for a phone network or campus behind one address
  resetEmail: [3, 3600000],       // reset emails per account per hour
  resetIp: [10, 3600000],         // reset requests per address per hour
  signupEmail: [3, 3600000],      // sign-up emails per address per hour (verification on)
  confirmIp: [30, 15 * 60000],    // wrong sign-up codes per address
  friendRequest: [30, 3600000],   // new friend requests per account per hour
  phoneLookup: [30, 3600000],     // lookups by number per account per hour: slows working out who has which number
  contactsDaily: [10, 86400000],  // contacts lookups (up to 2000 numbers each) per account per day
  smsAccount: [5, 3600000],       // codes texted per account per hour
  smsNumber: [5, 3600000],        // codes texted to one number per hour, whoever asks
  smsCheck: [10, 15 * 60000],     // wrong codes per account
  feedbackIp: [10, 3600000],      // feedback messages per address per hour
};
const RESET_MS = 30 * 60000;
const CODE_MS = 15 * 60000, CODE_TRIES = 5;   // a sign-up code lasts 15 minutes and allows 5 wrong tries
const PROVIDERS = ['Amtrak', 'Via', 'Brightline', ...FEED_PROVIDERS];   // Amtraker's, then the feeds worker's
const TRIPS_MAX = 200;       // upcoming trips
const TRIPS_KEPT = 5000;     // every trip, past ones included
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;
const FRIENDS_MAX = 200;   // friends and requests, together
const FRIEND_TRIPS_BACK = 4 * 86400000;   // the longest runs take about three days; older trips are surely over
const TRIP_DONE_MS = 6 * 3600000;         // a trip counts as over this long after its scheduled arrival, as on the site
const PHONE = /^\+1\d{10}$/;                // US and Canada only: texts elsewhere cost more, and invite SMS fraud
const HASH = /^[0-9a-f]{64}$/;
const FEEDBACK_KINDS = ['idea', 'problem', 'other'];
const FEEDBACK_MAX = 4000;                  // characters in a message
const MATCH_MAX = 2000;                     // numbers per contacts lookup; the app sends a big address book in parts

/* ---------------- passwords and tokens ---------------- */
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
const iterationsFor = (env) => Math.min(DEFAULT_ITERATIONS, Number(env.PASSWORD_ITERATIONS) || DEFAULT_ITERATIONS);
export async function hashPassword(password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, iterations))}`;
}
/* The iteration count is stored with each hash, so it can be raised later without locking anyone out. */
export async function verifyPassword(password, stored) {
  const [scheme, it, salt, want] = String(stored).split('$');
  if (scheme !== 'pbkdf2-sha256') return false;
  const got = await pbkdf2(password, unb64url(salt), Number(it));
  const w = unb64url(want);
  let diff = got.length ^ w.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (w[i] || 0);
  return diff === 0;
}
/* Unknown emails still pay for one hash, so response times don't reveal which emails have accounts. */
const DUMMY_HASH = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const tokenHash = async (token) => hex(await crypto.subtle.digest('SHA-256', enc.encode(token)));

/* ---------------- helpers ---------------- */
class ApiError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
function checkEmail(email) {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'bad_email', 'Enter a valid email address.');
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw new ApiError(400, 'weak_password', `Use a password of at least ${PASSWORD_MIN} characters.`);
  if (pw.length > PASSWORD_MAX) throw new ApiError(400, 'long_password', `Use a password of at most ${PASSWORD_MAX} characters.`);
}
async function body(req, max = BODY_MAX) {
  const text = await req.text();
  if (text.length > max) throw new ApiError(413, 'too_large', 'That request is too large.');
  try { return text ? JSON.parse(text) : {}; } catch { throw new ApiError(400, 'bad_json', 'The request body must be JSON.'); }
}
const publicUser = (u) => ({ id: u.id, email: u.email, username: u.username || null, phone: u.phone || null, createdAt: u.createdAt });
const phoneHash = async (phone) => hex(await crypto.subtle.digest('SHA-256', enc.encode(phone)));
function checkPhone(p) {
  const number = String(p || '').trim();
  if (!PHONE.test(number)) throw new ApiError(400, 'bad_phone', 'Only US and Canada numbers work for now.');
  return number;
}
const normUsername = (n) => String(n || '').trim().replace(/^@/, '').toLowerCase();
function checkUsername(name) {
  if (!USERNAME.test(name)) throw new ApiError(400, 'bad_username', 'Usernames are 3 to 20 letters, numbers or underscores, starting with a letter.');
}
const usernameTaken = () => new ApiError(409, 'username_taken', 'That username is taken. Try another.');
const TAKEN = {
  username_taken: usernameTaken,
  phone_taken: () => new ApiError(409, 'phone_taken', 'That number is already on another Trackside account.'),
};

async function limit(store, bucket, [max, windowMs], now) {
  if (await store.countAttempts(bucket, now - windowMs) >= max) {
    throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.', { 'Retry-After': String(Math.ceil(windowMs / 1000)) });
  }
}
async function startSession(store, user, now) {
  const token = newToken();
  await store.createSession({ tokenHash: await tokenHash(token), userId: user.id, createdAt: now, expiresAt: now + SESSION_MS });
  return { token, user: publicUser(user) };
}
async function signedIn(req, store, now) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '');
  if (!m) throw new ApiError(401, 'signed_out', 'Sign in to continue.');
  const th = await tokenHash(m[1]);
  const s = await store.getSession(th);
  if (!s || s.expiresAt <= now) {
    if (s) await store.deleteSession(th);
    throw new ApiError(401, 'signed_out', 'Your session has ended. Sign in again.');
  }
  const user = await store.getUserById(s.userId);
  if (!user) throw new ApiError(401, 'signed_out', 'This account no longer exists.');
  return { user, tokenHash: th };
}
function checkData(data, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'bad_data', 'data must be an object.');
  const out = {};
  for (const [key, e] of Object.entries(data)) {
    if (!DATA_KEY.test(key)) throw new ApiError(400, 'bad_data', `"${key.slice(0, 40)}" isn't a valid key.`);
    if (!e || typeof e !== 'object' || !('value' in e) || !Number.isFinite(e.updatedAt)) throw new ApiError(400, 'bad_data', `${key} needs a value and an updatedAt time.`);
    if (JSON.stringify(e.value).length > DATA_MAX_VALUE) throw new ApiError(413, 'too_large', `${key} is too large to sync.`);
    out[key] = { value: e.value, updatedAt: Math.min(Math.floor(e.updatedAt), now + 60000) };   // a fast clock can't pin a value forever
  }
  return out;
}

/* ---------------- trips ---------------- */
const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isStop = (s) => s && isStr(s.code, 24) && isStr(s.name, 100) && Number.isFinite(s.at) && isStr(s.tz, 40);
function checkTrip(b, now) {
  const bad = (msg) => new ApiError(400, 'bad_trip', msg);
  if (!b || !PROVIDERS.includes(b.provider)) throw bad('That railroad isn’t one Trackside knows.');
  if (typeof b.num !== 'string' || !/^[A-Za-z0-9-]{1,12}$/.test(b.num)) throw bad('That train number doesn’t look right.');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? Date.parse(b.date + 'T12:00:00Z') : NaN;
  if (!(day > now - 7 * 86400000 && day < now + 400 * 86400000)) throw bad('Trips can be up to a week in the past or about a year ahead.');
  if (!isStop(b.from) || !isStop(b.to) || b.to.at <= b.from.at) throw bad('A trip needs the stations where it starts and ends, in order, with their times.');
  if (!isStr(b.route, 100)) throw bad('A trip needs the train’s route name.');
  const stop = (s) => ({ code: s.code, name: s.name, at: Math.round(s.at), tz: s.tz });
  return { provider: b.provider, num: b.num, date: b.date, departAt: Math.round(b.from.at), data: { route: b.route, from: stop(b.from), to: stop(b.to) } };
}
const publicTrip = (t) => ({ id: t.id, provider: t.provider, num: t.num, date: t.date, route: t.data.route, from: t.data.from, to: t.data.to, createdAt: t.createdAt });

/* ---------------- password reset ---------------- */
const codeMail = (to, code) => ({
  to,
  subject: `${code} is your Trackside code`,
  text: `Your Trackside sign-up code is ${code}. It works for 15 minutes.\n\nIf you didn’t sign up, ignore this email.`,
  html: `<p>Your Trackside sign-up code is <b style="font-size:20px;letter-spacing:2px">${code}</b>. It works for 15 minutes.</p><p>If you didn’t sign up, ignore this email.</p>`,
});
const alreadyMail = (env, to) => ({
  to,
  subject: 'You already have a Trackside account',
  text: `Someone tried to sign up for Trackside with ${to}, which already has an account. Sign in at ${env.SITE_URL}, `
    + 'or reset your password there if you’ve forgotten it.\n\nIf that wasn’t you, ignore this email.',
  html: `<p>Someone tried to sign up for Trackside with <b>${escapeHtml(to)}</b>, which already has an account. `
    + `<a href="${escapeHtml(env.SITE_URL)}">Sign in</a>, or reset your password there if you’ve forgotten it.</p><p>If that wasn’t you, ignore this email.</p>`,
});

async function sendReset(store, mailer, env, user, now) {
  await store.deleteResetTokensForUser(user.id);   // only the newest link works
  const token = newToken();
  await store.createResetToken({ tokenHash: await tokenHash(token), userId: user.id, createdAt: now, expiresAt: now + RESET_MS });
  // the token rides in the URL fragment, which browsers never send to a server, so it stays out of web logs
  const link = String(env.SITE_URL).replace(/#.*$/, '') + '#reset=' + token;
  await mailer.send({
    to: user.email,
    subject: 'Reset your Trackside password',
    text: `Someone asked to reset the password for the Trackside account ${user.email}.\n\n`
      + `To choose a new password, open this link within 30 minutes:\n${link}\n\n`
      + 'If that wasn’t you, ignore this email. Your password stays the same.',
    html: `<p>Someone asked to reset the password for the Trackside account <b>${escapeHtml(user.email)}</b>.</p>`
      + `<p><a href="${escapeHtml(link)}">Choose a new password</a>. The link works once, for 30 minutes.</p>`
      + '<p>If that wasn’t you, ignore this email. Your password stays the same.</p>',
  });
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------------- routes ---------------- */
export const isAccountsPath = (p) => p.startsWith('/v1/auth/') || p === '/v1/me' || p.startsWith('/v1/me/') || p === '/v1/feedback';

export async function handleAccounts(req, env, ctx, url) {
  const store = storeFor(env);
  const noStore = { 'Cache-Control': 'no-store' };
  if (!store) return json({ error: { code: 'unavailable', message: "Accounts aren't set up on this server yet." } }, req, env, noStore, 503);
  const now = Date.now();
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'POST /v1/auth/signup') {
      const b = await body(req);
      const email = normEmail(b.email);
      checkEmail(email);
      // optional, so older copies of the app can still sign people up; they choose one later
      const username = b.username == null || b.username === '' ? null : normUsername(b.username);
      if (username) checkUsername(username);
      checkPassword(b.password);
      const human = await checkHuman(env, b.turnstileToken, ip);
      if (human === false) throw new ApiError(403, 'not_human', 'Couldn’t confirm you’re a person. Try again.');
      await limit(store, 'signup-ip:' + ip, human ? LIMITS.signupIpHuman : LIMITS.signupIp, now);
      await store.addAttempt('signup-ip:' + ip, now);
      const mailer = env.EMAIL_VERIFY !== 'off' && env.SITE_URL ? mailerFor(env) : null;
      if (mailer) {
        if (username && await store.getUserByUsername(username)) throw usernameTaken();   // usernames are public anyway
        await limit(store, 'signup-email:' + email, LIMITS.signupEmail, now);
        await store.addAttempt('signup-email:' + email, now);
        // the same work and the same answer whether or not there's an account, so the answer can't tell
        const passwordHash = await hashPassword(b.password, iterationsFor(env));
        const existing = await store.getUserByEmail(email);
        let mail;
        if (existing) mail = alreadyMail(env, email);
        else {
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
          await store.putPendingSignup({ email, username, passwordHash, codeHash: await tokenHash(email + ':' + code), createdAt: now, expiresAt: now + CODE_MS });
          mail = codeMail(email, code);
        }
        ctx.waitUntil(mailer.send(mail).catch((err) => console.error('sign-up email:', err && err.message)));
        return json({ pending: true }, req, env, noStore, 202);
      }
      const user = { id: crypto.randomUUID(), email, username, passwordHash: await hashPassword(b.password, iterationsFor(env)), createdAt: now };
      try { await store.createUser(user); } catch (err) {
        if (err instanceof StoreError && err.code === 'email_taken') throw new ApiError(409, 'email_taken', 'There’s already an account with that email. Sign in instead.');
        if (err instanceof StoreError && err.code === 'username_taken') throw usernameTaken();
        throw err;
      }
      housekeeping(store, ctx, now);
      return json(await startSession(store, user, now), req, env, noStore, 201);
    }
    if (route === 'POST /v1/auth/signup/confirm') {
      const b = await body(req);
      const email = normEmail(b.email);
      const code = String(b.code || '').replace(/\s/g, '');
      const wrong = new ApiError(400, 'bad_code', 'That code is wrong or expired.');
      await limit(store, 'confirm-ip:' + ip, LIMITS.confirmIp, now);
      const p = email && /^\d{6}$/.test(code) ? await store.getPendingSignup(email) : null;
      if (!p || p.expiresAt <= now || p.attempts >= CODE_TRIES) {
        if (p) await store.deletePendingSignup(email);
        await store.addAttempt('confirm-ip:' + ip, now);
        throw wrong;
      }
      if (await tokenHash(email + ':' + code) !== p.codeHash) {
        await Promise.all([store.addPendingAttempt(email), store.addAttempt('confirm-ip:' + ip, now)]);
        throw wrong;
      }
      await store.deletePendingSignup(email);
      const user = { id: crypto.randomUUID(), email, username: p.username, passwordHash: p.passwordHash, createdAt: now };
      try { await store.createUser(user); } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        if (err.code === 'email_taken') throw wrong;
        user.username = null;   // taken while the code was on its way: they choose another after signing in
        await store.createUser(user);
      }
      housekeeping(store, ctx, now);
      return json(await startSession(store, user, now), req, env, noStore, 201);
    }
    if (route === 'POST /v1/auth/login') {
      const b = await body(req);
      const email = normEmail(b.email);
      if (!email || typeof b.password !== 'string') throw new ApiError(400, 'missing', 'Enter your email and password.');
      await limit(store, 'login-email:' + email, LIMITS.loginEmail, now);
      await limit(store, 'login-ip:' + ip, LIMITS.loginIp, now);
      const user = await store.getUserByEmail(email);
      const ok = await verifyPassword(b.password.slice(0, PASSWORD_MAX), user ? user.passwordHash : DUMMY_HASH);
      if (!user || !ok) {
        await Promise.all([store.addAttempt('login-email:' + email, now), store.addAttempt('login-ip:' + ip, now)]);
        throw new ApiError(401, 'bad_login', 'That email and password don’t match an account.');
      }
      // hashes made with fewer iterations than today's setting are upgraded at sign-in
      if (Number(user.passwordHash.split('$')[1]) < iterationsFor(env)) ctx.waitUntil(hashPassword(b.password, iterationsFor(env)).then((h) => store.setPasswordHash(user.id, h)));
      housekeeping(store, ctx, now);
      return json(await startSession(store, user, now), req, env, noStore);
    }
    if (route === 'POST /v1/auth/reset') {
      const mailer = mailerFor(env);
      if (!mailer || !env.SITE_URL) throw new ApiError(503, 'unavailable', 'Password reset isn’t set up on this server yet.');
      const email = normEmail((await body(req)).email);
      checkEmail(email);
      await limit(store, 'reset-email:' + email, LIMITS.resetEmail, now);
      await limit(store, 'reset-ip:' + ip, LIMITS.resetIp, now);
      await Promise.all([store.addAttempt('reset-email:' + email, now), store.addAttempt('reset-ip:' + ip, now)]);
      const user = await store.getUserByEmail(email);
      // the same answer, as fast, whether or not there's an account: the email goes out after the response
      if (user) ctx.waitUntil(sendReset(store, mailer, env, user, now).catch((err) => console.error('reset email:', err && err.message)));
      return json({ ok: true }, req, env, noStore, 202);
    }
    if (route === 'POST /v1/auth/reset/confirm') {
      const b = await body(req);
      const expired = new ApiError(400, 'bad_token', 'This reset link has expired or was already used. Ask for a new one.');
      const r = typeof b.token === 'string' && b.token.length <= 100 ? await store.getResetToken(await tokenHash(b.token)) : null;
      if (!r || r.expiresAt <= now) throw expired;
      checkPassword(b.password);   // before using up the link, so a too-short password can be fixed and retried
      const user = await store.getUserById(r.userId);
      if (!user) throw expired;
      await store.deleteResetTokensForUser(user.id);
      await store.setPasswordHash(user.id, await hashPassword(b.password, iterationsFor(env)));
      await store.deleteSessionsForUser(user.id);
      return json(await startSession(store, user, now), req, env, noStore);
    }
    if (route === 'POST /v1/auth/logout') {
      const { tokenHash: th } = await signedIn(req, store, now);
      await store.deleteSession(th);
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }
    if (route === 'GET /v1/me') {
      const { user } = await signedIn(req, store, now);
      return json({ user: publicUser(user) }, req, env, noStore);
    }
    if (route === 'POST /v1/me/password') {
      const { user } = await signedIn(req, store, now);
      const b = await body(req);
      await limit(store, 'login-email:' + user.email, LIMITS.loginEmail, now);
      if (!(await verifyPassword(String(b.password || '').slice(0, PASSWORD_MAX), user.passwordHash))) {
        await store.addAttempt('login-email:' + user.email, now);
        throw new ApiError(403, 'bad_password', 'Your current password isn’t right.');
      }
      checkPassword(b.newPassword);
      await store.setPasswordHash(user.id, await hashPassword(b.newPassword, iterationsFor(env)));
      await store.deleteSessionsForUser(user.id);   // every device signs in again, including this one, which gets a fresh session
      return json(await startSession(store, user, now), req, env, noStore);
    }
    if (route === 'DELETE /v1/me') {
      const { user } = await signedIn(req, store, now);
      const b = await body(req);
      await limit(store, 'login-email:' + user.email, LIMITS.loginEmail, now);
      if (!(await verifyPassword(String(b.password || '').slice(0, PASSWORD_MAX), user.passwordHash))) {
        await store.addAttempt('login-email:' + user.email, now);
        throw new ApiError(403, 'bad_password', 'Your password isn’t right.');
      }
      await store.deleteUser(user.id);
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }
    if (route === 'GET /v1/me/data') {
      const { user } = await signedIn(req, store, now);
      return json({ data: await store.getData(user.id) }, req, env, noStore);
    }
    if (route === 'PUT /v1/me/data') {
      const { user } = await signedIn(req, store, now);
      const incoming = checkData((await body(req)).data, now);
      const current = await store.getData(user.id);
      const keys = new Set([...Object.keys(current), ...Object.keys(incoming)]);
      if (keys.size > DATA_MAX_KEYS) throw new ApiError(413, 'too_large', `An account can sync at most ${DATA_MAX_KEYS} kinds of data.`);
      await store.putData(user.id, incoming);
      return json({ data: await store.getData(user.id) }, req, env, noStore);
    }
    if (route === 'GET /v1/me/trips') {
      const { user } = await signedIn(req, store, now);
      return json({ trips: (await store.listTrips(user.id)).map(publicTrip) }, req, env, noStore);
    }
    if (route === 'POST /v1/me/trips') {
      const { user } = await signedIn(req, store, now);
      const t = checkTrip(await body(req), now);
      const all = await store.listTrips(user.id);
      const ahead = (x) => x.data.to.at + TRIP_DONE_MS > now;
      if (ahead(t) && all.filter(ahead).length >= TRIPS_MAX) throw new ApiError(409, 'too_many', `You can plan up to ${TRIPS_MAX} trips ahead. Remove some first.`);
      if (all.length >= TRIPS_KEPT) throw new ApiError(409, 'too_many', `You can keep up to ${TRIPS_KEPT} trips. Remove some old ones first.`);
      const trip = { id: crypto.randomUUID(), userId: user.id, ...t, createdAt: now };
      try { await store.addTrip(trip); } catch (err) {
        if (err instanceof StoreError && err.code === 'trip_exists') throw new ApiError(409, 'trip_exists', `Train ${t.num} on that day is already in your trips.`);
        throw err;
      }
      return json({ trip: publicTrip(trip) }, req, env, noStore, 201);
    }
    const del = req.method === 'DELETE' && /^\/v1\/me\/trips\/([\w-]{1,64})$/.exec(url.pathname);
    if (del) {
      const { user } = await signedIn(req, store, now);
      if (!(await store.deleteTrip(user.id, del[1]))) throw new ApiError(404, 'not_found', 'That trip isn’t in your account.');
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }
    if (route === 'PUT /v1/me/profile') {
      const { user } = await signedIn(req, store, now);
      const b = await body(req);
      const change = {};
      if (b.username !== undefined) {
        change.username = normUsername(b.username);
        checkUsername(change.username);
      }
      if (b.phone === null || b.phone === '') change.phone = null;
      else if (b.phone !== undefined) throw new ApiError(400, 'verify_phone', 'Verify the number with a code first.');
      try { await store.setProfile(user.id, change); } catch (err) {
        if (err instanceof StoreError && TAKEN[err.code]) throw TAKEN[err.code]();
        throw err;
      }
      return json({ user: publicUser(await store.getUserById(user.id)) }, req, env, noStore);
    }
    if (route === 'POST /v1/me/phone') {
      const { user } = await signedIn(req, store, now);
      const sms = verifierFor(env);
      const number = checkPhone((await body(req)).phone);
      const [owner] = await store.findByPhoneHashes([await phoneHash(number)]);
      if (owner && owner.id !== user.id) throw TAKEN.phone_taken();   // before paying for a text
      await limit(store, 'sms-user:' + user.id, LIMITS.smsAccount, now);
      if (!sms) {
        // no texting service (SMS_PROVIDER empty): the number is saved as entered, without proof it's theirs
        await store.addAttempt('sms-user:' + user.id, now);
        try { await store.setProfile(user.id, { phone: { number, hash: await phoneHash(number) } }); } catch (err) {
          if (err instanceof StoreError && TAKEN[err.code]) throw TAKEN[err.code]();
          throw err;
        }
        return json({ user: publicUser(await store.getUserById(user.id)) }, req, env, noStore);
      }
      await limit(store, 'sms-phone:' + number, LIMITS.smsNumber, now);
      await Promise.all([store.addAttempt('sms-user:' + user.id, now), store.addAttempt('sms-phone:' + number, now)]);
      await sms.start(number);
      return json({ ok: true }, req, env, noStore, 202);
    }
    if (route === 'POST /v1/me/phone/verify') {
      const { user } = await signedIn(req, store, now);
      const sms = verifierFor(env);
      if (!sms) throw new ApiError(503, 'unavailable', 'Phone numbers aren’t set up on this server yet.');
      const b = await body(req);
      const number = checkPhone(b.phone);
      const code = String(b.code || '').replace(/\s/g, '');
      if (!/^\d{4,10}$/.test(code)) throw new ApiError(400, 'bad_code', 'Enter the code from the text.');
      await limit(store, 'sms-check:' + user.id, LIMITS.smsCheck, now);
      if (!(await sms.check(number, code))) {
        await store.addAttempt('sms-check:' + user.id, now);
        throw new ApiError(400, 'bad_code', 'That code is wrong or expired.');
      }
      try { await store.setProfile(user.id, { phone: { number, hash: await phoneHash(number) } }); } catch (err) {
        if (err instanceof StoreError && TAKEN[err.code]) throw TAKEN[err.code]();
        throw err;
      }
      return json({ user: publicUser(await store.getUserById(user.id)) }, req, env, noStore);
    }
    if (route === 'GET /v1/me/friends') {
      const { user } = await signedIn(req, store, now);
      const out = { friends: [], incoming: [], outgoing: [] };
      for (const f of await store.listFriendships(user.id)) {
        if (f.status === 'accepted') out.friends.push({ username: f.otherUsername, at: f.acceptedAt });
        else (f.requesterId === user.id ? out.outgoing : out.incoming).push({ username: f.otherUsername, at: f.createdAt });
      }
      out.friends.sort((a, b) => a.username.localeCompare(b.username));
      return json(out, req, env, noStore);
    }
    if (route === 'POST /v1/me/friends') {
      const { user } = await signedIn(req, store, now);
      if (!user.username) throw new ApiError(409, 'no_username', 'Choose a username first, so your friends can tell who’s asking.');
      const b = await body(req);
      let them;
      if (b.phoneHash !== undefined) {
        if (typeof b.phoneHash !== 'string' || !HASH.test(b.phoneHash)) throw new ApiError(400, 'bad_phone', 'That phone number doesn’t look right.');
        await limit(store, 'phone-lookup:' + user.id, LIMITS.phoneLookup, now);
        await store.addAttempt('phone-lookup:' + user.id, now);
        [them] = await store.findByPhoneHashes([b.phoneHash]);
        if (!them) throw new ApiError(404, 'no_such_user', 'No one on Trackside has added that number yet. Try their username.');
      } else {
        const name = normUsername(b.username);
        them = USERNAME.test(name) ? await store.getUserByUsername(name) : null;
        if (!them) throw new ApiError(404, 'no_such_user', `No one on Trackside has the username @${name.slice(0, 20)}.`);
      }
      if (them.id === user.id) throw new ApiError(400, 'self', 'That’s you.');
      const answer = (status, code = 200) => json({ status, username: them.username }, req, env, noStore, code);
      const f = await store.getFriendship(user.id, them.id);
      if (f && f.status === 'accepted') return answer('accepted');
      if (f && f.requesterId === them.id) {   // they asked first: this accepts
        await store.acceptFriendRequest(them.id, user.id, now);
        return answer('accepted');
      }
      if (f) return answer('pending');
      if ((await store.listFriendships(user.id)).length >= FRIENDS_MAX) throw new ApiError(409, 'too_many', `You can have up to ${FRIENDS_MAX} friends and requests.`);
      await limit(store, 'friend-req:' + user.id, LIMITS.friendRequest, now);
      await store.addAttempt('friend-req:' + user.id, now);
      try { await store.addFriendRequest({ requesterId: user.id, addresseeId: them.id, createdAt: now }); } catch (err) {
        if (!(err instanceof StoreError && err.code === 'friendship_exists')) throw err;
      }
      return answer('pending', 201);
    }
    if (route === 'POST /v1/me/friends/match') {
      const { user } = await signedIn(req, store, now);
      const hashes = (await body(req, MATCH_MAX * 70 + 1024)).phoneHashes;
      if (!Array.isArray(hashes) || hashes.length > MATCH_MAX || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) {
        throw new ApiError(400, 'bad_request', `Send up to ${MATCH_MAX} phone hashes at a time.`);
      }
      await limit(store, 'phone-lookup:' + user.id, LIMITS.phoneLookup, now);
      await limit(store, 'contacts:' + user.id, LIMITS.contactsDaily, now);
      await Promise.all([store.addAttempt('phone-lookup:' + user.id, now), store.addAttempt('contacts:' + user.id, now)]);
      const found = (await store.findByPhoneHashes([...new Set(hashes)])).filter((m) => m.id !== user.id);
      const rel = new Map((await store.listFriendships(user.id)).map((f) => [f.otherId,
        f.status === 'accepted' ? 'friends' : f.requesterId === user.id ? 'requested' : 'incoming']));
      return json({ matches: found.map((m) => ({ phoneHash: m.phoneHash, username: m.username, status: rel.get(m.id) || null })) }, req, env, noStore);
    }
    if (route === 'GET /v1/me/friends/trips') {
      const { user } = await signedIn(req, store, now);
      const trips = (await store.listFriendTrips(user.id, now - FRIEND_TRIPS_BACK))
        .filter((t) => t.data.to.at + TRIP_DONE_MS > now)
        .slice(0, TRIPS_MAX)
        .map((t) => ({ ...publicTrip(t), username: t.username }));
      return json({ trips }, req, env, noStore);
    }
    if (route === 'POST /v1/feedback') {
      const b = await body(req);
      const kind = FEEDBACK_KINDS.includes(b.kind) ? b.kind : 'other';
      const message = typeof b.message === 'string' ? b.message.trim() : '';
      if (!message) throw new ApiError(400, 'bad_feedback', 'Write a message first.');
      if (message.length > FEEDBACK_MAX) throw new ApiError(400, 'bad_feedback', `Keep it under ${FEEDBACK_MAX} characters.`);
      const contact = b.contact == null || b.contact === '' ? null : normEmail(b.contact);
      if (contact) checkEmail(contact);
      // signed in is optional: a stale token still sends the message, just without the account
      const user = req.headers.get('Authorization') ? await signedIn(req, store, now).then((s) => s.user, () => null) : null;
      await limit(store, 'feedback-ip:' + ip, LIMITS.feedbackIp, now);
      await store.addAttempt('feedback-ip:' + ip, now);
      await store.addFeedback({ id: crypto.randomUUID(), userId: user ? user.id : null, kind, message, contact,
        page: typeof b.page === 'string' ? b.page.slice(0, 60) : null, createdAt: now });
      return new Response(null, { status: 201, headers: corsHeaders(req, env) });
    }
    const unfriend = req.method === 'DELETE' && /^\/v1\/me\/friends\/@?([A-Za-z0-9_]{1,20})$/.exec(url.pathname);
    if (unfriend) {
      const { user } = await signedIn(req, store, now);
      const them = await store.getUserByUsername(unfriend[1].toLowerCase());
      if (!them || !(await store.deleteFriendship(user.id, them.id))) throw new ApiError(404, 'not_found', `You and @${unfriend[1]} aren’t friends.`);
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }
    return json({ error: { code: 'not_found', message: 'Not found.' } }, req, env, noStore, 404);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, req, env, { ...noStore, ...err.headers }, err.status);
    console.error('accounts:', err && err.stack || err);
    return json({ error: { code: 'server_error', message: 'Something went wrong on our side. Try again in a moment.' } }, req, env, noStore, 500);
  }
}

/* Now and then, drop expired sessions and old attempt records, after the response has gone. */
function housekeeping(store, ctx, now) {
  if (Math.random() > 0.05) return;
  ctx.waitUntil(Promise.all([store.deleteSessionsBefore(now), store.deleteAttemptsBefore(now - 86400000), store.deleteResetTokensBefore(now), store.deletePendingSignupsBefore(now)]).catch(() => {}));
}
