import axios from 'axios';
import { config } from '../config.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const PENDING_STALE_MS = 2 * 60 * 60 * 1000;
const CONVERSATIONS_FOLDER_NAME = 'conversations';
const LOG_FILE_NAME = 'log.md';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedNotificationStateFileId = null;
let cachedGoogleCalendarSyncStateFileId = null;
let cachedConversationsFolderId = null;
let cachedLogFileId = null;
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

function normalizeGoogleCalendarSyncState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { failures: [], pulls: {} };
  }

  if (!Array.isArray(state.failures)) {
    state.failures = [];
  }

  if (!state.pulls || typeof state.pulls !== 'object' || Array.isArray(state.pulls)) {
    state.pulls = {};
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
  if (cacheKey === 'googleCalendarSync' && cachedGoogleCalendarSyncStateFileId) return cachedGoogleCalendarSyncStateFileId;

  const existingId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name
  });
  if (existingId) {
    if (cacheKey === 'notification') cachedNotificationStateFileId = existingId;
    if (cacheKey === 'googleCalendarSync') cachedGoogleCalendarSyncStateFileId = existingId;
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
  if (cacheKey === 'googleCalendarSync') cachedGoogleCalendarSyncStateFileId = created.data?.id || null;
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

async function deleteDriveFile(fileId) {
  await driveRequest({
    method: 'delete',
    url: `${GOOGLE_DRIVE_API_URL}/${fileId}`
  });
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

async function readGoogleCalendarSyncState() {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = await findStateFileId({
    name: config.googleCalendar.syncStateFileName,
    initialContent: { failures: [], pulls: {} },
    cacheKey: 'googleCalendarSync'
  });
  const text = (await readDriveTextFile(fileId)).trim();
  if (!text) return normalizeGoogleCalendarSyncState({});

  try {
    return normalizeGoogleCalendarSyncState(JSON.parse(text));
  } catch {
    return normalizeGoogleCalendarSyncState({});
  }
}

async function writeGoogleCalendarSyncState(state) {
  const fileId = await findStateFileId({
    name: config.googleCalendar.syncStateFileName,
    initialContent: { failures: [], pulls: {} },
    cacheKey: 'googleCalendarSync'
  });
  await writeDriveTextFile(
    fileId,
    JSON.stringify(normalizeGoogleCalendarSyncState(state), null, 2),
    'application/json'
  );
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

export async function appendGoogleCalendarSyncFailure(entry) {
  const state = await readGoogleCalendarSyncState();
  const normalizedEntry = {
    at: String(entry?.at || new Date().toISOString()),
    dateKey: String(entry?.dateKey || '').trim(),
    localTaskId: String(entry?.localTaskId || '').trim(),
    googleCalendarEventId: String(entry?.googleCalendarEventId || '').trim(),
    calendarId: String(entry?.calendarId || '').trim(),
    operation: String(entry?.operation || '').trim(),
    retryable: Boolean(entry?.retryable),
    error: String(entry?.error || 'unknown error').trim().slice(0, 500)
  };

  state.failures = [...state.failures, normalizedEntry].slice(-200);
  await writeGoogleCalendarSyncState(state);
  return normalizedEntry;
}

export async function deleteLegacyTasksFolder() {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const folderId = await findDriveChildId({
    parentId: config.googleDrive.folderId,
    name: 'tasks',
    mimeType: 'application/vnd.google-apps.folder'
  });
  if (!folderId) {
    return { deleted: false, found: false };
  }

  await deleteDriveFile(folderId);
  return { deleted: true, found: true, folderId };
}

function normalizeGoogleCalendarPulledEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;

  const eventId = String(event.eventId || '').trim();
  if (!eventId) return null;

  return {
    eventId,
    status: String(event.status || '').trim(),
    summary: String(event.summary || '').trim().slice(0, 1024),
    description: String(event.description || '').trim().slice(0, 8192),
    start: event.start && typeof event.start === 'object' ? {
      date: String(event.start.date || '').trim(),
      dateTime: String(event.start.dateTime || '').trim(),
      timeZone: String(event.start.timeZone || '').trim()
    } : { date: '', dateTime: '', timeZone: '' },
    end: event.end && typeof event.end === 'object' ? {
      date: String(event.end.date || '').trim(),
      dateTime: String(event.end.dateTime || '').trim(),
      timeZone: String(event.end.timeZone || '').trim()
    } : { date: '', dateTime: '', timeZone: '' },
    source: String(event.source || '').trim() || 'external',
    linkedLocalTaskId: String(event.linkedLocalTaskId || '').trim(),
    calendarId: String(event.calendarId || '').trim(),
    htmlLink: String(event.htmlLink || '').trim(),
    updated: String(event.updated || '').trim()
  };
}

export async function writeGoogleCalendarPullSnapshot({
  dateKey,
  calendarId,
  startedAt,
  completedAt,
  windowStart,
  windowEnd,
  status,
  operation,
  error = '',
  events = []
}) {
  const normalizedDateKey = String(dateKey || '').trim();
  if (!normalizedDateKey) {
    throw new Error('dateKey is required');
  }

  const state = await readGoogleCalendarSyncState();
  state.pulls[normalizedDateKey] = {
    calendarId: String(calendarId || '').trim(),
    startedAt: String(startedAt || '').trim(),
    completedAt: String(completedAt || '').trim(),
    windowStart: String(windowStart || '').trim(),
    windowEnd: String(windowEnd || '').trim(),
    status: String(status || '').trim() || 'unknown',
    operation: String(operation || '').trim(),
    error: String(error || '').trim().slice(0, 500),
    events: (Array.isArray(events) ? events : [])
      .map((event) => normalizeGoogleCalendarPulledEvent(event))
      .filter(Boolean)
      .slice(0, 500)
  };
  await writeGoogleCalendarSyncState(state);
  return state.pulls[normalizedDateKey];
}

export async function readGoogleCalendarPullSnapshotForDate(dateKey) {
  const normalizedDateKey = String(dateKey || '').trim();
  if (!normalizedDateKey) return null;

  const state = await readGoogleCalendarSyncState();
  const snapshot = state.pulls?.[normalizedDateKey];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  return {
    calendarId: String(snapshot.calendarId || '').trim(),
    startedAt: String(snapshot.startedAt || '').trim(),
    completedAt: String(snapshot.completedAt || '').trim(),
    windowStart: String(snapshot.windowStart || '').trim(),
    windowEnd: String(snapshot.windowEnd || '').trim(),
    status: String(snapshot.status || '').trim(),
    operation: String(snapshot.operation || '').trim(),
    error: String(snapshot.error || '').trim(),
    events: (Array.isArray(snapshot.events) ? snapshot.events : [])
      .map((event) => normalizeGoogleCalendarPulledEvent(event))
      .filter(Boolean)
  };
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
