/**
 * detect -> dispatch -> re-detect, until terminal or a guard trips.
 *
 * Guards:
 *   1. per-phase budgets      - owned by budget.js, charged inside handlers
 *   2. oscillation            - same state N times with no counter advancing
 *   3. transition cap         - backstop
 *
 * detect and handlers are injected so the loop is unit testable with fakes.
 */
// Without profile here, a PROFILE_LIST <-> PROFILE_FORM bounce leaves the
// fingerprint unchanged and the oscillation guard cannot see it.
function countersFingerprint(budget) {
  const c = budget.counters;
  return `${c.login}:${c.preForm}:${c.postForm}:${c.unavailable}:${c.profile}:${budget.searchesUsed}`;
}

// City-major, deliberately: both categories are searched while the portal
// profile is already pinned to that city, which halves the number of profile
// edits per cycle from four to two.
function buildPlan(cfg) {
  const items = [];
  for (const city of cfg.CITIES) {
    for (const category of cfg.MACHINE.CATEGORIES) {
      items.push({
        city: city.name,
        location: city.LOCATION,
        category,
        label: `${city.name}/${category}`,
      });
    }
  }
  return items;
}

async function run({ driver, detect, handlers, budget, cfg, log }) {
  // profileCity is in-memory only and dies with the run. There is deliberately
  // no persisted last-city: a cached value silently disagrees with the portal
  // the moment the profile is edited by hand or a run dies mid-subflow.
  const plan = buildPlan(cfg);
  // searchesAtStart / planSize are the run-level search ceiling. searchesUsed is
  // an all-time persisted total, so only the delta means anything here; planSize
  // is captured before the plan starts shifting. VISA_FORM refuses to submit once
  // the delta reaches planSize - one real search per plan item and no more.
  const state = {
    phase: 'login',
    plan,
    results: {},
    profileCity: null,
    searchesAtStart: budget.searchesUsed,
    planSize: plan.length,
  };
  const limit = cfg.MACHINE.MAX_TRANSITIONS;
  const oscLimit = cfg.MACHINE.OSCILLATION_LIMIT;

  let transitions = 0;
  let lastState = null;
  let repeats = 0;
  let lastFingerprint = countersFingerprint(budget);

  const finish = (result, note) => ({
    result,
    note: note || null,
    transitions,
    results: state.results,
    searchesUsed: budget.searchesUsed,
    // Set only by the SLOTS handler; app.js must stop() it to exit.
    alerts: state.alerts || null,
  });

  while (transitions < limit) {
    const detected = await detect(driver);
    transitions += 1;
    log(`[${transitions}] ${detected.state}${detected.reason ? '/' + detected.reason : ''} - ${detected.evidence}`);

    const fingerprint = countersFingerprint(budget);
    if (detected.state === lastState && fingerprint === lastFingerprint) {
      repeats += 1;
      if (repeats >= oscLimit) {
        log(`Oscillating on ${detected.state} with no progress - aborting.`);
        return finish('OSCILLATING', detected.state);
      }
    } else {
      repeats = 1;
    }
    lastState = detected.state;
    lastFingerprint = fingerprint;

    const handler = handlers[detected.state];
    if (!handler) {
      log(`No handler for ${detected.state} - aborting.`);
      return finish('NO_HANDLER', detected.state);
    }

    // A throw used to escape run() entirely: app.js turned it into exit 1 and
    // the finish path never ran, so the results and the search count were never
    // logged. Overnight that meant nobody could see which combos had completed,
    // and the next cycle rebuilt the plan from scratch and RE-SEARCHED the city
    // this run had already paid for. Convert it into a normal terminal result
    // instead, so the run reports what it managed to do.
    let outcome;
    try {
      outcome = await handler({ driver, detected, budget, state, cfg, log });
    } catch (e) {
      log(`Handler for ${detected.state} threw: ${e.message}`);
      return finish('HANDLER_ERROR', e.message);
    }
    if (outcome && outcome.terminal) {
      return finish(outcome.result, outcome.note);
    }
  }

  log(`Transition cap (${limit}) reached - aborting.`);
  return finish('TRANSITION_CAP');
}

module.exports = { run, buildPlan };
