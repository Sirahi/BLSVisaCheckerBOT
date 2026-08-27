const test = require('node:test');
const assert = require('node:assert');
const { EXIT, EXIT_FATAL } = require('../app');
const { classify, nextStreaks, blockWaitMinutes } = require('../main');
const S = require('../config').SCHEDULER;

// app.js decides the code; main.js decides what to do about it. Nothing links
// the two, so a value added on one side and missed on the other would fail
// silently - the scheduler would just treat a new outcome as a crash.
test('every code app.js can emit is classified by the scheduler', () => {
  for (const [result, code] of Object.entries(EXIT)) {
    const c = classify(code);
    assert.ok(c && c.result, `exit ${code} (${result}) is unclassified`);
  }
});

test('a clean no-slots cycle keeps the loop running', () => {
  assert.deepStrictEqual(
    classify(EXIT.NO_SLOTS),
    { result: 'NO_SLOTS', halt: false, failure: false, blocked: false },
  );
});

test('finding slots halts the loop and is not a failure', () => {
  const c = classify(EXIT.SLOTS_FOUND);
  assert.strictEqual(c.halt, true);
  assert.strictEqual(c.failure, false);
});

// UNKNOWN_REASON is the branch expected to catch the portal block. It used to
// halt the loop outright, which threw away the rest of the day: a block at
// 11am left the bot dead until a human noticed. Every cycle spawns a fresh
// browser and re-detects from whatever page it lands on, so there is nothing
// to recover - the next cycle simply starts again from LOGIN or HOME.
test('an unrecognised terminal page retries instead of halting the loop', () => {
  for (const code of [EXIT.UNKNOWN_REASON, EXIT.UNKNOWN_PAGE]) {
    assert.strictEqual(classify(code).halt, false, `exit ${code} should not halt`);
    assert.strictEqual(classify(code).blocked, true, `exit ${code} should be flagged blocked`);
  }
});

// A block carries its own counter. If it were classified as a failure it would
// eat MAX_CONSECUTIVE_FAILURES slots; if it were classified as a clean cycle it
// would RESET that streak, and an alternating crash/block pattern would then
// never trip the failure cap at all.
test('a block is neither a failure nor a clean cycle', () => {
  const c = classify(EXIT.UNKNOWN_REASON);
  assert.strictEqual(c.failure, false);
  assert.strictEqual(c.blocked, true);
  assert.strictEqual(classify(EXIT.NO_SLOTS).blocked, false);
  assert.strictEqual(classify(EXIT.OSCILLATING).blocked, false);
});

test('guard aborts and crashes are failures but do not halt immediately', () => {
  for (const code of [EXIT.OSCILLATING, EXIT.TRANSITION_CAP, EXIT.BUDGET_EXHAUSTED, EXIT_FATAL]) {
    const c = classify(code);
    assert.strictEqual(c.failure, true, `exit ${code} should count as a failure`);
    assert.strictEqual(c.halt, false, `exit ${code} should not halt on its own`);
  }
});

// Regression: app.js used to swallow fatals and exit 0, making a crash
// indistinguishable from a quiet cycle.
test('a crash is never classified as a clean cycle', () => {
  assert.notStrictEqual(classify(EXIT_FATAL).result, 'NO_SLOTS');
});

test('an unmapped code is treated as a crash, not as success', () => {
  const c = classify(99);
  assert.strictEqual(c.failure, true);
  assert.notStrictEqual(c.result, 'NO_SLOTS');
});

// Both codes were added by the whole-branch review. Neither is a crash: the
// run deliberately stopped itself, reported its results, and the next cycle
// retries. Mapping either to exit 1 would burn a MAX_CONSECUTIVE_FAILURES slot
// and make a routine self-limit look like a broken browser.
test('the run-level search ceiling is a tolerable transient, not a crash', () => {
  assert.strictEqual(EXIT.SEARCH_CEILING, 30);
  const c = classify(EXIT.SEARCH_CEILING);
  assert.strictEqual(c.halt, false);
  assert.notStrictEqual(c.result, 'CRASH');
});

test('a caught handler throw is a guard abort, not a crash', () => {
  assert.strictEqual(EXIT.HANDLER_ERROR, 30);
  assert.strictEqual(classify(EXIT.HANDLER_ERROR).result, 'GUARD_ABORT');
});

// ---- Streak bookkeeping ------------------------------------------------
//
// Two independent streaks. Extracted from loop() so the reset rule can be
// tested without spawning anything: loop() reads exit codes and sleeps, and
// neither is worth mocking to assert on arithmetic.

const FRESH = { failures: 0, blocks: 0 };

test('a clean cycle clears both streaks so the next block starts the backoff over', () => {
  const after = nextStreaks({ failures: 2, blocks: 3 }, classify(EXIT.NO_SLOTS));
  assert.deepStrictEqual(after, FRESH);
});

// The whole point of the reset: blocked, blocked, then in. The cycle after
// that must be paced by an ordinary random draw again, not by a multiplier
// still carrying the two blocks that are now over. Checked here through
// blockWaitMinutes rather than the draw itself: if the streak really is clear
// the loop takes the random branch, and a hypothetical block right after would
// start the ladder from the bottom again.
test('getting back in after a block streak restores the ordinary interval', () => {
  let streaks = FRESH;
  streaks = nextStreaks(streaks, classify(EXIT.UNKNOWN_REASON));
  streaks = nextStreaks(streaks, classify(EXIT.UNKNOWN_REASON));
  assert.strictEqual(streaks.blocks, 2);

  streaks = nextStreaks(streaks, classify(EXIT.NO_SLOTS));
  assert.strictEqual(streaks.blocks, 0);
  assert.strictEqual(blockWaitMinutes(S.INTERVAL_MAX_MINUTES, streaks.blocks + 1), S.INTERVAL_MAX_MINUTES);
});

test('a block advances the block streak and leaves the failure streak alone', () => {
  const after = nextStreaks({ failures: 2, blocks: 0 }, classify(EXIT.UNKNOWN_PAGE));
  assert.deepStrictEqual(after, { failures: 2, blocks: 1 });
});

test('a guard abort advances the failure streak and leaves the block streak alone', () => {
  const after = nextStreaks({ failures: 0, blocks: 2 }, classify(EXIT.OSCILLATING));
  assert.deepStrictEqual(after, { failures: 1, blocks: 2 });
});

// A CONFIRMED block, as opposed to a page the detector merely failed to
// recognise. The portal serves two of these ("Too Many Requests" from the
// origin, a CloudFront 403 from the edge) and both were landing as
// UNKNOWN_PAGE, which reported them in the log as "unrecognised - a human
// should look". They are separated from UNKNOWN so the log can state the
// difference, but they must still be paced by the SAME back-off: the response
// to a rate limit does not change just because we can now name it.
test('a confirmed block backs off exactly like an unrecognised one', () => {
  const c = classify(EXIT.BLOCKED);
  assert.strictEqual(c.blocked, true, 'a confirmed block must drive the back-off');
  assert.strictEqual(c.halt, false, 'a block is retried, not fatal');
  assert.strictEqual(c.failure, false, 'a block has its own counter');
});

test('a confirmed block is distinguishable from an unrecognised page', () => {
  assert.notStrictEqual(EXIT.BLOCKED, EXIT.UNKNOWN_PAGE,
    'sharing a code makes the two indistinguishable in the log');
  assert.notStrictEqual(classify(EXIT.BLOCKED).result, classify(EXIT.UNKNOWN_PAGE).result);
});
