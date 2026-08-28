/**
 * All portal interaction lives here.
 *
 * The three big helpers below (selectKendoDropdownByLabel, dismissVisibleModal,
 * scanAndNotifySlots) were moved VERBATIM out of app.js - they work today and
 * were not rewritten as part of the state-machine work. Only their indentation
 * changed (they used to be inner functions of main()).
 *
 * createPortalActions() supplies exactly the 14 deps createHandlers()
 * expects, so handlers.js stays unit testable without a browser.
 */
const { By, until, Key } = require('selenium-webdriver');
const CFG = require('./config');
const MSG = require('./messages');
const { startSlotAlerts, notifySlotPageReached } = require('./telegramNotifier');
const { solveVisibleCaptcha } = require('./captchaSolver');
const { capturePage } = require('./capture');
const { saveResultShot } = require('./shots');
const { waitForPageSettled } = require('./settle');
const path = require('path');

// Dropdown selection function - matches by LABEL TEXT
// Does a rendered option text name the option the config asked for?
//
// EQUALITY, not containment. The old test was `=== || .includes()`, which made
// a config value a prefix pattern instead of a name: Karachi lists both
// "National Visa" and "National Visas (Study, Work & Other National Visas)",
// so a needle of "National Visa" matched both and the winner was whichever
// came first in DOM order.
//
// Normalised on both sides before comparing. Selenium's getText() collapses
// runs of whitespace, the config value is hand-typed, and the portal's own
// "National Visa/ Long Term Visa" has a space on one side of the slash only -
// so case and internal spacing are not worth failing over. Everything else is.
const normalise = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const optionMatches = (optionText, wanted) => normalise(optionText) === normalise(wanted);

async function selectKendoDropdownByLabel(
  driver,
  labelText,
  visibleText,
  timeout = CFG.DROPDOWN.TIMEOUT
) {

  try {
    // Find all label elements
    const allLabels = await driver.findElements(By.css('label.form-label'));

    let targetDropdown = null;

    // Check each label
    for (const label of allLabels) {
      try {
        const labelTextContent = await label.getText();

        // Does the label text match?
        if (labelTextContent.includes(labelText)) {
          // Find the parent div
          const parentDiv = await label.findElement(By.xpath('..'));

          // Is the parent visible?
          const isDisplayed = await parentDiv.isDisplayed();
          if (!isDisplayed) {
            continue; // Hidden - move to the next one
          }

          // Find the dropdown (inside the parent div)
          try {
            targetDropdown = await parentDiv.findElement(By.css('span.k-dropdown-wrap'));
            break;
          } catch (e) {
            // No dropdown in this div - continue
            continue;
          }
        }
      } catch (e) {
        // Could not read the label - continue
        continue;
      }
    }

    if (!targetDropdown) {
      console.log(MSG.DROPDOWN_NOT_FOUND(labelText));
      return false;
    }

    // Click the dropdown
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", targetDropdown);
    await driver.sleep(CFG.SLEEP.SHORT);
    await driver.executeScript("arguments[0].click();", targetDropdown);
    await driver.sleep(400);

    // Find the options
    let found = false;
    let start = Date.now();
    const seenOptions = new Set(); // PK: record real option text for config discovery

    while (Date.now() - start < timeout) {
      const allLists = await driver.findElements(
        By.css(".k-list-container ul, .k-animation-container ul")
      );

      for (const ul of allLists) {
        try {
          const isListDisplayed = await ul.isDisplayed();
          if (!isListDisplayed) continue;

          const items = await ul.findElements(By.css("li.k-item"));

          if (items.length > 0) {
            for (const item of items) {
              try {
                const txt = (await item.getText()).trim();
                if (txt) seenOptions.add(txt);
                if (txt && optionMatches(txt, visibleText)) {
                  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", item);
                  await driver.sleep(150);
                  await driver.executeScript("arguments[0].click();", item);
                  console.log(MSG.DROPDOWN_SELECTED(labelText, txt));
                  await driver.sleep(400);
                  found = true;
                  break;
                }
              } catch (e) {
                continue;
              }
            }
            if (found) break;
          }
        } catch (e) {
          continue;
        }
      }
      if (found) break;
      await driver.sleep(200);
    }

    if (!found) {
      console.log(MSG.DROPDOWN_NOT_SELECTED(labelText, visibleText));
      // The Pakistan portal's option text differs from Turkey's and is not in
      // the saved captures (Kendo loads it by AJAX). Print what is actually
      // there so config.js can be filled in from one run.
      const opts = [...seenOptions];
      if (opts.length) {
        console.log(`    >>> "${labelText}" actual options (${opts.length}):`);
        opts.forEach((o) => console.log(`          ${JSON.stringify(o)}`));
        console.log(`    >>> put the matching one in config.js`);
      } else {
        console.log(`    >>> "${labelText}" list never rendered - dropdown did not open,`);
        console.log(`    >>> or the previous dropdown must be set first (cascading).`);
      }
    }
    return found;

  } catch (e) {
    console.log(MSG.DROPDOWN_ERROR(labelText, e.message));
    return false;
  }
}

// ============================================================
// Dismiss whatever modal the portal just threw up.
//
// Selecting certain dropdown values opens a Bootstrap modal that overlays the
// form and blocks every dropdown below it:
//   Visa Type = National  -> #NationalVisaModal   ("Ok")
//   Category  = Premium   -> #PremiumTypeModel    ("Reject" / "Accept")
//
// ~10 modals are pre-rendered on the page and only one is ever visible, so
// nothing may be selected by id or document order - the visible one is
// resolved at runtime. The button to click is always .btn-success
// ("Ok" / "Accept"); .btn-danger is Reject and must never be clicked.
// ============================================================
//
// WAITING, not sampling. The modal is raised by the portal's own change
// handler and fades in over a few hundred milliseconds, so a single sweep
// taken the instant a dropdown selection returns is a race - and on
// 2026-08-27 that race was lost four times. Each loss looked like this:
//
//   [Visa Type] selected National Visa/ Long Term Visa      <- modal starts
//   (no "Modal dismissed after Visa Type" line)             <- sweep too early
//   [Visa Sub Type] could not select "National Visa"        <- modal in the way
//   >>> list never rendered - dropdown did not open
//
// and cost a whole cycle. Every one of the seven cycles that got through that
// day has the dismissal line; every one of the four that died lacks it.
//
// `waitMs` is opt-in because most fields raise no modal at all and paying the
// full budget on each of them would add seconds to every form fill for
// nothing. Zero (the default) keeps the old single-sweep behaviour for the
// pre-flight checks, which want an answer about RIGHT NOW.
async function dismissVisibleModal(driver, context = '', { waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const hit = await sweepForVisibleModal(driver, context);
    if (hit) return true;
    if (Date.now() >= deadline) return false;
    await driver.sleep(POLL_MS);
  }
}

const POLL_MS = 150;

// One pass over the DOM. Returns true if a visible modal was found AND
// dismissed.
async function sweepForVisibleModal(driver, context = '') {
  try {
    const modals = await driver.findElements(By.css('div.modal'));
    for (const modal of modals) {
      let visible = false;
      try {
        visible = await modal.isDisplayed();
        if (visible) {
          const disp = await modal.getCssValue('display');
          visible = disp !== 'none';
        }
      } catch (e) { continue; }
      if (!visible) continue;

      // Log what it said, so unexpected modals are not silently accepted.
      let title = '';
      try {
        const h = await modal.findElement(By.css('.modal-title'));
        title = (await h.getText()).trim();
      } catch (e) { }

      let btn = null;
      try {
        btn = await modal.findElement(By.css('.modal-footer .btn-success'));
      } catch (e) {
        try { btn = await modal.findElement(By.css('.btn-success')); } catch (e2) { }
      }
      if (!btn) continue;

      const label = (await btn.getText().catch(() => '')).trim() || 'button';
      try {
        await btn.click();
      } catch (e) {
        await driver.executeScript('arguments[0].click();', btn);
      }
      console.log(`\u2705 Modal dismissed${context ? ' after ' + context : ''}: "${title}" -> ${label}`);
      await driver.sleep(CFG.SLEEP.MEDIUM);
      return true;
    }
  } catch (e) {
    console.log(`\u26a0\ufe0f Modal check failed (non-critical): ${e.message}`);
  }
  return false;
}

// Slot scanning and notification function (avoids duplicated code)
async function scanAndNotifySlots(driver, item = { category: 'Normal', city: 'Unknown' }) {
  const categoryName = item.category;
  const cityName = item.city;
  // Find the date picker
  const allDatePickers = await driver.findElements(By.css('input.k-input[data-role="datepicker"]'));

  let visibleDatePicker = null;
  for (const picker of allDatePickers) {
    try {
      const isDisplayed = await picker.isDisplayed();
      if (isDisplayed) {
        visibleDatePicker = picker;
        console.log(MSG.DATE_PICKER_READY);
        break;
      }
    } catch (e) { continue; }
  }

  if (!visibleDatePicker) {
    console.log(MSG.DATE_PICKER_NOT_FOUND);
    console.log(MSG.SLOT_NO_DATE_PICKER(categoryName));
    try {
      await notifySlotPageReached(`${cityName}/${categoryName}: date picker not found, but the slot page is open!`, cityName);
    } catch (e) {
      console.log(MSG.TELEGRAM_FAILED_SIMPLE);
    }
    throw new Error("Date picker not found");
  }

  console.log(MSG.CALENDAR_OPENING);

  let calendarOpened = false;
  const openMethods = [
    {
      name: "JS Click",
      fn: async () => {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", visibleDatePicker);
        await driver.sleep(250);
        await driver.executeScript("arguments[0].click();", visibleDatePicker);
      }
    },
    {
      name: "Normal Click",
      fn: async () => {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", visibleDatePicker);
        await driver.sleep(250);
        await visibleDatePicker.click();
      }
    },
    {
      name: "Calendar Icon Click",
      fn: async () => {
        const parent = await visibleDatePicker.findElement(By.xpath('../..'));
        const calendarIcon = await parent.findElement(By.css('.k-icon.k-i-calendar'));
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", calendarIcon);
        await driver.sleep(250);
        await driver.executeScript("arguments[0].click();", calendarIcon);
      }
    }
  ];

  for (const method of openMethods) {
    try {
      await method.fn();
      await driver.sleep(CFG.SLEEP.LONG);

      const calendarCheck = await driver.findElements(By.css('.k-calendar-container[aria-hidden="false"], .k-calendar-container:not([aria-hidden="true"])'));
      if (calendarCheck.length > 0) {
        console.log(MSG.CALENDAR_OPENED(method.name));
        calendarOpened = true;
        break;
      }
    } catch (e) {
      /* this calendar-opening method is skipped silently */
    }
  }

  if (!calendarOpened) {
    console.log(MSG.CALENDAR_NOT_OPENED);
    console.log(MSG.SLOT_NO_CALENDAR(categoryName));
    try {
      await notifySlotPageReached(`${cityName}/${categoryName}: could not open the calendar, but the slot page is open!`, cityName);
    } catch (e) { console.log(MSG.TELEGRAM_FAILED_SIMPLE); }
    throw new Error("Could not open the calendar");
  }

  await driver.sleep(CFG.SLEEP.LONG);

  const calendarExists = await driver.findElements(By.css('.k-calendar'));
  if (calendarExists.length === 0) {
    console.log(MSG.CALENDAR_ELEM_NOT_FOUND);
    try {
      await notifySlotPageReached(`${cityName}/${categoryName}: no calendar element, but the slot page is open!`, cityName);
    } catch (e) { console.log(MSG.TELEGRAM_FAILED_SIMPLE); }
    throw new Error("No calendar element");
  }

  console.log(MSG.CALENDAR_ELEM_FOUND(calendarExists.length));
  console.log(MSG.CALENDAR_SEARCHING(categoryName));

  const availableDatesWithSlots = [];
  const maxMonthsToCheck = CFG.CALENDAR.MAX_MONTHS_TO_CHECK;

  for (let monthIndex = 0; monthIndex < maxMonthsToCheck; monthIndex++) {
    try {
      let monthTitle = null;
      try {
        monthTitle = await driver.findElement(By.css('.k-calendar .k-nav-fast'));
      } catch (e) {
        try {
          monthTitle = await driver.findElement(By.css('.k-calendar .k-header a.k-nav-fast'));
        } catch (e2) {
          console.log(MSG.CALENDAR_MONTH_NO_HEADER(monthIndex));
          break;
        }
      }

      const currentMonth = await monthTitle.getText();
      console.log(MSG.CALENDAR_MONTH_CHECKING(currentMonth));
      await driver.sleep(CFG.SLEEP.MEDIUM);

      const allDateLinks = await driver.findElements(By.css('.k-calendar a.k-link[data-value]'));
      if (allDateLinks.length === 0) {
        console.log(MSG.CALENDAR_NO_DATES);
        continue;
      }

      let foundInThisMonth = 0;

      for (let i = 0; i < allDateLinks.length; i++) {
        try {
          const dateLink = allDateLinks[i];
          const dataValue = await dateLink.getAttribute('data-value');

          if (!dataValue) continue;

          const parentTd = await dateLink.findElement(By.xpath('..'));
          const tdClass = await parentTd.getAttribute('class');
          if (tdClass && tdClass.includes('k-state-disabled')) continue;

          // Green (available) check
          const colorInfo = await driver.executeScript(`
            const link = arguments[0];
            const style = window.getComputedStyle(link);
            const bgColor = style.backgroundColor;
            
            const match = bgColor.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);
            if (!match) return { bgColor: bgColor, isGreen: false };
            
            const r = parseInt(match[1]);
            const g = parseInt(match[2]);
            const b = parseInt(match[3]);
            
            const isGreen = (g > 100 && g > r * 1.5 && g > b * 1.2 && r < 100);
            
            return {
              bgColor: bgColor,
              isGreen: isGreen,
              rgb: { r, g, b }
            };
          `, dateLink);

          if (colorInfo.isGreen) {
            const dateText = await dateLink.getText();
            availableDatesWithSlots.push({
              date: dataValue,
              text: dateText,
              month: currentMonth,
              bgColor: colorInfo.bgColor,
              rgb: colorInfo.rgb,
              category: categoryName,
              city: cityName
            });
            foundInThisMonth++;
          }
        } catch (e) {
          continue;
        }
      }

      if (foundInThisMonth > 0) {
        console.log(MSG.CALENDAR_MONTH_GREEN(currentMonth, foundInThisMonth));
      } else {
        console.log(MSG.CALENDAR_MONTH_EMPTY(currentMonth));
      }

      // Move to the next month
      if (monthIndex < maxMonthsToCheck - 1) {
        try {
          const nextMonthBtns = await driver.findElements(By.css('.k-calendar .k-nav-next'));

          if (nextMonthBtns.length === 0) break;

          const nextMonthBtn = nextMonthBtns[0];
          const btnClass = await nextMonthBtn.getAttribute('class');
          if (btnClass && btnClass.includes('k-state-disabled')) break;

          await driver.executeScript("arguments[0].click();", nextMonthBtn);
          await driver.sleep(CFG.SLEEP.CALENDAR_NAV);
          console.log(MSG.CALENDAR_NEXT_MONTH(monthIndex + 2, maxMonthsToCheck));
        } catch (e) {
          console.log(MSG.CALENDAR_NEXT_MONTH_ERROR(e.message));
          break;
        }
      }

    } catch (e) {
      console.log(MSG.CALENDAR_MONTH_ERROR(e.message));
      break;
    }
  }

  console.log(MSG.CALENDAR_TOTAL_GREEN(categoryName, availableDatesWithSlots.length));

  if (availableDatesWithSlots.length === 0) {
    console.log(MSG.CALENDAR_NO_DATES_FOUND(categoryName));
    // Returning null here does NOT resume the cycle: handlers.js still treats
    // the SLOTS page as terminal, so app.js exits 10 and the scheduler stops
    // for the night with the remaining combos unsearched. That is the right
    // call - reaching the slot page at all is worth stopping for - but doing
    // it in total silence is not. Something has to say why the night ended.
    try {
      await notifySlotPageReached(
        `${cityName}/${categoryName}: the slot page is open but the calendar showed no open dates.`,
        cityName
      );
    } catch (e) { console.log(MSG.TELEGRAM_FAILED_SIMPLE); }
    return null;
  }

  // Repeating alerts, not one shot - see startSlotAlerts. The handle is
  // returned so app.js can stop() it; the pending interval would otherwise
  // keep the process alive past the hold.
  let alerts = null;
  try {
    alerts = startSlotAlerts(availableDatesWithSlots);
    console.log(MSG.TELEGRAM_SENT);
  } catch (e) {
    console.log(MSG.TELEGRAM_FAILED(e.message));
  }

  console.log(MSG.CALENDAR_CLOSING);
  try {
    await driver.executeScript("arguments[0].blur();", visibleDatePicker);
    await driver.sleep(CFG.SLEEP.SHORT);
    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await driver.sleep(CFG.SLEEP.SHORT);
    console.log(MSG.CALENDAR_CLOSED);
  } catch (e) {
    console.log(MSG.CALENDAR_CLOSE_ERROR(e.message));
  }

  console.log(MSG.SCAN_DONE(categoryName));
  return alerts;
}

// Shaped exactly like what scanAndNotifySlots collects off the calendar, but
// the month is unmistakable on a phone screen - a simulated alert must never
// be mistaken for a real one at 3am.
function fakeSlotDates(item = { category: 'Normal', city: 'Unknown' }) {
  return [
    { text: '12', month: 'SIMULATION - NOT A REAL SLOT', category: item.category, city: item.city },
    { text: '15', month: 'SIMULATION - NOT A REAL SLOT', category: item.category, city: item.city },
  ];
}

// Resolve the VISIBLE element for a selector, or null. Never index into
// findElements - the portal pre-renders decoys everywhere.
async function firstVisible(driver, css) {
  const els = await driver.findElements(By.css(css));
  for (const el of els) {
    try { if (await el.isDisplayed()) return el; } catch (e) { /* stale */ }
  }
  return null;
}

async function clickIt(driver, el) {
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", el);
  await driver.sleep(250);
  try { await el.click(); } catch (e) { await driver.executeScript('arguments[0].click();', el); }
}

// An OPEN alert makes switchTo().defaultContent() throw as well, so the alert
// must be dealt with BEFORE trying to leave the frame - and tried again after,
// because it can arrive late.
//
// Returns {seen, text}. `seen` is REPORTED rather than swallowed because it is
// the only evidence the portal accepted the profile edit: this function used to
// return normally whether or not an alert ever appeared, and the caller then
// recorded a city change that may never have happened.
//
// The text is captured for the log only. It is deliberately NOT pattern-matched
// to decide success - this page has never been captured and we do not know what
// it says, so any match would be a guess dressed as a check.
async function acceptProfileAlert(driver) {
  const result = { seen: false, text: null };

  const take = async () => {
    const alert = await driver.switchTo().alert();
    try { result.text = await alert.getText(); } catch (e) { /* unreadable is fine */ }
    await alert.accept();
    result.seen = true;
  };

  try {
    await driver.wait(until.alertIsPresent(), 3000);
    await take();
  } catch (e) { /* not open yet - fall through */ }
  try {
    await driver.switchTo().defaultContent();
  } catch (e) {
    // defaultContent() throwing usually means a LATE alert is still open.
    try { await take(); } catch (e2) { /* none */ }
    try { await driver.switchTo().defaultContent(); } catch (e2) { /* already there */ }
  }
  return result;
}

// The real MyAppointments page has never been captured (see the module
// comment), so we do not actually know the primary XPath below always
// matches there. If it misses, the fallback CSS selector matches every
// a[onclick*="ManageApplicant"] on the page - which, on the live portal,
// plausibly includes an 'Add New Member' affordance and not just per-
// applicant edit links. Clicking the wrong one would CREATE a new
// applicant on the user's real visa account: an account-mutating action
// on a live government portal, taken unattended. So the fallback must
// fail closed - skip anything that reads like an add/delete affordance
// rather than gamble on an unseen page - and throw if nothing safe is left.
const NON_EDIT_ANCHOR_TEXT = /add\s*new|delete|remove/i;

async function openApplicantEditImpl(driver, cfg) {
  // Primary Applicant first; the generic fallback below also matches 'Add
  // New Member' and every other applicant row, so it is text-guarded.
  const strategies = [
    By.xpath("//div[contains(@class,'row') and contains(@class,'border') and contains(., 'Primary Applicant')]//a[contains(@onclick,'ManageApplicant')]"),
    By.css('a[onclick*="ManageApplicant"]'),
  ];
  for (let i = 0; i < strategies.length; i++) {
    const isFallback = i === strategies.length - 1;
    const els = await driver.findElements(strategies[i]);
    for (const el of els) {
      try {
        if (!(await el.isDisplayed())) continue;
        if (isFallback) {
          const text = ((await el.getText()) || '').trim();
          if (NON_EDIT_ANCHOR_TEXT.test(text)) continue; // fail closed, see comment above
        }
        await clickIt(driver, el);
        await driver.sleep(cfg.SLEEP.LONG);
        await waitForPageSettled(driver, {
          timeout: (cfg.SETTLE && cfg.SETTLE.TIMEOUT_MS) || 15000,
          quietMs: (cfg.SETTLE && cfg.SETTLE.QUIET_MS) || 600,
          pollMs: (cfg.SETTLE && cfg.SETTLE.POLL_MS) || 150,
          log: (m) => console.log(`⏳ applicant edit: ${m}`),
        });
        return;
      } catch (e) { /* stale - try the next */ }
    }
  }
  throw new Error('Manage Applicants edit button not found');
}

function createPortalActions({ email, password, cfg, log }) {
  // Wait for the portal to stop loading. Used after EVERY navigation: each one
  // is followed by detect(), and detect on a half-loaded page matches no
  // predicate - which is reported as UNKNOWN and answered by the scheduler with
  // a 40-60 minute back-off. A slow page must not be able to look like a ban.
  const settled = (driver, where) => waitForPageSettled(driver, {
    timeout: (cfg.SETTLE && cfg.SETTLE.TIMEOUT_MS) || 15000,
    quietMs: (cfg.SETTLE && cfg.SETTLE.QUIET_MS) || 600,
    pollMs: (cfg.SETTLE && cfg.SETTLE.POLL_MS) || 150,
    log: (m) => console.log(`⏳ ${where}: ${m}`),
  });

  return {
    solve: (driver, opts) => solveVisibleCaptcha(driver, opts),

    capture: (driver, label, detected) => capturePage(driver, label, detected),

    // The button's href differs by origin - site root, the captcha page, or the
    // dropdown page. Click it and let the loop re-detect. Never assume.
    clickDeadEndButton: async (driver) => {
      const btn = await firstVisible(driver, '#div-main a.btn-primary');
      if (!btn) throw new Error('Dead-end button not found');
      await clickIt(driver, btn);
      await driver.sleep(cfg.SLEEP.AFTER_LOGIN);
      await settled(driver, 'dead-end button');
    },

    clickBookNow: async (driver) => {
      const links = await driver.findElements(By.css('a[href$="appointment/newappointment"]'));
      for (const el of links) {
        try {
          const cls = (await el.getAttribute('class')) || '';
          if (cls.includes('nav-link')) continue;
          if (!(await el.isDisplayed())) continue;
          await clickIt(driver, el);
          await driver.sleep(cfg.SLEEP.AFTER_LOGIN);
          await settled(driver, 'Book Now');
          return;
        } catch (e) { /* try the next one */ }
      }
      throw new Error('Book Now button not found');
    },

    // Direct navigation, not the nav dropdown. The Manage Applicants link is a
    // .dropdown-item inside a collapsed menu; driving a hover menu is a
    // needless failure mode when the URL is stable and already in config.
    goToMyAppointments: async (driver) => {
      await driver.get(cfg.MY_APPOINTMENTS_URL);
      await driver.sleep(cfg.SLEEP.AFTER_LOGIN);
      await settled(driver, 'MyAppointments');
    },

    goHome: async (driver) => {
      await driver.get(cfg.BASE_URL + cfg.BLS_HOME_URL);
      await driver.sleep(cfg.SLEEP.AFTER_LOGIN);
      await settled(driver, 'home');
    },

    fillEmail: async (driver) => {
      const input = await firstVisible(driver, 'input[type="text"], input[type="email"]');
      if (!input) throw new Error('Email field not found');
      await driver.executeScript("arguments[0].value='';", input);
      await input.sendKeys(email);
      const verify = await firstVisible(driver, '#btnVerify');
      if (!verify) throw new Error('Verify button not found');
      await clickIt(driver, verify);
      await driver.sleep(cfg.SLEEP.AFTER_LOGIN);
      await settled(driver, 'email verify');
    },

    fillPasswordAndSolve: async (driver) => {
      const input = await firstVisible(driver, 'input[type="password"]');
      if (!input) return { ok: false, reason: 'Password field not found' };
      const cls = (await input.getAttribute('class')) || '';
      if (cls.includes('entry-disabled')) {
        await driver.executeScript(`
          arguments[0].classList.remove('entry-disabled');
          arguments[0].removeAttribute('disabled');
          arguments[0].removeAttribute('readonly');
        `, input);
      }
      await driver.executeScript("arguments[0].value='';", input);
      await input.sendKeys(password);
      await driver.sleep(cfg.SLEEP.MEDIUM);
      return solveVisibleCaptcha(driver, { isLogin: true });
    },

    fillFormAndSubmit: async (driver, item) => {
      const settle = (cfg.MODAL && cfg.MODAL.SETTLE_MS) || 0;
      await dismissVisibleModal(driver, 'page load', { waitMs: settle }); // #scamAlert fires here
      const fields = [
        ['Location', item.location],
        ['Visa Type', cfg.FORM.VISA_TYPE],
        // From the ITEM, not cfg: the sub type is per city (buildPlan resolves
        // the override against the global FORM value). Falls back for any
        // caller that still hands over a plan item built before this existed.
        ['Visa Sub Type', item.visaSubType || cfg.FORM.VISA_SUB_TYPE],
        ['Category', item.category === 'Premium' ? cfg.FORM.CATEGORY_PREMIUM : cfg.FORM.CATEGORY_NORMAL],
      ];
      for (const [label, value] of fields) {
        // Pre-flight. The post-field wait below catches the modal that the
        // PREVIOUS field raised, but a slow one can still land in the gap. This
        // costs one DOM sweep and is the difference between a lost cycle and a
        // dismissed dialog, so it is paid before every dropdown rather than
        // only before the one that happened to fail on 2026-08-27.
        await dismissVisibleModal(driver, `${label} (pre-flight)`);

        const ok = await selectKendoDropdownByLabel(driver, label, value);
        if (!ok) throw new Error(`Form filling failed: ${label}`);

        // WAIT here. Visa Type raises "Information" and Category=Premium raises
        // the premium confirmation; both fade in AFTER the selection returns,
        // and an undismissed one covers every dropdown below it.
        await dismissVisibleModal(driver, label, { waitMs: settle });
        await driver.sleep(cfg.SLEEP.SHORT);
      }
      const submit = await firstVisible(driver, '#btnSubmit');
      if (!submit) throw new Error('Submit button not found');
      await driver.wait(until.elementIsEnabled(submit), 5000);
      await clickIt(driver, submit);
      await driver.sleep(cfg.SLEEP.AFTER_SUBMIT);

      // The one that prompted all of this. The shot below and the detect() that
      // follows this function both need a page that has finished rendering.
      await settled(driver, 'search result');

      // Photograph whatever came back, before anything classifies it.
      //
      // The log already records the detector's verdict for this page, but a
      // verdict is not evidence when the open question is whether the detector
      // is right - specifically whether a slots-available page is being read as
      // "no slots". Taken HERE rather than from the DEAD_END handler on
      // purpose: a shot keyed on the detected state would be gated by the very
      // classification it exists to check, so the one page worth having a
      // picture of - a misread one - is the one that would never be shot.
      //
      // Never allowed to throw: a real search has just been spent, against a
      // budget the portal blocks you for exceeding.
      const shotCfg = cfg.SHOTS || {};
      const shot = await saveResultShot(driver, {
        label: item.label,
        dir: shotCfg.DIR,
        keep: shotCfg.KEEP,
        enabled: shotCfg.ENABLED !== false,
        log: (m) => console.log(m),
      });
      if (shot) console.log(`\u{1F4F7} Result page: ${path.basename(shot)}`);
    },

    // Signature stays exactly as moved - it reads CFG and MSG from module scope.
    scanSlots: (driver, item) => scanAndNotifySlots(driver, item),
    simulateSlotsFound: (item) => startSlotAlerts(fakeSlotDates(item)),

    openApplicantEdit: async (driver) => openApplicantEditImpl(driver, cfg),

    setProfileCity: async (driver, item) => {
      await driver.wait(until.elementLocated(By.css('div.modal-content')), cfg.DROPDOWN.TIMEOUT);
      await driver.sleep(cfg.SLEEP.MEDIUM);

      const ok = await selectKendoDropdownByLabel(driver, 'Location', item.location);
      if (!ok) throw new Error(`Profile Location "${item.location}" could not be selected`);
      console.log(MSG.PROFILE_LOCATION_SET(item.city));
      await driver.sleep(cfg.SLEEP.LONG);

      // Compare against CFG.FORM.VISA_TYPE. The Turkey original tested for
      // 'Schengen', which never matches this portal's 'National Visa' - so it
      // silently re-selected the dropdown on every pass.
      let current = '';
      try {
        const el = await firstVisible(driver, 'span[aria-owns="VisaType_listbox"] .k-input, .k-input[aria-controls="VisaType_listbox"]');
        if (el) current = await el.getText();
      } catch (e) { /* unreadable - fall through and set it */ }

      if (current.toLowerCase().includes(cfg.FORM.VISA_TYPE.toLowerCase())) {
        console.log(MSG.PROFILE_VISA_TYPE_OK(cfg.FORM.VISA_TYPE));
      } else {
        const vt = await selectKendoDropdownByLabel(driver, 'Visa Type', cfg.FORM.VISA_TYPE);
        if (!vt) throw new Error('Profile Visa Type could not be selected');
        console.log(MSG.PROFILE_VISA_TYPE_SET(cfg.FORM.VISA_TYPE));
        await driver.sleep(cfg.SLEEP.MEDIUM);
      }

      const proceed = await driver.findElement(
        By.xpath("//div[contains(@class,'modal-footer')]//button[contains(text(),'Proceed')]")
      );
      await clickIt(driver, proceed);
      console.log(MSG.PROFILE_PROCEED_CLICKED);
      await driver.sleep(cfg.SLEEP.LONG);
      await settled(driver, 'profile Proceed');
    },

    submitProfileFrame: async (driver) => {
      await driver.wait(until.elementLocated(By.css('iframe.k-content-frame')), cfg.DROPDOWN.TIMEOUT);
      await driver.sleep(cfg.SLEEP.MEDIUM);
      const frame = await driver.findElement(By.css('iframe.k-content-frame'));
      await driver.switchTo().frame(frame);
      let alert = { seen: false, text: null };
      try {
        const btn = (await firstVisible(driver, 'button[type="submit"].btn-primary'))
          || (await firstVisible(driver, 'button[type="submit"]'))
          || (await firstVisible(driver, 'button.btn-primary'));
        if (!btn) throw new Error('Profile Submit button not found inside the frame');
        await clickIt(driver, btn);
        console.log(MSG.PROFILE_SUBMIT_CLICKED);
        await driver.sleep(cfg.SLEEP.MEDIUM);
        // NO settle wait here, deliberately. This click is inside the Kendo
        // iframe and the portal answers it with a JS ALERT, which is accepted
        // by acceptProfileAlert below. waitForPageSettled runs a script, and a
        // script issued while an alert is open fails with "unexpected alert
        // open" - the exact bug fixed in the captcha path on 2026-08-27.
        // Settling here would reintroduce it one function over.
        //
        // Nothing is lost: the caller follows this with goHome(), which settles
        // on the way out, and that is the page detect() actually looks at.
      } finally {
        // Runs even when Submit was never found, so a failure can never strand
        // the driver inside the iframe for the next detect(). If the try block
        // threw, that error still wins - this only clears the frame.
        alert = await acceptProfileAlert(driver);
      }
      // Reached only on the success path (a throw above skips it). The alert is
      // the portal telling us it saved; without one, Proceed/Submit may have
      // silently no-opped and the profile is still on the previous city.
      // Throwing here is the safe outcome: handlers.js leaves profileCity unset,
      // the run terminates, and no search is spent against the wrong city.
      if (!alert.seen) throw new Error(MSG.PROFILE_ALERT_MISSING);
      console.log(MSG.PROFILE_ALERT_ACCEPTED(alert.text));
    },
  };
}

module.exports = {
  createPortalActions,
  selectKendoDropdownByLabel,
  optionMatches, // exported for its unit test; the match rule is the risky part
  dismissVisibleModal,
  scanAndNotifySlots,
  fakeSlotDates,
  firstVisible,
  clickIt,
  openApplicantEditImpl, // exported for the fail-closed guard's unit test
};
