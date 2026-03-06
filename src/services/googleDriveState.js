import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const PENDING_STALE_MS = 2 * 60 * 60 * 1000;
const TASKS_FOLDER_NAME = 'tasks';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedStateFileId = null;
let cachedTasksFolderId = null;
const cachedTaskFileIds = new Map();

function driveStateConfigError() {
  if (!config.googleDrive.enabled) return 'GOOGLE_DRIVE_ENABLED must be true';
  if (!config.googleDrive.folderId) return 'GOOGLE_DRIVE_FOLDER_ID is required';
  if (!config.googleDrive.oauthClientId) return 'GOOGLE_OAUTH_CLIENT_ID is required';
  if (!config.googleDrive.oauthClientSecret) return 'GOOGLE_OAUTH_CLIENT_SECRET is required';
  if (!config.googleDrive.oauthRefreshToken) return 'GOOGLE_OAUTH_REFRESH_TOKEN is required';
  return '';
}

function notificationKey(slot, dateKey) {
  return `${slot}:${dateKey}`;
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { notifications: {} };
  }

  if (!state.notifications || typeof state.notifications !== 'object' || Array.isArray(state.notifications)) {
    state.notifications = {};
  }

  return state;
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

async function driveRequest({ method, url, params, data, headers, responseType }) {
  const accessToken = await getAccessToken();
  return axios({
    method,
    url,
    params,
    data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers
    },
    responseType,
    timeout: 10000
  });
}

function buildMultipartBody(metadata, content, contentMimeType = 'application/json; charset=UTF-8') {
  const boundary = `secretary-${randomUUID()}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${contentMimeType}`,
    '',
    content,
    `--${boundary}--`
  ].join('\r\n');

  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`
  };
}

async function findStateFileId() {
  if (cachedStateFileId) return cachedStateFileId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name: config.googleDrive.stateFileName
  });
  if (existingId) {
    cachedStateFileId = existingId;
    return existingId;
  }

  const { body, contentType } = buildMultipartBody(
    {
      name: config.googleDrive.stateFileName,
      parents: [config.googleDrive.folderId],
      mimeType: 'application/json'
    },
    JSON.stringify({ notifications: {} }, null, 2)
  );

  const created = await driveRequest({
    method: 'post',
    url: GOOGLE_DRIVE_UPLOAD_URL,
    params: {
      uploadType: 'multipart',
      fields: 'id'
    },
    data: body,
    headers: { 'Content-Type': contentType }
  });

  cachedStateFileId = created.data?.id || null;
  return cachedStateFileId;
}

async function findDriveChildId({ parentId, name, mimeType }) {
  const qParts = [
    'trashed = false',
    `name = '${escapeDriveQueryValue(name)}'`,
    `'${escapeDriveQueryValue(parentId)}' in parents`
  ];

  if (mimeType) {
    qParts.push(`mimeType = '${escapeDriveQueryValue(mimeType)}'`);
  }

  const response = await driveRequest({
    method: 'get',
    url: GOOGLE_DRIVE_API_URL,
    params: {
      q: qParts.join(' and '),
      pageSize: 1,
      fields: 'files(id,name,mimeType)'
    }
  });

  return response.data?.files?.[0]?.id || null;
}

async function createDriveFile({ parentId, name, mimeType, content }) {
  if (mimeType === 'application/vnd.google-apps.folder') {
    const created = await driveRequest({
      method: 'post',
      url: GOOGLE_DRIVE_API_URL,
      params: { fields: 'id' },
      data: {
        name,
        parents: [parentId],
        mimeType
      },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' }
    });

    return created.data?.id || null;
  }

  const { body, contentType } = buildMultipartBody(
    {
      name,
      parents: [parentId],
      mimeType
    },
    content,
    `${mimeType}; charset=UTF-8`
  );

  const created = await driveRequest({
    method: 'post',
    url: GOOGLE_DRIVE_UPLOAD_URL,
    params: {
      uploadType: 'multipart',
      fields: 'id'
    },
    data: body,
    headers: { 'Content-Type': contentType }
  });

  return created.data?.id || null;
}

async function ensureTasksFolderId() {
  if (cachedTasksFolderId) return cachedTasksFolderId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name: TASKS_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  });

  if (existingId) {
    cachedTasksFolderId = existingId;
    return existingId;
  }

  const createdId = await createDriveFile({
    parentId: config.googleDrive.folderId,
    name: TASKS_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
    content: ''
  });

  cachedTasksFolderId = createdId;
  return createdId;
}

function buildTaskFileBody({ dateKey, tasks }) {
  const taskLines = tasks.length === 0
    ? ['- まだタスクはありません']
    : tasks.flatMap((task, index) => {
      const lines = [
        `- [${task.status}] ${task.title}`,
        `  - id: ${task.id}`,
        `  - userId: ${task.userId}`
      ];

      if (task.detail) {
        lines.push(`  - detail: ${task.detail}`);
      }

      if (index < tasks.length - 1) {
        lines.push('');
      }

      return lines;
    });

  return [
    `# Tasks ${dateKey}`,
    '',
    '## Items',
    ...taskLines,
    ''
  ].join('\n');
}

function parseMarkdownTasks(text, dateKey) {
  const normalizedText = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalizedText) {
    return { date: dateKey, tasks: [] };
  }

  const lines = normalizedText.split('\n');
  const headerMatch = lines[0]?.match(/^# Tasks (\d{4}-\d{2}-\d{2})$/);
  const parsedDateKey = headerMatch?.[1] || dateKey;
  const tasks = [];
  let currentTask = null;

  const pushCurrentTask = () => {
    if (!currentTask) return;
    tasks.push(currentTask);
    currentTask = null;
  };

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }

    if (line === '## Items' || line === '- まだタスクはありません') {
      continue;
    }

    const taskMatch = line.match(/^(?:-|\d+\.) \[(todo|done)\] (.+)$/);
    if (taskMatch) {
      pushCurrentTask();
      currentTask = {
        status: taskMatch[1],
        title: taskMatch[2].trim(),
        detail: ''
      };
      continue;
    }

    if (!currentTask) {
      continue;
    }

    const metaMatch = line.match(/^\s*- (id|userId|detail):\s*(.*)$/);
    if (!metaMatch) {
      continue;
    }

    const [, key, value] = metaMatch;
    currentTask[key] = value.trim();
  }

  pushCurrentTask();

  return {
    date: parsedDateKey,
    tasks
  };
}

function parseTaskFileBody(content, dateKey) {
  return parseMarkdownTasks(String(content || ''), dateKey);
}

async function readDriveTextFile(fileId) {
  const response = await driveRequest({
    method: 'get',
    url: `${GOOGLE_DRIVE_API_URL}/${fileId}`,
    params: { alt: 'media' },
    responseType: 'arraybuffer'
  });

  return Buffer.from(response.data || '').toString('utf8');
}

async function writeDriveTextFile(fileId, content, mimeType = 'text/markdown') {
  await driveRequest({
    method: 'patch',
    url: `${GOOGLE_DRIVE_UPLOAD_URL}/${fileId}`,
    params: { uploadType: 'media' },
    data: content,
    headers: { 'Content-Type': `${mimeType}; charset=UTF-8` }
  });
}

async function ensureTaskFileId(dateKey) {
  if (cachedTaskFileIds.has(dateKey)) {
    return cachedTaskFileIds.get(dateKey);
  }

  const tasksFolderId = await ensureTasksFolderId();
  const fileName = `${dateKey}.md`;
  const existingId = await findDriveChildId({
    parentId: tasksFolderId,
    name: fileName
  });

  if (existingId) {
    cachedTaskFileIds.set(dateKey, existingId);
    return existingId;
  }

  const createdId = await createDriveFile({
    parentId: tasksFolderId,
    name: fileName,
    mimeType: 'text/markdown',
    content: buildTaskFileBody({ dateKey, tasks: [] })
  });

  cachedTaskFileIds.set(dateKey, createdId);
  return createdId;
}

async function loadTaskFileForDate(dateKey) {
  const fileId = await ensureTaskFileId(dateKey);
  const content = await readDriveTextFile(fileId);

  return {
    fileId,
    content: content || buildTaskFileBody({ dateKey, tasks: [] })
  };
}

async function readState() {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = await findStateFileId();
  const text = (await readDriveTextFile(fileId)).trim();
  if (!text) return { notifications: {} };

  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return { notifications: {} };
  }
}

async function writeState(state) {
  const fileId = await findStateFileId();
  await writeDriveTextFile(fileId, JSON.stringify(normalizeState(state), null, 2), 'application/json');
}

function normalizeStoredTask(task, fallbackUserId = '') {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;

  const title = String(task.title || '').trim().replace(/\s+/g, ' ');
  if (!title) return null;

  const detail = String(task.detail || '').trim().replace(/\s+/g, ' ');
  const rawStatus = String(task.status || 'todo').trim().toLowerCase();
  const status = rawStatus === 'done' ? 'done' : 'todo';

  return {
    id: String(task.id || `task-${randomUUID()}`),
    userId: String(task.userId || fallbackUserId),
    title: title.slice(0, 120),
    detail: detail.slice(0, 280),
    status
  };
}

async function loadTasksForDate(dateKey) {
  const { fileId, content } = await loadTaskFileForDate(dateKey);
  const parsed = parseTaskFileBody(content, dateKey);

  return {
    fileId,
    content,
    tasks: parsed.tasks
      .map((task) => normalizeStoredTask(task))
      .filter(Boolean)
  };
}

export async function readTasksForDate(dateKey) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const { tasks } = await loadTasksForDate(dateKey);
  return tasks;
}

export async function readTaskFileForDate(dateKey) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const { tasks } = await loadTasksForDate(dateKey);
  return buildTaskFileBody({ dateKey, tasks });
}

export async function replaceTaskFileForDate({ dateKey, content, allowedNewTaskIds = [], currentUserId = '' }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const normalizedContent = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!normalizedContent) {
    throw new Error('タスクファイルの内容が空です。');
  }

  const { fileId, tasks: existingTasks } = await loadTasksForDate(dateKey);
  const parsed = parseTaskFileBody(normalizedContent, dateKey);
  const nextTasks = parsed.tasks
    .map((task) => normalizeStoredTask(task, currentUserId))
    .filter(Boolean);
  const seenIds = new Set();
  const allowedNewIds = new Set(allowedNewTaskIds);
  const existingById = new Map(existingTasks.map((task) => [task.id, task]));

  if (parsed.date !== dateKey) {
    throw new Error('返却されたタスクファイルの日付が当日ではありません。');
  }

  for (const task of nextTasks) {
    if (seenIds.has(task.id)) {
      throw new Error('返却されたタスクファイルに重複した id があります。');
    }
    seenIds.add(task.id);

    const existingTask = existingById.get(task.id);
    if (existingTask) {
      if (existingTask.userId !== task.userId) {
        throw new Error('既存タスクの userId は変更できません。');
      }
      continue;
    }

    if (!allowedNewIds.has(task.id)) {
      throw new Error('新規タスクの id が許可された候補に含まれていません。');
    }

    if (currentUserId && task.userId !== currentUserId) {
      throw new Error('新規タスクの userId が現在ユーザーと一致しません。');
    }
  }

  await writeDriveTextFile(fileId, `${normalizedContent}\n`);
  return nextTasks;
}

export async function reserveNotificationWindow({ slot, dateKey, localTime, now = new Date() }) {
  const state = await readState();
  const key = notificationKey(slot, dateKey);
  const existing = state.notifications[key];
  const nowIso = now.toISOString();

  if (existing?.status === 'sent') {
    return { reserved: false, reason: 'already sent', record: existing };
  }

  if (existing?.status === 'pending') {
    const reservedAt = Date.parse(existing.reservedAt || '');
    if (Number.isFinite(reservedAt) && now.getTime() - reservedAt < PENDING_STALE_MS) {
      return { reserved: false, reason: 'already pending', record: existing };
    }
  }

  state.notifications[key] = {
    slot,
    dateKey,
    localTime,
    reservedAt: nowIso,
    status: 'pending'
  };
  await writeState(state);

  return { reserved: true, record: state.notifications[key] };
}

export async function completeNotificationWindow({ slot, dateKey, localTime, sentAt = new Date().toISOString() }) {
  const state = await readState();
  const key = notificationKey(slot, dateKey);
  const previous = state.notifications[key] || {};
  state.notifications[key] = {
    ...previous,
    slot,
    dateKey,
    localTime,
    sentAt,
    status: 'sent'
  };
  await writeState(state);
}

export async function failNotificationWindow({ slot, dateKey, localTime, error, failedAt = new Date().toISOString() }) {
  const state = await readState();
  const key = notificationKey(slot, dateKey);
  const previous = state.notifications[key] || {};
  state.notifications[key] = {
    ...previous,
    slot,
    dateKey,
    localTime,
    failedAt,
    error: String(error || 'unknown error').slice(0, 500),
    status: 'failed'
  };
  await writeState(state);
}
