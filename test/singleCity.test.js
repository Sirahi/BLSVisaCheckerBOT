/**
 * Single-city mode.
 *
 * The saving is that the run never opens Manage Applicants: it TRUSTS that the
 * portal profile is already pinned to the configured city. That trust is the
 * risk too - if it is misplaced, every search runs against a different city
 * under this one's name and nothing fails loudly. So the behaviour is pinned
 * here rather than left to config review.
 *
 * config.js resolves CITIES (the catalogue) -> ACTIVE_CITIES (what this run
 * searches). buildPlan only ever sees the resolved list.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { run, buildPlan } = require('../runner');
const { createHandlers } = require('../handlers');
const { STATES } = require('../pageState');
const { createBudget } = require('../budget');

const ISB = { name: 'Islamabad', LOCATION: 'Islamabad' };
const LHE = { name: 'Lahore', LOCATION: 'Lahore' };
const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5, profile: 3 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), 's.json');

const SINGLE = {
  MULTI_CITY: false,
  ACTIVE_CITIES: [ISB],
  MACHINE: { CATEGORIES: ['Normal', 'Premium'], MAX_TRANSITIONS: 60, OSCILLATION_LIMIT: 6 },
};

// Drive run() with one inert handler and hand the ctx back to the caller.
async function firstCtx(cfg, onCtx, log = () => {}) {
  return run({
    driver: {},
    detect: async () => ({ state: 'X', reason: null, evidence: '' }),
    handlers: {
      X: async (c) => {
        onCtx(c);
        return { terminal: true, result: 'NO_SLOTS' };
      },
    },
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    cfg,
    log,
  });
}

// ---- the plan -------------------------------------------------------------

test('a single-city plan is one city x every category', () => {
  assert.deepStrictEqual(buildPlan(SINGLE).map((p) => p.label), [
    'Islamabad/Normal',
    'Islamabad/Premium',
  ]);
});

test('halving the plan halves the run-level search ceiling', async () => {
  // planSize IS the ceiling (see VISA_FORM in handlers.js). Two combos means
  // two searches per cycle instead of four - the whole point of the switch.
  let seen = null;
  await firstCtx(SINGLE, (c) => { seen = c.state.planSize; });
  assert.strictEqual(seen, 2);
});

// ---- the profile assumption ----------------------------------------------

test('run seeds profileCity with the active city, so HOME sees no mismatch', async () => {
  let seen = 'unset';
  await firstCtx(SINGLE, (c) => { seen = c.state.profileCity; });
  assert.strictEqual(seen, 'Islamabad');
});

test('multi-city still starts with profileCity unknown, so the edit still happens', async () => {
  let seen = 'unset';
  await firstCtx({ ...SINGLE, MULTI_CITY: true, ACTIVE_CITIES: [ISB, LHE] }, (c) => {
    seen = c.state.profileCity;
  });
  assert.strictEqual(seen, null, 'a seeded multi-city run would skip the first profile edit');
});

test('the assumption is announced, because nothing else can reveal it is wrong', async () => {
  const lines = [];
  await firstCtx(SINGLE, () => {}, (m) => lines.push(m));
  assert.ok(
    lines.some((l) => /Single-city mode: Islamabad/.test(l) && /ASSUMING/.test(l)),
    'expected a loud single-city notice, got:\n' + lines.join('\n')
  );
});

// ---- HOME must not detour through Manage Applicants -----------------------

function noopDeps(extra) {
  return Object.assign({
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
  }, extra || {});
}

function homeCtx(profileCity) {
  return {
    driver: { sleep: async () => {} },
    detected: { state: STATES.HOME, reason: null, evidence: '' },
    budget: createBudget({ limits: LIMITS, searchFile: tmp() }),
    state: {
      phase: 'preForm',
      plan: [{ city: 'Islamabad', location: 'Islamabad', category: 'Normal', label: 'Islamabad/Normal' }],
      results: {},
      profileCity,
      searchesAtStart: 0,
      planSize: 1,
    },
    cfg: SINGLE,
    log: () => {},
  };
}

function tracingHandlers(calls) {
  return createHandlers(noopDeps({
    clickBookNow: async () => { calls.push('bookNow'); },
    goToMyAppointments: async () => { calls.push('manageApplicants'); },
  }));
}

test('HOME goes straight to the booking form when profileCity is already the target', async () => {
  const calls = [];
  await tracingHandlers(calls)[STATES.HOME](homeCtx('Islamabad'));
  assert.deepStrictEqual(calls, ['bookNow'], 'single-city mode must not open the profile editor');
});

test('HOME still detours when profileCity genuinely disagrees', async () => {
  // The skip is a consequence of the seed, not a separate branch. If this ever
  // fails, the multi-city path has been broken by the single-city switch.
  const calls = [];
  await tracingHandlers(calls)[STATES.HOME](homeCtx('Lahore'));
  assert.deepStrictEqual(calls, ['manageApplicants']);
});

// ---- config resolution ----------------------------------------------------

// Resolution happens at require time, so each case needs a fresh process.
function resolve(env) {
  const script = "process.stdout.write(require('./config').ACTIVE_CITIES.map(c=>c.name).join(','))";
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
  }).trim();
  // dotenv may print a banner ahead of the value; the answer is the last line.
  return out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
}

test('the default config searches one city', () => {
  assert.strictEqual(resolve({ MULTI_CITY: '', ACTIVE_CITY: '' }), 'Islamabad');
});

test('ACTIVE_CITY picks the city without a code edit', () => {
  assert.strictEqual(resolve({ MULTI_CITY: '', ACTIVE_CITY: 'Lahore' }), 'Lahore');
});

// Derived from CITIES, not spelled out: the catalogue is a config list that
// grows (Karachi was added 2026-08-27), and a hardcoded expectation here fails
// on the config edit rather than on any change to the resolving logic - which
// is what these tests are actually about.
const CATALOGUE = require('../config').CITIES.map((c) => c.name).join(',');

test('MULTI_CITY=1 brings the whole catalogue back', () => {
  assert.strictEqual(resolve({ MULTI_CITY: '1', ACTIVE_CITY: '' }), CATALOGUE);
});

test('MULTI_CITY accepts the usual spellings of true', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.strictEqual(resolve({ MULTI_CITY: v, ACTIVE_CITY: '' }), CATALOGUE, v);
  }
});

test('MULTI_CITY=0 forces single-city for one run', () => {
  // The point of spelling truthiness out: with a bare `=== '1'` test there is
  // no way to switch a default-on multi-city OFF from the environment.
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(resolve({ MULTI_CITY: v, ACTIVE_CITY: '' }), 'Islamabad', v);
  }
});

test('an ACTIVE_CITY that is not in CITIES refuses to start', () => {
  // Deliberately fatal rather than falling back to CITIES[0]: a typo that
  // silently searched the wrong city is the failure this mode is exposed to.
  //
  // The bad name must be one that can never become real. This test used to use
  // "Karachi", which stopped throwing the day Karachi was added to CITIES.
  assert.throws(
    () => resolve({ MULTI_CITY: '', ACTIVE_CITY: 'Atlantis' }),
    (e) => /is not in CITIES/.test(e.stderr || '') && /Refusing to guess/.test(e.stderr || '')
  );
});
