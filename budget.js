/**
 * Run budgets.
 *
 * Three enforcing counters plus one instrument that never blocks:
 *   login / preForm / postForm  - 3 each, enforced
 *   unavailable                 - 5, enforced (matches the old retry cap)
 *   searchesUsed                - persisted, logged, NEVER enforced
 *
 * The counters are not equal in cost. login and preForm spend captcha requests
 * but never submit the form. postForm retries re-submit, and each re-submit is
 * an appointment search - the budget that got the account blocked. That is why
 * searches are tracked separately rather than inferred.
 */
const fs = require('fs');

function readSearches(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(raw.searchesUsed) ? raw.searchesUsed : 0;
  } catch (e) {
    return 0; // missing or corrupt - start clean, never throw
  }
}

function createBudget({ limits, searchFile }) {
  const counters = { login: 0, preForm: 0, postForm: 0, unavailable: 0 };
  let searchesUsed = readSearches(searchFile);
  let exhausted = null;

  return {
    get counters() { return { ...counters }; },
    get searchesUsed() { return searchesUsed; },
    get exhausted() { return exhausted; },

    charge(phase) {
      if (!(phase in counters)) throw new Error(`Unknown budget phase: ${phase}`);
      if (counters[phase] >= limits[phase]) { exhausted = phase; return false; }
      counters[phase] += 1;
      return true;
    },

    // A new category gets a full traversal allowance. login is NOT reset - we
    // do not log in again mid-run.
    resetTraversal() {
      counters.preForm = 0;
      counters.postForm = 0;
      counters.unavailable = 0;
      exhausted = null;
    },

    recordSearch() {
      searchesUsed += 1;
      try {
        fs.writeFileSync(
          searchFile,
          JSON.stringify({ searchesUsed, updatedAt: new Date().toISOString() }, null, 2)
        );
      } catch (e) {
        // Never let bookkeeping kill a run.
      }
      return searchesUsed;
    },
  };
}

module.exports = { createBudget };
