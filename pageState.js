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

// The alert must be a DIRECT child of #div-main and must NOT sit inside a
// modal. The Visa Type form has #div-main AND an alert-warning (inside
// #scamAlert) AND six a.btn-primary - every conjunct of a naive predicate.
async function deadEnd(driver) {
  const info = await driver.executeScript(`
    ${VIS_FN}
    const dm = document.querySelector('#div-main');
    if (!dm) return null;
    if ([...document.querySelectorAll('.box-label')].some(vis)) return null;
    const alert = [...dm.children].find(
      (c) => c.classList.contains('alert') && !c.closest('.modal') && vis(c)
    );
    if (!alert) return null;
    const btn = [...dm.querySelectorAll('a.btn-primary')].find(vis);
    if (!btn) return null;
    return {
      cls: alert.className,
      text: alert.textContent.replace(/\\s+/g, ' ').trim(),
      href: btn.getAttribute('href'),
    };
  `);
  if (!info) return null;

  let reason = REASONS.UNKNOWN_REASON;
  if (/alert-warning/.test(info.cls) && /captcha/i.test(info.text) && /invalid/i.test(info.text)) {
    reason = REASONS.CAPTCHA_INVALID;
  } else if (/alert-danger/.test(info.cls) && /no slots are available/i.test(info.text)) {
    reason = REASONS.NO_SLOTS;
  }
  return { state: STATES.DEAD_END, reason, evidence: info.text.slice(0, 300) };
}

// Returns the REAL box-label's text, or null. The decoys are painted the
// background colour, never hidden, so vis() cannot be used here.
async function visibleCaptchaLabel(driver) {
  return driver.executeScript(`
    ${CAPTCHA_LABEL_FN}
    return captchaLabel();
  `);
}

async function hasVisiblePassword(driver) {
  return driver.executeScript(`
    ${VIS_FN}
    return [...document.querySelectorAll('input[type="password"]')].some(vis);
  `);
}

// Ordered before captcha: a visible password field is the ONLY difference.
async function loginCaptcha(driver) {
  const label = await visibleCaptchaLabel(driver);
  if (!label) return null;
  if (!(await hasVisiblePassword(driver))) return null;
  return { state: STATES.LOGIN_CAPTCHA, reason: null, evidence: label };
}

async function captcha(driver) {
  const label = await visibleCaptchaLabel(driver);
  if (!label) return null;
  return { state: STATES.CAPTCHA, reason: null, evidence: label };
}

// Deliberately loose. A missed slot notification is this project's worst
// outcome, so the source-text fallback is kept alongside the element check.
// This is the ONE permitted getPageSource-style test in the detector.
async function slots(driver) {
  const hit = await driver.executeScript(`
    ${VIS_FN}
    if ([...document.querySelectorAll('input[data-role="datepicker"]')].some(vis)) {
      return 'datepicker';
    }
    const labels = [...document.querySelectorAll('label, span, div, h5')];
    const el = labels.find((e) => vis(e) && /Appointment Slot/i.test(e.textContent));
    return el ? 'Appointment Slot label' : null;
  `);
  if (!hit) return null;
  return { state: STATES.SLOTS, reason: null, evidence: hit };
}

async function visaForm(driver, url) {
  const hit = await driver.executeScript(`
    ${VIS_FN}
    const dd = [...document.querySelectorAll('span.k-dropdown-wrap')].filter(vis);
    if (dd.length === 0) return null;
    const h5 = [...document.querySelectorAll('h5')].find(
      (e) => /Visa Type Selection/i.test(e.textContent)
    );
    return h5 ? dd.length + ' dropdowns, h5 matched' : null;
  `);
  if (!hit) return null;
  return { state: STATES.VISA_FORM, reason: null, evidence: hit };
}

// Ordered. First match wins. Order is load-bearing - see the spec.
const PREDICATES = [deadEnd, loginCaptcha, captcha, slots, visaForm];

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
