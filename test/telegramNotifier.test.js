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

// Asserted against the RESOLVED active city, not the literal "Islamabad": the
// fallback reads CFG.ACTIVE_CITIES, which ACTIVE_CITY in .env can change
// without touching a line of code. Hardcoding the name made this fail the
// moment the standing city moved to Karachi - a test of the config, not of the
// fallback.
test('with no city supplied it still falls back to the configured centres', async () => {
  const expected = require('../config').ACTIVE_CITIES.map((c) => c.name);
  posts.length = 0;
  await notifySlotPageReached('something broke');
  assert.strictEqual(posts.length, 1);
  for (const name of expected) {
    assert.match(posts[0].text, new RegExp(name), `the alert must name ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Telegram's legacy Markdown treats _ * ` [ as entity delimiters and offers NO
// backslash escape (verified against the live API: "\_" fails exactly as "_"
// does). So any runtime string interpolated into a *bold* or _italic_ span can
// desynchronise the parser and make Telegram reject the WHOLE message with
// HTTP 400 - it is not delivered garbled, it is not delivered at all.
//
// This is not hypothetical. On 2026-08-27 the scheduler halted and sent
// notifyBotError("...last was GUARD_ABORT, exit 30..."). The underscore in
// GUARD_ABORT closed the italic span early, the trailing "_" of the footer was
// then left unterminated, and Telegram answered:
//
//   400 can't parse entities: Can't find end of the entity starting at byte 204
//
// The one message whose entire job is to say "the bot has stopped" was the one
// message that never arrived.
const { notifyBotError, notifyFormError } = require('../telegramNotifier');

// Balanced-pair check for the four legacy-Markdown delimiters. Telegram itself
// is stricter than this, but an odd count is always a rejection.
function delimitersBalanced(text) {
  for (const ch of ['_', '*', '`']) {
    const n = text.split(ch).length - 1;
    if (n % 2 !== 0) return { ok: false, ch, n };
  }
  return { ok: true };
}

test('a halt reason containing an underscore does not break the message', async () => {
  posts.length = 0;
  await notifyBotError('Stopped after cycle 14: 3 consecutive failures (last was GUARD_ABORT, exit 30). Searches used all time: 137.');
  assert.strictEqual(posts.length, 1);
  const b = delimitersBalanced(posts[0].text);
  assert.ok(b.ok, `unbalanced "${b.ch}" (${b.n}) - Telegram rejects this with 400 and the halt is never announced`);
  assert.match(posts[0].text, /GUARD.ABORT/, 'the reason must still be readable');
});

test('markdown delimiters in a form-error step cannot break the message', async () => {
  posts.length = 0;
  await notifyFormError('Visa_Sub*Type`[');
  assert.strictEqual(posts.length, 1);
  assert.ok(delimitersBalanced(posts[0].text).ok);
});

// The highest-stakes message in the project: it exists to wake a human and
// send them to a page that may have open slots. It must survive whatever the
// city name and the error detail happen to contain.
test('the slot alert survives markdown delimiters in city and detail', async () => {
  posts.length = 0;
  await notifySlotPageReached('Karachi/Premium: date_picker not found *at all*', 'Kara_chi');
  assert.strictEqual(posts.length, 1);
  assert.ok(delimitersBalanced(posts[0].text).ok);
});
