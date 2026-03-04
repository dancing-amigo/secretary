import express from 'express';
import { config, assertMinimalConfig } from './config.js';
import { verifyLineSignature, replyMessage } from './services/lineClient.js';
import { processUserMessage } from './services/assistantEngine.js';
import { startSchedulers } from './services/scheduler.js';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/webhook/line', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.headers['x-line-signature'];

  if (!verifyLineSignature(rawBody, String(signature || ''))) {
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('invalid json');
  }

  res.status(200).send('ok');

  const events = payload.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const userId = event.source?.userId || config.line.defaultUserId;
    if (!userId) continue;

    const text = event.message.text || '';
    try {
      const replyText = await processUserMessage({ userId, text });
      await replyMessage(event.replyToken, replyText);
    } catch (e) {
      await replyMessage(event.replyToken, `処理中にエラーが発生しました: ${String(e.message || e)}`);
    }
  }
});

app.post('/internal/morning', express.json(), async (_req, res) => {
  try {
    const { runMorningPlan } = await import('./services/assistantEngine.js');
    const { pushMessage } = await import('./services/lineClient.js');
    const text = await runMorningPlan();
    if (config.line.defaultUserId) await pushMessage(config.line.defaultUserId, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/internal/chat', express.json(), async (req, res) => {
  const userId = req.body?.userId || config.line.defaultUserId || 'U_local';
  const text = req.body?.text || '';
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
  try {
    const reply = await processUserMessage({ userId, text });
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const missing = assertMinimalConfig();
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`Missing env vars: ${missing.join(', ')}`);
}

startSchedulers();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`line-secretary-mvp listening on :${config.port}`);
});
