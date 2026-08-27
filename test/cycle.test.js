const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { run } = require('../runner');
const { createHandlers } = require('../handlers');
const { createBudget } = require('../budget');
const { STATES, REASONS } = require('../pageState');

// A whole 2-city, 4-combo cycle driven through the REAL run() and the REAL
// createHandlers(), with only the portal itself faked. Every other test in this
// suite checks one handler in isolation; nothing until now asserted the
// property the entire multi-city design rests on:
//
//   four combos cost exactly four searches, and each one is searched in the
//   city its label claims.
//
// The city lives on the server-side applicant profile, not on the booking
// form's Location dropdown, so a mis-sequenced profile edit does not fail
// loudly - it quietly re-searches the previous city under the next city's name.

const LIMITS = { login: 3, preForm: 3, postForm: 3, unavailable: 5, profile: 3 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyc-')), 's.json');

const CFG = {
  // This whole file exercises the MULTI-CITY cycle - the profile subflow it
  // asserts on only happens when a run crosses a city boundary. Set explicitly
  // because it is no longer the default; see config.js MULTI_CITY.
  MULTI_CITY: true,
  ACTIVE_CITIES: [{ name: 'Islamabad', LOCATION: 'Islamabad' }, { name: 'Lahore', LOCATION: 'Lahore' }],
  MACHINE: { CATEGORIES: ['Normal', 'Premium'], MAX_TRANSITIONS: 60, OSCILLATION_LIMIT: 6 },
  MY_APPOINTMENTS_URL: 'https://example.test/Global/appointmentdata/MyAppointments',
  BASE_URL: 'https://example.test',
  BLS_HOME_URL: '/Global/home/index',
  SIMULATE: { SLOTS: false },
};

/**
 * A fake portal that behaves like the real one in the two ways that matter:
 *
 *  - it holds the applicant's city SERVER-SIDE (`portalCity`), changed only by
 *    a completed profile subflow;
 *  - the booking form's Location dropdown does not move the search - every
 *    #btnSubmit searches whatever `portalCity` currently is.
 *
 * `formRepeats` models the portal handing the form page back instead of a dead
 * end, which is what makes the per-combo postForm budget spend more than one
 * real search. `profileFailsOnCity` models the F1 failure: the subflow throws
 * because no confirmation alert appeared.
 */
function portal({ formRepeats = 1, profileFailsOnCity = null } = {}) {
  const m = {
    page: STATES.LOGIN_EMAIL,
    reason: null,
    portalCity: 'Islamabad',
    pendingCity: null,
    searches: [],
    profileSets: [],
    submitsThisCombo: 0,
  };

  const deps = {
    capture: async () => 'dir',
    scanSlots: async () => null,
    simulateSlotsFound: () => null,

    fillEmail: async () => { m.page = STATES.LOGIN_CAPTCHA; },
    fillPasswordAndSolve: async () => { m.page = STATES.HOME; return { ok: true }; },
    solve: async () => { m.page = STATES.VISA_FORM; return { ok: true }; },
    clickBookNow: async () => { m.page = STATES.CAPTCHA; m.reason = null; },
    goHome: async () => { m.page = STATES.HOME; m.reason = null; },
    goToMyAppointments: async () => { m.page = STATES.PROFILE_LIST; m.reason = null; },

    openApplicantEdit: async () => { m.page = STATES.PROFILE_FORM; },
    setProfileCity: async (d, item) => { m.pendingCity = item.location; m.page = STATES.PROFILE_CONFIRM; },
    submitProfileFrame: async () => {
      if (profileFailsOnCity && m.pendingCity === profileFailsOnCity) {
        throw new Error('No confirmation alert appeared after the profile Submit');
      }
      m.portalCity = m.pendingCity;
      m.profileSets.push(m.pendingCity);
    },

    fillFormAndSubmit: async (d, item) => {
      m.searches.push({ label: item.label, searchedCity: m.portalCity });
      m.submitsThisCombo += 1;
      if (m.submitsThisCombo >= formRepeats) {
        m.submitsThisCombo = 0;
        m.page = STATES.DEAD_END;
        m.reason = REASONS.NO_SLOTS;
      } else {
        m.page = STATES.VISA_FORM;   // the portal handed the form back
        m.reason = null;
      }
    },
    clickDeadEndButton: async () => { m.page = STATES.CAPTCHA; m.reason = null; },
  };

  const detect = async () => ({ state: m.page, reason: m.reason, evidence: 'fake' });
  return { m, deps, detect };
}

function cycle(opts) {
  const p = portal(opts);
  const budget = createBudget({ limits: LIMITS, searchFile: tmp() });
  return {
    p,
    budget,
    go: () => run({
      driver: { sleep: async () => {} },
      detect: p.detect,
      handlers: createHandlers(p.deps),
      budget,
      cfg: CFG,
      log: () => {},
    }),
  };
}

test('a clean 2-city cycle costs exactly four searches and two profile edits', async () => {
  const { p, go } = cycle();
  const out = await go();

  assert.strictEqual(out.result, 'NO_SLOTS');
  assert.strictEqual(out.searchesUsed, 4, 'four combos must cost four searches, no more');
  assert.strictEqual(p.m.searches.length, 4);
  assert.deepStrictEqual(p.m.searches.map((s) => s.label), [
    'Islamabad/Normal', 'Islamabad/Premium', 'Lahore/Normal', 'Lahore/Premium',
  ]);
  assert.deepStrictEqual(p.m.profileSets, ['Islamabad', 'Lahore'],
    'city-major ordering means two profile edits per cycle, not four');
  assert.deepStrictEqual(out.results, {
    'Islamabad/Normal': 'NO_SLOTS',
    'Islamabad/Premium': 'NO_SLOTS',
    'Lahore/Normal': 'NO_SLOTS',
    'Lahore/Premium': 'NO_SLOTS',
  });
  assert.ok(out.transitions < CFG.MACHINE.MAX_TRANSITIONS,
    `clean cycle used ${out.transitions} of ${CFG.MACHINE.MAX_TRANSITIONS} transitions`);
});

// The failure this whole design exists to prevent: a search labelled Lahore
// that actually ran against the Islamabad profile. It costs a duplicate search
// AND announces a real Islamabad slot as Lahore at 3am.
test('every search runs in the city its label claims', async () => {
  const { p, go } = cycle();
  await go();
  for (const s of p.m.searches) {
    assert.strictEqual(s.searchedCity, s.label.split('/')[0],
      `${s.label} was actually searched against ${s.searchedCity}`);
  }
});

// F1 + F3 together. The profile subflow fails on the SECOND city: the throw is
// caught by run() (F3) rather than escaping as a crash, and because the throw
// left profileCity unset (F1) the run stops instead of re-searching Islamabad
// twice under Lahore's name.
test('a profile failure on the second city cannot spend a fifth search', async () => {
  const { p, go } = cycle({ profileFailsOnCity: 'Lahore' });
  const out = await go();

  assert.strictEqual(out.result, 'HANDLER_ERROR');
  assert.strictEqual(out.searchesUsed, 2, 'only the two Islamabad combos may be paid for');
  assert.strictEqual(p.m.searches.length, 2);
  assert.deepStrictEqual(p.m.profileSets, ['Islamabad'], 'the failed edit must not be recorded');
  assert.strictEqual(p.m.portalCity, 'Islamabad', 'the portal never moved');
  // The finish path still ran, so the operator can see what completed.
  assert.deepStrictEqual(out.results, {
    'Islamabad/Normal': 'NO_SLOTS',
    'Islamabad/Premium': 'NO_SLOTS',
  });
});

// F2. postForm is 3 and resetTraversal() refreshes it at every combo boundary,
// so a portal that hands the form page back instead of a dead end lets one run
// spend 3 x 4 = 12 real searches. The account was blocked once after fewer
// than ten.
test('the run-level ceiling caps a form-page loop at one search per plan item', async () => {
  const { p, go } = cycle({ formRepeats: 3 });
  const out = await go();

  assert.strictEqual(out.result, 'SEARCH_CEILING');
  assert.strictEqual(out.searchesUsed, 4,
    'without the ceiling this same portal behaviour spends 12');
  assert.strictEqual(p.m.searches.length, 4);
});
