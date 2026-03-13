import dotenv from "dotenv";

dotenv.config();

function isValidTimeZone(value) {
  try {
    // Validate using Intl to avoid runtime failures in scheduled jobs.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(rawValue, fallback = "America/Vancouver") {
  const raw = String(rawValue || "").trim();
  if (!raw) return fallback;

  // Some platforms expose POSIX-style TZ values like ":UTC", which are not IANA names.
  // Treat these as platform defaults and keep the app's configured fallback zone.
  if (raw.startsWith(":")) return fallback;

  const candidate = raw;
  if (candidate && isValidTimeZone(candidate)) return candidate;
  return fallback;
}

function normalizeRetentionDays(rawValue, fallback) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return value;
}

function normalizeTimeoutMs(rawValue, fallback) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(value) || value < 1000) return fallback;
  return value;
}

function normalizeOptionalBoolean(rawValue) {
  const normalized = String(rawValue ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function normalizeLocalTime(rawValue, fallback) {
  const normalized = String(rawValue || '').trim();
  if (!normalized) return fallback;
  const match = normalized.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return fallback;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return fallback;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  app: {
    baseUrl:
      process.env.APP_BASE_URL ||
      process.env.SECRETARY_BASE_URL ||
      "",
    publicCalendarUrl: process.env.PUBLIC_CALENDAR_URL || "",
    jobTimes: {
      morning: normalizeLocalTime(process.env.MORNING_JOB_TIME, '08:00:00'),
      night: normalizeLocalTime(process.env.NIGHT_JOB_TIME, '22:00:00'),
      close: normalizeLocalTime(process.env.CLOSE_JOB_TIME, '03:00:00')
    }
  },
  tz: normalizeTimeZone(
    process.env.APP_TIMEZONE || process.env.TZ,
    "America/Vancouver",
  ),
  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET || "",
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
    defaultUserId: process.env.LINE_DEFAULT_USER_ID || "",
    endReminderIntervalMinutes: normalizeRetentionDays(
      process.env.END_REMINDER_INTERVAL_MINUTES,
      15,
    ),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    timeoutMs: normalizeTimeoutMs(process.env.OPENAI_TIMEOUT_MS, 90000),
    actionModel:
      process.env.OPENAI_ACTION_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-5-mini",
    taskModel:
      process.env.OPENAI_TASK_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini",
    summaryModel:
      process.env.OPENAI_SUMMARY_MODEL ||
      process.env.OPENAI_TASK_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-5-mini",
  },
  googleDrive: {
    enabled:
      String(process.env.GOOGLE_DRIVE_ENABLED || "false").toLowerCase() ===
      "true",
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
    memoryFolderName:
      process.env.GOOGLE_DRIVE_MEMORY_FOLDER_NAME || "memory",
    statesFolderName:
      process.env.GOOGLE_DRIVE_STATES_FOLDER_NAME || "states",
    notificationStateFileName:
      process.env.GOOGLE_DRIVE_NOTIFICATION_STATE_FILE_NAME ||
      "notification-state.json",
    notificationRetentionDays: normalizeRetentionDays(
      process.env.GOOGLE_DRIVE_NOTIFICATION_RETENTION_DAYS,
      7,
    ),
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "",
    oauthRedirectUri:
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      "http://127.0.0.1:53682/oauth2callback",
  },
  googleCalendar: {
    enabled:
      String(
        process.env.GOOGLE_CALENDAR_ENABLED ??
          String(process.env.GOOGLE_DRIVE_ENABLED || "false"),
      ).toLowerCase() === "true",
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    eventColorId: process.env.GOOGLE_CALENDAR_EVENT_COLOR_ID || "1",
    syncStateFileName:
      process.env.GOOGLE_CALENDAR_SYNC_STATE_FILE_NAME || "task-sync-state.json",
    pullRetentionDays: normalizeRetentionDays(
      process.env.GOOGLE_CALENDAR_PULL_RETENTION_DAYS,
      7,
    ),
  },
  cloudTasks: {
    projectId:
      process.env.CLOUD_TASKS_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      "",
    location: process.env.CLOUD_TASKS_LOCATION || "",
    queue: process.env.CLOUD_TASKS_QUEUE || "",
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    serviceAccountPrivateKey:
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "",
  },
  x: {
    enabled:
      normalizeOptionalBoolean(process.env.X_ENABLED) ??
      Boolean(
        process.env.X_API_KEY &&
          process.env.X_API_KEY_SECRET &&
          process.env.X_ACCESS_TOKEN &&
          process.env.X_ACCESS_TOKEN_SECRET
      ),
    apiKey: process.env.X_API_KEY || '',
    apiKeySecret: process.env.X_API_KEY_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || '',
    clientId: process.env.X_CLIENT_ID || '',
    clientSecret: process.env.X_CLIENT_SECRET || '',
    mentionUsername: process.env.X_MENTION_USERNAME || ''
  }
};

export function assertMinimalConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push("LINE_CHANNEL_SECRET");
  if (!config.line.accessToken) missing.push("LINE_CHANNEL_ACCESS_TOKEN");
  return missing;
}
