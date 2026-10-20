#!/usr/bin/env node
// Runs the worker on http://localhost:8787 with plain Node, using the keys in ../.env, and serves the site itself there
// too (../index.html at /, ../data/ at /data/): open http://localhost:8787/ to try it all locally, without a Cloudflare
// account. (Opened straight from disk, the page can't read data/, so it plans trips with the published site's
// timetables instead.) Keys stay in this process.
// Accounts are kept in .accounts-dev.sqlite here (git-ignored), through the same store code D1 uses.
// Password-reset emails aren't sent: they're printed here, link and all.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from './src/index.js';
import { SECRET_KEYS } from './src/agencies.js';
import { SqlStore } from './src/store/sql.js';
import { sqliteClient } from './local/sqlite-client.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = {
  ALLOWED_ORIGINS: 'null',   // index.html opened as a file
  ALLOW_LOCALHOST: 'true',   // or served from http://localhost
  ACCOUNTS_STORE: new SqlStore(sqliteClient(path.join(dir, '.accounts-dev.sqlite'))),
  MAIL_PROVIDER: 'log',
  SMS_PROVIDER: 'log',   // phone codes are printed here, not texted
  SITE_URL: process.env.SITE_URL || 'http://localhost:8000/',   // where you serve index.html locally
};
try {
  for (const line of (await readFile(path.join(dir, '..', '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && SECRET_KEYS.includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
for (const k of SECRET_KEYS) if (process.env[k]) env[k] = process.env[k];

const port = Number(process.env.PORT) || 8787;
const root = path.join(dir, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
/* The site: index.html, and files under data/ only. */
async function site(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = p === '/' ? path.join(root, 'index.html') : path.normalize(path.join(root, p));
  if (file !== path.join(root, 'index.html') && !file.startsWith(path.join(root, 'data') + path.sep)) return false;
  try {
    let body = await readFile(file);
    // the page talks to this server, not the deployed worker (which only answers the published site), and skips
    // the bot check, which needs the published site's address
    if (p === '/') body = body.toString('utf8').replace(/^const FEEDS_WORKER = '[^']*';/m, "const FEEDS_WORKER = '';")
      .replace(/^const TURNSTILE_SITE_KEY = '[^']*';/m, "const TURNSTILE_SITE_KEY = '';");
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
  return true;
}
createServer(async (req, res) => {
  if (req.method === 'GET' && !req.url.startsWith('/v1/') && await site(req, res)) return;
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  await Promise.allSettled(pending);
}).listen(port, () => {
  console.log(`Trackside on http://localhost:${port}/ (feeds at /v1/trains)`);
  for (const k of SECRET_KEYS) if (!env[k]) console.log(`  (no ${k} in ../.env: that railroad will be empty)`);
});
