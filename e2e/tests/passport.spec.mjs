/* Passport: every trip in the account whose train has reached the rider's stop, added up and drawn on the map. */
import { test, expect } from '@playwright/test';
import { openSite, openSheet, signUp, RECORDED_AT } from './helpers.mjs';

const H = 3600000;
/* Straight to the worker: the trip planner only offers trains that haven't left yet. */
async function addTrips(page, trips) {
  await page.evaluate(async (trips) => {
    const { token } = JSON.parse(localStorage.getItem('trackside:session'));
    for (const t of trips) {
      const r = await fetch('http://localhost:8787/v1/me/trips', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(t) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }
  }, trips);
}
const trip = (num, route, from, to, at, hours) => ({ provider: 'Amtrak', num, route, date: new Date(at - 5 * H).toISOString().slice(0, 10),
  from: { ...from, at }, to: { ...to, at: at + hours * H } });
const CHI = { code: 'CHI', name: 'Chicago Union Station', tz: 'America/Chicago' }, DEN = { code: 'DEN', name: 'Denver', tz: 'America/Denver' };
const NYP = { code: 'NYP', name: 'New York Penn', tz: 'America/New_York' }, WAS = { code: 'WAS', name: 'Washington Union', tz: 'America/New_York' };

test('signed out, Passport invites a sign-in', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-passport').click();
  await expect(page.locator('#passport')).toContainText('Your passport');
  await expect(page.locator('[data-pp="signin"]')).toBeVisible();
});

test('trips taken add up; trips ahead wait until they happen', async ({ page }) => {
  await openSite(page);
  await signUp(page);
  const now = RECORDED_AT.getTime();
  await addTrips(page, [
    trip('5', 'California Zephyr', CHI, DEN, now - 43 * H, 18),   // overnight: leaves Chicago in the evening
    trip('171', 'Northeast Regional', NYP, WAS, now - 30 * H, 3.5),
    trip('175', 'Northeast Regional', NYP, WAS, now - 8 * H, 3.25),
    trip('183', 'Northeast Regional', NYP, WAS, now + 20 * H, 3.5),   // not yet
  ]);
  await page.reload();
  await openSheet(page);
  await page.locator('#tab-passport').click();
  const main = page.locator('.pp-main');
  await expect(main.locator('.pp-stats > div').first()).toContainText('3');
  await expect(main).toContainText('overnight');
  await expect(main).toContainText(/Distance\s*[\d,]+ mi/);
  await expect(main).toContainText('24h 45m');
  await expect(main).toContainText('in 4 states');   // IL, CO, NY and DC, as the station data has it
  await expect(page.locator('.pp-long')).toContainText('Chicago Union Station to Denver');
  await expect(page.locator('.pp-fav')).toContainText('Northeast Regional');
  await expect(page.locator('.pp-fav')).toContainText('2 trips');
  await expect(page.locator('.pp-row')).toHaveCount(3);
  await expect(page.locator('.passport-lines .line')).toHaveCount(3);
  await expect(page.locator('#map')).toHaveClass(/passport-on/);

  await page.locator('#tab-explore').click();   // the lines are only for the Passport tab
  await expect(page.locator('.passport-lines .line')).toHaveCount(0);
  await expect(page.locator('#map')).not.toHaveClass(/passport-on/);
});
