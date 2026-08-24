/**
 * Saves a page we have never seen before.
 *
 * Mirrors harvest.js: saved unconditionally, because the failures are the
 * valuable samples. Fires on SLOTS (no fixture exists), UNKNOWN (the page that
 * broke detection), UNKNOWN_REASON (likely the block message), and any
 * post-submit page that is not a known dead end.
 */
const fs = require('fs');
const path = require('path');
const { VIS_FN, CAPTCHA_LABEL_FN } = require('./pageState');

const DEFAULT_ROOT = path.join(__dirname, '..', 'Archive', 'Html_Pages', 'auto');

async function probeVisibility(driver) {
  return driver.executeScript(`
    ${VIS_FN}
    ${CAPTCHA_LABEL_FN}
    const seen = (sel) => [...document.querySelectorAll(sel)];
    const alerts = seen('.alert').filter(vis).map((e) => ({
      cls: e.className,
      text: e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300),
    }));
    return {
      // Box-labels are colour-camouflaged - a "visible" count is meaningless
      // here (all of them are). Record what the predicate actually resolves.
      captchaLabel: captchaLabel(),
      boxLabelsTotal: seen('.box-label').length,
      alerts,
      btnPrimary: seen('a.btn-primary').filter(vis).map((a) => a.getAttribute('href')),
      dropdowns: seen('span.k-dropdown-wrap').filter(vis).length,
      datepickers: seen('input[data-role="datepicker"]').filter(vis).length,
      passwords: seen('input[type="password"]').filter(vis).length,
      modals: seen('.modal').filter(vis).map((m) => m.id || '(no id)'),
      h5: seen('h5').filter(vis).map((e) => e.textContent.trim()).slice(0, 5),
    };
  `);
}

async function capturePage(driver, label, detected, root = DEFAULT_ROOT) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, `${stamp}_${label}`);
  fs.mkdirSync(dir, { recursive: true });

  const html = await driver.getPageSource();
  fs.writeFileSync(path.join(dir, 'page.html'), html, 'utf8');

  const probe = {
    url: await driver.getCurrentUrl(),
    state: detected && detected.state,
    reason: (detected && detected.reason) || null,
    capturedAt: new Date().toISOString(),
    visible: await probeVisibility(driver),
  };
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(probe, null, 2), 'utf8');

  return dir;
}

module.exports = { capturePage, probeVisibility, DEFAULT_ROOT };
