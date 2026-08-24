/**
 * BLS Visa Checker - Central configuration
 * All static values are managed from here.
 */

const BASE_URL = 'https://appointment.thespainvisa.com';

module.exports = {
    BASE_URL,

    // === URL ===
    LOGIN_URL: 'https://appointment.thespainvisa.com/Global/Account/LogIn',
    BOOK_NOW_URL: '/Global/appointment/newappointment',
    BLS_HOME_URL: '/Global/home/index',
    // The Pakistan form posts to /Global/Appointment/VisaType. The Turkey
    // value was /Global/bls/visatype, which never matched - so the post-captcha
    // "did we reach the form?" wait timed out every time and forced a retry.
    // Compared case-insensitively (see urlIsForm in app.js).
    VISA_TYPE_URL: '/Global/Appointment/VisaType',
    MY_APPOINTMENTS_URL: 'https://appointment.thespainvisa.com/Global/appointmentdata/MyAppointments',

    // === FORM VALUES ===
    // All values below confirmed against the live Intiana Pakistan portal,
    // 2026-08-20. Matching is case-insensitive substring (see
    // selectKendoDropdownByLabel in app.js), so these are chosen to be
    // distinctive enough to match exactly one option each.
    FORM: {
        // Confirmed from live portal. Full option text is
        // 'National Visa/ Long Term Visa'; we match on a distinctive substring
        // so a whitespace difference around the slash cannot break it.
        VISA_TYPE: 'National Visa',
        // Confirmed. Full option text is 'Family Reunification Visa';
        // this substring matches it and nothing else in the list.
        VISA_SUB_TYPE: 'Family Reunification',
        CATEGORY_NORMAL: 'Normal',
        CATEGORY_PREMIUM: 'Premium',
    },

    // === CITIES ===
    // The city lives in TWO places on this portal: the applicant's profile
    // (persistent, server-side, set through Manage Applicants) and the booking
    // form's Location dropdown. Setting only the form does not move the search.
    // The portal also offers Karachi (id 7664); it is deliberately excluded.
    CITIES: [
        { name: 'Islamabad', LOCATION: 'Islamabad' },
        { name: 'Lahore', LOCATION: 'Lahore' },
    ],

    // === RETRY & TIMEOUT ===
    RETRY: {
        MAX_LOGIN_RETRIES: 3,
        MAX_CAPTCHA_RETRIES: 3,
        MAX_APPOINTMENT_RETRIES: 3,
        MAX_UNAVAILABLE_RETRIES: 5,
    },

    // === STATE MACHINE ===
    MACHINE: {
        // A clean 2-city x 2-category cycle is 25 transitions (was 10 for one
        // city). 40 left no room for captcha retries across four combos.
        MAX_TRANSITIONS: 60,
        OSCILLATION_LIMIT: 6, // must exceed BUDGET.unavailable
        SEARCH_FILE: require('path').join(__dirname, '.search-count.json'),
        // Append-only ledger of every real btnSubmit, one JSON line each.
        // SEARCH_FILE holds an all-time total, which cannot answer "how many
        // in the last N hours" - the only form of the question that matters
        // for pacing against the block.
        SEARCH_LOG: require('path').join(__dirname, 'logs', 'searches.jsonl'),
        // Crossed with CITIES to build the run plan - see buildPlan in runner.js.
        CATEGORIES: ['Normal', 'Premium'],
    },

    BUDGET: {
        login: 3,
        preForm: 3,
        postForm: 3,
        profile: 3,
        unavailable: 5,
    },

    // === SLEEP (ms) ===
    SLEEP: {
        SHORT: 250,
        MEDIUM: 500,
        LONG: 1000,
        AFTER_LOGIN: 1500,
        AFTER_SUBMIT: 2500,
        RATE_LIMIT: 30000,
        CALENDAR_NAV: 750,
    },

    // === CALENDAR ===
    CALENDAR: {
        MAX_MONTHS_TO_CHECK: 12,
    },

    // === DROPDOWN ===
    DROPDOWN: {
        TIMEOUT: 10000, // ms
    },

    // === CAPTCHA ===
    CAPTCHA: {
        EARLY_EXIT_VOTES: 3,
        OCR_SUCCESS_RATE_THRESHOLD: 20,
        OCR_MIN_ATTEMPTS_FOR_CUT: 50,
    },

    // === TELEGRAM NOTIFICATION TEXT (when a slot is found) ===
    TELEGRAM: {
        SLOT_OPEN_LINK: 'https://appointment.thespainvisa.com/Global/Account/LogIn',
        // Repeat the slot-found alert to wake a sleeping human. COUNT includes
        // the first alert, so 1 reproduces the old single-shot behaviour.
        // 20 x 5s is about 95 seconds of buzzing; 12/min sits under Telegram's
        // per-chat rate limit. Repeats also buy resilience - a single network
        // blip at the moment of the find no longer loses the notification.
        SLOT_ALERT_COUNT: 10,
        SLOT_ALERT_INTERVAL_MS: 5000,
    },

    // === LOGGING ===
    LOG: {
        DIR: require('path').join(__dirname, 'logs'),
        CONSOLE_LEVEL: 'Display',
        FILE_LEVEL: 'Verbose',
        // One JSON line per completed cycle. Prose logs are for reading; this
        // is for answering "blocked after N searches in M hours".
        CYCLES_FILE: require('path').join(__dirname, 'logs', 'cycles.jsonl'),
    },

    // === SCHEDULER (main.js) ===
    SCHEDULER: {
        // The portal's timezone, NOT the machine's. This machine runs
        // Europe/London, which is UTC+1 in summer and UTC+0 in winter, while
        // Asia/Karachi is UTC+5 year-round - so the gap between them is 4
        // hours today and 5 hours after BST ends in October. Hardcoding an
        // offset would silently shift the whole schedule by an hour mid-season.
        TIMEZONE: 'Asia/Karachi',
        WORK_START_HOUR: 8,
        MORNING_END_HOUR: 12,  // intensive until here
        WORK_END_HOUR: 24,
        MORNING_INTERVAL_MIN: 20,
        AFTERNOON_INTERVAL_MIN: 120,
        // A guard trip or a crash is usually transient (a stale element, a
        // dropped VPN). Several in a row is not - stop rather than grind
        // through the night failing.
        MAX_CONSECUTIVE_FAILURES: 3,
    },

    // === SIMULATION (testing only, off unless SIMULATE_SLOTS is set) ===
    //
    // No run has ever reached the SLOTS state, so the only way to exercise
    // everything downstream of it - the repeating Telegram alerts, the
    // held-open browser, exit code 10, the scheduler's halt - is to fake it.
    //
    // The fake fires at VISA_FORM, the last moment BEFORE btnSubmit. By then
    // the run has done a real login, a real captcha and has a real
    // authenticated browser on the form, but has NOT spent a search. So the
    // whole path can be tested for zero searches.
    SIMULATE: {
        SLOTS: process.env.SIMULATE_SLOTS === '1',
    },

    // === WHAT TO DO WHEN SLOTS ARE FOUND ===
    SLOTS: {
        // Keep the browser open, authenticated, on the slots page so the
        // handover costs no re-login, no captcha, and no extra search.
        // chromedriver kills the browser when its client process exits, so
        // holding the process open is what keeps Chrome alive.
        HOLD_MINUTES: 120,
    },
};
