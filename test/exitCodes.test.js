const test = require('node:test');
const assert = require('node:assert');
const { EXIT, EXIT_FATAL } = require('../app');
const { classify } = require('../main');

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
  assert.deepStrictEqual(classify(EXIT.NO_SLOTS), { result: 'NO_SLOTS', halt: false, failure: false });
});

test('finding slots halts the loop and is not a failure', () => {
  const c = classify(EXIT.SLOTS_FOUND);
  assert.strictEqual(c.halt, true);
  assert.strictEqual(c.failure, false);
});

// UNKNOWN_REASON is the branch expected to catch the portal block. It must
// stop the loop: retrying would spend the search budget against a wall and
// bury the one capture that explains it.
test('an unrecognised terminal page halts rather than retrying', () => {
  assert.strictEqual(classify(EXIT.UNKNOWN_REASON).halt, true);
  assert.strictEqual(classify(EXIT.UNKNOWN_PAGE).halt, true);
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

