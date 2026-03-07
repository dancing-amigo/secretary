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

export function cloudTasksConfigError() {
  const authError = googleServiceAuthConfigError();
  if (authError) return authError;
  if (!config.cloudTasks.location) return 'CLOUD_TASKS_LOCATION is required';
  if (!config.cloudTasks.queue) return 'CLOUD_TASKS_QUEUE is required';
  if (!reminderTargetUrl()) return 'APP_BASE_URL or SECRETARY_BASE_URL is required';
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

  const response = await cloudTasksRequest({
    method: 'post',
    url: `${CLOUD_TASKS_API_URL}/${queuePath()}/tasks`,
    data: {
      task: {
        name: taskName,
        scheduleTime,
        httpRequest: {
          httpMethod: 'POST',
          url: reminderTargetUrl(),
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {})
          },
          body: Buffer.from(JSON.stringify(payload)).toString('base64')
        }
      }
    }
  });

  return {
    taskName: response.data?.name || taskName,
    scheduledAt: payload.scheduledAt
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
