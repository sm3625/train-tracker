#!/usr/bin/env node
// Builds www/, the web content the iOS and Android apps ship: the site's index.html and data/, plus Capacitor's runtime.
//
//   npm run build        (npm run sync also copies www/ into ios/ and android/)
//
// The page is the website's own file, unchanged except for two scripts added ahead of its code:
//   - Capacitor's runtime (capacitor-runtime.js), which lets the page reach the native plugins (location, back button)
//   - the site's public address (TRACKSIDE_SITE_URL), for share links and for reading the current timetables.
//     It comes from SITE_URL in ../worker/wrangler.toml, so the site's address lives in one place.
// On the website neither exists, and the page behaves as before.
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const OUT = path.join(dir, 'www');

const toml = await readFile(path.join(root, 'worker', 'wrangler.toml'), 'utf8');
const site = (toml.match(/^SITE_URL\s*=\s*"([^"]+)"/m) || [])[1];
if (!site) { console.error('No SITE_URL in worker/wrangler.toml; the app needs the site\'s address.'); process.exit(1); }

let html = await readFile(path.join(root, 'index.html'), 'utf8');
const at = html.indexOf('<script');
if (at < 0) { console.error('index.html has no <script> to put the app\'s scripts ahead of.'); process.exit(1); }
const inject = `<script>window.TRACKSIDE_SITE_URL = ${JSON.stringify(site)};</script>\n<script src="capacitor-runtime.js"></script>\n`;
html = html.slice(0, at) + inject + html.slice(at);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'index.html'), html);
await cp(path.join(dir, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), path.join(OUT, 'capacitor-runtime.js'));
// a copy for when the app can't reach the site; the page prefers the site's, which is refreshed weekly
await cp(path.join(root, 'data'), path.join(OUT, 'data'), { recursive: true });
console.log(`Built ${path.relative(process.cwd(), OUT) || 'www'} for ${site}`);
