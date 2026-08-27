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
//
// Plans over ACTIVE_CITIES, not CITIES. CITIES is the catalogue of what the
// bot CAN search; ACTIVE_CITIES is what this run WILL search, resolved in
// config.js from the MULTI_CITY switch. In single-city mode that is a
// one-entry list, so the city-major ordering below collapses to plain
// category order and no city boundary ever occurs.
function buildPlan(cfg) {
  const items = [];
  for (const city of cfg.ACTIVE_CITIES) {
    for (const category of cfg.MACHINE.CATEGORIES) {
      items.push({
        city: city.name,
        location: city.LOCATION,
        category,
        label: `${city.name}/${category}`,
        // Per CITY, because the portal serves the Visa Sub Type list per
        // LOCATION - it is loaded by AJAX once Location and Visa Type are set,
        // and each centre publishes its own catalogue. Most cities inherit the
        // global FORM value; one that lists something different overrides it.
        // Resolved onto the ITEM rather than read from cfg at submit time, so
        // a MULTI_CITY run cannot apply one city's sub type to another.
        // Optional chained: the sub type is optional on the item too
        // (portalActions falls back to cfg.FORM at submit time), so buildPlan
        // does not hard-require a FORM block just to build a plan.
        visaSubType: city.VISA_SUB_TYPE || (cfg.FORM && cfg.FORM.VISA_SUB_TYPE),
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

  // Single-city mode skips the Manage Applicants subflow, and it does so by
  // SEEDING profileCity rather than by branching. HOME opens the profile
  // editor only when state.profileCity !== plan[0].city; seeding them equal
  // means that never fires, and DEAD_END's city-boundary check cannot fire
  // either because a one-city plan has no boundary. No second code path, so
  // the multi-city path cannot rot while it is switched off.
  //
  // The seed is an ASSUMPTION about server-side state this run never verified.
  // Logged loudly for exactly that reason: if the portal profile is really on
  // another city, this line is the only place the mistake is visible.
  const assumedCity = !cfg.MULTI_CITY && plan.length ? plan[0].city : null;
  if (assumedCity) {
    log(
      `Single-city mode: ${assumedCity}. ASSUMING the portal profile is already ` +
        `set to it - no Manage Applicants edit will be made this run.`,
    );
  }
  // searchesAtStart / planSize are the run-level search ceiling. searchesUsed is
  // an all-time persisted total, so only the delta means anything here; planSize
  // is captured before the plan starts shifting. VISA_FORM refuses to submit once
  // the delta reaches planSize - one real search per plan item and no more.
  const state = {
    phase: "login",
    plan,
    results: {},
    profileCity: assumedCity,
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
    log(
      `[${transitions}] ${detected.state}${detected.reason ? "/" + detected.reason : ""} - ${detected.evidence}`,
    );

    const fingerprint = countersFingerprint(budget);
    if (detected.state === lastState && fingerprint === lastFingerprint) {
      repeats += 1;
      if (repeats >= oscLimit) {
        log(`Oscillating on ${detected.state} with no progress - aborting.`);
        return finish("OSCILLATING", detected.state);
      }
    } else {
      repeats = 1;
    }
    lastState = detected.state;
    lastFingerprint = fingerprint;

    const handler = handlers[detected.state];
    if (!handler) {
      log(`No handler for ${detected.state} - aborting.`);
      return finish("NO_HANDLER", detected.state);
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
      return finish("HANDLER_ERROR", e.message);
    }
    if (outcome && outcome.terminal) {
      return finish(outcome.result, outcome.note);
    }
  }

  log(`Transition cap (${limit}) reached - aborting.`);
  return finish("TRANSITION_CAP");
}

module.exports = { run, buildPlan };
