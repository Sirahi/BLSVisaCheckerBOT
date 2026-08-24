/**
 * Discovers TELEGRAM_CHAT_ID and writes it into .env.
 *
 * Prerequisites, both done on the phone:
 *   1. @BotFather -> /newbot -> put the token in .env as TELEGRAM_BOT_TOKEN
 *   2. Open your new bot and press Start / send it any message.
 *      Bots cannot open a conversation, so without this getUpdates is empty
 *      and any send fails with "chat not found".
 *
 *   node tools/telegram-setup.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENV = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV, quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN;

(async () => {
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set in .env.');
    console.error('Get one from @BotFather (/newbot), then add:');
    console.error('  TELEGRAM_BOT_TOKEN=123456789:AA...');
    process.exit(1);
  }

  // Confirm the token itself is valid before blaming the chat.
  let me;
  try {
    me = (await axios.get(`https://api.telegram.org/bot${token}/getMe`)).data;
  } catch (e) {
    const d = e.response && e.response.data;
    console.error('The token was rejected by Telegram:', d ? d.description : e.message);
    process.exit(1);
  }
  console.log(`Token is valid. Bot: @${me.result.username} (${me.result.first_name})`);

  const updates = (await axios.get(`https://api.telegram.org/bot${token}/getUpdates`)).data;
  const chats = new Map();
  for (const u of updates.result || []) {
    const m = u.message || u.edited_message || u.channel_post;
    if (m && m.chat) chats.set(m.chat.id, m.chat);
  }

  if (chats.size === 0) {
    console.error('');
    console.error('No messages found. Open @' + me.result.username + ' on your phone,');
    console.error('press Start, send it any message, then run this again.');
    console.error('(Telegram only keeps recent updates, so do it just before rerunning.)');
    process.exit(1);
  }

  console.log('');
  for (const [id, chat] of chats) {
    const who = chat.username ? '@' + chat.username : (chat.title || chat.first_name || 'unknown');
    console.log(`  chat ${id}  ${who}  (${chat.type})`);
  }

  const [chatId] = [...chats.keys()];
  if (chats.size > 1) console.log(`\nMore than one chat found - using the first (${chatId}).`);

  let env = fs.readFileSync(ENV, 'utf8');
  if (/^TELEGRAM_CHAT_ID=/m.test(env)) {
    env = env.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`);
  } else {
    if (!env.endsWith('\n')) env += '\n';
    env += `TELEGRAM_CHAT_ID=${chatId}\n`;
  }
  fs.writeFileSync(ENV, env);
  console.log(`\nWrote TELEGRAM_CHAT_ID=${chatId} to .env`);
  console.log('Now run:  npm run telegram-test');
})();
