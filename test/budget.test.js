const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBudget } = require('../budget');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5 };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')), 'searches.json');
}

test('charge returns true until the limit, then false', () => {
  const b = createBudget({ limits: LIMITS, searchFile: tmpFile() });
  assert.strictEqual(b.charge('preForm'), true);
  assert.strictEqual(b.charge('preForm'), true);
  assert.strictEqual(b.charge('preForm'), true);
  assert.strictEqual(b.charge('preForm'), false);
  assert.strictEqual(b.exhausted, 'preForm');
});

test('phases are independent', () => {
  const b = createBudget({ limits: LIMITS, searchFile: tmpFile() });
  b.charge('preForm'); b.charge('preForm'); b.charge('preForm');
  assert.strictEqual(b.charge('login'), true);
  assert.strictEqual(b.counters.login, 1);
});

test('resetTraversal clears preForm and postForm but not login', () => {
  const b = createBudget({ limits: LIMITS, searchFile: tmpFile() });
  b.charge('login'); b.charge('preForm'); b.charge('postForm');
  b.resetTraversal();
  assert.strictEqual(b.counters.preForm, 0);
  assert.strictEqual(b.counters.postForm, 0);
  assert.strictEqual(b.counters.login, 1, 'login must survive - we do not log in again');
  assert.strictEqual(b.exhausted, null);
});

test('searches accumulate across budget instances via the file', () => {
  const f = tmpFile();
  const a = createBudget({ limits: LIMITS, searchFile: f });
  a.recordSearch();
  a.recordSearch();
  assert.strictEqual(a.searchesUsed, 2);
  const b = createBudget({ limits: LIMITS, searchFile: f });
  assert.strictEqual(b.searchesUsed, 2, 'must reload the running total');
  assert.strictEqual(b.recordSearch(), 3);
});

test('a missing or corrupt search file starts at zero without throwing', () => {
  const b = createBudget({ limits: LIMITS, searchFile: tmpFile() });
  assert.strictEqual(b.searchesUsed, 0);
  const f = tmpFile();
  fs.writeFileSync(f, 'not json at all');
  const c = createBudget({ limits: LIMITS, searchFile: f });
  assert.strictEqual(c.searchesUsed, 0);
});
