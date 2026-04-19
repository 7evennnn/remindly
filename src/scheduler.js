import cron from 'node-cron';
import { db } from './db/index.js';
import { sendReminder, sendNudge } from './bot.js';
import { getNextFireDate } from './recurrence.js';

// Midnight: create today's instances for due tasks
cron.schedule('0 23 * * *', async () => {
  const { rows: tasks } = await db.query(`
    SELECT * FROM tasks WHERE active = true AND next_fire = CURRENT_DATE
  `);

  for (const task of tasks) {
    await db.query(`
      INSERT INTO instances (task_id, fire_date)
      VALUES ($1, CURRENT_DATE)
      ON CONFLICT (task_id, fire_date) DO NOTHING
    `, [task.id]);

    if (task.recurrence.type === 'specific') {
      await db.query(`UPDATE tasks SET active = false WHERE id = $1`, [task.id]);
    } else {
      const next = getNextFireDate(task.recurrence);
      await db.query(`UPDATE tasks SET next_fire = $1 WHERE id = $2`, [next, task.id]);
    }
  }

  console.log(`Midnight cron: processed ${tasks.length} tasks`);
});

// Hourly: fire reminders for users at 8am / 2pm / 8pm in their timezone
cron.schedule('0 * * * *', async () => {
  const { rows } = await db.query(`
    SELECT
      i.id, i.nudge_count, t.name, u.chat_id,
      EXTRACT(HOUR FROM NOW() AT TIME ZONE u.timezone)::int AS local_hour
    FROM instances i
    JOIN tasks t ON i.task_id = t.id
    JOIN users u ON t.user_id = u.id
    WHERE i.fire_date = CURRENT_DATE
      AND i.status = 'pending'
      AND (i.snooze_until IS NULL OR i.snooze_until < NOW())
  `);

  for (const row of rows) {
    const h = row.local_hour;
    const n = row.nudge_count;

    if (h === 8 && n === 0) {
      await sendReminder(row.chat_id, row.name);
      await db.query(`UPDATE instances SET nudge_count = 1 WHERE id = $1`, [row.id]);
    } else if (h === 14 && n === 1) {
      await sendNudge(row.chat_id, row.name);
      await db.query(`UPDATE instances SET nudge_count = 2 WHERE id = $1`, [row.id]);
    } else if (h === 20 && n === 2) {
      await sendNudge(row.chat_id, row.name);
      await db.query(`UPDATE instances SET nudge_count = 3 WHERE id = $1`, [row.id]);
    }
  }
});

// Every 5 min: deliver snoozed reminders that are now due
cron.schedule('*/5 * * * *', async () => {
  const { rows } = await db.query(`
    SELECT i.id, t.name, u.chat_id
    FROM instances i
    JOIN tasks t ON i.task_id = t.id
    JOIN users u ON t.user_id = u.id
    WHERE i.status = 'snoozed' AND i.snooze_until <= NOW()
  `);

  for (const row of rows) {
    await sendNudge(row.chat_id, row.name);
    await db.query(`
      UPDATE instances SET status = 'pending', snooze_until = NULL WHERE id = $1
    `, [row.id]);
  }
});
