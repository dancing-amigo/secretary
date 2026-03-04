import cron from 'node-cron';
import { DateTime } from 'luxon';
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
  return users.length;
}

async function sendToUser(userId, text) {
  if (!userId) return 0;
  await pushMessage(userId, text).catch(() => null);
  return 1;
}

function isLocalClock(targetHour) {
  const now = DateTime.now().setZone(config.tz);
  return now.hour === targetHour;
}

function isWithinReminderWindow() {
  const now = DateTime.now().setZone(config.tz);
  return now.hour >= 8 && now.hour < 22;
}

export async function runMorningJob({ enforceLocalClock = false } = {}) {
  if (enforceLocalClock && !isLocalClock(8)) return { skipped: true, reason: 'not 08:00 local hour' };
  const users = targetUsers();
  let userCount = 0;
  for (const userId of users) {
    const text = await runMorningPlan(userId);
    userCount += await sendToUser(userId, text);
  }
  return { skipped: false, userCount };
}

export async function runNightJob({ enforceLocalClock = false } = {}) {
  if (enforceLocalClock && !isLocalClock(22)) return { skipped: true, reason: 'not 22:00 local hour' };
  const users = targetUsers();
  let userCount = 0;
  for (const userId of users) {
    const text = runNightReview(userId);
    userCount += await sendToUser(userId, text);
  }
  return { skipped: false, userCount };
}

export async function runReminderTick() {
  const due = store.dueReminderJobs();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const withinWindow = isWithinReminderWindow();

  for (const job of due) {
    if (!withinWindow) {
      store.markReminderJob(job.id, {
        status: 'skipped',
        attempts: (job.attempts || 0) + 1,
        reason: 'quiet_hours'
      });
      skipped += 1;
      continue;
    }

    if (shouldSkipJob(job)) {
      store.markReminderJob(job.id, { status: 'skipped', attempts: (job.attempts || 0) + 1 });
      skipped += 1;
      continue;
    }

    try {
      const users = await sendToUser(job.userId, messageForJob(job));
      if (users > 0) {
        store.markReminderJob(job.id, { status: 'sent', sentAt: new Date().toISOString(), attempts: (job.attempts || 0) + 1 });
        sent += 1;
      } else {
        store.markReminderJob(job.id, { status: 'failed', attempts: (job.attempts || 0) + 1, error: 'no target users' });
        failed += 1;
      }
    } catch (e) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts >= 3) {
        store.markReminderJob(job.id, { status: 'failed', attempts, error: String(e.message || e) });
      } else {
        store.markReminderJob(job.id, { attempts });
      }
      failed += 1;
    }
  }

  return { due: due.length, sent, skipped, failed, withinWindow };
}

export function startSchedulers() {
  cron.schedule(
    config.cron.morning,
    async () => {
      await runMorningJob();
    },
    { timezone: config.tz }
  );

  cron.schedule(
    config.cron.night,
    async () => {
      await runNightJob();
    },
    { timezone: config.tz }
  );

  cron.schedule(
    config.cron.reminderTick,
    async () => {
      await runReminderTick();
    },
    { timezone: config.tz }
  );
}
