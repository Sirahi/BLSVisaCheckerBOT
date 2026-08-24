const test = require('node:test');
const assert = require('node:assert');

// Stub the notifier BEFORE portalActions loads - it destructures at require
// time. Nothing in this suite may reach Telegram.
const sent = [];
const tnPath = require.resolve('../telegramNotifier');
require.cache[tnPath] = {
  id: tnPath,
  filename: tnPath,
  loaded: true,
  exports: {
    notifySlotPageReached: async (detail, city) => { sent.push({ detail, city }); return true; },
    startSlotAlerts: (dates) => ({ stop() {}, dates }),
  },
};

const { scanAndNotifySlots } = require('../portalActions');

const ITEM = { city: 'Islamabad', location: 'Islamabad', category: 'Premium', label: 'Islamabad/Premium' };

// Models only what scanAndNotifySlots actually asks the page for. Selectors are
// routed by their text, so a rename in portalActions.js fails loudly here.
function calendarDriver({ datePicker = true, calendarOpens = true, calendarElem = true, greenDates = 0 } = {}) {
  const plain = () => ({
    isDisplayed: async () => true,
    click: async () => {},
    getText: async () => 'August 2026',
    getAttribute: async () => null,
    findElement: async () => ({ getAttribute: async () => '' }),
  });
  const dateLinks = [0, 1, 2].map((i) => ({
    isDisplayed: async () => true,
    getAttribute: async () => '2026-09-0' + (i + 1),
    getText: async () => String(i + 1),
    findElement: async () => ({ getAttribute: async () => '' }),
  }));
  return {
    sleep: async () => {},
    actions: () => ({ sendKeys: () => ({ perform: async () => {} }) }),
    executeScript: async (script, arg) => {
      if (/backgroundColor/.test(script)) {
        const idx = dateLinks.indexOf(arg);
        return { bgColor: 'rgb(0, 200, 0)', isGreen: idx > -1 && idx < greenDates, rgb: { r: 0, g: 200, b: 0 } };
      }
      return null;
    },
    findElement: async (by) => {
      if (/k-nav-fast/.test(by.value)) return { getText: async () => 'August 2026' };
      throw new Error('no such element: ' + by.value);
    },
    findElements: async (by) => {
      const v = by.value;
      if (/datepicker/.test(v)) return datePicker ? [plain()] : [];
      if (/k-calendar-container/.test(v)) return calendarOpens ? [plain()] : [];
      if (/a\.k-link/.test(v)) return dateLinks;
      if (/k-nav-next/.test(v)) return [];
      if (/\.k-calendar$/.test(v)) return calendarElem ? [plain()] : [];
      return [];
    },
  };
}

// scanAndNotifySlots narrates ~15 lines per call through bare console.log.
async function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
}

test.beforeEach(() => { sent.length = 0; });

// ---- F5: a SLOTS page with zero green dates used to be silent -------------
//
// handlers.js still returns terminal SLOTS_FOUND for this page - exit 10 -
// which stops the scheduler for the night and abandons the remaining combos.
// That is the right call: reaching the slot page at all is worth stopping for.
// Doing it without telling anyone is not.
test('a slots page with no open dates still notifies, naming city and category', async () => {
  const out = await quiet(() => scanAndNotifySlots(calendarDriver({ greenDates: 0 }), ITEM));
  assert.strictEqual(out, null, 'the null return - and the browser hold - are unchanged');
  assert.strictEqual(sent.length, 1, 'the night must not be abandoned in silence');
  assert.match(sent[0].detail, /Islamabad/);
  assert.match(sent[0].detail, /Premium/);
});

test('a slots page WITH open dates still fires the real repeating alert', async () => {
  const out = await quiet(() => scanAndNotifySlots(calendarDriver({ greenDates: 2 }), ITEM));
  assert.ok(out && typeof out.stop === 'function', 'the alert handle must reach app.js');
  assert.strictEqual(sent.length, 0, 'the degraded message must not shadow the real one');
  assert.strictEqual(out.dates.length, 2);
  assert.strictEqual(out.dates[0].city, 'Islamabad');
});

// ---- F4: the three degraded alerts could not name the city ----------------
test('the no-date-picker alert names the city', async () => {
  await assert.rejects(
    () => quiet(() => scanAndNotifySlots(calendarDriver({ datePicker: false }), ITEM)),
    /Date picker not found/
  );
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].detail, /Islamabad/);
  assert.strictEqual(sent[0].city, 'Islamabad');
});

test('the calendar-would-not-open alert names the city', async () => {
  await assert.rejects(
    () => quiet(() => scanAndNotifySlots(calendarDriver({ calendarOpens: false }), ITEM)),
    /Could not open the calendar/
  );
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].detail, /Islamabad/);
  assert.strictEqual(sent[0].city, 'Islamabad');
});

test('the no-calendar-element alert names the city', async () => {
  await assert.rejects(
    () => quiet(() => scanAndNotifySlots(calendarDriver({ calendarElem: false }), ITEM)),
    /No calendar element/
  );
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].detail, /Islamabad/);
  assert.strictEqual(sent[0].city, 'Islamabad');
});
