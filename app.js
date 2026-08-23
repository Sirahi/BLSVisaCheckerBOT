/**
 * Entry point. One run of the state machine, then exit.
 *
 * All navigation logic lives in runner.js / handlers.js / pageState.js.
 * This file only wires things together.
 */
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const CFG = require('./config');
const MSG = require('./messages');
const { detect } = require('./pageState');
const { createBudget } = require('./budget');
const { createHandlers } = require('./handlers');
const { createPortalActions } = require('./portalActions');
const { run } = require('./runner');

require('dotenv').config();

async function main() {
  const log = (msg) => console.log(msg);

  const options = new chrome.Options();
  options.addArguments('--start-maximized');
  const driver = await new Builder()
    .forBrowser(Browser.CHROME)
    .setChromeOptions(options)
    .build();

  try {
    await driver.get(CFG.LOGIN_URL);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

    const budget = createBudget({
      limits: CFG.BUDGET,
      searchFile: CFG.MACHINE.SEARCH_FILE,
    });
    const actions = createPortalActions({
      email: process.env.EMAIL,
      password: process.env.PASSWORD,
      cfg: CFG,
      log,
    });
    const handlers = createHandlers(actions);

    log(MSG.MACHINE_START);
    const outcome = await run({ driver, detect, handlers, budget, cfg: CFG, log });

    log(MSG.MACHINE_RESULTS(outcome.results));
    log(MSG.MACHINE_DONE(outcome.result, outcome.transitions, outcome.searchesUsed));
  } catch (e) {
    console.error(`Fatal: ${e.message}`);
  } finally {
    await driver.quit();
  }
}

// Guarded so `require('./app.js')` cannot launch a run against the live portal.
if (require.main === module) main();

module.exports = { main };
