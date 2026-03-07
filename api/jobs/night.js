import { runNightJob } from '../../src/services/scheduler.js';
import { ensureDailyJobsScheduled } from '../_lib/ensureDailyJobs.js';
import { requireCronAuth } from '../_lib/cronAuth.js';

export default async function handler(req, res) {
  await ensureDailyJobsScheduled();
  if (!requireCronAuth(req, res)) return;
  const out = await runNightJob();
  res.status(200).json({ ok: true, ...out });
}
