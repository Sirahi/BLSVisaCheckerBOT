const test = require('node:test');
const assert = require('node:assert');
const { By } = require('selenium-webdriver');
const { withFixture, quitDriver } = require('./helpers');
const { STATES, detect } = require('../pageState');

test.after(async () => { await quitDriver(); });

// GATE: computed visibility must work for ORDINARY elements over file://.
// Captcha box-labels are deliberately excluded - they are camouflaged by
// colour, not hidden, and all 39 report visible. See the spec.
test('computed visibility survives file:// for ordinary elements', async () => {
  await withFixture('Book_New_Appointment_Visa_Type_Selection', async (d) => {
    const modals = await d.findElements(By.css('.modal'));
    assert.ok(modals.length >= 7, `expected pre-rendered modals, got ${modals.length}`);
    let shown = 0;
    for (const el of modals) { try { if (await el.isDisplayed()) shown++; } catch (e) {} }
    assert.ok(shown < modals.length,
      `CSS did not apply over file:// - all ${modals.length} modals report visible`);
  });
});

// The decoys are painted the background colour. isDisplayed() is useless here;
// the real label is the only one with a colour the others do not share.
test('exactly one box-label is the odd colour out', async () => {
  await withFixture('Book_New_Appointment_Captcha', async (d) => {
    const counts = await d.executeScript(`
      const c = {};
      document.querySelectorAll('.box-label').forEach((e) => {
        const k = getComputedStyle(e).color; c[k] = (c[k] || 0) + 1;
      });
      return c;
    `);
    const unique = Object.entries(counts).filter(([, n]) => n === 1);
    assert.strictEqual(unique.length, 1,
      `expected 1 odd-colour-out label, got ${unique.length}: ${JSON.stringify(counts)}`);
  });
});

test('detect fails closed on a page it does not recognise', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get('data:text/html,<html><body><p>nothing here</p></body></html>');
  const r = await detect(d, 'https://example.com/');
  assert.strictEqual(r.state, STATES.UNKNOWN);
});

const { REASONS } = require('../pageState');
const { fixtureUrl } = require('./fixtures');

test('TryAgain is a dead end meaning NO_SLOTS', async () => {
  await withFixture('TryAgain', async (d) => {
    const r = await detect(d, fixtureUrl('TryAgain'));
    assert.strictEqual(r.state, STATES.DEAD_END);
    assert.strictEqual(r.reason, REASONS.NO_SLOTS);
    assert.match(r.evidence, /no slots are available/i);
  });
});

test('Go_To_Home is a dead end meaning CAPTCHA_INVALID', async () => {
  await withFixture('Go_To_Home', async (d) => {
    const r = await detect(d, fixtureUrl('Go_To_Home'));
    assert.strictEqual(r.state, STATES.DEAD_END);
    assert.strictEqual(r.reason, REASONS.CAPTCHA_INVALID);
    assert.match(r.evidence, /captcha/i);
  });
});

// The form page has #div-main + an alert-warning + 6 btn-primary. It must NOT
// be mistaken for a dead end, because DEAD_END is checked first.
test('the Visa Type form is NOT a dead end despite #div-main and an alert', async () => {
  await withFixture('Book_New_Appointment_Visa_Type_Selection', async (d) => {
    const r = await detect(d, fixtureUrl('Book_New_Appointment_Visa_Type_Selection'));
    assert.notStrictEqual(r.state, STATES.DEAD_END);
  });
});

test('the login page with password + captcha is LOGIN_CAPTCHA', async () => {
  await withFixture('LoginPage_Captcha_And_Password', async (d) => {
    const r = await detect(d, fixtureUrl('LoginPage_Captcha_And_Password'));
    assert.strictEqual(r.state, STATES.LOGIN_CAPTCHA);
  });
});

test('the appointment captcha page is CAPTCHA', async () => {
  await withFixture('Book_New_Appointment_Captcha', async (d) => {
    const r = await detect(d, fixtureUrl('Book_New_Appointment_Captcha'));
    assert.strictEqual(r.state, STATES.CAPTCHA);
  });
});

test('the second captcha capture is also CAPTCHA', async () => {
  await withFixture('Captcha', async (d) => {
    const r = await detect(d, fixtureUrl('Captcha'));
    assert.strictEqual(r.state, STATES.CAPTCHA);
  });
});

test('CAPTCHA evidence carries the target number', async () => {
  await withFixture('Book_New_Appointment_Captcha', async (d) => {
    const r = await detect(d, fixtureUrl('Book_New_Appointment_Captcha'));
    assert.match(r.evidence, /\d{3}/);
  });
});

for (const name of [
  'Book_New_Appointment_Visa_Type_Selection',
  'Book_New_Appointment_Visa_Type_Selection_National_Visa_Type_Popup',
  'Book_New_Appointment_Visa_Type_Selection_Premium_Category_Popup',
]) {
  test(`${name} is VISA_FORM`, async () => {
    await withFixture(name, async (d) => {
      const r = await detect(d, fixtureUrl(name));
      assert.strictEqual(r.state, STATES.VISA_FORM);
    });
  });
}

// No SLOTS capture exists, so assert the guarantee that matters: the form page
// must never be claimed by the SLOTS predicate, which is checked first.
test('SLOTS does not steal the form page', async () => {
  await withFixture('Book_New_Appointment_Visa_Type_Selection', async (d) => {
    const r = await detect(d, fixtureUrl('Book_New_Appointment_Visa_Type_Selection'));
    assert.notStrictEqual(r.state, STATES.SLOTS);
  });
});

// Synthetic: a datepicker is enough to mean SLOTS.
test('a visible datepicker is SLOTS', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get('data:text/html,' + encodeURIComponent(
    '<html><body><input class="k-input" data-role="datepicker" ' +
    'style="width:200px;height:30px"></body></html>'
  ));
  const r = await detect(d, 'https://appointment.thespainvisa.com/Global/Appointment/VisaType');
  assert.strictEqual(r.state, STATES.SLOTS);
});

test('the login page is LOGIN_EMAIL', async () => {
  await withFixture('LoginPage', async (d) => {
    const r = await detect(d, fixtureUrl('LoginPage'));
    assert.strictEqual(r.state, STATES.LOGIN_EMAIL);
  });
});

test('the Book Now page is HOME', async () => {
  await withFixture('Book_Now_Button_Page', async (d) => {
    const r = await detect(d, fixtureUrl('Book_Now_Button_Page'));
    assert.strictEqual(r.state, STATES.HOME);
  });
});

// The nav bar carries the same href on every page. HOME must not match here.
test('the form page is not HOME even though the nav has the Book Now href', async () => {
  await withFixture('Book_New_Appointment_Visa_Type_Selection', async (d) => {
    const r = await detect(d, fixtureUrl('Book_New_Appointment_Visa_Type_Selection'));
    assert.strictEqual(r.state, STATES.VISA_FORM);
  });
});

test('the captcha page is not HOME even though the nav has the Book Now href', async () => {
  await withFixture('Captcha', async (d) => {
    const r = await detect(d, fixtureUrl('Captcha'));
    assert.strictEqual(r.state, STATES.CAPTCHA);
  });
});

test('an outage page is UNAVAILABLE', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get('data:text/html,' + encodeURIComponent(
    '<html><body><h1>Application Temporarily Unavailable</h1></body></html>'
  ));
  const r = await detect(d, 'https://appointment.thespainvisa.com/Global/home/index');
  assert.strictEqual(r.state, STATES.UNAVAILABLE);
});

const MYAPPTS_URL = 'https://appointment.thespainvisa.com/Global/appointmentdata/MyAppointments';

async function onHtml(html, url) {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get('data:text/html,' + encodeURIComponent(html));
  return detect(d, url);
}

test('the applicant list is PROFILE_LIST', async () => {
  const r = await onHtml(
    `<div class="row border">Primary Applicant
       <a href="#" onclick="ManageApplicant('x')">Edit</a>
     </div>`, MYAPPTS_URL);
  assert.strictEqual(r.state, STATES.PROFILE_LIST);
});

test('PROFILE_LIST needs the URL, not just the link', async () => {
  const r = await onHtml(
    `<a href="#" onclick="ManageApplicant('x')">Edit</a>`,
    'https://appointment.thespainvisa.com/Global/home/index');
  assert.notStrictEqual(r.state, STATES.PROFILE_LIST);
});

test('the location modal is PROFILE_FORM', async () => {
  const r = await onHtml(
    `<div class="modal-content">
       <div class="modal-body"><label class="form-label">Location*</label></div>
       <div class="modal-footer"><button onclick="VisaTypeProceed();">Proceed</button></div>
     </div>`, MYAPPTS_URL);
  assert.strictEqual(r.state, STATES.PROFILE_FORM);
});

test('a hidden modal is not PROFILE_FORM', async () => {
  const r = await onHtml(
    `<div class="modal-content" style="display:none">
       <label class="form-label">Location*</label>
       <button>Proceed</button>
     </div>`, MYAPPTS_URL);
  assert.notStrictEqual(r.state, STATES.PROFILE_FORM);
});

test('the kendo iframe is PROFILE_CONFIRM and beats the modal behind it', async () => {
  const r = await onHtml(
    `<div class="modal-content">
       <label class="form-label">Location*</label><button>Proceed</button>
     </div>
     <iframe class="k-content-frame" style="width:400px;height:300px"></iframe>`, MYAPPTS_URL);
  assert.strictEqual(r.state, STATES.PROFILE_CONFIRM);
});

test('a datepicker on MyAppointments does not masquerade as SLOTS', async () => {
  const r = await onHtml(
    `<div class="row border">Primary Applicant
       <a href="#" onclick="ManageApplicant('x')">Edit</a>
     </div>
     <input data-role="datepicker" style="width:200px;height:30px">`, MYAPPTS_URL);
  assert.strictEqual(r.state, STATES.PROFILE_LIST,
    'profile predicates must be ordered ahead of the deliberately-loose slots predicate');
});

// ---- F6: slots must never fire on MyAppointments -------------------------
//
// profileList is URL-pinned AND requires a[onclick*="ManageApplicant"]. The
// real page has never been captured; if it turns out to use
// <button onclick="ManageApplicant..."> instead of <a>, profileList misses,
// and the deliberately-loose slots predicate - any visible datepicker - fires
// a FALSE slots alert on an appointments page. Waking a human at 3am for
// nothing is this project's worst failure mode.
const MY_APPTS = 'https://appointment.thespainvisa.com/Global/appointmentdata/MyAppointments';
const NEW_APPT = 'https://appointment.thespainvisa.com/Global/appointment/newappointment';
const DATEPICKER_PAGE =
  'data:text/html,<html><body><input class="k-input" data-role="datepicker" ' +
  'style="width:220px;height:32px"></body></html>';

test('a datepicker on MyAppointments is NOT a slots page', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get(DATEPICKER_PAGE);
  const r = await detect(d, MY_APPTS);
  assert.notStrictEqual(r.state, STATES.SLOTS,
    'a MyAppointments datepicker must never fire the 3am alert');
});

// The guard cannot hide a real slot: the genuine slots page lives on
// /appointment/newappointment, which the guard does not touch.
test('the same datepicker on the booking url IS still a slots page', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get(DATEPICKER_PAGE);
  const r = await detect(d, NEW_APPT);
  assert.strictEqual(r.state, STATES.SLOTS);
});

test('the guard does not stop MyAppointments being detected as PROFILE_LIST', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get(
    'data:text/html,<html><body>' +
    '<a onclick="ManageApplicant(1)" style="display:block;width:80px;height:20px">Edit</a>' +
    '<input class="k-input" data-role="datepicker" style="width:220px;height:32px">' +
    '</body></html>'
  );
  const r = await detect(d, MY_APPTS);
  assert.strictEqual(r.state, STATES.PROFILE_LIST);
});
