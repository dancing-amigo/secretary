import axios from 'axios';
import { config } from '../config.js';
import {
  appendGoogleTaskSyncFailure,
  readGoogleTaskSyncMappingsForDate,
  removeGoogleTaskSyncMapping,
  upsertGoogleTaskSyncMapping
} from './googleDriveState.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TASKS_API_URL = 'https://tasks.googleapis.com/tasks/v1';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function googleTasksConfigError() {
  if (!config.googleTasks.enabled) return 'GOOGLE_TASKS_ENABLED must be true';
  if (!config.googleDrive.enabled) return 'GOOGLE_DRIVE_ENABLED must be true';
  if (!config.googleDrive.oauthClientId) return 'GOOGLE_OAUTH_CLIENT_ID is required';
  if (!config.googleDrive.oauthClientSecret) return 'GOOGLE_OAUTH_CLIENT_SECRET is required';
  if (!config.googleDrive.oauthRefreshToken) return 'GOOGLE_OAUTH_REFRESH_TOKEN is required';
  if (!config.googleTasks.taskListId) return 'GOOGLE_TASKS_TASKLIST_ID is required';
  return '';
}

function sanitizeTaskText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function buildDueDateTime(dateKey) {
  const normalizedDateKey = String(dateKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateKey)) {
    return undefined;
  }

  return `${normalizedDateKey}T00:00:00.000Z`;
}

function toGoogleTaskPayload(task, dateKey) {
  const payload = {
    title: sanitizeTaskText(task.title, 1024),
    notes: sanitizeTaskText(task.detail, 8192) || undefined,
    status: task.status === 'done' ? 'completed' : 'needsAction',
    due: buildDueDateTime(dateKey)
  };

  if (payload.status === 'completed') {
    payload.completed = new Date().toISOString();
  }

  return payload;
}

export function buildGoogleTaskSyncPlan({ dateKey, localTasks, mappings }) {
  const normalizedDateKey = String(dateKey || '').trim();
  const localList = Array.isArray(localTasks) ? localTasks : [];
  const mappingList = (Array.isArray(mappings) ? mappings : []).filter(
    (mapping) => String(mapping?.dateKey || '').trim() === normalizedDateKey
  );
  const localIds = new Set(localList.map((task) => String(task.id || '').trim()).filter(Boolean));
  const mappingByLocalId = new Map(
    mappingList.map((mapping) => [String(mapping.localTaskId || '').trim(), mapping])
  );

  const operations = [];

  for (const task of localList) {
    const localTaskId = String(task.id || '').trim();
    if (!localTaskId) continue;

    const mapping = mappingByLocalId.get(localTaskId);
    operations.push(
      mapping
        ? {
            type: 'upsert',
            localTaskId,
            mapping,
            task
          }
        : {
            type: 'create',
            localTaskId,
            task
          }
    );
  }

  for (const mapping of mappingList) {
    const localTaskId = String(mapping.localTaskId || '').trim();
    if (!localTaskId || localIds.has(localTaskId)) continue;

    operations.push({
      type: 'delete',
      localTaskId,
      mapping
    });
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

async function googleTasksRequest({ method, url, params, data }) {
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

async function createGoogleTask(task, dateKey) {
  const response = await googleTasksRequest({
    method: 'post',
    url: `${GOOGLE_TASKS_API_URL}/lists/${encodeURIComponent(config.googleTasks.taskListId)}/tasks`,
    data: toGoogleTaskPayload(task, dateKey)
  });

  return response.data;
}

async function updateGoogleTask({ googleTaskId, task, dateKey }) {
  const response = await googleTasksRequest({
    method: 'patch',
    url: `${GOOGLE_TASKS_API_URL}/lists/${encodeURIComponent(config.googleTasks.taskListId)}/tasks/${encodeURIComponent(googleTaskId)}`,
    params: {
      fields: 'id,title,notes,status,completed'
    },
    data: toGoogleTaskPayload(task, dateKey)
  });

  return response.data;
}

async function deleteGoogleTask(googleTaskId) {
  await googleTasksRequest({
    method: 'delete',
    url: `${GOOGLE_TASKS_API_URL}/lists/${encodeURIComponent(config.googleTasks.taskListId)}/tasks/${encodeURIComponent(googleTaskId)}`
  });
}

async function recordFailure({ dateKey, localTaskId, googleTaskId, operation, error }) {
  await appendGoogleTaskSyncFailure({
    at: new Date().toISOString(),
    dateKey,
    localTaskId,
    googleTaskId,
    taskListId: config.googleTasks.taskListId,
    operation,
    retryable: isRetryableGoogleError(error),
    error: formatGoogleError(error)
  });
}

export async function verifyGoogleTasksConnection() {
  const configError = googleTasksConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const response = await googleTasksRequest({
    method: 'get',
    url: `${GOOGLE_TASKS_API_URL}/users/@me/lists/${encodeURIComponent(config.googleTasks.taskListId)}`
  });

  return response.data;
}

export async function syncGoogleTasksForDate({ dateKey, localTasks }) {
  const configError = googleTasksConfigError();
  if (configError) {
    return {
      enabled: false,
      total: 0,
      succeeded: 0,
      failed: 0,
      retryable: 0,
      errors: [configError]
    };
  }

  const mappings = await readGoogleTaskSyncMappingsForDate(dateKey);
  const operations = buildGoogleTaskSyncPlan({ dateKey, localTasks, mappings });
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
        const created = await createGoogleTask(operation.task, dateKey);
        await upsertGoogleTaskSyncMapping({
          localTaskId: operation.localTaskId,
          googleTaskId: String(created?.id || '').trim(),
          taskListId: config.googleTasks.taskListId,
          dateKey,
          lastSyncedAt: new Date().toISOString()
        });
        summary.succeeded += 1;
        continue;
      }

      if (operation.type === 'upsert') {
        try {
          await updateGoogleTask({
            googleTaskId: operation.mapping.googleTaskId,
            task: operation.task,
            dateKey
          });
          await upsertGoogleTaskSyncMapping({
            localTaskId: operation.localTaskId,
            googleTaskId: operation.mapping.googleTaskId,
            taskListId: config.googleTasks.taskListId,
            dateKey,
            lastSyncedAt: new Date().toISOString()
          });
          summary.succeeded += 1;
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }

          const created = await createGoogleTask(operation.task, dateKey);
          await upsertGoogleTaskSyncMapping({
            localTaskId: operation.localTaskId,
            googleTaskId: String(created?.id || '').trim(),
            taskListId: config.googleTasks.taskListId,
            dateKey,
            lastSyncedAt: new Date().toISOString()
          });
          summary.succeeded += 1;
        }
        continue;
      }

      if (operation.type === 'delete') {
        try {
          await deleteGoogleTask(operation.mapping.googleTaskId);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }

        await removeGoogleTaskSyncMapping(operation.localTaskId);
        summary.succeeded += 1;
      }
    } catch (error) {
      await recordFailure({
        dateKey,
        localTaskId: operation.localTaskId,
        googleTaskId: operation.mapping?.googleTaskId || '',
        operation: operation.type,
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
