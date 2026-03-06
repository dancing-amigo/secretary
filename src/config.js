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
  },
  googleDrive: {
    enabled: String(process.env.GOOGLE_DRIVE_ENABLED || 'false').toLowerCase() === 'true',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    stateFileName: process.env.GOOGLE_DRIVE_STATE_FILE_NAME || 'secretary-state.json',
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
    oauthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682/oauth2callback'
  }
};

export function assertMinimalConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.accessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
