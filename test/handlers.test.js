const test = require('node:test');
const assert = require('node:assert');
const { createHandlers } = require('../handlers');
const { STATES, REASONS } = require('../pageState');
const { createBudget } = require('../budget');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h-')), 's.json');

function ctx(overrides = {}) {
  return {
    driver: { sleep: async () => {}, navigate: () => ({ refresh: async () => {} }) },
    detected: { state: STATES.CAPTCHA, reason: null, evidence: '' },
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    state: { phase: 'preForm', plan: ['Normal', 'Premium'], results: {} },
    cfg: { MACHINE: { PLAN: ['Normal', 'Premium'] } },
    log: () => {},
    ...overrides,
  };
}

test('NO_SLOTS records the result, shifts the plan, and resets traversal budgets', async () => {
  const clicked = [];
  const h = createHandlers({
    solve: async () => ({ ok: true }),
    capture: async () => 'dir',
    clickDeadEndButton: async () => { clicked.push('btn'); },
    fillFormAndSubmit: async () => {},
    scanSlots: async () => {},
    clickBookNow: async () => {},
    fillEmail: async () => {},
    fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots' } });
  c.budget.charge('postForm');
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(c.state.results.Normal, 'NO_SLOTS');
  assert.deepStrictEqual(c.state.plan, ['Premium']);
  assert.strictEqual(c.budget.counters.postForm, 0, 'next category gets a full allowance');
  assert.strictEqual(c.state.phase, 'preForm');
  assert.strictEqual(out.terminal, false);
  assert.deepStrictEqual(clicked, ['btn']);
});

test('NO_SLOTS on the last category is terminal', async () => {
  const h = createHandlers({
    solve: async () => ({ ok: true }), capture: async () => 'dir',
    clickDeadEndButton: async () => {}, fillFormAndSubmit: async () => {},
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'x' } });
  c.state.plan = ['Premium'];
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(out.result, 'NO_SLOTS');
});

test('CAPTCHA_INVALID charges the active phase and is terminal when exhausted', async () => {
  const h = createHandlers({
    solve: async () => ({ ok: true }), capture: async () => 'dir',
    clickDeadEndButton: async () => {}, fillFormAndSubmit: async () => {},
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.CAPTCHA_INVALID, evidence: 'invalid' } });
  assert.strictEqual((await h[STATES.DEAD_END](c)).terminal, false);
  assert.strictEqual((await h[STATES.DEAD_END](c)).terminal, false);
  assert.strictEqual((await h[STATES.DEAD_END](c)).terminal, false);
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(out.terminal, true, 'fourth attempt exceeds the 3-try budget');
});

test('UNKNOWN_REASON captures the page and stops immediately', async () => {
  let captured = null;
  const h = createHandlers({
    solve: async () => ({ ok: true }),
    capture: async (d, label) => { captured = label; return 'dir'; },
    clickDeadEndButton: async () => {}, fillFormAndSubmit: async () => {},
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.UNKNOWN_REASON, evidence: 'blocked!' } });
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(out.terminal, true);
  assert.match(captured, /UNKNOWN_REASON/);
});

test('VISA_FORM submits, records a search, and flips phase to postForm', async () => {
  let filled = null;
  const h = createHandlers({
    solve: async () => ({ ok: true }), capture: async () => 'dir',
    clickDeadEndButton: async () => {},
    fillFormAndSubmit: async (d, category) => { filled = category; },
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.VISA_FORM, reason: null, evidence: '' } });
  const out = await h[STATES.VISA_FORM](c);
  assert.strictEqual(filled, 'Normal');
  assert.strictEqual(c.state.phase, 'postForm');
  assert.strictEqual(c.budget.searchesUsed, 1);
  assert.strictEqual(out.terminal, false);
});

test('CAPTCHA charges the active phase', async () => {
  const h = createHandlers({
    solve: async () => ({ ok: true }), capture: async () => 'dir',
    clickDeadEndButton: async () => {}, fillFormAndSubmit: async () => {},
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx();
  await h[STATES.CAPTCHA](c);
  assert.strictEqual(c.budget.counters.preForm, 1);
  c.state.phase = 'postForm';
  await h[STATES.CAPTCHA](c);
  assert.strictEqual(c.budget.counters.postForm, 1);
});

test('SLOTS captures the page and is terminal', async () => {
  let captured = null;
  const h = createHandlers({
    solve: async () => ({ ok: true }),
    capture: async (d, label) => { captured = label; return 'dir'; },
    clickDeadEndButton: async () => {}, fillFormAndSubmit: async () => {},
    scanSlots: async () => {}, clickBookNow: async () => {},
    fillEmail: async () => {}, fillPasswordAndSolve: async () => ({ ok: true }),
  });
  const c = ctx({ detected: { state: STATES.SLOTS, reason: null, evidence: 'datepicker' } });
  const out = await h[STATES.SLOTS](c);
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(out.result, 'SLOTS_FOUND');
  assert.match(captured, /SLOTS/);
});
