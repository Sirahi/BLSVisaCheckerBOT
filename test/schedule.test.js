const test = require('node:test');
const assert = require('node:assert');
const { msUntilWorkStart, blockWaitMinutes, afterNightSleep } = require('../main');
const CFG = require('../config');

const S = CFG.SCHEDULER;
const MIN = 60 * 1000;

// The scheduler's night sleep once counted whole hours only, so 05:30 in
// Karachi was "3 hours to hour 8" and the loop woke at 08:30 - the first half
// hour of the morning burst lost every single night.
test('the night sleep ends at the top of the work hour, not an hour after the wake-up', () => {
  // 2026-08-24T00:30:11.164Z is 05:30:11.164 in Asia/Karachi.
  const wait = msUntilWorkStart(new Date('2026-08-24T00:30:11.164Z'));
  assert.strictEqual(wait, 2 * 60 * MIN + 29 * MIN + 48836);
});

test('a wake-up seconds before the work hour waits seconds, not an hour', () => {
  const wait = msUntilWorkStart(new Date('2026-08-24T02:59:59.000Z')); // 07:59:59 Karachi
  assert.strictEqual(wait, 1000);
});

test('exactly on the hour waits whole hours', () => {
  const wait = msUntilWorkStart(new Date('2026-08-23T20:00:00.000Z')); // 01:00:00 Karachi
  assert.strictEqual(wait, 7 * 60 * MIN);
});

test('after the work hour it waits round the clock to the next one', () => {
  const wait = msUntilWorkStart(new Date('2026-08-24T18:05:00.000Z')); // 23:05:00 Karachi
  assert.strictEqual(wait, 8 * 60 * MIN + 55 * MIN);
});

test('the wait never lands short of the work hour', () => {
  // Any instant in the closed night window must arrive exactly at hour 8:00.
  for (let m = 0; m < 60 * 8; m += 7) {
    const at = new Date(Date.UTC(2026, 7, 23, 19, 0, 0) + m * MIN);
    const arrival = new Date(at.getTime() + msUntilWorkStart(at));
    const karachiHour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: S.TIMEZONE, hour: '2-digit', hourCycle: 'h23',
    }).format(arrival));
    assert.strictEqual(karachiHour, S.WORK_START_HOUR, `from ${at.toISOString()}`);
  }
});

// ---- Block backoff -----------------------------------------------------
//
// A block used to stop the loop. It now retries, which raises the opposite
// risk: hammering an active block at the ordinary 20m cadence keeps re-tripping
// it. The wait therefore grows with each consecutive block.

test('the first block waits the ordinary interval for the time of day', () => {
  assert.strictEqual(blockWaitMinutes(S.MORNING_INTERVAL_MIN, 1), S.MORNING_INTERVAL_MIN);
  assert.strictEqual(blockWaitMinutes(S.AFTERNOON_INTERVAL_MIN, 1), S.AFTERNOON_INTERVAL_MIN);
});

test('each further consecutive block backs off by the multiplier', () => {
  const m = S.BLOCK_BACKOFF_MULTIPLIER;
  assert.strictEqual(blockWaitMinutes(20, 2), 20 * m);
  assert.strictEqual(blockWaitMinutes(20, 3), 20 * m * m);
});

// Doubling reaches the daily ceiling in four blocks and spends the whole
// afternoon asleep. The point is to ease off the portal, not to give up on it.
test('the backoff is gentle - it never doubles from one block to the next', () => {
  assert.ok(S.BLOCK_BACKOFF_MULTIPLIER > 1, 'a multiplier of 1 or less is not a backoff');
  assert.ok(S.BLOCK_BACKOFF_MULTIPLIER < 2, 'the multiplier must stay below 2x');
});

test('the backoff is capped so a block streak cannot sleep through the whole day', () => {
  assert.strictEqual(blockWaitMinutes(20, 99), S.BLOCK_BACKOFF_MAX_MIN);
  assert.ok(S.BLOCK_BACKOFF_MAX_MIN >= S.AFTERNOON_INTERVAL_MIN);
});

// Guards the streak cap itself: without one, a hard IP ban would have an
// unattended bot retrying until someone noticed.
test('a block streak has a cap that eventually stops the loop', () => {
  assert.ok(Number.isInteger(S.MAX_CONSECUTIVE_BLOCKS) && S.MAX_CONSECUTIVE_BLOCKS > 0);
});

// ---- The day boundary --------------------------------------------------
//
// The block streak used to survive the night sleep, so an evening spent
// blocked meant the next morning resumed mid-backoff - 120m waits through the
// most valuable window of the day instead of a fresh 20m burst.

test('the night sleep clears the block streak so the morning starts at the ordinary interval', () => {
  const after = afterNightSleep({ failures: 1, blocks: 7 });
  assert.strictEqual(after.blocks, 0);
  assert.strictEqual(
    blockWaitMinutes(S.MORNING_INTERVAL_MIN, after.blocks + 1),
    S.MORNING_INTERVAL_MIN,
  );
});

// A block is the portal rate-limiting the day's activity, and a night off is
// exactly the remedy. A crash streak is a broken setup - bad credentials, a
// dead chromedriver - and sleeping does not fix any of those.
test('the night sleep leaves the failure streak alone', () => {
  assert.strictEqual(afterNightSleep({ failures: 2, blocks: 3 }).failures, 2);
});
