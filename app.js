/**
 * Entry point. One run of the state machine, then exit.
 *
 * All navigation logic lives in runner.js / handlers.js / pageState.js.
 * This file only wires things together, decides an exit code, and - on the one
 * path that matters - keeps the browser alive instead of closing it.
 */
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const CFG = require('./config');
const MSG = require('./messages');
const { detect } = require('./pageState');
const { createBudget } = require('./budget');
const { createHandlers } = require('./handlers');
const { createPortalActions } = require('./portalActions');
const { createLogger } = require('./logger');
const { run } = require('./runner');
const { shutdownOCR } = require('./captchaSolver');

require('dotenv').config();

/**
 * Exit codes. main.js branches on these - without them the scheduler cannot
 * tell "no slots" from "blocked" from "the browser died", and loops
 * identically through all three.
 *
 *    0  nothing found, keep polling
 *   10  SLOTS FOUND      - stop everything
 *   20  unrecognised terminal page - a human should look at the capture.
 *   21  CONFIRMED block - the portal said so in as many words. Same back-off
 *        as 20, but the log can stop hedging about which one it was.
 *   30  a guard tripped  - transient, tolerate a few in a row
 *    1  crashed
 */
const EXIT = {
  NO_SLOTS: 0,
  SLOTS_FOUND: 10,
  UNKNOWN_REASON: 20,
  UNKNOWN_PAGE: 20,
  // Separate from UNKNOWN_PAGE on purpose. Both back off identically, but one
  // means "the detector has never seen this page" and the other means "the
  // portal served us its rate-limit page". Sharing a code made the log report
  // a known, expected, self-correcting rate limit as a mystery needing a human.
  BLOCKED: 21,
  BUDGET_EXHAUSTED: 30,
  OSCILLATING: 30,
  NO_HANDLER: 30,
  TRANSITION_CAP: 30,
  PLAN_EXHAUSTED: 30,
  // The run tried to spend more searches than it has plan items. Transient by
  // design - the next cycle rebuilds the plan and gets a fresh ceiling - so it
  // is a guard abort, not a crash.
  SEARCH_CEILING: 30,
  // A handler threw and runner.js caught it so the cycle could still report its
  // results. Transient in the same way a guard abort is: the next cycle retries.
  HANDLER_ERROR: 30,
};
const EXIT_FATAL = 1;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  const logger = createLogger({
    dir: CFG.LOG.DIR,
    consoleLevel: CFG.LOG.CONSOLE_LEVEL,
    fileLevel: CFG.LOG.FILE_LEVEL,
    tz: CFG.SCHEDULER.TIMEZONE, // same clock as the scheduler; LOG_FILE is inherited
  });
  // portalActions and captchaSolver log through bare console.log. Mirror the
  // console into the file so the run is captured whole, without rewriting all
  // 130 message sites.
  logger.teeConsole('Bot');

  const log = (msg) => logger.display('Nav', msg);

  // Loud, because in PowerShell $env: vars persist for the whole terminal
  // session. A SIMULATE_SLOTS left set from an earlier test would make every
  // subsequent run stop before btnSubmit - the bot would look healthy and
  // never actually search for anything.
  if (CFG.SIMULATE.SLOTS) {
    logger.warning('Sim', '*'.repeat(64));
    logger.warning('Sim', 'SIMULATE_SLOTS=1 - this run will FAKE a slots hit and NOT search.');
    logger.warning('Sim', 'Unset it before any real run:  Remove-Item Env:SIMULATE_SLOTS');
    logger.warning('Sim', '*'.repeat(64));
  }

  const options = new chrome.Options();
  options.addArguments('--start-maximized');
  const driver = await new Builder()
    .forBrowser(Browser.CHROME)
    .setChromeOptions(options)
    .build();

  let exitCode = EXIT_FATAL;
  let outcome = null;

  try {
    await driver.get(CFG.LOGIN_URL);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

    const budget = createBudget({
      limits: CFG.BUDGET,
      searchFile: CFG.MACHINE.SEARCH_FILE,
      searchLog: CFG.MACHINE.SEARCH_LOG,
    });
    const actions = createPortalActions({
      email: process.env.EMAIL,
      password: process.env.PASSWORD,
      cfg: CFG,
      log,
    });
    const handlers = createHandlers(actions);

    log(MSG.MACHINE_START);
    outcome = await run({ driver, detect, handlers, budget, cfg: CFG, log });

    log(MSG.MACHINE_RESULTS(outcome.results));
    log(MSG.MACHINE_DONE(outcome.result, outcome.transitions, outcome.searchesUsed));

    exitCode = EXIT[outcome.result];
    if (exitCode === undefined) {
      logger.warning('Nav', `Unmapped result "${outcome.result}" - treating as a guard abort.`);
      exitCode = 30;
    }
  } catch (e) {
    // Previously this logged and fell through to exit 0, so a crash was
    // indistinguishable from a clean no-slots cycle.
    logger.error('Nav', `Fatal: ${e.message}`);
    exitCode = EXIT_FATAL;
  }

  // ---- The one path where the browser must NOT close ----------------------
  //
  // chromedriver kills Chrome when its client process exits, so holding this
  // process open is what keeps the session alive. Closing it would cost the
  // human a re-login, two captchas, and another search from the budget just to
  // get back to the page the bot was already standing on.
  //
  // Everything durable - capture, screenshot, Telegram - was written before we
  // got here, so sleeping through the hold loses nothing.
  if (exitCode === EXIT.SLOTS_FOUND) {
    const mins = CFG.SLOTS.HOLD_MINUTES;
    logger.display('Slots', '='.repeat(64));
    logger.display('Slots', `SLOTS FOUND - browser left OPEN and logged in for ${mins} minutes.`);
    logger.display('Slots', 'Go book. No re-login, no captcha, no extra search needed.');
    logger.display('Slots', '='.repeat(64));
    await sleep(mins * 60 * 1000);
    logger.display('Slots', `Hold of ${mins}m expired - closing the browser.`);
  }

  if (outcome && outcome.alerts) outcome.alerts.stop();
  // The OCR worker pool is process-wide and lazily spun up; released here so
  // requiring main() from a test does not leave live workers holding the loop.
  await shutdownOCR();
  try {
    await driver.quit();
  } catch (e) {
    logger.warning('Nav', `driver.quit failed: ${e.message}`);
  }
  return exitCode;
}

// Guarded so `require('./app.js')` cannot launch a run against the live portal.
if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { main, EXIT, EXIT_FATAL };
