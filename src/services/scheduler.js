import cron from 'node-cron';
import { config } from '../config.js';
import { store } from './store.js';
import { messageForJob, shouldSkipJob } from './reminders.js';
import { pushMessage } from './lineClient.js';
import { runMorningPlan, runNightReview } from './assistantEngine.js';

function targetUsers() {
  const list = store.listUserIds();
  if (list.length > 0) return list;
  if (config.line.defaultUserId) return [config.line.defaultUserId];
  return [];
}

async function fanout(text) {
  const users = targetUsers();
  for (const userId of users) {
    await pushMessage(userId, text).catch(() => null);
  }
}

export function startSchedulers() {
  cron.schedule(
    config.cron.morning,
    async () => {
      const text = await runMorningPlan();
      await fanout(text);
    },
    { timezone: config.tz }
  );

  cron.schedule(
    config.cron.night,
    async () => {
      const text = runNightReview();
      await fanout(text);
    },
    { timezone: config.tz }
  );

  cron.schedule(
    config.cron.reminderTick,
    async () => {
      const due = store.dueReminderJobs();
      for (const job of due) {
        if (shouldSkipJob(job)) {
          store.markReminderJob(job.id, { status: 'skipped', attempts: (job.attempts || 0) + 1 });
          continue;
        }

        try {
          await fanout(messageForJob(job));
          store.markReminderJob(job.id, { status: 'sent', sentAt: new Date().toISOString(), attempts: (job.attempts || 0) + 1 });
        } catch (e) {
          const attempts = (job.attempts || 0) + 1;
          if (attempts >= 3) {
            store.markReminderJob(job.id, { status: 'failed', attempts, error: String(e.message || e) });
          } else {
            store.markReminderJob(job.id, { attempts });
          }
        }
      }
    },
    { timezone: config.tz }
  );
}
