/* Home: the rider's current or next trip first (Phase 1 of docs/implementation-plan.md). */
import { test, expect } from '@playwright/test';
import { openSite, openSheet, signUp, addRunningTrip } from './helpers.mjs';

test('signed out, Home invites a sign-in and offers the map', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-home').click();
  await expect(page.locator('#homeHero')).toContainText('Find your train');
  await page.locator('[data-hero="explore"]').click();
  await expect(page.locator('#tab-explore')).toHaveAttribute('aria-selected', 'true');
});

test('signed out, Home shows recently viewed trains, kept on this device', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  const row = page.locator('#list .row').first();
  const id = await row.getAttribute('data-id');
  await row.click();
  await page.locator('#back').click();
  await page.locator('#tab-home').click();
  await expect(page.locator('#homeSaved')).toContainText('Recently viewed');
  await expect(page.locator(`#homeSaved [data-id="${id}"]`)).toBeVisible();
});

test('with no trips, Home offers to add a train', async ({ page }) => {
  await openSite(page);
  await signUp(page);
  await openSheet(page);
  await page.locator('#tab-home').click();
  await expect(page.locator('#homeHero')).toContainText('No trips coming up');
  await page.locator('[data-hero="plan"]').click();
  await expect(page.locator('#plan')).toBeVisible();
});

test('a running trip is the hero, live, with a way to track it', async ({ page }) => {
  await openSite(page);
  const num = await addRunningTrip(page);
  await page.locator('#tab-home').click();
  const hero = page.locator('#homeHero .hero');
  await expect(hero).toHaveClass(/is-live/);
  await expect(hero.locator('.hero-title')).toContainText(num);
  await expect(hero.locator('.hero-fresh')).toContainText('Reported');
  await hero.locator('[data-hero="track"]').click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail .d-num')).toHaveText(num);
});

test('with a trip under way, the app opens on Home', async ({ page }) => {
  await openSite(page);
  await addRunningTrip(page);
  await page.reload();
  await expect(page.locator('#tab-home')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#homeHero .hero')).toHaveClass(/is-live/);
});

test('without a connection, Home says it is showing the last update', async ({ page }) => {
  await openSite(page);
  await addRunningTrip(page);
  await page.locator('#tab-home').click();
  await page.route('https://api-v3.amtraker.com/v3/trains', (r) => r.abort());
  const refresh = page.locator((page.viewportSize().width < 560) ? '#mapLive' : '#refresh');
  await refresh.click();
  await expect(page.locator('#homeHero .hero-fresh')).toContainText('Offline. Last update');
});
