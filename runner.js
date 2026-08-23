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
function countersFingerprint(budget) {
  const c = budget.counters;
  return `${c.login}:${c.preForm}:${c.postForm}:${c.unavailable}:${budget.searchesUsed}`;
}

async function run({ driver, detect, handlers, budget, cfg, log }) {
  const state = { phase: 'login', plan: [...cfg.MACHINE.PLAN], results: {} };
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

    const outcome = await handler({ driver, detected, budget, state, cfg, log });
    if (outcome && outcome.terminal) {
      return finish(outcome.result, outcome.note);
    }
  }

  log(`Transition cap (${limit}) reached - aborting.`);
  return finish('TRANSITION_CAP');
}

module.exports = { run };
