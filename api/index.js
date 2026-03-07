import { app } from '../src/app.js';
import { ensureDailyJobsScheduled } from './_lib/ensureDailyJobs.js';

export default async function handler(req, res) {
  await ensureDailyJobsScheduled();
  return app(req, res);
}
