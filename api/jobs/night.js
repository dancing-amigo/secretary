import { runNightJob } from '../../src/services/scheduler.js';
import { requireCronAuth } from '../_lib/cronAuth.js';

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;
  const out = await runNightJob({ enforceLocalClock: true });
  res.status(200).json({ ok: true, ...out });
}
