/* One station listed by two railroads is one station across the site. */
import { test, expect } from '@playwright/test';
import { openSite, openSheet } from './helpers.mjs';

test('search finds Boston South by the MBTA\'s name, once', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#q').fill('South Station');
  const opts = page.locator('#sugg .sg-opt', { hasText: 'Boston' });
  await expect(opts.first()).toBeVisible();
  await expect(page.locator('#sugg .sg-opt', { hasText: /^South Station/ })).toHaveCount(0);
  await expect(opts.first()).toContainText('also MBTA');
});

test('Providence is one station, Amtrak\'s and the MBTA\'s', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#q').fill('Providence');
  // station rows only (not the Providence/Stoughton Line): one, saying both railroads
  const stationRows = page.locator('#sugg .sg-opt', { hasText: /^Providence\s*(PVD|MBTA)/ });
  await expect(stationRows).toHaveCount(1);
  await expect(stationRows).toContainText('PVD');
  await expect(stationRows).toContainText('also MBTA');
});

test('trains between stations include every railroad at a shared station', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-track').click();
  await page.locator('#fromSt').fill('Boston South');   // Amtrak's code; the MBTA train lists South Station
  await page.locator('#fromSugg .sg-opt').first().click();
  await expect(page.locator('#fromSt')).toHaveValue(/Boston South \(BOS\)/);
  await page.locator('#toSt').fill('New Bedford');
  await page.locator('#toSugg .sg-opt').first().click();
  await page.locator('#tripPast').check();
  await expect(page.locator('#tripResults .trip-row', { hasText: 'Fall River/New Bedford Line' })).toBeVisible();
});
