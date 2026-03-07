import { runEventReminderDelivery } from '../../src/services/eventReminders.js';
import { requireCronAuth } from '../_lib/cronAuth.js';

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;
  const out = await runEventReminderDelivery(req.body);
  res.status(200).json({ ok: true, ...out });
}
