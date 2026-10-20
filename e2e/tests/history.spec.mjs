/* The browser's Back goes back a screen, the way the page's own Back does, and lands where the rider was. */
import { test, expect } from '@playwright/test';
import { openSite, openSheet } from './helpers.mjs';

test('browser Back from a train returns to the list, scrolled where it was', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  const rows = page.locator('#list .row');
  await rows.nth(12).scrollIntoViewIfNeeded();
  const before = await page.locator('#body').evaluate((b) => b.scrollTop);
  await rows.nth(12).click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#detail')).toBeHidden();
  await expect(page.locator('#list .row').first()).toBeVisible();
  expect(await page.locator('#body').evaluate((b) => b.scrollTop)).toBeCloseTo(before, -1);
  await expect(page).toHaveURL(/\/$/);   // still on Trackside
});

test('station, then train: browser Back steps back through both, keeping the board as it was', async ({ page }) => {
  await openSite(page);
  await page.evaluate(() => { location.hash = '#s-WAS'; });
  await expect(page.locator('#station h2')).toHaveText('Washington Union');
  await page.locator('#bt-dep').click();   // the departures board
  await page.locator('#station [data-id]').first().click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#station h2')).toHaveText('Washington Union');
  await expect(page.locator('#bt-dep')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.locator('#station')).toBeHidden();
});

test('the page\'s own Back still works, and leaves nothing behind for the browser\'s', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  await page.locator('#list .row').first().click();
  await page.locator('#back').click();
  await expect(page.locator('#detail')).toBeHidden();
  await page.locator('#list .row').nth(1).click();
  await page.goBack();
  await expect(page.locator('#detail')).toBeHidden();
});

test('with search suggestions open, Tab moves on and closes them (no Escape needed)', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#q').fill('Chicago');
  await expect(page.locator('#sugg')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#sugg')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe('q');
});

test('following a station link from a train opens the station, and Back returns to the train', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  await page.locator('#list .row').first().click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.evaluate(() => { location.hash = '#s-WAS'; });
  await expect(page.locator('#station h2')).toHaveText('Washington Union');
  await page.goBack();
  await expect(page.locator('#detail')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#detail')).toBeHidden();
});
