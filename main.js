/**
 * The polling loop. Spawns one app.js run per cycle, then sleeps.
 *
 * It runs round the clock - there are no working hours and no morning or
 * afternoon cadence. The gap between cycles is drawn fresh from
 * [SCHEDULER.INTERVAL_MIN_MINUTES, SCHEDULER.INTERVAL_MAX_MINUTES] every time,
 * because a fixed cadence is the one thing a human checking a visa portal
 * never has: nobody searches at 08:00, 08:20 and 08:40 on the dot.
 *
 * Unlike the version this was adapted from, the loop READS the child's exit
 * code. Without that it cannot tell "no slots" from "blocked" from "the
 * browser died" and loops identically through all three - which for an
 * unattended day-long run means hammering through a block for hours and
 * leaving no record of when it started. A blocked cycle is the one case that
 * does NOT draw at random: it backs off from the upper limit and climbs.
 *
 * Two env vars exist so the schedule itself can be tested without touching
 * the portal or editing constants:
 *
 *   BOT_SCRIPT=stub.js   spawn something cheap instead of app.js
 *   TIME_SCALE=45        one virtual hour = 45 real seconds
 *
 * Both default to production behaviour when unset.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = require('./config');
const { createLogger, hourIn } = require('./logger');
const { notifyBotError } = require('./telegramNotifier');

const S = CFG.SCHEDULER;
const TZ = S.TIMEZONE || null;
const BOT_SCRIPT = process.env.BOT_SCRIPT || 'app.js';
const TIME_SCALE_S = Number(process.env.TIME_SCALE) || 0; // 0 = real clock

const logger = createLogger({
  dir: CFG.LOG.DIR,
  consoleLevel: CFG.LOG.CONSOLE_LEVEL,
  fileLevel: CFG.LOG.FILE_LEVEL,
  tz: TZ,
  tee: false, // the scheduler logs deliberately; the child tees its own console
});

const scaled = TIME_SCALE_S > 0;

// Under TIME_SCALE the clock is synthetic so a scaled test can watch a day's
// worth of intervals go by in a minute.
const hourMs = scaled ? TIME_SCALE_S * 1000 : 60 * 60 * 1000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// How long to wait after an ordinary cycle. Uniform over the configured
// limits, at SECONDS resolution - whole-minute gaps are still a pattern, and
// the entire point of drawing at all is to stop looking like a cron job.
//
// `rand` is a parameter so the tests can pin the endpoints without stubbing
// Math.random globally.
function nextIntervalMinutes(rand = Math.random) {
  const { INTERVAL_MIN_MINUTES: lo, INTERVAL_MAX_MINUTES: hi } = S;
  return Math.round((lo + rand() * (hi - lo)) * 60) / 60;
}

// Minutes -> ms, honouring TIME_SCALE so a scaled run does not sleep for real.
const intervalToMs = (min) => (scaled ? (min / 60) * hourMs : min * 60 * 1000);

// 26.6667 -> "26m 40s". Whole minutes still read as "20m", so the label does
// not get noisier for the cases where the draw happens to land round.
function fmtMinutes(min) {
  const totalS = Math.round(min * 60);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// One ledger row. `waitMin` replaces the old `mode` field: morning/afternoon
// stopped meaning anything when the loop went round the clock, and the gap the
// loop actually chose is the number you need to answer "how many searches in
// the last N hours". null means the loop stopped instead of waiting.
function ledgerEntry({ cycle, code, result, durationMs, waitMin }) {
  return {
    ts: new Date().toISOString(),
    cycle,
    exit: code,
    result,
    searches: readSearchTotal(),
    durationMs,
    waitMin: waitMin === null ? null : Number(waitMin.toFixed(2)),
  };
}

function recordCycle(entry) {
  try {
    fs.mkdirSync(path.dirname(CFG.LOG.CYCLES_FILE), { recursive: true });
    fs.appendFileSync(CFG.LOG.CYCLES_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    logger.warning('Sched', `Could not append to the cycle ledger: ${e.message}`);
  }
}

function runOnce() {
  return new Promise((resolve) => {
    // LOG_FILE makes the child append to THIS session's file rather than
    // opening one of its own.
    const child = spawn('node', [BOT_SCRIPT], {
      stdio: 'inherit',
      env: { ...process.env, LOG_FILE: logger.file },
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', (e) => {
      logger.error('Sched', `Could not spawn ${BOT_SCRIPT}: ${e.message}`);
      resolve(1);
    });
  });
}

function readSearchTotal() {
  try {
    return JSON.parse(fs.readFileSync(CFG.MACHINE.SEARCH_FILE, 'utf8')).searchesUsed ?? null;
  } catch (e) {
    return null;
  }
}

// Telegram must never take the scheduler down with it - a failed notification
// is strictly less important than the log line that records the halt.
async function tell(message) {
  try {
    await notifyBotError(message);
  } catch (e) {
    logger.warning('Sched', `Telegram notification failed: ${e.message}`);
  }
}

function searchLine() {
  const n = readSearchTotal();
  return n === null ? 'Search total unknown.' : `Searches used all time: ${n}.`;
}

// exit code -> what the loop should do about it.
//
// `blocked` is its own axis rather than a flavour of `failure`. Folding it
// into failure would eat MAX_CONSECUTIVE_FAILURES slots; folding it into the
// clean path would RESET that streak, and an alternating crash/block pattern
// would then never trip the failure cap at all.
function classify(code) {
  if (code === 0) return { result: 'NO_SLOTS', halt: false, failure: false, blocked: false };
  if (code === 10) return { result: 'SLOTS_FOUND', halt: true, failure: false, blocked: false };
  if (code === 20) return { result: 'UNKNOWN_TERMINAL', halt: false, failure: false, blocked: true };
  if (code === 30) return { result: 'GUARD_ABORT', halt: false, failure: true, blocked: false };
  return { result: 'CRASH', halt: false, failure: true, blocked: false };
}

// Streak bookkeeping, pure so the reset rule is testable without spawning a
// child. A cycle that gets through clears BOTH streaks - two blocks then a
// successful run means the run after it is paced by an ordinary random draw
// again, not by a multiplier still carrying blocks that are over.
function nextStreaks(prev, { blocked, failure }) {
  if (blocked) return { failures: prev.failures, blocks: prev.blocks + 1 };
  if (failure) return { failures: prev.failures + 1, blocks: prev.blocks };
  return { failures: 0, blocks: 0 };
}

// How long to wait after the nth consecutive block. The caller always passes
// INTERVAL_MAX_MINUTES as the base: n === 1 is therefore the slowest ORDINARY
// pace, and each further unbroken block multiplies it, up to the ceiling.
function blockWaitMinutes(baseMin, consecutiveBlocks) {
  const steps = Math.max(0, consecutiveBlocks - 1);
  const grown = baseMin * Math.pow(S.BLOCK_BACKOFF_MULTIPLIER, steps);
  // Strictly greater. A wait that lands exactly on the ceiling is legal and
  // passes through untouched.
  return grown > S.BLOCK_BACKOFF_MAX_MIN ? S.BLOCK_BACKOFF_MAX_MIN : grown;
}

async function loop() {
  logger.display('Sched', `Visa bot scheduler started (spawning ${BOT_SCRIPT}).`);
  // Loud, because this is silent otherwise: a stub spawns, exits 0, and the
  // loop reports healthy NO_SLOTS cycles forever without ever opening a
  // browser. Especially dangerous set in .env, which survives reboots.
  if (BOT_SCRIPT !== 'app.js') {
    logger.warning('Sched', '*'.repeat(64));
    logger.warning('Sched', `BOT_SCRIPT=${BOT_SCRIPT} - NOT running the real bot. No portal checks.`);
    logger.warning('Sched', 'Unset it (and remove it from .env) before any real run.');
    logger.warning('Sched', '*'.repeat(64));
  }
  logger.display('Sched', `Timezone ${TZ || 'machine-local'} - it is hour ${hourIn(TZ)} there now (machine is hour ${new Date().getHours()}).`);
  logger.display('Sched', `Running round the clock; each gap drawn at random from ${S.INTERVAL_MIN_MINUTES}-${S.INTERVAL_MAX_MINUTES}m.`);
  if (scaled) logger.warning('Sched', `TIME_SCALE=${TIME_SCALE_S} - 1 virtual hour = ${TIME_SCALE_S}s. NOT a real schedule.`);
  logger.display('Sched', `Logging to ${logger.file}`);

  let cycle = 0;
  let streaks = { failures: 0, blocks: 0 };

  while (true) {
    cycle += 1;
    const startedAt = Date.now();
    logger.display('Sched', `Cycle ${cycle} starting (hour ${hourIn(TZ)} in ${TZ || 'machine-local'}).`);

    const code = await runOnce();
    const verdict = classify(code);
    const { result, halt, blocked } = verdict;
    const durationMs = Date.now() - startedAt;

    logger.display('Sched', `Cycle ${cycle} finished: ${result} (exit ${code}) in ${Math.round(durationMs / 1000)}s.`);

    // SLOTS_FOUND is now the only outcome that stops the loop on its own.
    if (halt) {
      // app.js already fired the repeating alerts and is holding the browser.
      recordCycle(ledgerEntry({ cycle, code, result, durationMs, waitMin: null }));
      logger.display('Sched', 'SLOTS FOUND - stopping the loop. The browser is being held open by the run.');
      return;
    }

    const recovered = streaks.blocks > 0 && !blocked;
    streaks = nextStreaks(streaks, verdict);

    // Decided before the stop checks so the ledger can record what the loop
    // WOULD have waited even on a cycle that turns out to be the last.
    //
    // A blocked cycle does not draw. The randomness is there to look human
    // while polling, and a blocked bot is not polling - so a block goes
    // straight to the slowest ordinary pace and climbs from there.
    const waitMin = blocked
      ? blockWaitMinutes(S.INTERVAL_MAX_MINUTES, streaks.blocks)
      : nextIntervalMinutes();

    recordCycle(ledgerEntry({ cycle, code, result, durationMs, waitMin }));

    if (blocked) {
      logger.error('Sched', `Unrecognised terminal page - the likely block (${streaks.blocks}/${S.MAX_CONSECUTIVE_BLOCKS} consecutive). The capture is written; retrying rather than stopping.`);
      if (streaks.blocks >= S.MAX_CONSECUTIVE_BLOCKS) {
        logger.error('Sched', 'Still blocked after the whole retry budget - stopping rather than hammering.');
        await tell(`Stopped after cycle ${cycle}: still blocked after ${streaks.blocks} consecutive cycles (exit ${code}). ${searchLine()}`);
        return;
      }
      // Deliberately NO Telegram here. A block that is being retried is not an
      // event that needs a human: the loop handles it and says so in the log.
      // Telegram is reserved for the two things worth waking up for - the loop
      // STOPPING, and a slot (which app.js announces itself, repeatedly). A
      // message per block trains you to ignore the one that matters.
    } else if (recovered) {
      logger.display('Sched', 'Back in after the block - streak cleared, back to the ordinary random interval.');
    }

    if (streaks.failures > 0) {
      logger.warning('Sched', `${result} (${streaks.failures}/${S.MAX_CONSECUTIVE_FAILURES} consecutive).`);
      if (streaks.failures >= S.MAX_CONSECUTIVE_FAILURES) {
        logger.error('Sched', 'Too many consecutive failures - stopping rather than grinding.');
        await tell(`Stopped after cycle ${cycle}: ${S.MAX_CONSECUTIVE_FAILURES} consecutive failures (last was ${result}, exit ${code}). ${searchLine()}`);
        return;
      }
    }

    const waitMs = intervalToMs(waitMin);
    const label = scaled ? `${Math.round(waitMs / 1000)}s (scaled)` : fmtMinutes(waitMin);
    // The first block is not "backed off" from anything - it IS the upper
    // limit. Saying otherwise makes the log read as though a multiplier had
    // already been applied.
    const why = blocked
      ? ` (blocked ${streaks.blocks}x - ${waitMin > S.INTERVAL_MAX_MINUTES
          ? `backed off from ${S.INTERVAL_MAX_MINUTES}m`
          : `the ${S.INTERVAL_MAX_MINUTES}m upper limit`})`
      : ` (random draw from ${S.INTERVAL_MIN_MINUTES}-${S.INTERVAL_MAX_MINUTES}m)`;
    logger.display('Sched', `Next check in ${label}${why}.`);
    await sleep(waitMs);
  }
}

// Guarded like app.js: requiring this file must not start polling the portal.
if (require.main === module) loop();

module.exports = { classify, loop, nextStreaks, blockWaitMinutes, nextIntervalMinutes };
