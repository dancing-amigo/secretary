import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config.js';

const api = axios.create({
  baseURL: 'https://api.line.me/v2/bot/message',
  headers: {
    Authorization: `Bearer ${config.line.accessToken}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

const profileApi = axios.create({
  baseURL: 'https://api.line.me/v2/bot',
  headers: {
    Authorization: `Bearer ${config.line.accessToken}`
  },
  timeout: 10000
});

export function verifyLineSignature(rawBody, signature) {
  if (!config.line.channelSecret || !signature) return false;
  const hmac = crypto
    .createHmac('sha256', config.line.channelSecret)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

export async function replyMessage(replyToken, text) {
  if (!replyToken) return;
  await api.post('/reply', {
    replyToken,
    messages: [{ type: 'text', text: text.slice(0, 5000) }]
  });
}

export async function pushMessage(userId, text) {
  if (!userId) return;
  await api.post('/push', {
    to: userId,
    messages: [{ type: 'text', text: text.slice(0, 5000) }]
  });
}

export async function getUserProfile(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return null;
  }

  const response = await profileApi.get(`/profile/${normalizedUserId}`);
  const displayName = String(response.data?.displayName || '').trim();
  const userIdFromApi = String(response.data?.userId || normalizedUserId).trim();

  return {
    userId: userIdFromApi,
    displayName
  };
}
