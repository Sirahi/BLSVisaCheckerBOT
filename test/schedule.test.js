const test = require('node:test');
const assert = require('node:assert');
const { blockWaitMinutes, nextIntervalMinutes } = require('../main');
const CFG = require('../config');
const { validateScheduler } = require('../config');

const S = CFG.SCHEDULER;

// ---- The randomised interval -------------------------------------------
//
// The bot used to check on a flat cadence - 20m before noon, 40m after - which
// is the one thing a human checking a visa portal never does. Nobody searches
// at 08:00, 08:20, 08:40 on the dot. Every gap is now drawn fresh from
// [INTERVAL_MIN_MINUTES, INTERVAL_MAX_MINUTES].
//
// `rand` is injected rather than stubbing Math.random globally: these assert on
// the real arithmetic, and a global stub leaks into whatever runs next.

test('a draw at the bottom of the range gives exactly the lower limit', () => {
  assert.strictEqual(nextIntervalMinutes(() => 0), S.INTERVAL_MIN_MINUTES);
});

test('a draw at the top of the range gives exactly the upper limit', () => {
  // Math.random() never actually returns 1, but the endpoint has to be exact
  // rather than one rounding step short of the limit.
  assert.strictEqual(nextIntervalMinutes(() => 1), S.INTERVAL_MAX_MINUTES);
});

test('a draw in the middle lands in the middle', () => {
  const mid = (S.INTERVAL_MIN_MINUTES + S.INTERVAL_MAX_MINUTES) / 2;
  assert.strictEqual(nextIntervalMinutes(() => 0.5), mid);
});

test('every draw lands inside the configured limits', () => {
  for (let i = 0; i < 2000; i += 1) {
    const v = nextIntervalMinutes();
    assert.ok(
      v >= S.INTERVAL_MIN_MINUTES && v <= S.INTERVAL_MAX_MINUTES,
      `${v} is outside [${S.INTERVAL_MIN_MINUTES}, ${S.INTERVAL_MAX_MINUTES}]`,
    );
  }
});

// Guards the whole point of the change: a constant sneaking back in - a
// forgotten `return S.INTERVAL_MIN_MINUTES`, a stubbed rand left behind -
// would pass every range check above and restore the robotic cadence.
test('successive draws differ - the interval is actually random', () => {
  const draws = new Set();
  for (let i = 0; i < 50; i += 1) draws.add(nextIntervalMinutes());
  assert.ok(draws.size > 1, 'every draw returned the same value');
});

// Whole-minute gaps are still a tell. Seconds resolution is the point; whole
// minutes are only ever hit by coincidence.
//
// Asserted over many real draws rather than one hand-picked `rand`: any single
// value can land on a whole minute for some choice of limits, and a test that
// breaks when the range is retuned is testing the config, not the code.
test('draws land on whole seconds, not whole minutes', () => {
  let fractional = 0;
  for (let i = 0; i < 200; i += 1) {
    const v = nextIntervalMinutes();
    // Compared with a tolerance, not ===: the value is minutes, so the seconds
    // it represents come back through a divide and a multiply and land a
    // float hair off the integer they mathematically are.
    const secs = v * 60;
    assert.ok(
      Math.abs(secs - Math.round(secs)) < 1e-6,
      `${v} minutes is ${secs}s - not a whole number of seconds`,
    );
    if (v % 1 !== 0) fractional += 1;
  }
  assert.ok(fractional > 0, 'every draw was a whole minute - the value is being rounded');
});

// ---- Config invariants -------------------------------------------------

test('the configured limits are the right way round and positive', () => {
  assert.doesNotThrow(() => validateScheduler(S));
});

test('a lower limit above the upper limit is refused, not silently swapped', () => {
  assert.throws(() => validateScheduler({ ...S, INTERVAL_MIN_MINUTES: 60, INTERVAL_MAX_MINUTES: 40 }),
    /INTERVAL_MIN_MINUTES/);
});

test('a zero or negative lower limit is refused', () => {
  assert.throws(() => validateScheduler({ ...S, INTERVAL_MIN_MINUTES: 0 }), /INTERVAL_MIN_MINUTES/);
});

// A ceiling BELOW the ordinary upper limit would make a "backoff" shorter than
// an ordinary wait - the first block would slow down to less than normal pace.
// Equal is fine, though: a ceiling of exactly the upper limit just means the
// backoff never grows. The check trips on strictly greater only.
test('an upper limit equal to the backoff ceiling is allowed', () => {
  assert.doesNotThrow(() => validateScheduler({
    ...S, INTERVAL_MAX_MINUTES: 120, BLOCK_BACKOFF_MAX_MIN: 120,
  }));
});

test('an upper limit above the backoff ceiling is refused', () => {
  assert.throws(() => validateScheduler({
    ...S, INTERVAL_MAX_MINUTES: 121, BLOCK_BACKOFF_MAX_MIN: 120,
  }), /BLOCK_BACKOFF_MAX_MIN/);
});

// ---- Block backoff -----------------------------------------------------
//
// A block used to stop the loop. It now retries, which raises the opposite
// risk: hammering an active block keeps re-tripping it. The wait therefore
// grows with each consecutive block.

// The randomness is there to look human while polling. A blocked bot is not
// polling, so the first backed-off wait is the slowest ORDINARY pace - the
// upper limit - rather than whatever the dice happened to give.
test('the first block waits the upper limit exactly, never a random draw', () => {
  assert.strictEqual(blockWaitMinutes(S.INTERVAL_MAX_MINUTES, 1), S.INTERVAL_MAX_MINUTES);
});

test('each further consecutive block backs off by the multiplier', () => {
  const m = S.BLOCK_BACKOFF_MULTIPLIER;
  assert.strictEqual(blockWaitMinutes(20, 2), 20 * m);
  assert.strictEqual(blockWaitMinutes(20, 3), 20 * m * m);
});

// Doubling reaches the ceiling in four blocks and spends the whole day asleep.
// The point is to ease off the portal, not to give up on it.
test('the backoff is gentle - it never doubles from one block to the next', () => {
  assert.ok(S.BLOCK_BACKOFF_MULTIPLIER > 1, 'a multiplier of 1 or less is not a backoff');
  assert.ok(S.BLOCK_BACKOFF_MULTIPLIER < 2, 'the multiplier must stay below 2x');
});

test('the backoff is capped so a block streak cannot sleep through the whole day', () => {
  assert.strictEqual(blockWaitMinutes(S.INTERVAL_MAX_MINUTES, 99), S.BLOCK_BACKOFF_MAX_MIN);
});

// The clamp trips on strictly greater than the ceiling. A wait that lands
// exactly on it is already legal and passes through untouched.
test('a wait of exactly the ceiling is not clamped', () => {
  const atCeiling = blockWaitMinutes(S.BLOCK_BACKOFF_MAX_MIN, 1);
  assert.strictEqual(atCeiling, S.BLOCK_BACKOFF_MAX_MIN);
});

// Guards the streak cap itself: without one, a hard IP ban would have an
// unattended bot retrying until someone noticed. With no night sleep to clear
// the streak, this is now the ONLY thing that stops a permanently blocked loop.
test('a block streak has a cap that eventually stops the loop', () => {
  assert.ok(Number.isInteger(S.MAX_CONSECUTIVE_BLOCKS) && S.MAX_CONSECUTIVE_BLOCKS > 0);
});

// The documented ladder, end to end: 40 -> 60 -> 90 -> ceiling.
test('the ladder climbs from the upper limit to the ceiling', () => {
  const base = S.INTERVAL_MAX_MINUTES;
  const m = S.BLOCK_BACKOFF_MULTIPLIER;
  const waits = [1, 2, 3, 4, 5].map((n) => blockWaitMinutes(base, n));
  assert.strictEqual(waits[0], base);
  assert.strictEqual(waits[1], base * m);
  assert.strictEqual(waits[2], base * m * m);
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(waits[i] >= waits[i - 1], 'the ladder must never go backwards');
    assert.ok(waits[i] <= S.BLOCK_BACKOFF_MAX_MIN, 'the ladder must never pass the ceiling');
  }
  assert.strictEqual(waits[4], S.BLOCK_BACKOFF_MAX_MIN);
});
