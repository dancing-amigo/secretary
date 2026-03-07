import { config } from '../config.js';
import {
  appendConversationTurn,
  deleteEventScheduleRecord,
  getEventScheduleRecord,
  getNotificationRecord,
  listEventScheduleRecords,
  updateNotificationRecord,
  upsertEventScheduleRecord
} from './googleDriveState.js';
import { deleteReminderTask, createReminderTask, cloudTasksConfigError } from './cloudTasks.js';
import { getCalendarRfc3339ForLocalDateTime, getGoogleCalendarEventById } from './googleCalendarSync.js';
import { pushMessage } from './lineClient.js';

const END_REMINDER_INTERVAL_MINUTES = 15;
const END_REMINDER_CUTOFF_HOUR = 22;

function extractDateKey(boundary) {
  const date = String(boundary?.date || '').trim();
  if (date) return date;

  const dateTime = String(boundary?.dateTime || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(dateTime)) {
    return dateTime.slice(0, 10);
  }

  return '';
}

function isTimedEvent(event) {
  return Boolean(event && !event.allDay && event.startTime && event.endTime);
}

function reminderSlot({ eventId, type, scheduledAt }) {
  return `event-reminder:${String(type || '').trim()}:${String(eventId || '').trim()}:${String(scheduledAt || '').trim()}`;
}

async function wasReminderSent({ eventId, type, scheduledAt, dateKey }) {
  const record = await getNotificationRecord({
    slot: reminderSlot({ eventId, type, scheduledAt }),
    dateKey
  });
  return Boolean(record?.sentAt);
}

async function markReminderSent({ eventId, type, scheduledAt, dateKey }) {
  return updateNotificationRecord({
    slot: reminderSlot({ eventId, type, scheduledAt }),
    dateKey,
    updates: {
      eventId,
      type,
      scheduledAt,
      sentAt: new Date().toISOString(),
      status: 'sent'
    }
  });
}

function formatLocalTimeInZone(isoString, timeZone = config.tz) {
  const parsed = Date.parse(String(isoString || '').trim());
  if (!Number.isFinite(parsed)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(parsed));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function isBeforeEndReminderCutoff(isoString, timeZone = config.tz) {
  const localTime = formatLocalTimeInZone(isoString, timeZone);
  if (!localTime) return false;
  return localTime < `${String(END_REMINDER_CUTOFF_HOUR).padStart(2, '0')}:00:00`;
}

function addMinutesToIso(isoString, minutes) {
  const parsed = Date.parse(String(isoString || '').trim());
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed + minutes * 60 * 1000).toISOString();
}

function formatEventScheduledAt(event, boundaryKey) {
  const dateKey = extractDateKey(event?.[boundaryKey]);
  const time = boundaryKey === 'start' ? event?.startTime : event?.endTime;
  if (!dateKey || !time) return '';
  return getCalendarRfc3339ForLocalDateTime({
    dateKey,
    time,
    timeZone: config.tz
  });
}

function startReminderMessage(event) {
  return `「${event.title || '予定'}」の時間です。`;
}

function endReminderMessage(event) {
  return `「${event.title || '予定'}」は終了時刻です。まだ終わっていなければ対応してください。`;
}

async function sendReminderMessage(text) {
  const userId = config.line.defaultUserId;
  if (!userId) {
    throw new Error('LINE_DEFAULT_USER_ID is required');
  }

  await pushMessage(userId, text);
  try {
    await appendConversationTurn({
      userId,
      role: 'assistant',
      text
    });
  } catch {}
}

async function deleteReminderTasks(taskNames) {
  for (const taskName of taskNames.map((value) => String(value || '').trim()).filter(Boolean)) {
    await deleteReminderTask(taskName);
  }
}

function shouldCreateFutureStartTask(startScheduledAt) {
  const parsed = Date.parse(startScheduledAt);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function buildDesiredSchedule(event) {
  const timed = isTimedEvent(event);
  const startScheduledAt = timed && event.status !== 'done'
    ? formatEventScheduledAt(event, 'start')
    : '';
  const endScheduledAt = timed && event.notifyOnEnd && event.status === 'todo'
    ? formatEventScheduledAt(event, 'end')
    : '';

  return {
    timed,
    startScheduledAt,
    endScheduledAt
  };
}

async function reconcileSingleEvent(event) {
  const eventId = String(event?.eventId || '').trim();
  if (!eventId) return;

  const existing = await getEventScheduleRecord(eventId);
  const desired = buildDesiredSchedule(event);
  const nextRecord = {
    eventId,
    startTaskName: existing?.startTaskName || '',
    startScheduledAt: desired.startScheduledAt || existing?.startScheduledAt || '',
    endTaskName: existing?.endTaskName || '',
    endScheduledAt: desired.endScheduledAt || existing?.endScheduledAt || '',
    endRepeatTaskName: existing?.endRepeatTaskName || '',
    endRepeatScheduledAt: existing?.endRepeatScheduledAt || '',
    notifyOnEnd: Boolean(event.notifyOnEnd),
    status: String(event.status || '').trim(),
    allDay: Boolean(event.allDay)
  };

  const startChanged = String(existing?.startScheduledAt || '') !== String(desired.startScheduledAt || '')
    || Boolean(existing?.allDay) !== Boolean(event.allDay)
    || String(existing?.status || '') !== String(event.status || '').trim();
  if (startChanged && existing?.startTaskName) {
    await deleteReminderTask(existing.startTaskName);
    nextRecord.startTaskName = '';
  }

  if (desired.startScheduledAt) {
    const startSent = await wasReminderSent({
      eventId,
      type: 'start',
      scheduledAt: desired.startScheduledAt,
      dateKey: extractDateKey(event.start)
    });
    if (!startSent && !nextRecord.startTaskName && shouldCreateFutureStartTask(desired.startScheduledAt)) {
      const created = await createReminderTask({
        eventId,
        type: 'start',
        scheduledAt: desired.startScheduledAt,
        dateKey: extractDateKey(event.start)
      });
      nextRecord.startTaskName = created.taskName;
      nextRecord.startScheduledAt = created.scheduledAt;
    }
  } else {
    nextRecord.startTaskName = '';
    nextRecord.startScheduledAt = '';
  }

  const endChanged = String(existing?.endScheduledAt || '') !== String(desired.endScheduledAt || '')
    || Boolean(existing?.notifyOnEnd) !== Boolean(event.notifyOnEnd)
    || String(existing?.status || '') !== String(event.status || '').trim()
    || Boolean(existing?.allDay) !== Boolean(event.allDay);
  if (endChanged) {
    await deleteReminderTasks([existing?.endTaskName, existing?.endRepeatTaskName]);
    nextRecord.endTaskName = '';
    nextRecord.endRepeatTaskName = '';
    nextRecord.endRepeatScheduledAt = '';
  }

  if (desired.endScheduledAt && isBeforeEndReminderCutoff(desired.endScheduledAt)) {
    const endSent = await wasReminderSent({
      eventId,
      type: 'end',
      scheduledAt: desired.endScheduledAt,
      dateKey: extractDateKey(event.end)
    });
    if (!endSent && !nextRecord.endTaskName) {
      const created = await createReminderTask({
        eventId,
        type: 'end',
        scheduledAt: desired.endScheduledAt,
        dateKey: extractDateKey(event.end)
      });
      nextRecord.endTaskName = created.taskName;
      nextRecord.endScheduledAt = created.scheduledAt;
    } else {
      nextRecord.endScheduledAt = desired.endScheduledAt;
    }
  } else {
    nextRecord.endTaskName = '';
    nextRecord.endScheduledAt = desired.endScheduledAt || '';
    if (!desired.endScheduledAt) {
      await deleteReminderTasks([existing?.endRepeatTaskName]);
      nextRecord.endRepeatTaskName = '';
      nextRecord.endRepeatScheduledAt = '';
    }
  }

  if (!desired.timed && !nextRecord.endRepeatTaskName) {
    await deleteReminderTasks([existing?.startTaskName, existing?.endTaskName, existing?.endRepeatTaskName]);
    await deleteEventScheduleRecord(eventId);
    return;
  }

  await upsertEventScheduleRecord(eventId, nextRecord);
}

export async function reconcileReminderSchedulesForDate({ dateKey, events }) {
  if (cloudTasksConfigError()) {
    return { enabled: false, total: 0 };
  }

  const normalizedDateKey = String(dateKey || '').trim();
  const eventList = Array.isArray(events) ? events : [];
  const currentIds = new Set(
    eventList
      .filter((event) => extractDateKey(event?.start) === normalizedDateKey || extractDateKey(event?.end) === normalizedDateKey)
      .map((event) => String(event?.eventId || '').trim())
      .filter(Boolean)
  );

  const existingSchedules = await listEventScheduleRecords();
  for (const record of existingSchedules) {
    if (currentIds.has(record.eventId)) continue;
    await deleteReminderTasks([record.startTaskName, record.endTaskName, record.endRepeatTaskName]);
    await deleteEventScheduleRecord(record.eventId);
  }

  for (const event of eventList) {
    if (!String(event?.eventId || '').trim()) continue;
    await reconcileSingleEvent(event);
  }

  return { enabled: true, total: eventList.length };
}

function scheduledAtMatches(left, right) {
  const leftTime = Date.parse(String(left || '').trim());
  const rightTime = Date.parse(String(right || '').trim());
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function parseReminderPayload(rawPayload) {
  let payload = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  return {
    eventId: String(payload.eventId || '').trim(),
    type: String(payload.type || '').trim(),
    scheduledAt: String(payload.scheduledAt || '').trim(),
    dateKey: String(payload.dateKey || '').trim()
  };
}

async function clearStartScheduleIfMatches(record, scheduledAt) {
  if (!record || !scheduledAtMatches(record.startScheduledAt, scheduledAt)) return;
  await upsertEventScheduleRecord(record.eventId, {
    ...record,
    startTaskName: '',
    startScheduledAt: record.startScheduledAt
  });
}

async function clearEndScheduleIfMatches(record, scheduledAt, { clearRepeat = false } = {}) {
  if (!record) return;
  const updates = { ...record };
  if (scheduledAtMatches(record.endScheduledAt, scheduledAt)) {
    updates.endTaskName = '';
  }
  if (clearRepeat && scheduledAtMatches(record.endRepeatScheduledAt, scheduledAt)) {
    updates.endRepeatTaskName = '';
    updates.endRepeatScheduledAt = '';
  }
  await upsertEventScheduleRecord(record.eventId, updates);
}

async function scheduleNextEndRepeat({ record, event, previousScheduledAt }) {
  const nextScheduledAt = addMinutesToIso(previousScheduledAt, END_REMINDER_INTERVAL_MINUTES);
  if (!nextScheduledAt || !isBeforeEndReminderCutoff(nextScheduledAt)) {
    await upsertEventScheduleRecord(record.eventId, {
      ...record,
      endTaskName: '',
      endRepeatTaskName: '',
      endRepeatScheduledAt: ''
    });
    return null;
  }

  const dateKey = extractDateKey(event.end);
  const created = await createReminderTask({
    eventId: record.eventId,
    type: 'end-repeat',
    scheduledAt: nextScheduledAt,
    dateKey
  });
  await upsertEventScheduleRecord(record.eventId, {
    ...record,
    endTaskName: '',
    endRepeatTaskName: created.taskName,
    endRepeatScheduledAt: created.scheduledAt,
    endScheduledAt: formatEventScheduledAt(event, 'end')
  });
  return created;
}

export async function runEventReminderDelivery(rawPayload) {
  const payload = parseReminderPayload(rawPayload);
  if (!payload.eventId || !payload.type || !payload.scheduledAt) {
    return { ok: false, skipped: true, reason: 'invalid payload' };
  }

  const event = await getGoogleCalendarEventById(payload.eventId);
  const record = await getEventScheduleRecord(payload.eventId);
  if (!event) {
    if (record) {
      await deleteReminderTasks([record.startTaskName, record.endTaskName, record.endRepeatTaskName]);
      await deleteEventScheduleRecord(payload.eventId);
    }
    return { ok: true, skipped: true, reason: 'event missing', payload };
  }

  const dateKey = payload.dateKey || extractDateKey(event.start) || extractDateKey(event.end);
  if (await wasReminderSent({ ...payload, dateKey })) {
    return { ok: true, skipped: true, reason: 'already sent', payload };
  }

  if (payload.type === 'start') {
    const currentStartScheduledAt = formatEventScheduledAt(event, 'start');
    if (!isTimedEvent(event) || event.status === 'done' || !scheduledAtMatches(currentStartScheduledAt, payload.scheduledAt)) {
      if (record) {
        await clearStartScheduleIfMatches(record, payload.scheduledAt);
      }
      return { ok: true, skipped: true, reason: 'start conditions not met', payload };
    }

    await sendReminderMessage(startReminderMessage(event));
    await markReminderSent({ ...payload, dateKey });
    if (record) {
      await clearStartScheduleIfMatches(record, payload.scheduledAt);
    }
    return { ok: true, skipped: false, payload };
  }

  if (payload.type !== 'end' && payload.type !== 'end-repeat') {
    return { ok: false, skipped: true, reason: 'unknown type', payload };
  }

  const currentEndScheduledAt = formatEventScheduledAt(event, 'end');
  const repeatScheduledAt = record?.endRepeatScheduledAt || '';
  const scheduledMatches = payload.type === 'end'
    ? scheduledAtMatches(currentEndScheduledAt, payload.scheduledAt)
    : scheduledAtMatches(repeatScheduledAt, payload.scheduledAt);
  if (
    !isTimedEvent(event)
    || !event.notifyOnEnd
    || event.status === 'done'
    || !scheduledMatches
  ) {
    if (record) {
      await clearEndScheduleIfMatches(record, payload.scheduledAt, { clearRepeat: true });
    }
    return { ok: true, skipped: true, reason: 'end conditions not met', payload };
  }

  await sendReminderMessage(endReminderMessage(event));
  await markReminderSent({ ...payload, dateKey });
  if (record) {
    await scheduleNextEndRepeat({
      record,
      event,
      previousScheduledAt: payload.scheduledAt
    });
  }

  return { ok: true, skipped: false, payload };
}
