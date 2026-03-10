import { config } from '../config.js';
import {
  appendConversationTurn,
  deleteEventScheduleRecord,
  getEventScheduleRecord,
  getNotificationRecord,
  listEventScheduleRecords,
  readConversationTurns,
  updateNotificationRecord,
  upsertEventScheduleRecord
} from './googleDriveState.js';
import { deleteReminderTask, createReminderTask, cloudTasksConfigError } from './cloudTasks.js';
import { getCalendarRfc3339ForLocalDateTime, getGoogleCalendarEventById } from './googleCalendarSync.js';
import { pushMessage } from './lineClient.js';
import { createTextOutput } from './openaiClient.js';

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

function parseLocalDateParts(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new RangeError(`Invalid local date: ${dateKey}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function shiftDateKey(dateKey, days) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit'
  }).formatToParts(date);
  const rawOffset = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = rawOffset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function getUtcIsoForLocalDateTime({ dateKey, time, timeZone }) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const timeMatch = String(time || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeMatch) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || 0);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000).toISOString();
}

function formatConversationTimestamp(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:[+-]\d{2}:\d{2}|Z)?$/);
  if (!match) return normalized;
  return `${match[1]} ${match[2]}`;
}

function formatConversationTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return '- 会話履歴なし';
  }

  return turns
    .map((turn) => `- [${formatConversationTimestamp(turn.localAt)}] ${turn.role}: ${turn.text}`)
    .join('\n');
}

async function loadReminderConversationContext({ userId, dateKey, localTime, timeZone }) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return { turns: [], text: '- 会話履歴なし' };
  }

  const since = getUtcIsoForLocalDateTime({
    dateKey: shiftDateKey(dateKey, -1),
    time: '22:00:00',
    timeZone
  });
  const until = getUtcIsoForLocalDateTime({
    dateKey,
    time: localTime,
    timeZone
  });
  const turns = await readConversationTurns({ userId: normalizedUserId, since, until });
  return {
    turns,
    text: formatConversationTurns(turns)
  };
}

export function buildReminderBaseMessage(event, type) {
  if (type === 'start') {
    return startReminderMessage(event);
  }
  return endReminderMessage(event);
}

function startReminderMessage(event) {
  return `「${event.title || '予定'}」の時間です。`;
}

function endReminderMessage(event) {
  return `「${event.title || '予定'}」は終了時刻です。まだ終わっていなければ対応してください。`;
}

function buildReminderReplyPrompt({ userId, type, event, dateKey, localTime, timeZone, conversationText, baseMessage }) {
  const timeText = event.allDay
    ? '終日'
    : `${event.startTime || '(start?)'}-${event.endTime || '(end?)'}`;

  return [
    'あなたは個人向けLINE秘書のイベントリマインダー生成役です。',
    `現在のユーザーID: ${userId || '(empty)'}`,
    `対象日付: ${dateKey}`,
    `送信直前のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    `通知種別: ${type}`,
    '',
    '役割:',
    '- いま送るイベント通知を、そのまま LINE に送れる自然な日本語1本に整える',
    '- 基本はリマインダー本文を維持しつつ、必要なときだけ短い補足を1文まで足してよい',
    '',
    'ルール:',
    '- 完成済みの本文だけを返す。前置きや説明は不要',
    '- 長くしすぎない。最大でも2文程度の短文にする',
    '- ベースの通知意図を崩さない。開始通知なら「時間です」、終了通知なら「終了時刻です」が自然に伝わること',
    '- 会話履歴や予定詳細から有益な一言があるときだけ短く足す。無理に足さない',
    '- 新しい約束や未確認の事実を作らない',
    '- 箇条書き、見出し、絵文字は使わない',
    '',
    'ベース通知文:',
    baseMessage,
    '',
    '対象イベント:',
    `- title: ${event.title || '予定'}`,
    `- time: ${timeText}`,
    `- detail: ${event.detail || '(なし)'}`,
    `- status: ${event.status || '(unknown)'}`,
    '',
    '当日の会話履歴:',
    conversationText
  ].join('\n');
}

export function normalizeReminderMessage(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 5000);

  return normalized || fallback;
}

async function generateReminderMessage({ event, type, scheduledAt, userId }) {
  const fallback = buildReminderBaseMessage(event, type);
  const dateKey = extractDateKey(type === 'start' ? event.start : event.end) || extractDateKey(event.start);
  const localTime = formatLocalTimeInZone(scheduledAt, config.tz) || formatLocalTimeInZone(new Date().toISOString(), config.tz);
  const conversationContext = dateKey
    ? await loadReminderConversationContext({ userId, dateKey, localTime, timeZone: config.tz })
    : { text: '- 会話履歴なし' };

  try {
    const output = await createTextOutput({
      model: config.openai.summaryModel || config.openai.taskModel,
      systemPrompt: '完成済みの日本語メッセージ本文だけを返してください。前置きや説明は不要です。',
      userPrompt: buildReminderReplyPrompt({
        userId,
        type,
        event,
        dateKey: dateKey || '(unknown)',
        localTime,
        timeZone: config.tz,
        conversationText: conversationContext.text,
        baseMessage: fallback
      })
    });
    return normalizeReminderMessage(output, fallback);
  } catch (error) {
    console.error('[event-reminders] llm generation failed', {
      eventId: event?.eventId || '',
      type,
      userId,
      error: String(error?.message || error)
    });
    return fallback;
  }
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

    const text = await generateReminderMessage({
      event,
      type: 'start',
      scheduledAt: payload.scheduledAt,
      userId: config.line.defaultUserId
    });
    await sendReminderMessage(text);
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

  const text = await generateReminderMessage({
    event,
    type: payload.type,
    scheduledAt: payload.scheduledAt,
    userId: config.line.defaultUserId
  });
  await sendReminderMessage(text);
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
