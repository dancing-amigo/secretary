export function requireCronAuth(req, res) {
  const expected = process.env.CRON_SECRET || '';
  if (!expected) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${expected}`) return true;
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}
