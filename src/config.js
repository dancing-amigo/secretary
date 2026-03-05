import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8787),
  tz: process.env.TZ || 'America/Vancouver',
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
