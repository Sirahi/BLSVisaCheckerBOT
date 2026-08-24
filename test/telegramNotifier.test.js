const test = require('node:test');
const assert = require('node:assert');

// Stub axios BEFORE telegramNotifier loads. The suite must never touch the
// network, and what is under test is the message TEXT, not its delivery.
const posts = [];
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: { post: async (url, body) => { posts.push(body); return { data: { ok: true } }; } },
};

const { notifySlotPageReached } = require('../telegramNotifier');

// This is the "slot page is open, CHECK MANUALLY NOW" message. It wakes a
// human at 3am. Printing the whole CITIES list tells them to check a page
// without saying which appointment centre it belongs to - and the two centres
// are four hours apart.
test('the degraded slots alert names the city it is sending a human to', async () => {
  posts.length = 0;
  await notifySlotPageReached('Lahore/Premium: the calendar showed no open dates.', 'Lahore');
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0].text, /Lahore/);
  assert.doesNotMatch(posts[0].text, /Islamabad \+ Lahore/,
    'a list of every configured centre is not an instruction');
});

test('with no city supplied it still falls back to the configured centres', async () => {
  posts.length = 0;
  await notifySlotPageReached('something broke');
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0].text, /Islamabad/);
});
