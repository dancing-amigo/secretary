import { runReminderTick } from '../../src/services/scheduler.js';
import { requireCronAuth } from '../_lib/cronAuth.js';
import { withDriveSync } from '../../src/services/driveSync.js';

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;
  const out = await withDriveSync(async () => runReminderTick());
  res.status(200).json({ ok: true, ...out });
}
