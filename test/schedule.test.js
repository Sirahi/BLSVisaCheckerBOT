const test = require('node:test');
const assert = require('node:assert');
const { msUntilWorkStart } = require('../main');
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

