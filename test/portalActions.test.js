const test = require('node:test');
const assert = require('node:assert');
const { By } = require('selenium-webdriver');
const { openApplicantEditImpl } = require('../portalActions');

// Fakes an anchor found via driver.findElements(). displayed/text/click are
// configurable per element; click() records into `clicked` instead of
// throwing, so a wrongly-clicked element is provable rather than masked by
// openApplicantEditImpl's own "stale - try the next" catch.
function fakeAnchor(text, clicked) {
  return {
    isDisplayed: async () => true,
    getText: async () => text,
    click: async () => { clicked.push(text); },
  };
}

// Routes findElements by locator kind: the primary strategy is an XPath
// (Primary Applicant row), the fallback is a plain CSS selector. `byResults`
// supplies what each strategy "finds" on the fake page.
function fakeDriver({ xpath = [], css = [] } = {}) {
  return {
    sleep: async () => {},
    executeScript: async () => {},
    findElements: async (by) => (by.using === 'xpath' ? xpath : css),
  };
}

const cfg = { SLEEP: { LONG: 0 } };

test('the fallback never clicks an anchor that reads like Add New Member', async () => {
  const clicked = [];
  const addNew = fakeAnchor('Add New Member', clicked);
  // Primary XPath finds nothing (unseen real page); fallback CSS finds ONLY
  // the add-new affordance - the exact shape the review flagged as dangerous.
  const driver = fakeDriver({ xpath: [], css: [addNew] });

  await assert.rejects(
    () => openApplicantEditImpl(driver, cfg),
    /Manage Applicants edit button not found/,
    'must fail closed instead of clicking an unknown affordance'
  );
  assert.deepStrictEqual(clicked, [], 'Add New Member must never be clicked');
});

test('the fallback still clicks a legitimate edit-looking anchor when the guard passes', async () => {
  const clicked = [];
  const edit = fakeAnchor('Edit', clicked);
  const driver = fakeDriver({ xpath: [], css: [edit] });

  await openApplicantEditImpl(driver, cfg);
  assert.deepStrictEqual(clicked, ['Edit']);
});

test('the fallback skips Add New Member but clicks a real edit link listed after it', async () => {
  const clicked = [];
  const addNew = fakeAnchor('Add New Member', clicked);
  const edit = fakeAnchor('Edit', clicked);
  const driver = fakeDriver({ xpath: [], css: [addNew, edit] });

  await openApplicantEditImpl(driver, cfg);
  assert.deepStrictEqual(clicked, ['Edit'], 'Add New Member must be skipped, not clicked');
});

test('the primary XPath strategy is tried first and is not text-guarded', async () => {
  const clicked = [];
  const primary = fakeAnchor('Primary Applicant Edit', clicked);
  const driver = fakeDriver({ xpath: [primary], css: [] });

  await openApplicantEditImpl(driver, cfg);
  assert.deepStrictEqual(clicked, ['Primary Applicant Edit']);
});

// ---- F1: the confirmation alert is the ONLY evidence the portal saved ------
//
// submitProfileFrame drives an iframe and a native JS alert. This fake models
// the three things that matter: whether Submit is findable, whether an alert
// ever appears, and whether the driver was left standing inside the frame.
const { createPortalActions } = require('../portalActions');

function frameDriver({ alert = 'Applicant updated successfully', submitFound = true } = {}) {
  const events = [];
  let alertOpen = alert !== null;
  return {
    events,
    wait: async () => {},
    sleep: async () => {},
    executeScript: async () => {},
    findElement: async () => ({ tag: 'iframe' }),
    findElements: async () => (submitFound
      ? [{ isDisplayed: async () => true, click: async () => { events.push('submit'); } }]
      : []),
    switchTo: () => ({
      frame: async () => { events.push('enter-frame'); },
      defaultContent: async () => { events.push('default-content'); },
      alert: async () => {
        if (!alertOpen) throw new Error('no such alert');
        return {
          getText: async () => alert,
          accept: async () => { alertOpen = false; events.push('accept-alert'); },
        };
      },
    }),
  };
}

const PA_CFG = { SLEEP: { LONG: 0, MEDIUM: 0, SHORT: 0 }, DROPDOWN: { TIMEOUT: 0 } };
const actions = () => createPortalActions({ email: 'e', password: 'p', cfg: PA_CFG, log: () => {} });

// The failure this guards: Proceed/Submit silently no-ops, no alert appears,
// and the caller records profileCity = Lahore while the portal is still on
// Islamabad. The Lahore combos then re-run Islamabad - two duplicated searches
// against an account that was blocked after fewer than ten - and a real
// Islamabad slot is announced at 3am as Lahore.
test('submitProfileFrame throws when no confirmation alert ever appears', async () => {
  const d = frameDriver({ alert: null });
  await assert.rejects(
    () => actions().submitProfileFrame(d),
    /no confirmation alert/i,
    'an unconfirmed profile edit must never be reported as a success'
  );
  assert.ok(d.events.includes('default-content'),
    'a failure must still never strand the driver inside the iframe');
});

test('submitProfileFrame accepts the alert and returns when one is seen', async () => {
  const d = frameDriver({ alert: 'Applicant updated successfully' });
  await actions().submitProfileFrame(d);
  assert.deepStrictEqual(d.events,
    ['enter-frame', 'submit', 'accept-alert', 'default-content']);
});

// This page has never been captured. The alert text is the only record of what
// it actually says, so the shakedown run must print it.
test('the alert text is logged as shakedown evidence', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await actions().submitProfileFrame(frameDriver({ alert: 'Applicant Updated Successfully' }));
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((l) => l.includes('Applicant Updated Successfully')),
    `alert text was never logged: ${JSON.stringify(lines)}`);
});

test('a missing Submit button still leaves the frame and still throws', async () => {
  const d = frameDriver({ submitFound: false, alert: null });
  await assert.rejects(() => actions().submitProfileFrame(d), /Submit button not found/);
  assert.ok(d.events.includes('default-content'),
    'the finally-block contract must survive the F1 change');
});

// ---- Dropdown option matching ------------------------------------------
//
// Matching used to be `=== || .includes()`, which made a config value a PREFIX
// pattern rather than a name. That is ambiguous whenever one option's text
// contains another's: Karachi lists both "National Visa" and "National Visas
// (Study, Work & Other National Visas)", and a needle of "National Visa"
// matches both. Which one got picked depended on DOM order.
//
// Matching is now equality, normalised for case and internal whitespace.

const { optionMatches } = require('../portalActions');

test('an exact option text matches', () => {
  assert.strictEqual(optionMatches('Family Reunification Visa', 'Family Reunification Visa'), true);
});

test('matching ignores case and surrounding space', () => {
  assert.strictEqual(optionMatches('  FAMILY reunification VISA ', 'Family Reunification Visa'), true);
});

// The portal renders "National Visa/ Long Term Visa" - space after the slash,
// none before. Selenium's getText() collapses runs of whitespace, but the
// config value is hand-typed, so internal spacing is normalised on both sides
// rather than trusted to agree character for character.
test('matching normalises internal whitespace', () => {
  assert.strictEqual(optionMatches('National Visa/  Long  Term Visa', 'National Visa/ Long Term Visa'), true);
});

// The whole point of the change.
test('a longer option is no longer matched by a shorter needle', () => {
  assert.strictEqual(
    optionMatches('National Visas (Study, Work & Other National Visas)', 'National Visa'),
    false,
  );
});

test('the two Karachi sub types are told apart', () => {
  const opts = ['National Visa', 'National Visas (Study, Work & Other National Visas)'];
  const hits = opts.filter((o) => optionMatches(o, 'National Visa'));
  assert.deepStrictEqual(hits, ['National Visa'], 'exactly one option may match');
});

// Equality makes the config value a full name, so the old abbreviations no
// longer resolve. Pinned so a half-finished revert is caught here rather than
// live on the portal.
test('an abbreviated config value no longer matches', () => {
  assert.strictEqual(optionMatches('Family Reunification Visa', 'Family Reunification'), false);
  assert.strictEqual(optionMatches('National Visa/ Long Term Visa', 'National Visa'), false);
});

test('the shipped config values match the option text the portal renders', () => {
  const CFG = require('../config');
  assert.strictEqual(optionMatches('National Visa/ Long Term Visa', CFG.FORM.VISA_TYPE), true);
  assert.strictEqual(optionMatches('Family Reunification Visa', CFG.FORM.VISA_SUB_TYPE), true);
  const karachi = CFG.CITIES.find((c) => c.name === 'Karachi');
  if (karachi) assert.strictEqual(optionMatches('National Visa', karachi.VISA_SUB_TYPE), true);
});
