import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const PENDING_STALE_MS = 2 * 60 * 60 * 1000;

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedStateFileId = null;

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

function buildMultipartBody(metadata, content) {
  const boundary = `secretary-${randomUUID()}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
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

  const q = [
    'trashed = false',
    `name = '${escapeDriveQueryValue(config.googleDrive.stateFileName)}'`,
    `'${escapeDriveQueryValue(config.googleDrive.folderId)}' in parents`
  ].join(' and ');

  const response = await driveRequest({
    method: 'get',
    url: GOOGLE_DRIVE_API_URL,
    params: {
      q,
      pageSize: 1,
      fields: 'files(id,name)'
    }
  });

  const existingId = response.data?.files?.[0]?.id;
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

async function readState() {
  const configError = driveStateConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const fileId = await findStateFileId();
  const response = await driveRequest({
    method: 'get',
    url: `${GOOGLE_DRIVE_API_URL}/${fileId}`,
    params: { alt: 'media' },
    responseType: 'arraybuffer'
  });

  const text = Buffer.from(response.data || '').toString('utf8').trim();
  if (!text) return { notifications: {} };

  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return { notifications: {} };
  }
}

async function writeState(state) {
  const fileId = await findStateFileId();
  await driveRequest({
    method: 'patch',
    url: `${GOOGLE_DRIVE_UPLOAD_URL}/${fileId}`,
    params: { uploadType: 'media' },
    data: JSON.stringify(normalizeState(state), null, 2),
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  });
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
