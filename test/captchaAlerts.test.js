const test = require('node:test');
const assert = require('node:assert');
const { drainAlerts } = require('../captchaSolver');

// ===========================================================================
// "unexpected alert open" - the error that hid every real portal message.
//
// The portal answers a bad captcha with a JS alert. Under W3C WebDriver an
// open alert makes the NEXT command fail with UnexpectedAlertOpenError, and
// solveVisibleCaptcha used to call switchTo().defaultContent() BEFORE its
// alert-draining block. So the drain never ran: the failing command consumed
// the alert, its Selenium error became the reported reason, and the log of
// 2026-08-27 filled up with
//
//   Captcha attempt failed: unexpected alert open:
//     {Alert text : Please select correct number boxes} (Session info: chrome=151...)
//
// instead of the portal's own words. Worse, it made the RATE_LIMITED branch
// unreachable - the alert that identifies a rate limit was being eaten by the
// failing command rather than read by the code that looks for it.
//
// drainAlerts exists so the draining happens FIRST, before any other command.

// Serves `texts` one alert at a time, then behaves like a page with no alert
// (driver.wait rejects). Records the order of every call so the test can prove
// nothing else was issued while an alert was still open.
function fakeAlertDriver(texts) {
  const queue = [...texts];
  const calls = [];
  const driver = {
    calls,
    sleep: async () => {},
    wait: async () => {
      calls.push('wait');
      if (queue.length === 0) throw new Error('no such alert');
      return true;
    },
    switchTo: () => ({
      alert: async () => {
        calls.push('alert');
        const text = queue[0];
        return {
          getText: async () => text,
          accept: async () => { calls.push('accept'); queue.shift(); },
        };
      },
      defaultContent: async () => { calls.push('defaultContent'); },
    }),
  };
  return driver;
}

test('the portal message is read, not swallowed by the next command', async () => {
  const d = fakeAlertDriver(['Please select correct number boxes']);
  const text = await drainAlerts(d);
  assert.strictEqual(text, 'Please select correct number boxes');
  assert.ok(d.calls.includes('accept'), 'the alert must be accepted');
  assert.ok(
    d.calls.indexOf('accept') < d.calls.lastIndexOf('wait'),
    'draining must complete before anything else is attempted',
  );
});

// The rate-limit alert is the one worth telling apart from an ordinary
// rejection, and it was unreachable while the drain ran too late.
test('a rate-limit alert survives to be classified', async () => {
  const d = fakeAlertDriver(['You have reached maximum number of captcha request. Please try after sometime']);
  const text = await drainAlerts(d);
  assert.match(text, /maximum number of captcha request/i);
});

test('several queued alerts are all accepted', async () => {
  const d = fakeAlertDriver(['first', 'second', 'third']);
  const text = await drainAlerts(d);
  assert.strictEqual(text, 'third', 'the last one is the one that matters');
  assert.strictEqual(d.calls.filter((c) => c === 'accept').length, 3);
});

test('no alert at all is not an error', async () => {
  const d = fakeAlertDriver([]);
  assert.strictEqual(await drainAlerts(d), null);
});

// An alert that disappears between the wait and the read is an ordinary race,
// not a failure - drainAlerts must never throw into the solve path.
test('an alert that vanishes mid-read does not throw', async () => {
  const d = {
    sleep: async () => {},
    wait: async () => true,
    switchTo: () => ({ alert: async () => { throw new Error('no such alert'); } }),
  };
  assert.strictEqual(await drainAlerts(d), null);
});
