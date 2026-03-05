import cron from 'node-cron';
import { config } from '../config.js';
import { pushMessage } from './lineClient.js';
import { runMorningPlan, runNightReview } from './assistantEngine.js';

function localHour(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false
  }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === 'hour')?.value;
  return Number(hourPart);
}

async function sendToDefaultUser(text) {
  const userId = config.line.defaultUserId;
  if (!userId) {
    return { ok: false, error: 'LINE_DEFAULT_USER_ID is required' };
  }

  await pushMessage(userId, text);
  return { ok: true, userId, text };
}

export async function runMorningJob({ enforceLocalClock = false } = {}) {
  if (enforceLocalClock) {
    if (localHour(config.tz) !== 8) return { skipped: true, reason: 'not 08:00 local hour' };
  }

  const text = await runMorningPlan();
  const out = await sendToDefaultUser(text);
  return { skipped: false, ...out };
}

export async function runNightJob({ enforceLocalClock = false } = {}) {
  if (enforceLocalClock) {
    if (localHour(config.tz) !== 22) return { skipped: true, reason: 'not 22:00 local hour' };
  }

  const text = runNightReview();
  const out = await sendToDefaultUser(text);
  return { skipped: false, ...out };
}

export function startSchedulers() {
  cron.schedule(config.cron.morning, async () => {
    await runMorningJob();
  }, { timezone: config.tz });

  cron.schedule(config.cron.night, async () => {
    await runNightJob();
  }, { timezone: config.tz });
}
