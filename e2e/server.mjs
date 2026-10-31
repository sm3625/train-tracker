#!/usr/bin/env node
/* The browser tests' server, with no live data:
     http://localhost:4173   the site: ../index.html pointed at the local worker, with the bot check off
     http://localhost:8787   the real worker (accounts, trips, friends) on a fresh in-memory database; its train and
                             station feeds answer from fixtures/ instead of the railroads
   Amtraker's API is answered from fixtures/ by the tests themselves (see helpers.mjs). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../worker/src/index.js';
import { SqlStore } from '../worker/src/store/sql.js';
import { sqliteClient } from '../worker/local/sqlite-client.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const fixture = (name) => readFile(path.join(dir, 'fixtures', name));

// The worker keeps the page's clock (see openSite in tests/helpers.mjs): held at when the fixtures were recorded, or
// trips on their trains are refused as over a week old once the recording is.
const realNow = Date.now, shift = Date.parse((await fixture('recorded-at.txt')).toString().trim()) - realNow();
Date.now = () => realNow() + shift;

// TURNSTILE: every sign-up passes the bot check, as a person's would, so the suite's many sign-ups get the
// higher per-address limit (worker/src/turnstile.js)
const env = { ALLOWED_ORIGINS: 'null', ALLOW_LOCALHOST: 'true', ACCOUNTS_STORE: new SqlStore(sqliteClient(':memory:')), PASSWORD_ITERATIONS: '1000',
  TURNSTILE: async () => true };
const FEEDS = { '/v1/trains': 'feeds-trains.json', '/v1/stations': 'feeds-stations.json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8787');
  if (req.method === 'GET' && FEEDS[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*', 'X-Feed-Status': '{}', 'Access-Control-Expose-Headers': 'X-Feed-Status' });
    res.end(await fixture(FEEDS[url.pathname]));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787);

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost:4173').pathname);
  try {
    if (p === '/' || p === '/index.html') {
      const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
        .replace(/^const FEEDS_WORKER = '[^']*';/m, "const FEEDS_WORKER = '';")
        .replace(/^const TURNSTILE_SITE_KEY = '[^']*';/m, "const TURNSTILE_SITE_KEY = '';");
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      res.end(html);
      return;
    }
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(path.join(root, 'data') + path.sep)) throw new Error('outside data/');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(4173, () => console.log('e2e server on http://localhost:4173'));
