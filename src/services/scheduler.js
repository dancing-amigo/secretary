import { config } from '../config.js';
import { pushMessage } from './lineClient.js';
import { prepareDailyClose, runMorningPlan, shiftDateKey } from './assistantEngine.js';
import {
  appendConversationTurn,
  completeNotificationWindow,
  failNotificationWindow
} from './googleDriveState.js';
import { cloudTasksConfigError, ensureDailyJobTask } from './cloudTasks.js';
import { maybePostDailySummaryToX } from './xPosting.js';

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
    localTime: config.app.jobTimes[jobName],
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
    try {
      const text = await runMorningPlan();
      const out = await sendToDefaultUser(text);
      const messageSentAt = new Date().toISOString();
      try {
        await appendConversationTurn({
          userId: config.line.defaultUserId,
          role: 'assistant',
          text,
          at: messageSentAt
        });
      } catch {}

      try {
        await completeNotificationWindow({
          slot: 'morning',
          dateKey: snapshot.dateKey,
          localTime: snapshot.localTime,
          sentAt: messageSentAt
        });
      } catch {}

      return { skipped: false, ...out, ...snapshot };
    } catch (error) {
      try {
        await failNotificationWindow({
          slot: 'morning',
          dateKey: snapshot.dateKey,
          localTime: snapshot.localTime,
          error
        });
      } catch {}

      throw error;
    }
  });
}

export async function runNightJob() {
  return runScheduledJob('night', async () => {
    const snapshot = getLocalScheduleContext(config.tz);

    try {
      const text = '今日のまとめを送ってください。予定どおりに進まなかったことや、予定外で起きたことがあれば、それも一緒に書いてください。';

      const out = await sendToDefaultUser(text);
      const messageSentAt = new Date().toISOString();
      try {
        await appendConversationTurn({
          userId: config.line.defaultUserId,
          role: 'assistant',
          text,
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

      return { skipped: false, ...out, ...snapshot };
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

export async function runCloseJob() {
  return runScheduledJob('close', async () => {
    const snapshot = getLocalScheduleContext(config.tz);
    const summaryDateKey = shiftDateKey(snapshot.dateKey, -1);

    try {
      const review = await prepareDailyClose({
        userId: config.line.defaultUserId,
        dateKey: summaryDateKey,
        localTime: snapshot.localTime,
        timeZone: config.tz
      });

      let xPost = { skipped: true, reason: 'not attempted' };
      try {
        xPost = await maybePostDailySummaryToX({
          userId: config.line.defaultUserId,
          dateKey: summaryDateKey,
          localTime: snapshot.localTime,
          timeZone: config.tz
        });
      } catch (error) {
        console.error('[scheduler] x post attempt failed unexpectedly', {
          dateKey: summaryDateKey,
          error: String(error?.message || error)
        });
        xPost = {
          skipped: false,
          ok: false,
          error: String(error?.message || error || 'unknown error')
        };
      }

      try {
        await completeNotificationWindow({
          slot: 'close',
          dateKey: summaryDateKey,
          localTime: snapshot.localTime
        });
      } catch {}

      return {
        skipped: false,
        ...snapshot,
        summaryDateKey,
        ...review,
        xPost
      };
    } catch (error) {
      try {
        await failNotificationWindow({
          slot: 'close',
          dateKey: summaryDateKey,
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
    scheduleNextDailyJob('night'),
    scheduleNextDailyJob('close')
  ]);
}
