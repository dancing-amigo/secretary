import cron from 'node-cron';
import { config } from '../config.js';
import { pushMessage } from './lineClient.js';
import { prepareNightReview, runMorningPlan } from './assistantEngine.js';
import {
  appendConversationTurn,
  completeNotificationWindow,
  failNotificationWindow,
  reserveNotificationWindow
} from './googleDriveState.js';

const NOTIFICATION_WINDOWS = {
  morning: {
    startMinutes: 7 * 60 + 30,
    endMinutes: 8 * 60 + 30,
    label: '07:30-08:30 local time'
  },
  night: {
    startMinutes: 21 * 60 + 30,
    endMinutes: 22 * 60 + 30,
    label: '21:30-22:30 local time'
  }
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

function getLocalScheduleSnapshot(slot, timeZone, date = new Date()) {
  const window = NOTIFICATION_WINDOWS[slot];
  const parts = getLocalDateTimeParts(timeZone, date);
  const totalMinutes = parts.hour * 60 + parts.minute;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    withinWindow: totalMinutes >= window.startMinutes && totalMinutes <= window.endMinutes,
    windowLabel: window.label
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

async function runWindowedJob({ slot, textFactory, enforceWindow = false }) {
  const snapshot = getLocalScheduleSnapshot(slot, config.tz);
  if (enforceWindow && !snapshot.withinWindow) {
    return { skipped: true, reason: `outside ${snapshot.windowLabel}`, ...snapshot };
  }

  let reservation;
  try {
    reservation = await reserveNotificationWindow({
      slot,
      dateKey: snapshot.dateKey,
      localTime: snapshot.localTime
    });
  } catch (error) {
    return {
      skipped: true,
      reason: `notification dedupe unavailable: ${String(error.message || error)}`,
      ...snapshot
    };
  }

  if (!reservation.reserved) {
    return { skipped: true, reason: reservation.reason, ...snapshot };
  }

  try {
    const text = await textFactory();
    const out = await sendToDefaultUser(text);
    await completeNotificationWindow({
      slot,
      dateKey: snapshot.dateKey,
      localTime: snapshot.localTime
    });
    return { skipped: false, ...out, ...snapshot };
  } catch (error) {
    try {
      await failNotificationWindow({
        slot,
        dateKey: snapshot.dateKey,
        localTime: snapshot.localTime,
        error
      });
    } catch {
      // Keep the original send error as the primary failure.
    }

    throw error;
  }
}

export async function runMorningJob({ enforceWindow = false } = {}) {
  return runWindowedJob({
    slot: 'morning',
    textFactory: runMorningPlan,
    enforceWindow
  });
}

export async function runNightJob({ enforceWindow = false } = {}) {
  const snapshot = getLocalScheduleSnapshot('night', config.tz);
  if (enforceWindow && !snapshot.withinWindow) {
    return { skipped: true, reason: `outside ${snapshot.windowLabel}`, ...snapshot };
  }

  let reservation;
  try {
    reservation = await reserveNotificationWindow({
      slot: 'night',
      dateKey: snapshot.dateKey,
      localTime: snapshot.localTime
    });
  } catch (error) {
    return {
      skipped: true,
      reason: `notification dedupe unavailable: ${String(error.message || error)}`,
      ...snapshot
    };
  }

  if (!reservation.reserved) {
    return { skipped: true, reason: reservation.reason, ...snapshot };
  }

  try {
    const review = await prepareNightReview({
      userId: config.line.defaultUserId,
      dateKey: snapshot.dateKey,
      localTime: snapshot.localTime,
      timeZone: config.tz
    });

    if (!review.alreadySent) {
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

      await completeNotificationWindow({
        slot: 'night',
        dateKey: snapshot.dateKey,
        localTime: snapshot.localTime,
        sentAt: messageSentAt
      });

      return { skipped: false, ...out, ...snapshot, ...review };
    }

    await completeNotificationWindow({
      slot: 'night',
      dateKey: snapshot.dateKey,
      localTime: snapshot.localTime
    });

    return { skipped: true, reason: 'already sent', ...snapshot, ...review };
  } catch (error) {
    try {
      await failNotificationWindow({
        slot: 'night',
        dateKey: snapshot.dateKey,
        localTime: snapshot.localTime,
        error
      });
    } catch {
      // Keep the original send error as the primary failure.
    }

    throw error;
  }
}

export function startSchedulers() {
  cron.schedule(config.cron.morning, async () => {
    await runMorningJob();
  }, { timezone: config.tz });

  cron.schedule(config.cron.night, async () => {
    await runNightJob();
  }, { timezone: config.tz });
}
