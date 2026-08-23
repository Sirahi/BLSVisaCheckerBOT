const test = require('node:test');
const assert = require('node:assert');
const { By } = require('selenium-webdriver');
const { withFixture, quitDriver } = require('./helpers');
const { STATES, detect } = require('../pageState');

test.after(async () => { await quitDriver(); });

// GATE: if this fails, computed visibility does not survive file:// and the
// rest of the offline suite cannot be trusted. Stop and re-plan.
test('visibility survives file:// - only 1 of 40 box-labels is visible', async () => {
  await withFixture('Book_New_Appointment_Captcha', async (d) => {
    const all = await d.findElements(By.css('div.box-label'));
    assert.ok(all.length > 30, `expected many decoys, got ${all.length}`);
    let shown = 0;
    for (const el of all) { try { if (await el.isDisplayed()) shown++; } catch (e) {} }
    assert.strictEqual(shown, 1, `expected exactly 1 visible box-label, got ${shown}`);
  });
});

test('detect fails closed on a page it does not recognise', async () => {
  const { getDriver } = require('./helpers');
  const d = await getDriver();
  await d.get('data:text/html,<html><body><p>nothing here</p></body></html>');
  const r = await detect(d, 'https://example.com/');
  assert.strictEqual(r.state, STATES.UNKNOWN);
});
