/* Trip share links: https://<worker>/s/<token>.

   A rider shares one of their saved trips (POST /v1/me/trips/:id/share in accounts.js), and anyone with the link can
   see it: the website opens it from #share-<token>, reading GET /v1/shares/<token>.

   The link is on the worker's address, not the website's, so the worker can answer for it three ways:
   - a browser gets a small page with a preview (the card iMessage, WhatsApp and Slack show) that forwards to the
     website at SITE_URL#share-<token>;
   - with the iOS app installed, iOS opens the app instead (a universal link), once Apple has read
     /.well-known/apple-app-site-association here, which lists the app (APPLE_APP_IDS) and the /s/ paths;
   - on Android the same, through /.well-known/assetlinks.json (ANDROID_PACKAGE and ANDROID_CERT_SHA256).
   The app gets the link's address from Capacitor's appUrlOpen event and opens the trip itself (index.html,
   openShareFromUrl). Without those settings both files are 404s, and links always open in the browser. */

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
export const newShareToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/* The link for a token: on SHARE_URL when set (a custom domain, later), else on the address the request came to. */
export const shareUrl = (env, origin, token) => `${String(env.SHARE_URL || origin).replace(/\/+$/, '')}/s/${token}`;

/* What a share link shows: the trip as the page models it, and whose it is. null for an unknown token. */
export async function sharedTrip(store, token) {
  if (!TOKEN.test(token)) return null;
  const t = await store.getSharedTrip(token);
  if (!t) return null;
  const user = await store.getUserById(t.userId);
  return {
    trip: { provider: t.provider, num: t.num, date: t.date, route: t.data.route, from: t.data.from, to: t.data.to },
    username: (user && user.username) || null,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (at, tz) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at); }
  catch { return new Date(at).toUTCString(); }
};

/* GET /s/<token>: the preview and the hop to the website. */
export async function sharePage(store, env, token) {
  const site = String(env.SITE_URL || '').replace(/#.*$/, '');
  const s = store && (await sharedTrip(store, token));
  const to = site ? `${site}#share-${encodeURIComponent(token)}` : '';
  const title = s ? `${s.trip.provider} ${s.trip.num}: ${s.trip.from.name} to ${s.trip.to.name}` : 'Trackside';
  const desc = s
    ? `${s.username ? '@' + s.username + '’s' : 'A'} trip, leaving ${when(s.trip.from.at, s.trip.from.tz)}. Follow it live on Trackside.`
    : 'This trip link has expired or was removed.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Trackside">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta name="twitter:card" content="summary"><meta name="description" content="${esc(desc)}">
${to ? `<meta http-equiv="refresh" content="0; url=${esc(to)}"><link rel="canonical" href="${esc(to)}">` : ''}
<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:48px 20px;text-align:center;color:#1d1d1f;background:#f5f5f7}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#000}a{color:#4ea1ff}}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:#86868b}</style>
</head><body><h1>${esc(title)}</h1><p>${esc(desc)}</p>${to ? `<a href="${esc(to)}">Open in Trackside</a>
<script>location.replace(${JSON.stringify(to)})</script>` : ''}</body></html>`;
  return new Response(html, { status: s ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/* GET /.well-known/apple-app-site-association: which iOS apps open /s/ links. APPLE_APP_IDS: TEAMID.bundle.id, comma-separated. */
export function appleAssociation(env) {
  const ids = list(env.APPLE_APP_IDS);
  if (!ids.length) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify({ applinks: { details: [{ appIDs: ids, components: [{ '/': '/s/*', comment: 'trip share links' }] }] } }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}
/* GET /.well-known/assetlinks.json: the Android app that opens them. ANDROID_CERT_SHA256: the signing certificate's
   SHA-256 fingerprints (Play Console, App integrity), comma-separated. */
export function androidAssociation(env) {
  const prints = list(env.ANDROID_CERT_SHA256);
  if (!prints.length) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: env.ANDROID_PACKAGE || 'io.github.sm3625.trackside', sha256_cert_fingerprints: prints } }]),
  { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}
