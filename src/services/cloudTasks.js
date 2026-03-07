import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config.js';
import { getGoogleCloudAccessToken, googleServiceAuthConfigError } from './googleServiceAuth.js';

const CLOUD_TASKS_API_URL = 'https://cloudtasks.googleapis.com/v2';

function sanitizeTaskSegment(value, fallback = 'task') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function scheduleStamp(value) {
  return String(value || '')
    .replace(/[^0-9]/g, '')
    .slice(0, 14) || '0';
}

function eventHash(eventId) {
  return crypto.createHash('sha1').update(String(eventId || '')).digest('hex').slice(0, 12);
}

function queuePath() {
  return `projects/${config.cloudTasks.projectId}/locations/${config.cloudTasks.location}/queues/${config.cloudTasks.queue}`;
}

function reminderTargetUrl() {
  const baseUrl = String(config.app.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) return '';
  return `${baseUrl}/api/jobs/event-reminder-delivery`;
}

function jobTargetUrl(jobName) {
  const baseUrl = String(config.app.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) return '';
  return `${baseUrl}/api/jobs/${sanitizeTaskSegment(jobName, 'job')}`;
}

export function cloudTasksConfigError() {
  const authError = googleServiceAuthConfigError();
  if (authError) return authError;
  if (!config.cloudTasks.location) return 'CLOUD_TASKS_LOCATION is required';
  if (!config.cloudTasks.queue) return 'CLOUD_TASKS_QUEUE is required';
  if (!String(config.app.baseUrl || '').trim()) return 'APP_BASE_URL or SECRETARY_BASE_URL is required';
  return '';
}

function buildTaskName(taskId) {
  return `${queuePath()}/tasks/${taskId}`;
}

function formatTaskId({ eventId, type, scheduledAt }) {
  return [
    'event',
    sanitizeTaskSegment(type, 'reminder'),
    eventHash(eventId),
    sanitizeTaskSegment(eventId, 'event'),
    scheduleStamp(scheduledAt)
  ].join('-').slice(0, 500);
}

async function cloudTasksRequest({ method, url, data }) {
  const accessToken = await getGoogleCloudAccessToken();
  return axios({
    method,
    url,
    data,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    }
  });
}

export function buildReminderTaskName({ eventId, type, scheduledAt }) {
  return buildTaskName(formatTaskId({ eventId, type, scheduledAt }));
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

function parseLocalDateParts(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new RangeError(`Invalid local date: ${dateKey}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function parseLocalTimeParts(time) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new RangeError(`Invalid local time: ${time}`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  return { hour, minute, second };
}

function formatLocalDateKey(date, timeZone = config.tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getUtcIsoForLocalDateTime({ dateKey, time, timeZone }) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const { hour, minute, second } = parseLocalTimeParts(time);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000).toISOString();
}

function addDaysToDateKey(dateKey, days) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatLocalDateKey(date, 'UTC');
}

function getLocalTimeParts(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}

function nextDateKeyForLocalTime({ timeZone, localTime, now = new Date() }) {
  const { hour, minute, second } = parseLocalTimeParts(localTime);
  const localNow = getLocalTimeParts(timeZone, now);
  const currentSeconds = localNow.hour * 3600 + localNow.minute * 60 + localNow.second;
  const targetSeconds = hour * 3600 + minute * 60 + second;
  return currentSeconds < targetSeconds ? localNow.dateKey : addDaysToDateKey(localNow.dateKey, 1);
}

function formatJobTaskId({ jobName, dateKey, localTime }) {
  return [
    'job',
    sanitizeTaskSegment(jobName, 'job'),
    dateKey.replace(/[^0-9]/g, ''),
    scheduleStamp(localTime)
  ].join('-');
}

function createHttpTaskPayload({ url, payload, scheduleTime, taskName }) {
  return {
    task: {
      name: taskName,
      scheduleTime,
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {})
        },
        body: Buffer.from(JSON.stringify(payload)).toString('base64')
      }
    }
  };
}

async function createTask({ taskName, url, payload, scheduleTime }) {
  try {
    const response = await cloudTasksRequest({
      method: 'post',
      url: `${CLOUD_TASKS_API_URL}/${queuePath()}/tasks`,
      data: createHttpTaskPayload({ taskName, url, payload, scheduleTime })
    });

    return {
      taskName: response.data?.name || taskName,
      alreadyExists: false
    };
  } catch (error) {
    if (Number(error?.response?.status || 0) === 409) {
      return {
        taskName,
        alreadyExists: true
      };
    }
    throw error;
  }
}

export async function createReminderTask({ eventId, type, scheduledAt, dateKey }) {
  const configError = cloudTasksConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const taskName = buildReminderTaskName({ eventId, type, scheduledAt });
  const payload = {
    eventId: String(eventId || '').trim(),
    type: String(type || '').trim(),
    scheduledAt: String(scheduledAt || '').trim(),
    dateKey: String(dateKey || '').trim()
  };
  const scheduledAtTime = Date.parse(payload.scheduledAt);
  const scheduleTime = Number.isFinite(scheduledAtTime) && scheduledAtTime > Date.now()
    ? payload.scheduledAt
    : new Date(Date.now() + 5000).toISOString();
  const response = await createTask({
    taskName,
    url: reminderTargetUrl(),
    payload,
    scheduleTime
  });

  return {
    taskName: response.taskName,
    scheduledAt: payload.scheduledAt
  };
}

export async function ensureDailyJobTask({ jobName, localTime, timeZone = config.tz, now = new Date() }) {
  const configError = cloudTasksConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const targetUrl = jobTargetUrl(jobName);
  if (!targetUrl) {
    throw new Error('APP_BASE_URL or SECRETARY_BASE_URL is required');
  }

  const dateKey = nextDateKeyForLocalTime({ timeZone, localTime, now });
  const scheduleTime = getUtcIsoForLocalDateTime({ dateKey, time: localTime, timeZone });
  const taskName = buildTaskName(formatJobTaskId({ jobName, dateKey, localTime }));
  const payload = {
    scheduledFor: dateKey,
    scheduledLocalTime: localTime,
    scheduledTimeZone: timeZone
  };

  const response = await createTask({
    taskName,
    url: targetUrl,
    payload,
    scheduleTime
  });

  return {
    taskName: response.taskName,
    dateKey,
    scheduleTime,
    alreadyExists: response.alreadyExists
  };
}

export async function deleteReminderTask(taskName) {
  const normalizedTaskName = String(taskName || '').trim();
  if (!normalizedTaskName) {
    return { deleted: false, skipped: true };
  }

  const configError = cloudTasksConfigError();
  if (configError) {
    throw new Error(configError);
  }

  try {
    await cloudTasksRequest({
      method: 'delete',
      url: `${CLOUD_TASKS_API_URL}/${normalizedTaskName}`
    });
    return { deleted: true, skipped: false };
  } catch (error) {
    if (Number(error?.response?.status || 0) === 404) {
      return { deleted: false, skipped: true, notFound: true };
    }
    throw error;
  }
}
