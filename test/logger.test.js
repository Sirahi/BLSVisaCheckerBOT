const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger, format, sessionFile, hourIn, partsIn } = require('../logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-'));
}

// A fixed instant: 2026-08-24T00:56:07+01:00 (London) == 04:56:07 in Karachi.
const AT = new Date('2026-08-23T23:56:07.123Z');

test('format pads category and level into fixed columns', () => {
  const line = format('Nav', 'Log', 'hello', AT, 'Asia/Karachi');
  assert.match(line, /\[Nav {4}\] Log: {5}hello$/);
  const wide = format('Captcha', 'Display', 'hi', AT, 'Asia/Karachi');
  assert.match(wide, /\[Captcha\] Display: hi$/);
});

test('a category longer than the column is truncated, never wrapped', () => {
  const line = format('Scheduler', 'Log', 'x', AT, null);
  assert.match(line, /\[Schedul\]/);
});

test('timestamps render in the configured timezone, not the machine one', () => {
  const karachi = format('Nav', 'Log', 'x', AT, 'Asia/Karachi');
  const london = format('Nav', 'Log', 'x', AT, 'Europe/London');
  assert.match(karachi, /^\[2026\.08\.24-04\.56\.07:123\]/);
  assert.match(london, /^\[2026\.08\.24-00\.56\.07:123\]/);
});

test('hourIn reports the hour in the given zone', () => {
  assert.strictEqual(partsIn('Asia/Karachi', AT).h, 4);
  assert.strictEqual(partsIn('Europe/London', AT).h, 0);
  assert.strictEqual(typeof hourIn('Asia/Karachi'), 'number');
});

// The offset between the machine and the portal is NOT a constant: London is
// UTC+1 in summer and UTC+0 in winter while Karachi is UTC+5 all year. This is
// why the scheduler carries a timezone instead of a hardcoded "+4".
test('the machine-to-portal gap changes across DST', () => {
  const summer = new Date('2026-08-24T12:00:00Z');
  const winter = new Date('2026-12-24T12:00:00Z');
  const gap = (d) => partsIn('Asia/Karachi', d).h - partsIn('Europe/London', d).h;
  assert.strictEqual(gap(summer), 4);
  assert.strictEqual(gap(winter), 5);
});

test('the file receives levels the console filters out', () => {
  const dir = tmpDir();
  const l = createLogger({ dir, consoleLevel: 'Error', fileLevel: 'Verbose', tee: false });
  l.display('Nav', 'display-line');
  l.verbose('Nav', 'verbose-line');
  const body = fs.readFileSync(l.file, 'utf8');
  assert.match(body, /display-line/);
  assert.match(body, /verbose-line/);
});

test('fileLevel filters the file too', () => {
  const dir = tmpDir();
  const l = createLogger({ dir, consoleLevel: 'Error', fileLevel: 'Warning', tee: false });
  l.warning('Nav', 'kept');
  l.log('Nav', 'dropped');
  const body = fs.readFileSync(l.file, 'utf8');
  assert.match(body, /kept/);
  assert.doesNotMatch(body, /dropped/);
});

// Regression: an earlier version wrote Error via appendFileSync while
// everything else went through a buffered stream, so errors jumped ahead of
// the lines that explained them.
test('lines land in call order, errors included', () => {
  const dir = tmpDir();
  const l = createLogger({ dir, consoleLevel: 'Error', fileLevel: 'Verbose', tee: false });
  l.display('Nav', 'first');
  l.error('Nav', 'second');
  l.display('Nav', 'third');
  const lines = fs.readFileSync(l.file, 'utf8').trim().split('\n');
  assert.match(lines[0], /first/);
  assert.match(lines[1], /second/);
  assert.match(lines[2], /third/);
});

test('LOG_FILE makes a child append to the parent session file', () => {
  const dir = tmpDir();
  const parent = createLogger({ dir, tee: false });
  parent.display('Sched', 'from-parent');
  process.env.LOG_FILE = parent.file;
  try {
    const child = createLogger({ dir, tee: false });
    assert.strictEqual(child.file, parent.file);
    child.display('Nav', 'from-child');
  } finally {
    delete process.env.LOG_FILE;
  }
  const body = fs.readFileSync(parent.file, 'utf8');
  assert.match(body, /from-parent/);
  assert.match(body, /from-child/);
});

test('session filenames are timestamped and sort chronologically', () => {
  const a = path.basename(sessionFile('logs', new Date('2026-08-24T00:00:01Z'), 'UTC'));
  const b = path.basename(sessionFile('logs', new Date('2026-08-24T00:00:02Z'), 'UTC'));
  assert.match(a, /^\d{4}-\d{2}-\d{2}_\d{6}\.log$/);
  assert.ok(a < b, `${a} should sort before ${b}`);
});

test('logging never throws when the directory is unwritable', () => {
  const dir = tmpDir();
  const l = createLogger({ dir, tee: false });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => l.error('Nav', 'after the directory vanished'));
});
