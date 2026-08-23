const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { fixtureFileUrl } = require('./fixtures');

let driver = null;

async function getDriver() {
  if (driver) return driver;
  const opts = new chrome.Options();
  opts.addArguments(
    '--headless=new',
    '--window-size=1400,1000',
    '--allow-file-access-from-files',
    // The captures reference 23 remote URLs - 17 of them to
    // appointment.thespainvisa.com itself. Without this, every fixture load
    // fires requests at the LIVE PORTAL and waits ~40s for them to time out.
    // Blackhole all DNS so the suite is genuinely offline and fast. Local
    // file:// resources (the _files folders) are unaffected, so computed
    // styles still resolve correctly.
    '--host-resolver-rules=MAP * 127.0.0.1:1',
    '--disable-background-networking',
  );
  // The captures serialize the POST-Kendo DOM - k-dropdown-wrap is already in
  // the saved HTML - so waiting for 3.8MB of kendo.all.min.js plus 808K of
  // recaptcha to re-execute buys nothing and costs ~40s per load. 'eager'
  // returns at DOMContentLoaded, by which point the DOM and CSS the
  // predicates read are both in place.
  opts.setPageLoadStrategy('eager');
  driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(opts).build();
  return driver;
}

async function quitDriver() {
  if (driver) { await driver.quit(); driver = null; }
}

// Loads a saved capture and hands the driver to fn.
async function withFixture(name, fn) {
  const d = await getDriver();
  await d.get(fixtureFileUrl(name));
  await d.sleep(300); // let Bootstrap CSS apply
  return fn(d);
}

module.exports = { getDriver, quitDriver, withFixture };
