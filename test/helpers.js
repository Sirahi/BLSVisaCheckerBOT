const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { fixtureFileUrl } = require('./fixtures');

let driver = null;

async function getDriver() {
  if (driver) return driver;
  const opts = new chrome.Options();
  opts.addArguments('--headless=new', '--window-size=1400,1000', '--allow-file-access-from-files');
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
