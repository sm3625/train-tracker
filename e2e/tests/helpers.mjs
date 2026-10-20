import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect } from '@playwright/test';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
/* The page's clock is held at the moment the fixtures were recorded, so their trains look live. */
export const RECORDED_AT = new Date(readFileSync(path.join(fixtures, 'recorded-at.txt'), 'utf8').trim());

/* Opens the site on fixture data. */
export async function openSite(page) {
  await page.clock.setFixedTime(RECORDED_AT);
  await page.route('https://api-v3.amtraker.com/v3/trains', (r) => r.fulfill({ path: path.join(fixtures, 'amtraker-trains.json'), contentType: 'application/json' }));
  await page.route('https://api-v3.amtraker.com/v3/stations', (r) => r.fulfill({ path: path.join(fixtures, 'amtraker-stations.json'), contentType: 'application/json' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());   // map tiles: not what's under test
  await page.goto('/');
  await expect(page.locator('#list .row').first()).toBeVisible();
}

const isPhone = (page) => page.viewportSize().width < 560;
/* On phones the list lives in a bottom sheet; pull it up so its contents can be used. */
export async function openSheet(page) {
  if (isPhone(page) && (await page.locator('#handle').getAttribute('aria-expanded')) !== 'true') await page.locator('#handle').click();
}

let n = 0;
export async function signUp(page) {
  const name = `rider${Date.now() % 1e7}${n++}`;
  if (await page.locator('#acct').isHidden()) await page.locator('#acctBtn').click();
  if (await page.locator('#acctUserRow').isHidden()) await page.locator('#acctSwitch').click();
  await page.locator('#acctUserIn').fill(name);
  await page.locator('#acctEmailIn').fill(`${name}@example.com`);
  await page.locator('#acctPwIn').fill('zephyr-to-emeryville');
  await page.locator('#acctSubmit').click();
  await page.locator('#promptSkip').click();   // the phone-number prompt
  await expect(page.locator('#acctBtn')).toHaveAttribute('data-signed-in', '');
  return name;
}

/* Signs up, then adds the first train in the list (a running one) to the new account's trips. */
export async function addRunningTrip(page) {
  await signUp(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  const row = page.locator('#list .row:not(:has(.stale))').first();   // a train with a recent report
  const num = (await row.getAttribute('data-id')).split('-')[0];
  await row.click();
  await page.locator('#tripBtn').click();
  await page.locator('[data-pp-add]').click();
  await expect(page.locator('#tripBtn')).toHaveText('In your trips');
  await page.locator('#back').click();
  return num;
}
