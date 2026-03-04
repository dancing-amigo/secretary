import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import { runtimePath, ensureRuntimeSeeded } from './runtimeFs.js';

const enabled = String(process.env.GOOGLE_DRIVE_ENABLED || 'false').toLowerCase() === 'true';
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const saPrivateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';

const stateFileName = process.env.GOOGLE_DRIVE_STATE_FILE_NAME || 'secretary-state.json';
const memoryFileName = process.env.GOOGLE_DRIVE_MEMORY_FILE_NAME || 'secretary-memory.json';

let cachedStateFileId = process.env.GOOGLE_DRIVE_STATE_FILE_ID || '';
let cachedMemoryFileId = process.env.GOOGLE_DRIVE_MEMORY_FILE_ID || '';

const statePath = runtimePath('data', 'state.json');
const memoryRoot = runtimePath('memory');

function authMode() {
  if (oauthClientId && oauthClientSecret && oauthRefreshToken) return 'oauth_user';
  if (saEmail && saPrivateKey) return 'service_account';
  return 'none';
}

function isConfigured() {
  return Boolean(enabled && folderId && authMode() !== 'none');
}

function authClient() {
  const mode = authMode();
  if (mode === 'oauth_user') {
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682/oauth2callback';
    const oauth2 = new google.auth.OAuth2(oauthClientId, oauthClientSecret, redirectUri);
    oauth2.setCredentials({ refresh_token: oauthRefreshToken });
    return oauth2;
  }

  if (mode === 'service_account') {
    return new google.auth.JWT({
      email: saEmail,
      key: saPrivateKey,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
  }

  throw new Error('Google Drive auth is not configured');
}

function driveClient() {
  return google.drive({ version: 'v3', auth: authClient() });
}

async function findFileIdByName(name) {
  const drive = driveClient();
  const q = `'${folderId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return res.data.files?.[0]?.id || '';
}

async function createFile(name, mimeType, body) {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
      mimeType
    },
    media: {
      mimeType,
      body
    },
    fields: 'id',
    supportsAllDrives: true
  });
  return res.data.id;
}

async function ensureFileIds() {
  if (!cachedStateFileId) {
    cachedStateFileId = (await findFileIdByName(stateFileName)) || '';
    if (!cachedStateFileId) {
      cachedStateFileId = await createFile(stateFileName, 'application/json', JSON.stringify({}));
    }
  }

  if (!cachedMemoryFileId) {
    cachedMemoryFileId = (await findFileIdByName(memoryFileName)) || '';
    if (!cachedMemoryFileId) {
      cachedMemoryFileId = await createFile(memoryFileName, 'application/json', JSON.stringify({ files: {} }));
    }
  }
}

async function downloadText(fileId) {
  const drive = driveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

async function uploadText(fileId, mimeType, text) {
  const drive = driveClient();
  await drive.files.update({
    fileId,
    media: {
      mimeType,
      body: text
    },
    supportsAllDrives: true
  });
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        out.push(p);
      }
    }
  }
  if (fs.existsSync(rootDir)) await walk(rootDir);
  return out;
}

async function readMemoryBundle() {
  const files = await listFilesRecursive(memoryRoot);
  const map = {};
  for (const abs of files) {
    const rel = path.relative(memoryRoot, abs).replace(/\\/g, '/');
    map[rel] = await fsp.readFile(abs, 'utf8');
  }
  return { files: map };
}

async function writeMemoryBundle(bundle) {
  const map = bundle?.files || {};
  await fsp.mkdir(memoryRoot, { recursive: true });
  for (const [rel, content] of Object.entries(map)) {
    const abs = path.join(memoryRoot, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(content ?? ''), 'utf8');
  }
}

let syncInProgress = Promise.resolve();
function queue(fn) {
  const run = syncInProgress.then(fn);
  syncInProgress = run.catch(() => null);
  return run;
}

export async function pullFromDrive() {
  if (!isConfigured()) return { skipped: true, reason: 'drive not configured' };
  return queue(async () => {
    ensureRuntimeSeeded();
    await ensureFileIds();

    const stateText = await downloadText(cachedStateFileId);
    if (stateText?.trim()) {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, stateText, 'utf8');
    }

    const memoryText = await downloadText(cachedMemoryFileId);
    if (memoryText?.trim()) {
      let bundle = { files: {} };
      try {
        bundle = JSON.parse(memoryText);
      } catch {
        bundle = { files: {} };
      }
      await writeMemoryBundle(bundle);
    }

    return { skipped: false };
  });
}

export async function pushToDrive() {
  if (!isConfigured()) return { skipped: true, reason: 'drive not configured' };
  return queue(async () => {
    ensureRuntimeSeeded();
    await ensureFileIds();

    const stateText = await fsp.readFile(statePath, 'utf8');
    await uploadText(cachedStateFileId, 'application/json', stateText);

    const bundle = await readMemoryBundle();
    await uploadText(cachedMemoryFileId, 'application/json', JSON.stringify(bundle));

    return { skipped: false };
  });
}

export async function withDriveSync(fn) {
  if (!isConfigured()) return fn();
  await pullFromDrive();
  const out = await fn();
  await pushToDrive();
  return out;
}

export function driveStatus() {
  const keyConfigured = Boolean(saPrivateKey && saPrivateKey.includes('BEGIN PRIVATE KEY'));
  return {
    enabled,
    configured: isConfigured(),
    authMode: authMode(),
    folderId: folderId || null,
    serviceAccountEmailConfigured: Boolean(saEmail),
    privateKeyConfigured: keyConfigured,
    oauthClientConfigured: Boolean(oauthClientId && oauthClientSecret),
    oauthRefreshTokenConfigured: Boolean(oauthRefreshToken),
    stateFileId: cachedStateFileId || null,
    memoryFileId: cachedMemoryFileId || null
  };
}

export async function driveDebugSnapshot() {
  if (!isConfigured()) return { configured: false };
  await ensureFileIds();
  const stateText = await downloadText(cachedStateFileId);
  const memoryText = await downloadText(cachedMemoryFileId);

  let state = {};
  let memory = { files: {} };
  try {
    state = JSON.parse(stateText || '{}');
  } catch {
    state = {};
  }
  try {
    memory = JSON.parse(memoryText || '{"files":{}}');
  } catch {
    memory = { files: {} };
  }

  return {
    configured: true,
    authMode: authMode(),
    stateFileId: cachedStateFileId,
    memoryFileId: cachedMemoryFileId,
    taskCount: Array.isArray(state.tasks) ? state.tasks.length : 0,
    usersCount: state.users ? Object.keys(state.users).length : 0,
    memoryFileCount: memory?.files ? Object.keys(memory.files).length : 0
  };
}
