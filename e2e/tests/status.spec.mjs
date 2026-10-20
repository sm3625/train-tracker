/* Status the rider can trust: what the refresh time means, what the counts count, and which event a delay is about. */
import { test, expect } from '@playwright/test';
import { openSite, openSheet } from './helpers.mjs';

test('the header says when data was refreshed, not that every train is live', async ({ page }) => {
  await openSite(page);
  await expect(page.locator('#statusText')).toContainText('Data refreshed');
  await expect(page.locator('#statusText')).not.toContainText('Live');
});

test('the summary counts running trains apart from finished ones, with the on-time share\'s base', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await expect(page.locator('#sumText')).toContainText(/running · \d+% on time/);
  await expect(page.locator('#sumNote')).toContainText('with a current estimate');
});

test('a train standing at a station: the departure and the arrival each carry their own delay', async ({ page }) => {
  await openSite(page);
  await page.evaluate(() => { location.hash = '#t-11-14'; });   // Coast Starlight at Salinas: in 13 min late, out 17 min late
  const head = page.locator('#detail');
  await expect(head.locator('.d-next .lbl')).toHaveText('At station now');
  await expect(head.locator('.d-status .pill')).toHaveText('Departs 17 min late');
  await expect(head.locator('.d-eta')).toContainText('arrived 12:19 PM, 13 min late');
  await expect(head.locator('.d-status')).toContainText('departure scheduled 12:06 PM');
});

test('a train opened from a station board leads with that station', async ({ page }) => {
  await openSite(page);
  await page.evaluate(() => { location.hash = '#s-WAS'; });   // Washington Union's board
  await expect(page.locator('#station h2')).toHaveText('Washington Union');
  await page.locator('#station .row, #station [data-id]').first().click();
  const here = page.locator('#detail .d-here');
  await expect(here).toContainText('At your station: Washington Union');
  await expect(page.locator('#detail .stop.here')).toHaveCount(1);
});

test('a selected train\'s progress shows in its page; on desktop not again over the map', async ({ page }, info) => {
  await openSite(page);
  await page.evaluate(() => { location.hash = '#t-11-14'; });
  await expect(page.locator('#dProg .prog-track')).toBeVisible();
  if (info.project.name === 'desktop') await expect(page.locator('#progOverlay')).toBeHidden();
});
