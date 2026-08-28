const test = require('node:test');
const assert = require('node:assert');
const { waitForPageSettled } = require('../settle');

// ===========================================================================
// The spinner screenshot of 2026-08-28.
//
// The result shot for Karachi/Normal came back 13KB of white with a single
// loading dot in the middle; the Karachi/Premium shot from the same run came
// back 74KB of real page. Same code path, same cycle - so the fixed
// SLEEP.AFTER_SUBMIT of 2500ms is sometimes simply not long enough, and which
// one you get is a coin toss on how busy the portal is.
//
// The screenshot is the harmless victim. detect() runs immediately after
// fillFormAndSubmit returns, and a spinner page matches NO predicate - it
// would come back UNKNOWN, exit 20, which the scheduler reads as a BLOCK and
// answers with a 40-60 minute back-off. A slow page load must not be able to
// masquerade as a ban.
//
// So: wait for a condition, not for a duration.

// Scripts a sequence of page states, one per poll. Each entry is
// [readyState, visibleLoaders].
function fakeDriver(script) {
  const d = { polls: 0, slept: 0 };
  d.sleep = async (ms) => { d.slept += ms; };
  d.executeScript = async () => {
    const step = script[Math.min(d.polls, script.length - 1)];
    d.polls += 1;
    return { readyState: step[0], loaders: step[1] };
  };
  return d;
}

const READY = ['complete', 0];
const BUSY = ['complete', 1];
const LOADING = ['loading', 0];

test('a page that is already settled returns quickly', async () => {
  const d = fakeDriver([READY]);
  const ok = await waitForPageSettled(d, { timeout: 5000, quietMs: 300, pollMs: 100 });
  assert.strictEqual(ok, true);
});

test('it waits for the loader to disappear', async () => {
  const d = fakeDriver([BUSY, BUSY, BUSY, BUSY, READY]);
  const ok = await waitForPageSettled(d, { timeout: 5000, quietMs: 200, pollMs: 10 });
  assert.strictEqual(ok, true);
  assert.ok(d.polls >= 5, 'it must have kept polling while the loader was up');
});

test('a page still loading is not settled', async () => {
  const d = fakeDriver([LOADING, LOADING, READY]);
  const ok = await waitForPageSettled(d, { timeout: 5000, quietMs: 100, pollMs: 10 });
  assert.strictEqual(ok, true);
  assert.ok(d.polls >= 3);
});

// THE SUBTLE ONE, and the same mistake that cost four cycles on the modals:
// the overlay does not appear the instant the click returns. Sampling once, or
// accepting the very first "looks fine", reads the gap BEFORE the spinner
// arrives as though the page were done.
test('a quiet period is required, so the gap before the spinner is not mistaken for settled', async () => {
  // Looks ready, then the overlay actually shows up, then it really finishes.
  const d = fakeDriver([READY, BUSY, BUSY, READY, READY, READY, READY]);
  const ok = await waitForPageSettled(d, { timeout: 5000, quietMs: 250, pollMs: 100 });
  assert.strictEqual(ok, true);
  assert.ok(d.polls > 4,
    'accepting the first calm poll would have returned before the spinner even appeared');
});

// A wait that can hang is worse than a wait that is too short: it would stall
// the scheduler indefinitely on one cycle.
test('it gives up at the timeout and reports it, rather than hanging', async () => {
  const d = fakeDriver([BUSY]);
  const logged = [];
  const ok = await waitForPageSettled(d, { timeout: 300, quietMs: 100, pollMs: 50, log: (m) => logged.push(m) });
  assert.strictEqual(ok, false, 'a timeout reports false');
  assert.strictEqual(logged.length, 1, 'and says so, so a slow portal is visible in the log');
});

// The caller has just spent a real search. A probe that throws must not undo
// that - proceeding on an unsettled page is bad, crashing the cycle is worse.
test('a driver error is treated as not-settled, never thrown', async () => {
  const d = {
    sleep: async () => {},
    executeScript: async () => { throw new Error('javascript error: window is not defined'); },
  };
  const logged = [];
  const ok = await waitForPageSettled(d, { timeout: 200, quietMs: 50, pollMs: 50, log: (m) => logged.push(m) });
  assert.strictEqual(ok, false);
});
