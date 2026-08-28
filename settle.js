/**
 * Wait for the portal to finish loading, by CONDITION rather than by duration.
 *
 * Every navigation in portalActions used to be "click, then sleep N ms, then
 * let the state machine look at whatever is there". That is a bet on the
 * portal's response time, and on 2026-08-28 the bet was visibly lost: the
 * result screenshot for Karachi/Normal came back as 13KB of white with a
 * single loading dot, while Karachi/Premium in the same cycle came back as a
 * 74KB real page. Same code, same run - the fixed 2500ms was simply sometimes
 * too short.
 *
 * The screenshot is the harmless victim of that race. detect() is the
 * dangerous one: it runs on whatever is on screen when the sleep expires, and
 * a spinner page matches NO predicate in pageState. It would be reported
 * UNKNOWN, exit 20, which main.js classifies as a BLOCK and answers with a
 * 40-60 minute back-off. A slow page load must not be able to masquerade as a
 * ban and cost an hour of searching.
 */

// Both of the portal's loading indicators. #global-overlay is the AJAX overlay
// (the yellow dot); .preloader is the full-page one shown on a hard
// navigation. Verified against five saved portal pages: on a settled page NONE
// of these are visible, so this condition genuinely terminates - a predicate
// that is never true would be a hang, not a wait.
const LOADER_SELECTORS = ['#global-overlay', '.global-overlay', '.preloader', '.spinner-grow'];

const PROBE = `
  const vis = (el) => {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sels = ${JSON.stringify(LOADER_SELECTORS)};
  let loaders = 0;
  for (const s of sels) {
    loaders += [...document.querySelectorAll(s)].filter(vis).length;
  }
  return { readyState: document.readyState, loaders };
`;

/**
 * Resolves true once the page has been quiet for `quietMs`, false on timeout.
 * NEVER throws and never navigates - the caller has usually just spent a real
 * search, and a probe must not be able to undo that.
 *
 * The quiet period is the load-bearing part. A loading overlay does not appear
 * the instant a click returns, so a single sample - or accepting the first
 * calm poll - reads the gap BEFORE the spinner arrives as "done". That is the
 * same race that cost four cycles on the form modals; it is not repeated here.
 */
async function waitForPageSettled(driver, { timeout = 15000, quietMs = 600, pollMs = 150, log = () => {} } = {}) {
  const deadline = Date.now() + timeout;
  let quietSince = null;

  for (;;) {
    let state = null;
    try {
      state = await driver.executeScript(PROBE);
    } catch (e) {
      // A page mid-navigation can reject a script outright. That is not
      // settled, and it is not fatal either.
      state = null;
    }

    const calm = !!state && state.readyState === 'complete' && state.loaders === 0;
    if (calm) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    } else {
      quietSince = null;
    }

    if (Date.now() >= deadline) {
      log(`Page still loading after ${timeout}ms - continuing anyway.`);
      return false;
    }
    await driver.sleep(pollMs);
  }
}

module.exports = { waitForPageSettled, LOADER_SELECTORS };
