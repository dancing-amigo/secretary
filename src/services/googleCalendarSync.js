import axios from 'axios';
import { config } from '../config.js';
import {
  appendGoogleTaskSyncFailure,
  readGoogleTaskSyncMappingsForDate,
  removeGoogleCalendarSyncMapping,
  upsertGoogleCalendarSyncMapping
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

function toCalendarDateTime(dateKey, time) {
  return `${String(dateKey).trim()}T${String(time).trim()}`;
}

function toCalendarEventPayload({ task, dateKey, timeRange }) {
  return {
    summary: String(task.title || '').trim().slice(0, 1024),
    description: String(task.detail || '').trim().slice(0, 8192) || undefined,
    start: {
      dateTime: toCalendarDateTime(dateKey, timeRange.startTime),
      timeZone: config.tz
    },
    end: {
      dateTime: toCalendarDateTime(dateKey, timeRange.endTime),
      timeZone: config.tz
    }
  };
}

export function buildGoogleCalendarSyncPlan({ dateKey, localTasks, mappings }) {
  const normalizedDateKey = String(dateKey || '').trim();
  const mappingList = (Array.isArray(mappings) ? mappings : []).filter(
    (mapping) => String(mapping?.dateKey || '').trim() === normalizedDateKey
  );
  const mappingByLocalId = new Map(
    mappingList.map((mapping) => [String(mapping.localTaskId || '').trim(), mapping])
  );
  const operations = [];
  const localIds = new Set();

  for (const task of Array.isArray(localTasks) ? localTasks : []) {
    const localTaskId = String(task?.id || '').trim();
    if (!localTaskId) continue;
    localIds.add(localTaskId);

    const timeRange = extractTimeRange(task.detail) || extractTimeRange(task.title);
    const mapping = mappingByLocalId.get(localTaskId);
    if (!timeRange) {
      if (mapping?.googleCalendarEventId) {
        operations.push({ type: 'delete', localTaskId, mapping });
      }
      continue;
    }

    operations.push({
      type: mapping?.googleCalendarEventId ? 'upsert' : 'create',
      localTaskId,
      mapping,
      task,
      timeRange
    });
  }

  for (const mapping of mappingList) {
    const localTaskId = String(mapping.localTaskId || '').trim();
    if (!localTaskId || localIds.has(localTaskId)) continue;
    if (!mapping.googleCalendarEventId) continue;
    operations.push({ type: 'delete', localTaskId, mapping });
  }

  return operations;
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

async function createCalendarEvent({ task, dateKey, timeRange }) {
  const response = await googleCalendarRequest({
    method: 'post',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events`,
    data: toCalendarEventPayload({ task, dateKey, timeRange })
  });

  return response.data;
}

async function updateCalendarEvent({ googleCalendarEventId, task, dateKey, timeRange }) {
  const response = await googleCalendarRequest({
    method: 'patch',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events/${encodeURIComponent(googleCalendarEventId)}`,
    data: toCalendarEventPayload({ task, dateKey, timeRange })
  });

  return response.data;
}

async function deleteCalendarEvent(googleCalendarEventId) {
  await googleCalendarRequest({
    method: 'delete',
    url: `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events/${encodeURIComponent(googleCalendarEventId)}`
  });
}

async function recordFailure({ dateKey, localTaskId, googleCalendarEventId, operation, error }) {
  await appendGoogleTaskSyncFailure({
    at: new Date().toISOString(),
    dateKey,
    localTaskId,
    googleTaskId: googleCalendarEventId,
    taskListId: config.googleCalendar.calendarId,
    operation,
    retryable: isRetryableGoogleError(error),
    error: formatGoogleError(error)
  });
}

export async function syncGoogleCalendarForDate({ dateKey, localTasks }) {
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

  const mappings = await readGoogleTaskSyncMappingsForDate(dateKey);
  const operations = buildGoogleCalendarSyncPlan({ dateKey, localTasks, mappings });
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
      if (operation.type === 'create') {
        const created = await createCalendarEvent(operation);
        await upsertGoogleCalendarSyncMapping({
          localTaskId: operation.localTaskId,
          googleCalendarEventId: String(created?.id || '').trim(),
          calendarId: config.googleCalendar.calendarId,
          dateKey,
          lastSyncedAt: new Date().toISOString()
        });
        summary.succeeded += 1;
        continue;
      }

      if (operation.type === 'upsert') {
        try {
          const updated = await updateCalendarEvent({
            googleCalendarEventId: operation.mapping.googleCalendarEventId,
            task: operation.task,
            dateKey,
            timeRange: operation.timeRange
          });
          await upsertGoogleCalendarSyncMapping({
            localTaskId: operation.localTaskId,
            googleCalendarEventId: String(updated?.id || operation.mapping.googleCalendarEventId || '').trim(),
            calendarId: config.googleCalendar.calendarId,
            dateKey,
            lastSyncedAt: new Date().toISOString()
          });
          summary.succeeded += 1;
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }

          const created = await createCalendarEvent(operation);
          await upsertGoogleCalendarSyncMapping({
            localTaskId: operation.localTaskId,
            googleCalendarEventId: String(created?.id || '').trim(),
            calendarId: config.googleCalendar.calendarId,
            dateKey,
            lastSyncedAt: new Date().toISOString()
          });
          summary.succeeded += 1;
        }
        continue;
      }

      if (operation.type === 'delete') {
        try {
          await deleteCalendarEvent(operation.mapping.googleCalendarEventId);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }

        await removeGoogleCalendarSyncMapping(operation.localTaskId);
        summary.succeeded += 1;
      }
    } catch (error) {
      await recordFailure({
        dateKey,
        localTaskId: operation.localTaskId,
        googleCalendarEventId: operation.mapping?.googleCalendarEventId || '',
        operation: `calendar_${operation.type}`,
        error
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
