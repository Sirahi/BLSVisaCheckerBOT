/**
 * Page-state detection. READ-ONLY - never clicks, types, or navigates.
 *
 * Every predicate resolves the VISIBLE element at runtime. The portal
 * pre-renders ~10 modals, 40 captcha box-labels, and randomised ids on every
 * page, so presence in the DOM means nothing.
 */
const STATES = {
  UNAVAILABLE: 'UNAVAILABLE',
  DEAD_END: 'DEAD_END',
  LOGIN_CAPTCHA: 'LOGIN_CAPTCHA',
  CAPTCHA: 'CAPTCHA',
  SLOTS: 'SLOTS',
  VISA_FORM: 'VISA_FORM',
  LOGIN_EMAIL: 'LOGIN_EMAIL',
  HOME: 'HOME',
  UNKNOWN: 'UNKNOWN',
};

const REASONS = {
  NO_SLOTS: 'NO_SLOTS',
  CAPTCHA_INVALID: 'CAPTCHA_INVALID',
  UNKNOWN_REASON: 'UNKNOWN_REASON',
};

// Injected into every probe. One round-trip beats N isDisplayed() calls, and
// this is the exact visibility definition the whole detector shares.
const VIS_FN = `
  const vis = (el) => {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
`;

// Ordered. First match wins. Order is load-bearing - see the spec.
const PREDICATES = [];

/**
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string} [url] - defaults to the live url. Tests pass the fixture's
 *   original "saved from url" so url-based predicates work offline.
 * @returns {Promise<{state: string, reason: string|null, evidence: string}>}
 */
async function detect(driver, url) {
  const currentUrl = url || (await driver.getCurrentUrl());
  for (const predicate of PREDICATES) {
    const hit = await predicate(driver, currentUrl);
    if (hit) return hit;
  }
  return { state: STATES.UNKNOWN, reason: null, evidence: currentUrl };
}

module.exports = { STATES, REASONS, VIS_FN, PREDICATES, detect };
