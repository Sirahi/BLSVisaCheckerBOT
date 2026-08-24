/**
 * Unreal-style logging: [timestamp][Category] Level: message
 *
 * Written to disk AS IT HAPPENS, not dumped at exit. This is deliberate:
 * when Node's stdout is a pipe rather than a TTY, writes become asynchronous
 * and buffered, so a hard crash (chromedriver death, unhandled rejection)
 * loses whatever is still in the buffer - which is exactly the lines that
 * explain the crash. Writing from inside the process avoids that.
 *
 * Every write is synchronous. A buffered stream both reorders lines against
 * the sync appends that Error needs and loses its buffer on a hard crash -
 * each time losing the context that explains the failure. At a few hundred
 * lines per run the cost is not measurable.
 *
 * main.js and app.js append to the SAME daily file, so a long unattended run
 * reads as one continuous story instead of N disconnected fragments.
 */
const fs = require('fs');
const path = require('path');

const LEVELS = { Error: 0, Warning: 1, Display: 2, Log: 3, Verbose: 4 };
const CAT_WIDTH = 7;
const LVL_WIDTH = 9;

// Every wall-clock reading in this project goes through one timezone, set by
// CFG.SCHEDULER.TIMEZONE. The machine is not necessarily in the same zone as
// the portal, and the offset between them is not even constant - Europe/London
// is UTC+1 in summer and UTC+0 in winter while Asia/Karachi is UTC+5 all year.
// Reading a log at 3am is no time to be doing that arithmetic.
function partsIn(tz, d) {
  if (!tz) {
    return {
      y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(),
      h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(),
    };
  }
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    y: +f.year, mo: +f.month, da: +f.day,
    h: +f.hour, mi: +f.minute, s: +f.second,
  };
}

// Returns the hour 0-23 in the given zone. This is what the scheduler's
// working-hours arithmetic runs on.
function hourIn(tz, d = new Date()) {
  return partsIn(tz, d).h;
}

// [2026.08.24-00.17.19:705]
function stamp(d = new Date(), tz = null) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const t = partsIn(tz, d);
  return `[${t.y}.${p(t.mo)}.${p(t.da)}-${p(t.h)}.${p(t.mi)}.${p(t.s)}:` +
         `${p(d.getMilliseconds(), 3)}]`;
}

function format(category, level, message, d = new Date(), tz = null) {
  const cat = String(category).slice(0, CAT_WIDTH).padEnd(CAT_WIDTH);
  const lvl = `${level}:`.padEnd(LVL_WIDTH);
  return `${stamp(d, tz)}[${cat}] ${lvl}${message}`;
}

// One file per scheduler SESSION, not per process. main.js stamps the name
// once and hands it to every child through LOG_FILE, so the scheduler's lines
// and all N runs interleave into a single readable story instead of
// fragmenting into a file per cycle.
function sessionFile(dir, d = new Date(), tz = null) {
  const p = (n) => String(n).padStart(2, '0');
  const t = partsIn(tz, d);
  return path.join(dir, `${t.y}-${p(t.mo)}-${p(t.da)}_${p(t.h)}${p(t.mi)}${p(t.s)}.log`);
}

function createLogger({ dir, consoleLevel = 'Display', fileLevel = 'Verbose', tee = true, tz = null, file: fileOverride = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // Precedence: explicit > inherited from the scheduler > a fresh session file.
  const file = fileOverride || process.env.LOG_FILE || sessionFile(dir, new Date(), tz);

  const consoleMax = LEVELS[consoleLevel] ?? LEVELS.Display;
  const fileMax = LEVELS[fileLevel] ?? LEVELS.Verbose;

  // Captured before the console tee is installed, so writing a log line can
  // never recurse back into the tee.
  const rawLog = console.log.bind(console);
  const rawErr = console.error.bind(console);

  function write(category, level, message) {
    const line = format(category, level, message, new Date(), tz);
    if (LEVELS[level] <= fileMax) {
      try {
        fs.appendFileSync(file, line + '\n');
      } catch (e) {
        // Never throw from logging.
      }
    }
    if (LEVELS[level] <= consoleMax) (level === 'Error' ? rawErr : rawLog)(line);
  }

  const api = { file, format, write };
  for (const level of Object.keys(LEVELS)) {
    api[level.toLowerCase()] = (category, message) => write(category, level, message);
  }

  // The codebase logs two ways: the injected log() in app.js, and direct
  // console.log(MSG.X) in portalActions/captchaSolver. Rather than rewrite all
  // 130 message sites, mirror the console into the file under a default
  // category so nothing is lost.
  api.teeConsole = (category = 'Bot') => {
    if (!tee) return;
    console.log = (...a) => write(category, 'Log', a.join(' '));
    console.error = (...a) => write(category, 'Error', a.join(' '));
  };

  api.close = () => Promise.resolve(); // nothing buffered; kept for API stability
  return api;
}

module.exports = { createLogger, format, stamp, sessionFile, hourIn, partsIn, LEVELS };
