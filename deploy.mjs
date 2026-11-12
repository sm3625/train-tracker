#!/usr/bin/env node
// Uploads the site to GitHub through the GitHub REST API, so you don't need git installed.
//
//   node deploy.mjs                      upload with an automatic commit message
//   node deploy.mjs "Bigger station dots"   upload with your own commit message
//
// Reads GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH and DEPLOY_FILES from .env (git-ignored) or the
// environment. The token is only sent to api.github.com and is never printed or uploaded. Files that contain the
// token or any key in SECRET_KEYS below are refused.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SECRET_KEYS = ['METROLINK_API_KEY', 'CALTRAIN_511_KEY', 'METRA_API_KEY', 'NJT_PASSWORD', 'TURNSTILE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN', 'BREVO_API_KEY', 'RESEND_API_KEY', 'TURSO_AUTH_TOKEN'];

async function loadEnv() {
  const env = {};
  try {
    const text = await readFile(path.join(dir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env: fall back to the environment */ }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GITHUB_') || k === 'DEPLOY_FILES' || SECRET_KEYS.includes(k))) };
}

const env = await loadEnv();
const token = env.GITHUB_TOKEN;
const repo = env.GITHUB_REPO || 'sm3625/train-tracker';
const branch = env.GITHUB_BRANCH || 'main';
const files = (env.DEPLOY_FILES || 'index.html').split(',').map((f) => f.trim()).filter(Boolean);
const message = process.argv.slice(2).join(' ') || `Update Trackside (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`;

if (!token) {
  console.error('No GITHUB_TOKEN found. Put it in .env (see .env.example), then run this again.');
  process.exit(1);
}

async function api(route, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${route ? '/' + route : ''}`, {   // GitHub 404s a trailing slash
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trackside-deploy',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const check = await api('');
if (check.status === 401) { console.error('GitHub rejected the token (401). It may be mistyped, expired or revoked.'); process.exit(1); }
if (check.status !== 200) { console.error(`Can't reach ${repo} with this token (${check.status}). Give the token access to this repository.`); process.exit(1); }

// The feeds worker answers only the origins in its ALLOWED_ORIGINS. If the site's origin isn't one of them, the page
// loads without its commuter railroads and nothing on the page says why, so check before uploading.
const siteUrl = ((await readFile(path.join(dir, 'worker', 'wrangler.toml'), 'utf8')).match(/^SITE_URL\s*=\s*"([^"]+)"/m) || [])[1];
const pagesOrigin = siteUrl ? new URL(siteUrl).origin : 'https://trackside-pearl.vercel.app';
const feedsUrl = ((await readFile(path.join(dir, 'index.html'), 'utf8')).match(/const FEEDS_WORKER = '([^']+)'/) || [])[1];
if (feedsUrl) {
  const res = await fetch(feedsUrl + '/v1/stations', { headers: { Origin: pagesOrigin } });
  await res.body?.cancel();
  if (res.headers.get('access-control-allow-origin') !== pagesOrigin) {
    console.error(`The feeds worker (${feedsUrl}) doesn't allow ${pagesOrigin}, so the site would lose its commuter railroads.`);
    console.error('Add that origin to ALLOWED_ORIGINS in worker/wrangler.toml, then run: cd worker && npx wrangler deploy');
    process.exit(1);
  }
}

// git's blob hash, to skip files that haven't changed
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

let uploaded = 0;
for (const file of files) {
  if ((/^\.env($|\.)/.test(path.basename(file)) && file !== '.env.example') || /^\.dev\.vars/.test(path.basename(file))) { console.error(`Refusing to upload ${file}: it may contain secrets.`); process.exit(1); }
  const buf = await readFile(path.join(dir, file));
  if (buf.includes(token) || /\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/.test(buf.toString('utf8'))) {
    console.error(`Refusing to upload ${file}: it looks like it contains a GitHub token.`);
    process.exit(1);
  }
  const leaked = SECRET_KEYS.find((k) => env[k] && buf.includes(env[k]));
  if (leaked) {
    console.error(`Refusing to upload ${file}: it contains ${leaked}. Keys belong in the feeds worker's secrets, not the site.`);
    process.exit(1);
  }
  const route = `contents/${file.split('/').map(encodeURIComponent).join('/')}`;
  const cur = await api(`${route}?ref=${encodeURIComponent(branch)}`);
  const sha = cur.status === 200 ? cur.body.sha : undefined;
  if (sha && sha === blobSha(buf)) { console.log(`unchanged  ${file}`); continue; }
  const put = await api(route, { method: 'PUT', body: JSON.stringify({ message, branch, content: buf.toString('base64'), ...(sha ? { sha } : {}) }) });
  if (put.status !== 200 && put.status !== 201) {
    console.error(`Upload of ${file} failed (${put.status}): ${put.body.message || 'unknown error'}`);
    if (put.status === 403 || put.status === 404) console.error('The token needs "Contents: Read and write" permission on this repository.');
    process.exit(1);
  }
  uploaded++;
  console.log(`${sha ? 'updated   ' : 'added     '} ${file}`);
}
console.log(uploaded ? `Done. Vercel builds from the push and usually publishes within a minute: ${siteUrl || pagesOrigin}` : 'Nothing to upload; GitHub already has these versions.');
