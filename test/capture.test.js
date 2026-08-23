const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withFixture, quitDriver } = require('./helpers');
const { capturePage } = require('../capture');

test.after(async () => { await quitDriver(); });

test('capturePage writes page.html and a visibility probe', async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  await withFixture('Book_New_Appointment_Captcha', async (d) => {
    const dir = await capturePage(d, 'CAPTCHA', { state: 'CAPTCHA', reason: null }, outRoot);
    assert.ok(fs.existsSync(path.join(dir, 'page.html')));
    const probe = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
    assert.strictEqual(probe.state, 'CAPTCHA');
    // The probe must record what the predicates actually resolve. Box-labels
    // are colour-camouflaged, so record the resolved label, NOT a count of
    // "visible" ones - all 39 report visible.
    assert.strictEqual(probe.visible.boxLabelsTotal, 39);
    assert.match(probe.visible.captchaLabel, /number \d{3}/);
    assert.ok(probe.url);
  });
});
