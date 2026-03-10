import crypto from 'crypto';
import { config } from '../config.js';

function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function createNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function collectSignatureParams(url, oauthParams) {
  const target = new URL(url);
  const params = [];

  for (const [key, value] of target.searchParams.entries()) {
    params.push([percentEncode(key), percentEncode(value)]);
  }

  for (const [key, value] of Object.entries(oauthParams)) {
    params.push([percentEncode(key), percentEncode(value)]);
  }

  params.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });

  return params.map(([key, value]) => `${key}=${value}`).join('&');
}

function buildOAuthHeader(oauthParams) {
  const parts = Object.entries(oauthParams)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`);
  return `OAuth ${parts.join(', ')}`;
}

export function isXPostingEnabled() {
  return Boolean(config.x.enabled);
}

export function xClientConfigError() {
  if (!config.x.enabled) return 'X posting is disabled';
  if (!config.x.apiKey) return 'X_API_KEY is required';
  if (!config.x.apiKeySecret) return 'X_API_KEY_SECRET is required';
  if (!config.x.accessToken) return 'X_ACCESS_TOKEN is required';
  if (!config.x.accessTokenSecret) return 'X_ACCESS_TOKEN_SECRET is required';
  return '';
}

function buildAuthorizationHeader({ method, url }) {
  const oauthParams = {
    oauth_consumer_key: config.x.apiKey,
    oauth_nonce: createNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.x.accessToken,
    oauth_version: '1.0'
  };

  const normalizedParams = collectSignatureParams(url, oauthParams);
  const signatureBaseString = [
    method.toUpperCase(),
    percentEncode(normalizeBaseUrl(url)),
    percentEncode(normalizedParams)
  ].join('&');
  const signingKey = [
    percentEncode(config.x.apiKeySecret),
    percentEncode(config.x.accessTokenSecret)
  ].join('&');
  const oauthSignature = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBaseString)
    .digest('base64');

  return buildOAuthHeader({
    ...oauthParams,
    oauth_signature: oauthSignature
  });
}

async function xRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const configError = xClientConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: buildAuthorizationHeader({ method, url }),
      ...headers
    },
    body
  });

  const rawBody = await response.text();
  let parsedBody = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  if (!response.ok) {
    const detail = typeof parsedBody === 'string'
      ? parsedBody
      : parsedBody?.detail || parsedBody?.errors?.[0]?.message || response.statusText;
    const error = new Error(`X API ${response.status}: ${String(detail || 'request failed')}`);
    error.status = response.status;
    error.responseBody = parsedBody;
    throw error;
  }

  return parsedBody;
}

export async function verifyXCredentials() {
  return xRequest('https://api.x.com/1.1/account/verify_credentials.json');
}

export async function fetchAuthenticatedXUser() {
  return xRequest('https://api.x.com/2/users/me');
}

export async function postTweet(text) {
  return xRequest('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });
}
