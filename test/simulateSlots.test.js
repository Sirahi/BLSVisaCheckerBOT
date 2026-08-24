const test = require('node:test');
const assert = require('node:assert');
const { createHandlers } = require('../handlers');
const { STATES } = require('../pageState');
const { createBudget } = require('../budget');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5, profile: 3 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sim-')), 's.json');

const ISB_N = { city: 'Islamabad', location: 'Islamabad', category: 'Normal', label: 'Islamabad/Normal' };
const ISB_P = { city: 'Islamabad', location: 'Islamabad', category: 'Premium', label: 'Islamabad/Premium' };

function build({ simulate }) {
  const calls = { submitted: 0, simulated: 0 };
  let simulatedItem = null;
  const h = createHandlers({
    solve: async () => ({ ok: true }),
    capture: async () => 'dir',
    clickDeadEndButton: async () => {},
    fillFormAndSubmit: async () => { calls.submitted += 1; },
    scanSlots: async () => null,
    clickBookNow: async () => {},
    fillEmail: async () => {},
    fillPasswordAndSolve: async () => ({ ok: true }),
    goHome: async () => {},
    goToMyAppointments: async () => {},
    simulateSlotsFound: (item) => { calls.simulated += 1; simulatedItem = item; return { stop() {}, sent: 1, total: 1, done: true }; },
  });
  const c = {
    driver: { sleep: async () => {} },
    detected: { state: STATES.VISA_FORM, reason: null, evidence: '4 dropdowns' },
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    state: { phase: 'preForm', plan: [ISB_N, ISB_P], results: {}, profileCity: 'Islamabad' },
    cfg: { MACHINE: { CATEGORIES: ['Normal', 'Premium'] }, SIMULATE: { SLOTS: simulate } },
    log: () => {},
  };
  return { h, c, calls, get simulatedItem() { return simulatedItem; } };
}

// The whole point of simulating at VISA_FORM rather than anywhere later is
// that it stops short of btnSubmit. If this ever regresses, testing the alert
// path would quietly start costing real searches against an unknown ceiling.
test('simulation submits no form and spends no search', async () => {
  const built = build({ simulate: true });
  const { h, c, calls } = built;
  const out = await h[STATES.VISA_FORM](c);

  assert.strictEqual(out.result, 'SLOTS_FOUND');
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(calls.submitted, 0, 'must not submit the form');
  assert.strictEqual(calls.simulated, 1);
  assert.strictEqual(built.simulatedItem.label, 'Islamabad/Normal', 'the plan ITEM reaches the simulator, not a bare string');
  assert.strictEqual(c.budget.searchesUsed, 0, 'must not spend a search');
  assert.strictEqual(c.budget.counters.postForm, 0, 'must not charge the postForm budget');
});

test('simulation hands the alert handle out so app.js can stop it', async () => {
  const { h, c } = build({ simulate: true });
  await h[STATES.VISA_FORM](c);
  assert.ok(c.state.alerts, 'alerts handle must reach state');
  assert.strictEqual(typeof c.state.alerts.stop, 'function');
});

test('with the flag off the real path runs and a search IS spent', async () => {
  const { h, c, calls } = build({ simulate: false });
  const out = await h[STATES.VISA_FORM](c);

  assert.strictEqual(out.terminal, false, 'real path continues to re-detect');
  assert.strictEqual(calls.submitted, 1);
  assert.strictEqual(c.budget.searchesUsed, 1);
  assert.strictEqual(c.state.phase, 'postForm');
});

// Absent config must behave as production, not as simulation - a missing key
// should never silently disable real searching.
test('a missing SIMULATE block behaves as production', async () => {
  const { h, c, calls } = build({ simulate: false });
  delete c.cfg.SIMULATE;
  await h[STATES.VISA_FORM](c);
  assert.strictEqual(calls.submitted, 1);
  assert.strictEqual(c.budget.searchesUsed, 1);
});

test('a simulated slot alert names the city it was found in', () => {
  const { fakeSlotDates } = require('../portalActions');
  const dates = fakeSlotDates({ city: 'Lahore', category: 'Premium', label: 'Lahore/Premium' });
  assert.ok(dates.length > 0);
  for (const d of dates) {
    assert.strictEqual(d.city, 'Lahore');
    assert.strictEqual(d.category, 'Premium');
  }
});
