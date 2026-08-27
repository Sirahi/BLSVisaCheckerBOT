/**
 * BLS Visa Checker - Central configuration
 * All static values are managed from here.
 */

// Loaded HERE, not only in app.js. config.js is required at app.js:11 but
// app.js does not call dotenv until line 21, so without this the switches
// below would read process.env before .env had been applied - and MULTI_CITY
// set in .env would be silently ignored. dotenv never overwrites a variable
// that is already set, so the real shell environment still wins.
require('dotenv').config({ quiet: true });

const BASE_URL = 'https://appointment.thespainvisa.com';

// The full catalogue of searchable cities - see the CITIES comment in the
// export below for why the portal profile matters more than the form dropdown.
// VISA_SUB_TYPE is OPTIONAL per city and overrides FORM.VISA_SUB_TYPE for that
// city only. The portal serves the Visa Sub Type dropdown per LOCATION - Kendo
// loads it by AJAX once Location and Visa Type are set - so each centre
// publishes its own catalogue and there is no single value that fits them all.
const CITIES = [
    { name: 'Islamabad', LOCATION: 'Islamabad' },
    { name: 'Lahore', LOCATION: 'Lahore' },
    // Karachi's Visa Sub Type dropdown lists exactly two options - "National
    // Visa" and "National Visas (Study, Work & Other National Visas)" -
    // confirmed live 2026-08-27. FORM.VISA_SUB_TYPE is not among them, so the
    // city carries its own value. Full option text, matched by equality.
    { name: 'Karachi', LOCATION: 'Karachi', VISA_SUB_TYPE: 'National Visa' },
];

// ===== THE TWO SWITCHES =====================================================
//
// Edit the _DEFAULT literals to change the standing behaviour; use the env
// vars to override a single run without touching code. The profile is changed
// by hand on the portal anyway, and the two changes want to happen together.
//
//   MULTI_CITY=1 npm start           this run searches every entry in CITIES
//   MULTI_CITY=0 npm start           this run searches one city, whatever the default
//   ACTIVE_CITY=Lahore npm start     this run searches Lahore
//
const MULTI_CITY_DEFAULT = false;      // <- flip to true for permanent multi-city
const ACTIVE_CITY_DEFAULT = 'Islamabad'; // <- the single city when multi is off

// Truthiness is spelled out rather than `=== '1'` so MULTI_CITY=0 can turn the
// mode OFF for one run. With a bare `=== '1'` check there is no way to override
// a default of true from the environment, only to confirm it.
const MULTI_CITY = process.env.MULTI_CITY
    ? /^(1|true|yes|on)$/i.test(process.env.MULTI_CITY)
    : MULTI_CITY_DEFAULT;

const ACTIVE_CITY = process.env.ACTIVE_CITY || ACTIVE_CITY_DEFAULT;

// Resolved at require time so a bad ACTIVE_CITY kills the process before it
// touches the portal. Falling back to CITIES[0] would be worse than crashing:
// a typo would quietly search the wrong queue and burn searches doing it.
function resolveActiveCities() {
    if (MULTI_CITY) return CITIES;
    const only = CITIES.find((c) => c.name === ACTIVE_CITY);
    if (!only) {
        throw new Error(
            `config.ACTIVE_CITY "${ACTIVE_CITY}" is not in CITIES ` +
            `(${CITIES.map((c) => c.name).join(', ')}). Refusing to guess.`
        );
    }
    return [only];
}

// ===== SCHEDULER ============================================================
//
// The loop runs round the clock. It used to keep working hours (08:00-24:00
// Karachi) with a fast morning and a slow afternoon, which meant two things
// that turned out to be wrong: it slept through the night, and it checked on a
// flat cadence. A human hunting a visa slot does not search at 08:00, 08:20
// and 08:40 on the dot - so every gap is now drawn fresh from a range instead.
const SCHEDULER = {
    // The portal's timezone, NOT the machine's. This machine runs
    // Europe/London, which is UTC+1 in summer and UTC+0 in winter, while
    // Asia/Karachi is UTC+5 year-round - so the gap between them is 4
    // hours today and 5 hours after BST ends in October. Nothing in the
    // schedule depends on the hour any more, but the LOGS do: a timestamp
    // in machine time is useless for lining a run up against the portal.
    TIMEZONE: 'Asia/Karachi',

    // --- Pacing ---
    //
    // The gap between one cycle finishing and the next starting, drawn
    // uniformly from [MIN, MAX] after every cycle. Both are in minutes and
    // both are yours to tune; the pair is the ONLY pacing control now.
    //
    // Mind what the numbers cost. One cycle spends one real search per city
    // per category - two a cycle in the standing single-city setup - and
    // running 24/7 at 20-40m is ~48 cycles a day where the old split day was
    // ~30. The portal has blocked this account before. Widening the range
    // slows the burn AND makes the pattern less regular, so it is the right
    // dial to reach for first.
    INTERVAL_MIN_MINUTES: 20,
    INTERVAL_MAX_MINUTES: 40,

    // A guard trip or a crash is usually transient (a stale element, a
    // dropped VPN). Several in a row is not - stop rather than grind
    // through the night failing.
    MAX_CONSECUTIVE_FAILURES: 3,

    // --- Block handling ---
    //
    // A block (exit 20) used to stop the loop outright, which threw away
    // the rest of the day: blocked at 11am meant dead until a human
    // noticed. It now retries instead. Every cycle spawns a fresh browser
    // and re-detects from whatever page it lands on, so a blocked run
    // leaves nothing to unwind - the next one starts again from LOGIN or
    // HOME on its own.
    //
    // A blocked cycle is NOT paced by the random draw. The randomness exists
    // to look human while polling, and a blocked bot is not polling - so the
    // first backed-off wait is INTERVAL_MAX_MINUTES, the slowest ordinary
    // pace, and each further consecutive block multiplies from there.
    // Deliberately below 2x: doubling reaches the ceiling in four blocks and
    // sleeps away most of a day. At 1.5x from 40m the ladder runs
    // 40, 60, 90, then the ceiling.
    BLOCK_BACKOFF_MULTIPLIER: 1.5,
    // Ceiling on a single backed-off wait. Must be at least
    // INTERVAL_MAX_MINUTES or a "backoff" would be faster than an ordinary
    // wait; equal is allowed and simply means the backoff never grows.
    BLOCK_BACKOFF_MAX_MIN: 120,
    // The streak resets on any cycle that gets through, so this counts
    // UNBROKEN blocks only. With no night sleep left to clear the streak,
    // this is now the ONLY thing that stops a permanently blocked loop:
    // 40 + 60 + 90 + 120 x 9 is about 21 hours before it gives up and
    // sends the Telegram.
    MAX_CONSECUTIVE_BLOCKS: 12,
};

// Refuses rather than guesses, for the same reason resolveActiveCities does:
// a swapped pair or a ceiling below the upper limit does not crash, it just
// paces the bot wrongly for as long as nobody looks at the logs.
function validateScheduler(s) {
    const { INTERVAL_MIN_MINUTES: lo, INTERVAL_MAX_MINUTES: hi, BLOCK_BACKOFF_MAX_MIN: cap } = s;
    if (!(lo > 0)) {
        throw new Error(`config.SCHEDULER.INTERVAL_MIN_MINUTES must be greater than 0, got ${lo}.`);
    }
    if (hi < lo) {
        throw new Error(
            `config.SCHEDULER.INTERVAL_MIN_MINUTES (${lo}) is above ` +
            `INTERVAL_MAX_MINUTES (${hi}). Refusing to guess which way round you meant them.`
        );
    }
    // Strictly greater only. A ceiling that EQUALS the upper limit is a valid
    // choice - it means "back off to the slowest normal pace and no further".
    if (hi > cap) {
        throw new Error(
            `config.SCHEDULER.BLOCK_BACKOFF_MAX_MIN (${cap}) is below ` +
            `INTERVAL_MAX_MINUTES (${hi}), which would make a backed-off wait ` +
            `SHORTER than an ordinary one.`
        );
    }
    return s;
}

validateScheduler(SCHEDULER);

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
    // 2026-08-20. Matching is EQUALITY on the option text, normalised for case
    // and internal whitespace (optionMatches in portalActions.js), so each
    // value below must be the option's FULL text, not a distinctive fragment.
    // A value that no longer exists fails loudly and dumps the real list.
    FORM: {
        // Full option text, confirmed live. The space falls after the slash
        // and not before it; matching normalises spacing, so that detail
        // cannot break the match on its own.
        VISA_TYPE: 'National Visa/ Long Term Visa',
        // Full option text, confirmed live on Islamabad and Lahore. Karachi
        // does not list this option and overrides it in CITIES.
        VISA_SUB_TYPE: 'Family Reunification Visa',
        CATEGORY_NORMAL: 'Normal',
        CATEGORY_PREMIUM: 'Premium',
    },

    // === CITIES ===
    // The city lives in TWO places on this portal: the applicant's profile
    // (persistent, server-side, set through Manage Applicants) and the booking
    // form's Location dropdown. Setting only the form does not move the search.
    // The portal also offers Karachi (id 7664); it is deliberately excluded.
    //
    // CITIES is the CATALOGUE of what the bot knows how to search. What it
    // actually searches on a given run is ACTIVE_CITIES, resolved below.
    CITIES,

    // Multi-city works and is fully implemented - it is switched off, not
    // removed. Each extra city costs one more profile edit AND one more real
    // search per cycle, and that search rate is what got the account blocked.
    // Flip to true to search every entry in CITIES again.
    MULTI_CITY,

    // Used only when MULTI_CITY is false. Must name an entry in CITIES.
    //
    // Single-city mode ASSUMES the portal profile is already pinned to this
    // city and skips the Manage Applicants edit entirely (see runner.js). That
    // assumption is the whole saving, and it is also the whole risk: if the
    // profile is actually on a different city, every search silently runs
    // against that other city under this one's name. Change the profile by
    // hand first, then change this.
    ACTIVE_CITY,

    // The cities this run will actually plan over. Derived, never hand-edited.
    ACTIVE_CITIES: resolveActiveCities(),

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
        // Left at 60 with MULTI_CITY off: it is a backstop, not a budget, and
        // sizing it down to the single-city plan would only convert a slow but
        // legitimate run into an abort. The real spend limit is planSize.
        MAX_TRANSITIONS: 60,
        OSCILLATION_LIMIT: 6, // must exceed BUDGET.unavailable
        SEARCH_FILE: require('path').join(__dirname, '.search-count.json'),
        // Append-only ledger of every real btnSubmit, one JSON line each.
        // SEARCH_FILE holds an all-time total, which cannot answer "how many
        // in the last N hours" - the only form of the question that matters
        // for pacing against the block.
        SEARCH_LOG: require('path').join(__dirname, 'logs', 'searches.jsonl'),
        // Crossed with ACTIVE_CITIES to build the run plan - see buildPlan in runner.js.
        CATEGORIES: ['Normal', 'Premium'],
    },

    // === BUDGET: attempts each phase of a run may spend ====================
    //
    // Not for-loop retries: the state machine re-detects the page every pass,
    // so a failed attempt lands on the same state again and these counters are
    // the only thing that ends the loop. Running one out ends the run with
    // BUDGET_EXHAUSTED -> exit 30 -> GUARD_ABORT.
    //
    // budget.js resetTraversal() clears everything except `login` at each
    // city x category boundary, so those are per COMBO, not per run.
    //
    // (The RETRY block above is dead config - MAX_CAPTCHA_RETRIES looks like
    // the captcha lever but nothing reads it. `login` and `preForm` are.)
    BUDGET: {
        login: 3,       // login-page captcha attempts; the one counter never reset, so 3 per RUN
        preForm: 8,     // booking-form captcha attempts; costs a captcha, never a search - cheapest to raise
        postForm: 3,    // entries into the submit form; EXPENSIVE - but the planSize ceiling caps real searches first
        profile: 3,     // Manage Applicants subflow attempts; unspent in single-city mode, exists for MULTI_CITY
        unavailable: 5, // outage-page refreshes at 5s each; MACHINE.OSCILLATION_LIMIT must stay ABOVE this
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

    // === MODALS ===
    MODAL: {
        // How long to WAIT for a modal the portal is about to raise, after the
        // dropdown selection that triggers it. Selecting Visa Type = National
        // opens an "Information" dialog and Category = Premium opens a
        // confirmation; both fade in a few hundred ms after the selection
        // returns, and an undismissed one covers the dropdowns below it.
        //
        // Sampling the DOM once instead of waiting cost four whole cycles on
        // 2026-08-27 - each died on "Visa Sub Type: list never rendered" with
        // the Information modal still sitting on top of it.
        //
        // Paid only after a field is set, and abandoned the moment a modal is
        // found, so the common no-modal case costs this once per field and the
        // triggering case costs almost nothing.
        SETTLE_MS: 1500,
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
    SCHEDULER,

    // Exported for the tests: the invariants below are the kind that are only
    // ever wrong by hand-editing, and a throw at require time is no use to a
    // test that wants to prove WHICH edit is refused.
    validateScheduler,

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
