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
