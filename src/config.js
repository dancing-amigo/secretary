import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8787),
  tz: process.env.TZ || 'Asia/Tokyo',
  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    defaultUserId: process.env.LINE_DEFAULT_USER_ID || ''
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini'
  },
  cron: {
    morning: process.env.MORNING_PLAN_CRON || '30 7 * * *',
    night: process.env.NIGHT_REVIEW_CRON || '30 21 * * *',
    reminderTick: process.env.REMINDER_TICK_CRON || '*/1 * * * *'
  },
  gcal: {
    enabled: String(process.env.GCAL_ENABLED || 'false').toLowerCase() === 'true',
    calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
    accessToken: process.env.GCAL_ACCESS_TOKEN || ''
  }
};

export function assertMinimalConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.accessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
