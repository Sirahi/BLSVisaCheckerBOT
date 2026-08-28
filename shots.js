/**
 * One screenshot per search, of whatever page the portal returned.
 *
 * Deliberately separate from capture.js. That module saves pages we have NEVER
 * SEEN - full DOM, probe, a directory each - and fires on the exceptional
 * states (SLOTS, UNKNOWN). This one fires on the most routine event there is,
 * ~60 times a day forever, so it saves a single flat PNG and prunes itself.
 *
 * WHY IT EXISTS: to be ground truth for what a search actually returned. The
 * log records the detector's VERDICT ("Karachi/Premium: no slots"), which is
 * worth nothing as evidence if the question on the table is whether the
 * detector read a slots-available page as no-slots. A picture is not a verdict.
 *
 * For the same reason the shot is taken in fillFormAndSubmit, straight after
 * the submit click, and NOT from a handler keyed on the detected state.
 * Hanging it off DEAD_END/NO_SLOTS would gate the evidence on the very
 * classification it exists to audit: a misread page would never be
 * photographed, which is precisely the case worth having a photograph of.
 */
const fs = require('fs');
const path = require('path');

// "Karachi/Premium" -> "Karachi-Premium". The label carries a slash, and a
// slash in a filename is a directory - the shots must stay flat so that
// sorting the folder by name sorts it by time.
const slug = (s) => String(s == null ? 'unknown' : s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

// ISO first, so lexical order IS chronological order - which is what makes the
// pruning below a plain sort, and what makes the folder readable at a glance.
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const isShot = (f) => f.endsWith('.png');

// Keep the newest `keep`, delete the rest. Only ever touches .png files: the
// directory belongs to the user too, and deleting something they put there
// would be a nasty surprise for a feature they asked to be quiet.
function prune(dir, keep) {
  if (!Number.isInteger(keep) || keep <= 0) return 0;
  const shots = fs.readdirSync(dir).filter(isShot).sort();
  const doomed = shots.slice(0, Math.max(0, shots.length - keep));
  let removed = 0;
  for (const f of doomed) {
    try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch (e) { /* already gone */ }
  }
  return removed;
}

/**
 * @returns {Promise<string|null>} the file written, or null - never throws.
 *
 * This runs immediately after a REAL search has been spent against a budget
 * the portal blocks you for exceeding. A failed screenshot must never turn a
 * completed search into a failed cycle, so every path here swallows.
 */
async function saveResultShot(driver, { label, dir, keep = 200, log = () => {}, enabled = true } = {}) {
  if (!enabled) return null;
  try {
    // Ordered so a disabled or unwritable destination costs no round-trip to
    // the browser.
    fs.mkdirSync(dir, { recursive: true });
    const png = await driver.takeScreenshot();
    const file = path.join(dir, `${stamp()}_${slug(label)}_result.png`);
    fs.writeFileSync(file, png, 'base64');
    prune(dir, keep);
    return file;
  } catch (e) {
    log(`Result screenshot failed (non-critical): ${e.message}`);
    return null;
  }
}

module.exports = { saveResultShot, prune, slug };
