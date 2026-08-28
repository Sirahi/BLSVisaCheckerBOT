const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveResultShot } = require('../shots');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));

// A driver that hands back a 1x1 PNG, and counts how often it was asked.
function fakeDriver({ fail = false } = {}) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64');
  const d = { shots: 0 };
  d.takeScreenshot = async () => {
    d.shots += 1;
    if (fail) throw new Error('session deleted');
    return png;
  };
  return d;
}

// ===========================================================================
// The point of these shots is to be GROUND TRUTH for what the portal returned
// after a search - specifically to rule out the bot reading a slots-available
// page as "no slots". So the shot is taken right after the submit click, in
// fillFormAndSubmit, NOT from a handler keyed on the detected state: hanging it
// off DEAD_END/NO_SLOTS would gate the evidence on the very classification it
// exists to audit, and a misread page would simply never be photographed.

test('a shot is written, named for the city and category', async () => {
  const dir = tmpDir();
  const file = await saveResultShot(fakeDriver(), { label: 'Karachi/Premium', dir, keep: 200 });
  assert.ok(file, 'a path is returned');
  assert.ok(fs.existsSync(file), 'the file is on disk');
  const name = path.basename(file);
  assert.match(name, /Karachi-Premium/, 'the label must survive into the filename');
  assert.match(name, /\.png$/);
  assert.doesNotMatch(name, /[/\:]/, 'a "/" in the label must not become a directory');
});

test('the filename sorts chronologically', async () => {
  const dir = tmpDir();
  const a = await saveResultShot(fakeDriver(), { label: 'Karachi/Normal', dir, keep: 200 });
  await new Promise((r) => setTimeout(r, 5));
  const b = await saveResultShot(fakeDriver(), { label: 'Karachi/Premium', dir, keep: 200 });
  assert.ok(path.basename(a) < path.basename(b),
    'an ISO stamp first means sorting by name is sorting by time');
});

// A 24-hour run is ~30 cycles x 2 searches = ~60 shots a day, forever. Without
// a cap that is unbounded growth in a directory nobody prunes by hand.
test('the directory is capped at keep, oldest deleted first', async () => {
  const dir = tmpDir();
  for (let i = 0; i < 8; i++) {
    await saveResultShot(fakeDriver(), { label: `Karachi/Run${i}`, dir, keep: 3 });
    await new Promise((r) => setTimeout(r, 3));
  }
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.strictEqual(left.length, 3, `expected 3 kept, got ${left.length}`);
  assert.match(left[2], /Run7/, 'the newest must survive');
  assert.match(left[0], /Run5/, 'the three newest are the ones kept');
});

test('files that are not shots are never pruned', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  for (let i = 0; i < 5; i++) {
    await saveResultShot(fakeDriver(), { label: `X/Y${i}`, dir, keep: 1 });
    await new Promise((r) => setTimeout(r, 3));
  }
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'only .png shots are pruned');
});

// This runs immediately after a real search has been spent. A screenshot that
// throws must never turn a completed search into a failed cycle.
test('a screenshot failure is swallowed, not thrown', async () => {
  const dir = tmpDir();
  const logged = [];
  const file = await saveResultShot(fakeDriver({ fail: true }), {
    label: 'Karachi/Normal', dir, keep: 200, log: (m) => logged.push(m),
  });
  assert.strictEqual(file, null);
  assert.strictEqual(logged.length, 1, 'the failure is reported, not silent');
});

test('an unwritable directory is survivable too', async () => {
  const file = await saveResultShot(fakeDriver(), {
    label: 'Karachi/Normal', dir: path.join(os.tmpdir(), 'shots-x', '\0bad'), keep: 200, log: () => {},
  });
  assert.strictEqual(file, null);
});

test('disabled by config means no screenshot is even requested', async () => {
  const dir = tmpDir();
  const d = fakeDriver();
  const file = await saveResultShot(d, { label: 'Karachi/Normal', dir, keep: 200, enabled: false });
  assert.strictEqual(file, null);
  assert.strictEqual(d.shots, 0, 'a disabled shot must not cost a round-trip to the browser');
});
