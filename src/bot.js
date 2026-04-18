import { db } from './db/index.js';
import { getNextFireDate } from './recurrence.js';

const TOKEN = process.env.TG_BOT_TOKEN;
const BASE = `https://api.telegram.org/bot${TOKEN}`;


async function logEvent(chatId, event, data = {}) {
  try {
    await db.query(
      `INSERT INTO analytics (chat_id, event, data) VALUES ($1, $2, $3)`,
      [String(chatId), event, JSON.stringify(data)]
    );
  } catch (e) {
    console.error('Analytics log failed:', e.message);
  }
}

// ── API helpers ──────────────────────────────────────────────────

async function api(method, body = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error(`Telegram ${method} error:`, json.description);
  return json;
}

async function sendMessage(chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return api('sendMessage', body);
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' };
  if (keyboard) body.reply_markup = keyboard ? { inline_keyboard: keyboard } : { remove_keyboard: true };
  return api('editMessageText', body);
}

async function answerCallback(callbackId, text = '') {
  return api('answerCallbackQuery', { callback_query_id: callbackId, text });
}

// ── Reminder senders (used by scheduler) ────────────────────────

const REMINDER_BUTTONS = [[
  { text: '✅ Done', callback_data: 'done' },
  { text: '⏰ +2 hrs', callback_data: 'snooze_2h' },
  { text: '🌙 Tonight', callback_data: 'snooze_8pm' },
]];

export async function sendReminder(chatId, taskName) {
  return sendMessage(chatId, `📋 *${taskName}*`, REMINDER_BUTTONS);
}

export async function sendNudge(chatId, taskName) {
  return sendMessage(chatId, `⏰ Still pending: *${taskName}*`, REMINDER_BUTTONS);
}

// ── Conversation state ───────────────────────────────────────────
// Tracks multi-step /add flow: name → frequency → detail

const convo = new Map();

// ── Commands ─────────────────────────────────────────────────────

async function handleStart(chatId) {
    await logEvent(chatId, 'start');
  await db.query(
    `INSERT INTO users (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING`,
    [String(chatId)]
  );
  await sendMessage(chatId,
    `👋 *Welcome to Remindly!*\n\nI send you reminders for recurring tasks — invoices, inventory checks, renewals, whatever you run on a schedule.\n\n` +
    `*Commands:*\n/add — create a new task\n/list — see your tasks\n/delete — remove a task\n/timezone — change your timezone\n\n` +
    `Start with /add to create your first reminder.`
  );
}

async function handleAdd(chatId) {
    await logEvent(chatId, 'add_task_started');
  convo.set(chatId, { step: 'name' });
  await sendMessage(chatId, `What's the task name?\n\n_e.g. "Send invoice to client"_`);
}

async function handleList(chatId) {
  const { rows } = await db.query(`
    SELECT t.name, t.recurrence, t.next_fire
    FROM tasks t JOIN users u ON t.user_id = u.id
    WHERE u.chat_id = $1 AND t.active = true
    ORDER BY t.next_fire
  `, [String(chatId)]);

  if (!rows.length) {
    return sendMessage(chatId, `No active tasks. Use /add to create one.`);
  }

  const lines = rows.map((r, i) => `${i + 1}. *${r.name}* — next: ${r.next_fire}`);
  await sendMessage(chatId, `*Your tasks:*\n\n${lines.join('\n')}`);
}

async function handleDelete(chatId) {
  const { rows } = await db.query(`
    SELECT t.id, t.name FROM tasks t JOIN users u ON t.user_id = u.id
    WHERE u.chat_id = $1 AND t.active = true
  `, [String(chatId)]);

  if (!rows.length) return sendMessage(chatId, 'No tasks to delete.');

  const buttons = rows.map(r => [{ text: r.name, callback_data: `del_${r.id}` }]);
  await sendMessage(chatId, 'Which task do you want to delete?', buttons);
}

async function handleTimezone(chatId) {
  await sendMessage(chatId, 'Pick your timezone:', [
    [{ text: '🇸🇬 Singapore (UTC+8)', callback_data: 'tz_Asia/Singapore' }],
    [{ text: '🇮🇳 India (UTC+5:30)',  callback_data: 'tz_Asia/Kolkata' }],
    [{ text: '🇬🇧 London (UTC+0/+1)', callback_data: 'tz_Europe/London' }],
    [{ text: '🇺🇸 New York (UTC-5)',  callback_data: 'tz_America/New_York' }],
    [{ text: '🇦🇺 Sydney (UTC+10)',   callback_data: 'tz_Australia/Sydney' }],
  ]);
}

// ── Multi-step /add conversation ─────────────────────────────────

async function handleConversation(chatId, text) {
  const state = convo.get(chatId);
  if (!state) return false;

  if (state.step === 'name') {
    state.name = text.trim();
    state.step = 'freq';
    convo.set(chatId, state);
    await sendMessage(chatId, `Got it: *"${state.name}"*\n\nHow often should I remind you?`, [
      [{ text: 'Every day',              callback_data: 'freq_daily' }],
      [{ text: 'Weekly (pick a day)',    callback_data: 'freq_weekly' }],
      [{ text: 'Monthly (pick a date)',  callback_data: 'freq_monthly' }],
      [{ text: 'Specific date (once)',   callback_data: 'freq_specific' }],
    ]);
    return true;
  }

  if (state.step === 'weekday') {
    const day = text.trim().toLowerCase();
    const valid = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    if (!valid.includes(day)) {
      await sendMessage(chatId, 'Type one of: monday, tuesday, wednesday, thursday, friday, saturday, sunday');
      return true;
    }
    await saveTask(chatId, state.name, { type: 'weekly', weekday: day });
    convo.delete(chatId);
    await sendMessage(chatId, `✅ Saved! You'll get a reminder every *${day}* at 8am.`);
    return true;
  }

  if (state.step === 'monthday') {
    const day = parseInt(text.trim());
    if (isNaN(day) || day < 1 || day > 31) {
      await sendMessage(chatId, 'Type a number between 1 and 31.');
      return true;
    }
    await saveTask(chatId, state.name, { type: 'monthly_date', day });
    convo.delete(chatId);
    await sendMessage(chatId, `✅ Saved! You'll get a reminder on the *${day}th of each month* at 8am.`);
    return true;
  }

  if (state.step === 'specificdate') {
    let date = text.trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) {
      const [d, m, y] = date.split('/');
      date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await sendMessage(chatId, 'Use format DD/MM/YYYY or YYYY-MM-DD\ne.g. 15/03/2026 or 2026-03-15');
      return true;
    }
    await saveTask(chatId, state.name, { type: 'specific', date });
    convo.delete(chatId);
    await sendMessage(chatId, `✅ Saved! You'll get a reminder on *${date}* at 8am.`);
    return true;
  }

  return false;
}

// ── Save task helper ─────────────────────────────────────────────

async function saveTask(chatId, name, recurrence) {
  const { rows } = await db.query(`SELECT id FROM users WHERE chat_id = $1`, [String(chatId)]);
  if (!rows.length) return;

  const nextFire = recurrence.type === 'specific'
    ? recurrence.date
    : getNextFireDate(recurrence);

  await db.query(
    `INSERT INTO tasks (user_id, name, recurrence, next_fire) VALUES ($1, $2, $3, $4)`,
    [rows[0].id, name, JSON.stringify(recurrence), nextFire]
  );

  await logEvent(chatId, 'task_created', { name, type: recurrence.type });
}

// ── Callback query handler (button taps) ────────────────────────

async function handleCallbackQuery(query) {
  const { id, data, from, message } = query;
  const chatId = from.id;
  const state = convo.get(chatId);

  await answerCallback(id);

  // Timezone picker
  if (data.startsWith('tz_')) {
    const tz = data.replace('tz_', '');
    await db.query(`UPDATE users SET timezone = $1 WHERE chat_id = $2`, [tz, String(chatId)]);
    await sendMessage(chatId, `✅ Timezone set to *${tz}*`);
    return;
  }

  // Delete task
  if (data.startsWith('del_')) {
    const taskId = data.replace('del_', '');
    await db.query(`UPDATE tasks SET active = false WHERE id = $1`, [taskId]);
    await sendMessage(chatId, '🗑️ Task deleted.');
    return;
  }

  // Frequency selection during /add flow
  if (data.startsWith('freq_') && state?.step === 'freq') {
    const freq = data.replace('freq_', '');
    if (freq === 'daily') {
      await saveTask(chatId, state.name, { type: 'daily' });
      convo.delete(chatId);
      await sendMessage(chatId, `✅ Saved! You'll get a reminder *every day* at 8am.`);
    } else if (freq === 'weekly') {
      state.step = 'weekday';
      convo.set(chatId, state);
      await sendMessage(chatId, 'Which day?\n\nType it out: monday, tuesday, wednesday...');
    } else if (freq === 'monthly') {
      state.step = 'monthday';
      convo.set(chatId, state);
      await sendMessage(chatId, 'Which day of the month? (1–31)\n\nJust type the number:');
    } else if (freq === 'specific') {
      state.step = 'specificdate';
      convo.set(chatId, state);
      await sendMessage(chatId, 'What date?\n\nFormat: DD/MM/YYYY\ne.g. 15/03/2026');
    }
    return;
  }

  // Reminder response buttons
  if (['done', 'snooze_2h', 'snooze_8pm'].includes(data)) {
    const { rows } = await db.query(`
      SELECT i.id FROM instances i
      JOIN tasks t ON i.task_id = t.id
      JOIN users u ON t.user_id = u.id
      WHERE u.chat_id = $1
        AND i.fire_date = CURRENT_DATE
        AND i.status IN ('pending', 'snoozed')
      ORDER BY i.created_at DESC LIMIT 1
    `, [String(chatId)]);

    if (!rows.length) {
      await sendMessage(chatId, "Couldn't find a task to update — it may have already been marked done.");
      return;
    }

    const instanceId = rows[0].id;

    if (data === 'done') {
      await db.query(`UPDATE instances SET status = 'done' WHERE id = $1`, [instanceId]);
      await editMessage(chatId, message.message_id, '✅ Done!');
    } else if (data === 'snooze_2h') {
      const until = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await db.query(`UPDATE instances SET status='snoozed', snooze_until=$1 WHERE id=$2`, [until, instanceId]);
      await editMessage(chatId, message.message_id, '⏰ Snoozed 2 hours.');
    } else if (data === 'snooze_8pm') {
      const tonight = new Date();
      tonight.setHours(20, 0, 0, 0);
      await db.query(`UPDATE instances SET status='snoozed', snooze_until=$1 WHERE id=$2`, [tonight, instanceId]);
      await editMessage(chatId, message.message_id, '🌙 Snoozed until 8pm.');
    }
  }
}

// ── Main update router ───────────────────────────────────────────

export async function handleUpdate(update) {
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query);
  }

  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.startsWith('/start'))    return handleStart(chatId);
  if (text === '/add')              return handleAdd(chatId);
  if (text === '/list')             return handleList(chatId);
  if (text === '/delete')           return handleDelete(chatId);
  if (text === '/timezone')         return handleTimezone(chatId);

  const handled = await handleConversation(chatId, text);
  if (!handled) {
    await sendMessage(chatId, 'Use /add to create a task or /list to see your reminders.');
  }
}

// ── Polling mode (local dev — no ngrok needed) ───────────────────

export async function startPolling() {
  console.log('Polling for Telegram updates...');
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message","callback_query"]`
      );
      const { result } = await res.json();
      for (const update of result ?? []) {
        await handleUpdate(update).catch(console.error);
        offset = update.update_id + 1;
      }
    } catch (e) {
      console.error('Polling error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Webhook mode (production) ────────────────────────────────────

export async function setWebhook(url) {
  const res = await api('setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log('Webhook registered:', res.description);
}
