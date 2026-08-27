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
  BLOCKED: 'BLOCKED',
  PROFILE_LIST: 'PROFILE_LIST',
  PROFILE_FORM: 'PROFILE_FORM',
  PROFILE_CONFIRM: 'PROFILE_CONFIRM',
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
// The resolved label's textContent is intact: "Please select all boxes with
// number 696". (An earlier note here claimed every 's' was dropped - that was
// an artifact of a /s+/ regex produced by heredoc escaping, not the portal.)
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

// ---- The Manage Applicants subflow -------------------------------------
//
// Three overlays on ONE url - MyAppointments never navigates between them - so
// they are separated by visible DOM, not by address.

// The Kendo window that Proceed opens. Checked before profileForm because the
// modal may still be in the DOM behind it.
async function profileConfirm(driver) {
  const hit = await driver.executeScript(`
    ${VIS_FN}
    const frames = [...document.querySelectorAll('iframe.k-content-frame')].filter(vis);
    return frames.length ? frames.length + ' k-content-frame' : null;
  `);
  if (!hit) return null;
  return { state: STATES.PROFILE_CONFIRM, reason: null, evidence: hit };
}

// The bootstrap modal holding Location + Visa Type. Both conjuncts are needed:
// this portal pre-renders modals everywhere, and .modal-content alone matches
// several that have nothing to do with the profile.
async function profileForm(driver) {
  const hit = await driver.executeScript(`
    ${VIS_FN}
    const modals = [...document.querySelectorAll('div.modal-content')].filter(vis);
    for (const m of modals) {
      const hasLocation = [...m.querySelectorAll('label')]
        .some((l) => vis(l) && /Location/i.test(l.textContent));
      const proceed = [...m.querySelectorAll('button')]
        .find((b) => vis(b) && /Proceed/i.test(b.textContent));
      if (hasLocation && proceed) return 'modal with Location + Proceed';
    }
    return null;
  `);
  if (!hit) return null;
  return { state: STATES.PROFILE_FORM, reason: null, evidence: hit };
}

// Pinned to the url: a[onclick*="ManageApplicant"] is not unique enough alone.
async function profileList(driver, url) {
  if (!/\/appointmentdata\/myappointments/i.test(url)) return null;
  const hit = await driver.executeScript(`
    ${VIS_FN}
    const links = [...document.querySelectorAll('a[onclick*="ManageApplicant"]')].filter(vis);
    return links.length ? links.length + ' ManageApplicant link(s)' : null;
  `);
  if (!hit) return null;
  return { state: STATES.PROFILE_LIST, reason: null, evidence: hit };
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
//
// The one negative guard: MyAppointments is never a slots page. profileList
// is URL-pinned AND requires a[onclick*="ManageApplicant"]; the real page has
// never been captured, so if it turns out to use a <button onclick=
// "ManageApplicant..."> instead of an <a>, profileList misses and this
// predicate - which fires on ANY visible datepicker, and MyAppointments is an
// appointments page - would raise a FALSE slots alert, waking a human at 3am
// for nothing. The guard cannot cause a MISSED alert in exchange: the genuine
// slots page lives on /appointment/newappointment, which this never touches.
async function slots(driver, url) {
  if (url && /\/appointmentdata\/myappointments/i.test(url)) return null;
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

// #btnVerify is in the shared layout on EVERY page, so it only means anything
// combined with the url and a visibility check.
async function loginEmail(driver, url) {
  if (!/\/account\/login/i.test(url)) return null;
  const ok = await driver.executeScript(`
    ${VIS_FN}
    const verify = document.querySelector('#btnVerify');
    if (!verify || !vis(verify)) return null;
    const input = [...document.querySelectorAll('input[type="text"], input[type="email"]')]
      .find((e) => vis(e) && e.getBoundingClientRect().width > 50);
    return input ? 'email input + btnVerify' : null;
  `);
  if (!ok) return null;
  return { state: STATES.LOGIN_EMAIL, reason: null, evidence: ok };
}

// The Book Now href is in the nav on every page. Exclude .nav-link and pin the
// url, or this matches almost everywhere.
async function home(driver, url) {
  if (!/\/home\/index/i.test(url)) return null;
  const ok = await driver.executeScript(`
    ${VIS_FN}
    const links = [...document.querySelectorAll('a[href$="appointment/newappointment"]')];
    const real = links.find((a) => !a.classList.contains('nav-link') && vis(a));
    return real ? real.getAttribute('href') : null;
  `);
  if (!ok) return null;
  return { state: STATES.HOME, reason: null, evidence: ok };
}

// Source-based on purpose: the outage page is a bare error document with no
// stable structure to resolve.
async function unavailable(driver) {
  const src = await driver.getPageSource();
  if (!/Temporarily Unavailable/i.test(src)) return null;
  return { state: STATES.UNAVAILABLE, reason: null, evidence: 'Temporarily Unavailable' };
}

// The portal's two "we have seen enough of you" pages. Source-based for the
// same reason as unavailable(): these are bare error documents served by the
// edge, with no portal chrome and no stable structure to resolve.
//
// Both were captured live as UNKNOWN on 2026-08-26/27, which is the wrong
// verdict twice over. UNKNOWN means "never seen this, a human must look", so
// each one wrote a capture directory and an Error line asking for attention
// that nothing could act on - while the thing actually being reported was an
// ordinary rate limit whose only correct answer is to back off and come back.
//
//   "Too Many Requests"  - the origin's own limiter, an explicit IP mention
//   "403 ERROR ... Request blocked ... Generated by cloudfront" - the CDN
//
// The patterns are deliberately TIGHT. A loose source match here is the
// dangerous kind of bug: the portal's real pages are large documents full of
// script and copy, and a false BLOCKED would stop the bot searching at all
// while reporting a healthy, deliberate back-off. Every pattern below pairs a
// title-ish phrase with a second phrase from the same document, and the whole
// test is skipped for any document big enough to be a real portal page.
const BLOCK_SIGNATURES = [
  {
    kind: 'Too Many Requests (origin rate limit)',
    all: [/Too Many Requests/i, /excessive requests from your IP/i],
  },
  {
    kind: 'CloudFront 403 (edge block)',
    all: [/The request could not be satisfied/i, /Request blocked/i, /cloudfront/i],
  },
];

// Real portal pages run to hundreds of kilobytes; both block pages are under
// one. The cap is a cheap second lock on the false-positive risk above.
const BLOCK_PAGE_MAX_BYTES = 8000;

async function blocked(driver) {
  const src = await driver.getPageSource();
  if (src.length > BLOCK_PAGE_MAX_BYTES) return null;
  for (const sig of BLOCK_SIGNATURES) {
    if (sig.all.every((re) => re.test(src))) {
      return { state: STATES.BLOCKED, reason: null, evidence: sig.kind };
    }
  }
  return null;
}

// Ordered. First match wins.
//
// ORDER IS LOAD-BEARING:
//  - blocked first: it is the cheapest test and the only one whose answer
//    means "stop, none of the others can be true".
//  - deadEnd first among the portal's own pages: TryAgain's button href IS the
//    Book Now selector.
//  - the profile trio BEFORE slots: slots is deliberately loose (any visible
//    datepicker), and MyAppointments is an appointments page. Ordered after
//    slots, a profile page could fire a false slots alert.
//  - profileConfirm before profileForm: the modal can linger behind the frame.
//  - loginCaptcha before captcha: a visible password field is the only diff.
//  - slots before visaForm: a successful search EXTENDS the form page.
const PREDICATES = [
  blocked,
  unavailable,
  deadEnd,
  profileConfirm,
  profileForm,
  profileList,
  loginCaptcha,
  captcha,
  slots,
  visaForm,
  loginEmail,
  home,
];

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
