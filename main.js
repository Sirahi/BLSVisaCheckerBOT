const { spawn } = require('child_process');

// ⏰ Working hours settings
const WORK_START_HOUR = 8;   // Start at 08:00
const WORK_END_HOUR = 24;    // Stop at 00:00
const MORNING_END_HOUR = 12; // Intensive mode until 12:00

const MORNING_INTERVAL = 20; // 20 minutes between 08:00-12:00
const AFTERNOON_INTERVAL = 120; // 120 minutes (2 hours) between 12:00-24:00

// Is the current time within working hours?
function isWorkingHours() {
  const hour = new Date().getHours();
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

// Is it currently morning (intensive mode)?
function isMorning() {
  const hour = new Date().getHours();
  return hour >= WORK_START_HOUR && hour < MORNING_END_HOUR;
}

// Wait until the next working hour window
function getTimeUntilWorkStart() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(WORK_START_HOUR, 0, 0, 0);

  const todayStart = new Date(now);
  todayStart.setHours(WORK_START_HOUR, 0, 0, 0);

  // If working hours have not started yet today
  if (now.getHours() < WORK_START_HOUR) {
    return todayStart - now;
  }

  // After midnight, wait until tomorrow morning
  return tomorrow - now;
}

// Show the wait duration in a human-readable format
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

// Show the current time (24-hour clock)
function getTimeString() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

(async function loop() {
  console.log('🚀 Visa Bot started!');
  console.log(`⏰ Working hours: ${WORK_START_HOUR}:00 - ${WORK_END_HOUR}:00`);
  console.log(`🌅 Morning (${WORK_START_HOUR}:00-${MORNING_END_HOUR}:00): every ${MORNING_INTERVAL} minutes`);
  console.log(`🌆 Afternoon (${MORNING_END_HOUR}:00-${WORK_END_HOUR}:00): every ${AFTERNOON_INTERVAL} minutes\n`);

  while (true) {
    // Working hours check
    if (!isWorkingHours()) {
      const waitTime = getTimeUntilWorkStart();
      console.log(`😴 [${getTimeString()}] Night mode - sleeping!`);
      console.log(`⏰ Waking up at ${WORK_START_HOUR}:00 (in ${formatDuration(waitTime)})\n`);
      await new Promise(res => setTimeout(res, waitTime));
      console.log(`\n☀️ Good morning! Starting work.\n`);
      continue;
    }

    // Run the bot
    console.log(`\n🔍 [${getTimeString()}] Starting appointment check...`);
    await new Promise((resolve) => {
      const child = spawn('node', ['app.js'], { stdio: 'inherit' });
      child.on('exit', resolve);
    });

    // Wait duration based on the time of day
    const interval = isMorning() ? MORNING_INTERVAL : AFTERNOON_INTERVAL;
    const modeEmoji = isMorning() ? '🌅' : '🌆';
    const modeName = isMorning() ? 'Morning mode' : 'Afternoon mode';

    console.log(`\n${modeEmoji} [${getTimeString()}] ${modeName} - next check in ${interval} minutes...`);
    await new Promise(res => setTimeout(res, interval * 60 * 1000));
  }
})();
