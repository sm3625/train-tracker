/* Dead trains: a train is shown only while it's plausibly running, whatever its feed says (GONE_MIN in index.html;
   GONE_MS and GHOST_MS in worker/src/trains.js). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openSite, openSheet, RECORDED_AT } from './helpers.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const MIN = 60000;
/* A train as the feeds worker serves one it couldn't match to the timetable: a position, no stops, no times. */
const bare = (num, ago) => ({
  dataSource: 'trackside-feeds', provider: 'SEPTA', routeName: 'Chestnut Hill West Line', trainNum: num, trainNumRaw: num, trainID: num + '-SE',
  lat: 40.06, lon: -75.2, heading: '', velocity: 0, trainState: 'Active', origCode: '', origName: '', originTZ: 'America/New_York',
  destCode: '', destName: '', destTZ: 'America/New_York', lastValTS: new Date(RECORDED_AT.getTime() - ago).toISOString(), stations: [], alerts: [],
});
/* The feeds fixture, with these trains added to SEPTA's. */
async function withFeedTrains(page, extra) {
  const feeds = JSON.parse(readFileSync(path.join(fixtures, 'feeds-trains.json'), 'utf8'));
  feeds.SEPTA = feeds.SEPTA.concat(extra);
  await page.route('**/localhost:8787/v1/trains', (r) => r.fulfill({
    json: feeds, headers: { 'Access-Control-Allow-Origin': '*', 'X-Feed-Status': '{}', 'Access-Control-Expose-Headers': 'X-Feed-Status' },
  }));
}

test('a parked consist the feed still lists, and a bare position gone quiet, are left out; one reporting now stays', async ({ page }) => {
  // what SEPTA's feed served: cars, not a train, last reported a day and a half earlier
  await withFeedTrains(page, [bare('400,432,431,287', 34 * 60 * MIN), bare('2040', 25 * MIN), bare('9100', MIN)]);
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  await page.locator('#q').fill('9100');
  await expect(page.locator('#list [data-id="9100-SE"]')).toHaveCount(1);   // fresh: nothing ahead to tell, but it's there
  await page.locator('#q').fill('400,432');
  await expect(page.locator('#list [data-id="400,432,431,287-SE"]')).toHaveCount(0);
  await expect(page.locator('#sugg')).toContainText('No trains, routes or stations match');   // not in search either
  await page.locator('#q').fill('2040');
  await expect(page.locator('#list [data-id="2040-SE"]')).toHaveCount(0);
});

test('a train silent for hours is left out, whichever feed still lists it (Amtrak 59, eighteen hours on)', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#tab-explore').click();
  await page.locator('#q').fill('City of New Orleans');
  await expect(page.locator('#list [data-id="59-14"]')).toHaveCount(0);
  await expect(page.locator('#list [data-id="58-15"]')).toHaveCount(1);   // the other one, reporting, is still there
});
