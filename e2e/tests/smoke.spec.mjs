/* Smoke tests: the main things people do still work. Fixture data, no live feeds (see ../server.mjs). */
import { test, expect } from '@playwright/test';
import { openSite, openSheet, signUp } from './helpers.mjs';

test('live trains load into the summary and the list', async ({ page }) => {
  await openSite(page);
  await expect(page.locator('#sumText')).toContainText('trains running');
  expect(await page.locator('#list .row').count()).toBeGreaterThan(5);
});

test('a train opens with its stops, and Back returns', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#list .row').first().click();
  await expect(page.locator('#detail')).toBeVisible();
  expect(await page.locator('#detail .stops li').count()).toBeGreaterThan(1);
  await page.locator('#back').click();
  await expect(page.locator('#detail')).toBeHidden();
});

test('search finds a train by number', async ({ page }) => {
  await openSite(page);
  await page.locator('#q').fill('5');
  await expect(page.locator('#sugg')).toContainText('California Zephyr');
});

test('a first visit goes straight to the map, and signing up works from the account button', async ({ page }) => {
  await openSite(page);
  await expect(page.locator('#acct')).toBeHidden();   // no account prompt in the way
  await expect(page.locator('#list .row').first()).toBeVisible();
  await signUp(page);
  await expect(page.locator('#acctAvatar')).toBeVisible();
});

test('a running train can be added to your trips', async ({ page }) => {
  await openSite(page);
  await signUp(page);
  await openSheet(page);
  await page.locator('#list .row').first().click();
  await page.locator('#tripBtn').click();
  await page.locator('[data-pp-add]').click();
  await expect(page.locator('#tripBtn')).toHaveText('In your trips');
  await page.locator('#back').click();
  await page.locator('#tab-track').click();
  await expect(page.locator('#mtList .mt-card')).toHaveCount(1);
});

test('the Friends dialog opens for a signed-in rider', async ({ page }) => {
  await openSite(page);
  const name = await signUp(page);
  await page.locator('#friendsBtn').click();
  await expect(page.locator('#friends')).toBeVisible();
  await expect(page.locator('#frMe')).toHaveText('@' + name);
});

test('phones get the bottom sheet and the header buttons', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout only');
  await openSite(page);
  await expect(page.locator('#handle')).toBeVisible();
  await expect(page.locator('#friendsBtn')).toBeVisible();
  await expect(page.locator('#acctBtn')).toBeVisible();
  await expect(page.locator('#refresh')).toBeHidden();   // the map's Live badge refreshes instead
});
