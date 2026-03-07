import { config } from '../config.js';
import { pushMessage } from './lineClient.js';
import { prepareNightReview, runMorningPlan } from './assistantEngine.js';
import {
  appendConversationTurn,
  completeNotificationWindow,
  failNotificationWindow
} from './googleDriveState.js';
import { cloudTasksConfigError, ensureDailyJobTask } from './cloudTasks.js';

const DAILY_JOB_TIMES = {
  morning: '08:00:00',
  night: '22:00:00'
};

function getLocalDateTimeParts(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function getLocalScheduleContext(timeZone, date = new Date()) {
  const parts = getLocalDateTimeParts(timeZone, date);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  };
}

async function sendToDefaultUser(text) {
  const userId = config.line.defaultUserId;
  if (!userId) {
    return { ok: false, error: 'LINE_DEFAULT_USER_ID is required' };
  }

  await pushMessage(userId, text);
  return { ok: true, userId, text };
}

async function scheduleNextDailyJob(jobName, now = new Date()) {
  const result = await ensureDailyJobTask({
    jobName,
    localTime: DAILY_JOB_TIMES[jobName],
    timeZone: config.tz,
    now
  });
  return result;
}

async function runScheduledJob(jobName, runner) {
  try {
    const result = await runner();
    const next = await scheduleNextDailyJob(jobName, new Date(Date.now() + 1000));
    return { ...result, nextScheduled: next };
  } catch (error) {
    try {
      await scheduleNextDailyJob(jobName, new Date(Date.now() + 1000));
    } catch (scheduleError) {
      console.error(`[scheduler] failed to reschedule ${jobName}`, {
        error: String(scheduleError?.message || scheduleError)
      });
    }

    throw error;
  }
}

export async function runMorningJob() {
  return runScheduledJob('morning', async () => {
    const snapshot = getLocalScheduleContext(config.tz);
    const text = await runMorningPlan();
    const out = await sendToDefaultUser(text);
    try {
      await completeNotificationWindow({
        slot: 'morning',
        dateKey: snapshot.dateKey,
        localTime: snapshot.localTime
      });
    } catch {}
    return { skipped: false, ...out, ...snapshot };
  });
}

export async function runNightJob() {
  return runScheduledJob('night', async () => {
    const snapshot = getLocalScheduleContext(config.tz);

    try {
      const review = await prepareNightReview({
        userId: config.line.defaultUserId,
        dateKey: snapshot.dateKey,
        localTime: snapshot.localTime,
        timeZone: config.tz
      });

      const out = await sendToDefaultUser(review.text);
      const messageSentAt = new Date().toISOString();
      try {
        await appendConversationTurn({
          userId: config.line.defaultUserId,
          role: 'assistant',
          text: review.text,
          at: messageSentAt
        });
      } catch {}

      try {
        await completeNotificationWindow({
          slot: 'night',
          dateKey: snapshot.dateKey,
          localTime: snapshot.localTime,
          sentAt: messageSentAt
        });
      } catch {}

      return { skipped: false, ...out, ...snapshot, ...review };
    } catch (error) {
      try {
        await failNotificationWindow({
          slot: 'night',
          dateKey: snapshot.dateKey,
          localTime: snapshot.localTime,
          error
        });
      } catch {}

      throw error;
    }
  });
}

export async function startSchedulers() {
  const configError = cloudTasksConfigError();
  if (configError) {
    console.warn(`[scheduler] cloud tasks disabled: ${configError}`);
    return;
  }

  await Promise.all([
    scheduleNextDailyJob('morning'),
    scheduleNextDailyJob('night')
  ]);
}
