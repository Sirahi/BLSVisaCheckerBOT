const { Builder, Browser, By, Key, until } = require("selenium-webdriver");
const { solveCaptchaInIframe } = require("./captchaSolver");
const {
  notifyAppointmentFound,
  notifySlotPageReached
} = require("./telegramNotifier");
const CFG = require("./config");
const MSG = require("./messages");

require("dotenv").config();

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

async function main() {
  // Check for and recover from the "Application Temporarily Unavailable" error
  async function checkAndHandleUnavailable(driver) {
    try {
      const pageSource = await driver.getPageSource();
      if (pageSource.includes('Application Temporarily Unavailable') ||
        pageSource.includes('Temporarily Unavailable')) {
        console.log(MSG.UNAVAILABLE_DETECTED);
        await driver.sleep(5000);
        console.log(MSG.UNAVAILABLE_REFRESHING);
        await driver.navigate().refresh();
        await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
        console.log(MSG.PAGE_REFRESHED);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

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
  // URL comparison must be case-insensitive: the portal serves
  // /Global/Appointment/VisaType but redirects can vary the casing.
  function urlIsForm(url) {
    return (url || '').toLowerCase().includes(CFG.VISA_TYPE_URL.toLowerCase());
  }

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

  // Premium Category'yi deneme fonksiyonu
  async function tryPremiumCategory(driver, city) {
    console.log(MSG.PREMIUM_FLOW_STARTING);

    let tryAgainClicked = false;

    try {
      // Look for the "Try Again" link first
      const tryAgainLinks = await driver.findElements(By.xpath("//a[contains(text(), 'Try Again') or contains(text(), 'try again')]"));

      if (tryAgainLinks.length > 0) {
        for (const link of tryAgainLinks) {
          try {
            const isDisplayed = await link.isDisplayed();
            if (isDisplayed) {
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", link);
              await driver.sleep(250);
              await driver.executeScript("arguments[0].click();", link);
              console.log(MSG.TRY_AGAIN_LINK_CLICKED);
              tryAgainClicked = true;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      // If no link was found, look for a button
      if (!tryAgainClicked) {
        const tryAgainBtns = await driver.findElements(By.xpath("//button[contains(text(), 'Try Again') or contains(text(), 'try again')]"));

        if (tryAgainBtns.length > 0) {
          for (const btn of tryAgainBtns) {
            try {
              const isDisplayed = await btn.isDisplayed();
              if (isDisplayed) {
                await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", btn);
                await driver.sleep(250);
                await driver.executeScript("arguments[0].click();", btn);
                console.log(MSG.TRY_AGAIN_BTN_CLICKED);
                tryAgainClicked = true;
                break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      }

      if (!tryAgainClicked) {
        console.log(MSG.TRY_AGAIN_NOT_FOUND);
        const bookNowBtn = await driver.findElement(By.css(`a[href="${CFG.BOOK_NOW_URL}"]`));
        await bookNowBtn.click();
        console.log(MSG.BOOK_NOW_BTN_CLICKED);
      }
    } catch (e) {
      console.log(MSG.TRY_AGAIN_FAILED(e.message));
      throw new Error("Try Again action failed");
    }

    await driver.sleep(1500);

    // 2. "Application Temporarily Unavailable" check
    await checkAndHandleUnavailable(driver);

    // 3. Captcha check (appointment page)
    console.log(MSG.PREMIUM_CAPTION_PAGE_CHECKING);
    await driver.sleep(CFG.SLEEP.LONG);

    const currentUrl = await driver.getCurrentUrl();
    const pageSource = await driver.getPageSource();

    // Are we on the form page?
    const hasFormTitle = pageSource.includes('Book New Appointment - Visa Type Selection');

    if (!hasFormTitle && !currentUrl.includes('/Global/bls/visatype')) {
      console.log(MSG.CAPTCHA_DETECTED);

      let captchaSuccess = false;
      let captchaRetries = 0;
      const maxCaptchaRetries = CFG.RETRY.MAX_CAPTCHA_RETRIES;

      while (!captchaSuccess && captchaRetries < maxCaptchaRetries) {
        try {
          if (captchaRetries > 0) {
            console.log(MSG.PREMIUM_CAPTCHA_RETRYING(captchaRetries + 1, maxCaptchaRetries));
            await driver.sleep(CFG.SLEEP.LONG);
          }

          await solveCaptchaInIframe(driver);

          // Post-captcha check
          await driver.sleep(1000);
          await checkAndHandleUnavailable(driver);

          // Did we reach the form page?
          await driver.sleep(1500);
          const afterCaptchaUrl = await driver.getCurrentUrl();
          const afterCaptchaPage = await driver.getPageSource();

          if (afterCaptchaUrl.includes('/Global/bls/visatype') ||
            afterCaptchaPage.includes('Book New Appointment - Visa Type Selection')) {
            console.log(MSG.CAPTCHA_FORM_SUCCESS);
            captchaSuccess = true;
          } else {
            throw new Error("Could not be redirected to the form page");
          }

        } catch (e) {
          captchaRetries++;
          console.log(MSG.PREMIUM_CAPTCHA_FAILED(e.message));

          if (captchaRetries >= maxCaptchaRetries) {
            throw new Error("Could not solve captcha - max attempts exceeded");
          }

          await driver.sleep(1500);
        }
      }
    } else {
      console.log(MSG.CAPTCHA_NOT_NEEDED);
    }

    await driver.sleep(1000);
    await checkAndHandleUnavailable(driver);

    // 4. Form filling - Premium selection
    console.log(MSG.PREMIUM_FORM_FILLING);

    await driver.wait(until.elementLocated(By.css("span.k-dropdown-wrap")), CFG.DROPDOWN.TIMEOUT);
    await driver.sleep(CFG.SLEEP.MEDIUM);

    const formSuccess = {
      location: false,
      visaType: false,
      visaSubType: false,
      category: false
    };

    // No Jurisdiction dropdown on the Pakistan portal - the form starts at
    // Location. Jurisdiction is a Turkey-only field.
    formSuccess.location = await selectKendoDropdownByLabel(driver, "Location", city.LOCATION);
    if (!formSuccess.location) throw new Error("Premium: could not select Location");
    await dismissVisibleModal(driver, "Location");
    await driver.sleep(CFG.SLEEP.SHORT);

    formSuccess.visaType = await selectKendoDropdownByLabel(driver, "Visa Type", CFG.FORM.VISA_TYPE);
    if (!formSuccess.visaType) throw new Error("Premium: could not select Visa Type");
    await dismissVisibleModal(driver, "Visa Type");
    await driver.sleep(CFG.SLEEP.SHORT);

    formSuccess.visaSubType = await selectKendoDropdownByLabel(driver, "Visa Sub Type", CFG.FORM.VISA_SUB_TYPE);
    if (!formSuccess.visaSubType) throw new Error("Premium: could not select Visa Sub Type");
    await dismissVisibleModal(driver, "Visa Sub Type");
    await driver.sleep(CFG.SLEEP.SHORT);

    formSuccess.category = await selectKendoDropdownByLabel(driver, "Category", CFG.FORM.CATEGORY_PREMIUM);
    if (!formSuccess.category) throw new Error("Premium: could not select Category");
    // Selecting Premium opens #PremiumTypeModel. Accept it here; the block
    // below is a second pass that also logs the message text.
    await dismissVisibleModal(driver, "Category");
    await driver.sleep(CFG.SLEEP.MEDIUM);

    // 6. PREMIUM MODAL DIALOG CHECK AND ACCEPT
    try {
      // Wait for the modal to open
      await driver.sleep(1000);

      // Look for the modal body
      const modalBodies = await driver.findElements(By.css('.modal-body, .scam-body'));
      let modalFound = false;

      for (const modalBody of modalBodies) {
        try {
          const isDisplayed = await modalBody.isDisplayed();
          if (isDisplayed) {
            const text = await modalBody.getText();

            // Is there a Premium Lounge message?
            if (text.includes('Premium Lounge') || text.includes('optional service')) {
              console.log(MSG.PREMIUM_MODAL_SUMMARY(text));
              modalFound = true;

              // Accept butonu ara
              // Look for the success button inside the modal first
              let acceptBtns = await driver.findElements(By.css('.modal-footer .btn-success, .modal-footer button.btn-success'));

              if (acceptBtns.length === 0) {
                // Alternative: all success buttons
                acceptBtns = await driver.findElements(By.css('.btn-success, button.btn-success'));
              }

              // Click the Accept button
              let acceptClicked = false;
              for (const btn of acceptBtns) {
                try {
                  const btnDisplayed = await btn.isDisplayed();
                  const btnText = await btn.getText();

                  if (btnDisplayed && btnText.toLowerCase().includes('accept')) {
                    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", btn);
                    await driver.sleep(150);
                    await driver.executeScript("arguments[0].click();", btn);
                    console.log(MSG.PREMIUM_MODAL_ACCEPT_CLICKED);
                    acceptClicked = true;
                    break;
                  }
                } catch (e) {
                  continue;
                }
              }

              if (!acceptClicked) {
                console.log(MSG.PREMIUM_MODAL_ACCEPT_NOT_FOUND);
              }

              break;
            }
          }
        } catch (e) {
          continue;
        }
      }

      if (!modalFound) {
        console.log(MSG.PREMIUM_MODAL_NOT_FOUND);
      }
      await driver.sleep(CFG.SLEEP.MEDIUM);
    } catch (e) {
      console.log(MSG.PREMIUM_MODAL_ERROR(e.message));
    }

    console.log(MSG.PREMIUM_FORM_DONE);
    await driver.sleep(CFG.SLEEP.SHORT);
    await checkAndHandleUnavailable(driver);

    console.log(MSG.PREMIUM_SUBMIT_SEARCHING);
    const submitBtn = await driver.findElement(By.id("btnSubmit"));
    await driver.wait(until.elementIsVisible(submitBtn), 5000);
    await driver.wait(until.elementIsEnabled(submitBtn), 5000);
    try {
      await submitBtn.click();
      console.log(MSG.PREMIUM_SUBMITTED);
    } catch (e) {
      await driver.executeScript("arguments[0].click();", submitBtn);
      console.log(MSG.PREMIUM_SUBMITTED_JS);
    }

    await driver.sleep(CFG.SLEEP.AFTER_SUBMIT);
    await checkAndHandleUnavailable(driver);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

    console.log(MSG.PREMIUM_CHECKING);

    const premiumPageSource = await driver.getPageSource();
    const premiumHasCaptcha = premiumPageSource.includes('Please select all boxes');

    if (premiumHasCaptcha) {
      console.log(MSG.CAPTCHA_PREMIUM_DETECTED);
      console.log(MSG.CAPTCHA_SOLVING);
      try {
        await solveCaptchaInIframe(driver);
        await driver.sleep(CFG.SLEEP.LONG);
        await checkAndHandleUnavailable(driver);
        await driver.sleep(CFG.SLEEP.LONG);
        console.log(MSG.CAPTCHA_PREMIUM_SOLVED);
      } catch (e) {
        console.log(MSG.CAPTCHA_PREMIUM_FAILED(e.message));
        throw new Error("Could not solve premium captcha");
      }
    }

    const premiumSlotOpen = await checkIfSlotsAreOpen(driver, "Premium");

    if (premiumSlotOpen) {
      console.log(MSG.PREMIUM_SLOT_FOUND);
      await driver.sleep(CFG.SLEEP.LONG);
      await scanAndNotifySlots(driver, "Premium");
    } else {
      console.log(MSG.PREMIUM_SLOT_NOT_FOUND);
    }
  }

  // ============================================================
  // Full scan flow for a single city (Normal + Premium)
  // ============================================================
  async function scanCity(driver, city) {
    console.log(MSG.CITY_SCAN_START(city.name));

    // The applicant's jurisdiction is set by hand in the portal profile and is
    // never touched by the bot - we go straight to Book Now after login.
    await driver.get(`${CFG.BASE_URL}${CFG.BLS_HOME_URL}`);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
    await checkAndHandleUnavailable(driver);

    // Click the "Book Now" button
    try {
      // Wait for the page to fully load
      await driver.wait(
        until.elementLocated(By.css(`a[href="${CFG.BOOK_NOW_URL}"]`)),
        CFG.DROPDOWN.TIMEOUT
      );
      await driver.sleep(CFG.SLEEP.MEDIUM);

      const bookNowBtn = await driver.findElement(
        By.css(`a[href="${CFG.BOOK_NOW_URL}"]`)
      );

      // Scroll + JS click (avoids the element-not-interactable error)
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", bookNowBtn);
      await driver.sleep(CFG.SLEEP.SHORT);

      try {
        await bookNowBtn.click();
      } catch (_) {
        await driver.executeScript("arguments[0].click();", bookNowBtn);
      }
      console.log(MSG.BOOK_NOW_CLICKED);
    } catch (e) {
      console.log(MSG.BOOK_NOW_NOT_FOUND(e.message));
      throw new Error('Could not click the "Book Now" button!');
    }

    await driver.sleep(750);
    await checkAndHandleUnavailable(driver);

    console.log(MSG.APPOINTMENT_PAGE_CHECKING);
    await driver.sleep(750);

    const cityCurrentUrl = await driver.getCurrentUrl();
    console.log(MSG.CURRENT_URL(cityCurrentUrl));

    if (urlIsForm(cityCurrentUrl)) {
      console.log(MSG.FORM_DIRECT);
    } else {
      const cityPageSource = await driver.getPageSource();
      const cityHasFormTitle = cityPageSource.includes('Book New Appointment - Visa Type Selection');

      if (cityHasFormTitle) {
        console.log(MSG.FORM_DETECTED_SOURCE);
      } else {
        console.log(MSG.FORM_CAPTCHA_DETECTED);

        let appointmentCaptchaSuccess = false;
        let appointmentRetries = 0;
        const maxAppointmentRetries = CFG.RETRY.MAX_APPOINTMENT_RETRIES;

        while (!appointmentCaptchaSuccess && appointmentRetries < maxAppointmentRetries) {
          try {
            if (appointmentRetries > 0) {
              console.log(MSG.APPOINTMENT_CAPTCHA_RETRYING(appointmentRetries + 1, maxAppointmentRetries));
              await driver.sleep(750);

              const retryUrl = await driver.getCurrentUrl();
              if (retryUrl.includes('/home/index')) {
                console.log(MSG.HOME_REDIRECT_BOOK_NOW);
                const retryBookNowBtn = await driver.findElement(
                  By.css(`a[href="${CFG.BOOK_NOW_URL}"]`)
                );
                await retryBookNowBtn.click();
                await driver.sleep(750);
              }
            }

            console.log(MSG.APPOINTMENT_CAPTCHA_SOLVING);
            await solveCaptchaInIframe(driver);

            await driver.sleep(750);
            console.log(MSG.AFTER_CAPTCHA_CHECKING);
            await checkAndHandleUnavailable(driver);

            console.log(MSG.FORM_REDIRECT_WAITING);
            await driver.sleep(750);

            try {
              await driver.wait(async () => urlIsForm(await driver.getCurrentUrl()), 10000);
              console.log(MSG.APPOINTMENT_CAPTCHA_SUCCESS);
              appointmentCaptchaSuccess = true;
            } catch (e) {
              const pageCheck = await driver.getPageSource();
              if (pageCheck.includes('Book New Appointment - Visa Type Selection')) {
                console.log(MSG.APPOINTMENT_CAPTCHA_ALT_SUCCESS);
                appointmentCaptchaSuccess = true;
              } else {
                throw new Error("Was not redirected to the form page");
              }
            }

          } catch (e) {
            appointmentRetries++;
            console.log(MSG.APPOINTMENT_CAPTCHA_FAILED(e.message));

            if (appointmentRetries >= maxAppointmentRetries) {
              console.log(MSG.APPOINTMENT_MAX_RETRY(maxAppointmentRetries));
              throw new Error("Appointment captcha failed - max attempts exceeded");
            }

            await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
          }
        }
      }
    }

    await driver.sleep(1000);
    await checkAndHandleUnavailable(driver);
    await checkAndHandleUnavailable(driver);

    console.log(MSG.FORM_READY);
    await driver.sleep(CFG.SLEEP.LONG);

    await driver.wait(
      until.elementLocated(By.css("span.k-dropdown-wrap")),
      CFG.DROPDOWN.TIMEOUT
    );
    console.log(MSG.FORM_FILLING_DROPDOWNS);
    await driver.sleep(CFG.SLEEP.MEDIUM);

    const formSuccess = {
      location: false,
      visaType: false,
      visaSubType: false,
      category: false
    };

    // No Jurisdiction dropdown on the Pakistan portal - the form starts at
    // Location. Jurisdiction is a Turkey-only field.
    formSuccess.location = await selectKendoDropdownByLabel(driver, "Location", city.LOCATION);
    if (!formSuccess.location) {
      console.log(MSG.LOCATION_FAILED);
      throw new Error(`Form filling failed: Location (${city.name})`);
    }
    await dismissVisibleModal(driver, "Location");
    await driver.sleep(CFG.SLEEP.SHORT);

    formSuccess.visaType = await selectKendoDropdownByLabel(driver, "Visa Type", CFG.FORM.VISA_TYPE);
    if (!formSuccess.visaType) {
      console.log(MSG.VISA_TYPE_FAILED);
      throw new Error(`Form filling failed: Visa Type (${city.name})`);
    }
    await dismissVisibleModal(driver, "Visa Type");
    await driver.sleep(CFG.SLEEP.SHORT);

    formSuccess.visaSubType = await selectKendoDropdownByLabel(driver, "Visa Sub Type", CFG.FORM.VISA_SUB_TYPE);
    if (!formSuccess.visaSubType) {
      console.log(MSG.VISA_SUB_TYPE_FAILED);
      throw new Error(`Form filling failed: Visa Sub Type (${city.name})`);
    }
    await dismissVisibleModal(driver, "Visa Sub Type");
    await driver.sleep(CFG.SLEEP.SHORT);

    console.log(MSG.APPOINTMENT_FOR_INFO);

    formSuccess.category = await selectKendoDropdownByLabel(driver, "Category", CFG.FORM.CATEGORY_NORMAL);
    if (!formSuccess.category) {
      console.log(MSG.CATEGORY_FAILED);
      throw new Error(`Form filling failed: Category (${city.name})`);
    }
    await dismissVisibleModal(driver, "Category");
    await driver.sleep(CFG.SLEEP.SHORT);

    console.log(MSG.FORM_ALL_DONE);
    await driver.sleep(CFG.SLEEP.SHORT);
    await checkAndHandleUnavailable(driver);

    console.log(MSG.FORM_SUBMIT_SEARCHING);
    const submitBtn = await driver.findElement(By.id("btnSubmit"));
    await driver.wait(until.elementIsVisible(submitBtn), 5000);
    await driver.wait(until.elementIsEnabled(submitBtn), 5000);

    try {
      await submitBtn.click();
      console.log(MSG.FORM_SUBMITTED);
    } catch (e) {
      console.log(MSG.FORM_SUBMIT_JS_FALLBACK);
      await driver.executeScript("arguments[0].click();", submitBtn);
      console.log(MSG.FORM_SUBMITTED_JS);
    }

    await driver.sleep(CFG.SLEEP.AFTER_SUBMIT);
    await checkAndHandleUnavailable(driver);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

    console.log(MSG.FORM_SUBMIT_CHECKING);

    const cityPageSourceAfterSubmit = await driver.getPageSource();
    const hasCaptcha = cityPageSourceAfterSubmit.includes('Please select all boxes');

    if (hasCaptcha) {
      console.log(MSG.CAPTCHA_FORM_DETECTED);
      console.log(MSG.CAPTCHA_SOLVING);
      try {
        await solveCaptchaInIframe(driver);
        await driver.sleep(CFG.SLEEP.LONG);
        await checkAndHandleUnavailable(driver);
        await driver.sleep(CFG.SLEEP.LONG);
        console.log(MSG.CAPTCHA_SOLVED);
      } catch (e) {
        console.log(MSG.CAPTCHA_FAILED(e.message));
        throw new Error("Could not solve captcha");
      }
    }

    const slotOpen = await checkIfSlotsAreOpen(driver, `${city.name} Normal`);

    if (slotOpen) {
      console.log(MSG.NORMAL_SLOT_FOUND);
      await driver.sleep(CFG.SLEEP.LONG);
      await scanAndNotifySlots(driver, `${city.name} Normal`);
    } else {
      console.log(MSG.NORMAL_NO_SLOT);
      try {
        await tryPremiumCategory(driver, city);
      } catch (e) {
        console.log(MSG.PREMIUM_FAILED(e.message));
      }
    }

    console.log(MSG.CITY_SCAN_DONE(city.name));

    // Return to the home page for the next city
    await driver.get(`${CFG.BASE_URL}${CFG.BLS_HOME_URL}`);
    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
    await checkAndHandleUnavailable(driver);
  }

  // Slot-open check function - SIMPLIFIED
  // NOTE: the captcha check must run BEFORE this function is called!
  async function checkIfSlotsAreOpen(driver, categoryName) {
    await driver.sleep(1000);
    await checkAndHandleUnavailable(driver);

    const pageSource = await driver.getPageSource();

    // Check for the "Appointment Slot" label - THIS IS THE MOST IMPORTANT CHECK!
    const hasAppointmentSlotLabel = pageSource.includes('Appointment Slot');

    if (hasAppointmentSlotLabel) {
      console.log(MSG.SLOT_OPEN(categoryName));

      try {
        const message = `🎉 *${categoryName} Category: slots are open!*\n\n` +
          `✅ "Appointment Slot" label detected\n` +
          `📅 An appointment can be selected!\n\n` +
          `🔗 [Check it now!](${CFG.TELEGRAM.SLOT_OPEN_LINK})\n\n` +
          `⏰ ${new Date().toLocaleString('tr-TR')}`;

        const { sendMessageToTelegram } = require("./telegramNotifier");
        await sendMessageToTelegram(message);
        console.log(MSG.SLOT_TELEGRAM_SENT);
      } catch (e) {
        console.log(MSG.SLOT_TELEGRAM_FAILED(e.message));
      }

      return true;
    }

    console.log(MSG.SLOT_CLOSED(categoryName));
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

  (async function example() {
    const chromeOptions = new (require("selenium-webdriver/chrome").Options)();
    chromeOptions.addArguments("--start-maximized");
    let driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(chromeOptions).build();
    try {
      await driver.get(CFG.LOGIN_URL);

      console.log(MSG.PAGE_LOADED);
      await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

      let unavailableRetries = 0;
      while (await checkAndHandleUnavailable(driver) && unavailableRetries < CFG.RETRY.MAX_UNAVAILABLE_RETRIES) {
        unavailableRetries++;
        await driver.sleep(CFG.SLEEP.LONG);
      }

      console.log(MSG.EMAIL_WAITING);
      await driver.sleep(CFG.SLEEP.LONG);

      let emailInput = null;
      try {
        const allInputs = await driver.findElements(By.css('input[type="text"]'));
        for (let i = 0; i < allInputs.length; i++) {
          try {
            const input = allInputs[i];
            const isDisplayed = await input.isDisplayed();
            const rect = await input.getRect();
            if (isDisplayed && rect.width > 50 && rect.height > 20) {
              emailInput = input;
              break;
            }
          } catch (e) { }
        }
      } catch (e) { }

      if (!emailInput) throw new Error("Email field not found!");

      try {
        console.log(MSG.EMAIL_ENTERING);
        await driver.executeScript("arguments[0].value = '';", emailInput);
        await emailInput.sendKeys(EMAIL);
        console.log(MSG.EMAIL_SUCCESS);
      } catch (e) {
        console.log(MSG.EMAIL_ERROR(e.message));
        throw new Error("Email girilemedi!");
      }

      await driver.findElement(By.id("btnVerify")).click();
      console.log(MSG.VERIFY_CLICKED);

      await driver.sleep(CFG.SLEEP.AFTER_LOGIN);

      console.log(MSG.PASSWORD_WAITING);
      await driver.sleep(CFG.SLEEP.LONG);

      let passwordInput = null;
      try {
        const allPasswords = await driver.findElements(By.css('input[type="password"]'));
        for (let i = 0; i < allPasswords.length; i++) {
          try {
            const input = allPasswords[i];
            const isDisplayed = await input.isDisplayed();
            const rect = await input.getRect();
            if (isDisplayed && rect.width > 50 && rect.height > 20) {
              passwordInput = input;
              break;
            }
          } catch (e) { }
        }
      } catch (e) { }

      if (!passwordInput) throw new Error("Password field not found!");

      try {
        console.log(MSG.PASSWORD_ENTERING);
        await driver.executeScript("arguments[0].value = '';", passwordInput);
        await passwordInput.sendKeys(PASSWORD);
        console.log(MSG.PASSWORD_SUCCESS);
      } catch (e) {
        console.log(MSG.PASSWORD_ERROR(e.message));
        throw new Error("Password girilemedi!");
      }

      await driver.sleep(1000);

      // Solve the login captcha - with a retry mechanism
      let loginSuccess = false;
      let loginRetries = 0;
      const maxLoginRetries = CFG.RETRY.MAX_LOGIN_RETRIES;

      while (!loginSuccess && loginRetries < maxLoginRetries) {
        try {
          if (loginRetries > 0) {
            console.log(MSG.LOGIN_RETRYING(loginRetries + 1, maxLoginRetries));
            await driver.sleep(CFG.SLEEP.LONG);

            let passwordFound = false;
            let passwordFilled = false;

            const retryPasswords = await driver.findElements(By.css('input[type="password"]'));
            for (let passInput of retryPasswords) {
              try {
                // Visibility check - some inputs may be hidden
                let passDisplayed = false;
                try {
                  passDisplayed = await passInput.isDisplayed();
                } catch (e) {
                  // If isDisplayed throws, check via JS instead
                  passDisplayed = await driver.executeScript(`
                    const el = arguments[0];
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
                  `, passInput);
                }

                const passRect = await passInput.getRect();
                if (passDisplayed && passRect.width > 50) {
                  passwordFound = true;

                  const inputClass = await passInput.getAttribute('class');
                  if (inputClass && inputClass.includes('entry-disabled')) {
                    console.log(MSG.ENTRY_DISABLED_REMOVING);
                    await driver.executeScript(`
                      arguments[0].classList.remove('entry-disabled');
                      arguments[0].removeAttribute('disabled');
                      arguments[0].removeAttribute('readonly');
                    `, passInput);
                    await driver.sleep(150);
                  }

                  // Check and fill the password value
                  const currentValue = await passInput.getAttribute('value');
                  if (!currentValue || currentValue.length === 0) {
                    // Clear via JS first, then fill
                    await driver.executeScript("arguments[0].value = '';", passInput);
                    await driver.executeScript("arguments[0].focus();", passInput);
                    await driver.sleep(100);

                    // Enter via sendKeys
                    await passInput.sendKeys(PASSWORD);

                    // Check whether the value was entered
                    const newValue = await passInput.getAttribute('value');
                    if (newValue && newValue.length > 0) {
                      console.log(MSG.PASSWORD_RETRY_SUCCESS);
                      passwordFilled = true;
                    } else {
                      await driver.executeScript(`arguments[0].value = arguments[1];`, passInput, PASSWORD);
                      await driver.executeScript(`
                        arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
                        arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
                      `, passInput);
                      console.log(MSG.PASSWORD_JS_SUCCESS);
                      passwordFilled = true;
                    }
                  } else {
                    console.log(MSG.PASSWORD_ALREADY_FILLED);
                    passwordFilled = true;
                  }
                  break;
                }
              } catch (e) { }
            }

            if (!passwordFound) {
              console.log(MSG.PASSWORD_NOT_FOUND);

              // Find and fill the email input
              const retryEmailInputs = await driver.findElements(By.css('input[type="text"]'));
              for (let input of retryEmailInputs) {
                try {
                  const isDisplayed = await input.isDisplayed();
                  const rect = await input.getRect();
                  if (isDisplayed && rect.width > 50) {
                    await driver.executeScript("arguments[0].value = '';", input);
                    await input.sendKeys(EMAIL);
                    console.log(MSG.EMAIL_SUCCESS);
                    await driver.sleep(CFG.SLEEP.MEDIUM);
                    try {
                      await driver.findElement(By.id("btnVerify")).click();
                      console.log(MSG.VERIFY_CLICKED);
                    } catch (e) {
                      console.log(MSG.VERIFY_NOT_FOUND);
                    }
                    await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
                    break;
                  }
                } catch (e) { }
              }

              console.log(MSG.PASSWORD_WAITING);
              await driver.sleep(750);

              const newPasswords = await driver.findElements(By.css('input[type="password"]'));
              for (let passInput of newPasswords) {
                try {
                  let passDisplayed = false;
                  try {
                    passDisplayed = await passInput.isDisplayed();
                  } catch (e) {
                    passDisplayed = await driver.executeScript(`
                      const el = arguments[0];
                      const style = window.getComputedStyle(el);
                      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
                    `, passInput);
                  }

                  const passRect = await passInput.getRect();
                  if (passDisplayed && passRect.width > 50) {

                    const inputClass = await passInput.getAttribute('class');
                    if (inputClass && inputClass.includes('entry-disabled')) {
                      console.log(MSG.ENTRY_DISABLED_REMOVED);
                      await driver.executeScript(`
                        arguments[0].classList.remove('entry-disabled');
                        arguments[0].removeAttribute('disabled');
                        arguments[0].removeAttribute('readonly');
                      `, passInput);
                      await driver.sleep(150);
                    }

                    await driver.executeScript("arguments[0].value = '';", passInput);
                    await driver.executeScript("arguments[0].focus();", passInput);
                    await driver.sleep(100);
                    await passInput.sendKeys(PASSWORD);

                    const newValue = await passInput.getAttribute('value');
                    if (newValue && newValue.length > 0) {
                      console.log(MSG.PASSWORD_RETRY_SUCCESS);
                      passwordFilled = true;
                    } else {
                      await driver.executeScript(`arguments[0].value = arguments[1];`, passInput, PASSWORD);
                      await driver.executeScript(`
                        arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
                        arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
                      `, passInput);
                      console.log(MSG.PASSWORD_JS_SUCCESS);
                      passwordFilled = true;
                    }
                    break;
                  }
                } catch (e) { }
              }
            }

            if (!passwordFilled) {
              console.log(MSG.PASSWORD_FILL_FAILED);
            }

            await driver.sleep(250);
          }

          console.log(MSG.LOGIN_CAPTCHA_SOLVING);
          await solveCaptchaInIframe(driver, 0, CFG.RETRY.MAX_CAPTCHA_RETRIES, true);

          await driver.sleep(750);
          console.log(MSG.AFTER_LOGIN_CHECKING);
          await checkAndHandleUnavailable(driver);

          await driver.wait(until.urlContains(CFG.BLS_HOME_URL), 8000);
          console.log(MSG.LOGIN_SUCCESS);
          loginSuccess = true;

        } catch (e) {
          loginRetries++;
          console.log(MSG.LOGIN_FAILED(e.message));

          if (loginRetries >= maxLoginRetries) {
            console.log(MSG.LOGIN_MAX_RETRY(maxLoginRetries));
            throw new Error("Login failed - max attempts exceeded");
          }

          await driver.sleep(CFG.SLEEP.AFTER_LOGIN);
        }
      }

      await driver.sleep(750);

      // "Application Temporarily Unavailable" check
      await checkAndHandleUnavailable(driver);

      // Single city. CFG.CITY must match the jurisdiction already set on the
      // account - the bot does not change the applicant profile.
      try {
        await scanCity(driver, CFG.CITY);
      } catch (e) {
        console.log(MSG.CITY_SCAN_ERROR(CFG.CITY.name, e.message));
      }

    } catch (e) {
      console.error(MSG.GLOBAL_ERROR(e.message));
    } finally {
      await driver.quit();
    }
  })();
}

// app.js now only runs the main() function
// Use main.js for the loop!
main();