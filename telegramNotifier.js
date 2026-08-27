const axios = require("axios");
require("dotenv").config();
const CFG = require("./config");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ---------------------------------------------------------------------------
// Telegram's legacy Markdown treats _ * ` [ as entity delimiters and supports
// NO backslash escape - verified against the live API, "\_" is rejected in
// exactly the same way "_" is. So a runtime string carrying one of them
// desynchronises the parser and Telegram answers 400: the message is not
// delivered garbled, it is not delivered AT ALL.
//
// Seen live on 2026-08-27. The scheduler hit its failure cap and sent
//   "...3 consecutive failures (last was GUARD_ABORT, exit 30)..."
// inside an _italic_ span. The underscore in GUARD_ABORT closed that span
// early, the footer's own closing "_" was then left unterminated, and the API
// answered "can't parse entities: Can't find end of the entity starting at
// byte offset 204". The one message whose entire job is to announce that the
// bot has STOPPED was the one message that never arrived.
//
// Since escaping is not available, interpolated values are NEUTRALISED. A
// "GUARD ABORT" that reaches the phone beats a "GUARD_ABORT" that does not.
// Only INTERPOLATED values go through this - the fixed layout around them is
// authored here and is known to be balanced.
const MD_NEUTRAL = { '_': ' ', '*': ' ', '`': "'", '[': '(', ']': ')' };
const mdSafe = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/[_*`\[\]]/g, (c) => MD_NEUTRAL[c]);

// The city is per-alert now, not per-process: the bot searches more than one,
// so a module-level constant would name the wrong one on the single message
// this project exists to send. LOCATIONS is only for messages that describe the
// whole run (startup, blocked, no-slots), which genuinely cover every city.
//
// ACTIVE_CITIES, not CITIES: with multi-city switched off a run-level message
// naming both would tell a human at 3am to check a city the bot never looked at.
const LOCATIONS = mdSafe((CFG.ACTIVE_CITIES || CFG.CITIES || []).map((c) => c.name).join(' + ') || 'Unknown');
const VISA_TYPE = mdSafe(CFG.FORM.VISA_TYPE);

// Timestamp helper - 24-hour clock
const stamp = () => new Date().toLocaleString('en-GB');

// Where delivery failures go. console.error by default, but main.js runs its
// logger with tee:false - so a failure there printed to a terminal nobody was
// watching and left NOTHING in the log file. On 2026-08-27 that is exactly
// what happened: the halt notification was rejected by Telegram and the only
// evidence was a line on a console that had already scrolled away.
let report = (msg) => console.error(msg);
const setLogger = (fn) => { report = typeof fn === 'function' ? fn : ((m) => console.error(m)); };


// Base message-sending function
const sendMessageToTelegram = async (message, parseMode = 'Markdown') => {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const post = (body) => axios.post(url, body);

  try {
    await post({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: parseMode });
    return true;
  } catch (error) {
    const data = error.response ? error.response.data : null;
    const description = (data && data.description) || '';

    // Backstop, deliberately kept even though mdSafe should make it
    // unreachable. "Should" is not a good enough guarantee for the slot alert:
    // an unparseable message is still worth delivering WITHOUT formatting,
    // because the alternative is silence.
    if (parseMode && /can't parse entities/i.test(description)) {
      report(`Telegram rejected the formatting (${description}) - resending as plain text.`);
      try {
        await post({ chat_id: TELEGRAM_CHAT_ID, text: message });
        return true;
      } catch (e2) {
        const d2 = e2.response ? JSON.stringify(e2.response.data) : e2.message;
        report(`Telegram Error (plain-text retry also failed): ${d2}`);
        return false;
      }
    }

    report(`Telegram Error: ${data ? JSON.stringify(data) : error.message}`);
    return false;
  }
};

// 🎉 APPOINTMENT FOUND - with the available dates
const notifyAppointmentFound = async (availableDates, repeat = null) => {
  // Read the category if present
  const category = availableDates.length > 0 && availableDates[0].category
    ? availableDates[0].category
    : "Normal";

  const city = availableDates.length > 0 && availableDates[0].city
    ? availableDates[0].city
    : LOCATIONS;

  const categoryEmoji = category === "Premium" ? "⭐️" : "🎫";

  const header = "🎊🎉✨ *GREAT NEWS!* ✨🎉🎊\n";
  const subHeader = "🇪🇸 *APPOINTMENT DATES ARE OPEN!* 🇪🇸\n\n";

  const summary = `🌟 *${availableDates.length} date(s) available!*\n\n`;

  // Group the dates by month
  const datesByMonth = {};
  for (const dateObj of availableDates) {
    if (!datesByMonth[dateObj.month]) {
      datesByMonth[dateObj.month] = [];
    }
    datesByMonth[dateObj.month].push(mdSafe(dateObj.text));
  }

  // Add the grouped dates
  let datesText = "📅 *Available dates:*\n";
  for (const [month, dates] of Object.entries(datesByMonth)) {
    datesText += `\n🗓 *${mdSafe(month)}*\n`;
    datesText += `   💚 ${dates.join(' • ')}\n`;
  }

  const location = `\n📍 *Location:* ${mdSafe(city)} 🏛\n`;
  const visaType = `🎫 *Visa type:* ${VISA_TYPE} ✈️\n`;
  const categoryInfo = `${categoryEmoji} *Category:* ${mdSafe(category)}\n\n`;

  const action = "🚀 *GO NOW:*\n";
  const link = `🔗 [Open the visa portal](${CFG.TELEGRAM.SLOT_OPEN_LINK})\n\n`;

  const footer = "⏰ " + stamp() + "\n";
  // Numbered so N repeats read as one find being re-announced, not N finds.
  const counter = repeat && repeat.total > 1 ? `🔔 *Alert ${repeat.attempt}/${repeat.total}* — ` : "";
  const warning = counter + "⚡️ _Be quick! Appointments go fast._ 🏃‍♂️💨";

  const message = header + subHeader + summary + datesText + location + visaType + categoryInfo + action + link + footer + warning;

  return await sendMessageToTelegram(message);
};

// 😔 NO DATES AVAILABLE
const notifyNoAppointments = async (monthsScanned) => {
  const header = "😔 *No luck this time...*\n\n";

  const info = `🔍 Checked ${mdSafe(monthsScanned)} month(s)\n`;
  const result = "📅 No available dates right now 😢\n\n";

  const location = `📍 ${LOCATIONS}\n`;
  const visaType = `🎫 ${VISA_TYPE}\n\n`;

  const footer = "⏰ " + stamp() + "\n";
  const note = "💪 _Still watching. Will keep checking..._";

  const message = header + info + result + location + visaType + footer + note;

  return await sendMessageToTelegram(message);
};

// 🔒 APPOINTMENTS CLOSED
const notifyAppointmentsClosed = async () => {
  const header = "🔒 *Doors Closed* 🚪\n\n";

  const info = "😞 The appointment system is currently closed\n";
  const reason = "🇪🇸 Spain is not issuing appointments for this category\n\n";

  const location = `📍 ${LOCATIONS}\n`;
  const visaType = `🎫 ${VISA_TYPE}\n\n`;

  const footer = "⏰ " + stamp() + "\n";
  const note = "🤞 _Hopefully it opens soon - still watching._";

  const message = header + info + reason + location + visaType + footer + note;

  return await sendMessageToTelegram(message);
};

// 🤔 FORM FILLING ERROR
const notifyFormError = async (errorStep) => {
  const header = "🤔 *Something Went Wrong*\n\n";

  const error = `📝 Could not fill the form:\n_${mdSafe(errorStep)}_\n\n`;

  const footer = "⏰ " + stamp() + "\n";
  const note = "🔄 _No problem, I will try again._";

  const message = header + error + footer + note;

  return await sendMessageToTelegram(message);
};

// 🧩 CAPTCHA ERROR
const notifyCaptchaError = async (retryCount) => {
  const header = "🧩 *Captcha Was Too Hard* 😅\n\n";

  const info = `🔢 Attempt: ${mdSafe(retryCount)}/3\n`;
  const status = "🤖 Could not solve the puzzle this time\n\n";

  const footer = "⏰ " + stamp() + "\n";
  const note = "🎯 _Trying again - hopefully I get it next time._";

  const message = header + info + status + footer + note;

  return await sendMessageToTelegram(message);
};

// 🚀 BOT STARTED
const notifyBotStarted = async () => {
  const header = "🚀 *Hello! Ready To Go* 👋\n\n";

  const info = "🤖 Spain visa hunter is active!\n\n";

  const settings = "⚙️ *What I am doing:*\n";
  const location = `   📍 Watching ${LOCATIONS}\n`;
  const visaType = `   🎫 Looking for ${VISA_TYPE}\n`;
  const interval = "   ⏱ Checking on the configured schedule\n\n";

  const footer = "⏰ " + stamp() + "\n";
  const note = "🔔 _I will let you know as soon as a slot opens!_ ✨";

  const message = header + info + settings + location + visaType + interval + footer + note;

  return await sendMessageToTelegram(message);
};

// 😵 BOT STOPPED / ERROR
const notifyBotError = async (errorMessage) => {
  const header = "😵 *Something went wrong*\n\n";

  const error = `🐛 _${mdSafe(errorMessage)}_\n\n`;

  const footer = "⏰ " + stamp() + "\n";
  const note = "🔧 _Recovering and coming back._ 🏃‍♂️";

  const message = header + error + footer + note;

  return await sendMessageToTelegram(message);
};

// 🔔 SLOT PAGE REACHED BUT NOT READABLE
// cityName is per call. This message is the "the slot page is open, CHECK
// MANUALLY NOW" alert - it wakes a human, and naming every configured centre
// tells them to go and check a page without saying WHICH centre it belongs to.
// LOCATIONS stays as the fallback for callers that genuinely cover every city.
const notifySlotPageReached = async (errorDetail, cityName = null) => {
  const header = "🔔🔔🔔 *ATTENTION!* 🔔🔔🔔\n\n";

  const good = "✅ *REACHED THE SLOT SELECTION PAGE!*\n\n";
  const bad = `⚠️ Could not read the calendar: _${mdSafe(errorDetail)}_\n\n`;

  const important = "🚨 *THIS MATTERS!*\n";
  const meaning = "📅 The slot selection page being open means appointments MAY be available!\n\n";

  const action = "👉 *CHECK MANUALLY NOW:*\n";
  const link = `🔗 [Open the visa portal](${CFG.TELEGRAM.SLOT_OPEN_LINK})\n\n`;

  const location = `📍 ${cityName ? mdSafe(cityName) : LOCATIONS} | 🎫 ${VISA_TYPE}\n`;
  const footer = "⏰ " + stamp() + "\n\n";
  const note = "⚡️ _The bot could not read the calendar, but you can._";

  const message = header + good + bad + important + meaning + action + link + location + footer + note;

  return await sendMessageToTelegram(message);
};


// 🔁 REPEATED SLOT ALERTS
//
// A single notification is easy to sleep through, and a single network blip at
// the moment of the find loses it outright. Fire N of them a few seconds apart
// instead. COUNT includes the first, so 1 reproduces the old behaviour.
//
// Returns a handle - the caller MUST stop() it, because the pending interval
// keeps the Node process (and therefore the held-open browser) alive.
const startSlotAlerts = (availableDates) => {
  const total = Math.max(1, CFG.TELEGRAM.SLOT_ALERT_COUNT || 1);
  const gap = CFG.TELEGRAM.SLOT_ALERT_INTERVAL_MS || 5000;
  let sent = 0;
  let timer = null;

  const fire = () => {
    sent += 1;
    const n = sent;
    notifyAppointmentFound(availableDates, { attempt: n, total }).catch(() => {});
    if (sent >= total && timer) { clearInterval(timer); timer = null; }
  };

  fire();
  if (total > 1) timer = setInterval(fire, gap);

  return {
    get sent() { return sent; },
    get total() { return total; },
    get done() { return sent >= total; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
};

module.exports = {
  sendMessageToTelegram,
  setLogger,
  mdSafe,
  startSlotAlerts,
  notifyAppointmentFound,
  notifyNoAppointments,
  notifyAppointmentsClosed,
  notifyFormError,
  notifyCaptchaError,
  notifyBotStarted,
  notifyBotError,
  notifySlotPageReached
};
