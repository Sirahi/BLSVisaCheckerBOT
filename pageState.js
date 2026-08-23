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

// Resolves the REAL captcha label among the decoys.
//
// The decoys are not hidden - they are painted the background colour
// (.qjfmqi{color:#FFFAFA;} and 49 siblings). All 39 report isDisplayed() ===
// true, live and offline alike, so visibility cannot be used here.
//
// Primary: odd colour out (38 decoys share one colour, the real label does
// not). Tiebreak: highest z-index, which is what the shipping findTargetNumber
// already uses. Verified agreeing on all three captures.
//
// NOTE: textContent drops every 's' - "Plea e  elect all boxe  with number
// 696". Digits and "number" survive; never match on label words.
const CAPTCHA_LABEL_FN = `
  const captchaLabel = () => {
    const els = [...document.querySelectorAll('.box-label')];
    if (els.length === 0) return null;
    const counts = {};
    els.forEach((e) => {
      const c = window.getComputedStyle(e).color;
      counts[c] = (counts[c] || 0) + 1;
    });
    const odd = els.filter((e) => counts[window.getComputedStyle(e).color] === 1);
    const pick = odd.length === 1
      ? odd[0]
      : els.slice().sort((a, b) =>
          (parseInt(window.getComputedStyle(b).zIndex) || 0) -
          (parseInt(window.getComputedStyle(a).zIndex) || 0))[0];
    return pick ? pick.textContent.replace(/\\s+/g, ' ').trim() : null;
  };
`;

// Injected into every probe. One round-trip beats N isDisplayed() calls, and
// this is the exact visibility definition the whole detector shares.
// Valid for alerts, dropdowns, passwords, and modals - NOT for box-labels.
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

module.exports = { STATES, REASONS, VIS_FN, CAPTCHA_LABEL_FN, PREDICATES, detect };
