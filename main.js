/**
 * The polling loop. Spawns one app.js run per cycle, then sleeps.
 *
 * Unlike the version this was adapted from, the loop READS the child's exit
 * code. Without that it cannot tell "no slots" from "blocked" from "the
 * browser died" and loops identically through all three - which for an
 * unattended day-long run means hammering through a block for hours and
 * leaving no record of when it started.
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
const { createLogger, hourIn, partsIn } = require('./logger');
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

const T0 = Date.now();
const scaled = TIME_SCALE_S > 0;

// Under TIME_SCALE the whole clock is synthetic, including the night wait -
// otherwise a scaled test would sleep for real hours at the day boundary.
const hourMs = scaled ? TIME_SCALE_S * 1000 : 60 * 60 * 1000;
// Working hours are the PORTAL's hours, not the machine's - see
// SCHEDULER.TIMEZONE. Reading getHours() here would have run the schedule on
// London time, i.e. 12:00-04:00 in Pakistan.
const currentHour = () =>
  scaled ? Math.floor((Date.now() - T0) / hourMs) % 24 : hourIn(TZ);

const isWorkingHours = () => {
  const h = currentHour();
  return h >= S.WORK_START_HOUR && h < S.WORK_END_HOUR;
};
const isMorning = () => {
  const h = currentHour();
  return h >= S.WORK_START_HOUR && h < S.MORNING_END_HOUR;
};

// Whole hours are not enough here. Counting only the hour number made 05:30
// "3 hours short of hour 8", so the night sleep overshot by the 30 minutes
// already spent inside the current hour and the morning burst began at 08:30 -
// half an hour of the most valuable window gone. Wait to the TOP of the hour.
function msUntilWorkStart(now = new Date()) {
  if (scaled) {
    // The scaled clock is a continuous ramp, so the fractional virtual hour is
    // just elapsed time; there are no wall-clock parts to read.
    const h = ((now.getTime() - T0) / hourMs) % 24;
    const hoursToWait = h < S.WORK_START_HOUR
      ? S.WORK_START_HOUR - h
      : 24 - h + S.WORK_START_HOUR;
    return hoursToWait * hourMs;
  }
  const t = partsIn(TZ, now);
  const hoursToWait = t.h < S.WORK_START_HOUR
    ? S.WORK_START_HOUR - t.h
    : 24 - t.h + S.WORK_START_HOUR;
  const msIntoHour = t.mi * 60000 + t.s * 1000 + now.getMilliseconds();
  return hoursToWait * hourMs - msIntoHour;
}

const fmt = (ms) => `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
// successful run means the run after it is paced by the ordinary
// morning/afternoon interval again, not by a multiplier still carrying blocks
// that are over.
function nextStreaks(prev, { blocked, failure }) {
  if (blocked) return { failures: prev.failures, blocks: prev.blocks + 1 };
  if (failure) return { failures: prev.failures + 1, blocks: prev.blocks };
  return { failures: 0, blocks: 0 };
}

// A block is the portal rate-limiting the day's activity, and a night off is
// exactly the remedy - so the block streak does NOT survive the night sleep.
// Carrying it over meant an evening spent blocked resumed the next morning
// mid-backoff, spending the most valuable window of the day on 120m waits
// instead of a fresh 20m burst. The failure streak is untouched: a crash streak
// is a broken setup, and sleeping does not fix chromedriver.
function afterNightSleep(streaks) {
  return { failures: streaks.failures, blocks: 0 };
}

// How long to wait after the nth consecutive block. n === 1 is the ordinary
// interval for the time of day; each further unbroken block multiplies it, up
// to the ceiling.
function blockWaitMinutes(baseMin, consecutiveBlocks) {
  const steps = Math.max(0, consecutiveBlocks - 1);
  const grown = baseMin * Math.pow(S.BLOCK_BACKOFF_MULTIPLIER, steps);
  return Math.min(grown, S.BLOCK_BACKOFF_MAX_MIN);
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
  // hourIn, not currentHour - the banner must state the REAL portal hour even
  // when TIME_SCALE has replaced the clock underneath the loop.
  logger.display('Sched', `Timezone ${TZ || 'machine-local'} - it is hour ${hourIn(TZ)} there now (machine is hour ${new Date().getHours()}).`);
  logger.display('Sched', `Hours ${S.WORK_START_HOUR}-${S.WORK_END_HOUR}; morning until ${S.MORNING_END_HOUR} every ${S.MORNING_INTERVAL_MIN}m, then every ${S.AFTERNOON_INTERVAL_MIN}m.`);
  if (scaled) logger.warning('Sched', `TIME_SCALE=${TIME_SCALE_S} - 1 virtual hour = ${TIME_SCALE_S}s. NOT a real schedule.`);
  logger.display('Sched', `Logging to ${logger.file}`);

  let cycle = 0;
  let streaks = { failures: 0, blocks: 0 };

  while (true) {
    if (!isWorkingHours()) {
      const wait = msUntilWorkStart();
      const label = scaled
        ? `${(wait / hourMs).toFixed(1)} virtual hours (${Math.round(wait / 1000)}s real)`
        : fmt(wait);
      logger.display('Sched', `Outside working hours - sleeping ${label} until hour ${S.WORK_START_HOUR}.`);
      await sleep(wait);
      if (streaks.blocks > 0) {
        logger.display('Sched', `New day - clearing a block streak of ${streaks.blocks}; the morning starts at the ordinary ${S.MORNING_INTERVAL_MIN}m interval.`);
      }
      streaks = afterNightSleep(streaks);
      continue;
    }

    cycle += 1;
    const morning = isMorning();
    const startedAt = Date.now();
    logger.display('Sched', `Cycle ${cycle} starting (${morning ? 'morning' : 'afternoon'}, virtual hour ${currentHour()}).`);

    const code = await runOnce();
    const verdict = classify(code);
    const { result, halt, blocked } = verdict;
    const durationMs = Date.now() - startedAt;

    recordCycle({
      ts: new Date().toISOString(),
      cycle,
      exit: code,
      result,
      searches: readSearchTotal(),
      durationMs,
      mode: morning ? 'morning' : 'afternoon',
    });

    logger.display('Sched', `Cycle ${cycle} finished: ${result} (exit ${code}) in ${Math.round(durationMs / 1000)}s.`);

    // SLOTS_FOUND is now the only outcome that stops the loop on its own.
    if (halt) {
      // app.js already fired the repeating alerts and is holding the browser.
      logger.display('Sched', 'SLOTS FOUND - stopping the loop. The browser is being held open by the run.');
      return;
    }

    const recovered = streaks.blocks > 0 && !blocked;
    streaks = nextStreaks(streaks, verdict);

    if (blocked) {
      logger.error('Sched', `Unrecognised terminal page - the likely block (${streaks.blocks}/${S.MAX_CONSECUTIVE_BLOCKS} consecutive). The capture is written; retrying rather than stopping.`);
      if (streaks.blocks >= S.MAX_CONSECUTIVE_BLOCKS) {
        logger.error('Sched', 'Still blocked after the whole retry budget - stopping rather than hammering.');
        await tell(`Stopped after cycle ${cycle}: still blocked after ${streaks.blocks} consecutive cycles (exit ${code}). ${searchLine()}`);
        return;
      }
      // Only the FIRST block of a streak notifies. The repeats are expected
      // from here on, and a Telegram every 20 minutes all afternoon trains you
      // to ignore the one that matters.
      if (streaks.blocks === 1) {
        await tell(`Cycle ${cycle}: blocked (unrecognised terminal page, exit ${code}). Retrying with backoff instead of stopping; giving up after ${S.MAX_CONSECUTIVE_BLOCKS} consecutive blocks. ${searchLine()}`);
      }
    } else if (recovered) {
      logger.display('Sched', 'Back in after the block - streak cleared, back to the ordinary interval.');
      await tell(`Cycle ${cycle}: back in after the block (${result}). Normal pacing resumed. ${searchLine()}`);
    }

    if (streaks.failures > 0) {
      logger.warning('Sched', `${result} (${streaks.failures}/${S.MAX_CONSECUTIVE_FAILURES} consecutive).`);
      if (streaks.failures >= S.MAX_CONSECUTIVE_FAILURES) {
        logger.error('Sched', 'Too many consecutive failures - stopping rather than grinding.');
        await tell(`Stopped after cycle ${cycle}: ${S.MAX_CONSECUTIVE_FAILURES} consecutive failures (last was ${result}, exit ${code}). ${searchLine()}`);
        return;
      }
    }

    const baseInterval = morning ? S.MORNING_INTERVAL_MIN : S.AFTERNOON_INTERVAL_MIN;
    const interval = blocked ? blockWaitMinutes(baseInterval, streaks.blocks) : baseInterval;
    const waitMs = scaled ? (interval / 60) * hourMs : interval * 60 * 1000;
    const label = scaled ? Math.round(waitMs / 1000) + 's (scaled)' : Math.round(interval) + 'm';
    const backedOff = blocked && interval !== baseInterval ? ` (backed off from ${baseInterval}m)` : '';
    logger.display('Sched', `Next check in ${label}${backedOff}.`);
    await sleep(waitMs);
  }
}

// Guarded like app.js: requiring this file must not start polling the portal.
if (require.main === module) loop();

module.exports = { classify, loop, msUntilWorkStart, nextStreaks, blockWaitMinutes, afterNightSleep };
