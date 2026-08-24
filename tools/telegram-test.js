/**
 * Fires a FAKE slots-found alert through the real notification path, so the
 * thing being tested is the code that will actually run at 3am - startSlotAlerts,
 * the repeat timer, the message formatting - not a simplified stand-in.
 *
 *   node tools/telegram-test.js       # 3 alerts
 *   node tools/telegram-test.js 20    # the real configured burst
 *
 * Costs nothing: no browser, no portal, no search.
 */
require('dotenv').config({ quiet: true });
const CFG = require('../config');

const count = Number(process.argv[2]) || 3;
CFG.TELEGRAM.SLOT_ALERT_COUNT = count; // read by startSlotAlerts at call time

const { startSlotAlerts } = require('../telegramNotifier');

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing from .env.');
  console.error('Run: node tools/telegram-setup.js');
  process.exit(1);
}

// Shaped exactly like what scanAndNotifySlots collects from the calendar.
const fakeDates = [
  { text: '12', month: 'September 2026', category: 'Normal' },
  { text: '15', month: 'September 2026', category: 'Normal' },
  { text: '03', month: 'October 2026', category: 'Normal' },
];

const gap = CFG.TELEGRAM.SLOT_ALERT_INTERVAL_MS;
console.log(`Sending ${count} alert(s), ${gap}ms apart. Watch your phone.`);
console.log('THIS IS A TEST - no slots are actually open.');

const handle = startSlotAlerts(fakeDates);

const timer = setInterval(() => {
  if (handle.done) {
    clearInterval(timer);
    handle.stop();
    console.log(`Done - ${handle.sent}/${handle.total} sent.`);
    console.log('If nothing arrived, the error line above says why.');
  }
}, 250);
