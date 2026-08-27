const test = require('node:test');
const assert = require('node:assert');
const { createHandlers } = require('../handlers');
const { STATES, REASONS } = require('../pageState');
const { createBudget } = require('../budget');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5, profile: 3 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h-')), 's.json');

const ISB_N = { city: 'Islamabad', location: 'Islamabad', category: 'Normal', label: 'Islamabad/Normal' };
const ISB_P = { city: 'Islamabad', location: 'Islamabad', category: 'Premium', label: 'Islamabad/Premium' };
const LHE_N = { city: 'Lahore', location: 'Lahore', category: 'Normal', label: 'Lahore/Normal' };
const LHE_P = { city: 'Lahore', location: 'Lahore', category: 'Premium', label: 'Lahore/Premium' };

function ctx(overrides = {}) {
  return {
    driver: {
      sleep: async () => {},
      navigate: () => ({ refresh: async () => {} }),
      get: async () => {},
      switchTo: () => ({ frame: async () => {}, defaultContent: async () => {}, alert: async () => ({ accept: async () => {} }) }),
    },
    detected: { state: STATES.CAPTCHA, reason: null, evidence: '' },
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    // searchesAtStart / planSize are what runner.js seeds; the run-level
    // search ceiling is measured against them.
    state: { phase: 'preForm', plan: [ISB_N, ISB_P, LHE_N, LHE_P], results: {}, profileCity: null, searchesAtStart: 0, planSize: 4 },
    cfg: {
      CITIES: [{ name: 'Islamabad', LOCATION: 'Islamabad' }, { name: 'Lahore', LOCATION: 'Lahore' }],
      MACHINE: { CATEGORIES: ['Normal', 'Premium'] },
      MY_APPOINTMENTS_URL: 'https://example.test/Global/appointmentdata/MyAppointments',
      BASE_URL: 'https://example.test',
      BLS_HOME_URL: '/Global/home/index',
    },
    log: () => {},
    ...overrides,
  };
}

// Every dep createHandlers expects, all inert. Tests override the one they assert on.
function noopDeps() {
  return {
    solve: async () => ({ ok: true }),
    capture: async () => 'dir',
    clickDeadEndButton: async () => {},
    fillFormAndSubmit: async () => {},
    scanSlots: async () => null,
    simulateSlotsFound: () => null,
    clickBookNow: async () => {},
    fillEmail: async () => {},
    fillPasswordAndSolve: async () => ({ ok: true }),
    goHome: async () => {},
    goToMyAppointments: async () => {},
    openApplicantEdit: async () => {},
    setProfileCity: async () => {},
    submitProfileFrame: async () => {},
  };
}

test('NO_SLOTS records the result, shifts the plan, and resets traversal budgets', async () => {
  const clicked = [];
  const h = createHandlers({
    ...noopDeps(),
    clickDeadEndButton: async () => { clicked.push('btn'); },
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots' } });
  c.budget.charge('postForm');
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(c.state.results['Islamabad/Normal'], 'NO_SLOTS');
  assert.deepStrictEqual(c.state.plan.map((p) => p.label), ['Islamabad/Premium', 'Lahore/Normal', 'Lahore/Premium']);
  assert.strictEqual(c.budget.counters.postForm, 0, 'next category gets a full allowance');
  assert.strictEqual(c.state.phase, 'preForm');
  assert.strictEqual(out.terminal, false);
  assert.deepStrictEqual(clicked, ['btn']);
});

test('NO_SLOTS on the last category is terminal', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'x' } });
  c.state.plan = [LHE_P];
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(out.result, 'NO_SLOTS');
});

test('CAPTCHA_INVALID never ends the run on its own - the CAPTCHA charge bounds it', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.CAPTCHA_INVALID, evidence: 'invalid' } });
  // Four rejections back to back. None may terminate, and none may charge:
  // returning to the form is not itself a failed attempt, and billing it as one
  // is what halved the usable captcha budget.
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual((await h[STATES.DEAD_END](c)).terminal, false, `rejection ${i + 1} must not end the run`);
  }
  assert.strictEqual(c.budget.counters.preForm, 0, 'the rejection branch charges nothing');
});

test('UNKNOWN_REASON captures the page and stops immediately', async () => {
  let captured = null;
  const h = createHandlers({
    ...noopDeps(),
    capture: async (d, label) => { captured = label; return 'dir'; },
  });
  const c = ctx({ detected: { state: STATES.DEAD_END, reason: REASONS.UNKNOWN_REASON, evidence: 'blocked!' } });
  const out = await h[STATES.DEAD_END](c);
  assert.strictEqual(out.terminal, true);
  assert.match(captured, /UNKNOWN_REASON/);
});

test('VISA_FORM submits, records a search, and flips phase to postForm', async () => {
  let filled = null;
  const h = createHandlers({
    ...noopDeps(),
    fillFormAndSubmit: async (d, item) => { filled = item; },
  });
  const c = ctx({ detected: { state: STATES.VISA_FORM, reason: null, evidence: '' } });
  const out = await h[STATES.VISA_FORM](c);
  assert.strictEqual(filled.category, 'Normal');
  assert.strictEqual(filled.label, 'Islamabad/Normal');
  assert.strictEqual(c.state.phase, 'postForm');
  assert.strictEqual(c.budget.searchesUsed, 1);
  assert.strictEqual(out.terminal, false);
});

test('CAPTCHA charges the active phase', async () => {
  const h = createHandlers({ ...noopDeps() });
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
    ...noopDeps(),
    capture: async (d, label) => { captured = label; return 'dir'; },
  });
  const c = ctx({ detected: { state: STATES.SLOTS, reason: null, evidence: 'datepicker' } });
  const out = await h[STATES.SLOTS](c);
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(out.result, 'SLOTS_FOUND');
  assert.match(captured, /SLOTS/);
});

test('VISA_FORM submits the plan item city, not a config-wide city', async () => {
  let filled = null;
  const h = createHandlers({
    ...noopDeps(),
    fillFormAndSubmit: async (d, item) => { filled = item; },
  });
  const c = ctx();
  await h[STATES.VISA_FORM](c);
  assert.strictEqual(filled.location, 'Islamabad');
  assert.strictEqual(filled.category, 'Normal');
});

test('a search is recorded against its city and category', async () => {
  const logFile = tmp();
  const h = createHandlers({ ...noopDeps(), fillFormAndSubmit: async () => {} });
  const c = ctx({ budget: createBudget({ limits: LIMITS, searchFile: tmp(), searchLog: logFile }) });
  await h[STATES.VISA_FORM](c);
  const line = JSON.parse(require('fs').readFileSync(logFile, 'utf8').trim());
  assert.strictEqual(line.city, 'Islamabad');
  assert.strictEqual(line.category, 'Normal');
});

test('results are keyed by label so two cities do not collide', async () => {
  const h = createHandlers({ ...noopDeps(), clickDeadEndButton: async () => {} });
  const c = ctx();
  c.detected = { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots are available' };
  await h[STATES.DEAD_END](c);   // finishes Islamabad/Normal
  await h[STATES.DEAD_END](c);   // finishes Islamabad/Premium
  assert.deepStrictEqual(c.state.results, {
    'Islamabad/Normal': 'NO_SLOTS',
    'Islamabad/Premium': 'NO_SLOTS',
  });
});

test('HOME goes to Manage Applicants when the profile city is unknown', async () => {
  const went = [];
  const h = createHandlers({
    ...noopDeps(),
    goToMyAppointments: async () => { went.push('profile'); },
    clickBookNow: async () => { went.push('booknow'); },
  });
  const c = ctx();                     // profileCity === null
  await h[STATES.HOME](c);
  assert.deepStrictEqual(went, ['profile']);
});

test('HOME clicks Book Now once the profile already matches', async () => {
  const went = [];
  const h = createHandlers({
    ...noopDeps(),
    goToMyAppointments: async () => { went.push('profile'); },
    clickBookNow: async () => { went.push('booknow'); },
  });
  const c = ctx();
  c.state.profileCity = 'Islamabad';
  await h[STATES.HOME](c);
  assert.deepStrictEqual(went, ['booknow']);
});

test('a same-city advance uses the dead-end button and does NOT re-enter the profile', async () => {
  const went = [];
  const h = createHandlers({
    ...noopDeps(),
    clickDeadEndButton: async () => { went.push('deadend'); },
    goHome: async () => { went.push('home'); },
  });
  const c = ctx();
  c.state.profileCity = 'Islamabad';
  c.detected = { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots are available' };
  await h[STATES.DEAD_END](c);         // Islamabad/Normal -> Islamabad/Premium
  assert.deepStrictEqual(went, ['deadend']);
});

test('a cross-city advance returns home instead', async () => {
  const went = [];
  const h = createHandlers({
    ...noopDeps(),
    clickDeadEndButton: async () => { went.push('deadend'); },
    goHome: async () => { went.push('home'); },
  });
  const c = ctx();
  c.state.profileCity = 'Islamabad';
  c.state.plan = [ISB_P, LHE_N, LHE_P];
  c.detected = { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots are available' };
  await h[STATES.DEAD_END](c);         // Islamabad/Premium -> Lahore/Normal
  assert.deepStrictEqual(went, ['home']);
});

test('the profile city survives a same-city advance', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx();
  c.state.profileCity = 'Islamabad';
  c.detected = { state: STATES.DEAD_END, reason: REASONS.NO_SLOTS, evidence: 'no slots are available' };
  await h[STATES.DEAD_END](c);
  assert.strictEqual(c.state.profileCity, 'Islamabad');
});

test('PROFILE_CONFIRM records the city only AFTER the frame submit succeeds', async () => {
  const h = createHandlers({ ...noopDeps(), submitProfileFrame: async () => {} });
  const c = ctx();
  await h[STATES.PROFILE_CONFIRM](c);
  assert.strictEqual(c.state.profileCity, 'Islamabad');
});

test('a failed frame submit leaves the profile city unset so the next pass retries', async () => {
  const h = createHandlers({
    ...noopDeps(),
    submitProfileFrame: async () => { throw new Error('Submit button not found inside the frame'); },
  });
  const c = ctx();
  await assert.rejects(() => h[STATES.PROFILE_CONFIRM](c));
  assert.strictEqual(c.state.profileCity, null, 'a half-done subflow must never be recorded as done');
});

test('PROFILE_FORM sets the city named by the plan item', async () => {
  let asked = null;
  const h = createHandlers({ ...noopDeps(), setProfileCity: async (d, item) => { asked = item; } });
  const c = ctx();
  c.state.plan = [LHE_N, LHE_P];
  await h[STATES.PROFILE_FORM](c);
  assert.strictEqual(asked.location, 'Lahore');
});

test('the profile budget stops a subflow that keeps bouncing', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx();
  assert.strictEqual((await h[STATES.PROFILE_LIST](c)).terminal, false);
  assert.strictEqual((await h[STATES.PROFILE_LIST](c)).terminal, false);
  assert.strictEqual((await h[STATES.PROFILE_LIST](c)).terminal, false);
  const fourth = await h[STATES.PROFILE_LIST](c);
  assert.strictEqual(fourth.terminal, true);
  assert.strictEqual(fourth.result, 'BUDGET_EXHAUSTED');
});

test('PROFILE_CONFIRM returns home so HOME can re-route', async () => {
  const went = [];
  const h = createHandlers({ ...noopDeps(), goHome: async () => { went.push('home'); } });
  const c = ctx();
  await h[STATES.PROFILE_CONFIRM](c);
  assert.deepStrictEqual(went, ['home']);
});

// ---- F2: the per-run search ceiling ---------------------------------------
//
// postForm is limited to 3 and resetTraversal() gives every combo a fresh
// allowance, so the per-phase budget alone permits 3 x 4 = 12 real #btnSubmit
// clicks in a single run. The spec's rate table is built on FOUR. The account
// was blocked once after fewer than ten searches, so the overspend is the
// difference between 72 searches a day and 216.
test('the run-level ceiling caps a run at one search per plan item', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx({ detected: { state: STATES.VISA_FORM, reason: null, evidence: '' } });

  for (let i = 0; i < 4; i++) {
    const out = await h[STATES.VISA_FORM](c);
    assert.strictEqual(out.terminal, false, `search ${i + 1} of the plan must be allowed`);
    c.budget.resetTraversal();          // what a combo boundary does
  }
  assert.strictEqual(c.budget.searchesUsed, 4);

  const fifth = await h[STATES.VISA_FORM](c);
  assert.strictEqual(fifth.terminal, true);
  assert.strictEqual(fifth.result, 'SEARCH_CEILING');
  assert.strictEqual(c.budget.searchesUsed, 4, 'the refused search must not be spent');
});

test('the ceiling refuses BEFORE the form is filled, not after', async () => {
  let submits = 0;
  const h = createHandlers({ ...noopDeps(), fillFormAndSubmit: async () => { submits += 1; } });
  const c = ctx({ detected: { state: STATES.VISA_FORM, reason: null, evidence: '' } });
  c.state.planSize = 1;
  await h[STATES.VISA_FORM](c);
  c.budget.resetTraversal();
  const out = await h[STATES.VISA_FORM](c);
  assert.strictEqual(out.result, 'SEARCH_CEILING');
  assert.strictEqual(submits, 1, '#btnSubmit must never be reached once the ceiling trips');
  assert.strictEqual(c.budget.counters.postForm, 0, 'no budget charged for a refused search');
});

// searchesUsed is an ALL-TIME persisted total, so the ceiling has to be a
// delta. Measuring it absolutely would refuse every search forever after the
// first few dozen.
test('the ceiling is a per-run delta, not the all-time search total', async () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ searchesUsed: 57 }));
  const c = ctx({ budget: createBudget({ limits: LIMITS, searchFile: file }) });
  c.state.searchesAtStart = c.budget.searchesUsed;
  assert.strictEqual(c.state.searchesAtStart, 57, 'fixture must actually pre-seed the ledger');
  const h = createHandlers({ ...noopDeps() });
  const out = await h[STATES.VISA_FORM](c);
  assert.strictEqual(out.terminal, false, 'a fresh run must not start at its ceiling');
  assert.strictEqual(c.budget.searchesUsed, 58);
});

test('the ceiling logs why it refused', async () => {
  const lines = [];
  const h = createHandlers({ ...noopDeps() });
  const c = ctx({ log: (m) => lines.push(m) });
  c.state.planSize = 0;
  await h[STATES.VISA_FORM](c);
  assert.ok(lines.some((l) => /ceiling/i.test(l)), `no ceiling log line: ${JSON.stringify(lines)}`);
});

// A rejected captcha is ONE failure. It used to be charged twice - once in the
// CAPTCHA handler for the solve, then again here for the rejection - which made
// BUDGET.preForm mean half what it says: a limit of 3 bought ONE survived
// rejection, not three attempts. Seen live on 2026-08-24, where a completely
// fresh post-city-switch budget died on the second captcha.
test('a captcha rejection is charged once, so preForm:3 buys three solve attempts', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx();
  c.state.phase = 'preForm';
  let rejections = 0;
  for (let i = 0; i < 10; i++) {
    c.detected = { state: STATES.CAPTCHA, reason: null, evidence: '' };
    const solved = await h[STATES.CAPTCHA](c);
    if (solved.terminal) break;
    c.detected = { state: STATES.DEAD_END, reason: REASONS.CAPTCHA_INVALID, evidence: 'invalid' };
    const back = await h[STATES.DEAD_END](c);
    rejections += 1;
    assert.strictEqual(back.terminal, false, 'the rejection itself must not end the run');
  }
  assert.strictEqual(rejections, 3, 'three solve attempts, each rejected, before the budget stops it');
});

test('the rejection branch itself charges nothing', async () => {
  const h = createHandlers({ ...noopDeps() });
  const c = ctx();
  c.state.phase = 'preForm';
  c.detected = { state: STATES.DEAD_END, reason: REASONS.CAPTCHA_INVALID, evidence: 'invalid' };
  await h[STATES.DEAD_END](c);
  assert.strictEqual(c.budget.counters.preForm, 0, 'the solve that produced this was already charged');
});

// ===========================================================================
// The captcha 119 loop of 2026-08-27, cycle 3.
//
// The OCR read none of the nine tiles as the target, and the solver submitted
// an EMPTY selection anyway. The portal answered with an alert - "Please
// select correct number boxes" - and re-served the SAME challenge. That
// repeated eight times against the same target, 119, until the preForm budget
// was exhausted and the cycle was thrown away:
//
//   Captcha 119: 0/9 tiles, submitted     x8
//   Captcha attempt failed: unexpected alert open: {Alert text : Please select correct number boxes}
//   Budget exhausted for preForm - stopping.
//
// A zero-tile submission cannot succeed: the target is always drawn from the
// tiles on screen, so the right answer always has at least one. Submitting it
// buys nothing and costs a budget charge, an alert, and another go at the
// identical unreadable image. The only way out is a DIFFERENT challenge.
const { STATES: ST } = require('../pageState');

test('a captcha the solver could not read at all is not resubmitted', async () => {
  const refreshed = [];
  const c = ctx();
  c.driver.navigate = () => ({ refresh: async () => { refreshed.push('refresh'); } });
  const h = createHandlers({
    ...noopDeps(),
    solve: async () => ({ ok: false, reason: 'NO_TILES_MATCHED', clicked: 0 }),
  });
  const out = await h[ST.CAPTCHA](c);
  assert.strictEqual(out.terminal, false, 'the run continues - this is recoverable');
  assert.deepStrictEqual(refreshed, ['refresh'],
    'an unreadable challenge must be replaced, not re-attempted as-is');
});

// The ordinary rejection path must NOT start refreshing. A captcha that was
// submitted and refused is answered by the portal's own dead-end button, and
// that route is what keeps the traversal on rails.
test('an ordinary failed captcha attempt does not refresh the page', async () => {
  const refreshed = [];
  const c = ctx();
  c.driver.navigate = () => ({ refresh: async () => { refreshed.push('refresh'); } });
  const h = createHandlers({
    ...noopDeps(),
    solve: async () => ({ ok: false, reason: 'ALERT: something else', clicked: 3 }),
  });
  await h[ST.CAPTCHA](c);
  assert.deepStrictEqual(refreshed, [], 'only an unreadable challenge is refreshed');
});

test('the login captcha is refreshed on the same terms', async () => {
  const refreshed = [];
  const c = ctx({ state: { phase: 'login', plan: [ISB_N], results: {}, profileCity: null, searchesAtStart: 0, planSize: 1 } });
  c.driver.navigate = () => ({ refresh: async () => { refreshed.push('refresh'); } });
  const h = createHandlers({
    ...noopDeps(),
    fillPasswordAndSolve: async () => ({ ok: false, reason: 'NO_TILES_MATCHED', clicked: 0 }),
  });
  await h[ST.LOGIN_CAPTCHA](c);
  assert.deepStrictEqual(refreshed, ['refresh']);
});
