/* Trip alerts in the app: the page as app/build.mjs ships it (Capacitor present, alerts.js loaded), with a fake
   LocalNotifications plugin that records what the page asks the phone to show. The rules themselves are tested in
   worker/test/alerts.test.js; this checks the page's side: asking, scheduling, opening and taking them back. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openSite, addRunningTrip } from './helpers.mjs';

const rules = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker', 'src', 'alerts.js'), 'utf8');
const names = [...rules.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const alertsScript = `window.TracksideAlerts = (() => { ${rules.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} }; })();`;

/* Capacitor as the app has it: every plugin answers, and LocalNotifications keeps a log. */
function fakeApp() {
  const log = { asked: 0, scheduled: [], cancelled: [], listeners: {} };
  window.__notes = log;
  const notes = {
    checkPermissions: async () => ({ display: log.asked ? 'granted' : 'prompt' }),
    requestPermissions: async () => { log.asked++; return { display: 'granted' }; },
    schedule: async ({ notifications }) => { log.scheduled.push(...notifications.map((n) => ({ ...n, at: n.schedule ? +new Date(n.schedule.at) : null }))); return { notifications }; },
    cancel: async ({ notifications }) => { log.cancelled.push(...notifications.map((n) => n.id)); },
    addListener: async (name, fn) => { log.listeners[name] = fn; return { remove() {} }; },
  };
  const other = new Proxy({}, { get: (_, k) => (k === 'addListener' ? async () => ({ remove() {} }) : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  window.capacitorExports = { registerPlugin: (name) => (name === 'LocalNotifications' ? notes : other) };
}

test('the first trip asks to send alerts, then hands the phone its reminders; tapping one opens the train', async ({ page }) => {
  await page.addInitScript(fakeApp);
  await page.addInitScript(alertsScript);
  await openSite(page);
  expect(await page.locator('#alertsRow').getAttribute('hidden')).toBeNull();   // shown in the app (Settings is closed)
  const num = await addRunningTrip(page);

  await expect.poll(() => page.evaluate(() => window.__notes.asked)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__notes.scheduled.some((n) => /^Arriving at .+ in 5 min$/.test(n.title)))).toBe(true);
  const notes = await page.evaluate(() => window.__notes.scheduled);
  const now = await page.evaluate(() => Date.now());
  const arriving = notes.find((n) => n.title.startsWith('Arriving at'));
  expect(arriving.at).toBeGreaterThan(now);
  expect(arriving.body).toContain(num);
  for (const n of notes) expect(Number.isInteger(n.id) && n.id > 0).toBe(true);

  // the next update hands over nothing new: the same reminder isn't set twice
  const before = notes.length;
  await page.locator('#refresh').dispatchEvent('click');   // the button is hidden on phones
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.__notes.scheduled)).filter((n) => n.id === arriving.id).length).toBe(1);
  expect((await page.evaluate(() => window.__notes.scheduled)).length).toBeLessThanOrEqual(before + 1);

  // tapping it opens the trip's train
  await page.evaluate((n) => window.__notes.listeners.localNotificationActionPerformed({ actionId: 'tap', notification: n }), arriving);
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail .d-num')).toHaveText(num);
});

test('turning alerts off in Settings takes back the reminders', async ({ page }) => {
  await page.addInitScript(fakeApp);
  await page.addInitScript(alertsScript);
  await openSite(page);
  await addRunningTrip(page);
  await expect.poll(() => page.evaluate(() => window.__notes.scheduled.filter((n) => n.at).length)).toBeGreaterThan(0);
  const timed = await page.evaluate(() => window.__notes.scheduled.filter((n) => n.at).map((n) => n.id));

  await page.locator('#settingsBtn').click();
  await expect(page.locator('#alertsToggle')).toBeChecked();
  await page.locator('#alertsRow').click();
  await expect(page.locator('#alertsToggle')).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.__notes.cancelled)).toEqual(expect.arrayContaining(timed));
});

test('on the website there is no alerts switch', async ({ page }) => {
  await openSite(page);
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#alertsRow')).toBeHidden();
});
