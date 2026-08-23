/**
 * BLS Visa Checker - Central log messages
 * All console.log messages are managed from here.
 */

module.exports = {
    // === GENERAL ===
    PAGE_LOADED: 'Page loaded...',
    PAGE_REFRESHED: '✅ Page refreshed!',

    // === UNAVAILABLE ===
    UNAVAILABLE_DETECTED: '⚠️ "Application Temporarily Unavailable" error detected! Waiting 10 seconds...',
    UNAVAILABLE_REFRESHING: 'Refreshing page...',

    // === LOGIN ===
    EMAIL_WAITING: 'Waiting for email input field...',
    EMAIL_NOT_FOUND: '❌ Email input not found',
    EMAIL_ENTERING: 'Entering email...',
    EMAIL_SUCCESS: '✅ Email entered successfully!',
    EMAIL_ERROR: (msg) => `Failed to fill email: ${msg}`,

    VERIFY_CLICKED: '✅ Verification submitted',
    VERIFY_NOT_FOUND: '⚠️ btnVerify not found',

    PASSWORD_WAITING: 'Waiting for password page...',
    PASSWORD_NOT_FOUND: '⚠️ Password field not found - may have returned to the email page',
    PASSWORD_ENTERING: 'Entering password...',
    PASSWORD_SUCCESS: '✅ Password entered successfully!',
    PASSWORD_RETRY_SUCCESS: '✅ Password entered on retry!',
    PASSWORD_JS_SUCCESS: '✅ Password entered via JS!',
    PASSWORD_ALREADY_FILLED: '✅ Password already filled',
    PASSWORD_ERROR: (msg) => `Failed to fill password: ${msg}`,
    PASSWORD_FILL_FAILED: '❌ Could not fill the password field!',
    ENTRY_DISABLED_REMOVING: '⚠️ entry-disabled class detected, removing...',
    ENTRY_DISABLED_REMOVED: '⚠️ Removing entry-disabled class...',

    LOGIN_RETRYING: (num, max) => `\n🔄 Retrying login (${num}/${max})...`,
    LOGIN_CAPTCHA_SOLVING: 'Solving login captcha...',
    LOGIN_SUCCESS: '✅ Login successful! Redirected to the home page.',
    LOGIN_FAILED: (msg) => `❌ Login failed: ${msg}`,
    LOGIN_MAX_RETRY: (max) => `❌ Maximum retry count reached (${max})`,

    // === CAPTCHA ===
    CAPTCHA_SOLVING: 'Solving captcha...',
    CAPTCHA_SOLVED: '✅ Captcha solved!',
    CAPTCHA_DETECTED: '🔒 Captcha screen detected, solving...',
    CAPTCHA_FORM_SUCCESS: '✅ Captcha solved, redirected to the form page!',
    CAPTCHA_NOT_NEEDED: '✅ On the form page - no captcha!',
    CAPTCHA_FORM_DETECTED: '🔒 CAPTCHA screen detected after form submit!',
    CAPTCHA_PREMIUM_DETECTED: '🔒 CAPTCHA screen detected after premium form submit!',
    CAPTCHA_PREMIUM_SOLVED: '✅ Premium captcha solved!',
    CAPTCHA_PREMIUM_FAILED: (msg) => `❌ Could not solve premium captcha: ${msg}`,
    CAPTCHA_FAILED: (msg) => `❌ Could not solve captcha: ${msg}`,
    RATE_LIMIT: '😤 Rate limited! Backing off... 30 second break ☕',

    // === APPOINTMENT CAPTCHA ===
    BOOK_NOW_CLICKED: '✅ "Book Now" clicked',
    BOOK_NOW_NOT_FOUND: (msg) => `❌ "Book Now" button not found: ${msg}`,
    APPOINTMENT_PAGE_CHECKING: 'Checking the appointment page...',
    APPOINTMENT_CAPTCHA_RETRYING: (num, max) => `\n🔄 Retrying appointment captcha (${num}/${max})...`,
    APPOINTMENT_CAPTCHA_SOLVING: 'Solving the appointment page captcha...',
    APPOINTMENT_CAPTCHA_SUCCESS: '✅ Appointment captcha passed! Redirected to the form page.',
    APPOINTMENT_CAPTCHA_ALT_SUCCESS: '✅ Form page detected (alternative check)!',
    APPOINTMENT_CAPTCHA_FAILED: (msg) => `❌ Appointment captcha failed: ${msg}`,
    APPOINTMENT_MAX_RETRY: (max) => `❌ Maximum retry count reached (${max})`,
    HOME_REDIRECT_BOOK_NOW: 'Back on the home page, clicking \'Book Now\' again...',

    AFTER_LOGIN_CHECKING: 'Running post-login-captcha check...',
    AFTER_CAPTCHA_CHECKING: 'Running post-appointment-captcha check...',
    FORM_REDIRECT_WAITING: 'Waiting for redirect to the form page...',
    FORM_DIRECT: '✅ Landed directly on the form page - CAPTCHA SKIPPED!\nForm screen ready...',
    FORM_DETECTED_SOURCE: '✅ Form page detected (page source) - NO CAPTCHA!',
    FORM_CAPTCHA_DETECTED: 'Captcha page detected, solving...',
    FORM_READY: '✅ Form page ready!',
    CURRENT_URL: (url) => `Current URL: ${url}`,

    // === FORM FILLING ===
    FORM_FILLING_DROPDOWNS: '📝 Filling form fields...',
    FORM_SUBMIT_CHECKING: '📋 Checking the page after form submit...',
    FORM_ALL_DONE: '✅ Form fields completed',
    FORM_SUBMIT_SEARCHING: 'Looking for submit...',
    FORM_SUBMITTED: '✅ Form submitted!',
    FORM_SUBMITTED_JS: '✅ Form submitted via JS!',
    FORM_SUBMIT_JS_FALLBACK: 'Submitting via JS...',
    APPOINTMENT_FOR_INFO: '📌 Appointment For: Individual (default)',

    LOCATION_FAILED: '❌ Could not select Location, form cannot be submitted!',
    VISA_TYPE_FAILED: '❌ Could not select Visa Type, form cannot be submitted!',
    VISA_SUB_TYPE_FAILED: '❌ Could not select Visa Sub Type, form cannot be submitted!',
    CATEGORY_FAILED: '❌ Could not select Category, form cannot be submitted!',

    // === DROPDOWN (Kendo — result line only) ===
    DROPDOWN_SELECTED: (label, value) => `✅ ${label}: selected ${value}`,
    DROPDOWN_NOT_FOUND: (label) => `❌ ${label} dropdown not found`,
    DROPDOWN_NOT_SELECTED: (label, value) => `❌ ${label}: could not select "${value}"`,
    DROPDOWN_ERROR: (label, msg) => `❌ ${label} dropdown: ${msg}`,

    // === TRY AGAIN / BOOK NOW ===
    TRY_AGAIN_LINK_CLICKED: '✅ Try Again (link) clicked',
    TRY_AGAIN_BTN_CLICKED: '✅ Try Again clicked',
    TRY_AGAIN_NOT_FOUND: '⚠️ Try Again button not found, clicking Book Now instead...',
    BOOK_NOW_BTN_CLICKED: '✅ Book Now clicked!',
    TRY_AGAIN_FAILED: (msg) => `❌ Try Again/Book Now error: ${msg}`,

    // === PREMIUM ===
    PREMIUM_FLOW_STARTING: '🌟 Premium category flow',
    PREMIUM_FORM_FILLING: '📝 Filling the premium form...',
    PREMIUM_MODAL_SUMMARY: (text) => `✅ Premium modal: ${text.substring(0, 80).replace(/\s+/g, ' ').trim()}…`,
    PREMIUM_MODAL_ACCEPT_CLICKED: '✅ Accept button clicked!',
    PREMIUM_MODAL_ACCEPT_NOT_FOUND: '⚠️ Accept button not found, continuing...',
    PREMIUM_MODAL_NOT_FOUND: '⚠️ Premium modal dialog not found (it may already be closed)',
    PREMIUM_MODAL_ERROR: (msg) => `⚠️ Error while checking the modal dialog (non-critical): ${msg}`,
    PREMIUM_FORM_DONE: '✅ Premium form completed',
    PREMIUM_SUBMIT_SEARCHING: 'Looking for submit...',
    PREMIUM_SUBMITTED: '✅ Premium form submitted!',
    PREMIUM_SUBMITTED_JS: '✅ Premium form submitted via JS!',
    PREMIUM_CHECKING: '📋 Checking the page after the premium form...',
    PREMIUM_SLOT_FOUND: '📅 Premium slot selection page',
    PREMIUM_SLOT_NOT_FOUND: '❌ No slots in Premium Category either!',
    PREMIUM_BOTH_CLOSED: 'Both categories are closed - script is exiting...',
    PREMIUM_FAILED: (msg) => `❌ Error in the Premium Category flow: ${msg}`,
    PREMIUM_CAPTION_PAGE_CHECKING: '📋 Checking the page (is there a captcha?)...',
    PREMIUM_CAPTCHA_RETRYING: (num, max) => `🔄 Captcha retry (${num}/${max})...`,
    PREMIUM_CAPTCHA_FAILED: (msg) => `❌ Captcha error: ${msg}`,

    // === SLOT CHECK ===
    SLOT_OPEN: (cat) => `✅ ${cat}: slots are open`,
    SLOT_TELEGRAM_SENT: '✅ Slot-open notification sent to Telegram!',
    SLOT_TELEGRAM_FAILED: (msg) => `Could not send Telegram notification: ${msg}`,
    SLOT_CLOSED: (cat) => `❌ ${cat}: slots are closed`,
    SLOT_NO_DATE_PICKER: (cat) => `🔔 BUT THE ${cat} SLOT PAGE IS OPEN! Manual check recommended...`,
    SLOT_NO_CALENDAR: (cat) => `🔔 BUT THE ${cat} SLOT PAGE IS OPEN!`,

    // === DATE SCANNING ===
    DATE_PICKER_READY: '✅ Appointment date field ready',
    DATE_PICKER_NOT_FOUND: '❌ Date picker not found!',
    CALENDAR_OPENING: '📅 Opening the calendar...',
    CALENDAR_OPENED: (method) => `✅ Calendar opened (${method})`,
    CALENDAR_NOT_OPENED: '❌ Could not open the calendar',
    CALENDAR_ELEM_NOT_FOUND: '❌ No calendar element',
    CALENDAR_ELEM_FOUND: (count) => `✅ Calendar: ${count} panel(s)`,
    CALENDAR_SEARCHING: (cat) => `🔍 ${cat} — scanning for available dates`,
    CALENDAR_MONTH_CHECKING: (month) => `📅 ${month}`,
    CALENDAR_MONTH_NO_HEADER: (idx) => `⚠️ Month ${idx + 1}: no header`,
    CALENDAR_NO_DATES: '⚠️ No date cells in this month',
    CALENDAR_MONTH_GREEN: (month, count) => `✅ ${month}: ${count} available day(s)`,
    CALENDAR_MONTH_EMPTY: (month) => `⚪ ${month}: no available days`,
    CALENDAR_NEXT_MONTH: (num, max) => `➡️ Next month (${num}/${max})`,
    CALENDAR_NEXT_MONTH_ERROR: (msg) => `⚠️ Error moving to the next month: ${msg}`,
    CALENDAR_MONTH_ERROR: (msg) => `⚠️ Month scan error: ${msg}`,
    CALENDAR_TOTAL_GREEN: (cat, count) => `📊 ${cat}: ${count} available day(s) in total`,
    CALENDAR_NO_DATES_FOUND: (cat) => `❌ ${cat}: NO AVAILABLE DATES AT ALL!`,
    CALENDAR_CLOSING: '📅 Closing the calendar...',
    CALENDAR_CLOSED: '✅ Calendar closed',
    CALENDAR_CLOSE_ERROR: (msg) => `⚠️ Error closing the calendar (non-critical): ${msg}`,
    SCAN_DONE: (cat) => `🎉 ${cat} scan finished`,

    // === TELEGRAM ===
    TELEGRAM_SENT: '✅ Telegram notification sent!',
    TELEGRAM_FAILED: (msg) => `❌ Could not send Telegram notification: ${msg}`,
    TELEGRAM_FAILED_SIMPLE: 'Could not send Telegram notification',

    // === CITY ===
    CITY_SCAN_START: (name) => `🏙️ ${name} scan starting`,
    CITY_SCAN_DONE: (name) => `✅ ${name} scan finished`,
    CITY_SCAN_ERROR: (name, msg) => `❌ Error during the ${name} scan: ${msg}`,

    // === NORMAL SLOT ===
    NORMAL_SLOT_FOUND: '📅 Normal category — slot selection page',
    NORMAL_NO_SLOT: '⚠️ No slots in Normal Category, trying Premium Category...',

    // === GENERAL ERROR ===
    GLOBAL_ERROR: (msg) => `❌ An error occurred: ${msg}`,

    // === STATE MACHINE ===
    MACHINE_START: 'State machine starting.',
    MACHINE_DONE: (result, transitions, searches) =>
        `Run finished: ${result} after ${transitions} transitions. Searches used (all time): ${searches}.`,
    MACHINE_RESULTS: (results) =>
        `Category results: ${Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
};
