import axios from 'axios';
import { config } from '../config.js';
import {
  appendGoogleCalendarSyncFailure,
  writeGoogleCalendarPullSnapshot
} from './googleDriveState.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function googleCalendarConfigError() {
  if (!config.googleCalendar.enabled) return 'GOOGLE_CALENDAR_ENABLED must be true';
  if (!config.googleDrive.enabled) return 'GOOGLE_DRIVE_ENABLED must be true';
  if (!config.googleDrive.oauthClientId) return 'GOOGLE_OAUTH_CLIENT_ID is required';
  if (!config.googleDrive.oauthClientSecret) return 'GOOGLE_OAUTH_CLIENT_SECRET is required';
  if (!config.googleDrive.oauthRefreshToken) return 'GOOGLE_OAUTH_REFRESH_TOKEN is required';
  if (!config.googleCalendar.calendarId) return 'GOOGLE_CALENDAR_ID is required';
  return '';
}

function normalizeTimeParts(hour, minute) {
  const h = Number(hour);
  const m = Number(minute || 0);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function normalizeFullTimeString(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
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

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absoluteMinutes = Math.abs(minutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const remainder = absoluteMinutes % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
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

function parseLocalTimeParts(time) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  return { hour, minute, second };
}

export function getCalendarRfc3339ForLocalDateTime({ dateKey, time, timeZone = config.tz }) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const { hour, minute, second } = parseLocalTimeParts(time);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);
  return `${dateKey}T${String(time).trim()}${formatOffset(offsetMinutes)}`;
}

export function extractTimeRange(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const colonMatch = raw.match(/(\d{1,2})(?::(\d{2}))?\s*[〜~\-ー–]\s*(\d{1,2})(?::(\d{2}))?/);
  if (colonMatch) {
    const start = normalizeTimeParts(colonMatch[1], colonMatch[2]);
    const end = normalizeTimeParts(colonMatch[3], colonMatch[4]);
    if (start && end && start < end) {
      return { startTime: start, endTime: end };
    }
  }

  const japaneseMatch = raw.match(/(\d{1,2})時(?:\s*(\d{1,2})分?)?\s*[〜~\-ー–]\s*(\d{1,2})時(?:\s*(\d{1,2})分?)?/);
  if (japaneseMatch) {
    const start = normalizeTimeParts(japaneseMatch[1], japaneseMatch[2]);
    const end = normalizeTimeParts(japaneseMatch[3], japaneseMatch[4]);
    if (start && end && start < end) {
      return { startTime: start, endTime: end };
    }
  }

  return null;
}

function extractTimePart(dateTime) {
  const match = String(dateTime || '').trim().match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function getNextDateKey(dateKey) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const nextDate = new Date(Date.UTC(year, month - 1, day));
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate.toISOString().slice(0, 10);
}

function normalizeAgendaStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'done') return 'done';
  if (raw === 'todo') return 'todo';
  return 'todo';
}

function normalizeNotifyOnEnd(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === 'yes';
}

function parseAgendaMetadata(description) {
  const raw = String(description || '').replace(/\r\n/g, '\n');
  if (!raw.trim()) {
    return {
      status: 'todo',
      notifyOnEnd: false,
      detail: ''
    };
  }

  const lines = raw.split('\n');
  const metadata = {};
  let index = 0;
  let metadataCount = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      break;
    }

    const match = line.match(/^(status|notifyOnEnd):\s*(.+)$/i);
    if (!match) {
      break;
    }

    metadata[match[1].toLowerCase()] = match[2].trim();
    metadataCount += 1;
    index += 1;
  }

  const status = normalizeAgendaStatus(metadata.status);
  const notifyOnEnd = normalizeNotifyOnEnd(metadata.notifyonend);
  const detail = metadataCount > 0 ? lines.slice(index).join('\n').trim() : raw.trim();

  return {
    status,
    notifyOnEnd,
    detail
  };
}

export function buildAgendaDescription({ status = 'todo', notifyOnEnd = false, detail = '' }) {
  const normalizedStatus = normalizeAgendaStatus(status);
  const normalizedNotifyOnEnd = normalizeNotifyOnEnd(notifyOnEnd) ? 'on' : 'off';
  const detailText = String(detail || '').trim();
  const header = `status: ${normalizedStatus}\nnotifyOnEnd: ${normalizedNotifyOnEnd}`;
  return detailText ? `${header}\n\n${detailText}` : header;
}

function toAgendaEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const parsed = parseAgendaMetadata(event.description);
  const allDay = Boolean(event.start?.date && event.end?.date);

  return {
    eventId: String(event.id || '').trim(),
    title: String(event.summary || '').trim(),
    status: parsed.status,
    notifyOnEnd: parsed.notifyOnEnd,
    detail: parsed.detail,
    allDay,
    startTime: allDay ? '' : extractTimePart(event.start?.dateTime),
    endTime: allDay ? '' : extractTimePart(event.end?.dateTime),
    start: {
      date: String(event.start?.date || '').trim(),
      dateTime: String(event.start?.dateTime || '').trim(),
      timeZone: String(event.start?.timeZone || '').trim()
    },
    end: {
      date: String(event.end?.date || '').trim(),
      dateTime: String(event.end?.dateTime || '').trim(),
      timeZone: String(event.end?.timeZone || '').trim()
    },
    htmlLink: String(event.htmlLink || '').trim(),
    updated: String(event.updated || '').trim(),
    googleEventStatus: String(event.status || '').trim()
  };
}

function toAgendaEventPayload({ agendaEvent, dateKey }) {
  const title = String(agendaEvent?.title || '').trim().slice(0, 1024);
  const status = normalizeAgendaStatus(agendaEvent?.status);
  const notifyOnEnd = normalizeNotifyOnEnd(agendaEvent?.notifyOnEnd);
  const detail = String(agendaEvent?.detail || '').trim();
  const allDay = Boolean(agendaEvent?.allDay);
  const startTime = normalizeFullTimeString(agendaEvent?.startTime);
  const endTime = normalizeFullTimeString(agendaEvent?.endTime);

  const payload = {
    summary: title,
    description: buildAgendaDescription({ status, notifyOnEnd, detail }),
    colorId: String(config.googleCalendar.eventColorId || '').trim() || undefined
  };

  if (allDay) {
    return {
      ...payload,
      start: { date: dateKey },
      end: { date: getNextDateKey(dateKey) }
    };
  }

  return {
    ...payload,
    start: {
      dateTime: getCalendarRfc3339ForLocalDateTime({
        dateKey,
        time: startTime,
        timeZone: config.tz
      }),
      timeZone: config.tz
    },
    end: {
      dateTime: getCalendarRfc3339ForLocalDateTime({
        dateKey,
        time: endTime,
        timeZone: config.tz
      }),
      timeZone: config.tz
    }
  };
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const params = new URLSearchParams({
    client_id: config.googleDrive.oauthClientId,
    client_secret: config.googleDrive.oauthClientSecret,
    refresh_token: config.googleDrive.oauthRefreshToken,
    grant_type: 'refresh_token'
  });

  if (config.googleDrive.oauthRedirectUri) {
    params.set('redirect_uri', config.googleDrive.oauthRedirectUri);
  }

  const response = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  const expiresIn = Number(response.data?.expires_in || 3600);
  cachedAccessToken = String(response.data?.access_token || '');
  cachedAccessTokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;
  return cachedAccessToken;
}

async function googleCalendarRequest({ method, url, params, data }) {
  const accessToken = await getAccessToken();
  return axios({
    method,
    url,
    params,
    data,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    }
  });
}

function isRetryableGoogleError(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 429) return true;
  if (status >= 500) return true;

  const code = String(error?.code || '').trim();
  return ['ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'].includes(code);
}

function isNotFoundError(error) {
  return Number(error?.response?.status || 0) === 404;
}

function formatGoogleError(error) {
  const status = Number(error?.response?.status || 0);
  const apiMessage = error?.response?.data?.error?.message;
  const message = String(apiMessage || error?.message || 'unknown error').trim();
  return status ? `${status} ${message}` : message;
}

function logGoogleCalendarSyncFailure({ dateKey, googleCalendarEventId, operation, payload, error }) {
  console.error('[google-calendar-sync] failed', {
    dateKey,
    googleCalendarEventId,
    calendarId: config.googleCalendar.calendarId,
    operation,
    payload,
    retryable: isRetryableGoogleError(error),
    error: formatGoogleError(error),
    response: error?.response?.data || null
  });
}

function getDateWindowForCalendarPull(dateKey) {
  return {
    timeMin: getCalendarRfc3339ForLocalDateTime({
      dateKey,
      time: '00:00:00',
      timeZone: config.tz
    }),
    timeMax: getCalendarRfc3339ForLocalDateTime({
      dateKey,
      time: '23:59:59',
      timeZone: config.tz
    })
  };
}

function extractDateKeyFromEventBoundary(boundary) {
  const date = String(boundary?.date || '').trim();
  if (date) return date;

  const dateTime = String(boundary?.dateTime || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(dateTime)) {
    return dateTime.slice(0, 10);
  }

  return '';
}

function isEventRelevantToDate(event, dateKey) {
  const startKey = extractDateKeyFromEventBoundary(event?.start);
  const endKey = extractDateKeyFromEventBoundary(event?.end);
  if (startKey === dateKey) return true;
  if (!endKey) return false;
  if (startKey && endKey) {
    return startKey <= dateKey && endKey >= dateKey;
  }
  return false;
}

function normalizePulledCalendarEvent(event) {
  const agendaEvent = toAgendaEvent(event);
  if (!agendaEvent?.eventId) return null;

  return {
    ...agendaEvent,
    calendarId: config.googleCalendar.calendarId,
    description: String(event?.description || '').trim()
  };
}

async function listCalendarEventsForDate({ dateKey }) {
  const { timeMin, timeMax } = getDateWindowForCalendarPull(dateKey);
  const response = await googleCalendarRequest({
    method: 'get',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events`,
    params: {
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      timeMin,
      timeMax,
      maxResults: 2500
    }
  });

  return {
    items: Array.isArray(response.data?.items) ? response.data.items : [],
    timeMin,
    timeMax
  };
}

export async function getGoogleCalendarEventById(eventId) {
  const configError = googleCalendarConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const normalizedEventId = String(eventId || '').trim();
  if (!normalizedEventId) {
    return null;
  }

  try {
    const response = await googleCalendarRequest({
      method: 'get',
      url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events/${encodeURIComponent(normalizedEventId)}`
    });
    return normalizePulledCalendarEvent(response.data);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function deleteCalendarEvent(googleCalendarEventId) {
  await googleCalendarRequest({
    method: 'delete',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events/${encodeURIComponent(googleCalendarEventId)}`
  });
}

async function createAgendaEvent({ agendaEvent, dateKey }) {
  const response = await googleCalendarRequest({
    method: 'post',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events`,
    data: toAgendaEventPayload({ agendaEvent, dateKey })
  });

  return response.data;
}

async function updateAgendaEvent({ eventId, agendaEvent, dateKey }) {
  const response = await googleCalendarRequest({
    method: 'patch',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events/${encodeURIComponent(eventId)}`,
    data: toAgendaEventPayload({ agendaEvent, dateKey })
  });

  return response.data;
}

export async function pullGoogleCalendarEventsForDate({ dateKey, operation = 'unknown' } = {}) {
  const configError = googleCalendarConfigError();
  if (configError) {
    return {
      enabled: false,
      status: 'disabled',
      failed: false,
      operation,
      calendarId: config.googleCalendar.calendarId,
      dateKey: String(dateKey || '').trim(),
      events: [],
      error: configError
    };
  }

  const normalizedDateKey = String(dateKey || '').trim();
  const startedAt = new Date().toISOString();

  try {
    const listed = await listCalendarEventsForDate({ dateKey: normalizedDateKey });
    const events = listed.items
      .filter((event) => isEventRelevantToDate(event, normalizedDateKey))
      .map((event) => normalizePulledCalendarEvent(event))
      .filter((event) => event?.eventId);

    const completedAt = new Date().toISOString();
    await writeGoogleCalendarPullSnapshot({
      dateKey: normalizedDateKey,
      calendarId: config.googleCalendar.calendarId,
      startedAt,
      completedAt,
      windowStart: listed.timeMin,
      windowEnd: listed.timeMax,
      status: 'ok',
      operation,
      events
    });

    return {
      enabled: true,
      status: 'ok',
      failed: false,
      operation,
      calendarId: config.googleCalendar.calendarId,
      dateKey: normalizedDateKey,
      events,
      startedAt,
      completedAt,
      windowStart: listed.timeMin,
      windowEnd: listed.timeMax,
      fromCache: false
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const { timeMin, timeMax } = getDateWindowForCalendarPull(normalizedDateKey);
    console.error('[google-calendar-read] failed', {
      dateKey: normalizedDateKey,
      calendarId: config.googleCalendar.calendarId,
      operation,
      timeMin,
      timeMax,
      retryable: isRetryableGoogleError(error),
      error: formatGoogleError(error),
      response: error?.response?.data || null
    });
    await appendGoogleCalendarSyncFailure({
      at: completedAt,
      dateKey: normalizedDateKey,
      calendarId: config.googleCalendar.calendarId,
      operation: `calendar_read:${operation}`,
      retryable: isRetryableGoogleError(error),
      error: formatGoogleError(error)
    });
    await writeGoogleCalendarPullSnapshot({
      dateKey: normalizedDateKey,
      calendarId: config.googleCalendar.calendarId,
      startedAt,
      completedAt,
      windowStart: timeMin,
      windowEnd: timeMax,
      status: 'failed',
      operation,
      error: formatGoogleError(error),
      events: []
    });

    return {
      enabled: true,
      status: 'failed',
      failed: true,
      operation,
      calendarId: config.googleCalendar.calendarId,
      dateKey: normalizedDateKey,
      events: [],
      error: formatGoogleError(error),
      retryable: isRetryableGoogleError(error),
      startedAt,
      completedAt,
      windowStart: timeMin,
      windowEnd: timeMax,
      fromCache: false
    };
  }
}

function formatAgendaOperationPayload(agendaEvent, dateKey) {
  try {
    return toAgendaEventPayload({ agendaEvent, dateKey });
  } catch {
    return null;
  }
}

export async function reconcileAgendaEventsForDate({
  dateKey,
  currentEvents,
  nextEvents,
  allowedNewEventIds = []
}) {
  const configError = googleCalendarConfigError();
  if (configError) {
    return {
      enabled: false,
      total: 0,
      succeeded: 0,
      failed: 0,
      retryable: 0,
      errors: []
    };
  }

  const currentList = Array.isArray(currentEvents) ? currentEvents : [];
  const nextList = Array.isArray(nextEvents) ? nextEvents : [];
  const currentById = new Map(
    currentList
      .filter((event) => String(event?.eventId || '').trim())
      .map((event) => [String(event.eventId || '').trim(), event])
  );
  const allowedNewIds = new Set((Array.isArray(allowedNewEventIds) ? allowedNewEventIds : []).map((id) => String(id || '').trim()));
  const seenNextIds = new Set();
  const operations = [];

  for (const event of nextList) {
    const eventId = String(event?.eventId || event?.id || '').trim();
    if (!eventId || seenNextIds.has(eventId)) continue;
    seenNextIds.add(eventId);

    if (currentById.has(eventId)) {
      operations.push({ type: 'update', eventId, agendaEvent: event });
      continue;
    }

    if (!allowedNewIds.has(eventId)) {
      operations.push({ type: 'invalid', eventId, agendaEvent: event, error: 'unknown new event id' });
      continue;
    }

    operations.push({ type: 'create', eventId, agendaEvent: event });
  }

  for (const currentEvent of currentList) {
    const eventId = String(currentEvent?.eventId || '').trim();
    if (!eventId || seenNextIds.has(eventId)) continue;
    operations.push({ type: 'delete', eventId, agendaEvent: currentEvent });
  }

  const summary = {
    enabled: true,
    total: operations.length,
    succeeded: 0,
    failed: 0,
    retryable: 0,
    errors: []
  };

  for (const operation of operations) {
    try {
      if (operation.type === 'invalid') {
        throw new Error(operation.error || 'invalid operation');
      }

      if (operation.type === 'create') {
        await createAgendaEvent({ agendaEvent: operation.agendaEvent, dateKey });
        summary.succeeded += 1;
        continue;
      }

      if (operation.type === 'update') {
        await updateAgendaEvent({
          eventId: operation.eventId,
          agendaEvent: operation.agendaEvent,
          dateKey
        });
        summary.succeeded += 1;
        continue;
      }

      if (operation.type === 'delete') {
        await deleteCalendarEvent(operation.eventId);
        summary.succeeded += 1;
      }
    } catch (error) {
      logGoogleCalendarSyncFailure({
        dateKey,
        googleCalendarEventId: operation.eventId || '',
        operation: `agenda_${operation.type}`,
        payload: formatAgendaOperationPayload(operation.agendaEvent, dateKey),
        error
      });
      await appendGoogleCalendarSyncFailure({
        at: new Date().toISOString(),
        dateKey,
        googleCalendarEventId: operation.eventId || '',
        calendarId: config.googleCalendar.calendarId,
        operation: `agenda_${operation.type}`,
        retryable: isRetryableGoogleError(error),
        error: formatGoogleError(error)
      });
      summary.failed += 1;
      if (isRetryableGoogleError(error)) {
        summary.retryable += 1;
      }
      summary.errors.push(formatGoogleError(error));
    }
  }

  return summary;
}
