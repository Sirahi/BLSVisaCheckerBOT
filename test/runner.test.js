const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../runner');
const { STATES } = require('../pageState');
const { createBudget } = require('../budget');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), 's.json');
const CFG = { MACHINE: { MAX_TRANSITIONS: 40, OSCILLATION_LIMIT: 6, PLAN: ['Normal', 'Premium'] } };

function harness(sequence, handlers) {
  let i = 0;
  return {
    driver: {},
    detect: async () => ({ state: sequence[Math.min(i++, sequence.length - 1)], reason: null, evidence: '' }),
    handlers,
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    cfg: CFG,
    log: () => {},
  };
}

test('the loop stops on a terminal outcome', async () => {
  const out = await run(harness([STATES.HOME, STATES.CAPTCHA, STATES.SLOTS], {
    [STATES.HOME]: async () => ({ terminal: false }),
    [STATES.CAPTCHA]: async () => ({ terminal: false }),
    [STATES.SLOTS]: async () => ({ terminal: true, result: 'SLOTS_FOUND' }),
  }));
  assert.strictEqual(out.result, 'SLOTS_FOUND');
  assert.strictEqual(out.transitions, 3);
});

test('oscillation aborts when a state repeats with no progress', async () => {
  const out = await run(harness([STATES.CAPTCHA], {
    [STATES.CAPTCHA]: async () => ({ terminal: false }), // never charges anything
  }));
  assert.strictEqual(out.result, 'OSCILLATING');
  assert.ok(out.transitions <= CFG.MACHINE.OSCILLATION_LIMIT + 1,
    `aborted after ${out.transitions} transitions`);
});

test('repeating a state is fine while a counter advances', async () => {
  let n = 0;
  const h = harness([STATES.CAPTCHA, STATES.CAPTCHA, STATES.CAPTCHA, STATES.SLOTS], {
    [STATES.CAPTCHA]: async (ctx) => { ctx.budget.charge('preForm'); n++; return { terminal: false }; },
    [STATES.SLOTS]: async () => ({ terminal: true, result: 'SLOTS_FOUND' }),
  });
  const out = await run(h);
  assert.strictEqual(out.result, 'SLOTS_FOUND');
  assert.strictEqual(n, 3);
});

test('the transition cap is a backstop', async () => {
  const cfg = { MACHINE: { MAX_TRANSITIONS: 5, OSCILLATION_LIMIT: 99, PLAN: ['Normal'] } };
  let n = 0;
  const h = harness([STATES.CAPTCHA], {
    [STATES.CAPTCHA]: async (ctx) => { n++; ctx.budget.charge('preForm'); return { terminal: false }; },
  });
  h.cfg = cfg;
  const out = await run(h);
  assert.strictEqual(out.result, 'TRANSITION_CAP');
  assert.strictEqual(out.transitions, 5);
});

test('a missing handler is reported, not thrown', async () => {
  const out = await run(harness([STATES.VISA_FORM], {}));
  assert.strictEqual(out.result, 'NO_HANDLER');
});
