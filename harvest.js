/**
 * Captcha tile harvesting.
 *
 * Every live run dumps its captcha tiles into ../captcha-lab/harvest/ so the
 * offline benchmark corpus grows each time the bot runs. Tiles are saved
 * UNCONDITIONALLY - whether the captcha was solved or not - because the tiles
 * the OCR got wrong are the most valuable samples we can collect.
 *
 * Nothing here may ever break a run: every operation is wrapped, and any
 * failure is swallowed after a single warning.
 */

const fs = require('fs');
const path = require('path');

const HARVEST_ROOT = path.join(__dirname, '..', 'captcha-lab', 'harvest');

let session = null;
let warned = false;

function warnOnce(e) {
  if (!warned) {
    warned = true;
    console.log(`⚠️ Tile harvesting disabled (${e.message})`);
  }
}

/**
 * Begin a harvest session for one captcha challenge.
 * @param {string} targetNumber - the number the challenge asks for
 * @param {string} kind - 'login' | 'entry' | 'retry' etc, for context
 */
function startChallenge(targetNumber, kind = 'unknown') {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(HARVEST_ROOT, `${ts}_${kind}_target-${targetNumber}`);
    fs.mkdirSync(dir, { recursive: true });
    session = {
      dir,
      target: targetNumber,
      kind,
      startedAt: new Date().toISOString(),
      tiles: [],
    };
  } catch (e) {
    session = null;
    warnOnce(e);
  }
}

/**
 * Save one tile image plus what the OCR made of it.
 * @param {number} index - tile position index
 * @param {string} base64src - the img src, i.e. "data:image/gif;base64,...."
 * @param {object} result - { text, votes, configs } from the OCR voting, may be null
 * @param {boolean} clicked - whether the bot clicked this tile
 */
function saveTile(index, base64src, result, clicked) {
  if (!session) return;
  try {
    const m = /^data:image\/([a-zA-Z0-9]+);base64,(.+)$/.exec(base64src || '');
    if (!m) return;
    const ext = m[1].toLowerCase();
    const name = `tile_${String(index).padStart(2, '0')}.${ext}`;
    fs.writeFileSync(path.join(session.dir, name), Buffer.from(m[2], 'base64'));
    session.tiles.push({
      file: name,
      index,
      ocr: (result && result.text) || null,
      votes: (result && result.votes) || 0,
      configs: (result && result.configs) || [],
      clicked: !!clicked,
      // matchesTarget is what the bot BELIEVED. It is not ground truth -
      // labelling still needs a human eye on the image.
      matchesTarget: !!(result && result.text === session.target),
    });
  } catch (e) {
    warnOnce(e);
  }
}

/**
 * Close the session and write the manifest.
 * @param {object} outcome - { solved, clickedCount, scanned, note }
 */
function endChallenge(outcome = {}) {
  if (!session) return;
  try {
    const manifest = {
      target: session.target,
      kind: session.kind,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      outcome,
      tileCount: session.tiles.length,
      // Tiles the OCR could not read at all: the highest-value samples.
      unreadable: session.tiles.filter(t => !t.ocr).map(t => t.file),
      tiles: session.tiles,
    };
    fs.writeFileSync(
      path.join(session.dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    const unread = manifest.unreadable.length;
    console.log(
      `🗂  Harvested ${session.tiles.length} tiles -> ${path.relative(path.join(__dirname, '..'), session.dir)}` +
      (unread ? `  (${unread} unreadable)` : '')
    );
  } catch (e) {
    warnOnce(e);
  } finally {
    session = null;
  }
}

module.exports = { startChallenge, saveTile, endChallenge };
