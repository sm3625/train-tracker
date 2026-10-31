/* How a railroad's feeds failing shows up in /v1/trains. The network is stubbed, so nothing leaves the machine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const realFetch = globalThis.fetch;
const status = async () => {
  const res = await worker.fetch(new Request('https://feeds.test/v1/trains'), { ALLOWED_ORIGINS: '' }, { waitUntil() {} });
  return JSON.parse(res.headers.get('X-Feed-Status'));
};

test('losing one of a railroad\'s two feeds costs that feed, and losing both is an error', async () => {
  globalThis.fetch = async (url) => (String(url).endsWith('/gtfs/Vehicle') ? new Response(new Uint8Array()) : new Response('', { status: 403 }));
  try {
    const s = await status();
    assert.equal(s.FrontRunner, 'stale: FrontRunner trips: HTTP 403');   // its vehicles still make trains
    assert.match(s.MARC, /^error: /);
  } finally { globalThis.fetch = realFetch; }
});
