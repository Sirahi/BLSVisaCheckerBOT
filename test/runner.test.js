const test = require('node:test');
const assert = require('node:assert');
const { run, buildPlan } = require('../runner');
const { STATES } = require('../pageState');
const { createBudget } = require('../budget');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), 's.json');
const CFG = { ACTIVE_CITIES: [{ name: 'Islamabad', LOCATION: 'Islamabad' }], MACHINE: { MAX_TRANSITIONS: 40, OSCILLATION_LIMIT: 6, CATEGORIES: ['Normal', 'Premium'] } };

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
  const cfg = { ACTIVE_CITIES: [{ name: 'Islamabad', LOCATION: 'Islamabad' }], MACHINE: { MAX_TRANSITIONS: 5, OSCILLATION_LIMIT: 99, CATEGORIES: ['Normal'] } };
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

// MULTI_CITY explicit: these three assert the multi-city ordering, which is
// no longer what a default config does. config.js resolves CITIES ->
// ACTIVE_CITIES; buildPlan only ever sees the resolved list.
const PLAN_CFG = {
  MULTI_CITY: true,
  ACTIVE_CITIES: [
    { name: 'Islamabad', LOCATION: 'Islamabad' },
    { name: 'Lahore', LOCATION: 'Lahore' },
  ],
  MACHINE: { CATEGORIES: ['Normal', 'Premium'] },
  FORM: { VISA_SUB_TYPE: 'Family Reunification' },
};

test('the plan is city-major: both categories run before the city changes', () => {
  const plan = buildPlan(PLAN_CFG);
  assert.deepStrictEqual(plan.map((p) => p.label), [
    'Islamabad/Normal',
    'Islamabad/Premium',
    'Lahore/Normal',
    'Lahore/Premium',
  ]);
});

test('plan items carry the portal Location value, not just the display name', () => {
  const plan = buildPlan(PLAN_CFG);
  assert.deepStrictEqual(plan[0], {
    city: 'Islamabad',
    location: 'Islamabad',
    category: 'Normal',
    label: 'Islamabad/Normal',
    visaSubType: 'Family Reunification',
  });
});

// ---- Per-city visa sub type --------------------------------------------
//
// The Visa Sub Type dropdown is served per LOCATION, not globally: the portal
// loads it by AJAX once Location and Visa Type are set, and each centre
// publishes its own catalogue. Islamabad offers "Family Reunification Visa";
// Karachi offers only "National Visa" and "National Visas (Study, Work &
// Other National Visas)", so the global FORM value can never match there.
// Seen live 2026-08-27 - the run died at the sub type dropdown.

test('a city without an override inherits the global sub type', () => {
  const plan = buildPlan(PLAN_CFG);
  assert.strictEqual(plan[0].visaSubType, 'Family Reunification');
  assert.ok(plan.every((p) => p.visaSubType === 'Family Reunification'));
});

test('a city can override the sub type without disturbing the others', () => {
  const plan = buildPlan({
    ...PLAN_CFG,
    ACTIVE_CITIES: [
      { name: 'Islamabad', LOCATION: 'Islamabad' },
      { name: 'Karachi', LOCATION: 'Karachi', VISA_SUB_TYPE: 'National Visa' },
    ],
  });
  const sub = Object.fromEntries(plan.map((p) => [p.label, p.visaSubType]));
  assert.strictEqual(sub['Islamabad/Normal'], 'Family Reunification');
  assert.strictEqual(sub['Karachi/Normal'], 'National Visa');
  assert.strictEqual(sub['Karachi/Premium'], 'National Visa');
});

// The override is per city, so it must ride on the plan ITEM. Reading
// cfg.FORM at submit time would apply one city's sub type to every city in a
// MULTI_CITY run - the exact bug this replaces.
test('every plan item carries its own sub type', () => {
  const plan = buildPlan({
    ...PLAN_CFG,
    ACTIVE_CITIES: [{ name: 'Karachi', LOCATION: 'Karachi', VISA_SUB_TYPE: 'National Visa' }],
  });
  assert.ok(plan.length > 0);
  assert.ok(plan.every((p) => typeof p.visaSubType === 'string' && p.visaSubType));
});

test('city-major ordering means exactly one city boundary for two cities', () => {
  const plan = buildPlan(PLAN_CFG);
  let boundaries = 0;
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].city !== plan[i - 1].city) boundaries += 1;
  }
  assert.strictEqual(boundaries, 1, 'category-major ordering would give 3');
});

test('charging profile changes the oscillation fingerprint', async () => {
  const { createBudget } = require('../budget');
  const b = createBudget({
    limits: { login: 3, preForm: 3, postForm: 3, unavailable: 5, profile: 3 },
    searchFile: require('path').join(require('os').tmpdir(), `fp-${Date.now()}.json`),
  });
  // Drive the machine through two identical detections, charging profile between
  // them. The guard must NOT count that as a repeat.
  let calls = 0;
  const detect = async () => ({ state: 'PROFILE_LIST', reason: null, evidence: '' });
  const handlers = {
    PROFILE_LIST: async () => {
      calls += 1;
      if (calls <= 3) { b.charge('profile'); return { terminal: false }; }
      return { terminal: true, result: 'NO_SLOTS' };
    },
  };
  const out = await run({
    driver: {}, detect, handlers, budget: b,
    cfg: { ACTIVE_CITIES: [{ name: 'Islamabad', LOCATION: 'Islamabad' }], MACHINE: { CATEGORIES: ['Normal'], MAX_TRANSITIONS: 60, OSCILLATION_LIMIT: 6 } },
    log: () => {},
  });
  assert.strictEqual(out.result, 'NO_SLOTS', 'progress via the profile counter must not trip the oscillation guard');
});

// ---- F3: a mid-cycle throw must not escape run() --------------------------
//
// A throw from the profile subflow used to propagate out of run(), so app.js
// turned it into exit 1 and - worse - the results and the search count were
// never logged. An overnight operator could not tell which combos had already
// completed, and the next cycle rebuilt the plan from scratch and RE-SEARCHED
// the city this run had already paid for.
test('a handler throw becomes a terminal HANDLER_ERROR, not an escaped exception', async () => {
  const h = harness([STATES.PROFILE_CONFIRM], {
    [STATES.PROFILE_CONFIRM]: async () => { throw new Error('no confirmation alert'); },
  });
  const out = await run(h);
  assert.strictEqual(out.result, 'HANDLER_ERROR');
  assert.match(out.note, /no confirmation alert/);
});

test('the results and search count survive a handler throw', async () => {
  const h = harness([STATES.VISA_FORM, STATES.PROFILE_CONFIRM], {
    [STATES.VISA_FORM]: async (ctx) => {
      ctx.state.results['Islamabad/Normal'] = 'NO_SLOTS';
      ctx.budget.recordSearch({ city: 'Islamabad', category: 'Normal' });
      return { terminal: false };
    },
    [STATES.PROFILE_CONFIRM]: async () => { throw new Error('boom'); },
  });
  const out = await run(h);
  assert.deepStrictEqual(out.results, { 'Islamabad/Normal': 'NO_SLOTS' });
  assert.strictEqual(out.searchesUsed, 1, 'the finish path must still report what was spent');
});

test('a handler throw is logged, not silently converted', async () => {
  const lines = [];
  const h = harness([STATES.HOME], {
    [STATES.HOME]: async () => { throw new Error('iframe never appeared'); },
  });
  h.log = (m) => lines.push(m);
  await run(h);
  assert.ok(lines.some((l) => /iframe never appeared/.test(l)),
    `the throw was never logged: ${JSON.stringify(lines)}`);
});

// ---- F2: run() must seed the ceiling's reference points -------------------
test('run seeds searchesAtStart and planSize so VISA_FORM has a ceiling', async () => {
  let seen = null;
  const h = harness([STATES.HOME], {
    [STATES.HOME]: async (ctx) => { seen = { ...ctx.state }; return { terminal: true, result: 'NO_SLOTS' }; },
  });
  await run(h);
  assert.strictEqual(seen.planSize, 2, 'CFG has 1 city x 2 categories');
  assert.strictEqual(seen.searchesAtStart, 0);
});

test('searchesAtStart is the ledger total at run start, not zero', async () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ searchesUsed: 41 }));
  let seen = null;
  const h = harness([STATES.HOME], {
    [STATES.HOME]: async (ctx) => { seen = { ...ctx.state }; return { terminal: true, result: 'NO_SLOTS' }; },
  });
  h.budget = createBudget({ limits: LIMITS, searchFile: file });
  await run(h);
  assert.strictEqual(seen.searchesAtStart, 41);
});
