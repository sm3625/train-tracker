/* Planning a trip from the timetables. */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openSite, openSheet } from './helpers.mjs';

/* A day every named railroad's timetable covers. data/timetables.json is refreshed weekly, so no fixed date stays in it. */
const TT = JSON.parse(readFileSync(new URL('../../data/timetables.json', import.meta.url), 'utf8'));
function dayFor(...providers) {
  const first = providers.map((p) => TT.agencies.find((a) => a.provider === p).valid[0]).sort().pop();
  const n = first > TT.built.replace(/-/g, '') ? first : TT.built.replace(/-/g, '');
  const d = new Date(Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8) + 1));   // a day in, clear of the edges
  return d.toISOString().slice(0, 10);
}

async function openPlanner(page) {
  await openSheet(page);
  await page.locator('#tab-track').click();
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  await expect(page.locator('#plan')).toBeVisible();
}

test('the swap button trades From and To, and looks the trains up again', async ({ page }) => {
  await openSite(page);
  await openPlanner(page);
  await page.locator('#planFrom').fill('New York Penn (NYP) · Amtrak');
  await page.locator('#planTo').fill('Washington Union (WAS) · Amtrak');
  await page.locator('#planSwap').click();
  await expect(page.locator('#planFrom')).toHaveValue('Washington Union (WAS) · Amtrak');
  await expect(page.locator('#planTo')).toHaveValue('New York Penn (NYP) · Amtrak');
  await expect(page.locator('#planOut')).toBeEmpty();   // nothing searched yet, so nothing looked up

  await page.locator('#planForm').getByRole('button', { name: 'Find trains' }).click();
  await expect(page.locator('#planOut')).not.toBeEmpty();
  const before = await page.locator('#planOut').innerText();
  await page.locator('#planSwap').click();
  await expect(page.locator('#planOut')).not.toHaveText(before);   // searched again the other way
});

test('when the page\'s own timetables can\'t be read, it uses the published site\'s', async ({ page }) => {
  await page.route('**/localhost:4173/data/timetables.json', (r) => r.abort());
  const data = readFileSync(new URL('../../data/timetables.json', import.meta.url));
  await page.route('https://sm3625.github.io/train-tracker/data/timetables.json', (r) => r.fulfill({ body: data, contentType: 'application/json' }));
  await openSite(page);
  await openPlanner(page);
  await expect(page.locator('#planForm .acct-err')).toBeHidden();
  await page.locator('#planFrom').fill('Chicago');
  await expect(page.locator('#planFromSugg .sg-opt').first()).toBeVisible();
});

test('NJ Transit trains can be planned', async ({ page }) => {
  await openSite(page);
  await openPlanner(page);
  await page.locator('#planDate').fill(dayFor('NJ Transit'));
  await page.locator('#planFrom').fill('New York Penn Station · NJ Transit');
  await page.locator('#planTo').fill('Trenton Transit Center · NJ Transit');
  await page.locator('#planForm').getByRole('button', { name: 'Find trains' }).click();
  await expect(page.locator('.plan-res', { hasText: 'NJ Transit' }).first()).toBeVisible();
});

test('station suggestions come from every railroad, best match first', async ({ page }) => {
  await openSite(page);
  await openPlanner(page);
  await page.locator('#planFrom').fill('Penn');
  const opts = page.locator('#planFromSugg .sg-opt');
  await expect(opts.first()).toBeVisible();
  const text = (await opts.allInnerTexts()).join('\n');
  for (const railroad of ['Amtrak', 'LIRR', 'NJ Transit']) expect(text).toContain(railroad);
  await page.locator('#planFrom').fill('Secaucus');
  await opts.filter({ hasText: 'NJ Transit' }).first().click();
  await expect(page.locator('#planFrom')).toHaveValue(/^Secaucus .* · NJ Transit$/);
  await expect(page.locator('#planFromSugg')).toBeHidden();
});

test('one station listed by two railroads is one place, with both railroads\' trains', async ({ page }) => {
  await openSite(page);
  await openPlanner(page);
  await page.locator('#planDate').fill(dayFor('Amtrak', 'MBTA'));
  await page.locator('#planFrom').fill('South Station');   // the MBTA's name for Amtrak's Boston South
  const opt = page.locator('#planFromSugg .sg-opt').first();
  await expect(opt).toContainText('Boston South');
  await expect(opt).toContainText('Amtrak · MBTA');
  await opt.click();
  await page.locator('#planTo').fill('Providence');
  await page.locator('#planToSugg .sg-opt').first().click();
  await expect(page.locator('#planTo')).toHaveValue(/Amtrak, MBTA$/);
  await page.locator('#planForm').getByRole('button', { name: 'Find trains' }).click();
  await expect(page.locator('.plan-res', { hasText: 'Amtrak' }).first()).toBeVisible();
  await expect(page.locator('.plan-res', { hasText: 'MBTA' }).first()).toBeVisible();
});

test('stations merge from the timetables\' own positions, even without the live commuter station list', async ({ page }) => {
  await page.route('**/localhost:8787/v1/stations', (r) => r.abort());   // as when no feeds worker answers
  await openSite(page);
  await openPlanner(page);
  await page.locator('#planFrom').fill('South Station');
  await expect(page.locator('#planFromSugg .sg-opt').first()).toContainText('Amtrak · MBTA');
});
