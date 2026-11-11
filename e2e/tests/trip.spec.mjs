/* A saved trip that isn't running opens as a page of its own: times at the rider's two stops, typical delays, the stops
   between, and the route on the map. */
import { test, expect } from '@playwright/test';
import { openSite, openSheet, signUp, RECORDED_AT } from './helpers.mjs';

const H = 3600000;

test('a trip ahead opens with its times, typical delays and route; Back returns to Trips', async ({ page }) => {
  await openSite(page);
  await signUp(page);
  const at = RECORDED_AT.getTime() + 20 * H;
  await page.evaluate(async (trip) => {
    const { token } = JSON.parse(localStorage.getItem('trackside:session'));
    const r = await fetch('http://localhost:8787/v1/me/trips', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(trip) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }, { provider: 'Amtrak', num: '183', route: 'Northeast Regional', date: new Date(at - 5 * H).toISOString().slice(0, 10),
    from: { code: 'NYP', name: 'New York Penn', tz: 'America/New_York', at },
    to: { code: 'WAS', name: 'Washington Union', tz: 'America/New_York', at: at + 3.5 * H } });
  await page.reload();
  await openSheet(page);
  await page.locator('#tab-track').click();
  await page.locator('#mtList [data-trip]').first().click();

  const trip = page.locator('#trip');
  await expect(trip).toBeVisible();
  await expect(trip.locator('.tp-head h2')).toHaveText('New York Penn to Washington Union');
  await expect(trip.locator('.tp-status')).toContainText('Live tracking starts once it’s running');
  await expect(trip.locator('.tp-time')).toHaveCount(2);
  await expect(trip.locator('.tp-mid')).toContainText('3 h 30 min');
  // the test server has no recorded history
  await expect(trip.locator('.tp-card')).toContainText(/Not enough history yet|aren’t available/);
  await expect(trip.locator('.stops .stop').first()).toContainText('New York Penn');
  await expect(page.locator('#map')).toHaveClass(/passport-on/);
  await expect(page.locator('.passport-lines .line').first()).toBeAttached();
  expect(page.url()).toContain('#trip-');

  await trip.locator('#back').click();
  await expect(trip).toBeHidden();
  await expect(page.locator('#mtList [data-trip]')).toHaveCount(1);
  await expect(page.locator('.passport-lines .line')).toHaveCount(0);
});
