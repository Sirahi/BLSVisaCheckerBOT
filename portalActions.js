/**
 * All portal interaction lives here.
 *
 * The three big helpers below (selectKendoDropdownByLabel, dismissVisibleModal,
 * scanAndNotifySlots) were moved VERBATIM out of app.js - they work today and
 * were not rewritten as part of the state-machine work. Only their indentation
 * changed (they used to be inner functions of main()).
 *
 * createPortalActions() supplies exactly the eight deps createHandlers()
 * expects, so handlers.js stays unit testable without a browser.
 */
const { By, until, Key } = require('selenium-webdriver');
const CFG = require('./config');
const MSG = require('./messages');
const { notifyAppointmentFound, notifySlotPageReached } = require('./telegramNotifier');
const { solveVisibleCaptcha } = require('./captchaSolver');
const { capturePage } = require('./capture');

// Dropdown selection function - matches by LABEL TEXT
async function selectKendoDropdownByLabel(
  driver,
  labelText,
  visibleText,
  timeout = CFG.DROPDOWN.TIMEOUT
) {
  const targetText = visibleText.trim().toLowerCase();

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
                if (txt && (txt.toLowerCase() === targetText || txt.toLowerCase().includes(targetText))) {
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
async function dismissVisibleModal(driver, context = '') {
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
async function scanAndNotifySlots(driver, categoryName = "Normal") {
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
      await notifySlotPageReached(`${categoryName}: date picker not found, but the slot page is open!`);
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
      await notifySlotPageReached(`${categoryName}: could not open the calendar, but the slot page is open!`);
    } catch (e) { console.log(MSG.TELEGRAM_FAILED_SIMPLE); }
    throw new Error("Could not open the calendar");
  }

  await driver.sleep(CFG.SLEEP.LONG);

  const calendarExists = await driver.findElements(By.css('.k-calendar'));
  if (calendarExists.length === 0) {
    console.log(MSG.CALENDAR_ELEM_NOT_FOUND);
    try {
      await notifySlotPageReached(`${categoryName}: no calendar element, but the slot page is open!`);
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
              category: categoryName
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
    return;
  }

  try {
    await notifyAppointmentFound(availableDatesWithSlots);
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

function createPortalActions({ email, password, cfg, log }) {
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
          return;
        } catch (e) { /* try the next one */ }
      }
      throw new Error('Book Now button not found');
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

    fillFormAndSubmit: async (driver, category) => {
      await dismissVisibleModal(driver, 'page load'); // #scamAlert fires here
      const fields = [
        ['Location', cfg.CITY.LOCATION],
        ['Visa Type', cfg.FORM.VISA_TYPE],
        ['Visa Sub Type', cfg.FORM.VISA_SUB_TYPE],
        ['Category', category === 'Premium' ? cfg.FORM.CATEGORY_PREMIUM : cfg.FORM.CATEGORY_NORMAL],
      ];
      for (const [label, value] of fields) {
        const ok = await selectKendoDropdownByLabel(driver, label, value);
        if (!ok) throw new Error(`Form filling failed: ${label}`);
        await dismissVisibleModal(driver, label);
        await driver.sleep(cfg.SLEEP.SHORT);
      }
      const submit = await firstVisible(driver, '#btnSubmit');
      if (!submit) throw new Error('Submit button not found');
      await driver.wait(until.elementIsEnabled(submit), 5000);
      await clickIt(driver, submit);
      await driver.sleep(cfg.SLEEP.AFTER_SUBMIT);
    },

    // Signature stays exactly as moved - it reads CFG and MSG from module scope.
    scanSlots: (driver, categoryName) => scanAndNotifySlots(driver, categoryName),
  };
}

module.exports = {
  createPortalActions,
  selectKendoDropdownByLabel,
  dismissVisibleModal,
  scanAndNotifySlots,
  firstVisible,
  clickIt,
};
