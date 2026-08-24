const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBudget } = require('../budget');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5 };

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'searchlog-'));
  return { searchFile: path.join(d, 'count.json'), searchLog: path.join(d, 'nested', 'searches.jsonl') };
}

// The all-time total cannot answer "how many searches in the last N hours",
// which is the only form of the question that matters for pacing against the
// block. Every search therefore carries its own timestamp.
test('each search appends one timestamped JSON line', () => {
  const { searchFile, searchLog } = tmp();
  const b = createBudget({ limits: LIMITS, searchFile, searchLog });
  b.recordSearch({ category: 'Normal' });
  b.recordSearch({ category: 'Premium' });

  const lines = fs.readFileSync(searchLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((l) => l.n), [1, 2]);
  assert.deepStrictEqual(lines.map((l) => l.category), ['Normal', 'Premium']);
  assert.ok(!Number.isNaN(Date.parse(lines[0].at)));
});

test('the ledger survives a restart and keeps counting from the total', () => {
  const { searchFile, searchLog } = tmp();
  createBudget({ limits: LIMITS, searchFile, searchLog }).recordSearch();
  const b2 = createBudget({ limits: LIMITS, searchFile, searchLog });
  assert.strictEqual(b2.recordSearch(), 2);
  const lines = fs.readFileSync(searchLog, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
});

test('searchLog is optional - existing callers are unaffected', () => {
  const { searchFile } = tmp();
  const b = createBudget({ limits: LIMITS, searchFile });
  assert.strictEqual(b.recordSearch(), 1);
});

test('a broken ledger path never kills a run', () => {
  const { searchFile } = tmp();
  const b = createBudget({ limits: LIMITS, searchFile, searchLog: '\0bad' });
  assert.doesNotThrow(() => b.recordSearch());
  assert.strictEqual(b.searchesUsed, 1);
});
