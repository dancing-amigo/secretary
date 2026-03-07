import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

export function googleServiceAuthConfigError() {
  if (!config.cloudTasks.projectId) return 'CLOUD_TASKS_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required';
  if (!config.cloudTasks.serviceAccountEmail) return 'GOOGLE_SERVICE_ACCOUNT_EMAIL is required';
  if (!normalizePrivateKey(config.cloudTasks.serviceAccountPrivateKey)) {
    return 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is required';
  }
  return '';
}

function buildServiceAccountJwt() {
  const privateKey = normalizePrivateKey(config.cloudTasks.serviceAccountPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: config.cloudTasks.serviceAccountEmail,
    sub: config.cloudTasks.serviceAccountEmail,
    aud: GOOGLE_TOKEN_URL,
    scope: CLOUD_PLATFORM_SCOPE,
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${unsigned}.${signature}`;
}

export async function getGoogleCloudAccessToken() {
  const configError = googleServiceAuthConfigError();
  if (configError) {
    throw new Error(configError);
  }

  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const response = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildServiceAccountJwt()
    }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    }
  );

  const expiresIn = Number(response.data?.expires_in || 3600);
  cachedAccessToken = String(response.data?.access_token || '');
  cachedAccessTokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;
  return cachedAccessToken;
}
