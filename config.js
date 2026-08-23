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

    // === CITY ===
    // Single city only. The applicant's jurisdiction is set by hand in the
    // portal profile; the bot never changes it. LOCATION fills the booking
    // form's Location dropdown. The Pakistan form has NO Jurisdiction field.
    CITY: { name: 'Islamabad', LOCATION: 'Islamabad' },

    // === RETRY & TIMEOUT ===
    RETRY: {
        MAX_LOGIN_RETRIES: 3,
        MAX_CAPTCHA_RETRIES: 3,
        MAX_APPOINTMENT_RETRIES: 3,
        MAX_UNAVAILABLE_RETRIES: 5,
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
    },
};
