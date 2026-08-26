# 🤖 BLS Spain Visa Appointment Checker

<p align="center">
  <img src="./logo.png" alt="BLS Visa Checker Logo" width="512">
</p>

An automation tool that watches the [BLS Spain visa portal](https://appointment.thespainvisa.com)
for appointment slots and sends a Telegram alert the moment one appears.

It runs unattended: a scheduler wakes up on a randomised interval, drives a Chrome session
through login, captcha, and the booking form, reads the calendar, and either
reports "no slots" or shouts. Captchas are solved locally with OCR — no
third-party solving service is involved.

> Configured out of the box for the **Pakistan** portal (Islamabad / Lahore),
> **National Visa → Family Reunification**, Normal and Premium categories.
> All of that is config, not code — see [Configuration](#-configuration).

---

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20.9 or newer (required by `sharp`)
- An account on the [BLS portal](https://appointment.thespainvisa.com) with an
  applicant profile already created

```bash
npm install
```

> [!NOTE]
> ChromeDriver is managed automatically by Selenium 4+. No manual install needed.

### 2. Credentials

Copy `.env.example` to `.env` and fill it in:

```env
EMAIL=your_email@example.com
PASSWORD=your_password

# Optional — omit to run without alerts
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=987654321
```

Telegram is optional but strongly recommended — it is the only way you find out
about a slot without watching the terminal. To set it up:

```bash
npm run telegram-setup   # walks through creating the bot and finding your chat ID
npm run telegram-test    # sends a test message
```

### 3. Run

```bash
npm start        # the scheduler — runs on a random interval, round the clock
npm run once     # a single cycle, then exit
```

---

## ⚙️ Configuration

Credentials live in `.env`. Everything else lives in `config.js`.

### Which city gets searched

City is configured in two parts. `CITIES` is the **catalogue** of cities the bot
knows how to search; what a given run **actually** searches is decided by
`MULTI_CITY` and `ACTIVE_CITY`.

```js
CITIES: [
  { name: 'Islamabad', LOCATION: 'Islamabad' },
  { name: 'Lahore',    LOCATION: 'Lahore' },
]

const MULTI_CITY_DEFAULT  = false;       // true → search every entry in CITIES
const ACTIVE_CITY_DEFAULT = 'Islamabad'; // the single city when multi is off
```

Both can be overridden without editing code — via `.env`, or per-run:

```bash
MULTI_CITY=1 npm start          # multi-city for this run
MULTI_CITY=0 npm start          # single-city for this run, whatever the default
ACTIVE_CITY=Lahore npm start    # single-city, Lahore
```

Precedence is **shell environment → `.env` → the default in `config.js`.**
An `ACTIVE_CITY` that is not present in `CITIES` aborts at startup rather than
guessing.

> [!IMPORTANT]
> **Single-city mode assumes your portal profile is already set to `ACTIVE_CITY`**
> and never opens Manage Applicants. Change the city on the portal by hand
> *first*, then change the config. Otherwise searches run against the old city
> under the new city's name, and nothing fails visibly.
>
> Multi-city mode does not have this caveat — it re-points the profile itself,
> at the cost of one extra profile edit and one extra search per cycle.

### Other useful settings

| Setting | Where | Default |
|---|---|---|
| Visa type / sub-type | `FORM` | National Visa → Family Reunification |
| Categories searched | `MACHINE.CATEGORIES` | `['Normal', 'Premium']` |
| Months of calendar scanned | `CALENDAR.MAX_MONTHS_TO_CHECK` | 12 |
| Active hours | `SCHEDULER` | round the clock — no working hours |
| Polling interval | `SCHEDULER.INTERVAL_MIN_MINUTES` / `_MAX_MINUTES` | random 20–40 min, redrawn every cycle |
| Stop after N failed cycles | `SCHEDULER.MAX_CONSECUTIVE_FAILURES` | 3 |

---

## 🎯 Features

- **Telegram alerts** — a repeating alarm when a slot is found, not a single
  message you might sleep through.
- **Local captcha solving** — image preprocessing plus Tesseract OCR with a
  six-way voting scheme, ~94% per-tile accuracy on the project's test corpus.
  All nine tiles are solved in parallel against a shared worker pool.
- **Single or multi-city** — one city by default; flip `MULTI_CITY` to sweep
  every configured city, Normal and Premium in each.
- **12-month calendar scan** — checks every open date, not just the first month.
- **Randomised 24/7 polling** — runs round the clock and draws every gap fresh
  from a configurable range, so the checks are not on a cadence a human never
  has. Widen the range to slow the search burn and blur the pattern at once.
- **Block-aware backoff** — treats a block as transient and retries with an
  increasing delay instead of giving up or grinding against an active block. A
  blocked cycle does not draw at random: it falls back to the upper limit and
  grows 1.5× per consecutive block, capped, until a cycle gets through.
- **Search budgeting** — a hard per-run ceiling on how many real searches can be
  submitted, so a retry loop can never quietly burn through your quota.
- **Keeps the browser open on a hit** — when slots are found the session is held
  logged in for two hours (`SLOTS.HOLD_MINUTES`) so you can book immediately,
  with no re-login and no second captcha.

---

## 🔧 How It Works

`npm start` runs `main.js`, a scheduler that spawns one `app.js` run per cycle
and sleeps between them. Each run is a fresh browser and a fresh state machine:
it detects which page it is on, dispatches a handler, then re-detects — so a run
that dies mid-flow leaves nothing to unwind, and the next cycle simply starts
again from wherever it lands.

The scheduler reads each run's exit code and reacts to it:

| Exit | Meaning | Scheduler response |
|---|---|---|
| `0` | No slots this cycle | Sleep, then continue |
| `10` | **Slots found** | Stop; browser held open and logged in (2h) |
| `20` | Blocked / unrecognised page | Back off and retry, progressively slower |
| `30` | A guard tripped (transient) | Tolerate a few, stop if they repeat |

### Development

```bash
npm test                      # unit tests — no browser, no portal traffic
SIMULATE_SLOTS=1 npm run once # exercise the slot-found path; submits no search
BOT_SCRIPT=stub.js npm start  # test the schedule without touching the portal
TIME_SCALE=45 npm start       # one virtual hour = 45 real seconds
```

---

## 🔧 Built With

- **Selenium WebDriver** — browser automation
- **Tesseract.js** — OCR captcha solving
- **sharp** — image preprocessing
- **Node.js** — runtime

---

## ⚠️ Important Notes

- **Security:** never share or commit your `.env` file.
- **Speed:** act the moment a slot alert arrives — they fill in minutes.
- **Rate:** every cycle submits real searches against your account. The defaults
  are deliberately conservative; raising the polling frequency or the number of
  cities raises your chance of being blocked.

---

## ⚖️ Disclaimer

This project is for research and educational purposes. The developer accepts no
responsibility for any consequences arising from its use. Check that automated
access is acceptable under the portal's terms before running it.

## 📄 License

[MIT](LICENSE)
