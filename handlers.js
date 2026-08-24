/**
 * One handler per state. No handler assumes where a click lands - the loop
 * re-detects afterward.
 *
 * Every portal interaction arrives through `deps` so the handlers are unit
 * testable without a browser.
 */
const fs = require('fs');
const path = require('path');
const { STATES, REASONS } = require('./pageState');

const CONTINUE = { terminal: false };

function createHandlers(deps) {
  const {
    solve,                  // (driver, {isLogin}) -> {ok, reason}
    capture,                // (driver, label, detected) -> dir
    clickDeadEndButton,     // (driver) -> void
    fillFormAndSubmit,      // (driver, item) -> void
    scanSlots,              // (driver, item) -> alert handle | null
    simulateSlotsFound,     // (item) -> alert handle   [testing only]
    clickBookNow,           // (driver) -> void
    fillEmail,              // (driver) -> void
    fillPasswordAndSolve,   // (driver) -> {ok, reason}
    goHome,                 // (driver) -> void
    goToMyAppointments,     // (driver) -> void
    openApplicantEdit,      // (driver) -> void
    setProfileCity,         // (driver, item) -> void
    submitProfileFrame,     // (driver) -> void
  } = deps;

  async function chargeOrStop(ctx, phase, note) {
    if (ctx.budget.charge(phase)) return null;
    ctx.log(`Budget exhausted for ${phase} - stopping.`);
    return { terminal: true, result: 'BUDGET_EXHAUSTED', note };
  }

  // Shakedown instrument. The three profile pages have never been captured, so
  // the first run through each one saves it as a fixture. Off unless asked for:
  // 18 cycles a day x 3 states would otherwise be 54 directories daily.
  async function captureOnce(ctx, label) {
    if (!process.env.CAPTURE_PROFILE) return;
    ctx.state.captured = ctx.state.captured || {};
    if (ctx.state.captured[label]) return;
    ctx.state.captured[label] = true;
    try {
      const dir = await capture(ctx.driver, label, ctx.detected);
      ctx.log(`Captured ${label} to ${dir}`);
    } catch (e) {
      ctx.log(`Capture of ${label} failed: ${e.message}`);
    }
  }

  return {
    [STATES.LOGIN_EMAIL]: async (ctx) => {
      await fillEmail(ctx.driver);
      return CONTINUE;
    },

    [STATES.LOGIN_CAPTCHA]: async (ctx) => {
      const stop = await chargeOrStop(ctx, 'login', 'login captcha');
      if (stop) return stop;
      const r = await fillPasswordAndSolve(ctx.driver);
      if (!r.ok) ctx.log(`Login captcha attempt failed: ${r.reason}`);
      return CONTINUE;
    },

    [STATES.HOME]: async (ctx) => {
      ctx.state.phase = 'preForm';
      // The city lives on the applicant PROFILE, not only on the booking form.
      // If the profile is not already pinned to the city we are about to search,
      // go and re-point it before spending a captcha and a search on the wrong one.
      const next = ctx.state.plan[0];
      if (next && ctx.state.profileCity !== next.city) {
        ctx.log(`Profile is on ${ctx.state.profileCity || '(unknown)'}, need ${next.city} - opening Manage Applicants.`);
        await goToMyAppointments(ctx.driver);
        return CONTINUE;
      }
      await clickBookNow(ctx.driver);
      return CONTINUE;
    },

    [STATES.CAPTCHA]: async (ctx) => {
      const phase = ctx.state.phase;
      const stop = await chargeOrStop(ctx, phase, 'captcha');
      if (stop) return stop;
      const r = await solve(ctx.driver, { isLogin: phase === 'login' });
      if (!r.ok) ctx.log(`Captcha attempt failed: ${r.reason}`);
      return CONTINUE;
    },

    [STATES.VISA_FORM]: async (ctx) => {
      const item = ctx.state.plan[0];
      if (!item) return { terminal: true, result: 'PLAN_EXHAUSTED' };

      // Deliberately BEFORE chargeOrStop and fillFormAndSubmit: the point of
      // the simulation is to test the slots path without spending a search.
      if (ctx.cfg.SIMULATE && ctx.cfg.SIMULATE.SLOTS) {
        ctx.log('*** SIMULATE_SLOTS=1 - faking a slots hit. NO search submitted. ***');
        ctx.state.alerts = simulateSlotsFound(item);
        return { terminal: true, result: 'SLOTS_FOUND' };
      }

      // Run-level search ceiling. The postForm budget is 3 and resetTraversal()
      // hands every combo a fresh allowance, so the per-phase budgets on their
      // own permit 3 x 4 combos = 12 real #btnSubmit clicks in ONE run - and
      // every one of those charges ends at a genuine search. The spec rate
      // table is built on four per cycle, and the account was blocked once
      // after fewer than ten searches. Refuse rather than overspend.
      //
      // searchesUsed is the ALL-TIME persisted total, so the ceiling is a
      // DELTA against what it was when this run started.
      const ceiling = Number.isInteger(ctx.state.planSize) ? ctx.state.planSize : null;
      if (ceiling !== null) {
        const spent = ctx.budget.searchesUsed - (ctx.state.searchesAtStart || 0);
        if (spent >= ceiling) {
          ctx.log(
            `Search ceiling reached: ${spent} search(es) already spent this run for a plan of ` +
            `${ceiling}. Refusing to submit ${item.label} - the plan is being re-walked.`
          );
          return { terminal: true, result: 'SEARCH_CEILING', note: item.label };
        }
      }

      const stop = await chargeOrStop(ctx, 'postForm', 'form fill');
      if (stop) return stop;
      await fillFormAndSubmit(ctx.driver, item);
      ctx.state.phase = 'postForm';
      const n = ctx.budget.recordSearch({ city: item.city, category: item.category });
      ctx.log(`Submitted a search for ${item.label}. Searches used (all time): ${n}`);
      return CONTINUE;
    },

    [STATES.PROFILE_LIST]: async (ctx) => {
      const stop = await chargeOrStop(ctx, 'profile', 'profile edit');
      if (stop) return stop;
      await captureOnce(ctx, 'PROFILE_LIST');
      await openApplicantEdit(ctx.driver);
      return CONTINUE;
    },

    [STATES.PROFILE_FORM]: async (ctx) => {
      const item = ctx.state.plan[0];
      if (!item) return { terminal: true, result: 'PLAN_EXHAUSTED' };
      await captureOnce(ctx, 'PROFILE_FORM');
      await setProfileCity(ctx.driver, item);
      return CONTINUE;
    },

    [STATES.PROFILE_CONFIRM]: async (ctx) => {
      const item = ctx.state.plan[0];
      if (!item) return { terminal: true, result: 'PLAN_EXHAUSTED' };
      await captureOnce(ctx, 'PROFILE_CONFIRM');
      // If this throws, profileCity stays as it was. That is deliberate: a
      // half-finished subflow must never be recorded as a completed one, or
      // the next HOME would skip the edit and search the wrong city.
      await submitProfileFrame(ctx.driver);
      ctx.state.profileCity = item.city;
      ctx.log(`Profile city is now ${item.city}.`);
      await goHome(ctx.driver);
      return CONTINUE;
    },

    [STATES.DEAD_END]: async (ctx) => {
      const { reason, evidence } = ctx.detected;

      if (reason === REASONS.UNKNOWN_REASON) {
        const dir = await capture(ctx.driver, 'DEAD_END_UNKNOWN_REASON', ctx.detected);
        ctx.log(`Unrecognised dead-end message: "${evidence}" - captured to ${dir}`);
        return { terminal: true, result: 'UNKNOWN_REASON', note: evidence };
      }

      if (reason === REASONS.NO_SLOTS) {
        const finished = ctx.state.plan.shift();
        if (finished) ctx.state.results[finished.label] = 'NO_SLOTS';
        ctx.log(`${finished ? finished.label : 'unknown'}: no slots.`);
        if (ctx.state.plan.length === 0) {
          return { terminal: true, result: 'NO_SLOTS' };
        }
        ctx.budget.resetTraversal();
        ctx.state.phase = 'preForm';
        // Crossing a city boundary means the portal PROFILE must be re-pointed,
        // and the dead-end button leads straight back to the form instead.
        const next = ctx.state.plan[0];
        if (finished && next.city !== finished.city) {
          ctx.log(`City boundary ${finished.city} -> ${next.city} - returning home to re-point the profile.`);
          await goHome(ctx.driver);
        } else {
          await clickDeadEndButton(ctx.driver);
        }
        return CONTINUE;
      }

      // CAPTCHA_INVALID
      //
      // Deliberately NOT charged. The solve that produced this rejection was
      // already charged in the CAPTCHA handler, and billing one failure twice
      // made BUDGET.preForm mean half what it says - a limit of 3 bought ONE
      // survived rejection, not three attempts. Seen live on 2026-08-24: a
      // completely fresh post-city-switch budget died on the second captcha.
      // The CAPTCHA charge alone still bounds the retry loop.
      ctx.log(`Captcha rejected - returning via the dead-end button.`);
      await clickDeadEndButton(ctx.driver);
      return CONTINUE;
    },

    [STATES.SLOTS]: async (ctx) => {
      // Object-shaped so scanSlots always receives an item, never a bare string.
      const item = ctx.state.plan[0]
        || { city: 'Unknown', location: 'Unknown', category: 'Unknown', label: 'Unknown' };
      const dir = await capture(ctx.driver, 'SLOTS', ctx.detected);
      // No run has ever reached this state, so the DOM here is unknown
      // territory. Capture a screenshot too: if scanSlots then fails on an
      // element we have never seen, the image still tells us which dates were
      // open - and it is the reference for designing anything past this page.
      try {
        const png = await ctx.driver.takeScreenshot();
        fs.writeFileSync(path.join(dir, 'screenshot.png'), png, 'base64');
      } catch (e) {
        ctx.log(`Screenshot failed: ${e.message}`);
      }
      ctx.log(`Slots are open. Page captured to ${dir}`);
      // scanSlots returns the repeating-alert handle (or null). app.js stops
      // it when the hold ends.
      ctx.state.alerts = await scanSlots(ctx.driver, item);
      return { terminal: true, result: 'SLOTS_FOUND' };
    },

    [STATES.UNAVAILABLE]: async (ctx) => {
      const stop = await chargeOrStop(ctx, 'unavailable', 'portal outage');
      if (stop) return stop;
      ctx.log('Portal temporarily unavailable - waiting, then refreshing.');
      await ctx.driver.sleep(5000);
      await ctx.driver.navigate().refresh();
      return CONTINUE;
    },

    [STATES.UNKNOWN]: async (ctx) => {
      const dir = await capture(ctx.driver, 'UNKNOWN', ctx.detected);
      ctx.log(`Unrecognised page - captured to ${dir}`);
      return { terminal: true, result: 'UNKNOWN_PAGE' };
    },
  };
}

module.exports = { createHandlers };
