/**
 * TEST ONLY. Stands in for app.js so the scheduler's timing can be exercised
 * without touching the portal. Spawn it with BOT_SCRIPT=stub.js.
 *
 * Exit code comes from STUB_EXIT so the loop's branching can be tested too:
 *   0 no slots (default) | 10 slots found | 20 blocked | 30 guard | 1 crash
 */
const code = Number(process.env.STUB_EXIT) || 0;
console.log(`[stub] run at ${new Date().toISOString()} -> exit ${code}`);
process.exit(code);
