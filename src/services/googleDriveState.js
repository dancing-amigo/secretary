import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const PENDING_STALE_MS = 2 * 60 * 60 * 1000;
const TASKS_FOLDER_NAME = 'tasks';
const CONVERSATIONS_FOLDER_NAME = 'conversations';
const LOG_FILE_NAME = 'log.md';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedNotificationStateFileId = null;
let cachedTasksFolderId = null;
let cachedConversationsFolderId = null;
let cachedLogFileId = null;
const cachedTaskFileIds = new Map();
const cachedConversationFileIds = new Map();

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

function normalizeConversationState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { conversations: {} };
  }

  if (!state.conversations || typeof state.conversations !== 'object' || Array.isArray(state.conversations)) {
    state.conversations = {};
  }

  return state;
}

function normalizeConversationTurn(turn) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return null;

  const role = String(turn.role || '').trim();
  const text = String(turn.text || '').trim();
  const at = String(turn.at || '').trim();
  if (!role || !text || !at) return null;
  if (role !== 'user' && role !== 'assistant') return null;

  return {
    role,
    text: text.slice(0, 5000),
    at
  };
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

async function findStateFileId({ name, initialContent, cacheKey }) {
  if (cacheKey === 'notification' && cachedNotificationStateFileId) return cachedNotificationStateFileId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name
  });
  if (existingId) {
    if (cacheKey === 'notification') cachedNotificationStateFileId = existingId;
    return existingId;
  }

  const { body, contentType } = buildMultipartBody(
    {
      name,
      parents: [config.googleDrive.folderId],
      mimeType: 'application/json'
    },
    JSON.stringify(initialContent, null, 2)
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

  if (cacheKey === 'notification') cachedNotificationStateFileId = created.data?.id || null;
  return created.data?.id || null;
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

async function ensureConversationsFolderId() {
  if (cachedConversationsFolderId) return cachedConversationsFolderId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name: CONVERSATIONS_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  });

  if (existingId) {
    cachedConversationsFolderId = existingId;
    return existingId;
  }

  const createdId = await createDriveFile({
    parentId: config.googleDrive.folderId,
    name: CONVERSATIONS_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
    content: ''
  });

  cachedConversationsFolderId = createdId;
  return createdId;
}

async function ensureLogFileId() {
  if (cachedLogFileId) return cachedLogFileId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name: LOG_FILE_NAME
  });

  if (existingId) {
    cachedLogFileId = existingId;
    return existingId;
  }

  const createdId = await createDriveFile({
    parentId: config.googleDrive.folderId,
    name: LOG_FILE_NAME,
    mimeType: 'text/markdown',
    content: '# Daily Log\n'
  });

  cachedLogFileId = createdId;
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

async function readNotificationState() {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = await findStateFileId({
    name: config.googleDrive.notificationStateFileName,
    initialContent: { notifications: {} },
    cacheKey: 'notification'
  });
  const text = (await readDriveTextFile(fileId)).trim();
  if (!text) return normalizeState({});

  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return normalizeState({});
  }
}

async function writeNotificationState(state) {
  const fileId = await findStateFileId({
    name: config.googleDrive.notificationStateFileName,
    initialContent: { notifications: {} },
    cacheKey: 'notification'
  });
  await writeDriveTextFile(fileId, JSON.stringify(normalizeState(state), null, 2), 'application/json');
}

function getDateKeyInTimeZone(date, timeZone = config.tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function listDateKeysBetween({ since, until, timeZone = config.tz }) {
  const sinceTime = Date.parse(since);
  const untilTime = Date.parse(until);
  if (!Number.isFinite(sinceTime) || !Number.isFinite(untilTime) || sinceTime > untilTime) {
    return [];
  }

  const keys = new Set([
    getDateKeyInTimeZone(new Date(sinceTime), timeZone),
    getDateKeyInTimeZone(new Date(untilTime), timeZone)
  ]);

  let cursor = new Date(sinceTime);
  cursor.setUTCHours(12, 0, 0, 0);
  const end = new Date(untilTime);
  end.setUTCHours(12, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    keys.add(getDateKeyInTimeZone(cursor, timeZone));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Array.from(keys).sort();
}

async function ensureConversationFileId(dateKey) {
  if (cachedConversationFileIds.has(dateKey)) {
    return cachedConversationFileIds.get(dateKey);
  }

  const folderId = await ensureConversationsFolderId();
  const fileName = `${dateKey}.json`;
  const existingId = await findDriveChildId({
    parentId: folderId,
    name: fileName
  });

  if (existingId) {
    cachedConversationFileIds.set(dateKey, existingId);
    return existingId;
  }

  const createdId = await createDriveFile({
    parentId: folderId,
    name: fileName,
    mimeType: 'application/json',
    content: JSON.stringify({ date: dateKey, conversations: {} }, null, 2)
  });

  cachedConversationFileIds.set(dateKey, createdId);
  return createdId;
}

async function findConversationFileId(dateKey) {
  if (cachedConversationFileIds.has(dateKey)) {
    return cachedConversationFileIds.get(dateKey);
  }

  const folderId = await ensureConversationsFolderId();
  const existingId = await findDriveChildId({
    parentId: folderId,
    name: `${dateKey}.json`
  });

  if (existingId) {
    cachedConversationFileIds.set(dateKey, existingId);
  }

  return existingId;
}

async function readConversationStateForDate(dateKey, { createIfMissing = false } = {}) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = createIfMissing ? await ensureConversationFileId(dateKey) : await findConversationFileId(dateKey);
  if (!fileId) {
    return normalizeConversationState({ date: dateKey, conversations: {} });
  }

  const text = (await readDriveTextFile(fileId)).trim();
  if (!text) return normalizeConversationState({});

  try {
    return normalizeConversationState(JSON.parse(text));
  } catch {
    return normalizeConversationState({});
  }
}

async function writeConversationStateForDate(dateKey, state) {
  const fileId = await ensureConversationFileId(dateKey);
  await writeDriveTextFile(fileId, JSON.stringify(normalizeConversationState(state), null, 2), 'application/json');
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
  const state = await readNotificationState();
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
  await writeNotificationState(state);

  return { reserved: true, record: state.notifications[key] };
}

export async function appendConversationTurn({ userId, role, text, at = new Date().toISOString() }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const normalizedUserId = String(userId || '').trim();
  const normalizedTurn = normalizeConversationTurn({ role, text, at });
  if (!normalizedUserId || !normalizedTurn) {
    return null;
  }

  const dateKey = getDateKeyInTimeZone(new Date(normalizedTurn.at), config.tz);
  const state = await readConversationStateForDate(dateKey, { createIfMissing: true });
  const currentTurns = Array.isArray(state.conversations[normalizedUserId]) ? state.conversations[normalizedUserId] : [];
  state.conversations[normalizedUserId] = [...currentTurns, normalizedTurn]
    .map((turn) => normalizeConversationTurn(turn))
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-500);

  state.date = dateKey;
  await writeConversationStateForDate(dateKey, state);
  return normalizedTurn;
}

export async function readConversationTurns({ userId, since, until }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return [];
  }

  const sinceTime = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const untilTime = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  const dateKeys = listDateKeysBetween({
    since: Number.isFinite(sinceTime) ? new Date(sinceTime).toISOString() : new Date(0).toISOString(),
    until: Number.isFinite(untilTime) ? new Date(untilTime).toISOString() : new Date().toISOString(),
    timeZone: config.tz
  });

  const turns = [];
  for (const dateKey of dateKeys) {
    const state = await readConversationStateForDate(dateKey);
    const dailyTurns = Array.isArray(state.conversations[normalizedUserId]) ? state.conversations[normalizedUserId] : [];
    turns.push(...dailyTurns);
  }

  return turns
    .map((turn) => normalizeConversationTurn(turn))
    .filter(Boolean)
    .filter((turn) => {
      const turnTime = Date.parse(turn.at);
      if (!Number.isFinite(turnTime)) return false;
      return turnTime > sinceTime && turnTime < untilTime;
    });
}

function upsertDailyLogSection(currentContent, dateKey, entryMarkdown) {
  const current = String(currentContent || '').replace(/\r\n/g, '\n').trimEnd();
  const section = `## ${dateKey}\n\n${String(entryMarkdown || '').trim()}\n`;

  if (!current) {
    return `# Daily Log\n\n${section}`;
  }

  const pattern = new RegExp(`(^## ${dateKey}\\n[\\s\\S]*?)(?=\\n## \\d{4}-\\d{2}-\\d{2}\\n|$)`, 'm');
  if (pattern.test(current)) {
    return `${current.replace(pattern, section.trimEnd())}\n`;
  }

  return `${current}\n\n${section}`;
}

export async function upsertDailyLog({ dateKey, entryMarkdown }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = await ensureLogFileId();
  const currentContent = await readDriveTextFile(fileId);
  const nextContent = upsertDailyLogSection(currentContent, dateKey, entryMarkdown);
  await writeDriveTextFile(fileId, nextContent);
  return nextContent;
}

export async function getNotificationRecord({ slot, dateKey }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const state = await readNotificationState();
  return state.notifications[notificationKey(slot, dateKey)] || null;
}

export async function updateNotificationRecord({ slot, dateKey, updates }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const state = await readNotificationState();
  const key = notificationKey(slot, dateKey);
  const previous = state.notifications[key] || { slot, dateKey };
  state.notifications[key] = {
    ...previous,
    ...updates,
    slot,
    dateKey
  };
  await writeNotificationState(state);
  return state.notifications[key];
}

export async function getLatestSentNotificationBefore({ slot, dateKey }) {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const state = await readNotificationState();
  const entries = Object.entries(state.notifications)
    .filter(([key, record]) => key.startsWith(`${slot}:`) && record?.sentAt && record.dateKey < dateKey)
    .sort(([, left], [, right]) => String(left.dateKey).localeCompare(String(right.dateKey)));

  if (entries.length === 0) {
    return null;
  }

  return entries[entries.length - 1][1] || null;
}

export async function completeNotificationWindow({ slot, dateKey, localTime, sentAt = new Date().toISOString() }) {
  const state = await readNotificationState();
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
  await writeNotificationState(state);
}

export async function failNotificationWindow({ slot, dateKey, localTime, error, failedAt = new Date().toISOString() }) {
  const state = await readNotificationState();
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
  await writeNotificationState(state);
}
