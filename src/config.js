import dotenv from 'dotenv';

dotenv.config();

function isValidTimeZone(value) {
  try {
    // Validate using Intl to avoid runtime failures in scheduled jobs.
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(rawValue, fallback = 'America/Vancouver') {
  const raw = String(rawValue || '').trim();
  if (!raw) return fallback;

  // Some platforms expose POSIX-style TZ values like ":UTC", which are not IANA names.
  // Treat these as platform defaults and keep the app's configured fallback zone.
  if (raw.startsWith(':')) return fallback;

  const candidate = raw;
  if (candidate && isValidTimeZone(candidate)) return candidate;
  return fallback;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  tz: normalizeTimeZone(process.env.TZ, 'America/Vancouver'),
  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    defaultUserId: process.env.LINE_DEFAULT_USER_ID || ''
  },
  cron: {
    morning: process.env.MORNING_PLAN_CRON || '0 8 * * *',
    night: process.env.NIGHT_REVIEW_CRON || '0 22 * * *'
  }
};

export function assertMinimalConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.accessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
