/**
 * One handler per state. No handler assumes where a click lands - the loop
 * re-detects afterward.
 *
 * Every portal interaction arrives through `deps` so the handlers are unit
 * testable without a browser.
 */
const { STATES, REASONS } = require('./pageState');

const CONTINUE = { terminal: false };

function createHandlers(deps) {
  const {
    solve,                  // (driver, {isLogin}) -> {ok, reason}
    capture,                // (driver, label, detected) -> dir
    clickDeadEndButton,     // (driver) -> void
    fillFormAndSubmit,      // (driver, category) -> void
    scanSlots,              // (driver, categoryName) -> void
    clickBookNow,           // (driver) -> void
    fillEmail,              // (driver) -> void
    fillPasswordAndSolve,   // (driver) -> {ok, reason}
  } = deps;

  async function chargeOrStop(ctx, phase, note) {
    if (ctx.budget.charge(phase)) return null;
    ctx.log(`Budget exhausted for ${phase} - stopping.`);
    return { terminal: true, result: 'BUDGET_EXHAUSTED', note };
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
      const category = ctx.state.plan[0];
      if (!category) return { terminal: true, result: 'PLAN_EXHAUSTED' };
      const stop = await chargeOrStop(ctx, 'postForm', 'form fill');
      if (stop) return stop;
      await fillFormAndSubmit(ctx.driver, category);
      ctx.state.phase = 'postForm';
      const n = ctx.budget.recordSearch();
      ctx.log(`Submitted a search for ${category}. Searches used (all time): ${n}`);
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
        const category = ctx.state.plan.shift();
        if (category) ctx.state.results[category] = 'NO_SLOTS';
        ctx.log(`${category}: no slots.`);
        if (ctx.state.plan.length === 0) {
          return { terminal: true, result: 'NO_SLOTS' };
        }
        ctx.budget.resetTraversal();
        ctx.state.phase = 'preForm';
        await clickDeadEndButton(ctx.driver);
        return CONTINUE;
      }

      // CAPTCHA_INVALID
      const phase = ctx.state.phase;
      const stop = await chargeOrStop(ctx, phase, 'captcha rejected');
      if (stop) return stop;
      ctx.log(`Captcha rejected - returning via the dead-end button.`);
      await clickDeadEndButton(ctx.driver);
      return CONTINUE;
    },

    [STATES.SLOTS]: async (ctx) => {
      const category = ctx.state.plan[0] || 'Unknown';
      const dir = await capture(ctx.driver, 'SLOTS', ctx.detected);
      ctx.log(`Slots are open. Page captured to ${dir}`);
      await scanSlots(ctx.driver, category);
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
