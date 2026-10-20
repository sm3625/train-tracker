/* The deployed settings have to agree with each other. The site and the apps each run on their own origin, and the feeds
   worker answers only the origins it allows: one missing from ALLOWED_ORIGINS loses its commuter railroads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const toml = await readFile(path.join(dir, '..', 'wrangler.toml'), 'utf8');
const setting = (name) => (toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1];
const allowed = setting('ALLOWED_ORIGINS').split(',').map((s) => s.trim());

test('the site origin is among the worker\'s ALLOWED_ORIGINS', () => {
  const site = new URL(setting('SITE_URL')).origin;
  assert.ok(allowed.includes(site), `SITE_URL is ${site}, but ALLOWED_ORIGINS is ${allowed.join(', ')}`);
});

test('the iOS and Android apps\' origins are among the worker\'s ALLOWED_ORIGINS', async () => {
  // Capacitor's defaults, unless app/capacitor.config.json changes them
  const server = JSON.parse(await readFile(path.join(dir, '..', '..', 'app', 'capacitor.config.json'), 'utf8')).server || {};
  const host = server.hostname || 'localhost';
  for (const origin of [`${server.iosScheme || 'capacitor'}://${host}`, `${server.androidScheme || 'https'}://${host}`]) {
    assert.ok(allowed.includes(origin), `the app loads from ${origin}, but ALLOWED_ORIGINS is ${allowed.join(', ')}`);
  }
});

test('the page\'s PUBLIC_SITE is SITE_URL', async () => {
  // the page reads the published timetables from there when it can't read its own (opened from disk)
  const html = await readFile(path.join(dir, '..', '..', 'index.html'), 'utf8');
  const site = (html.match(/^const PUBLIC_SITE = '([^']*)';/m) || [])[1];
  assert.equal(site, setting('SITE_URL'));
});
